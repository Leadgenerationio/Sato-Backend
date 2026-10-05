import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStatoMcpServer } from '../src/server.js';
import { StatoApi, idempotencyKeyFor } from '../src/stato-client.js';
import { startFakeStato, type Seen } from './fake-stato.js';

// Each MCP tool must call the Stato REST contract exactly (plan phase 2/4):
// right method + path, X-API-Key, JSON body, Idempotency-Key on uploads.

const CLIENT = '00000000-0000-0000-0000-000000000001';
const CREATIVE = '5b3f0f0e-9c1d-4a8e-8f0a-1c2d3e4f5a6b';
let fake: Awaited<ReturnType<typeof startFakeStato>>;
let reply: (r: Seen) => { status?: number; body: unknown };
let client: Client;

async function connect() {
  const server = createStatoMcpServer(new StatoApi({ baseUrl: `${fake.url}/`, apiKey: 'sk_live_test' }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0].text);

beforeEach(async () => {
  reply = () => ({ body: { status: 'success', data: { ok: true } } });
  fake = await startFakeStato((r) => reply(r));
  await connect();
});
afterEach(async () => { await client.close(); await fake.close(); });

describe('tool list', () => {
  it('exposes the five planned tools with input schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['attach_landing_page', 'find_client_by_ad_account', 'link_ad_account', 'list_creatives', 'upload_creative']);
    const upload = tools.find((t) => t.name === 'upload_creative')!;
    expect(upload.inputSchema.required).toEqual(expect.arrayContaining(['platform', 'sourceUrl']));
    expect(tools.find((t) => t.name === 'find_client_by_ad_account')!.annotations?.readOnlyHint).toBe(true);
  });
});

