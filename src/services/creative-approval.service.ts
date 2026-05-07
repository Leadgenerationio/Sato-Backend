import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creativeApprovals } from '../db/schema/creative-approvals.js';
import { creatives } from '../db/schema/creatives.js';
import { campaigns } from '../db/schema/campaigns.js';
import { users } from '../db/schema/users.js';

export type CreativeApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface CreativeApprovalEvent {
  id: string;
  action: 'approved' | 'rejected';
  decidedByUserId: string;
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
  constructor(public code: 'NOT_FOUND' | 'ACCESS_DENIED' | 'FEEDBACK_REQUIRED', message: string) {
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

  // DISTINCT ON returns the most recent row per creative_id. Sorted desc by
  // created_at within each partition.
  const rows = await db.execute<{
    creative_id: string;
    action: 'approved' | 'rejected';
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
 * Record a client decision on a creative. Always inserts a new row — the
 * audit trail is append-only so a later "did you actually approve?" query
 * has the full chronology.
 */
export async function recordDecision(params: {
  creativeId: string;
  decidedByUserId: string;
  action: 'approved' | 'rejected';
  ipAddress: string | null;
  userAgent: string | null;
  feedback: string | null;
}): Promise<CreativeApprovalEvent> {
  const { creativeId, decidedByUserId, action, ipAddress, userAgent, feedback } = params;

  if (action === 'rejected' && (!feedback || feedback.trim().length === 0)) {
    throw new CreativeApprovalError(
      'FEEDBACK_REQUIRED',
      'Reject feedback is required so the team can address the issue',
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
 */
export async function assertCreativeBelongsToClient(
  creativeId: string,
  clientId: string,
): Promise<void> {
  const [row] = await db
    .select({ clientId: campaigns.clientId })
    .from(creatives)
    .innerJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .where(eq(creatives.id, creativeId));

  if (!row) {
    throw new CreativeApprovalError('NOT_FOUND', 'Creative not found');
  }
  if (row.clientId !== clientId) {
    throw new CreativeApprovalError(
      'ACCESS_DENIED',
      "This creative belongs to another client's campaign",
    );
  }
}

// Re-export so the compliance endpoint can include the same shape.
export type { CreativeApprovalState as PortalApprovalState };
