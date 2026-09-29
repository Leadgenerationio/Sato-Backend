# Stato API Reference

**Base URL:** `http://localhost:3001/api/v1`

All responses follow the envelope format:

```json
{ "status": "success", "data": { ... } }
{ "status": "error", "message": "..." }
```

---

## Authentication

All endpoints (except login/register/refresh) require a JWT Bearer token in the `Authorization` header:

```
Authorization: Bearer <accessToken>
```

Tokens are issued on login and can be refreshed using the refresh endpoint. Access tokens are short-lived; refresh tokens are long-lived.

### Rate Limiting

Auth endpoints (`/api/v1/auth/*`) are rate-limited. Exceeding the limit returns `429 Too Many Requests`.

---

## Pagination

List endpoints support pagination via query parameters:

| Param  | Type   | Default | Max | Description            |
|--------|--------|---------|-----|------------------------|
| `page` | number | 1       | --  | Page number (1-based)  |
| `limit`| number | 10      | 100 | Items per page         |

Paginated responses include:

```json
{ "total": 42, "page": 1, "pageSize": 10 }
```

---

## Roles

| Role            | Description                              |
|-----------------|------------------------------------------|
| `owner`         | Full access to everything                |
| `finance_admin` | Invoices, clients, reports               |
| `ops_manager`   | Campaigns, clients, workflows            |
| `client`        | Client portal only                       |
| `readonly`      | View-only (notifications only by default)|

---

## Auth

### POST /auth/register

Create a new user account.

**Roles:** Public (no auth required)

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "securepass",
  "name": "Jane Doe",
  "role": "finance_admin"
}
```

| Field      | Type   | Required | Notes                                                    |
|------------|--------|----------|----------------------------------------------------------|
| `email`    | string | Yes      | Must be valid email                                      |
| `password` | string | Yes      | Min 6 characters                                         |
| `name`     | string | Yes      | 1-255 characters                                         |
| `role`     | string | No       | `owner`, `finance_admin`, `ops_manager`, `readonly`. Defaults to `readonly` |

**Response (201):**

```json
{
  "status": "success",
  "data": {
    "user": { "id": "...", "email": "...", "name": "...", "role": "..." },
    "tokens": { "accessToken": "...", "refreshToken": "..." }
  }
}
```

### POST /auth/login

Authenticate and receive tokens.

**Roles:** Public

**Request body:**

```json
{
  "email": "owner@stato.app",
  "password": "password123"
}
```

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "user": { "id": "...", "email": "...", "name": "...", "role": "owner" },
    "tokens": { "accessToken": "...", "refreshToken": "..." }
  }
}
```

### POST /auth/refresh

Exchange a refresh token for new access + refresh tokens.

**Roles:** Public

**Request body:**

```json
{ "refreshToken": "..." }
```

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "tokens": { "accessToken": "...", "refreshToken": "..." }
  }
}
```

### GET /auth/me

Get the currently authenticated user.

**Roles:** Any authenticated user

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "...",
      "email": "...",
      "name": "...",
      "role": "owner",
      "businessId": "...",
      "clientId": null,
      "isActive": true
    }
  }
}
```

---

## Users

All user management endpoints require the `owner` role.

### GET /users

List all users in the business.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "users": [
      { "id": "...", "email": "...", "name": "...", "role": "finance_admin", "isActive": true }
    ]
  }
}
```

### POST /users

Create a new user.

**Request body:**

```json
{
  "email": "may@stato.app",
  "name": "May",
  "password": "securepass",
  "role": "finance_admin"
}
```

**Response (201):** Returns the created user object.

### PUT /users/:id

Update a user's name and role.

**Request body:**

```json
{ "name": "May Updated", "role": "finance_admin" }
```

**Response (200):** Returns the updated user object.

### PATCH /users/:id/role

Update only a user's role.

**Request body:**

```json
{ "role": "ops_manager" }
```

**Response (200):** Returns the updated user object.

### PATCH /users/:id/toggle-active

Enable or disable a user account (toggles `isActive`).

**Response (200):** Returns the updated user object.

---

## Permissions

### GET /permissions

List all permission entries.

**Roles:** Any authenticated user

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "permissions": [
      { "permission": "invoices.create", "role": "finance_admin", "allowed": true }
    ]
  }
}
```

### PATCH /permissions

Update a single permission entry.

**Roles:** `owner`

**Request body:**

