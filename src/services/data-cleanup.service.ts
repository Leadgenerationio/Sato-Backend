/**
 * Settings → Clean up (Sam feedback round 1, 29 Sep 2026: S8 + N6).
 *
 * Finds likely test / demo data and untidy contact names, and lets the Owner
 * resolve it with one "Apply". The detection rules are shared with
 * scripts/audit-test-data.ts so the report and the screen always agree.
 *
 * Nothing is ever deleted:
 *   - test logins are DEACTIVATED (is_active=false) — audit rows keep pointing at them;
 *   - extra Owners are given a lower role;
 *   - SOS entries, SOPs and staff rows are ARCHIVED (archived_at) and hidden from lists;
 *   - contact names/emails are trimmed (whitespace only).
 */
import { sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { adminCleanupLog } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import type { AuthPayload } from '../types/index.js';

// Emails/names that look like fixtures. Matched case-insensitively.
export const TEST_EMAIL_PATTERNS = ['%@test.com', '%@example.com', 'demo@%', 'test@%', '%+test@%'];
export const TEST_USER_NAMES = ['demo', 'test', 'john', 'test user'];
export const TEST_TEXT = ['test', 'testing', 'msg', 'asdf', 'demo', 'do not save', 'ux test'];
export const TEST_SOP_TITLES = [...TEST_TEXT, 'onbording'];
export const PLACEHOLDER_STAFF_NAMES = ['john', 'test', 'demo'];
/** Roles an extra Owner may be moved to. */
export const DEMOTE_ROLES = ['finance_admin', 'ops_manager', 'readonly'] as const;
export type DemoteRole = (typeof DEMOTE_ROLES)[number];

const textArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;

export interface CleanupUser {
  id: string; email: string; name: string; role: string; isActive: boolean;
  isPrimaryOwner: boolean; isYou: boolean; reason: string; preselect: boolean;
}
export interface CleanupRow { id: string; label: string; detail: string | null; reason: string; preselect: boolean }
export interface CleanupContact { id: string; kind: 'contact' | 'client'; label: string; detail: string | null }
export interface CleanupReport {
  owners: CleanupUser[];
  testLogins: CleanupUser[];
  testSos: CleanupRow[];
  testSops: CleanupRow[];
  placeholderStaff: CleanupRow[];
  untrimmedContacts: CleanupContact[];
  agreementTemplatesCount: number;
}

type UserDbRow = { id: string; email: string; name: string; role: string; is_active: boolean; is_primary_owner: boolean };

function testLoginReason(email: string, name: string): string {
  const e = email.toLowerCase();
  const domain = e.split('@')[1] ?? '';
  if (domain === 'test.com' || domain === 'example.com') return `email on ${domain}`;
  if (e.startsWith('demo@')) return 'demo login';
  if (e.startsWith('test@') || e.includes('+test@')) return 'test email address';
  return `name "${name.trim()}" looks like a placeholder`;
}

function businessScope(requester: AuthPayload, column: string) {
  // Rows created before business scoping have a NULL business — include them.
  return requester.businessId
    ? sql`(${sql.raw(column)} = ${requester.businessId} OR ${sql.raw(column)} IS NULL)`
    : sql`TRUE`;
}

export async function getCleanupReport(requester: AuthPayload): Promise<CleanupReport> {
  const toUser = (r: UserDbRow, reason: string, preselect: boolean): CleanupUser => ({
    id: r.id, email: r.email, name: r.name, role: r.role, isActive: r.is_active,
    isPrimaryOwner: r.is_primary_owner, isYou: r.id === requester.userId, reason, preselect,
  });

  const owners = (await db.execute<UserDbRow>(sql`
    SELECT id, email, name, role, is_active, is_primary_owner FROM users
    WHERE role = 'owner' AND is_active AND ${businessScope(requester, 'business_id')}
    ORDER BY created_at`)) as unknown as UserDbRow[];

  const testUsers = (await db.execute<UserDbRow>(sql`
    SELECT id, email, name, role, is_active, is_primary_owner FROM users
    WHERE is_active
      AND (email ILIKE ANY(${textArray(TEST_EMAIL_PATTERNS)}) OR lower(trim(name)) = ANY(${textArray(TEST_USER_NAMES)}))
      AND ${businessScope(requester, 'business_id')}
    ORDER BY created_at`)) as unknown as UserDbRow[];

  const sos = (await db.execute<{ id: string; message: string | null; page_path: string | null }>(sql`
    SELECT id, message, page_path FROM sos_help_requests
    WHERE archived_at IS NULL
      AND (lower(trim(coalesce(message, ''))) = ANY(${textArray(TEST_TEXT)}) OR length(trim(coalesce(message, ''))) <= 3)
    ORDER BY created_at`)) as unknown as Array<{ id: string; message: string | null; page_path: string | null }>;

  const sops = (await db.execute<{ id: string; title: string; status: string }>(sql`
    SELECT id, title, status FROM sops
    WHERE archived_at IS NULL
      AND (lower(trim(title)) = ANY(${textArray(TEST_SOP_TITLES)}) OR length(trim(title)) <= 3)
      AND ${businessScope(requester, 'business_id')}
    ORDER BY created_at`)) as unknown as Array<{ id: string; title: string; status: string }>;

  const staffRows = (await db.execute<{ id: string; name: string; email: string }>(sql`
    SELECT id, name, email FROM staff
    WHERE archived_at IS NULL
      AND (lower(trim(name)) = ANY(${textArray(PLACEHOLDER_STAFF_NAMES)}) OR position(' ' in trim(name)) = 0)
      AND ${businessScope(requester, 'business_id')}
    ORDER BY created_at`)) as unknown as Array<{ id: string; name: string; email: string }>;

  const contacts = (await db.execute<{ id: string; name: string; email: string | null }>(sql`
    SELECT id, name, email FROM client_contacts WHERE name <> trim(name) OR email <> trim(email)`)) as unknown as Array<{ id: string; name: string; email: string | null }>;
  const clientRows = (await db.execute<{ id: string; company_name: string; contact_name: string | null }>(sql`
    SELECT id, company_name, contact_name FROM clients
    WHERE (contact_name <> trim(contact_name) OR contact_email <> trim(contact_email) OR company_name <> trim(company_name))
      AND ${businessScope(requester, 'business_id')}`)) as unknown as Array<{ id: string; company_name: string; contact_name: string | null }>;

  const [tpl] = (await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM agreement_templates WHERE archived_at IS NULL`)) as unknown as Array<{ n: number }>;

  return {
    // Owners are never pre-selected: whether someone should stay Owner is a judgement call.
    owners: owners.map((o) => toUser(o, o.is_primary_owner ? 'primary owner' : 'has full Owner access', false)),
    testLogins: testUsers.map((u) => toUser(u, testLoginReason(u.email, u.name), u.id !== requester.userId && !u.is_primary_owner)),
    testSos: sos.map((s) => ({
      id: s.id, label: s.message?.trim() ? `"${s.message.trim().slice(0, 60)}"` : '(no message)', detail: s.page_path,
      reason: s.message?.trim() && TEST_TEXT.includes(s.message.trim().toLowerCase()) ? 'message looks like a test' : 'message is empty or 3 characters or fewer',
      preselect: true,
    })),
    testSops: sops.map((s) => {
      const t = s.title.trim().toLowerCase();
      return {
        id: s.id, label: s.title, detail: s.status,
        reason: t === 'onbording' ? 'misspelt title ("onbording")' : TEST_TEXT.includes(t) ? 'title looks like a test' : 'title is 3 characters or fewer',
        preselect: true,
      };
    }),
    placeholderStaff: staffRows.map((s) => {
      const obvious = PLACEHOLDER_STAFF_NAMES.includes(s.name.trim().toLowerCase());
      return {
        id: s.id, label: s.name, detail: s.email,
        reason: obvious ? 'name looks like a placeholder' : 'first name only — check it is a real person',
        // A single first name can be a real person: only pre-tick the obvious placeholders.
        preselect: obvious,
      };
    }),
    untrimmedContacts: [
      ...contacts.map((c) => ({ id: c.id, kind: 'contact' as const, label: JSON.stringify(c.name), detail: c.email })),
      ...clientRows.map((c) => ({ id: c.id, kind: 'client' as const, label: JSON.stringify(c.company_name), detail: c.contact_name ? JSON.stringify(c.contact_name) : null })),
    ],
    agreementTemplatesCount: tpl?.n ?? 0,
  };
}

export interface CleanupApplyInput {
  deactivateUserIds?: string[];
  demoteOwnerIds?: Array<{ id: string; role: DemoteRole }>;
  archiveSosIds?: string[];
  archiveSopIds?: string[];
  archiveStaffIds?: string[];
  trimContacts?: boolean;
}
export interface CleanupApplyResult {
  deactivated: Array<{ id: string; email: string }>;
  demoted: Array<{ id: string; email: string; role: DemoteRole }>;
  archivedSos: number;
  archivedSops: number;
  archivedStaff: number;
  trimmedContacts: number;
  trimmedClients: number;
}

const refuse = (message: string) => new AppError(422, message);

export async function applyCleanup(requester: AuthPayload, input: CleanupApplyInput): Promise<CleanupApplyResult> {
  const report = await getCleanupReport(requester);
  const deactivate = [...new Set(input.deactivateUserIds ?? [])];
  const demote = input.demoteOwnerIds ?? [];
  const sosIds = [...new Set(input.archiveSosIds ?? [])];
  const sopIds = [...new Set(input.archiveSopIds ?? [])];
  const staffIds = [...new Set(input.archiveStaffIds ?? [])];

  // Only rows the report currently flags can be changed from this screen.
  const flagged = (ids: string[], list: Array<{ id: string }>, what: string) => {
    const allowed = new Set(list.map((r) => r.id));
    const bad = ids.filter((id) => !allowed.has(id));
    if (bad.length) throw refuse(`${bad.length} of the selected ${what} are no longer flagged. Refresh the page and try again — nothing was changed.`);
  };
  flagged(deactivate, report.testLogins, 'logins');
  flagged(demote.map((d) => d.id), report.owners, 'Owners');
  flagged(sosIds, report.testSos, 'SOS entries');
  flagged(sopIds, report.testSops, 'SOPs');
  flagged(staffIds, report.placeholderStaff, 'staff records');
  if (new Set(demote.map((d) => d.id)).size !== demote.length) throw refuse('Each Owner can only be given one new role.');
  if (demote.some((d) => deactivate.includes(d.id))) throw refuse('Choose either "deactivate" or "change role" for a login, not both.');

  const touched = [...deactivate, ...demote.map((d) => d.id)];
  if (touched.includes(requester.userId)) throw refuse("You can't deactivate your own login or change your own role here. Nothing was changed.");
  const allUsers = [...report.owners, ...report.testLogins];
  const primary = allUsers.find((u) => touched.includes(u.id) && u.isPrimaryOwner);
  if (primary) throw refuse(`${primary.email} is the primary Owner and can't be deactivated or demoted. Nothing was changed.`);
  const remainingOwners = report.owners.filter((o) => !touched.includes(o.id));
  if (report.owners.length > 0 && remainingOwners.length === 0) throw refuse('At least one active Owner must remain. Nothing was changed.');

  const emailOf = new Map(allUsers.map((u) => [u.id, u.email]));
  const result: CleanupApplyResult = {
    deactivated: deactivate.map((id) => ({ id, email: emailOf.get(id) ?? '' })),
    demoted: demote.map((d) => ({ id: d.id, email: emailOf.get(d.id) ?? '', role: d.role })),
    archivedSos: 0, archivedSops: 0, archivedStaff: 0, trimmedContacts: 0, trimmedClients: 0,
  };
  const uuidList = (ids: string[]) => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

  await db.transaction(async (tx) => {
    if (deactivate.length) {
      await tx.execute(sql`UPDATE users SET is_active = false, updated_at = now() WHERE id = ANY(${uuidList(deactivate)})`);
    }
    for (const d of demote) {
      await tx.execute(sql`UPDATE users SET role = ${d.role}::user_role, updated_at = now() WHERE id = ${d.id} AND role = 'owner'`);
    }
    if (sosIds.length) {
      const r = await tx.execute(sql`UPDATE sos_help_requests SET archived_at = now() WHERE id = ANY(${uuidList(sosIds)}) AND archived_at IS NULL`);
      result.archivedSos = (r as unknown as { count: number }).count ?? sosIds.length;
    }
    if (sopIds.length) {
      const r = await tx.execute(sql`UPDATE sops SET archived_at = now(), updated_at = now() WHERE id = ANY(${uuidList(sopIds)}) AND archived_at IS NULL`);
      result.archivedSops = (r as unknown as { count: number }).count ?? sopIds.length;
    }
    if (staffIds.length) {
      const r = await tx.execute(sql`UPDATE staff SET archived_at = now(), updated_at = now() WHERE id = ANY(${uuidList(staffIds)}) AND archived_at IS NULL`);
      result.archivedStaff = (r as unknown as { count: number }).count ?? staffIds.length;
    }
    if (input.trimContacts) {
      const a = await tx.execute(sql`
        UPDATE client_contacts SET name = trim(name), email = trim(email), updated_at = now()
        WHERE name <> trim(name) OR email <> trim(email)`);
      const b = await tx.execute(sql`
        UPDATE clients SET contact_name = trim(contact_name), contact_email = trim(contact_email),
                           company_name = trim(company_name), updated_at = now()
        WHERE (contact_name <> trim(contact_name) OR contact_email <> trim(contact_email) OR company_name <> trim(company_name))
          AND ${businessScope(requester, 'business_id')}`);
      result.trimmedContacts = (a as unknown as { count: number }).count ?? 0;
      result.trimmedClients = (b as unknown as { count: number }).count ?? 0;
    }
    await tx.insert(adminCleanupLog).values({
      businessId: requester.businessId ?? null,
      actorUserId: requester.userId,
      changes: result,
    });
  });

  return result;
}
