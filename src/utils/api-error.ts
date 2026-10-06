import { AppError } from './errors.js';

// MCP connector spec v1.0 section 3: one error shape for REST and MCP, with
// these codes. Existing AppError subclasses keep working; this class adds the
// machine-readable fields a bot needs to decide what to do next.
export const API_ERROR_CODES = [
  'unauthorized',
  'insufficient_scope',
  'not_found',
  'validation_failed',
  'account_not_linked',
  'account_client_mismatch',
  'campaign_client_mismatch',
  'move_requires_confirm',
  'duplicate',
  'file_too_large',
  'unsupported_type',
  'source_unreachable',
  'upload_incomplete',
  'rate_limited',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** HTTP status for each code (REST). MCP returns the same code with isError. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  insufficient_scope: 403,
  not_found: 404,
  validation_failed: 400,
  account_not_linked: 422,
  account_client_mismatch: 422,
  campaign_client_mismatch: 422,
  move_requires_confirm: 409,
  duplicate: 409,
  file_too_large: 413,
  unsupported_type: 415,
  source_unreachable: 422,
  upload_incomplete: 409,
  rate_limited: 429,
  internal_error: 500,
};

export interface ApiErrorFields {
  /** What the caller should do next, in plain English. */
  hint?: string;
  /** Per-field problems for validation_failed. */
  fields?: Array<{ field: string; message: string }>;
  /** True when the same call may succeed later (rate limit, timeout). */
  retryable?: boolean;
  /** Extra machine-readable context (for example the campaigns to choose from). */
  details?: Record<string, unknown>;
}

export class ApiError extends AppError {
  readonly code: ApiErrorCode;
  readonly hint?: string;
  readonly fields?: Array<{ field: string; message: string }>;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, extra: ApiErrorFields = {}) {
    super(API_ERROR_STATUS[code], message);
    Object.setPrototypeOf(this, ApiError.prototype);
    this.code = code;
    this.hint = extra.hint;
    this.fields = extra.fields;
    this.retryable = extra.retryable ?? (code === 'rate_limited');
    this.details = extra.details;
  }
}

export const accountNotLinked = (platform: string, accountId: string) =>
  new ApiError('account_not_linked', `The ${platform} account ${accountId} is not linked to a client.`, {
    hint: 'Link it first with link_ad_account, or ask the owner which client it belongs to. Do not guess from names.',
  });

export const accountClientMismatch = (accountId: string) =>
  new ApiError('account_client_mismatch', `Account ${accountId} belongs to a different client than the one given.`, {
    hint: 'Leave clientId out and let the account decide the client, or send the right clientId. Nothing was saved.',
  });

export const campaignClientMismatch = () =>
  new ApiError('campaign_client_mismatch', 'That campaign is not linked to this client.', {
    hint: 'Use list_campaigns with this clientId to see the valid campaigns. Nothing was saved.',
  });

export const moveRequiresConfirm = (fromClient: string) =>
  new ApiError('move_requires_confirm', `This account is already linked to ${fromClient}. Moving it needs confirmation.`, {
    hint: 'Ask the owner, then repeat the call with confirmMove = true.',
  });
