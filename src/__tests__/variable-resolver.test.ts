import { describe, it, expect } from 'vitest';
import { resolveVariables } from '../services/variable-resolver.js';
import type { ClientDetail } from '../services/client.service.js';

function makeClient(over: Partial<ClientDetail> = {}): ClientDetail {
  return {
    id: 'test-id',
    companyName: 'Acme Ltd',
    companyNumber: '12345678',
    contactName: 'John Smith',
    contactEmail: 'john@acme.example',
    contactPhone: '020 1234 5678',
    addressLine: '1 Acme St',
    addressTown: 'London',
    addressCounty: 'Greater London',
    addressCountry: 'UK',
    addressPostcode: 'SW1A 1AA',
    address: '1 Acme St, London',
    currency: 'GBP',
    paymentTermsDays: 14,
    vatRegistered: true,
    addVatToInvoices: true,
    vatNumber: 'GB123456789',
    vatRate: 20,
    leadPrice: 3.5,
    billingWorkflow: 'weekly_auto',
    onboardingStatus: 'agreement_signed',
    status: 'active',
    agreementSigned: true,
    creditScore: null,
    creditLastChecked: null,
    creditRiskRating: null,
    leadbyteClientId: null,
    endoleCompanyId: null,
    xeroContactId: null,
    notes: '',
    contacts: [],
    activeCampaigns: 0,
    totalRevenue: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as unknown as ClientDetail;
}

describe('variable-resolver — happy path', () => {
  it('resolves all 11 variables with sensible UK formatting', () => {
    const r = resolveVariables(makeClient(), { effectiveDate: null });
    expect(r['client.companyName']).toBe('Acme Ltd');
    expect(r['client.companyNumber']).toBe('12345678');
    expect(r['client.vatNumber']).toBe('GB123456789');
    expect(r['client.contactName']).toBe('John Smith');
    expect(r['client.contactEmail']).toBe('john@acme.example');
    expect(r['client.contactPhone']).toBe('020 1234 5678');
    expect(r['client.address']).toBe('1 Acme St, London, Greater London, SW1A 1AA, UK');
    expect(r['client.leadPrice']).toBe('£3.50 per lead');
    expect(r['client.paymentTermsDays']).toBe('14 days');
    expect(r['client.billingWorkflow']).toBe('Weekly auto');
    expect(r['today']).toMatch(/\d+ \w+ \d{4}/);
    expect(r['agreement.effectiveDate']).toMatch(/\d+ \w+ \d{4}/);
  });
});

describe('variable-resolver — missing fields', () => {
  it('renders missing fields as empty string (no exception)', () => {
    const r = resolveVariables(
      makeClient({ vatNumber: null as unknown as string, contactPhone: null as unknown as string, leadPrice: null as unknown as number }),
      { effectiveDate: null },
    );
    expect(r['client.vatNumber']).toBe('');
    expect(r['client.contactPhone']).toBe('');
    expect(r['client.leadPrice']).toBe('');
  });

  it('renders empty address parts skipped from join', () => {
    const r = resolveVariables(
      makeClient({ addressLine: '1 X St', addressTown: 'Y', addressCounty: '', addressPostcode: 'Z', addressCountry: '' }),
      { effectiveDate: null },
    );
    expect(r['client.address']).toBe('1 X St, Y, Z');
  });
});

describe('variable-resolver — billing workflow labels', () => {
  it('maps weekly_auto → "Weekly auto"', () => {
    const r = resolveVariables(makeClient({ billingWorkflow: 'weekly_auto' }), { effectiveDate: null });
    expect(r['client.billingWorkflow']).toBe('Weekly auto');
  });
  it('maps monthly_validated → "Monthly validated"', () => {
    const r = resolveVariables(makeClient({ billingWorkflow: 'monthly_validated' }), { effectiveDate: null });
    expect(r['client.billingWorkflow']).toBe('Monthly validated');
  });
  it('maps custom → "Custom"', () => {
    const r = resolveVariables(makeClient({ billingWorkflow: 'custom' }), { effectiveDate: null });
    expect(r['client.billingWorkflow']).toBe('Custom');
  });
  it('unknown billing workflow falls back to raw value', () => {
    const r = resolveVariables(makeClient({ billingWorkflow: 'mystery' as unknown as 'custom' }), { effectiveDate: null });
    expect(r['client.billingWorkflow']).toBe('mystery');
  });
});

describe('variable-resolver — overrides', () => {
  it('overrides take precedence over resolved values', () => {
    const r = resolveVariables(
      makeClient(),
      { effectiveDate: null },
      { 'client.leadPrice': '£4.00 per lead', 'client.companyName': 'Override Ltd' },
    );
    expect(r['client.leadPrice']).toBe('£4.00 per lead');
    expect(r['client.companyName']).toBe('Override Ltd');
  });

  it('override with empty string blanks the value (not falls back to client)', () => {
    const r = resolveVariables(makeClient(), { effectiveDate: null }, { 'client.companyName': '' });
    expect(r['client.companyName']).toBe('');
  });
});

describe('variable-resolver — agreement.effectiveDate', () => {
  it('uses provided effectiveDate (UK formatted)', () => {
    const r = resolveVariables(makeClient(), { effectiveDate: '2026-06-01' });
    expect(r['agreement.effectiveDate']).toBe('1 June 2026');
  });
  it('defaults to today when null', () => {
    const r = resolveVariables(makeClient(), { effectiveDate: null });
    expect(r['agreement.effectiveDate']).toBe(r['today']);
  });
});