```json
{
  "permission": "invoices.create",
  "role": "finance_admin",
  "allowed": false
}
```

**Response (200):** Returns the updated permission entry.

---

## Campaigns

All campaign endpoints require `owner` or `ops_manager` role.

### GET /campaigns

List campaigns with optional filtering and pagination.

**Query parameters:**

| Param    | Type   | Description                           |
|----------|--------|---------------------------------------|
| `status` | string | Filter by status (e.g. `active`, `paused`). Use `all` for no filter |
| `vertical` | string | Filter by vertical (e.g. `solar`, `insurance`) |
| `search` | string | Search campaign name or client name   |
| `page`   | number | Page number                           |
| `limit`  | number | Items per page                        |

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "campaigns": [
      {
        "id": "...",
        "name": "Solar PV Leads",
        "clientName": "GreenEnergy Ltd",
        "vertical": "Solar",
        "status": "active",
        "leadPrice": "12.50",
        "totalLeadsDelivered": 450,
        "totalRevenue": "5625.00"
      }
    ],
    "total": 15,
    "page": 1,
    "pageSize": 10
  }
}
```

### GET /campaigns/:id

Get full details of a single campaign.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "campaign": { "id": "...", "name": "...", ... }
  }
}
```

**Response (404):** `{ "status": "error", "message": "Campaign not found" }`

---

## Invoices

All invoice endpoints require `owner` or `finance_admin` role.

### GET /invoices

List invoices with optional filtering and pagination.

**Query parameters:**

| Param    | Type   | Description                              |
|----------|--------|------------------------------------------|
| `status` | string | Filter by status (`draft`, `sent`, `paid`, `overdue`). `all` = no filter |
| `client` | string | Filter by client ID                      |
| `search` | string | Search by invoice number or client name  |
| `page`   | number | Page number                              |
| `limit`  | number | Items per page                           |

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "invoices": [
      {
        "id": "...",
        "invoiceNumber": "INV-1001",
        "clientId": "...",
        "clientName": "Acme Ltd",
        "status": "sent",
        "currency": "GBP",
        "subtotal": 1250.00,
        "vatAmount": 250.00,
        "total": 1500.00,
        "dueDate": "2026-04-30",
        "daysOverdue": 0
      }
    ],
    "total": 30,
    "page": 1,
    "pageSize": 10
  }
}
```

### GET /invoices/:id

Get full invoice details including line items.

**Response (200):** Returns the full invoice object with `lineItems` array.

### GET /invoices/overdue

Get all overdue invoices.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "invoices": [ ... ]
  }
}
```

### GET /invoices/clients

Get a lightweight list of clients for the invoice creation dropdown.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "clients": [
      { "id": "...", "name": "Acme Ltd", "email": "..." }
    ]
  }
}
```

### POST /invoices

Create a new invoice.

**Request body:**

```json
{
  "clientId": "c-1",
  "currency": "GBP",
  "addVat": true,
  "lineItems": [
    {
      "description": "Solar PV Leads - Week 15",
      "quantity": 120,
      "unitPrice": 12.50,
      "amount": 1500.00
    }
  ]
}
```

| Field       | Type     | Required | Notes                              |
|-------------|----------|----------|------------------------------------|
| `clientId`  | string   | Yes      | UUID of the client                 |
| `currency`  | string   | Yes      | ISO 4217 code (e.g. `GBP`, `USD`) |
| `addVat`    | boolean  | Yes      | Whether to add 20% VAT            |
| `lineItems` | array    | Yes      | At least one line item             |

Each line item:

| Field         | Type   | Required | Notes                  |
|---------------|--------|----------|------------------------|
| `description` | string | Yes      | What this line is for  |
| `quantity`    | number | Yes      | Number of units        |
| `unitPrice`   | number | Yes      | Price per unit         |
| `amount`      | number | Yes      | Total for this line    |

**Response (201):** Returns the created invoice object.

---

## Clients

All client endpoints require `owner`, `finance_admin`, or `ops_manager` role.

### GET /clients

List clients with optional filtering and pagination.

**Query parameters:**

| Param    | Type   | Description                                    |
|----------|--------|------------------------------------------------|
| `status` | string | Filter by status (`prospect`, `active`, `paused`, `churned`). `all` = no filter |
| `search` | string | Search by company name, contact name, or email |
| `page`   | number | Page number                                    |
| `limit`  | number | Items per page                                 |

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "clients": [
      {
        "id": "...",
        "companyName": "Acme Ltd",
        "contactName": "John Smith",
        "contactEmail": "john@acme.com",
        "status": "active",
        "currency": "GBP",
        "creditScore": 72
      }
    ],
    "total": 8,
    "page": 1,
    "pageSize": 10
  }
}
```

