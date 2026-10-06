import { z } from 'zod';
import { defineTool } from '../types.js';
import { listLandingPages } from '../../services/creative-library.service.js';

export default defineTool({
  name: 'list_landing_pages',
  title: 'Find landing pages',
  description: 'List the saved landing pages for a client, with how many assets use each. Use it before add_landing_page or attach_landing_page. IDs are strings.',
  inputSchema: {
    clientId: z.string().optional(),
    q: z.string().max(100).optional().describe('Part of the URL or title.'),
    includeArchived: z.boolean().optional(),
  },
  outputSchema: {
    items: z.array(z.object({ landingPageId: z.string(), clientId: z.string().nullable(), url: z.string(), title: z.string().nullable(), status: z.string(), creativeCount: z.number() })),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scope: 'creatives:read',
  handler: async (args, ctx) => {
    const rows = await listLandingPages(ctx.businessId, args);
    return {
      summary: `${rows.length} landing pages.`,
      data: { items: rows.map((r) => ({ landingPageId: r.id, clientId: r.clientId, url: r.url, title: r.title, status: r.status, creativeCount: r.creativeCount ?? 0 })) },
    };
  },
});
