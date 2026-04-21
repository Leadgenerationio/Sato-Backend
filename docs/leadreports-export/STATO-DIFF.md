# Leadreports.io vs Stato — Feature Gap Analysis

Compares every Leadreports feature Sam uses today against what Stato currently ships. Drives our go-live punch list.

Legend: ✅ parity · 🟡 partial · 🔴 missing · 🆕 Stato has, Leadreports doesn't

---

## Dashboard KPIs (top row)

| Leadreports KPI | Stato equivalent | Status |
|---|---|---|
| Total Revenue | Dashboard revenue card + `/reports/financial` | ✅ |
| Total Cost | Dashboard has revenue/expenses chart | 🟡 need explicit "Total Cost" card |
| Net Profit | Revenue overview chart implies profit | 🟡 need explicit "Net Profit" card |
| Valid Leads (count) | Dashboard "Leads This Month" (6,133) | ✅ |
| Profit Margin % | Not shown on dashboard | 🔴 add margin % card |
| "vs last period" delta per KPI | Delta arrows on some cards | 🟡 not on every card — add consistently |

## Dashboard window tabs

| Leadreports | Stato campaign detail | Stato dashboard | Status |
|---|---|---|---|
| Live (realtime) | Today tab | static | 🔴 dashboard has no window tabs |
| Yesterday | ✅ Yesterday tab | static | 🔴 dashboard missing |
| This Month | ✅ This Month tab | static | 🔴 dashboard missing |
| Last Month | ✅ Last Month tab | static | 🔴 dashboard missing |
| Custom date range | Custom window + date picker | none | 🔴 both places missing "Custom" |

**Action:** Stato dashboard should expose the same 5 tabs (Live / Yesterday / This Month / Last Month / Custom) over the main KPI row.

## Campaign-type filter

| Leadreports option | Stato equivalent |
|---|---|
| Pay-Per-Lead | ✅ (status in our schema) |
| Managed | 🔴 not in schema |
| Pay-Per-Lead & Managed | 🔴 not in filter UI |
| Internal | 🔴 not in schema (Sam has 2 "Internal" campaigns: Solar Panels UK, Property Sales UK) |
| All Campaigns | ✅ default |

**Action:** Add `campaign_type` column to `db/schema/campaigns.ts` with values `pay_per_lead / managed / internal`. Filter dropdown on `/campaigns` list.

## Campaign table columns

| Leadreports | Stato `/reports/campaign` | Status |
|---|---|---|
| Campaign/Source | Campaign name + source count | 🟡 we show only campaign name — add source count badge |
| Data Quality | badge | 🔴 (Sam confirmed he doesn't need invalid splits — skip) |
| Revenue | ✅ | ✅ |
| Cost | ✅ | ✅ |
| Profit | ✅ | ✅ |
| Leads | ✅ | ✅ |
| CPL | ✅ | ✅ |
| Margin % | ✅ (colour-coded) | ✅ |

## Campaigns page — list view

| Leadreports field | Stato `/campaigns` | Status |
|---|---|---|
| Campaign name | ✅ | ✅ |
| **LeadByte ID** | not stored | 🔴 add `leadbyteId` to schema |
| Campaign type (PPL / Managed / Internal) | not shown | 🔴 |
| Created date | ✅ | ✅ |
| Traffic source count | not shown | 🔴 add source count |
| Click-to-expand traffic source list | not available | 🔴 add expansion panel |
| "Add Campaign" button | ✅ (our Create flow) | ✅ |

## Campaign detail page

| Leadreports (`Edit Campaign`) | Stato campaign detail | Status |
|---|---|---|
| Editable campaign name | read-only + separate edit | 🟡 inline edit would be nicer |
| Campaign Type selector with explanation | no selector | 🔴 |
| LeadByte ID display | ❌ not shown | 🔴 |
| Traffic Sources count | ❌ | 🔴 |
| Traffic sources table (Platform + Catchr URL + Actions) | ❌ entirely missing | 🔴 **biggest gap** |
| "Add Traffic Source" button | ❌ | 🔴 |
| Platform dropdown (Google/Taboola/Facebook/TikTok/Thank You Page Lead…) | ❌ | 🔴 |

**Action:** Stato needs a new `traffic_sources` table:
```sql
traffic_sources (
  id uuid pk,
  campaign_id uuid fk,
  name varchar,               -- e.g. "google-Lasting Power of Attorney (UK)"
  platform varchar,           -- Google / Facebook / Taboola / TikTok / Thank You Page Lead
  catchr_url text,            -- https://api.catchr.io/api/request?format=json&platform=...
  created_at, updated_at
)
```
Plus a `traffic_sources` UI card on campaign detail matching Leadreports' layout.

## Users page

| Leadreports | Stato `/users` | Status |
|---|---|---|
| Name + email + role | ✅ | ✅ |
| Role options: User / Admin / Platform Admin | Owner / Finance Admin / Ops Manager / Client / Readonly | 🟡 different taxonomy — confirm with Sam which model wins |
| Filter / search | ✅ | ✅ |
| "Add Member" invite flow | ✅ (we have create-user) | ✅ |
| Profile avatars | ✅ | ✅ |

## Data pipeline — cost source

**🔴 Biggest architectural gap:**

Leadreports pulls **ad spend per traffic source** from **Catchr** (`https://api.catchr.io/api/request?format=json&platform=...`).

Stato currently pulls spend from LeadByte's `/reports/supplier` (`payout` field). That **might** match Sam's expectations (he confirmed "supplier spend per source = Yes" on LeadByte), but Leadreports shows he actually wires **Catchr URLs per source per campaign** for real spend data.

**Decision needed from Sam:** is the LeadByte `payout` field what he uses for spend, or does it only reflect internal payouts and the real Ad Spend number comes from Catchr?

If Catchr is the source of truth → we need a Catchr integration in Stato for Phase 1, not Phase 2 like previously planned.

---

## Gap summary — prioritised

### 🔴 Phase-1 blockers (matching Leadreports feature set)

1. **Traffic sources per campaign** — new table + UI (campaign detail expansion + list view source count)
2. **Campaign type field** (PPL / Managed / Internal) — schema + filter dropdown
3. **LeadByte ID display** on campaign list + detail
4. **Dashboard window tabs** (Live / Yesterday / This Month / Last Month / Custom) on the main KPI row
5. **Net Profit + Total Cost + Profit Margin cards** on dashboard
6. **Cost source decision** — Catchr vs LeadByte payout

### 🟡 Nice-to-have

7. "vs last period" delta on every KPI card
8. Data quality badge (Sam says no, but worth a stub for future)
9. Inline-edit on campaign detail
10. Custom date range picker on campaign detail + dashboard

### 🆕 Stato has that Leadreports doesn't (keep)

- Full portal for clients
- Invoices + Xero sync
- DocuSign agreements
- Workflows / SOPs / Tasks
- Resend notifications + email templates
- R2 file storage
- Credit checks (Creditsafe/Endole)

## Next actions when back from the break

1. Send `STATO-DIFF.md` to Sam for review — confirm the 🔴 items match his priorities
2. Ask Sam directly: **"is your Ad Spend number from LeadByte's payout field, or from Catchr?"**
3. If Catchr → elevate Catchr integration from Phase 2 to Phase 1
4. Add `traffic_sources` table + campaign-type enum to schema → migration
5. Add the 3 missing dashboard cards + window tabs
