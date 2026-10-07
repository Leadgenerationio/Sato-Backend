import { ApiError } from '../utils/api-error.js';
import {
  assertAccountInScope, assertAdLinkInScope, assertCampaignInScope, assertClientInScope, assertCreativeInScope, assertLandingPageInScope,
  clientAllowed, runWithClientScope, type ClientScope,
} from '../services/key-client-scope.service.js';
import type { StatoTool, ToolContext, ToolOutput } from './types.js';

// The per-client key limit for every MCP tool, in one place (MCP spec v1.0 §3,
// step 1h). A key with allowed_client_ids may only see and touch those clients.
// For each tool: `before` checks every client the call would touch, before
// anything runs or is saved; `after` takes out of a result what belongs to other
// clients. The list tools filter in their queries (currentClientScope), so
// paging stays right.
//
// A tool that has no entry below is refused for a limited key, so a new tool
// can never leak another client's data by being added without a rule here.
// A key with no limit (NULL) skips all of this.

type Args = Record<string, unknown>;
interface ClientRule {
  before?: (args: Args, ctx: ToolContext, scope: readonly string[]) => Promise<void> | void;
  after?: (out: ToolOutput, scope: readonly string[]) => ToolOutput;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const clientArg = (args: Args, scope: readonly string[]) => { if (str(args.clientId)) assertClientInScope(str(args.clientId), scope); };
const creativeArg = (args: Args, ctx: ToolContext, scope: readonly string[]) => assertCreativeInScope(ctx.businessId, String(args.creativeId), scope);

const RULES: Record<string, ClientRule> = {
  // No client data, or only the key itself.
  whoami: {},
  create_upload: {},
  complete_upload: {},

  // Lists: filtered in their queries.
  list_clients: {},
  list_ad_accounts: { before: (a, _c, s) => clientArg(a, s) },
  list_assets: { before: (a, _c, s) => clientArg(a, s) },
  list_campaigns: {
    before: (a, _c, s) => clientArg(a, s),
    after: (out, scope) => {
      const data = out.data as { items: Array<{ linkedClientIds: string[] }> };
      for (const c of data.items) c.linkedClientIds = c.linkedClientIds.filter((id) => clientAllowed(id, scope));
      return out;
    },
  },
  list_landing_pages: {
    before: (a, _c, s) => clientArg(a, s),
    after: (out, scope) => {
      const data = out.data as { items: Array<{ clientId: string | null }> };
      const items = data.items.filter((p) => clientAllowed(p.clientId, scope));
      return { ...out, summary: `${items.length} landing pages.`, data: { ...data, items } };
    },
  },

  get_client: { before: (a, _c, s) => clientArg(a, s) },
  get_campaign: {
    before: (a, c, s) => assertCampaignInScope(c.businessId, String(a.campaignId), s),
    after: (out, scope) => {
      const d = out.data as { linkedClients: Array<{ clientId: string }>; adAccounts: Array<{ clientId: string | null }> };
      const linkedClients = d.linkedClients.filter((c) => clientAllowed(c.clientId, scope));
      const adAccounts = d.adAccounts.filter((a) => clientAllowed(a.clientId, scope));
      return { ...out, summary: `${(out.data as { campaign: { name: string } }).campaign.name}: ${linkedClients.length} clients, ${adAccounts.length} ad accounts.`, data: { ...d, linkedClients, adAccounts } };
    },
  },
  find_client_by_ad_account: { before: (a, c, s) => assertAccountInScope(c.businessId, String(a.platform), String(a.accountId), s) },
  find_asset_by_platform_id: {
    // Another client's asset is not there for this key: the same answer as no match.
    after: (out, scope) => {
      const d = out.data as { found: boolean; creative: { clientId: string | null } | null };
      if (!d.found || clientAllowed(d.creative?.clientId, scope)) return out;
      return { ...out, summary: 'No asset matches. It is safe to upload it.', data: { found: false, creative: null, adLink: null } };
    },
  },
  get_asset: { before: creativeArg },

  // Writes: every client the call touches must be on the list.
  link_ad_account: {
    before: async (a, c, s) => {
      clientArg(a, s);
      // Moving an account away from a client outside the list is touching that client.
      await assertAccountInScope(c.businessId, String(a.platform), String(a.accountId), s);
    },
  },
  upload_asset: {
    before: async (a, c, s) => {
      clientArg(a, s);
      if (str(a.platformAccountId) && !str(a.platform)) {
        throw new ApiError('validation_failed', 'platform is required with platformAccountId.', { fields: [{ field: 'platform', message: 'Required with platformAccountId' }] });
      }
      if (str(a.platformAccountId)) await assertAccountInScope(c.businessId, String(a.platform), String(a.platformAccountId), s);
      else if (!str(a.clientId)) {
        throw new ApiError('validation_failed', 'This key is limited to some clients: send platformAccountId or clientId so the asset is filed under one of them.', {
          fields: [{ field: 'platformAccountId', message: 'Required for a key limited to some clients' }],
        });
      }
    },
  },
  update_asset: { before: async (a, c, s) => { clientArg(a, s); await creativeArg(a, c, s); } },
  archive_asset: { before: creativeArg },
  restore_asset: { before: creativeArg },
  link_ad_platform_ids: {
    before: async (a, c, s) => {
      await creativeArg(a, c, s);
      await assertAccountInScope(c.businessId, String(a.platform), String(a.accountId), s);
    },
  },
  unlink_ad_platform_ids: { before: (a, c, s) => assertAdLinkInScope(c.businessId, String(a.adLinkId), s) },
  add_landing_page: { before: (a, _c, s) => clientArg(a, s) },
  attach_landing_page: {
    before: async (a, c, s) => {
      await creativeArg(a, c, s);
      if (str(a.landingPageId)) await assertLandingPageInScope(c.businessId, String(a.landingPageId), s);
    },
  },
};

/** Tool names with a rule; a limited key can call only these. */
export const TOOLS_WITH_CLIENT_RULES = Object.keys(RULES);

/** Run one tool call for this key, inside its client limit. */
export async function callWithinClientScope(tool: StatoTool, args: Args, ctx: ToolContext): Promise<ToolOutput> {
  const scope: ClientScope = ctx.allowedClientIds;
  if (!scope) return tool.handler(args, ctx);
  const rule = RULES[tool.name];
  if (!rule) {
    throw new ApiError('insufficient_scope', `${tool.name} is not available to a key limited to some clients.`, {
      hint: 'Use a key without a client limit for this tool.',
    });
  }
  return runWithClientScope(scope, async () => {
    await rule.before?.(args, ctx, scope);
    const out = await tool.handler(args, ctx);
    return rule.after ? rule.after(out, scope) : out;
  });
}
