# Reply to Sam — Credentials Handover follow-up

**To:** Sam
**From:** Yash
**Subject:** Re: Stato Go-Live Credentials Handover — 3 blockers resolved

Hi Sam,

Thanks for the filled-in handover. Here are the three items you flagged for us:

---

## 1. Client-data template (§4)

Attached: `client-data-template.csv` (blank) and `client-data-example.csv` (3 sample rows so you can see the expected shape).

Columns:
`company_name, company_number, billing_email, contact_name, phone, address, vat_number, vat_registered, currency, payment_terms_days, default_lead_price, billing_workflow, status, notes`

- `vat_registered` → `Y` or `N`
- `currency` → 3-letter ISO (`GBP`, `EUR`, `USD`)
- `billing_workflow` → one of `weekly_auto`, `monthly_validated`, `custom`
- `status` → one of `prospect`, `onboarding`, `active`, `paused`, `churned`

Once you return the filled sheet we'll bulk-import it into the onboarding flow.

---

## 2. Endole API (§3) — recommended alternative

Endole's API is only on their Enterprise tier, which is likely more than you need. We recommend **Creditsafe** as the Phase 1 credit-check provider:

- REST API included on all paid tiers from ~£40/month
- UK + EU company coverage equivalent to Endole
- Same data we need: credit score, risk rating, CCJs, accounts filed, limit recommendation
- Trial available — you can self-serve at https://www.creditsafe.com

If you'd rather stick with Endole and upgrade the plan, tell us the new tier name and we'll confirm API availability. Default plan is to proceed with Creditsafe.

---

## 3. E-signature (§6) — Google eSign has no usable API

Confirmed with Google Workspace docs: Google eSignature is a UI feature inside Docs, with **no public API for programmatic envelope creation or status webhooks**. We cannot wire it into Stato.

Recommendation: **DocuSign**.
- Free developer sandbox for us to build against now (no cost until go-live)
- Standard plan from ~£10/user/month
- Full REST API + webhooks for signed/declined/completed events
- Signed PDFs auto-archived to R2 once we wire the webhook

Please confirm:
- [ ] "Proceed with DocuSign" — we'll set up the production account in your name and send you the admin invite
- [ ] "Pick a different provider" — PandaDoc and HelloSign are the next options; tell us your preference

---

## Still needed from you

Once you reply on these three, the remaining yellow rows you can fill are:

- Xero Client ID / Secret / Webhook Key (or invite `yash.c@octogle.com` to your Xero dev account)
- Cloudflare R2 credentials (Account ID, Access Key ID, Secret, bucket name)
- Resend API key (key named `Stato`) + verified sender domain
- Google Workspace admin email (for the eSign API check we already did — just for audit trail)
- Primary business bank name (so we verify Xero bank feed support)

No rush — we're unblocked on everything else and already building against local sandboxes. Aiming to have end-to-end DocuSign + R2 flows working in sandbox by end of week; you can then drop in real creds and it'll flip to production with no code change.

Thanks,
Yash
