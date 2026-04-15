import { XeroClient as XeroSDK } from 'xero-node';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import * as tokenManager from './token-manager.js';
import type { XeroTokenSet, XeroConnectionStatus } from './xero-types.js';

const SCOPES = 'openid profile email accounting.transactions accounting.contacts accounting.settings offline_access';

function isConfigured(): boolean {
  return !!(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET && env.XERO_REDIRECT_URI);
}

function createSdk(): XeroSDK {
  return new XeroSDK({
    clientId: env.XERO_CLIENT_ID!,
    clientSecret: env.XERO_CLIENT_SECRET!,
    redirectUris: [env.XERO_REDIRECT_URI!],
    scopes: SCOPES.split(' '),
  });
}

/**
 * Generate the Xero OAuth authorization URL.
 */
export async function getAuthUrl(): Promise<string> {
  if (!isConfigured()) {
    throw new Error('Xero credentials not configured');
  }

  const sdk = createSdk();
  const url = await sdk.buildConsentUrl();
  return url;
}

/**
 * Exchange authorization code for tokens after OAuth callback.
 */
export async function exchangeCode(businessId: string, code: string): Promise<XeroTokenSet> {
  if (!isConfigured()) {
    throw new Error('Xero credentials not configured');
  }

  const sdk = createSdk();
  const tokenSet = await sdk.apiCallback(code);

  const tenants = await sdk.updateTenants(false);
  const tenantId = tenants[0]?.tenantId;

  if (!tenantId) {
    throw new Error('No Xero tenant found. Ensure the app is connected to an organisation.');
  }

  const tokens: XeroTokenSet = {
    accessToken: tokenSet.access_token!,
    refreshToken: tokenSet.refresh_token!,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId,
  };

  await tokenManager.saveTokens(businessId, tokens);
  logger.info({ businessId, tenantId }, 'Xero connected successfully');

  return tokens;
}

/**
 * Get a valid access token — auto-refreshes if expired.
 */
export async function getValidToken(businessId: string): Promise<{ accessToken: string; tenantId: string }> {
  const tokens = await tokenManager.getTokens(businessId);

  if (!tokens) {
    throw new Error('Xero not connected. Please connect via Settings.');
  }

  // Token still valid
  if (!tokenManager.isTokenExpired(tokens)) {
    return { accessToken: tokens.accessToken, tenantId: tokens.tenantId };
  }

  // Auto-refresh
  logger.info({ businessId }, 'Xero token expired, refreshing...');

  if (!isConfigured()) {
    throw new Error('Xero credentials not configured — cannot refresh');
  }

  const sdk = createSdk();
  sdk.setTokenSet({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
  });

  const newTokenSet = await sdk.refreshToken();

  const refreshed: XeroTokenSet = {
    accessToken: newTokenSet.access_token!,
    refreshToken: newTokenSet.refresh_token!,
    expiresAt: new Date(Date.now() + (newTokenSet.expires_in ?? 1800) * 1000),
    tenantId: tokens.tenantId,
  };

  await tokenManager.saveTokens(businessId, refreshed);
  logger.info({ businessId }, 'Xero token refreshed successfully');

  return { accessToken: refreshed.accessToken, tenantId: refreshed.tenantId };
}

/**
 * Check connection status for a business.
 */
export async function getStatus(businessId: string): Promise<XeroConnectionStatus> {
  const tokens = await tokenManager.getTokens(businessId);

  if (!tokens) {
    return { connected: false };
  }

  return {
    connected: true,
    tenantId: tokens.tenantId,
    expiresAt: tokens.expiresAt,
  };
}

/**
 * Disconnect Xero — revoke tokens and delete from DB.
 */
export async function disconnect(businessId: string): Promise<void> {
  const tokens = await tokenManager.getTokens(businessId);

  if (tokens && isConfigured()) {
    try {
      const sdk = createSdk();
      sdk.setTokenSet({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: 'Bearer',
      });
      await sdk.revokeToken();
      logger.info({ businessId }, 'Xero token revoked');
    } catch (err) {
      logger.warn({ businessId, err }, 'Failed to revoke Xero token (deleting locally anyway)');
    }
  }

  await tokenManager.deleteTokens(businessId);
  logger.info({ businessId }, 'Xero disconnected');
}

/**
 * Check if Xero credentials are configured.
 */
export function isXeroConfigured(): boolean {
  return isConfigured();
}
