export type XeroErrorCode =
  | 'xero_not_configured'
  | 'xero_not_connected'
  | 'xero_unauthorized'
  | 'xero_rate_limit'
  | 'xero_validation'
  | 'xero_api_error'
  | 'unknown';

export interface ClassifiedError {
  code: XeroErrorCode;
  message: string;
  /** HTTP status to return to the FE — 502 for upstream, 401 for auth, 429 for rate-limit, 400 for validation. */
  httpStatus: number;
}

export function classifyXeroError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : 'Xero request failed';

  if (/credentials not configured|XERO_CLIENT_ID|XERO_CLIENT_SECRET/i.test(message)) {
    return { code: 'xero_not_configured', message: 'Xero is not configured on this server. Add credentials in admin.', httpStatus: 503 };
  }
  if (/no xero tenant|integration not found|xero exchange_failed/i.test(message)) {
    return { code: 'xero_not_connected', message: 'Xero is not connected. Reconnect on the Integrations page.', httpStatus: 409 };
  }
  if (/auth failed: 401|\b401\b|unauthori[sz]ed|token (expired|invalid)/i.test(message)) {
    return { code: 'xero_unauthorized', message: 'Xero session expired — reconnect on the Integrations page.', httpStatus: 401 };
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    return { code: 'xero_rate_limit', message: 'Xero is rate-limiting requests — try again in a minute.', httpStatus: 429 };
  }
  // Validation/4xx from Xero → still surface as 502 because the caller didn't
  // submit bad data; our own integration code did. The `code` lets the FE branch.
  if (/\b4\d\d\b|validation/i.test(message)) {
    return { code: 'xero_validation', message, httpStatus: 502 };
  }
  return { code: 'xero_api_error', message, httpStatus: 502 };
}
