import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import type { AuthPayload } from '../types/index.js';

export type CampaignType = 'pay_per_lead' | 'managed' | 'internal';

/**
 * Sato-side metadata not tracked by LeadByte. Drives the Pay-Per-Lead /
 * Managed / Internal filter on the campaigns list (matches Leadreports.io).
 */
const CAMPAIGN_TYPE_BY_ID: Record<string, CampaignType> = {
  'lb-1': 'pay_per_lead',
  'lb-2': 'pay_per_lead',
  'lb-3': 'pay_per_lead',
  'lb-4': 'managed',
  'lb-5': 'pay_per_lead',
  'lb-6': 'pay_per_lead',
  'lb-7': 'internal',
  'lb-8': 'pay_per_lead',
};

function resolveCampaignType(id: string): CampaignType {
  return CAMPAIGN_TYPE_BY_ID[id] ?? 'pay_per_lead';
}

export interface CampaignSummary {
  id: string;
  name: string;
  clientName: string;
  vertical: string;
  status: string;
  campaignType: CampaignType;
  leadPrice: number;
  currency: string;
  totalLeads: number;
  leadsToday: number;
  leadsThisWeek: number;
  leadsThisMonth: number;
  totalRevenue: number;
  totalCost: number;
  cpl: number;
  margin: number;
  startDate: string;
}

export interface CampaignDetail extends CampaignSummary {
  leadDeliveries: {
    date: string;
    leadCount: number;
    validLeads: number;
    invalidLeads: number;
    revenue: number;
    cost: number;
  }[];
  suppliers: {
    id: string;
    name: string;
    platform: string;
    totalSpend: number;
    totalLeads: number;
    cpl: number;
  }[];
}

export async function listCampaigns(_requester: AuthPayload): Promise<CampaignSummary[]> {
  const campaigns = await leadbyte.getCampaigns();

  const summaries: CampaignSummary[] = [];

  for (const c of campaigns) {
    const deliveries = await leadbyte.getDeliveryReports(c.id, 30);

    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    const leadsToday = deliveries.filter((d) => d.date === today).reduce((sum, d) => sum + d.leadCount, 0);
    const leadsThisWeek = deliveries.filter((d) => d.date >= weekAgo).reduce((sum, d) => sum + d.leadCount, 0);
    const leadsThisMonth = deliveries.filter((d) => d.date >= monthAgo).reduce((sum, d) => sum + d.leadCount, 0);
    const totalLeads = deliveries.reduce((sum, d) => sum + d.leadCount, 0);
    const totalRevenue = deliveries.reduce((sum, d) => sum + d.revenue, 0);
    const totalCost = deliveries.reduce((sum, d) => sum + d.cost, 0);
    const cpl = totalLeads > 0 ? totalCost / totalLeads : 0;
    const margin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;

    summaries.push({
      id: c.id,
      name: c.name,
      clientName: c.clientName,
      vertical: c.vertical,
      status: c.status,
      campaignType: resolveCampaignType(c.id),
      leadPrice: c.leadPrice,
      currency: c.currency,
      totalLeads,
      leadsToday,
      leadsThisWeek,
      leadsThisMonth,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      cpl: Math.round(cpl * 100) / 100,
      margin: Math.round(margin * 10) / 10,
      startDate: c.startDate,
    });
  }

  return summaries;
}

export async function getCampaign(id: string, _requester: AuthPayload): Promise<CampaignDetail | null> {
  const campaigns = await leadbyte.getCampaigns();
  const campaign = campaigns.find((c) => c.id === id);
  if (!campaign) return null;

  const deliveries = await leadbyte.getDeliveryReports(id, 30);
  const suppliers = await leadbyte.getSuppliers(id);

  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const leadsToday = deliveries.filter((d) => d.date === today).reduce((sum, d) => sum + d.leadCount, 0);
  const leadsThisWeek = deliveries.filter((d) => d.date >= weekAgo).reduce((sum, d) => sum + d.leadCount, 0);
  const leadsThisMonth = deliveries.filter((d) => d.date >= monthAgo).reduce((sum, d) => sum + d.leadCount, 0);
  const totalLeads = deliveries.reduce((sum, d) => sum + d.leadCount, 0);
  const totalRevenue = deliveries.reduce((sum, d) => sum + d.revenue, 0);
  const totalCost = deliveries.reduce((sum, d) => sum + d.cost, 0);
  const cpl = totalLeads > 0 ? totalCost / totalLeads : 0;
  const margin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;

  return {
    id: campaign.id,
    name: campaign.name,
    clientName: campaign.clientName,
    vertical: campaign.vertical,
    status: campaign.status,
    campaignType: resolveCampaignType(campaign.id),
    leadPrice: campaign.leadPrice,
    currency: campaign.currency,
    totalLeads,
    leadsToday,
    leadsThisWeek,
    leadsThisMonth,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    cpl: Math.round(cpl * 100) / 100,
    margin: Math.round(margin * 10) / 10,
    startDate: campaign.startDate,
    leadDeliveries: deliveries.map((d) => ({
      date: d.date,
      leadCount: d.leadCount,
      validLeads: d.validLeads,
      invalidLeads: d.invalidLeads,
      revenue: d.revenue,
      cost: d.cost,
    })),
    suppliers: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      platform: s.platform,
      totalSpend: s.totalSpend,
      totalLeads: s.totalLeads,
      cpl: s.totalLeads > 0 ? Math.round((s.totalSpend / s.totalLeads) * 100) / 100 : 0,
    })),
  };
}
