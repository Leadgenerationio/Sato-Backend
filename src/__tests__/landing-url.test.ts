import { describe, it, expect } from 'vitest';
import { normaliseLandingUrl } from '../utils/landing-url.js';

describe('normaliseLandingUrl', () => {
  it('strips tracking params, fragment, trailing slash and lower-cases the host', () => {
    expect(normaliseLandingUrl('https://Offers.Example.COM/hearing/?utm_source=fb&utm_campaign=x&fbclid=abc#top'))
      .toBe('https://offers.example.com/hearing');
  });
  it('treats two ads with different tracking as the same page', () => {
    const a = normaliseLandingUrl('https://lp.example.com/ch?gclid=1&utm_medium=cpc');
    const b = normaliseLandingUrl('https://lp.example.com/ch/?msclkid=2&ttclid=3');
    expect(a).toBe(b);
  });
  it('keeps (and sorts) params that can change the page', () => {
    expect(normaliseLandingUrl('https://lp.example.com/p?variant=b&lang=de&utm_id=9'))
      .toBe('https://lp.example.com/p?lang=de&variant=b');
  });
  it('adds https when the scheme is missing and drops default ports', () => {
    expect(normaliseLandingUrl('lp.example.com:443/')).toBe('https://lp.example.com');
    expect(normaliseLandingUrl('http://lp.example.com:80/a')).toBe('http://lp.example.com/a');
  });
  it('keeps the path case (paths can be case-sensitive)', () => {
    expect(normaliseLandingUrl('https://lp.example.com/Offer-A')).toBe('https://lp.example.com/Offer-A');
  });
});
