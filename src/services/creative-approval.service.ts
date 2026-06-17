import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creativeApprovals } from '../db/schema/creative-approvals.js';
import { creatives } from '../db/schema/creatives.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { users } from '../db/schema/users.js';

// 'changes_requested' is the third decision state in the v2 buyer-review
// flow (Sam #9/#11 — 2026-05-17). Buyer signals "needs work" without
// finalising a rejection so the asset can be revised + re-uploaded by staff.
// 'submitted' (T2 — Sam, 2026-05-20) is the staff-side audit event for
// "I sent this draft to the buyer". It only appears in `creative_approvals`,
// never as a current state on `creatives.status` (which has its own
// 'sent_for_approval' value).
export type CreativeApprovalAction = 'approved' | 'rejected' | 'changes_requested' | 'submitted';
export type CreativeApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export interface CreativeApprovalEvent {
  id: string;
  action: CreativeApprovalAction;
  // null when the deciding user was later permanently removed (migration 0038).
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedByEmail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  feedback: string | null;
  createdAt: string;
}

export interface CreativeApprovalState {
  status: CreativeApprovalStatus;
  decidedAt: string | null;
  decidedByName: string | null;
  feedback: string | null;
}

export class CreativeApprovalError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'ACCESS_DENIED' | 'FEEDBACK_REQUIRED' | 'INVALID_STATE',
    message: string,
  ) {
    super(message);
    this.name = 'CreativeApprovalError';
  }
}

/**
 * Resolve current approval status for a set of creatives in one query.
 * Used by the portal compliance endpoint to decorate each creative with
 * its latest decision (or `pending` if none).
 */
export async function getApprovalStatesForCreatives(
  creativeIds: string[],
): Promise<Map<string, CreativeApprovalState>> {
  if (creativeIds.length === 0) return new Map();

  // DISTINCT ON returns the most recent BUYER decision per creative_id —
  // 'submitted' rows are staff audit events, not decisions, so they're
  // excluded from this lookup. The portal cares only about the latest
  // buyer-facing state ('pending' if nothing yet, else the action).
  const rows = await db.execute<{
    creative_id: string;
    action: 'approved' | 'rejected' | 'changes_requested';
    feedback: string | null;
    created_at: Date;
    decided_by_name: string | null;
  }>(sql`
    SELECT DISTINCT ON (ca.creative_id)
      ca.creative_id,
      ca.action,
      ca.feedback,
      ca.created_at,
      u.name as decided_by_name
    FROM creative_approvals ca
    LEFT JOIN users u ON u.id = ca.decided_by_user_id
    WHERE ca.creative_id IN (${sql.join(
      creativeIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      AND ca.action <> 'submitted'
    ORDER BY ca.creative_id, ca.created_at DESC
  `);

  const map = new Map<string, CreativeApprovalState>();
  for (const r of rows) {
    map.set(r.creative_id, {
      status: r.action,
      decidedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      decidedByName: r.decided_by_name,
      feedback: r.feedback,
    });
  }
  return map;
}

/**
 * Record a buyer decision on a creative. Always inserts a new row — the
 * audit trail is append-only so a later "did you actually approve?" query
 * has the full chronology. Also updates `creatives.status` so list queries
 * can filter without joining the audit table.
 */
export async function recordDecision(params: {
  creativeId: string;
  decidedByUserId: string;
  action: Exclude<CreativeApprovalAction, 'submitted'>;
  ipAddress: string | null;
  userAgent: string | null;
  feedback: string | null;
}): Promise<CreativeApprovalEvent> {
  const { creativeId, decidedByUserId, action, ipAddress, userAgent, feedback } = params;

  // Feedback is mandatory for both 'rejected' and 'changes_requested' — the
  // buyer needs to tell the team WHAT to fix. 'approved' is a no-feedback
  // happy path.
  if (action !== 'approved' && (!feedback || feedback.trim().length === 0)) {
    throw new CreativeApprovalError(
      'FEEDBACK_REQUIRED',
      'Feedback is required so the team knows what to address',
    );
  }

  const [creative] = await db.select().from(creatives).where(eq(creatives.id, creativeId));
  if (!creative) {
    throw new CreativeApprovalError('NOT_FOUND', 'Creative not found');
  }

  const [row] = await db
    .insert(creativeApprovals)
    .values({
      creativeId,
      action,
      decidedByUserId,
      ipAddress,
      userAgent: userAgent ? userAgent.slice(0, 500) : null,
      feedback: feedback ?? null,
    })
    .returning();

  // T2 (Sam, 2026-05-20): mirror the buyer's decision onto creatives.status
  // so list queries don't need to join the audit table. Approval log
  // remains the source of truth for HISTORY; the status column is the
  // source of truth for CURRENT state.
  await db
    .update(creatives)
    .set({ status: action, updatedAt: new Date() })
    .where(eq(creatives.id, creativeId));

  const [user] = await db.select().from(users).where(eq(users.id, decidedByUserId));

  return {
    id: row.id,
    action: row.action,
    decidedByUserId: row.decidedByUserId,
    decidedByName: user?.name ?? null,
    decidedByEmail: user?.email ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    feedback: row.feedback,
    createdAt: row.createdAt.toISOString(),
  };
}

