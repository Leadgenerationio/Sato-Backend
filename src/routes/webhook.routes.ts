import { Router, type Router as RouterType } from 'express';
import * as webhookController from '../controllers/webhook.controller.js';

export const webhookRoutes: RouterType = Router();

// Unauthenticated by design — Resend calls this. The controller verifies the
// Svix signature against RESEND_WEBHOOK_SECRET. Mounted under
// /api/v1/webhooks, which src/index.ts already wires with a rawBody-capturing
// JSON parser (HMAC must be computed over the exact bytes Resend signed).
webhookRoutes.post('/resend', webhookController.resendWebhook);
