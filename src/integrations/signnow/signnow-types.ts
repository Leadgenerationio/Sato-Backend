/**
 * Provider-neutral signing types. Same shape the DocuSign driver used so
 * `agreement.service.ts` only needs to swap the import, not the call-site.
 */
export type EnvelopeStatus =
  | 'created'
  | 'sent'
  | 'delivered'
  | 'signed'
  | 'completed'
  | 'declined'
  | 'voided';

// #47-50 PDF editor — a placed field to send to the signer. Coordinates
// arrive from the FE as fractions of the page (0..1); the signnow client
// converts to pixels at 72 DPI before posting.
export interface PreplacedField {
  page: number;             // 1-indexed
  type: 'signature' | 'date_signed' | 'text';
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  prefillValue?: string;    // type='text' only
}

export interface CreateEnvelopeInput {
  signerEmail: string;
  signerName: string;
  documentName: string;
  /** Base64-encoded PDF bytes. */
  documentBase64: string;
  emailSubject?: string;
  emailBody?: string;
  /**
   * #47-50 PDF editor — drag-placed fields. When supplied (non-empty),
   * the envelope is sent as a role-based invite with fields pre-positioned
   * at the given fractional coordinates. When omitted/empty, the free-
   * form invite path is used (signer places signature wherever).
   */
  fields?: PreplacedField[];
}

export interface EnvelopeResult {
  envelopeId: string;
  status: EnvelopeStatus;
  uri: string;
}

export interface SignNowToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * SignNow webhook envelope. Reference: docs.signnow.com → Guides → Webhooks.
 * The subset below is what `agreement.service.ts` actually reads; more fields
 * exist and can be added as needed.
 */
export interface SignNowWebhookEvent {
  event_type: 'document.create' | 'document.update' | 'document.complete' | 'document.delete' | 'invite.create' | 'invite.update';
  meta: {
    id: string;
    /** Document ID the event is about. */
    document_id?: string;
  };
  [key: string]: unknown;
}
