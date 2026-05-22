import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import * as signnow from '../integrations/signnow/signnow-client.js';

const ORIGINAL_FETCH = global.fetch;

function mockOk(payload: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => new Uint8Array(payload as ArrayBuffer).buffer,
  } as unknown as Response;
}

function mockPdf(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/pdf' }),
    arrayBuffer: async () => bytes.buffer,
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response;
}

function mockErr(status: number, body: Record<string, unknown> = {}): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('SignNow client — configuration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.SIGNNOW_CLIENT_ID;
    delete process.env.SIGNNOW_CLIENT_SECRET;
    delete process.env.SIGNNOW_USERNAME;
    delete process.env.SIGNNOW_PASSWORD;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports not configured when nothing is set', () => {
    expect(signnow.isSignNowConfigured()).toBe(false);
  });

  it('reports not configured when only CLIENT_ID is set', () => {
    process.env.SIGNNOW_CLIENT_ID = 'abc';
    expect(signnow.isSignNowConfigured()).toBe(false);
  });

  it('reports configured only when all four OAuth fields are set', () => {
    process.env.SIGNNOW_CLIENT_ID = 'abc';
    process.env.SIGNNOW_CLIENT_SECRET = 'def';
    process.env.SIGNNOW_USERNAME = 'svc@stato.app';
    process.env.SIGNNOW_PASSWORD = 'pw';
    expect(signnow.isSignNowConfigured()).toBe(true);
  });
});

describe('SignNow client — unconfigured mock fallback', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.SIGNNOW_CLIENT_ID;
    delete process.env.SIGNNOW_CLIENT_SECRET;
    delete process.env.SIGNNOW_USERNAME;
    delete process.env.SIGNNOW_PASSWORD;
    signnow.__testing.resetTokenCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
  });

  it('createEnvelope returns a mock id without network call when unconfigured', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await signnow.createEnvelope({
      signerEmail: 'jane@example.com',
      signerName: 'Jane Doe',
      documentName: 'Agreement.pdf',
      documentBase64: Buffer.from('%PDF').toString('base64'),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.envelopeId).toMatch(/^mock-/);
    expect(result.status).toBe('sent');
  });

  it('getEnvelopeStatus returns "sent" for mock envelope ids without network call', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const status = await signnow.getEnvelopeStatus('mock-123');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(status).toBe('sent');
  });

  it('downloadSignedPdf returns a non-empty PDF buffer for mock ids without network call', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const buf = await signnow.downloadSignedPdf('mock-123');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.toString('utf8', 0, 4)).toBe('%PDF');
  });
});

describe('SignNow client — OAuth token exchange', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.SIGNNOW_CLIENT_ID = 'test-client-id';
    process.env.SIGNNOW_CLIENT_SECRET = 'test-client-secret';
    process.env.SIGNNOW_USERNAME = 'svc@stato.app';
    process.env.SIGNNOW_PASSWORD = 'test-password';
    signnow.__testing.resetTokenCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    signnow.__testing.resetTokenCache();
  });

  it('POSTs /oauth2/token with Basic auth and password grant body', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return mockOk({ access_token: 'tok-1', expires_in: 3600, token_type: 'bearer' });
      }
      return mockOk({ id: 'doc-1' });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await signnow.createEnvelope({
      signerEmail: 'a@b.com',
      signerName: 'A B',
      documentName: 'Agreement.pdf',
      documentBase64: Buffer.from('%PDF').toString('base64'),
    });

    const tokenCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/oauth2/token'));
    expect(tokenCall).toBeDefined();
    const [url, init] = tokenCall as unknown as [string, RequestInit];
    expect(url).toContain('/oauth2/token');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    const expected = 'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64');
    expect(headers['Authorization']).toBe(expected);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = String(init.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain('username=svc%40stato.app');
    expect(body).toContain('password=test-password');
  });

  it('caches the token and does not re-exchange while still valid', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return mockOk({ access_token: 'tok-cached', expires_in: 3600, token_type: 'bearer' });
      }
      return mockOk({ id: 'doc-1' });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    // Two separate API calls, only one token exchange
    await signnow.getEnvelopeStatus('doc-1');
    await signnow.getEnvelopeStatus('doc-1');

    const tokenCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/oauth2/token'));
    expect(tokenCalls.length).toBe(1);
  });
});

