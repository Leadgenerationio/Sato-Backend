import type { UserRole } from '../types/index.js';

// Role Access Matrix (Sam feedback round 1, S7): one row per menu section.
//
// `floor` is the widest set of roles that can ever reach the section — it
// mirrors the requireRole() guard on the API routes behind it (and the
// FE sidebar / ProtectedRoute). The matrix can only switch a floor role OFF;
// it can never grant a role outside the floor, so a mis-click in Settings
// can't open finance data to a readonly user.
//
// `apiPrefixes` are the /api/v1 mounts requireSection() guards. Sections with
// no prefix are menu-only (the page is a shell over other sections' APIs).
//
// `locked` sections can't be switched at all (Settings must always be
// reachable — M6).
//
// Owner is never in the switchable set: Owner always has every section in
// its floor, and the API refuses to change it.

export interface SectionDef {
  key: string;
  label: string;
  group: string;
  floor: UserRole[];
  apiPrefixes: string[];
  locked?: boolean;
}

const STAFF: UserRole[] = ['owner', 'finance_admin', 'ops_manager', 'readonly'];
const INTERNAL: UserRole[] = ['owner', 'finance_admin', 'ops_manager'];
const FINANCE: UserRole[] = ['owner', 'finance_admin'];
const OPS: UserRole[] = ['owner', 'ops_manager'];
const PORTAL: UserRole[] = ['client', 'client_admin'];

export const SECTIONS: SectionDef[] = [
  { key: 'dashboard', label: 'Dashboard', group: 'Overview', floor: STAFF, apiPrefixes: ['/dashboard'] },
  { key: 'invoices', label: 'Invoices', group: 'Finance', floor: FINANCE, apiPrefixes: ['/invoices'] },
  { key: 'bank_feed', label: 'Bank Feed', group: 'Finance', floor: FINANCE, apiPrefixes: ['/finance/bank-feed'] },
  { key: 'auto_invoice', label: 'Auto-invoice', group: 'Finance', floor: FINANCE, apiPrefixes: ['/finance/auto-invoice'] },
  { key: 'reports', label: 'Reports', group: 'Finance', floor: FINANCE, apiPrefixes: ['/reports'] },
  { key: 'clients', label: 'Clients', group: 'Clients & campaigns', floor: INTERNAL, apiPrefixes: ['/clients'] },
  { key: 'campaigns', label: 'Campaigns', group: 'Clients & campaigns', floor: OPS, apiPrefixes: ['/campaigns'] },
  { key: 'agreements', label: 'Agreements', group: 'Clients & campaigns', floor: OPS, apiPrefixes: ['/agreements'] },
  { key: 'leadbyte', label: 'LeadByte', group: 'Clients & campaigns', floor: OPS, apiPrefixes: ['/leadbyte'] },
  { key: 'tasks', label: 'Tasks', group: 'Operations', floor: STAFF, apiPrefixes: ['/tasks'] },
  { key: 'sops', label: 'SOPs', group: 'Operations', floor: STAFF, apiPrefixes: ['/sops'] },
  { key: 'workflows', label: 'Workflows', group: 'Operations', floor: OPS, apiPrefixes: ['/workflows'] },
  { key: 'staff', label: 'Staff', group: 'Operations', floor: OPS, apiPrefixes: ['/hr'] },
  { key: 'sos', label: 'SOS Queue', group: 'Operations', floor: INTERNAL, apiPrefixes: ['/sos'] },
  { key: 'notifications', label: 'Notifications', group: 'Operations', floor: STAFF, apiPrefixes: ['/notifications'] },
  { key: 'integrations', label: 'Integrations', group: 'Admin', floor: ['owner'], apiPrefixes: ['/integrations'] },
  { key: 'user_management', label: 'User Management', group: 'Admin', floor: ['owner'], apiPrefixes: ['/users'] },
  { key: 'settings', label: 'Settings', group: 'Admin', floor: INTERNAL, apiPrefixes: [], locked: true },
  { key: 'portal', label: 'Client portal', group: 'Client portal', floor: PORTAL, apiPrefixes: ['/portal'] },
];

export const ALL_ROLES: UserRole[] = ['owner', 'finance_admin', 'ops_manager', 'readonly', 'client', 'client_admin'];

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

export function getSection(key: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.key === key);
}

/** Can the matrix switch this role on this section at all? */
export function isSwitchable(section: SectionDef, role: UserRole): boolean {
  return !section.locked && role !== 'owner' && section.floor.includes(role);
}
