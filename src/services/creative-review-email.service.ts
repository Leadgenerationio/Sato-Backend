import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientEmails } from '../db/schema/client-emails.js';
import { env } from '../config/env.js';
import { sendEmail, isResendConfigured } from '../integrations/resend/resend-client.js';
import { recordOutboundEmail } from './client-emails.service.js';
import { logger } from '../utils/logger.js';

// Creative-review v2 — Day 3 (Sam #9/#11). When staff uploads a creative,
// every buyer linked to that campaign gets an email to their portal account
// so they can sign off the new asset. Rate-limited to 1 email per buyer per
// hour: if 5 assets are uploaded in 10 minutes the buyer gets one digest,
// not five separate pings.
//
// All sends fire-and-forget — a Resend outage must NOT break creative upload.

const EMAIL_TAG = 'creative-review';
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Notify every buyer linked to a campaign that a new creative is awaiting
 * review. Rate-limited per-buyer via a lookup in `client_emails` — we skip
 * buyers who already received a creative-review email in the last hour.
 *
 * Each email auto-logs to `client_emails` (outbound) so the per-client
 * email thread reflects every send.
 */
export async function notifyBuyersOfNewCreative(params: {
  campaignId: string;
  campaignName: string;
  creativeName: string;
  section: 'media' | 'copy_lp';
}): Promise<{ sent: number; skipped: number }> {
  const { campaignId, campaignName, creativeName, section } = params;
  const result = { sent: 0, skipped: 0 };

  // 1) Resolve every buyer (linked client) of this campaign.
  const buyers = await db
    .select({
      id: clients.id,
      companyName: clients.companyName,
      contactName: clients.contactName,
      contactEmail: clients.contactEmail,
    })
    .from(clientCampaigns)
    .innerJoin(clients, eq(clientCampaigns.clientId, clients.id))
    .where(eq(clientCampaigns.campaignId, campaignId));

  if (buyers.length === 0) {
    logger.info({ campaignId }, 'creative-review email: no buyers linked, nothing to send');
    return result;
  }

  const sinceCutoff = new Date(Date.now() - RATE_LIMIT_MS);

  // 2) Per-buyer: rate-limit + send + log.
  for (const buyer of buyers) {
    if (!buyer.contactEmail) {
      logger.info({ clientId: buyer.id }, 'creative-review email: no contact_email on buyer, skipping');
      result.skipped++;
      continue;
    }

    // Rate-limit lookup — most-recent outbound row tagged for this thread.
    // resendEvent doubles as a tag here (we don't track per-message delivery
    // events) so reuse the column rather than adding a new one.
    const [recent] = await db
      .select({ occurredAt: clientEmails.occurredAt })
      .from(clientEmails)
      .where(and(
        eq(clientEmails.clientId, buyer.id),
        eq(clientEmails.direction, 'outbound'),
        eq(clientEmails.resendEvent, EMAIL_TAG),
        gte(clientEmails.occurredAt, sinceCutoff),
      ))
      .orderBy(desc(clientEmails.occurredAt))
      .limit(1);

    if (recent) {
      logger.info(
        { clientId: buyer.id, lastSentAt: recent.occurredAt },
        'creative-review email: within rate-limit window, skipping',
      );
      result.skipped++;
      continue;
    }

    const subject = `New ${section === 'media' ? 'creative' : 'copy / landing page'} ready for review — ${campaignName}`;
    const portalUrl = `${env.FRONTEND_URL?.split(',')[0] ?? 'https://sato-frontend.vercel.app'}/portal/creatives`;
    const greeting = buyer.contactName ? `Hi ${buyer.contactName.split(' ')[0]}` : 'Hi';
    const html = `
      <p>${greeting},</p>
      <p>A new ${section === 'media' ? 'creative asset' : 'copy / landing page'} is ready for your review
      on the <strong>${campaignName}</strong> campaign:</p>
      <p style="padding:12px;background:#f5f5f5;border-radius:6px;font-family:monospace;font-size:14px;">
        ${escapeHtml(creativeName)}
      </p>
      <p>You can approve, request changes, or reject the asset from your portal:</p>
      <p><a href="${portalUrl}" style="display:inline-block;padding:10px 18px;background:#171717;color:#fff;text-decoration:none;border-radius:6px;">Review on the portal →</a></p>
      <p style="color:#737373;font-size:13px;">If multiple assets are uploaded close together we&rsquo;ll send a single reminder per hour to avoid inbox spam.</p>
      <p>Thanks,<br/>leadgeneration.io</p>
    `;
    const text = [
      `${greeting},`,
      ``,
      `A new ${section === 'media' ? 'creative asset' : 'copy / landing page'} is ready for review on the ${campaignName} campaign:`,
      ``,
      `  ${creativeName}`,
      ``,
      `Approve / request changes / reject from your portal:`,
      `  ${portalUrl}`,
      ``,
      `If multiple assets are uploaded close together we'll send a single reminder per hour.`,
      ``,
      `Thanks,`,
      `leadgeneration.io`,
    ].join('\n');

    try {
      const sendRes = await sendEmail({
        to: buyer.contactEmail,
        subject,
        html,
        text,
        tags: [{ name: 'kind', value: EMAIL_TAG }, { name: 'section', value: section }],
      });
      // Log to client_emails for the thread view — use resendEvent as the tag
      // so the rate-limit lookup above can find it on the next upload.
      await recordOutboundEmail(buyer.id, {
        subject,
        body: text,
        toAddress: buyer.contactEmail,
        fromAddress: env.RESEND_FROM_EMAIL,
        messageId: sendRes.id,
      });
      // Patch the just-inserted row with the tag — recordOutboundEmail doesn't
      // accept resendEvent yet, so update by messageId. Cheap one-row update.
      if (sendRes.id) {
        await db
          .update(clientEmails)
          .set({ resendEvent: EMAIL_TAG })
          .where(eq(clientEmails.messageId, sendRes.id));
      }
      result.sent++;
      logger.info(
        { clientId: buyer.id, messageId: sendRes.id, section, configured: isResendConfigured() },
        'creative-review email sent',
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), clientId: buyer.id },
        'creative-review email send failed (non-blocking)',
      );
      result.skipped++;
    }
  }

  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
