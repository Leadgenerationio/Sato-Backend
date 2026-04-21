export type DeliveryWindow =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'ytd';

/** LeadByte date presets per the REST API v1.3 docs. */
export type LeadBytePreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_7d'
  | 'lastweek'
  | 'last_30d'
  | 'this_month'
  | 'last_month';

/** Basic campaign payload from `GET /campaigns`. */
export interface LeadByteCampaignRaw {
  id: number | string;
  name: string;
  reference?: string;
  description?: string;
  currency?: string;
  country?: string;
  sms_field?: string;
  active?: 'Yes' | 'No' | boolean;
  sup_visible?: 'Yes' | 'No' | boolean;
  archived?: 'Yes' | 'No' | boolean;
}

/** Normalised campaign shape used across Sato (enriched with our own client/vertical/pricing). */
export interface LeadByteCampaign {
  id: string;
  name: string;
  reference?: string;
  /** Populated from Sato clients table, not LeadByte. */
  clientId: string;
  clientName: string;
  /** Populated from Sato campaign metadata, not LeadByte. */
  vertical: string;
  status: 'active' | 'paused' | 'inactive';
  /** Populated from Sato agreement/lead-price config, not LeadByte `/campaigns` endpoint. */
  leadPrice: number;
  currency: string;
  startDate: string;
}

/** One row from `GET /reports/leadactivity` (groupBy=day). */
export interface LeadByteLeadActivityRow {
  campaign: string;
  date: string;
  count: number;
}

/** One row from `GET /reports/campaign`. */
export interface LeadByteCampaignReportRow {
  campaign: string;
  leads: number;
  valid: number;
  invalid: number;
  pending: number;
  rejections: number;
  payable: number;
  sold: number;
  returns: number;
  payout: number;
  emailCost?: number;
  smsCost?: number;
  validationCost?: number;
  revenue: number;
  profit: number;
  currency: string;
}

/** Derived per-day delivery report. Sam doesn't want invalid splits — we keep fields for back-compat but invalidLeads = 0. */
export interface LeadByteDeliveryReport {
  campaignId: string;
  date: string;
  leadCount: number;
  /** @deprecated Sam confirmed he does not need invalid splits — always equals leadCount. */
  validLeads: number;
  /** @deprecated Sam confirmed he does not need invalid splits — always 0. */
  invalidLeads: number;
  revenue: number;
  cost: number;
  reportId: string;
}

/** One row from `GET /reports/supplier` (groupBy=campaign, showSupplier=Yes). */
export interface LeadByteSupplierReportRow {
  campaign: string;
  supplier: string;
  leads: number;
  valid: number;
  invalid: number;
  validCR?: number;
  pending: number;
  rejected: number;
  payable: number;
  sold: number;
  returns: number;
  payableCR?: number;
  /** Amount paid to the supplier — this is Sam's "spend per source". */
  payout: number;
  emailCost?: number;
  smsCost?: number;
  validationCost?: number;
  /** Revenue from the buyer side. */
  revenue: number;
  profit: number;
  eCPL?: number;
  eRPL?: number;
  currency: string;
}

/** Supplier list shape (synthesised from the supplier report — LeadByte has no standalone /suppliers endpoint). */
export interface LeadByteSupplier {
  id: string;
  name: string;
  platform: string;
  accountId: string;
  campaignId: string;
  totalSpend: number;
  totalLeads: number;
}

/** Normalised per-supplier spend used by our reporting UI. */
export interface LeadByteSupplierSpend {
  supplierId: string;
  supplierName: string;
  platform: string;
  campaignId: string;
  campaignName: string;
  window: DeliveryWindow;
  /** Equals LeadByte `payout`. */
  spend: number;
  leads: number;
  /** Effective cost per lead. */
  cpl: number;
}

export interface LeadByteCampaignField {
  name: string;
  label: string;
  dataType: string;
  required: boolean;
  selection?: string[];
}

export interface LeadByteCampaignDetail extends LeadByteCampaignRaw {
  fields: LeadByteCampaignField[];
}

