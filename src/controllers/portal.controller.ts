import { Request, Response, NextFunction } from 'express';
import * as portalService from '../services/portal.service.js';
import * as approvalService from '../services/creative-approval.service.js';
import { classifyXeroError } from '../utils/xero-errors.js';

function handlePortalError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof Error && err.name === 'PortalAccessError') {
    res.status(403).json({ status: 'error', message: err.message });
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
    // Sam (jam-video #3, 29-May-2026): per-source breakdown is now
    // preset-only with `bySourceWindow` indicating which preset (or none)
    // produced the rows. No more "est." flag — empty when the range
    // doesn't map to a LeadByte preset.
    const [leads, bySourceResult] = await Promise.all([
      portalService.getLeads(req.user!, range),
      portalService.getLeadsBySource(req.user!, range),
    ]);
    res.json({
      status: 'success',
      data: {
        leads,
        range,
        bySource: bySourceResult.rows,
        bySourceWindow: bySourceResult.window,
        validLeadsByCampaign: bySourceResult.validLeadsByCampaign,
      },
    });
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

export async function invoicePdf(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await portalService.getInvoicePdf(req.user!, req.params.id as string);
    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ status: 'error', code: 'not_found', message: 'Invoice not found' });
        return;
      }
      res.status(409).json({
        status: 'error',
        code: 'not_in_xero',
        message: 'This invoice is not available to download yet.',
      });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    // requireClientId access errors stay portal-style; the PDF is fetched live
    // from Xero, so classify upstream Xero failures (401/429/timeout/5xx) into a
    // structured code instead of letting them fall through to an opaque 500.
    if (err instanceof Error && err.name === 'PortalAccessError') {
      handlePortalError(err, res, next);
      return;
    }
    const classified = classifyXeroError(err);
    res.status(classified.httpStatus).json({ status: 'error', code: classified.code, message: classified.message });
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

/**
 * Issue a fresh 1-hour signed download URL for one creative the buyer is
 * allowed to open. Server picks the R2 folder from the stored file_url, so
 * legacy rows uploaded into misc/ open without the buyer's FE needing to
 * know that.
 */
export async function creativeSignedUrl(req: Request, res: Response, next: NextFunction) {
  try {
    const creativeId = req.params.creativeId as string | undefined;
    if (!creativeId) {
      res.status(400).json({ status: 'error', message: 'creativeId is required' });
      return;
    }
    const url = await portalService.getCreativeSignedUrlForPortal(creativeId, req.user!);
    if (!url) {
      res.status(404).json({ status: 'error', message: 'Creative not found' });
      return;
    }
    res.json({ status: 'success', data: { url } });
  } catch (err) {
    handlePortalError(err, res, next);
  }
}

// Sam (2026-05-27 jam-video #2): the client-side self-service controllers
// (listPortalUsers / createPortalUser / deletePortalUser /
// updatePortalUserPermissions / uploadExternalAgreement) have been removed
// — Sam manages portal users and agreement uploads from the admin side.
