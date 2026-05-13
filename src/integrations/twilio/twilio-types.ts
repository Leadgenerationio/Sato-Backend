export interface TwilioSendRequest {
  /** E.164 phone number, e.g. "+447776531268" */
  to: string;
  /** SMS body. Twilio splits >160 chars across segments and bills per segment. */
  body: string;
}

export interface TwilioSendResponse {
  /** Twilio's message SID (or "mock-<ts>" when unconfigured). */
  id: string;
}