describe('SignNow client — createEnvelope (live)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.SIGNNOW_CLIENT_ID = 'id';
    process.env.SIGNNOW_CLIENT_SECRET = 'secret';
    process.env.SIGNNOW_USERNAME = 'svc@stato.app';
    process.env.SIGNNOW_PASSWORD = 'pw';
    signnow.__testing.resetTokenCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    signnow.__testing.resetTokenCache();
  });

  it('uploads the document then dispatches an invite, returning the document id as envelopeId', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/oauth2/token')) {
        return mockOk({ access_token: 'tok-1', expires_in: 3600, token_type: 'bearer' });
      }
      if (String(url).endsWith('/document') && init.method === 'POST') {
        return mockOk({ id: 'doc-xyz' });
      }
      if (String(url).includes('/document/doc-xyz/invite')) {
        return mockOk({ status: 'success' });
      }
      return mockErr(404);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await signnow.createEnvelope({
      signerEmail: 'jane@example.com',
      signerName: 'Jane Doe',
      documentName: 'Agreement.pdf',
      documentBase64: Buffer.from('%PDF').toString('base64'),
    });

    expect(result.envelopeId).toBe('doc-xyz');
    expect(result.status).toBe('sent');

    const uploadCall = calls.find((c) => c.url.endsWith('/document'));
    expect(uploadCall?.init.method).toBe('POST');
    const uploadHeaders = uploadCall?.init.headers as Record<string, string>;
    expect(uploadHeaders['Authorization']).toBe('Bearer tok-1');

    const inviteCall = calls.find((c) => c.url.includes('/document/doc-xyz/invite'));
    expect(inviteCall).toBeDefined();
    const inviteBody = JSON.parse(String(inviteCall?.init.body));
    // Free-form invite: `to` is a plain email string, not a role array.
    expect(inviteBody.to).toBe('jane@example.com');
    // `from` is the service account email.
    expect(inviteBody.from).toBeTruthy();
  });

  // ─── #47-50 PDF editor — pre-placed fields ────────────────────────────
  it('places fields via PUT /document/:id and switches invite to role-based', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('/oauth2/token')) {
        return mockOk({ access_token: 'tok', expires_in: 3600 });
      }
      if (u.endsWith('/document') && init.method === 'POST') {
        return mockOk({ id: 'doc-fields' });
      }
      // PUT /document/doc-fields — the addFields call
      if (u.endsWith('/document/doc-fields') && init.method === 'PUT') {
        return mockOk({ id: 'doc-fields' });
      }
      if (u.includes('/document/doc-fields/invite')) {
        return mockOk({ status: 'success' });
      }
      return mockErr(404);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await signnow.createEnvelope({
      signerEmail: 'jane@example.com',
      signerName: 'Jane Doe',
      documentName: 'Agreement.pdf',
      documentBase64: Buffer.from('%PDF').toString('base64'),
      fields: [
        { page: 1, type: 'signature',   xPct: 0.5,  yPct: 0.9,  widthPct: 0.25, heightPct: 0.05 },
        { page: 1, type: 'date_signed', xPct: 0.5,  yPct: 0.95, widthPct: 0.14, heightPct: 0.04 },
        { page: 2, type: 'text',        xPct: 0.1,  yPct: 0.2,  widthPct: 0.20, heightPct: 0.03, prefillValue: 'Manchester' },
      ],
    });

    // PUT /document/:id with the fields payload happened BEFORE the invite.
    const putCall = calls.find((c) => c.url.endsWith('/document/doc-fields') && c.init.method === 'PUT');
    expect(putCall).toBeDefined();
    const putBody = JSON.parse(String(putCall?.init.body));
    expect(putBody.fields).toHaveLength(3);
    // Pixel-coord translation: 0.5 xPct on a 595pt-wide A4 page → 298px.
    expect(putBody.fields[0].x).toBe(298);
    // page_number is 0-indexed on SignNow's side.
    expect(putBody.fields[0].page_number).toBe(0);
    expect(putBody.fields[2].page_number).toBe(1);
    // The text field with a prefillValue passes through.
    expect(putBody.fields[2].prefilled_text).toBe('Manchester');
    // All fields are assigned to "Signer 1" role.
    putBody.fields.forEach((f: { role: string }) => expect(f.role).toBe('Signer 1'));

    // Role-based invite: `to` is an array with role + order, not a bare email.
    const inviteCall = calls.find((c) => c.url.includes('/document/doc-fields/invite'));
    const inviteBody = JSON.parse(String(inviteCall?.init.body));
    expect(Array.isArray(inviteBody.to)).toBe(true);
    expect(inviteBody.to[0]).toEqual({
      email: 'jane@example.com',
      role: 'Signer 1',
      order: 1,
    });
  });

  it('skips addFields call when fields array is empty (back to free-form)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('/oauth2/token')) return mockOk({ access_token: 'tok', expires_in: 3600 });
      if (u.endsWith('/document') && init.method === 'POST') return mockOk({ id: 'doc-empty' });
      if (u.includes('/document/doc-empty/invite')) return mockOk({ status: 'success' });
      return mockErr(404);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await signnow.createEnvelope({
      signerEmail: 'jane@example.com',
      signerName: 'Jane Doe',
      documentName: 'Agreement.pdf',
      documentBase64: Buffer.from('%PDF').toString('base64'),
      fields: [],
    });

    // No PUT call should have happened.
    expect(calls.some((c) => c.url.endsWith('/document/doc-empty') && c.init.method === 'PUT')).toBe(false);
    // Invite stayed as free-form (`to` is a string).
    const inviteBody = JSON.parse(String(calls.find((c) => c.url.includes('/invite'))?.init.body));
    expect(inviteBody.to).toBe('jane@example.com');
  });
});

