import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StatoApi, StatoApiError } from './stato-client.js';

// Plan phase 4: a thin MCP wrapper over the Stato public API, so an assistant
// that has just loaded ads to Meta or Taboola can file each creative under the
// right client. Matching is on (platform, account ID) — never account names.

export const SERVER_INFO = { name: 'stato', version: '0.1.0' } as const;

const platform = z.string().min(1).max(50)
  .describe('Ad platform the account belongs to, e.g. "meta" (Facebook/Instagram) or "taboola". Stato normalises aliases such as "facebook" or "facebook-ads".');
const accountId = z.string().min(1).max(100)
  .describe("The platform's ad account ID exactly as the platform shows it (for Meta, digits without the act_ prefix are fine). Never an account name.");
// Shape check only (like the backend's uuidShape): zod's .uuid() rejects the
// nil-style ids Stato's seeded demo data uses.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (what: string) => z.string().regex(UUID_SHAPE, 'must be a UUID').describe(`Stato ${what} ID (UUID).`);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(summary: string, data: unknown): ToolResult {
  return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof StatoApiError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try { return await fn(); } catch (err) { return fail(err); }
}

export function createStatoMcpServer(api: StatoApi): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Stato is the Lead Generation admin portal. Use find_client_by_ad_account before uploading, to confirm which client an ad account belongs to. ' +
      'If it belongs to no client, ask the user which client, then link_ad_account. upload_creative is safe to retry: the same creative is updated, never duplicated.',
  });

  server.registerTool('find_client_by_ad_account', {
    title: 'Find client by ad account',
    description: 'Look up which Stato client (and optional campaign) owns an ad account. Returns null data when the account is not linked yet.',
    inputSchema: { platform, accountId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ platform, accountId }) => run(async () => {
    let data: unknown;
    try {
      data = await api.findClientByAdAccount(platform, accountId);
    } catch (err) {
      // The API answers 404 for an account no client owns — an answer, not a failure.
      if (err instanceof StatoApiError && err.status === 404) data = null;
      else throw err;
    }
    return ok(data ? `Ad account ${accountId} on ${platform} is linked in Stato.` : `Ad account ${accountId} on ${platform} is not linked to any client yet.`, data);
  }));

  server.registerTool('link_ad_account', {
    title: 'Link ad account to client',
    description: 'Record that an ad account belongs to a Stato client (optionally a campaign). Future creatives from this account are then filed under that client automatically.',
    inputSchema: {
      clientId: uuid('client'),
      platform,
      accountId,
      campaignId: uuid('campaign').optional(),
      currency: z.string().length(3).optional().describe('ISO currency the account spends in, e.g. GBP, EUR, CHF.'),
    },
    annotations: { idempotentHint: true, destructiveHint: false },
  }, ({ clientId, ...rest }) => run(async () => ok(`Linked ${rest.platform} account ${rest.accountId} to client ${clientId}.`, await api.linkAdAccount(clientId, rest))));

  server.registerTool('upload_creative', {
    title: 'Upload creative',
    description:
      'File an ad creative (image or video) in Stato. Give either clientId, or platform + accountId so Stato finds the client from the linked ad account. ' +
      'sourceUrl must be a public https URL of the file; Stato downloads, checks and stores it. Sending the same creative again updates it instead of copying it.',
    inputSchema: {
      platform,
      accountId: accountId.optional(),
      clientId: uuid('client').optional(),
      campaignId: uuid('campaign').optional(),
      sourceUrl: z.string().url().describe('Public https URL of the image or video file.'),
      landingPageUrl: z.string().url().optional().describe('Where the ad sends people. Stato stores it as a landing page record for the client.'),
      headline: z.string().max(500).optional(),
      bodyText: z.string().max(5000).optional().describe('Primary ad text.'),
      platformAdId: z.string().max(100).optional().describe("The platform's ad ID."),
      platformCreativeId: z.string().max(100).optional().describe("The platform's creative ID — the best key for de-duplication."),
      idempotencyKey: z.string().min(8).max(100).optional().describe('Optional; derived from the creative when omitted.'),
    },
    annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, (input) => run(async () => {
    if (!input.clientId && !input.accountId) {
      return fail(new StatoApiError(400, 'Give either clientId, or accountId so Stato can find the client from the ad account.'));
    }
    return ok('Creative saved in Stato.', await api.uploadCreative(input));
  }));

  server.registerTool('list_creatives', {
    title: 'List creatives',
    description: 'Search creatives in Stato by client, platform, landing page or text.',
    inputSchema: {
      clientId: uuid('client').optional(),
      platform: platform.optional(),
      landingPage: z.string().max(2048).optional().describe('Landing page URL (or part of it).'),
      q: z.string().max(200).optional().describe('Free-text search over name, headline and text.'),
      sort: z.enum(['newest', 'oldest', 'name']).optional(),
      page: z.number().int().min(1).optional(),
    },
    annotations: { readOnlyHint: true },
  }, (q) => run(async () => ok('Creatives from Stato.', await api.listCreatives(q))));

  server.registerTool('attach_landing_page', {
    title: 'Attach landing page',
    description: "Set a creative's landing page. Stato reuses the client's existing landing page record when the URL matches (tracking parameters ignored).",
    inputSchema: { creativeId: uuid('creative'), url: z.string().url().describe('Landing page URL.') },
    annotations: { idempotentHint: true, destructiveHint: false },
  }, ({ creativeId, url }) => run(async () => ok(`Landing page set on creative ${creativeId}.`, await api.attachLandingPage(creativeId, url))));

  return server;
}
