import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

// Symmetric encryption for secrets the server must be able to READ back —
// webhook signing secrets. A hash is not enough there: signing each delivery
// (HMAC-SHA256) needs the raw secret. So the secret is stored AES-256-GCM
// encrypted, with the key kept outside the database in WEBHOOK_SECRET_KEY.
// A leaked database dump alone therefore can't forge webhook signatures.
//
// Wire format: "v1:<iv b64url>:<tag b64url>:<ciphertext b64url>".

const DEV_FALLBACK = 'dev-webhook-secret-key-not-for-production';

function key(): Buffer {
  const raw = env.WEBHOOK_SECRET_KEY || (env.NODE_ENV === 'production' ? '' : DEV_FALLBACK);
  if (!raw) {
    throw new AppError(503, 'Webhooks are not set up on this server yet. Ask your administrator to configure them.');
  }
  // Accept any length of key material; derive a fixed 32-byte key from it.
  return createHash('sha256').update(raw).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

export function openSecret(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised sealed secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