export interface LeadByteLeadDetail {
  id: string | number;
  received?: string;
  campaign?: { id: string | number; name: string; reference?: string };
  supplier?: { id: string | number; name: string };
  payout?: number;
  revenue?: number;
  history?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface LeadByteLeadUpdateItem {
  id: number | string;
  quarantineId?: number | string;
  triggerDeliveryId?: number | string;
  triggerDeliveryIds?: Array<number | string>;
  action?: 'process' | 'reject' | 'reprocess';
  update?: Record<string, unknown>;
}

export interface LeadByteSearch {
  campaignId?: number | string;
  campaignIds?: Array<number | string>;
  email?: string;
  phone?: string;
  emailAddresses?: string[];
  phoneNumbers?: string[];
}

export interface LeadByteFeedbackInput {
  leads: Array<number | string>;
  BID: string;
  feedback: string;
  notes?: string;
  overwrite?: 'Yes' | 'No';
}

export interface LeadByteInternalFeedbackInput {
  leads: Array<number | string>;
  feedback: string;
  notes?: string;
  overwrite?: 'Yes' | 'No';
}

export interface LeadByteAssignBuyerInput {
  leadId?: number | string;
  leadIds?: Array<number | string>;
  deliveryId: number | string;
  triggerActions?: string;
  updateActions?: string;
}

export interface LeadBytePingInput {
  lead?: Record<string, unknown>;
  leads?: Array<Record<string, unknown>>;
  callback_url: string;
}

export interface LeadByteDelivery {
  id: number | string;
  reference?: string;
  status?: 'Active' | 'Inactive' | 'Saved';
  campaign?: { id: string | number; name: string };
  deliver_to?: 'Store Lead' | 'Email' | 'SMS' | 'Direct Post';
  buyer?: { id: string | number; name: string; bid?: string };
  [key: string]: unknown;
}

export interface LeadByteDeliveryCreateInput {
  campaign_code: string;
  delivery_type: 'Store Lead' | 'Email' | 'SMS' | 'Direct Post';
  delivery_name: string;
  revenue: number | string;
  bid: string;
  credit_amount?: number | string;
  sms_recipient?: string;
  email_recipient?: string;
  rules?: Record<string, unknown>;
  create_buyer?: 'Yes' | 'No';
  company?: string;
  [key: string]: unknown;
}

export interface LeadByteDeliveryUpdate {
  status?: 'Active' | 'Inactive';
  revenue?: number;
  caps?: { day?: number; week?: number; month?: number; total?: number };
  [key: string]: unknown;
}

export interface LeadByteResponderPush {
  push_id: number | string;
  name: string;
  type?: string;
  advertiser?: string;
  marketing_category?: string;
  sent?: number;
  delivered?: number;
  clicks?: number;
  conversions?: number;
  cost?: number;
  revenue?: number;
  profit?: number;
  currency?: string;
  active?: boolean;
}

export interface LeadByteResponder {
  id: number | string;
  reference?: string;
  status?: string;
  campaign?: { id: string | number; name: string };
  supplier?: { id: string | number; name: string };
  pause_from?: string;
  pause_to?: string;
  pushes?: LeadByteResponderPush[];
  rules?: Record<string, unknown>;
}

export interface LeadByteQueueItem {
  queueRef: string;
  status: 'Pending' | 'Processed' | 'Not Found';
  processed?: string;
  response?: {
    code?: string;
    response?: string;
    info?: string;
    leadId?: string | number;
    rejectionId?: string | number;
    processTime?: number;
    timestamp?: string;
  };
}

export interface LeadByteLeadFinancialsInput {
  leads: Array<number | string>;
  newPayout?: number;
  newRevenue?: number;
  BID?: string;
}

export interface LeadByteMessagingReportRow {
  campaign: string;
  responder?: string;
  supplier?: string;
  push?: string;
  advertiser?: string;
  sent: number;
  delivered: number;
  opened?: number;
  clicks: number;
  conversions: number;
  bounced?: number;
  unsubscribed?: number;
  cost: number;
  revenue: number;
  profit: number;
  currency: string;
}

export interface LeadByteBuyerReportRow {
  campaign: string;
  buyer: string;
  posted: number;
  accepted: number;
  sold: number;
  rejected: number;
  approvedCR?: number;
  returned: number;
  returnedPercent?: number;
  revenue: number;
  RPL?: number;
  RPS?: number;
  currency: string;
}

export interface LeadByteCreditInput {
  BID: string;
  amount: number | string;
  invoice?: string;
}

export interface LeadByteBuyer {
  id?: number | string;
  company: string;
  bid?: string;
  street1?: string;
  towncity?: string;
  county?: string;
  country?: string;
  postcode?: string;
  phone?: string;
  external_ref?: string;
  external_ref_2?: string;
  status?: 'Active' | 'Inactive';
  credit_amount?: number;
  credit_balance?: number;
}

export interface LeadByteBuyerCreateInput {
  company: string;
  bid?: string;
  street1?: string;
  towncity?: string;
  county?: string;
  postcode?: string;
  country_name?: string;
  phone?: string;
  external_ref?: string;
  external_ref_2?: string;
  external_ref_3?: string;
  external_ref_4?: string;
  external_ref_5?: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  autologin?: 'Yes' | 'No';
  create_delivery?: 'Yes' | 'No';
  campaign_code?: string;
  delivery_type?: 'Store Lead' | 'Email' | 'SMS';
  delivery_name?: string;
  sms_recipient?: string;
  email_recipient?: string;
  rules?: Record<string, unknown>;
  credit_amount?: number;
  revenue?: number;
}

export interface LeadByteBuyerCaps {
  day?: number;
  week?: number;
  month?: number;
  total?: number;
}

export interface LeadByteBuyerUpdate {
  status?: 'Active' | 'Inactive';
  caps?: LeadByteBuyerCaps;
}

export interface LeadByteQuarantineInput {
  quarantineId?: number | string;
  quarantineIds?: Array<number | string>;
  action: 'process' | 'reject';
}
