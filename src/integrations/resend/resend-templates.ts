interface TemplateVars {
  recipientName?: string;
  subject: string;
  headline: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  // Brand shown in the header/footer. Defaults to 'Stato' for internal
  // (team-facing) notifications; client-facing emails pass the client brand
  // (e.g. 'leadgeneration.io') so the portal invite matches the portal skin.
  brandName?: string;
  // Absolute URL to a brand logo image (PNG) shown in the header instead of the
  // text wordmark — avoids email clients auto-linking the "brand.tld" text.
  brandLogoUrl?: string;
  footerNote?: string;
}

// Statto brand palette — kept in sync with the portal theme (lime/ink).
const LIME = '#9FE870';
const INK = '#062F28';

export function renderEmailHtml(v: TemplateVars): string {
  const brand = escape(v.brandName ?? 'Stato');
  const footer = escape(
    v.footerNote ?? `${v.brandName ?? 'Stato'} - automated notification. Reply to this email to reach the team.`,
  );
  // Dark (ink) button with white text — high contrast in light AND dark mode,
  // and avoids the low-contrast white-on-lime combination.
  const cta = v.ctaLabel && v.ctaUrl
    ? `<a href="${escape(v.ctaUrl)}" style="display:inline-block;padding:14px 24px;background:${INK};color:#ffffff;text-decoration:none;border-radius:12px;font-size:15px;font-weight:600">${escape(v.ctaLabel)}</a>`
    : '';
  // Logo image when provided (avoids auto-linked text); else the text wordmark.
  const logoMark = v.brandLogoUrl
    ? `<img src="${escape(v.brandLogoUrl)}" alt="${brand}" height="30" style="display:block;height:30px;width:auto;border:0;outline:none;text-decoration:none">`
    : `<span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-.02em">${brand}</span>`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head>
<body style="margin:0;padding:0;background:#E7E7E9;font-family:'Poppins',-apple-system,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E7E7E9;padding:28px 16px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 20px rgba(6,47,40,.06)">
        <tr><td style="background-color:${INK};background-image:radial-gradient(circle at 92% -25%, rgba(199,245,156,0.65) 0%, rgba(199,245,156,0) 24%),radial-gradient(circle at 90% -20%, rgba(159,232,112,0.75) 0%, rgba(159,232,112,0) 46%),radial-gradient(circle at 2% 155%, rgba(132,212,81,0.5) 0%, rgba(132,212,81,0) 50%);padding:34px 28px">
          ${logoMark}
        </td></tr>
        <tr><td style="padding:32px 28px 4px">
          <h1 style="font-size:22px;line-height:1.3;margin:0 0 14px;color:${INK};font-weight:600;letter-spacing:-.01em">${escape(v.headline)}</h1>
          <div style="font-size:14.5px;line-height:1.65;color:#3a3a3a">${v.body}</div>
        </td></tr>
        ${cta ? `<tr><td style="padding:18px 28px 4px">${cta}</td></tr>` : ''}
        <tr><td style="padding:24px 28px 28px">
          <hr style="border:none;border-top:1px solid #ECECEE;margin:8px 0 16px">
          <p style="font-size:12px;color:#7B7B7B;margin:0;line-height:1.5">${footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function renderEmailText(v: TemplateVars): string {
  const cta = v.ctaLabel && v.ctaUrl ? `\n\n${v.ctaLabel}: ${v.ctaUrl}` : '';
  const body = v.body.replace(/<[^>]+>/g, '');
  return `${v.headline}\n\n${body}${cta}\n\n--\n${v.brandName ?? 'Stato'}`;
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
  passwordReset: (vars: { code: string; minutes: number; brandName?: string; brandLogoUrl?: string }) => ({
    subject: `Your ${vars.brandName ?? 'Stato'} password reset code`,
    headline: `Password reset code`,
    brandName: vars.brandName,
    brandLogoUrl: vars.brandLogoUrl,
    body: `<p>Use this code to reset your ${escape(vars.brandName ?? 'Stato')} password:</p>`
      + `<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:18px 0;font-family:monospace">${escape(vars.code)}</p>`
      + `<p>This code is valid for ${vars.minutes} minutes. If you didn't request a password reset, you can safely ignore this email and your password won't change.</p>`,
  }),

  // Portal client onboarding invite. Client-facing, so it carries the client
  // brand (brandName) rather than 'Stato'. The CTA deep-links to
  // /login?welcome=1 where the FE pre-opens the set-password flow.
  portalWelcome: (vars: { name?: string; email: string; loginUrl: string; brandName: string; brandLogoUrl?: string }) => ({
    subject: `Welcome to your ${vars.brandName} client portal`,
    headline: `Welcome${vars.name ? `, ${vars.name}` : ''}`,
    brandName: vars.brandName,
    brandLogoUrl: vars.brandLogoUrl,
    footerNote: `You're receiving this because a ${vars.brandName} portal account was created for you. If you weren't expecting this, you can ignore this email.`,
    body:
      `<p>Your client portal is ready. Sign in to track lead delivery, invoices, ad creatives, compliance, and your service agreement, all in one place.</p>`
      + `<p style="margin:18px 0 6px;color:#7B7B7B;font-size:13px">Your sign-in email</p>`
      + `<p style="margin:0 0 4px"><span style="display:inline-block;background:#F1FCE7;color:#062F28;font-weight:600;padding:8px 14px;border-radius:10px;font-size:14.5px">${escape(vars.email)}</span></p>`
      + `<p style="margin-top:18px">Click below to set your password and sign in for the first time.</p>`,
    ctaLabel: 'Set your password & sign in',
    ctaUrl: vars.loginUrl,
  }),
};
