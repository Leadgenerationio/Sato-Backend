import { z } from 'zod';
import { defineTool } from '../types.js';
import { describeApiKeyCaller } from '../../services/whoami.service.js';
import { ApiError } from '../../utils/api-error.js';

export default defineTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    'Shows which API key, owner and business this connection is using, the scopes it holds, and the clients it is limited to (key.allowedClients; null means every client). Call it first to check you are pointed at the right place; it also says how many calls this key has left in the current minute (rateLimit.remaining). It needs no input and changes nothing. IDs are strings.',
  inputSchema: {},
  outputSchema: {
    authType: z.literal('api_key'),
    keyName: z.string(),
    key: z.object({
      id: z.string(), name: z.string(), prefix: z.string(), scopes: z.array(z.string()), expiresAt: z.string().nullable(), lastUsedAt: z.string().nullable(),
      allowedClients: z.array(z.object({ clientId: z.string(), name: z.string() })).nullable().describe('The clients this key is limited to; null means every client in the business.'),
      agentLabel: z.string().nullable(),
    }),
    owner: z.object({ name: z.string() }).nullable(),
    business: z.object({ id: z.string(), name: z.string() }).nullable(),
    agent: z.string().nullable(),
    rateLimit: z.object({ limit: z.number(), windowSeconds: z.number(), remaining: z.number().nullable(), resetsInSeconds: z.number().nullable() }),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    const info = await describeApiKeyCaller(ctx.apiKey.id, ctx.businessId);
    if (!info) throw new ApiError('unauthorized', 'This API key no longer exists.', { hint: 'Ask the owner for a new key in Settings, API keys.' });
    return {
      summary: `Connected as key "${info.key.name}" for ${info.business?.name ?? 'your business'} with ${info.key.scopes.length} scopes${info.key.allowedClients ? `, limited to ${info.key.allowedClients.length} client(s)` : ''}.`,
      data: { ...info, keyName: info.key.name, agent: ctx.agent, rateLimit: { ...info.rateLimit, remaining: ctx.rateLimit?.remaining ?? null, resetsInSeconds: ctx.rateLimit?.resetsInSeconds ?? null } },
    };
  },
});
