import { Request, Response, NextFunction } from 'express';
import * as portalService from '../services/portal.service.js';
import * as approvalService from '../services/creative-approval.service.js';

function handlePortalError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof Error && err.name === 'PortalAccessError') {
    res.status(403).json({ status: 'error', message: err.message });
    return;
  }
  if (err instanceof Error && err.name === 'PortalValidationError') {
    res.status(400).json({ status: 'error', message: err.message });
    return;
  }
  if (err instanceof approvalService.CreativeApprovalError) {
    const statusByCode: Record<string, number> = {
      NOT_FOUND: 404,
      ACCESS_DENIED: 403,
      FEEDBACK_REQUIRED: 400,
    };
    res.status(statusByCode[err.code] ?? 400).json({ status: 'error', message: err.message });
    return;
  }
  next(err);
}

export async function dashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await portalService.getDashboard(req.user!);
    res.json({ status: 'success', data });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function campaigns(req: Request, res: Response, next: NextFunction) {
  try {
    const campaigns = await portalService.getCampaigns(req.user!);
    res.json({ status: 'success', data: { campaigns } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function leads(req: Request, res: Response, next: NextFunction) {
  try {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const range = portalService.resolveLeadsRange({ from, to });
    const leads = await portalService.getLeads(req.user!, range);
    res.json({ status: 'success', data: { leads, range } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function invoices(req: Request, res: Response, next: NextFunction) {
  try {
    const invoices = await portalService.getInvoices(req.user!);
    res.json({ status: 'success', data: { invoices } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function compliance(req: Request, res: Response, next: NextFunction) {
  try {
    const compliance = await portalService.getCompliance(req.user!);
    res.json({ status: 'success', data: { compliance } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function agreement(req: Request, res: Response, next: NextFunction) {
  try {
    const agreement = await portalService.getAgreement(req.user!);
    res.json({ status: 'success', data: { agreement } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function updateAgreementStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { status } = (req.body ?? {}) as { status?: unknown };
    if (typeof status !== 'string') {
      res.status(400).json({ status: 'error', message: 'Body must include a string "status".' });
      return;
    }
    const result = await portalService.updateAgreementStatus(req.user!, status);
    res.json({ status: 'success', data: result });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

// ─── Asset approval (Roadmap C — solicitor compliance) ───
//
// Client signs in to portal, sees pending creatives, approves or rejects.
// Decision row carries IP + UA + user-id + timestamp for legal evidence.

function captureRequestMetadata(req: Request): { ipAddress: string | null; userAgent: string | null } {
  // Behind Railway's proxy. Express's req.ip respects X-Forwarded-For when
  // app.set('trust proxy', true) is enabled (it is — see index.ts).
  const ipAddress = req.ip ?? null;
  const userAgent = req.get('user-agent') ?? null;
  return { ipAddress, userAgent };
}

async function handleDecision(
  req: Request,
  res: Response,
  next: NextFunction,
  action: 'approved' | 'rejected' | 'changes_requested',
) {
  try {
    const requester = req.user!;
    if (!requester.clientId) {
      res.status(403).json({ status: 'error', message: 'Portal access requires a client user' });
      return;
    }
    const creativeId = req.params.creativeId as string | undefined;
    if (!creativeId) {
      res.status(400).json({ status: 'error', message: 'creativeId is required' });
      return;
    }

    await approvalService.assertCreativeBelongsToClient(creativeId, requester.clientId);

    const feedbackRaw = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : null;
    const { ipAddress, userAgent } = captureRequestMetadata(req);

    const event = await approvalService.recordDecision({
      creativeId,
      decidedByUserId: requester.userId,
      action,
      ipAddress,
      userAgent,
      feedback: feedbackRaw && feedbackRaw.length > 0 ? feedbackRaw : null,
    });

    res.json({ status: 'success', data: { event } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

export async function approveCreative(req: Request, res: Response, next: NextFunction) {
  return handleDecision(req, res, next, 'approved');
}

export async function rejectCreative(req: Request, res: Response, next: NextFunction) {
  return handleDecision(req, res, next, 'rejected');
}

export async function requestChangesCreative(req: Request, res: Response, next: NextFunction) {
  return handleDecision(req, res, next, 'changes_requested');
}

/**
 * Creative review v2 list endpoint — returns the buyer's pending + decided
 * creatives split into 2 cards (`media` vs `copy_lp`). The portal /creatives
 * tab renders these side-by-side and the buyer signs off each card
 * independently.
 */
export async function creatives(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await portalService.getCreativesBySection(req.user!);
    res.json({ status: 'success', data });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}
