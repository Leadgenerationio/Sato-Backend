import type { UserRole } from '../types/index.js';

export interface PermissionEntry {
  permission: string;
  access: Record<UserRole, boolean>;
}

// Default permissions — owner can change these at runtime
const permissions: PermissionEntry[] = [
  { permission: 'View Dashboard', access: { owner: true, finance_admin: true, ops_manager: true, client: true, readonly: true } },
  { permission: 'Manage Users', access: { owner: true, finance_admin: false, ops_manager: false, client: false, readonly: false } },
  { permission: 'View Finance', access: { owner: true, finance_admin: true, ops_manager: false, client: false, readonly: true } },
  { permission: 'Manage Invoices', access: { owner: true, finance_admin: true, ops_manager: false, client: false, readonly: false } },
  { permission: 'Manage Campaigns', access: { owner: true, finance_admin: false, ops_manager: true, client: false, readonly: false } },
  { permission: 'View Reports', access: { owner: true, finance_admin: true, ops_manager: true, client: false, readonly: true } },
  { permission: 'Manage Clients', access: { owner: true, finance_admin: true, ops_manager: true, client: false, readonly: false } },
  { permission: 'View Portal', access: { owner: false, finance_admin: false, ops_manager: false, client: true, readonly: false } },
  { permission: 'System Settings', access: { owner: true, finance_admin: true, ops_manager: true, client: false, readonly: false } },
];

export function getPermissions(): PermissionEntry[] {
  return permissions;
}

export function updatePermission(permission: string, role: UserRole, allowed: boolean): PermissionEntry | null {
  const entry = permissions.find((p) => p.permission === permission);
  if (!entry) return null;

  // Owner permissions are immutable at the data layer as a defence in depth
  if (role === 'owner') return entry;

  entry.access[role] = allowed;
  return entry;
}