describe('SignNow client — getEnvelopeStatus (live)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.SIGNNOW_CLIENT_ID = 'id';
    process.env.SIGNNOW_CLIENT_SECRET = 'secret';
    process.env.SIGNNOW_USERNAME = 'svc@stato.app';
    process.env.SIGNNOW_PASSWORD = 'pw';
    signnow.__testing.resetTokenCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    signnow.__testing.resetTokenCache();
  });

  it('returns "completed" when all field_invites are fulfilled', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) return mockOk({ access_token: 't', expires_in: 3600 });
      return mockOk({ field_invites: [{ status: 'fulfilled' }, { status: 'fulfilled' }] });
    }) as unknown as typeof fetch;

    const status = await signnow.getEnvelopeStatus('doc-xyz');
    expect(status).toBe('completed');
  });

  it('returns "sent" when any invite is still pending', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) return mockOk({ access_token: 't', expires_in: 3600 });
      return mockOk({ field_invites: [{ status: 'fulfilled' }, { status: 'pending' }] });
    }) as unknown as typeof fetch;

    const status = await signnow.getEnvelopeStatus('doc-xyz');
    expect(status).toBe('sent');
  });

  it('returns "created" when no invites have been sent yet', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) return mockOk({ access_token: 't', expires_in: 3600 });
      return mockOk({ field_invites: [] });
    }) as unknown as typeof fetch;

    const status = await signnow.getEnvelopeStatus('doc-xyz');
    expect(status).toBe('created');
  });

  // Free-form invites report via `requests[]`, not `field_invites[]`. Each
  // request gets a `signature_id` when the signer signs. See SignNow API docs.
  it('returns "completed" for a free-form invite when every request has a signature_id', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) return mockOk({ access_token: 't', expires_in: 3600 });
      return mockOk({
        field_invites: [],
        requests: [{ id: 'req-1', signature_id: 'sig-abc', canceled: null }],
      });
    }) as unknown as typeof fetch;

    const status = await signnow.getEnvelopeStatus('doc-xyz');
    expect(status).toBe('completed');
  });

  it('returns "sent" for a free-form invite when request has no signature yet', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) return mockOk({ access_token: 't', expires_in: 3600 });
      return mockOk({
        field_invites: [],
        requests: [{ id: 'req-1', signature_id: null, canceled: null }],
      });
    }) as unknown as typeof fetch;

    const status = await signnow.getEnvelopeStatus('doc-xyz');
    expect(status).toBe('sent');
  });

  it('returns "declined" for a free-form invite when a request is canceled', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) return mockOk({ access_token: 't', expires_in: 3600 });
      return mockOk({
        field_invites: [],
        requests: [{ id: 'req-1', signature_id: null, canceled: '2026-04-22T10:00:00Z' }],
      });
    }) as unknown as typeof fetch;

    const status = await signnow.getEnvelopeStatus('doc-xyz');
    expect(status).toBe('declined');
  });
});

