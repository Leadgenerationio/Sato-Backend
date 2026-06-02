import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendEmail, isResendConfigured } from '../integrations/resend/resend-client.js';
import { renderEmailHtml, renderEmailText, templates } from '../integrations/resend/resend-templates.js';
import {
  isR2Configured,
  uploadFile,
  getSignedDownloadUrl,
  getSignedUploadUrl,
} from '../integrations/r2/r2-client.js';
// SignNow replaces DocuSign; see `signnow-client.test.ts` for the 17-test suite.
import { isCreditsafeConfigured, runCreditCheck as runCreditsafe } from '../integrations/creditsafe/creditsafe-client.js';
import { getActiveProvider, runCreditCheck as runCredit } from '../integrations/credit-check/index.js';

describe('Resend integration', () => {
  it('reports not configured when RESEND_API_KEY is empty', () => {
    delete process.env.RESEND_API_KEY;
    expect(isResendConfigured()).toBe(false);
  });

  it('returns a mock id and does not throw when unconfigured', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'Test',
      html: '<p>hi</p>',
    });
    expect(result.id).toMatch(/^mock-/);
  });

  it('renders template html with headline, body, and escaped CTA', () => {
    const html = renderEmailHtml({
      subject: 'x',
      headline: 'Hello & welcome',
      body: '<p>body text</p>',
      ctaLabel: 'Click <me>',
      ctaUrl: 'https://example.com/?a=1&b=2',
    });
    expect(html).toContain('Hello &amp; welcome');
    expect(html).toContain('Click &lt;me&gt;');
    expect(html).toContain('a=1&amp;b=2');
  });

  it('renders plain-text fallback without html tags', () => {
    const text = renderEmailText({
      subject: 'x',
      headline: 'Hi',
      body: '<p>Paragraph <strong>here</strong></p>',
    });
    expect(text).not.toContain('<p>');
    expect(text).toContain('Paragraph here');
  });

  it('exposes a template for each notification type', () => {
    expect(templates.invoiceOverdue({ clientName: 'Acme', invoiceNumber: 'INV-1', amount: '£100', daysOverdue: 5, invoiceUrl: 'https://x' }).subject).toContain('INV-1');
    expect(templates.paymentReceived({ clientName: 'Acme', invoiceNumber: 'INV-1', amount: '£100', method: 'bank' }).headline).toContain('Payment received');
    expect(templates.agreementSigned({ clientName: 'Acme', signedAt: '2026-04-17', agreementUrl: 'https://x' }).subject).toContain('Acme');
  });
});

describe('R2 integration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCOUNT_ID;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports not configured when credentials are missing', () => {
    expect(isR2Configured()).toBe(false);
  });

  it('mock upload returns a stable key shape without calling AWS SDK', async () => {
    const result = await uploadFile({
      folder: 'invoices',
      key: 'test.pdf',
      body: Buffer.from('%PDF'),
      contentType: 'application/pdf',
    });
    expect(result.key).toBe('invoices/test.pdf');
    expect(result.size).toBeGreaterThan(0);
  });

  it('mock signed download URL returns a public-style URL', async () => {
    const url = await getSignedDownloadUrl({ folder: 'agreements', key: 'abc.pdf' });
    expect(url).toContain('agreements/abc.pdf');
  });

  it('mock signed upload URL returns a mock:// scheme', async () => {
    const url = await getSignedUploadUrl({ folder: 'creatives', key: 'img.png', contentType: 'image/png' });
    expect(url.startsWith('mock://')).toBe(true);
  });

  it('strips leading slashes from key to prevent double prefixes', async () => {
    const result = await uploadFile({
      folder: 'invoices',
      key: '/leading-slash.pdf',
      body: 'x',
      contentType: 'application/pdf',
    });
    expect(result.key).toBe('invoices/leading-slash.pdf');
  });
});

describe('Creditsafe integration', () => {
  beforeEach(() => {
    delete process.env.CREDITSAFE_API_KEY;
  });

  it('reports not configured without credentials', () => {
    expect(isCreditsafeConfigured()).toBe(false);
  });

  // "No fabricated data" policy: an unconfigured provider must THROW rather
  // than return a made-up mock score. (The previous two tests asserted a mock
  // report's contents — that mock no longer exists, so they were stale.)
  it('throws "not configured" when unconfigured (no fabricated scores)', async () => {
    await expect(runCreditsafe('12345678', 'Acme Ltd')).rejects.toThrow(/not configured/i);
  });
});

describe('Credit-check provider router', () => {
  beforeEach(() => {
    delete process.env.CREDITSAFE_API_KEY;
    delete process.env.ENDOLE_APP_ID;
    delete process.env.ENDOLE_APP_KEY;
  });

  it('selects mock when neither provider is configured', () => {
    expect(getActiveProvider()).toBe('mock');
  });

  it('selects creditsafe when CREDITSAFE_API_KEY is set', () => {
    process.env.CREDITSAFE_API_KEY = 'token:test';
    expect(getActiveProvider()).toBe('creditsafe');
  });

  it('selects endole when both ENDOLE_APP_ID and ENDOLE_APP_KEY are set', () => {
    process.env.ENDOLE_APP_ID = '23013';
    process.env.ENDOLE_APP_KEY = 'test-key';
    expect(getActiveProvider()).toBe('endole');
  });

  it('creditsafe beats endole when both providers are configured', () => {
    process.env.CREDITSAFE_API_KEY = 'token:test';
    process.env.ENDOLE_APP_ID = '23013';
    process.env.ENDOLE_APP_KEY = 'test-key';
    expect(getActiveProvider()).toBe('creditsafe');
  });

  // 2026-05-05: removed the silent mock fallback. When neither provider is
  // configured, the router now throws CreditProviderNotConfiguredError so the
  // FE can show a clear "set up Endole/Creditsafe" message instead of
  // displaying a fabricated random score that looks real.
  it('throws CreditProviderNotConfiguredError when no provider is set', async () => {
    await expect(runCredit('87654321', 'Brightfield Corp')).rejects.toThrow(/not configured/i);
  });
});

// DocuSign integration tests were replaced by `signnow-client.test.ts` (17 cases)
// when we swapped providers. Nothing else to test here.