### GET /clients/:id

Get full client details.

**Response (200):** Returns the complete client object including all fields.

### POST /clients

Create a new client.

**Request body:**

```json
{
  "companyName": "NewCo Ltd",
  "companyNumber": "12345678",
  "contactName": "Jane Doe",
  "contactEmail": "jane@newco.com",
  "contactPhone": "+44 7700 900000",
  "address": "123 Business St, London",
  "currency": "GBP",
  "paymentTermsDays": 30,
  "vatRegistered": true,
  "addVatToInvoices": true,
  "leadPrice": 15.00,
  "billingWorkflow": "weekly_auto"
}
```

| Field               | Type    | Required | Notes                                         |
|---------------------|---------|----------|-----------------------------------------------|
| `companyName`       | string  | Yes      | Company legal name                            |
| `companyNumber`     | string  | No       | Companies House number                        |
| `contactName`       | string  | No       | Primary contact                               |
| `contactEmail`      | string  | No       | Primary contact email                         |
| `contactPhone`      | string  | No       | Phone number                                  |
| `address`           | string  | No       | Full address                                  |
| `currency`          | string  | No       | Default `GBP`                                 |
| `paymentTermsDays`  | number  | No       | Default `30`                                  |
| `vatRegistered`     | boolean | No       | Default `false`                               |
| `addVatToInvoices`  | boolean | No       | Default `false`                               |
| `leadPrice`         | number  | No       | Price per lead                                |
| `billingWorkflow`   | string  | No       | `weekly_auto`, `monthly_validated`, `custom`  |

**Response (201):** Returns the created client object.

### PUT /clients/:id

Update an existing client. Accepts the same fields as POST.

**Response (200):** Returns the updated client object.

**Response (404):** `{ "status": "error", "message": "Client not found" }`

### GET /clients/:id/credit-history

Get the credit check history for a client.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "history": [
      {
        "id": "...",
        "creditScore": 72,
        "creditLimit": "50000.00",
        "riskRating": "low",
        "previousScore": 68,
        "scoreChange": 4,
        "alertTriggered": false,
        "checkedAt": "2026-04-10T08:00:00Z"
      }
    ]
  }
}
```

### POST /clients/:id/credit-check

Run a new credit check for a client (via Endole integration).

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "creditCheck": {
      "creditScore": 75,
      "creditLimit": "50000.00",
      "riskRating": "low",
      "previousScore": 72,
      "scoreChange": 3,
      "alertTriggered": false,
      "checkedAt": "2026-04-15T10:00:00Z"
    }
  }
}
```

### GET /clients/credit-alerts

Get all clients with active credit alerts (score drops or high risk).

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "alerts": [ ... ]
  }
}
```

---

## Portal (Client-Facing)

All portal endpoints require the `client` role. Data is scoped to the authenticated client's account.

### GET /portal/dashboard

Get the client's dashboard summary.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "activeCampaigns": 2,
    "leadsThisMonth": 340,
    "outstandingBalance": 4500.00,
    "complianceScore": 95
  }
}
```

### GET /portal/campaigns

Get the client's campaigns.

**Response (200):** Returns `{ "campaigns": [...] }`

### GET /portal/leads

Get the client's lead deliveries.

**Response (200):** Returns `{ "leads": [...] }`

### GET /portal/invoices

Get the client's invoices.

**Response (200):** Returns `{ "invoices": [...] }`

### GET /portal/compliance

Get the client's compliance status.

**Response (200):** Returns `{ "compliance": {...} }`

### GET /portal/agreement

Get the client's service agreement.

**Response (200):** Returns `{ "agreement": {...} }`

---

## Ad accounts

Which client (and optionally which campaign) owns each ad account. Accounts are matched on `platform` + `accountId` only, never on the account name. `platform` accepts any common spelling (`Facebook`, `meta`, `facebook-ads`) and is stored in canonical form (`facebook-ads`, `google-ads`, `tik-tok`, `taboola`, `bing-ads`).

### GET /ad-accounts

**Roles:** owner, ops_manager, finance_admin. **Query:** `days` (1–365, default 30).

