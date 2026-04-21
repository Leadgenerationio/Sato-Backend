import dotenv from 'dotenv';

dotenv.config();

const v = (key: string, fallback = ''): string => process.env[key] || fallback;

export const env = {
  // Core
  PORT: parseInt(v('PORT', '3001'), 10),
  NODE_ENV: v('NODE_ENV', 'development'),
  FRONTEND_URL: v('FRONTEND_URL', 'http://localhost:5173'),
  JWT_SECRET: v('JWT_SECRET', 'dev-secret-change-me-in-production'),
  JWT_REFRESH_SECRET: v('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),

  // Data stores
  DATABASE_URL: v('DATABASE_URL'),
  REDIS_URL: v('REDIS_URL'),

  // Xero
  XERO_CLIENT_ID: v('XERO_CLIENT_ID'),
  XERO_CLIENT_SECRET: v('XERO_CLIENT_SECRET'),
  XERO_REDIRECT_URI: v('XERO_REDIRECT_URI'),
  XERO_WEBHOOK_KEY: v('XERO_WEBHOOK_KEY'),

  // LeadByte
  LEADBYTE_API_KEY: v('LEADBYTE_API_KEY'),
  LEADBYTE_BASE_URL: v('LEADBYTE_BASE_URL', 'https://clinical.leadbyte.co.uk/restapi/v1.3'),

  // Credit checks
  ENDOLE_API_KEY: v('ENDOLE_API_KEY'),
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

  // DocuSign
  DOCUSIGN_INTEGRATION_KEY: v('DOCUSIGN_INTEGRATION_KEY'),
  DOCUSIGN_SECRET: v('DOCUSIGN_SECRET'),
  DOCUSIGN_USER_ID: v('DOCUSIGN_USER_ID'),
  DOCUSIGN_ACCOUNT_ID: v('DOCUSIGN_ACCOUNT_ID'),
  DOCUSIGN_REDIRECT_URI: v('DOCUSIGN_REDIRECT_URI'),
  DOCUSIGN_BASE_PATH: v('DOCUSIGN_BASE_PATH', 'https://demo.docusign.net/restapi'),
  DOCUSIGN_OAUTH_BASE: v('DOCUSIGN_OAUTH_BASE', 'account-d.docusign.com'),
  DOCUSIGN_WEBHOOK_SECRET: v('DOCUSIGN_WEBHOOK_SECRET'),

  // Catchr (ad-spend aggregation via MCP)
  CATCHR_MCP_URL: v('CATCHR_MCP_URL', 'https://api.catchr.io/mcp'),
  CATCHR_ACCESS_TOKEN: v('CATCHR_ACCESS_TOKEN'),
  CATCHR_SYNC_BACKFILL_DAYS: parseInt(v('CATCHR_SYNC_BACKFILL_DAYS', '30'), 10),
};

export function isProduction(): boolean {
  return env.NODE_ENV === 'production';
}
