import { AppError } from '../../utils/errors.js';

/**
 * Typed error for credit-check provider failures (Endole / Creditsafe HTTP
 * non-2xx, network failure, malformed body). Surfacing this as an AppError
 * means the global errorHandler returns 502 with a stable `code` instead of a
 * generic 500 — the FE can then show a useful message ("Endole balance
 * exhausted") instead of "Internal server error".
 *
 * Codes:
 *   - credit_provider_balance_exhausted  → upstream returned "no credits left"
 *                                          (Endole error_code "102"). Sam needs
 *                                          to top up at endole.co.uk.
 *   - credit_provider_failed             → any other upstream error (401/403/
 *                                          429/404/5xx, network, timeout).
 */
export class CreditProviderError extends AppError {
  code: string;
  upstreamStatus?: number;
  upstreamCode?: string;

  constructor(
    message: string,
    opts: { code: string; upstreamStatus?: number; upstreamCode?: string },
  ) {
    super(502, message);
    this.code = opts.code;
    this.upstreamStatus = opts.upstreamStatus;
    this.upstreamCode = opts.upstreamCode;
    this.name = 'CreditProviderError';
  }
}