// T2 (Sam, 2026-05-20) — error code for "tried to submit from a state
// that doesn't allow it" (e.g. already submitted, already approved). HTTP
// 409 maps to this.
export type CreativeApprovalErrorCode =
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'FEEDBACK_REQUIRED'
  | 'INVALID_STATE';

/**
 * Staff-side "Submit for approval" transition. Flips creatives.status from
 * 'draft' or 'changes_requested' → 'sent_for_approval', stamps
 * submitted_at = now(), and writes an audit row with action='submitted'.
 *
 * Allowed source states:
 *   - draft → sent_for_approval (the first-time submit)
 *   - changes_requested → sent_for_approval (re-submit after staff revised
 *     in response to buyer feedback — T2 spec note "allows the staff
 *     member to re-submit later")
 *
 * Any other source state (already sent_for_approval, approved, rejected)
 * is rejected with INVALID_STATE (HTTP 409) so the FE knows the click was
 * a no-op against current state.
 */
export async function submitForApproval(params: {
  creativeId: string;
  submittedByUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<CreativeApprovalEvent> {
  const { creativeId, submittedByUserId, ipAddress, userAgent } = params;

  const [creative] = await db.select().from(creatives).where(eq(creatives.id, creativeId));
  if (!creative) {
    throw new CreativeApprovalError('NOT_FOUND', 'Creative not found');
  }
  if (creative.status !== 'draft' && creative.status !== 'changes_requested') {
    throw new CreativeApprovalError(
      'INVALID_STATE',
      `Cannot submit a creative in state '${creative.status}'`,
    );
  }

  const [row] = await db
    .insert(creativeApprovals)
    .values({
      creativeId,
      action: 'submitted',
      decidedByUserId: submittedByUserId,
      ipAddress,
      userAgent: userAgent ? userAgent.slice(0, 500) : null,
      feedback: null,
    })
    .returning();

  await db
    .update(creatives)
    .set({
      status: 'sent_for_approval',
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(creatives.id, creativeId));

  const [user] = await db.select().from(users).where(eq(users.id, submittedByUserId));

  return {
    id: row.id,
    action: row.action,
    decidedByUserId: row.decidedByUserId,
    decidedByName: user?.name ?? null,
    decidedByEmail: user?.email ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    feedback: row.feedback,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Full audit history for a single creative, oldest → newest.
 * Returned to admin staff as legal-evidence material.
 */
export async function getApprovalHistory(creativeId: string): Promise<CreativeApprovalEvent[]> {
  const rows = await db
    .select({
      id: creativeApprovals.id,
      action: creativeApprovals.action,
      decidedByUserId: creativeApprovals.decidedByUserId,
      ipAddress: creativeApprovals.ipAddress,
      userAgent: creativeApprovals.userAgent,
      feedback: creativeApprovals.feedback,
      createdAt: creativeApprovals.createdAt,
      decidedByName: users.name,
      decidedByEmail: users.email,
    })
    .from(creativeApprovals)
    .leftJoin(users, eq(users.id, creativeApprovals.decidedByUserId))
    .where(eq(creativeApprovals.creativeId, creativeId))
    .orderBy(desc(creativeApprovals.createdAt));

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    decidedByUserId: r.decidedByUserId,
    decidedByName: r.decidedByName,
    decidedByEmail: r.decidedByEmail,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    feedback: r.feedback,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Verify the calling client owns the campaign that a creative belongs to.
 * Prevents one client from approving another client's creatives.
 *
 * Slice 2 Day 6 (Sam #44, #45 ambiguity): assets live on the CAMPAIGN
 * (vertical-level), and many clients can be linked to a single campaign
 * via `client_campaigns`. Access is granted when:
 *   - the campaign has the legacy `client_id` matching (1:1 model), OR
 *   - the requesting client is linked through `client_campaigns` (M:N
 *     model — Solar Panels with 3 buyers underneath, any of them can
 *     approve their own copy of the creative).
 */
export async function assertCreativeBelongsToClient(
  creativeId: string,
  clientId: string,
): Promise<void> {
  // First confirm the creative exists and grab the campaign linkage.
  const [creativeRow] = await db
    .select({
      campaignId: creatives.campaignId,
      legacyClientId: campaigns.clientId,
    })
    .from(creatives)
    .innerJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .where(eq(creatives.id, creativeId));

  if (!creativeRow) {
    throw new CreativeApprovalError('NOT_FOUND', 'Creative not found');
  }

  // Fast path: legacy 1:1 link still matches → grant access.
  if (creativeRow.legacyClientId === clientId) return;

  // Slow path: check the many-to-many join. If the requesting client is
  // a buyer on this vertical campaign, they have access to its creatives.
  const [linkRow] = await db
    .select({ id: clientCampaigns.id })
    .from(clientCampaigns)
    .where(and(
      eq(clientCampaigns.campaignId, creativeRow.campaignId),
      eq(clientCampaigns.clientId, clientId),
    ));

  if (!linkRow) {
    throw new CreativeApprovalError(
      'ACCESS_DENIED',
      "This creative belongs to another client's campaign",
    );
  }
}

// Re-export so the compliance endpoint can include the same shape.
export type { CreativeApprovalState as PortalApprovalState };
