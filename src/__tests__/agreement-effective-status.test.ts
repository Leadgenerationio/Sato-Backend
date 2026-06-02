import { describe, it, expect } from 'vitest';
import { computeEffectiveAgreementStatus } from '../services/agreement.service.js';

// Bug A3 (Sam, 29-May → 01-Jun): the admin Agreements page must show an
// agreement as SIGNED whenever it is effectively signed — including the
// `clients.agreementSigned` admin override Sam uses for offline signatures
// (e.g. Benson Goldstein). Previously the admin read the raw `agreements.status`
// ('sent') and showed "Sent" while the portal + dashboard showed "Signed",
// then a partial fix made it show "Completed" for the override while the portal
// said "Signed". This locks the admin to MATCH the portal: override → 'signed'.

describe('computeEffectiveAgreementStatus — admin/portal status parity', () => {
  it('override active + raw status "sent" → "signed" (the Benson Goldstein case)', () => {
    const r = computeEffectiveAgreementStatus({
      status: 'sent',
      signedAt: null,
      clientAgreementSigned: true,
    });
    expect(r.effectiveStatus).toBe('signed');
    expect(r.rawStatus).toBe('sent');
    expect(r.effectiveSigned).toBe(true);
  });

  it('override active + raw status "pending" → "signed"', () => {
    const r = computeEffectiveAgreementStatus({
      status: 'pending',
      signedAt: null,
      clientAgreementSigned: true,
    });
    expect(r.effectiveStatus).toBe('signed');
  });

  it('genuine SignNow completion (status="completed") stays "completed"', () => {
    const r = computeEffectiveAgreementStatus({
      status: 'completed',
      signedAt: new Date('2026-05-18T10:00:00Z'),
      clientAgreementSigned: false,
    });
    expect(r.effectiveStatus).toBe('completed');
    expect(r.effectiveSigned).toBe(true);
  });

  it('signedAt present but status not yet flipped → "signed"', () => {
    const r = computeEffectiveAgreementStatus({
      status: 'sent',
      signedAt: new Date('2026-05-18T10:00:00Z'),
      clientAgreementSigned: false,
    });
    expect(r.effectiveStatus).toBe('signed');
    expect(r.effectiveSigned).toBe(true);
  });

  it('not signed and no override → raw status passes through unchanged', () => {
    const r = computeEffectiveAgreementStatus({
      status: 'sent',
      signedAt: null,
      clientAgreementSigned: false,
    });
    expect(r.effectiveStatus).toBe('sent');
    expect(r.effectiveSigned).toBe(false);
  });

  it('null status with no signing signal defaults to "pending"', () => {
    const r = computeEffectiveAgreementStatus({
      status: null,
      signedAt: null,
      clientAgreementSigned: false,
    });
    expect(r.effectiveStatus).toBe('pending');
    expect(r.effectiveSigned).toBe(false);
  });

  it('declined agreement is not signed even with status set', () => {
    const r = computeEffectiveAgreementStatus({
      status: 'declined',
      signedAt: null,
      clientAgreementSigned: false,
    });
    expect(r.effectiveStatus).toBe('declined');
    expect(r.effectiveSigned).toBe(false);
  });
});
