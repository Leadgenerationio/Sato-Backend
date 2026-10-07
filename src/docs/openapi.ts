import { z } from 'zod';
import * as lib from '../controllers/creative-library.controller.js';
import { linkOneSchema, listSchema as adAccountsListSchema } from '../routes/ad-account.routes.js';
import { API_SCOPES } from '../services/api-key.service.js';

// OpenAPI 3.1 for the public API (plan phase 2). Request schemas come from the
// SAME zod objects the routes validate with (z.toJSONSchema, zod v4), so the
// docs can't drift from what the server accepts.

type Json = Record<string, unknown>;
const schema = (s: z.ZodType): Json => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Json;

function queryParams(s: z.ZodObject): Json[] {
  const js = schema(s) as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, sch]) => ({
    name, in: 'query', required: (js.required ?? []).includes(name), schema: sch,
  }));
}

const ok = (description: string, data: Json = { type: 'object' }): Json => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { status: { const: 'success' }, data } } } },
});
const errors = {
  400: { $ref: '#/components/responses/ValidationError' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  429: { $ref: '#/components/responses/RateLimited' },
};
const sec = (scope: string) => [{ ApiKey: [scope] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const idempotencyHeader = {
  name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 100 },
  description: 'Retry-safe create: the first response is stored for 24 h and replayed (header `Idempotent-Replayed: true`). Reusing the key with a different body returns 422.',
};

export function buildOpenApi(serverUrl: string): Json {
  const lookupQuery = z.object({ platform: z.string().describe('meta | facebook-ads | taboola | google-ads | tik-tok (normalised)'), accountId: z.string() });
  return {
    openapi: '3.1.0',
    info: {
      title: 'Stato public API',
      version: '1.0.0',
      description: [
        'File ads from Meta, Taboola and other platforms under the right client automatically.',
        '',
        '**Auth:** send `X-API-Key: stk_…`. Keys are created and revoked by the Owner in Settings → API keys; each key has limited scopes, every call is logged, and each key is limited to 120 requests a minute.',
        '',
        '**MCP:** the same keys also work on `POST /mcp` for AI assistants: send `Authorization: Bearer stk_…`. See the setup guide (docs/mcp-setup.md) and the tool list (docs/mcp-tools.md).',
        '',
        '**Matching is on IDs, never names:** a creative finds its client from `(platform, platformAccountId)` via the ad-account links (`POST /clients/{id}/ad-accounts`).',
      ].join('\n'),
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: `Scopes: ${API_SCOPES.join(', ')}` },
        BearerKey: { type: 'http', scheme: 'bearer', description: 'The same key as `Authorization: Bearer stk_…` (used by MCP clients).' },
      },
      responses: {
        ValidationError: { description: 'Invalid input — `errors[]` lists each field.' },
        Unauthorized: { description: 'Missing, invalid, expired or revoked API key.' },
        Forbidden: { description: 'The key lacks the scope for this call (`code: insufficient_scope`).' },
        NotFound: { description: 'Not found in this business.' },
        RateLimited: { description: 'More than 120 requests in a minute for this key.' },
      },
    },
    paths: {
      '/mcp': {
        post: {
          summary: 'MCP endpoint (Streamable HTTP, stateless)',
          description: 'JSON-RPC 2.0 messages for the Model Context Protocol: `initialize`, `tools/list`, `tools/call`. 22 tools; each tool needs its own scope. A tool error is a normal 200 JSON-RPC result with `isError: true` and the shared error body (`code`, `message`, `hint`, `fields`, `retryable`, `requestId`). Over the limit (120 a minute per key) the answer is 429 with `retryAfter`. Only POST is accepted. Optional header `X-Stato-Agent` names the bot in the Activity screen.',
          security: [{ BearerKey: [] }, { ApiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['jsonrpc', 'method'], properties: { jsonrpc: { const: '2.0' }, id: { type: ['string', 'integer'] }, method: { type: 'string', examples: ['tools/list', 'tools/call'] }, params: { type: 'object' } } } } } },
          responses: { 200: ok('The JSON-RPC result (a tool error is a result with isError true).'), 401: { $ref: '#/components/responses/Unauthorized' }, 405: { description: 'Only POST is accepted.' }, 429: { $ref: '#/components/responses/RateLimited' } },
        },
      },
      '/whoami': {
        get: {
          summary: 'Which key, business and scopes this connection is using',
          description: 'Needs no scope: any valid key may ask. The live request count left is in the `RateLimit-Remaining` response header.',
          security: [{ ApiKey: [] }],
          responses: { 200: ok('The key (name, prefix, scopes, expiry), its owner, the business and the per-key rate limit.'), 401: { $ref: '#/components/responses/Unauthorized' }, 429: { $ref: '#/components/responses/RateLimited' } },
        },
      },
      '/ad-accounts': {
        get: {
          summary: 'Ad accounts with spend and what they are linked to',
          description: 'Filters are AND-ed. `linked=false` lists accounts with spend but no client. `q` matches the account ID (with or without `act_`) or the name. The summary counts only the filtered accounts.',
          security: sec('clients:read'),
          parameters: queryParams(adAccountsListSchema.shape.query),
          responses: { 200: ok('Accounts with 30-day spend (or `days`), their client and campaign link, and a summary.'), ...errors },
        },
      },
      '/clients/lookup': {
        get: {
          summary: 'Which client owns this ad account',
          security: sec('clients:read'),
          parameters: queryParams(lookupQuery),
          responses: { 200: ok('The client (and optional campaign) linked to the account.'), 404: { $ref: '#/components/responses/NotFound' }, ...errors },
        },
      },
      '/clients/{id}/ad-accounts': {
        post: {
          summary: 'Link an ad account to a client',
          description: 'Upsert on (platform, accountId). An account already linked to another client is refused with 409 `move_requires_confirm` unless the body has `confirmMove: true`; a confirmed move is recorded. `campaignId` may be the Stato UUID or the LeadByte number and must belong to the client; leave it out to keep the current campaign, send `null` to clear it. The response `platform` uses the API names `meta`, `google`, `tiktok`, `taboola` (it was `facebook-ads` / `tik-tok` before).',
          security: sec('ad_accounts:write'),
          parameters: [idParam],
          requestBody: { required: true, content: { 'application/json': { schema: schema(linkOneSchema.shape.body) } } },
          responses: { 201: ok('Linked.'), 200: ok('Updated, unchanged or moved (confirmMove).'), 409: { description: 'move_requires_confirm: the account belongs to another client.' }, 422: { description: 'campaign_client_mismatch: that campaign is not linked to this client.' }, ...errors },
        },
      },
      '/creatives': {
        get: {
          summary: 'List and search creatives',
          security: sec('creatives:read'),
          parameters: queryParams(lib.listQuerySchema),
          responses: { 200: ok('A page of creatives with signed thumbnail URLs.'), ...errors },
        },
        post: {
          summary: 'Add a creative (or up to 50)',
          description: 'Send the file as `sourceUrl` (downloaded by the server: public http(s), images/videos only, max 50 MB) or `r2Key` from the presign flow. The same (platform, platformCreativeId) — or the same file for the same client — updates the existing creative (200) instead of copying it (201).',
          security: sec('creatives:write'),
          parameters: [idempotencyHeader],
          requestBody: { required: true, content: { 'application/json': { schema: schema(lib.createCreativesBodySchema) } } },
          responses: { 201: ok('Created.'), 200: ok('Already on file — updated.'), 413: { description: 'File too large: max 50 MB' }, 422: { description: 'No client linked to the ad account, not an image/video, or unreachable sourceUrl.' }, ...errors },
        },
      },
      '/creatives/{id}': {
        get: { summary: 'One creative (with a signed file URL)', security: sec('creatives:read'), parameters: [idParam], responses: { 200: ok('The creative.'), 404: { $ref: '#/components/responses/NotFound' }, ...errors } },
      },
      '/creatives/{id}/landing-page': {
        post: {
          summary: 'Attach a landing page to a creative',
          security: sec('creatives:write'),
          parameters: [idParam],
          requestBody: { required: true, content: { 'application/json': { schema: schema(lib.attachSchema) } } },
          responses: { 200: ok('Updated creative.'), 404: { $ref: '#/components/responses/NotFound' }, ...errors },
        },
      },
      '/landing-pages': {
        post: {
          summary: 'Add a landing page for a client',
          description: 'Stored once per client by normalised URL (utm_*, fbclid, gclid… ignored): 201 new, 200 already on file.',
          security: sec('landing_pages:write'),
          requestBody: { required: true, content: { 'application/json': { schema: schema(lib.lpCreateSchema) } } },
          responses: { 201: ok('Created.'), 200: ok('Already on file.'), ...errors },
        },
      },
    },
  };
}

export function docsHtml(specUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stato public API</title></head>
<body><script id="api-reference" data-url="${specUrl}"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script></body></html>`;
}
