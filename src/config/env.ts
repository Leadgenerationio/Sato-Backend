import dotenv from 'dotenv';

dotenv.config();

const v = (key: string, fallback = ''): string => process.env[key] || fallback;

const NODE_ENV = v('NODE_ENV', 'development');
const isProd = NODE_ENV === 'production';

const DEV_JWT_SECRET = 'dev-secret-change-me-in-production';
const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-change-me';

const JWT_SECRET = v('JWT_SECRET', DEV_JWT_SECRET);
const JWT_REFRESH_SECRET = v('JWT_REFRESH_SECRET', DEV_JWT_REFRESH_SECRET);

if (isProd && (JWT_SECRET === DEV_JWT_SECRET || JWT_REFRESH_SECRET === DEV_JWT_REFRESH_SECRET)) {
  // Fail fast in production rather than silently signing tokens with a known
  // dev secret. Generate with: `openssl rand -base64 32` (one per secret).
  throw new Error(
    'JWT_SECRET and JWT_REFRESH_SECRET must be set to non-default values in production',
  );
}

export const env = {
  // Core
  PORT: parseInt(v('PORT', '3001'), 10),
  NODE_ENV,
  FRONTEND_URL: v('FRONTEND_URL', 'http://localhost:5173'),
  // Comma-separated allow-list of allowed CORS origins (production). When
  // unset in dev a fixed localhost allow-list is used; required in prod.
  CORS_ORIGINS: v('CORS_ORIGINS'),
  JWT_SECRET,
  JWT_REFRESH_SECRET,

  // Data stores
  DATABASE_URL: v('DATABASE_URL'),
  REDIS_URL: v('REDIS_URL'),

  // Xero — Custom Connection (server-to-server, client_credentials grant)
  XERO_CLIENT_ID: v('XERO_CLIENT_ID'),
  XERO_CLIENT_SECRET: v('XERO_CLIENT_SECRET'),
  XERO_WEBHOOK_KEY: v('XERO_WEBHOOK_KEY'),

  // LeadByte
  LEADBYTE_API_KEY: v('LEADBYTE_API_KEY'),
  LEADBYTE_BASE_URL: v('LEADBYTE_BASE_URL', 'https://clinical.leadbyte.co.uk/restapi/v1.3'),

  // Credit checks
  ENDOLE_APP_ID: v('ENDOLE_APP_ID'),
  ENDOLE_APP_KEY: v('ENDOLE_APP_KEY'),
  ENDOLE_BASE_URL: v('ENDOLE_BASE_URL', 'https://api.endole.co.uk'),
  ENDOLE_SANDBOX: v('ENDOLE_SANDBOX'),
  CREDITSAFE_API_KEY: v('CREDITSAFE_API_KEY'),
  CREDITSAFE_BASE_URL: v('CREDITSAFE_BASE_URL', 'https://connect.creditsafe.com'),

  // Cloudflare R2
  R2_ACCOUNT_ID: v('R2_ACCOUNT_ID'),
  R2_ACCESS_KEY_ID: v('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: v('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET: v('R2_BUCKET', 'stato-production'),
  R2_PUBLIC_URL: v('R2_PUBLIC_URL'),
  R2_ENDPOINT: v('R2_ENDPOINT'),

  // Resend
  RESEND_API_KEY: v('RESEND_API_KEY'),
  RESEND_FROM_EMAIL: v('RESEND_FROM_EMAIL', 'notifications@stato.local'),
  RESEND_FROM_NAME: v('RESEND_FROM_NAME', 'Stato Notifications'),

  // SignNow (replaces DocuSign).
  // Default base URL is the production endpoint — `api-eval.signnow.com` is the
  // sandbox and must be set explicitly via SIGNNOW_BASE_URL when wanted.
  SIGNNOW_CLIENT_ID: v('SIGNNOW_CLIENT_ID'),
  SIGNNOW_CLIENT_SECRET: v('SIGNNOW_CLIENT_SECRET'),
  SIGNNOW_USERNAME: v('SIGNNOW_USERNAME'),
  SIGNNOW_PASSWORD: v('SIGNNOW_PASSWORD'),
  SIGNNOW_BASE_URL: v('SIGNNOW_BASE_URL', 'https://api.signnow.com'),
  SIGNNOW_WEBHOOK_SECRET: v('SIGNNOW_WEBHOOK_SECRET'),

  // Catchr (ad-spend aggregation via MCP)
  CATCHR_MCP_URL: v('CATCHR_MCP_URL', 'https://api.catchr.io/mcp'),
  CATCHR_ACCESS_TOKEN: v('CATCHR_ACCESS_TOKEN'),
  CATCHR_SYNC_BACKFILL_DAYS: parseInt(v('CATCHR_SYNC_BACKFILL_DAYS', '30'), 10),

  // Slice 5 Day 6 — SOS help button target. Phone number that the SOS
  // WhatsApp deep-link opens. Plain digits with country code, no `+` or
  // spaces (wa.me format). Optional: when blank, the endpoint records
  // the request but the FE shows "not configured yet".
  SOS_WHATSAPP_NUMBER: v('SOS_WHATSAPP_NUMBER'),
};

export function isProduction(): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Map of env vars that gate "real" behaviour (vs. mock fallbacks). Used by
 * health checks and the deploy runbook to verify a production install before
 * cutting over traffic.
 */
export const REQUIRED_FOR_PRODUCTION = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'XERO_CLIENT_ID',
  'XERO_CLIENT_SECRET',
  'LEADBYTE_API_KEY',
  'SIGNNOW_CLIENT_ID',
  'SIGNNOW_CLIENT_SECRET',
  'SIGNNOW_USERNAME',
  'SIGNNOW_PASSWORD',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'CATCHR_ACCESS_TOKEN',
] as const;

export function missingProductionEnv(): string[] {
  return REQUIRED_FOR_PRODUCTION.filter((k) => !process.env[k]);
}
