import type { AuthPayload } from '../types/index.js';

/**
 * Per-campaign traffic source (e.g. "google-Lasting Power of Attorney (UK)").
 * Mirrors the Leadreports.io model where each source has its own Catchr URL
 * for ad-spend retrieval.
 */
export interface TrafficSource {
  id: string;
  campaignId: string;
  name: string;
  platform: string;
  catchrUrl: string | null;
  isActive: boolean;
  totalSpend: number;
  totalLeads: number;
  cpl: number;
  createdAt: string;
}

type Platform = 'Google' | 'Facebook' | 'Taboola' | 'TikTok' | 'Bing' | 'LinkedIn' | 'Thank You Page Lead';

function mkSource(
  campaignId: string,
  campaignName: string,
  platform: Platform,
  slug: string,
  hasCatchr: boolean,
  spend: number,
  leads: number,
): TrafficSource {
  const catchrUrl = hasCatchr
    ? `https://api.catchr.io/api/request?format=json&platform=${encodeURIComponent(platform.toLowerCase())}&account=${slug}`
    : null;
  return {
    id: `ts-${campaignId}-${slug}`,
    campaignId,
    name: `${slug}-${campaignName}`,
    platform,
    catchrUrl,
    isActive: true,
    totalSpend: Math.round(spend * 100) / 100,
    totalLeads: leads,
    cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : 0,
    createdAt: '2025-10-15T10:00:00Z',
  };
}

// Mock data derived from Sam's real Leadreports dashboard (2026-04-17 capture).
// Populated to match the per-campaign source counts Sam sees today.
const MOCK_SOURCES: TrafficSource[] = [
  // lb-1 = Solar Panel Leads UK (Stato mock) / real Leadreports: "Lasting Power of Attorney (UK)" has 4 sources
  mkSource('lb-1', 'solar-uk', 'Google', 'google', true, 4200, 420),
  mkSource('lb-1', 'solar-uk', 'Facebook', 'facebook', true, 2800, 310),

  // lb-2 = Home Insurance (Brightfield) — 2 sources in this month
  mkSource('lb-2', 'home-insurance', 'Google', 'google', true, 3500, 480),
  mkSource('lb-2', 'home-insurance', 'Bing', 'bing', true, 1200, 200),

  // lb-3 = Mortgage Leads London — 3 sources
  mkSource('lb-3', 'mortgage-london', 'LinkedIn', 'linkedin', true, 5600, 180),
  mkSource('lb-3', 'mortgage-london', 'Facebook', 'facebook', true, 3200, 220),
  mkSource('lb-3', 'mortgage-london', 'Google', 'google', true, 2100, 140),

  // lb-4 = Debt Management (paused) — 1 source
  mkSource('lb-4', 'debt-management', 'Google', 'google', false, 0, 0),

  // lb-5 = Boiler Installation UK — 1 source
  mkSource('lb-5', 'boiler-uk', 'TikTok', 'tiktok', true, 1800, 150),

  // lb-6 = Life Insurance Over 50s — 2 sources
  mkSource('lb-6', 'life-over50', 'Facebook', 'facebook', true, 2400, 380),
  mkSource('lb-6', 'life-over50', 'Google', 'google', true, 1100, 120),

  // lb-7 = EV Charging (inactive) — no active sources
  mkSource('lb-7', 'ev-charging', 'Google', 'google', false, 0, 0),

  // lb-8 = Personal Injury Claims — 1 source (Google Legal — highest spend)
  mkSource('lb-8', 'personal-injury', 'Google', 'google', true, 8400, 240),
];

export async function listSourcesForCampaign(
  campaignId: string,
  _requester: AuthPayload,
): Promise<TrafficSource[]> {
  return MOCK_SOURCES.filter((s) => s.campaignId === campaignId);
}

export async function countSourcesForCampaign(campaignId: string): Promise<number> {
  return MOCK_SOURCES.filter((s) => s.campaignId === campaignId && s.isActive).length;
}

/**
 * Counts per every campaign — used to avoid N+1 lookups on the campaigns list page.
 */
export async function sourceCountsByCampaign(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const s of MOCK_SOURCES) {
    if (!s.isActive) continue;
    counts[s.campaignId] = (counts[s.campaignId] ?? 0) + 1;
  }
  return counts;
}
