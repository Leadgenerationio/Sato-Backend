import type { ClientDetail } from './client.service.js';
import { formatMoney } from '../utils/currency.js';

const BILLING_LABELS: Record<string, string> = {
  weekly_auto: 'Weekly auto',
  monthly_validated: 'Monthly validated',
  custom: 'Custom',
};

function formatAddress(c: Pick<ClientDetail, 'addressLine' | 'addressTown' | 'addressCounty' | 'addressPostcode' | 'addressCountry'>): string {
  return [c.addressLine, c.addressTown, c.addressCounty, c.addressPostcode, c.addressCountry]
    .filter((p) => !!p && p.length > 0)
    .join(', ');
}

function formatUkDate(input?: string | Date | null): string {
  const d = input ? new Date(input) : new Date();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Resolve variable values from a client + agreement. Pure function — no I/O.
 * Overrides win over base values. Missing client fields render as empty strings.
 */
export function resolveVariables(
  client: ClientDetail,
  agreement: { effectiveDate: string | null },
  overrides: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    'client.companyName': client.companyName ?? '',
    'client.companyNumber': client.companyNumber ?? '',
    'client.vatNumber': client.vatNumber ?? '',
    'client.contactName': client.contactName ?? '',
    'client.contactEmail': client.contactEmail ?? '',
    'client.contactPhone': client.contactPhone ?? '',
    'client.address': formatAddress(client),
    // Feedback M3: in the client's own currency (was hard-coded £).
    'client.leadPrice': client.leadPrice != null ? `${formatMoney(client.leadPrice, client.currency)} per lead` : '',
    'client.paymentTermsDays': client.paymentTermsDays != null ? `${client.paymentTermsDays} days` : '',
    'client.billingWorkflow': BILLING_LABELS[client.billingWorkflow] ?? client.billingWorkflow ?? '',
    'today': formatUkDate(),
    'agreement.effectiveDate': formatUkDate(agreement.effectiveDate ?? undefined),
  };
  return { ...base, ...overrides };
}
