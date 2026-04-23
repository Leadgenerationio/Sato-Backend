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

export interface CreateEnvelopeInput {
  signerEmail: string;
  signerName: string;
  documentName: string;
  /** Base64-encoded PDF bytes. */
  documentBase64: string;
  emailSubject?: string;
  emailBody?: string;
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
