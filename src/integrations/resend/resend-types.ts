export interface ResendSendRequest {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  tags?: Array<{ name: string; value: string }>;
  /**
   * Optional Stato client UUID. When present, the email worker writes a
   * client_emails row + activity-feed entry after a successful send so the
   * client's email thread + activity panel show every outbound message.
   * Forwarded-to-Resend payload ignores this field — it's worker-only.
   */
  clientId?: string;
  /**
   * Coarse label for what produced this send ('portal_welcome',
   * 'password_reset', …). Stored on the email_deliveries ledger so invite
   * failures can be filtered without string-matching subject lines.
   * Worker-only — not forwarded to Resend.
   */
  kind?: string;
}

export interface ResendSendResponse {
  id: string;
}

export interface ResendError {
  name: string;
  message: string;
  statusCode: number;
}
