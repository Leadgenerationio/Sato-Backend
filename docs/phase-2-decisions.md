# Phase 2 — Post Go-Live Decisions

Captured from the credentials handover (2026-04-17). **Nothing here is built yet** — this is a log of confirmed product direction so Phase 2 planning has a starting point.

---

## Confirmed scope

| Area | Decision | Source |
|---|---|---|
| Chrome extension for tasks | **YES — build it** | Handover §Phase 2 |
| AI provider | **Claude (Anthropic)** | Handover §Phase 2 |
| Meeting tool | **Google Meet** | Handover §Phase 2 |
| WhatsApp Business for AI Bot | **YES** — Sam to create account pre-Phase 2 | Handover §Phase 2 |
| Advanced reporting | **Catchr MCP** at `https://api.catchr.io/mcp` | Handover §1 |

## Access already granted

- Catchr MCP system access → sent to `pratteek.s@octogle.com`
- Leadreports.io → invite to `pratteek.s@octogle.com`

## Credentials slot — not yet provided

- Anthropic API key (Claude) — pending, get from `console.anthropic.com` when Phase 2 starts
- Loom API key — pending, get from `loom.com` developer settings
- WhatsApp Business account — Sam to create before Phase 2 kickoff

---

## Deferred items (Phase 2 planning session)

From the handover, items agreed to handle in a dedicated session after go-live:

- Export of existing SOPs and task templates from current SopFlow
- List of daily task types used by the team
- Staff list (Name, Role, Department, Start Date)
- Recruitment stages (Apply → Assess → Interview → Offer)
- HR templates (contracts, NDAs, payslips)
- Holiday policy document
- SOPs, help docs, and training materials for AI Bot
- Lead location data for wastage analysis
- Business cost spreadsheet (rent, salaries, tools, tax)
- Campaign caps from LeadByte

---

## Implementation notes for when Phase 2 kicks off

- **Chrome extension** — Manifest V3, talks to `POST /api/v1/tasks` via the existing admin API. Auth via session cookie or PAT.
- **Claude AI bot** — integrate via Anthropic SDK. Context: SOPs + tasks + notifications feeds from the existing DB. Use prompt caching (1-hour) to keep SOP context cheap.
- **Google Meet** — `meet.google.com/new` links embedded in task detail + calendar invites via Google Calendar API.
- **WhatsApp Business** — Meta Cloud API. Pairs with AI bot for client comms.
- **Catchr MCP** — advanced reporting layer on top of our existing `/reports/*` endpoints. Use MCP client SDK; authenticate with the token sent to Pratteek.

None of this is scheduled yet — kickoff after Phase 1 go-live.
