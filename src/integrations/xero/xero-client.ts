import { logger } from '../../utils/logger.js';

/**
 * Xero Custom Connection client (client_credentials grant, server-to-server).
 *
 * Auth flow:
 *   1. POST https://identity.xero.com/connect/token
 *      Basic auth (client_id:client_secret) + `grant_type=client_credentials`
 *      Returns a 30-minute bearer token. No refresh token (just re-auth when expired).
 *   2. GET https://api.xero.com/connections (Bearer) → fetches the bound tenant.
 *      Custom Connections are tied to exactly one tenant at app-config time.
 *   3. Downstream Xero API calls: `Authorization: Bearer <token>` + `xero-tenant-id: <tenantId>`.
 *
 * Docs: https://developer.xero.com/documentation/guides/oauth2/custom-connections
 */

const IDENTITY_HOST = 'https://identity.xero.com';
const API_HOST = 'https://api.xero.com';

const SCOPES = 'accounting.transactions accounting.contacts';

interface XeroCache {
  accessToken: string;
  expiresAt: number;
  tenantId: string;
  tenantName: string;
}

let cache: XeroCache | null = null;

export const __testing = {
  resetCache() {
    cache = null;
  },
};

function clientId(): string {
  return process.env.XERO_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.XERO_CLIENT_SECRET || '';
}

export function isXeroConfigured(): boolean {
  return !!(clientId() && clientSecret());
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface ConnectionInfo {
  id: string;
  tenantId: string;
  tenantType?: string;
  tenantName?: string;
}

async function exchangeCredentials(): Promise<{ accessToken: string; expiresAt: number }> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
  const res = await fetch(`${IDENTITY_HOST}/connect/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: SCOPES,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Xero token exchange failed');
    throw new Error(`Xero auth failed: ${res.status}`);
  }

  const data = (await res.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function fetchBoundTenant(accessToken: string): Promise<{ tenantId: string; tenantName: string }> {
  const res = await fetch(`${API_HOST}/connections`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Xero /connections failed');
    throw new Error(`Xero /connections failed: ${res.status}`);
  }
  const connections = (await res.json()) as ConnectionInfo[];
  const first = connections[0];
  if (!first) {
    throw new Error('No Xero tenant bound to this Custom Connection app. Configure in developer.xero.com.');
  }
  return {
    tenantId: first.tenantId,
    tenantName: first.tenantName ?? 'Unknown',
  };
}

/**
 * Get a valid access token + tenant ID. Authenticates on first call and
 * re-authenticates when the cached token is within 60s of expiry.
 */
export async function getValidToken(): Promise<{ accessToken: string; tenantId: string }> {
  if (!isXeroConfigured()) {
    throw new Error('Xero credentials not configured');
  }

  if (cache && cache.expiresAt > Date.now() + 60_000) {
    return { accessToken: cache.accessToken, tenantId: cache.tenantId };
  }

  const { accessToken, expiresAt } = await exchangeCredentials();
  // Re-use cached tenant name if we have it; otherwise fetch it.
  const tenant = cache?.tenantName
    ? { tenantId: cache.tenantId, tenantName: cache.tenantName }
    : await fetchBoundTenant(accessToken);

  cache = { accessToken, expiresAt, tenantId: tenant.tenantId, tenantName: tenant.tenantName };
  logger.info({ tenantName: tenant.tenantName, tenantId: tenant.tenantId }, 'Xero authenticated (Custom Connection)');
  return { accessToken, tenantId: cache.tenantId };
}

export interface XeroStatus {
  configured: boolean;
  connected: boolean;
  tenantId?: string;
  tenantName?: string;
  expiresAt?: Date;
}

/**
 * Non-throwing status — reports whether the app is configured and whether we
 * have a live token. Used by the Settings page.
 */
export async function getStatus(): Promise<XeroStatus> {
  if (!isXeroConfigured()) {
    return { configured: false, connected: false };
  }
  if (cache && cache.expiresAt > Date.now()) {
    return {
      configured: true,
      connected: true,
      tenantId: cache.tenantId,
      tenantName: cache.tenantName,
      expiresAt: new Date(cache.expiresAt),
    };
  }
  return { configured: true, connected: false };
}

/**
 * Clear the in-memory token + tenant cache. Next `getValidToken()` call
 * will re-authenticate from scratch. No Xero-side revoke call needed —
 * Custom Connection tokens can't be individually revoked; they expire on
 * their own. To actually "disconnect" an app, Sam removes it in the Xero
 * developer portal.
 */
export function disconnect(): void {
  cache = null;
  logger.info('Xero cache cleared');
}
