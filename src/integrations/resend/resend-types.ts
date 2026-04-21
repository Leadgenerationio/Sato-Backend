export interface ResendSendRequest {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  tags?: Array<{ name: string; value: string }>;
}

export interface ResendSendResponse {
  id: string;
}

export interface ResendError {
  name: string;
  message: string;
  statusCode: number;
}
