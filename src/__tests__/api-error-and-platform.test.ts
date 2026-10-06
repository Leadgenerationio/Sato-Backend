import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { API_ERROR_CODES, ApiError, apiErrorBody, mcpErrorResult, requestIdMiddleware, toApiError } from '../utils/api-error.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { errorHandler } from '../middleware/error.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { toApiPlatform, apiPlatformOut, toAccountPlatform, toCreativePlatform } from '../utils/api-platform.js';
import { API_SCOPES } from '../services/api-key.service.js';

// MCP spec v1.0 §3 (one error shape, 15 codes) and §2.1 (platform names).

describe('error codes and shape', () => {
  it('has exactly the 15 codes of spec §3', () => {
    expect(Object.keys(API_ERROR_CODES).sort()).toEqual([
      'account_client_mismatch', 'account_not_linked', 'campaign_client_mismatch', 'duplicate', 'file_too_large',
      'insufficient_scope', 'internal_error', 'move_requires_confirm', 'not_found', 'rate_limited', 'source_unreachable',
      'unauthorized', 'unsupported_type', 'upload_incomplete', 'validation_failed',
    ]);
  });

  it('builds the full body with hint, fields, retryable and requestId', () => {
    const err = new ApiError('account_not_linked', 'Not linked', { hint: 'Call link_ad_account', fields: ['accountId'] });
    expect(err.statusCode).toBe(422);
    expect(apiErrorBody(err, 'req-12345678')).toEqual({
      status: 'error', code: 'account_not_linked', message: 'Not linked', hint: 'Call link_ad_account',
      fields: ['accountId'], retryable: false, requestId: 'req-12345678',
    });
    expect(new ApiError('rate_limited', 'Slow down', { retryAfter: 12 }).retryable).toBe(true);
  });

  it('maps older errors and hides internals', () => {
    expect(toApiError(new NotFoundError('Creative')).code).toBe('not_found');
    expect(toApiError(new AppError(403, 'nope')).code).toBe('insufficient_scope');
    const legacy = Object.assign(new AppError(409, 'moved'), { code: 'move_requires_confirm' });
    expect(toApiError(legacy).code).toBe('move_requires_confirm');
    const boom = toApiError(new Error('password=hunter2 at db.ts:12'));
    expect(boom.code).toBe('internal_error');
    expect(boom.message).not.toContain('hunter2');
  });

  it('turns a Zod error into validation_failed with the fields at fault', () => {
    const r = z.object({ creativeId: z.string(), platform: z.string() }).safeParse({});
    const e = toApiError(r.error);
    expect(e.code).toBe('validation_failed');
    expect(e.fields).toEqual(['creativeId', 'platform']);
  });

  it('MCP results carry isError and the same body', () => {
    const out = mcpErrorResult(new ApiError('duplicate', 'Already linked', { hint: 'Unlink first' }), 'r-abcdefgh');
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({ code: 'duplicate', hint: 'Unlink first', requestId: 'r-abcdefgh' });
    expect(out.content[0]!.text).toBe('duplicate: Already linked Unlink first');
  });
});

describe('REST responses use the shape', () => {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.get('/api-error', () => { throw new ApiError('account_client_mismatch', 'Wrong client', { fields: ['clientId'] }); });
  app.get('/legacy', () => { throw Object.assign(new AppError(403, 'Public registration is closed'), { code: 'registration_closed' }); });
  app.get('/crash', () => { throw new Error('secret internals'); });
  app.post('/validated', validate(z.object({ body: z.object({ accountId: z.string() }) })), (_req, res) => { res.json({ ok: true }); });
  app.use(errorHandler);

  it('an ApiError answers with its code, status and X-Request-Id', async () => {
    const res = await request(app).get('/api-error').set('X-Request-Id', 'caller-req-0001');
    expect(res.status).toBe(422);
    expect(res.headers['x-request-id']).toBe('caller-req-0001');
    expect(res.body).toMatchObject({ status: 'error', code: 'account_client_mismatch', fields: ['clientId'], retryable: false, requestId: 'caller-req-0001' });
  });

  it('keeps a legacy code the portal reads', async () => {
    const res = await request(app).get('/legacy');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'registration_closed', message: 'Public registration is closed' });
    expect(res.body.requestId).toEqual(res.headers['x-request-id']);
  });

  it('an unexpected error is internal_error with no internals', async () => {
    const res = await request(app).get('/crash');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'internal_error', message: 'Internal server error', retryable: true });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('validation keeps `errors` for the portal and adds code and fields', async () => {
    const res = await request(app).post('/validated').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'validation_failed', fields: ['accountId'], errors: [{ path: 'body.accountId' }] });
  });

  it('ignores a caller request ID that is not safe to echo', async () => {
    const res = await request(app).get('/api-error').set('X-Request-Id', 'bad id <script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('platform names at the API boundary', () => {
  it('maps every stored spelling to one API name', () => {
    expect(toApiPlatform('facebook-ads')).toBe('meta');
    expect(toApiPlatform('meta')).toBe('meta');
    expect(toApiPlatform('Facebook')).toBe('meta');
    expect(toApiPlatform('google-ads')).toBe('google');
    expect(toApiPlatform('tik-tok')).toBe('tiktok');
    expect(toApiPlatform('TikTok')).toBe('tiktok');
    expect(toApiPlatform('taboola')).toBe('taboola');
    expect(toApiPlatform('bing-ads')).toBe('bing');
    expect(toApiPlatform('myspace')).toBeNull();
    expect(apiPlatformOut('Manual')).toBe('manual');
  });

  it('stores ad accounts in the Catchr spelling and creatives in the short one', () => {
    expect(toAccountPlatform('meta')).toBe('facebook-ads');
    expect(toAccountPlatform('tiktok')).toBe('tik-tok');
    expect(toCreativePlatform('facebook-ads')).toBe('meta');
    expect(toCreativePlatform('google-ads')).toBe('google');
    expect(toCreativePlatform('bing')).toBeNull();
  });
});

describe('scopes', () => {
  it('adds the five MCP scopes without renaming the original five', () => {
    expect(API_SCOPES.slice(0, 5)).toEqual(['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'landing_pages:write']);
    expect(API_SCOPES).toEqual(expect.arrayContaining(['campaigns:read', 'ad_accounts:read', 'uploads:write', 'ad_links:write', 'creatives:archive']));
    expect(API_SCOPES).toHaveLength(10);
  });
});
