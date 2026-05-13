import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as twilio from '../integrations/twilio/twilio-client.js';

const ORIGINAL_FETCH = global.fetch;

describe('Twilio client — configuration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is not configured when no Twilio env vars are set', () => {
    expect(twilio.isTwilioConfigured()).toBe(false);
  });

  it('is not configured when only SID + TOKEN are set (FROM missing)', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    expect(twilio.isTwilioConfigured()).toBe(false);
  });

  it('is configured when SID + TOKEN + FROM are all set', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
    expect(twilio.isTwilioConfigured()).toBe(true);
  });
});

describe('Twilio client — mock fallback', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
  });

  it('returns mock id and does not call fetch when unconfigured', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const res = await twilio.sendSms({ to: '+447776531268', body: 'test' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.id).toMatch(/^mock-\d+$/);
  });
});

describe('Twilio client — live API', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
  });

  it('POSTs to Accounts/{SID}/Messages.json with Basic auth + form body', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ sid: 'SM_real_message_sid' }),
      text: async () => '{"sid":"SM_real_message_sid"}',
    } as unknown as Response));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const res = await twilio.sendSms({ to: '+447776531268', body: 'hello sam' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    const expectedAuth = 'Basic ' + Buffer.from('AC123:test-token').toString('base64');
    expect(headers['Authorization']).toBe(expectedAuth);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    // Form body assertions — parse the URLSearchParams payload
    const body = String(init.body);
    expect(body).toContain('From=%2B15551234567');
    expect(body).toContain('To=%2B447776531268');
    expect(body).toContain('Body=hello+sam');

    expect(res.id).toBe('SM_real_message_sid');
  });

  it('throws on HTTP 400 (e.g. invalid To)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ code: 21211, message: 'Invalid To Phone Number' }),
      text: async () => '{"code":21211,"message":"Invalid To Phone Number"}',
    } as unknown as Response)) as unknown as typeof fetch;

    await expect(twilio.sendSms({ to: 'not-a-number', body: 'x' })).rejects.toThrow(/400/);
  });

  it('throws on HTTP 401 (bad creds)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ code: 20003, message: 'Authentication Error' }),
      text: async () => '{"code":20003,"message":"Authentication Error"}',
    } as unknown as Response)) as unknown as typeof fetch;

    await expect(twilio.sendSms({ to: '+447776531268', body: 'x' })).rejects.toThrow(/401/);
  });
});
