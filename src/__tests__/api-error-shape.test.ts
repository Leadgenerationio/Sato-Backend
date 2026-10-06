import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/error.middleware.js';
import { requestId } from '../middleware/request-id.middleware.js';
import { ApiError, API_ERROR_CODES, API_ERROR_STATUS, accountNotLinked, moveRequiresConfirm } from '../utils/api-error.js';
import { AppError, NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors.js';

// MCP spec v1.0 section 3: one error shape for REST and MCP.
function app() {
  const a = express();
  a.use(requestId);
  a.get('/api-error', () => { throw accountNotLinked('meta', '123'); });
  a.get('/validation', () => { throw new ApiError('validation_failed', 'Bad input', { fields: [{ field: 'campaignId', message: 'Required when the account feeds several campaigns' }], details: { campaigns: ['a', 'b'] } }); });
  a.get('/rate', () => { throw new ApiError('rate_limited', 'Slow down'); });
  a.get('/move', () => { throw moveRequiresConfirm('Acme'); });
  a.get('/plain-404', () => { throw new NotFoundError('Creative'); });
  a.get('/plain-401', () => { throw new UnauthorizedError(); });
  a.get('/plain-400', () => { throw new ValidationError('nope'); });
  a.get('/plain-403', () => { throw new AppError(403, 'Forbidden thing'); });
  a.get('/coded', () => { const e = new AppError(409, 'taken') as AppError & { code: string }; e.code = 'custom_code'; throw e; });
  a.get('/boom', () => { throw new Error('secret internals'); });
  a.use(errorHandler);
  return a;
}

describe('error shape', () => {
  it('lists the 15 codes from the spec, each with an HTTP status', () => {
    expect([...API_ERROR_CODES].sort()).toEqual(['account_client_mismatch', 'account_not_linked', 'campaign_client_mismatch', 'duplicate', 'file_too_large', 'insufficient_scope', 'internal_error', 'move_requires_confirm', 'not_found', 'rate_limited', 'source_unreachable', 'unauthorized', 'unsupported_type', 'upload_incomplete', 'validation_failed']);
    for (const c of API_ERROR_CODES) expect(API_ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
  });
  it('an ApiError carries code, message, hint, retryable and requestId', async () => {
    const res = await request(app()).get('/api-error');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'error', code: 'account_not_linked', retryable: false });
    expect(res.body.message).toContain('123');
    expect(res.body.hint).toContain('link_ad_account');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
  it('validation errors list fields and details', async () => {
    const res = await request(app()).get('/validation');
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual([{ field: 'campaignId', message: 'Required when the account feeds several campaigns' }]);
    expect(res.body.details).toEqual({ campaigns: ['a', 'b'] });
  });
  it('rate_limited is retryable; others are not; a move needs confirmation', async () => {
    expect((await request(app()).get('/rate')).body).toMatchObject({ code: 'rate_limited', retryable: true });
    const move = await request(app()).get('/move');
    expect(move.status).toBe(409);
    expect(move.body).toMatchObject({ code: 'move_requires_confirm', retryable: false });
  });
  it('plain AppErrors keep their message and status and gain a code and requestId', async () => {
    const r404 = await request(app()).get('/plain-404');
    expect(r404.status).toBe(404);
    expect(r404.body).toMatchObject({ status: 'error', message: 'Creative not found', code: 'not_found' });
    expect(r404.body.requestId).toBeDefined();
    expect((await request(app()).get('/plain-401')).body.code).toBe('unauthorized');
    expect((await request(app()).get('/plain-400')).body.code).toBe('validation_failed');
    const r403 = await request(app()).get('/plain-403');
    expect(r403.status).toBe(403);
    expect(r403.body.code).toBeUndefined();
  });
  it('a code an error already has is never replaced', async () => {
    expect((await request(app()).get('/coded')).body.code).toBe('custom_code');
  });
  it('an unexpected error is masked, coded internal_error and carries a requestId', async () => {
    const res = await request(app()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ status: 'error', code: 'internal_error', message: 'Internal server error', retryable: false });
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
    expect(res.body.requestId).toBeDefined();
  });
  it('keeps a short caller-supplied request id and replaces an unsafe one', async () => {
    expect((await request(app()).get('/boom').set('X-Request-Id', 'bot-42')).headers['x-request-id']).toBe('bot-42');
    const unsafe = await request(app()).get('/boom').set('X-Request-Id', 'bad id with spaces');
    expect(unsafe.headers['x-request-id']).not.toBe('bad id with spaces');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