describe('REST calls', () => {
  it('find_client_by_ad_account → GET /clients/lookup with the key', async () => {
    reply = () => ({ body: { status: 'success', data: { client: { id: CLIENT, companyName: 'Copious' } } } });
    const r = await client.callTool({ name: 'find_client_by_ad_account', arguments: { platform: 'meta', accountId: '428353095282383' } });
    expect(r.isError).toBeFalsy();
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/api/v1/clients/lookup', query: { platform: 'meta', accountId: '428353095282383' } });
    expect(fake.seen[0].headers['x-api-key']).toBe('sk_live_test');
    expect(text(r)).toContain('is linked in Stato');
    expect(text(r)).toContain('Copious');
  });

  it('find_client_by_ad_account treats the API\'s 404 as "not linked", not an error', async () => {
    reply = () => ({ status: 404, body: { status: 'error', message: 'Linked client for this ad account not found' } });
    const r = await client.callTool({ name: 'find_client_by_ad_account', arguments: { platform: 'taboola', accountId: 'willwriting-sc' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('not linked to any client yet');
  });

  it('a `data: null` answer is passed on as null, not as the envelope', async () => {
    reply = () => ({ body: { status: 'success', data: null } });
    const r = await client.callTool({ name: 'find_client_by_ad_account', arguments: { platform: 'taboola', accountId: 'x' } });
    expect(text(r)).toContain('not linked to any client yet');
  });

  it('other lookup failures are still errors', async () => {
    reply = () => ({ status: 401, body: {} });
    const r = await client.callTool({ name: 'find_client_by_ad_account', arguments: { platform: 'meta', accountId: '1' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/API key is missing, wrong or revoked/);
  });

  it('link_ad_account → POST /clients/{id}/ad-accounts', async () => {
    await client.callTool({ name: 'link_ad_account', arguments: { clientId: CLIENT, platform: 'taboola', accountId: 'willwriting-sc', currency: 'PLN' } });
    expect(fake.seen[0]).toMatchObject({
      method: 'POST', path: `/api/v1/clients/${CLIENT}/ad-accounts`,
      body: { platform: 'taboola', accountId: 'willwriting-sc', currency: 'PLN' },
    });
    expect(fake.seen[0].headers['content-type']).toBe('application/json');
  });

  it('upload_creative → POST /creatives with an Idempotency-Key that is stable across retries', async () => {
    const args = { platform: 'meta', accountId: '428353095282383', sourceUrl: 'https://cdn.example.com/ad.jpg', platformCreativeId: '120210000000001', headline: 'Hear better' };
    await client.callTool({ name: 'upload_creative', arguments: args });
    await client.callTool({ name: 'upload_creative', arguments: args });
    expect(fake.seen).toHaveLength(2);
    // The API takes platformAccountId (not accountId) and requires mediaType.
    const { accountId, ...rest } = args;
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/creatives', body: { ...rest, platformAccountId: accountId, mediaType: 'image' } });
    expect((fake.seen[0].body as Record<string, unknown>).accountId).toBeUndefined();
    const k1 = fake.seen[0].headers['idempotency-key'];
    expect(k1).toBe(idempotencyKeyFor(args));
    expect(fake.seen[1].headers['idempotency-key']).toBe(k1);
    expect((fake.seen[0].body as Record<string, unknown>).idempotencyKey).toBeUndefined();
  });

  it('upload_creative sends mediaType: guessed video from the URL, an explicit value wins, images by default', async () => {
    await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://cdn.example.com/ad.mp4?token=1' } });
    await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://cdn.example.com/stream/12345', mediaType: 'video' } });
    await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://cdn.example.com/ad.png' } });
    expect(fake.seen.map((r) => (r.body as Record<string, unknown>).mediaType)).toEqual(['video', 'video', 'image']);
  });

  it('upload_creative maps platform aliases to the values the create endpoint accepts', async () => {
    for (const platform of ['facebook-ads', 'Facebook', 'google-ads', 'tik-tok', 'taboola']) {
      await client.callTool({ name: 'upload_creative', arguments: { platform, clientId: CLIENT, sourceUrl: 'https://cdn.example.com/a.jpg' } });
    }
    expect(fake.seen.map((r) => (r.body as Record<string, unknown>).platform)).toEqual(['meta', 'meta', 'google', 'tiktok', 'taboola']);
  });

  it('upload_creative without accountId sends no platformAccountId', async () => {
    await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://cdn.example.com/a.jpg' } });
    expect(Object.keys(fake.seen[0].body as object)).not.toContain('platformAccountId');
  });

  it('the same creative re-sent with a changed headline gets a new key (the API refuses a reused key with a different body)', async () => {
    const base = { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://cdn.example.com/a.jpg', platformCreativeId: '120210000000001' };
    await client.callTool({ name: 'upload_creative', arguments: { ...base, headline: 'First' } });
    await client.callTool({ name: 'upload_creative', arguments: { ...base, headline: 'Second' } });
    await client.callTool({ name: 'upload_creative', arguments: { ...base, headline: 'Second' } });
    const keys = fake.seen.map((r) => r.headers['idempotency-key']);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
  });

  it('upload_creative uses a caller-supplied Idempotency-Key and differs for a different creative', async () => {
    await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://cdn.example.com/a.mp4', idempotencyKey: 'caller-key-123' } });
    await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://cdn.example.com/b.mp4' } });
    expect(fake.seen[0].headers['idempotency-key']).toBe('caller-key-123');
    expect(fake.seen[1].headers['idempotency-key']).not.toBe(fake.seen[0].headers['idempotency-key']);
  });

  it('upload_creative refuses without clientId or accountId, and sends nothing', async () => {
    const r = await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', sourceUrl: 'https://cdn.example.com/a.jpg' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Give either clientId, or accountId/);
    expect(fake.seen).toHaveLength(0);
  });

  it('list_creatives → GET /creatives with filters', async () => {
    await client.callTool({ name: 'list_creatives', arguments: { clientId: CLIENT, platform: 'meta', q: 'hearing', page: 2 } });
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/api/v1/creatives', query: { clientId: CLIENT, platform: 'meta', q: 'hearing', page: '2' } });
  });

  it('attach_landing_page → POST /creatives/{id}/landing-page', async () => {
    await client.callTool({ name: 'attach_landing_page', arguments: { creativeId: CREATIVE, url: 'https://lp.example.com/hearing?utm_source=fb' } });
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: `/api/v1/creatives/${CREATIVE}/landing-page`, body: { url: 'https://lp.example.com/hearing?utm_source=fb' } });
  });
});

describe('errors come back as plain-text tool errors', () => {
  it("surfaces Stato's own message plus the first field error", async () => {
    reply = () => ({ status: 400, body: { status: 'error', message: 'Validation failed', errors: [{ path: 'sourceUrl', message: 'must be https' }] } });
    const r = await client.callTool({ name: 'upload_creative', arguments: { platform: 'meta', clientId: CLIENT, sourceUrl: 'https://x.example/a.jpg' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Validation failed (sourceUrl: must be https)');
  });

  it('explains a missing scope (403) without a server message', async () => {
    reply = () => ({ status: 403, body: {} });
    const r = await client.callTool({ name: 'link_ad_account', arguments: { clientId: CLIENT, platform: 'meta', accountId: '1' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/doesn't have permission/);
  });

  it('says nothing was changed when Stato is unreachable', async () => {
    await fake.close();
    const r = await client.callTool({ name: 'list_creatives', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Couldn't reach Stato .*Nothing was changed/);
    fake = await startFakeStato();
  });

  it('rejects bad input before calling Stato', async () => {
    const r = await client.callTool({ name: 'attach_landing_page', arguments: { creativeId: 'nope', url: 'not a url' } });
    expect(r.isError).toBe(true);
    expect(fake.seen).toHaveLength(0);
  });
});