Every known ad account, plus the client and campaign options for the linking screen (campaigns by Sato UUID). Known accounts: accounts with Catchr spend in the window, accounts referenced by a campaign's Ad Account Links, and accounts already linked. Spend is deduplicated across Catchr authorization ids. Unlinked accounts come first, largest spend first. `totalSpend`/`unlinkedSpend` add across currencies; display `unlinkedSpendByCurrency` instead.

```json
{
  "status": "success",
  "data": {
    "windowDays": 30,
    "accounts": [
      {
        "platform": "facebook-ads", "platformLabel": "Facebook",
        "accountId": "428353095282383", "accountName": "CH Hearing",
        "currency": "GBP", "spend": 14527.53, "lastSpendDate": "2026-09-28",
        "link": null,
        "campaigns": [{ "campaignId": "…", "campaignName": "Hearing Aids (CH)" }]
      }
    ],
    "options": {
      "clients": [{ "id": "…", "companyName": "…", "status": "active", "currency": "EUR" }],
      "campaigns": [{ "id": "…", "name": "Hearing Aids (CH)", "status": "active" }]
    },
    "summary": { "total": 40, "linked": 3, "unlinked": 37, "totalSpend": 612000.1, "unlinkedSpend": 586065.73, "unlinkedSpendByCurrency": { "GBP": 540000.0, "EUR": 46065.73 } }
  }
}
```

### PUT /ad-accounts/links

**Roles:** owner, ops_manager. Create, change or remove up to 500 links in one transaction. `clientId: null` removes a link. An unknown client or campaign id rejects the whole batch (400) and nothing is written.

```json
{ "links": [
  { "platform": "facebook", "accountId": "428353095282383", "clientId": "…", "campaignId": "…" },
  { "platform": "taboola", "accountId": "…willwriting-sc", "clientId": null }
] }
```

**Response (200):** `{ "created": 1, "updated": 0, "removed": 1, "unchanged": 0, "results": [{ "platform", "accountId", "action", "clientName", "campaignName" }] }`

### GET /clients/lookup

**Roles:** owner, ops_manager, finance_admin. **Query:** `platform`, `accountId` (both required).

The client that owns an ad account. 404 when the account isn't linked.

```json
{ "status": "success", "data": {
  "platform": "facebook-ads", "accountId": "428353095282383",
  "client": { "id": "…", "companyName": "…", "currency": "CHF" },
  "campaign": { "id": "…", "name": "Hearing Aids (CH)" }
} }
```

### Scheduled Meta / Taboola creative sync (plan phase 3)

Every `PLATFORM_SYNC_EVERY_HOURS` hours (default 3) a sync job pulls the ads of every linked **Meta** (`facebook-ads`) and **Taboola** ad account and files each creative under the client that owns the account, plus its campaign if one is set. The client always comes from the link above and is never guessed from a name. Each creative goes through the creative library's `upsertPlatformCreative()`, which copies the media into storage. Platform CDN links expire, so they are never kept as the file URL.

- **Meta:** `GET /act_{id}/ads` with the creative fields and `updated_since`, following `paging.next`. Video sources come from `/{video_id}`, and image hashes (carousels, dynamic creative) from `/act_{id}/adimages`. Carousels and asset feeds give one creative per card/asset. The client backs off on throttling codes 4/17/32/613 and when `X-Business-Use-Case-Usage` is ≥ 90%.
- **Taboola:** OAuth client_credentials, then `GET /{account_id}/campaigns` and `/{account_id}/campaigns/{id}/items/` for campaigns that are not terminated. Items still being crawled or stopped are skipped.
- **No duplicates:** creatives are upserted on platform + creative id, so a second run updates rather than copies. The next Meta run asks only for ads updated since the last successful run, with 10 minutes of overlap. If any creative failed to save, the window is kept and retried.
- **Off until connected:** with neither platform's credentials set, the job logs once and does nothing. The job runs on a fixed 3-hour slot (BullMQ scheduler), so the first run lands within one interval of deploy, not at boot. Use **Sync now** for an immediate pull.

**Credentials needed from the account owner:**

| Platform | What | Env |
| --- | --- | --- |
| Meta | Business Manager **system user token** with `ads_read`, and the system user assigned to every ad account that is linked to a client | `META_SYSTEM_USER_TOKEN` (optional `META_GRAPH_VERSION`, default `v21.0`) |
| Taboola | **Backstage API client** (client_credentials) with access to each advertiser account | `TABOOLA_CLIENT_ID`, `TABOOLA_CLIENT_SECRET` |