describe('SignNow client — downloadSignedPdf (live)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.SIGNNOW_CLIENT_ID = 'id';
    process.env.SIGNNOW_CLIENT_SECRET = 'secret';
    process.env.SIGNNOW_USERNAME = 'svc@stato.app';
    process.env.SIGNNOW_PASSWORD = 'pw';
    signnow.__testing.resetTokenCache();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = ORIGINAL_FETCH;
    signnow.__testing.resetTokenCache();
  });

  it('GETs /document/{id}/download?type=collapsed and returns the PDF buffer', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.7 signed');
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/oauth2/token')) return mockOk({ access_token: 't', expires_in: 3600 });
      return mockPdf(pdfBytes);
    }) as unknown as typeof fetch;

    const buf = await signnow.downloadSignedPdf('doc-xyz');
    expect(buf.toString('utf8', 0, 4)).toBe('%PDF');
    const downloadCall = calls.find((u) => u.includes('/document/doc-xyz/download'));
    expect(downloadCall).toContain('type=collapsed');
  });
});

describe('SignNow client — webhook signature verification', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.SIGNNOW_WEBHOOK_SECRET = 'my-secret-key';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts a correctly-signed HMAC-SHA256 payload', () => {
    const body = '{"event_type":"document.complete","meta":{"id":"doc-xyz"}}';
    const sig = crypto.createHmac('sha256', 'my-secret-key').update(body).digest('hex');
    expect(signnow.verifyWebhookSignature(body, sig)).toBe(true);
  });

  it('rejects a tampered body even with a signature for the original body', () => {
    const originalBody = '{"event_type":"document.complete","meta":{"id":"doc-xyz"}}';
    const tamperedBody = '{"event_type":"document.complete","meta":{"id":"doc-ATTACKER"}}';
    const sig = crypto.createHmac('sha256', 'my-secret-key').update(originalBody).digest('hex');
    expect(signnow.verifyWebhookSignature(tamperedBody, sig)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const body = '{"event_type":"document.complete","meta":{"id":"doc-xyz"}}';
    const sig = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    expect(signnow.verifyWebhookSignature(body, sig)).toBe(false);
  });

  it('returns false when webhook secret is not configured', () => {
    delete process.env.SIGNNOW_WEBHOOK_SECRET;
    expect(signnow.verifyWebhookSignature('{}', 'whatever')).toBe(false);
  });

  it('warns exactly once when called repeatedly without a secret (no log spam)', () => {
    delete process.env.SIGNNOW_WEBHOOK_SECRET;
    // Reset the module-level guard so we test from a clean slate, otherwise
    // earlier suites in this file might have tripped it already.
    signnow.__testing.resetWebhookSecretWarned();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Two back-to-back calls without a secret — every real webhook delivery
      // would call this, so we must not spam Railway logs.
      expect(signnow.verifyWebhookSignature('{"a":1}', 'sig-1')).toBe(false);
      expect(signnow.verifyWebhookSignature('{"a":2}', 'sig-2')).toBe(false);

      const notConfiguredLogs = warnSpy.mock.calls
        .map((c) => c.join(' '))
        .filter((line) => line.includes('[signnow][webhook] secret not configured'));
      expect(notConfiguredLogs).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      signnow.__testing.resetWebhookSecretWarned();
    }
  });
});
