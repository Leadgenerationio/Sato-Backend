import { eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { xeroTokens } from '../../db/schema/index.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import type { XeroTokenSet } from './xero-types.js';

const EXPIRY_BUFFER_MS = 2 * 60 * 1000; // Refresh 2 min before expiry

export async function getTokens(businessId: string): Promise<XeroTokenSet | null> {
  if (!db) return null;

  const [row] = await db
    .select()
    .from(xeroTokens)
    .where(eq(xeroTokens.businessId, businessId))
    .limit(1);

  if (!row) return null;

  return {
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    expiresAt: row.expiresAt,
    tenantId: row.tenantId,
  };
}

export async function saveTokens(businessId: string, tokens: XeroTokenSet): Promise<void> {
  if (!db) return;

  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = encrypt(tokens.refreshToken);

  const existing = await db
    .select({ id: xeroTokens.id })
    .from(xeroTokens)
    .where(eq(xeroTokens.businessId, businessId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(xeroTokens)
      .set({
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt: tokens.expiresAt,
        tenantId: tokens.tenantId,
        updatedAt: new Date(),
      })
      .where(eq(xeroTokens.businessId, businessId));
  } else {
    await db.insert(xeroTokens).values({
      businessId,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: tokens.expiresAt,
      tenantId: tokens.tenantId,
    });
  }

  logger.info({ businessId }, 'Xero tokens saved (encrypted)');
}

export async function deleteTokens(businessId: string): Promise<void> {
  if (!db) return;

  await db.delete(xeroTokens).where(eq(xeroTokens.businessId, businessId));
  logger.info({ businessId }, 'Xero tokens deleted');
}

export function isTokenExpired(tokens: XeroTokenSet): boolean {
  return tokens.expiresAt.getTime() - Date.now() < EXPIRY_BUFFER_MS;
}
