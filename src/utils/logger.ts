import pino from 'pino';
import { env } from '../config/env.js';

// Redact sensitive fields from any log line. Pino walks each redaction
// path and replaces the value with `[Redacted]` (or removes it with
// `remove: true`). Without this, auth-failure logs that include `req.body`
// or `err` could leak passwords/tokens to log shippers (Datadog, Loki,
// Railway log drains, etc).
const REDACT_PATHS = [
  // Request-side: when controllers log `req` or `req.headers`.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signnow-signature"]',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.refreshToken',
  'req.body.accessToken',
  // Generic — any object that has these keys at depth 1-2 (auth handlers
  // sometimes log the user object after registration which contains
  // passwordHash; the User type itself never serialises it but be safe).
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
  // Integration token responses — Xero/SignNow auth replies are sometimes
  // logged when the parent error wraps them.
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
];

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: REDACT_PATHS,
    censor: '[Redacted]',
  },
  transport: env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
