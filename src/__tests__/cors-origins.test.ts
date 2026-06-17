import { describe, it, expect } from 'vitest';
import { isFirstPartyStatoOrigin, isOriginAllowed } from '../utils/cors-origins.js';

// First-party = the product's own portal domains. Every business gets a
// {business}.stato.tech subdomain (see multi-business plan), so the whole
// stato.tech family is trusted without needing a CORS_ORIGINS edit per business.
describe('isFirstPartyStatoOrigin', () => {
  it('allows an https stato.tech subdomain (the per-business portal)', () => {
    expect(isFirstPartyStatoOrigin('https://leadgenerationio.stato.tech')).toBe(true);
  });

  it('allows the apex stato.tech over https', () => {
    expect(isFirstPartyStatoOrigin('https://stato.tech')).toBe(true);
  });

  it('rejects http (non-TLS) stato.tech', () => {
    expect(isFirstPartyStatoOrigin('http://leadgenerationio.stato.tech')).toBe(false);
  });

  it('rejects look-alike domains that merely contain "stato.tech"', () => {
    expect(isFirstPartyStatoOrigin('https://evil-stato.tech')).toBe(false);
    expect(isFirstPartyStatoOrigin('https://stato.tech.evil.com')).toBe(false);
  });

  it('rejects garbage that is not a URL', () => {
    expect(isFirstPartyStatoOrigin('not-a-url')).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  const configured = ['https://sato-frontend.vercel.app'];

  it('allows a no-origin request (server-to-server / curl / health checks)', () => {
    expect(isOriginAllowed(undefined, configured)).toBe(true);
  });

  it('allows an explicitly configured origin', () => {
    expect(isOriginAllowed('https://sato-frontend.vercel.app', configured)).toBe(true);
  });

  it('allows a first-party stato.tech origin even when not in the configured list', () => {
    expect(isOriginAllowed('https://leadgenerationio.stato.tech', [])).toBe(true);
  });

  it('rejects an unknown third-party origin', () => {
    expect(isOriginAllowed('https://random-site.com', configured)).toBe(false);
  });
});
