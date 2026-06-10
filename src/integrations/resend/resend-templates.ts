interface TemplateVars {
  recipientName?: string;
  subject: string;
  headline: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

export function renderEmailHtml(v: TemplateVars): string {
  const cta = v.ctaLabel && v.ctaUrl
    ? `<a href="${escape(v.ctaUrl)}" style="display:inline-block;margin-top:16px;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-size:14px">${escape(v.ctaLabel)}</a>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h1 style="font-size:20px;margin:0 0 12px">${escape(v.headline)}</h1>
  <div style="font-size:14px;line-height:1.6;color:#333">${v.body}</div>
  ${cta}
  <hr style="margin:32px 0;border:none;border-top:1px solid #eee">
  <p style="font-size:12px;color:#888">Stato — automated notification. Reply to this email to reach the team.</p>
</body></html>`;
}

export function renderEmailText(v: TemplateVars): string {
  const cta = v.ctaLabel && v.ctaUrl ? `\n\n${v.ctaLabel}: ${v.ctaUrl}` : '';
  const body = v.body.replace(/<[^>]+>/g, '');
  return `${v.headline}\n\n${body}${cta}\n\n—\nStato`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export const templates = {
  invoiceOverdue: (vars: { clientName: string; invoiceNumber: string; amount: string; daysOverdue: number; invoiceUrl: string }) => ({
    subject: `Invoice ${vars.invoiceNumber} overdue`,
    headline: `Invoice ${vars.invoiceNumber} is ${vars.daysOverdue} days overdue`,
    body: `<p>${escape(vars.clientName)}'s invoice of ${escape(vars.amount)} is past due. Consider sending a chase.</p>`,
    ctaLabel: 'View invoice',
    ctaUrl: vars.invoiceUrl,
  }),

  paymentReceived: (vars: { clientName: string; invoiceNumber: string; amount: string; method: string }) => ({
    subject: `Payment received — ${vars.clientName}`,
    headline: `Payment received`,
    body: `<p>${escape(vars.clientName)} paid ${escape(vars.invoiceNumber)} (${escape(vars.amount)}) via ${escape(vars.method)}.</p>`,
  }),

  agreementSigned: (vars: { clientName: string; signedAt: string; agreementUrl: string }) => ({
    subject: `Agreement signed — ${vars.clientName}`,
    headline: `${vars.clientName} signed the service agreement`,
    body: `<p>Signed ${escape(vars.signedAt)}. The countersigned PDF is archived and linked below.</p>`,
    ctaLabel: 'View agreement',
    ctaUrl: vars.agreementUrl,
  }),

  creditAlert: (vars: { clientName: string; oldScore: number; newScore: number; riskRating: string }) => ({
    subject: `Credit score drop — ${vars.clientName}`,
    headline: `${vars.clientName} credit score changed`,
    body: `<p>Score moved from ${vars.oldScore} to ${vars.newScore}. Risk rating: <strong>${escape(vars.riskRating)}</strong>.</p>`,
  }),

  workflowComplete: (vars: { workflowName: string; summary: string; workflowUrl: string }) => ({
    subject: `Workflow complete — ${vars.workflowName}`,
    headline: `${vars.workflowName} finished`,
    body: `<p>${escape(vars.summary)}</p>`,
    ctaLabel: 'Open workflow',
    ctaUrl: vars.workflowUrl,
  }),

  vatShortfall: (vars: { period: string; shortfallAmount: string }) => ({
    subject: `VAT shortfall detected — ${vars.period}`,
    headline: `VAT shortfall of ${vars.shortfallAmount}`,
    body: `<p>Estimated VAT liability for ${escape(vars.period)} exceeds collected VAT. Review recommended.</p>`,
  }),

  leadDeliverySpike: (vars: { campaignName: string; leadCount: number; pctAboveAverage: number }) => ({
    subject: `Lead spike — ${vars.campaignName}`,
    headline: `${vars.campaignName} received ${vars.leadCount} leads today`,
    body: `<p>${vars.pctAboveAverage}% above daily average. Check cap and delivery throttles.</p>`,
  }),

  // Sam (2026-06-10): self-service forgot-password. The 6-digit code is the
  // whole payload — render it large and unmissable. No CTA link; the user
  // types the code back into the sign-in screen.
  passwordReset: (vars: { code: string; minutes: number }) => ({
    subject: `Your Stato password reset code`,
    headline: `Password reset code`,
    body: `<p>Use this code to reset your Stato password:</p>`
      + `<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:18px 0;font-family:monospace">${escape(vars.code)}</p>`
      + `<p>This code is valid for ${vars.minutes} minutes. If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>`,
  }),
};
