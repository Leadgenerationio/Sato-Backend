import { z } from 'zod';
import { defineTool } from '../types.js';
import { attachLandingPage } from '../../services/creative-library.service.js';
import { toApiError } from '../../utils/to-api-error.js';

export default defineTool({
  name: 'attach_landing_page',
  title: 'Attach a landing page to an asset',
  description:
    'Set the landing page of an asset, by landingPageId or by url (the page is saved for the asset\'s client if it is new). The page must belong to the same client as the asset. Safe to repeat. IDs are strings.',
  inputSchema: {
    creativeId: z.string().min(1).describe('Stato asset ID (UUID).'),
    landingPageId: z.string().optional(),
    url: z.string().max(500).optional(),
  },
  outputSchema: { creativeId: z.string(), landingPage: z.object({ id: z.string(), url: z.string(), title: z.string().nullable() }).nullable() },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  scope: 'creatives:write',
  handler: async ({ creativeId, landingPageId, url }, ctx) => {
    try {
      const dto = await attachLandingPage(ctx.businessId, creativeId, { landingPageId, url });
      return {
        summary: `Landing page set for asset ${dto.id}.`,
        data: { creativeId: dto.id, landingPage: dto.landingPage },
        audit: { after: { landingPageId: dto.landingPageId }, recordsTouched: [{ type: 'creative', id: dto.id }] },
      };
    } catch (err) { return toApiError(err); }
  },
});
