import type { Request, Response } from 'express';
import { verifyResendSignature } from '../integrations/resend/resend-webhook.js';
import * as emailDeliveryService from '../services/email-delivery.service.js';
import { logger } from '../utils/logger.js';

// Resend delivery-event webhook — unauthenticated, must be reachable by Resend.
// Signature is verified with RESEND_WEBHOOK_SECRET (Svix `whsec_…`).
//
// Mirrors the SignNow webhook stance: refuse unsigned traffic in production,
// allow it (loudly) in dev, and always answer 200 on handler errors so we
// don't trigger a provider retry storm.
export async function resendWebhook(req: Request, res: Response) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (secret) {
      const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
      const ok = verifyResendSignature({
        rawBody,
        svixId: req.header('svix-id') ?? '',
        svixTimestamp: req.header('svix-timestamp') ?? '',
        svixSignature: req.header('svix-signature') ?? '',
        secret,
      });
      if (!ok) {
        logger.warn('Resend webhook signature verification failed — rejecting');
        res.status(401).json({ status: 'error', message: 'Invalid signature' });
        return;
      }
    } else if (process.env.NODE_ENV === 'production') {
      // 503 (not 200) so the misconfiguration lands in Resend's retry queue
      // and gets noticed, instead of us silently trusting forged events.
      logger.error('RESEND_WEBHOOK_SECRET not set in production — refusing webhook');
      res.status(503).json({ status: 'error', message: 'Webhook secret not configured' });
      return;
    } else {
      logger.warn('Resend webhook accepted without signature (non-production environment)');
    }

    const result = await emailDeliveryService.applyEvent(req.body);
    logger.info({ type: req.body?.type, ...result }, 'Resend webhook processed');
    res.status(200).json({ status: 'success' });
  } catch (err) {
    logger.error({ err }, 'Resend webhook handler threw');
    res.status(200).json({ status: 'received' });
  }
}
