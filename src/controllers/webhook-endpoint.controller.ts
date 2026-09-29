import { Request, Response } from 'express';
import * as service from '../services/webhook.service.js';

// Owner-only management of OUTBOUND webhooks (plan phase 4). Inbound provider
// webhooks (Xero, Resend, SignNow) live in webhook.controller.ts under /webhooks.

export async function list(req: Request, res: Response) {
  const endpoints = await service.listEndpoints(req.user!);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { endpoints, events: service.WEBHOOK_EVENTS } });
}

export async function create(req: Request, res: Response) {
  const { endpoint, secret } = await service.createEndpoint(req.user!, req.body);
  // The signing secret is returned ONCE, here. Only an encrypted copy is kept.
  res.status(201).json({ status: 'success', data: { endpoint, secret } });
}

export async function update(req: Request, res: Response) {
  const data = await service.updateEndpoint(req.user!, String(req.params.id), req.body);
  res.json({ status: 'success', data });
}

export async function remove(req: Request, res: Response) {
  await service.deleteEndpoint(req.user!, String(req.params.id));
  res.json({ status: 'success', data: { deleted: true } });
}

export async function deliveries(req: Request, res: Response) {
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
  const rows = await service.listDeliveries(req.user!, String(req.params.id), Number.isFinite(limit) ? limit : 50);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { deliveries: rows } });
}

export async function test(req: Request, res: Response) {
  const result = await service.sendTest(req.user!, String(req.params.id));
  res.json({ status: 'success', data: result });
}

export async function redeliver(req: Request, res: Response) {
  await service.redeliver(req.user!, String(req.params.id), String(req.params.deliveryId));
  res.status(202).json({ status: 'success', data: { queued: true } });
}