### GET /ad-accounts/sync-status

**Roles:** owner, ops_manager, finance_admin.

Whether each platform is connected, and for every linked Meta/Taboola account: the last run, the last error, and what the last run found.

```json
{ "status": "success", "data": {
  "everyHours": 3,
  "platforms": { "meta": { "connected": true }, "taboola": { "connected": false } },
  "libraryInstalled": true,
  "accounts": [{
    "linkId": "…", "platform": "facebook-ads", "accountId": "428353095282383", "accountName": "CH Hearing",
    "clientId": "…", "clientName": "…",
    "lastRunAt": "2026-09-29T12:00:00.000Z", "lastSuccessAt": "2026-09-29T12:00:00.000Z", "lastError": null,
    "adsSeen": 14, "created": 3, "updated": 11, "failed": 0
  }]
} }
```

### POST /ad-accounts/:id/sync-now

**Roles:** owner, ops_manager. `:id` is the link id (`linkId` above).

Pulls that one account now. **202** `{ "queued": true }` when queued (repeat clicks don't stack). **200** with the run's result when there is no queue. **404** for an unknown link. **409** when that platform isn't connected yet. **422** for platforms other than Meta/Taboola.

---

## Workflows

All workflow endpoints require `owner` or `ops_manager` role.

### GET /workflows/step-types

Get available workflow step types for the builder.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "types": [
      { "type": "fetch_leads", "label": "Fetch Leads from LeadByte", ... },
      { "type": "create_invoice", "label": "Create Xero Invoice", ... }
    ]
  }
}
```

### GET /workflows

List all workflows.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "workflows": [
      {
        "id": "wf-1",
        "name": "Weekly Auto-Invoice",
        "description": "Every Monday 9 AM - pull leads, create invoice, send to client",
        "type": "scheduled",
        "schedule": "Every Monday 9:00 AM",
        "status": "active",
        "lastRunAt": "2026-04-14T09:00:00Z",
        "nextRunAt": "2026-04-21T09:00:00Z",
        "totalRuns": 28,
        "successRate": 96
      }
    ]
  }
}
```

### POST /workflows

Create a new workflow.

**Request body:**

```json
{
  "name": "Monthly Report",
  "description": "Generate and send monthly financial report",
  "type": "scheduled",
  "schedule": "1st of month 9:00 AM",
  "steps": [
    {
      "name": "Generate Report",
      "type": "generate_report",
      "config": "{\"reportType\": \"financial_overview\"}"
    },
    {
      "name": "Send Email",
      "type": "send_email",
      "config": "{\"to\": \"sam@leadgeneration.io\"}"
    }
  ]
}
```

| Field         | Type   | Required | Notes                                     |
|---------------|--------|----------|-------------------------------------------|
| `name`        | string | Yes      | Workflow name                             |
| `description` | string | Yes      | What this workflow does                   |
| `type`        | string | Yes      | `scheduled`, `trigger`, or `manual`       |
| `schedule`    | string | No       | Human-readable schedule (for scheduled type) |
| `steps`       | array  | Yes      | Ordered list of workflow steps            |

**Response (201):** Returns the created workflow object.

### GET /workflows/:id

Get full workflow details including steps and recent executions.

**Response (200):** Returns the workflow with `steps` and `recentExecutions` arrays.

### PUT /workflows/:id

Update an existing workflow. Accepts the same fields as POST.

**Response (200):** Returns the updated workflow object.

### POST /workflows/:id/toggle-status

Toggle a workflow between `active` and `paused` (or `draft` to `active`).

**Response (200):** Returns the updated workflow object.

### POST /workflows/:id/execute

Manually execute a workflow immediately.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "execution": {
      "id": "...",
      "workflowId": "wf-1",
      "status": "completed",
      "currentStep": 3,
      "stepResults": [...],
      "startedAt": "2026-04-15T10:00:00Z",
      "completedAt": "2026-04-15T10:00:05Z"
    }
  }
}
```

---

## Reports

All report endpoints require `owner` or `finance_admin` role.

### GET /reports/campaign-performance

Campaign-level performance metrics (leads delivered, revenue, cost per lead).

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "report": { ... }
  }
}
```

### GET /reports/client-pnl

Profit and loss breakdown per client.

**Response (200):** Returns `{ "report": { ... } }`

