import { z } from 'zod';
import { defineTool } from '../types.js';
import { withToolResult } from '../../services/tool-idempotency.service.js';
import { uuidShape } from '../../utils/zod-helpers.js';
import { createLandingPage } from '../../services/creative-library.service.js';
import { toApiError } from '../../utils/to-api-error.js';

export default defineTool({
  name: 'add_landing_page',
  title: 'Add a landing page for a client',
  description:
    'Save a landing page URL for a client. The URL is normalised (utm_ parameters, fbclid and gclid are removed), so the same page sent twice is one record: the result is "existing" the second time. ' +
    'Stato stores URLs only; it does not host pages. Safe to repeat. IDs are strings.',
  inputSchema: {
    idempotencyKey: z.string().max(100).optional().describe('Optional. Repeating the same call with the same key returns the first answer instead of doing it twice.'),
    clientId: uuidShape().describe('Stato client ID (UUID).'),
    url: z.string().min(1).max(500).describe('The page address, http or https.'),
    title: z.string().max(255).optional(),
    campaignId: uuidShape().optional().describe('Stato campaign UUID.'),
  },
  outputSchema: {
    result: z.enum(['created', 'existing']),
    landingPage: z.object({ id: z.string(), clientId: z.string().nullable(), campaignId: z.string().nullable(), url: z.string(), normalisedUrl: z.string().nullable(), title: z.string().nullable(), status: z.string() }),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'landing_pages:write',
  handler: async (rawArgs, ctx) => {
    const { idempotencyKey, ...args } = rawArgs;
    return withToolResult(ctx.apiKey.id, idempotencyKey, 'add_landing_page', args, async () => {
    try {
      const { page, created } = await createLandingPage(ctx.businessId, args as { clientId: string; url: string; title?: string; campaignId?: string });
      return {
        summary: created ? `Saved the landing page ${page.url}.` : `That landing page is already saved (${page.id}).`,
        data: { result: (created ? 'created' : 'existing') as 'created' | 'existing', landingPage: { id: page.id, clientId: page.clientId, campaignId: page.campaignId, url: page.url, normalisedUrl: page.normalisedUrl, title: page.title, status: page.status } },
        audit: { after: { landingPageId: page.id, url: page.url, created }, recordsTouched: [{ type: 'landing_page', id: page.id }] },
      };
    } catch (err) { return toApiError(err); }
    });
  },
});
