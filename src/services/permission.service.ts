import { desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { rolePermissions, rolePermissionChanges } from '../db/schema/index.js';
import { SECTIONS, ALL_ROLES, getSection, isSwitchable, type SectionDef } from '../config/sections.js';
import type { AuthPayload, UserRole } from '../types/index.js';

// Role Access Matrix (S7). Rows in role_permissions are explicit choices;
// a missing row means "allowed" (within the section's floor).

/** What a cell in the matrix is, for one role on one section. */
export type CellState = 'always' | 'on' | 'off' | 'none';

export interface MatrixSection {
  key: string;
  label: string;
  group: string;
  locked: boolean;
  access: Record<UserRole, CellState>;
}

/** Legacy shape the pre-S7 Settings page reads (`permissions[]`). */
export interface LegacyPermissionEntry {
  permission: string;
  access: Record<UserRole, boolean>;
}

// Overrides are read on every guarded request, so keep a short per-business
// cache. Writes on this instance invalidate it immediately; another instance
// (the worker) sees the change within the TTL.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; overrides: Map<string, boolean> }>();

const cellKey = (section: string, role: UserRole) => `${section}:${role}`;

export function clearPermissionCache(): void {
  cache.clear();
}

async function loadOverrides(businessId: string): Promise<Map<string, boolean>> {
  const hit = cache.get(businessId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.overrides;

  const rows = await db
    .select({ section: rolePermissions.section, role: rolePermissions.role, allowed: rolePermissions.allowed })
    .from(rolePermissions)
    .where(eq(rolePermissions.businessId, businessId));

  const overrides = new Map<string, boolean>();
  for (const r of rows) overrides.set(cellKey(r.section, r.role as UserRole), r.allowed);
  cache.set(businessId, { at: Date.now(), overrides });
  return overrides;
}

export function cellState(section: SectionDef, role: UserRole, overrides: Map<string, boolean>): CellState {
  if (!section.floor.includes(role)) return 'none';
  if (role === 'owner' || section.locked) return 'always';
  return overrides.get(cellKey(section.key, role)) === false ? 'off' : 'on';
}

const isAllowed = (s: CellState) => s === 'always' || s === 'on';

export async function getMatrix(businessId: string | undefined): Promise<MatrixSection[]> {
  const overrides = businessId ? await loadOverrides(businessId) : new Map<string, boolean>();
  return SECTIONS.map((s) => ({
    key: s.key,
    label: s.label,
    group: s.group,
    locked: !!s.locked,
    access: Object.fromEntries(ALL_ROLES.map((r) => [r, cellState(s, r, overrides)])) as Record<UserRole, CellState>,
  }));
}

export function toLegacy(matrix: MatrixSection[]): LegacyPermissionEntry[] {
  return matrix.map((m) => ({
    permission: m.label,
    access: Object.fromEntries(ALL_ROLES.map((r) => [r, isAllowed(m.access[r])])) as Record<UserRole, boolean>,
  }));
}

/** Section keys the caller may open — drives the sidebar. */
export async function getSectionsFor(user: AuthPayload): Promise<string[]> {
  const overrides = user.businessId ? await loadOverrides(user.businessId) : new Map<string, boolean>();
  return SECTIONS.filter((s) => isAllowed(cellState(s, user.role, overrides))).map((s) => s.key);
}

/**
 * Server-side check used by requireSection(). Returns true (let the route's
 * own requireRole decide) for roles outside the floor — the matrix only ever
 * restricts floor roles, it never widens or duplicates the route guard.
 */
export async function isSectionAllowed(user: AuthPayload, sectionKey: string): Promise<boolean> {
  const section = getSection(sectionKey);
  if (!section) return true;
  if (!isSwitchable(section, user.role)) return true;
  if (!user.businessId) return true;
  const overrides = await loadOverrides(user.businessId);
  return overrides.get(cellKey(section.key, user.role)) !== false;
}

export class PermissionChangeError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

/** Accepts a section key or its label (the pre-S7 FE sends the label). */
export function resolveSection(keyOrLabel: string): SectionDef | undefined {
  return getSection(keyOrLabel) ?? SECTIONS.find((s) => s.label.toLowerCase() === keyOrLabel.toLowerCase());
}

export async function setPermission(
  requester: AuthPayload,
  keyOrLabel: string,
  role: UserRole,
  allowed: boolean,
): Promise<MatrixSection> {
  // Owner first: it's immutable whatever section (or stale label) is named.
  if (role === 'owner') throw new PermissionChangeError(403, 'Owner permissions are immutable');
  if (!requester.businessId) throw new PermissionChangeError(400, 'Your account is not linked to a business');
  const section = resolveSection(keyOrLabel);
  if (!section) throw new PermissionChangeError(404, 'Permission not found');
  if (section.locked) throw new PermissionChangeError(422, `${section.label} is always available and can't be switched off`);
  if (!section.floor.includes(role)) {
    throw new PermissionChangeError(422, `${section.label} isn't available to this role, so it can't be switched on here`);
  }

  const businessId = requester.businessId;
  const before = (await loadOverrides(businessId)).get(cellKey(section.key, role)) !== false;

  if (before !== allowed) {
    await db.transaction(async (tx) => {
      await tx
        .insert(rolePermissions)
        .values({ businessId, section: section.key, role, allowed, updatedBy: requester.userId })
        .onConflictDoUpdate({
          target: [rolePermissions.businessId, rolePermissions.section, rolePermissions.role],
          set: { allowed, updatedBy: requester.userId, updatedAt: new Date() },
        });
      await tx.insert(rolePermissionChanges).values({
        businessId, section: section.key, role, allowedBefore: before, allowedAfter: allowed, changedBy: requester.userId,
      });
    });
    cache.delete(businessId);
  }

  const matrix = await getMatrix(businessId);
  return matrix.find((m) => m.key === section.key)!;
}

export async function listChanges(businessId: string, limit = 50) {
  return db
    .select()
    .from(rolePermissionChanges)
    .where(eq(rolePermissionChanges.businessId, businessId))
    .orderBy(desc(rolePermissionChanges.changedAt))
    .limit(limit);
}