### GET /reports/supplier-performance

Supplier/traffic source performance metrics.

**Response (200):** Returns `{ "report": { ... } }`

### GET /reports/financial-overview

High-level financial overview (total revenue, outstanding, cash flow).

**Response (200):** Returns `{ "report": { ... } }`

---

## Notifications

Notification endpoints are available to any authenticated user. Notifications are scoped to the authenticated user.

### GET /notifications

List notifications for the current user.

**Query parameters:**

| Param    | Type   | Description                       |
|----------|--------|-----------------------------------|
| `filter` | string | `unread` to show only unread      |
| `page`   | number | Page number (default 1)           |
| `limit`  | number | Items per page (default 20, max 100) |

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "notifications": [
      {
        "id": "...",
        "type": "invoice_overdue",
        "title": "Invoice INV-1042 is overdue",
        "message": "Acme Ltd invoice is 7 days overdue",
        "severity": "warning",
        "read": false,
        "actionUrl": "/invoices/inv-1042",
        "createdAt": "2026-04-15T08:00:00Z"
      }
    ],
    "total": 12,
    "page": 1,
    "pageSize": 20
  }
}
```

### PUT /notifications/:id/read

Mark a single notification as read.

**Response (200):** Returns the updated notification object.

**Response (404):** `{ "status": "error", "message": "Notification not found" }`

### PUT /notifications/read-all

Mark all notifications as read for the current user.

**Response (200):**

```json
{
  "status": "success",
  "data": { "updated": 5 }
}
```

---

## Integrations

All integration endpoints require the `owner` role.

### GET /integrations/xero/auth-url

Get the Xero OAuth2 authorization URL to start the connection flow.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "url": "https://login.xero.com/identity/connect/authorize?..."
  }
}
```

**Response (503):** `{ "status": "error", "message": "Xero credentials not configured" }`

### GET /integrations/xero/callback

OAuth2 callback endpoint. Called by Xero after user authorizes. Redirects to frontend settings page with `?xero=connected`.

**Query parameters:** `code` (authorization code from Xero)

### GET /integrations/xero/status

Check current Xero connection status.

**Response (200):**

```json
{
  "status": "success",
  "data": {
    "connected": true,
    "configured": true,
    "tenantName": "LeadGeneration Ltd",
    "connectedAt": "2026-04-01T10:00:00Z"
  }
}
```

### POST /integrations/xero/disconnect

Disconnect the Xero integration.

**Response (200):**

```json
{
  "status": "success",
  "data": { "connected": false }
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "status": "error",
  "message": "Description of what went wrong"
}
```

Common HTTP status codes:

| Code | Meaning                                      |
|------|----------------------------------------------|
| 400  | Bad request (validation failed, missing data) |
| 401  | Unauthorized (missing or invalid token)       |
| 403  | Forbidden (insufficient role)                 |
| 404  | Resource not found                            |
| 429  | Rate limited (auth endpoints)                 |
| 503  | Service unavailable (integration not configured) |

---

## Database Schema (Reference)

Key tables for reference:

| Table                  | Key Fields                                                      |
|------------------------|-----------------------------------------------------------------|
| `businesses`           | id, name, slug, colour, status                                  |
| `users`                | id, email, name, role, businessId, clientId, isActive           |
| `clients`              | id, companyName, companyNumber, contactName, contactEmail, status, creditScore, leadPrice, billingWorkflow |
| `campaigns`            | id, clientId, name, vertical, status, leadPrice, totalLeadsDelivered, totalRevenue |
| `invoices`             | id, clientId, invoiceNumber, status, currency, subtotal, vatAmount, total, dueDate, lineItems |
| `workflows`            | id, name, trigger, steps, status                                |
| `workflow_executions`  | id, workflowId, status, currentStep, stepResults                |
| `notifications`        | id, userId, type, title, message, severity, read                |
| `credit_checks`        | id, clientId, creditScore, creditLimit, riskRating, scoreChange |
| `lead_deliveries`      | id, campaignId, delivery data                                   |
| `xero_tokens`          | id, businessId, OAuth token data                                |
| `bank_accounts`        | id, account details                                             |
| `traffic_sources`      | id, source details                                              |
| `landing_pages`        | id, page details                                                |
| `creatives`            | id, creative details                                            |
| `agreements`           | id, clientId, agreement details                                 |
| `chase_history`        | id, invoiceId, chase details                                    |
