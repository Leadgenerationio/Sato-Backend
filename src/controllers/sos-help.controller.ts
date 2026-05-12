import { Request, Response } from 'express';
import * as sosService from '../services/sos-help.service.js';

// Slice 5 Day 6 — Sam Loom #100. Three endpoints:
//   POST /api/v1/sos              — any authed user (including clients) hits
//                                   this to record a help request and get
//                                   back a wa.me link.
//   GET  /api/v1/sos              — owners/ops see the queue.
//   POST /api/v1/sos/:id/resolve  — owners/ops mark resolved.

export async function createSos(req: Request, res: Response) {
  const { pagePath, message } = req.body ?? {};
  const result = await sosService.createSosRequest(req.user!, {
    pagePath: typeof pagePath === 'string' ? pagePath : undefined,
    message: typeof message === 'string' ? message : undefined,
  });
  res.status(201).json({ status: 'success', data: result });
}

export async function listSos(req: Request, res: Response) {
  const unresolvedOnly = req.query.unresolved === 'true';
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
  const requests = await sosService.listSosRequests({ unresolvedOnly, limit });
  res.json({ status: 'success', data: { requests } });
}

export async function resolveSos(req: Request, res: Response) {
  const request = await sosService.resolveSosRequest(req.params.id as string, req.user!);
  if (!request) {
    res.status(404).json({ status: 'error', message: 'SOS request not found' });
    return;
  }
  res.json({ status: 'success', data: { request } });
}
