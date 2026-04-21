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
  documentBase64: string;
  emailSubject?: string;
  emailBody?: string;
}

export interface EnvelopeResult {
  envelopeId: string;
  status: EnvelopeStatus;
  uri: string;
}

export interface DocuSignJwtToken {
  accessToken: string;
  expiresAt: number;
}

export interface DocuSignWebhookEvent {
  event: string;
  data: {
    envelopeId: string;
    envelopeSummary: {
      status: EnvelopeStatus;
      completedDateTime?: string;
      declinedDateTime?: string;
      recipients?: {
        signers: Array<{ email: string; name: string; status: string; signedDateTime?: string }>;
      };
    };
  };
}
