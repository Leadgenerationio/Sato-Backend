# Stato MCP tools

<!-- Generated from the tool definitions by scripts/generate-mcp-docs.ts. Do not edit by hand. -->

22 tools. Every ID is a string. Every write tool takes an optional `idempotencyKey`. Errors come back with `isError: true` and a body with `code`, `message`, `hint`, `fields`, `retryable` and `requestId`.

| Tool | What it does | Scope | Kind | Inputs |
| --- | --- | --- | --- | --- |
| `add_landing_page` | Save a landing page URL for a client. | `landing_pages:write` | write | `clientId`, `url`; optional: `title`, `campaignId`; takes `idempotencyKey` |
| `archive_asset` | Hide an asset from the default lists. | `creatives:archive` | write (hides or removes, never deletes a file) | `creativeId`; optional: `reason`; takes `idempotencyKey` |
| `attach_landing_page` | Set the landing page of an asset, by landingPageId or by url (the page is saved for the asset's client if it is new). | `creatives:write` | write | `creativeId`; optional: `landingPageId`, `url`; takes `idempotencyKey` |
| `complete_upload` | Tell Stato the file is uploaded. | `uploads:write` | write | `uploadId`; optional: `parts`; takes `idempotencyKey` |
| `create_upload` | Start an upload for a file too big to send as a sourceUrl (images up to 30 MB, videos up to 4 GB). | `uploads:write` | write | `filename`, `contentType`, `sizeBytes`; optional: `sha256`; takes `idempotencyKey` |
| `find_asset_by_platform_id` | Check whether Stato already has an asset, before you upload or link, to avoid duplicates. | `creatives:read` | read only | optional: `platform`, `adId`, `platformCreativeId`, `platformAssetId`, `sha256` |
| `find_client_by_ad_account` | Which Stato client owns an ad account. | `clients:read` | read only | `platform`, `accountId` |
| `get_asset` | Full detail of one asset with a signed download link and its ad links. | `creatives:read` | read only | `creativeId`; optional: `downloadUrlMinutes` |
| `get_campaign` | One campaign with the clients that buy it, the ad accounts that feed it, and how many assets it has. | `campaigns:read` | read only | `campaignId` |
| `get_client` | One client with its ad accounts, the campaigns it buys, and how many assets and landing pages it has. | `clients:read` | read only | `clientId` |
| `link_ad_account` | Record which client (and optionally which campaign) an ad account belongs to. | `ad_accounts:write` | write | `clientId`, `platform`, `accountId`; optional: `campaignId`, `accountName`, `currency`, `confirmMove`; takes `idempotencyKey` |
| `link_ad_platform_ids` | Record that an asset in Stato runs in a platform ad, after you created the ad with your ad-platform tools. | `ad_links:write` | write | `creativeId`, `platform`, `accountId`; optional: `campaignId`, `platformCampaignId`, `platformCampaignName`, `campaignName`, `adsetId`, `adsetName`, `adId`, `adName`, `platformCreativeId`, `platformAssetId`, `landingPageUrl`, `status`; takes `idempotencyKey` |
| `list_ad_accounts` | Ad accounts with their last-30-day spend and what they are linked to. | `ad_accounts:read` | read only | optional: `platform`, `clientId`, `campaignId`, `linked`, `q`, `limit`, `cursor` |
| `list_assets` | Search the assets (images, videos, copy) in Stato. | `creatives:read` | read only | optional: `clientId`, `campaignId`, `platform`, `platformAccountId`, `platformAdId`, `landingPageId`, `mediaType`, `approvalStatus`, `hasAdLink`, `q`, `from`, `to`, `includeArchived`, `sort`, `limit`, `cursor` |
| `list_campaigns` | List or search campaigns, optionally only those one client buys (clientId). | `campaigns:read` | read only | optional: `clientId`, `status`, `vertical`, `q`, `limit`, `cursor` |
| `list_clients` | List or search the clients in this business. | `clients:read` | read only | optional: `q`, `status`, `limit`, `cursor` |
| `list_landing_pages` | List the saved landing pages for a client or campaign, with how many assets use each. | `creatives:read` | read only | optional: `clientId`, `campaignId`, `q`, `includeArchived` |
| `restore_asset` | Bring an archived asset back into the default lists, exactly as it was. | `creatives:archive` | write | `creativeId`; optional: `reason`; takes `idempotencyKey` |
| `unlink_ad_platform_ids` | Remove an ad link that was recorded by mistake. | `ad_links:write` | write (hides or removes, never deletes a file) | `adLinkId`; optional: `reason`; takes `idempotencyKey` |
| `update_asset` | Change an asset's name, headline, bodyText, tags (replaces the list) or campaign. | `creatives:write` | write | `creativeId`; optional: `name`, `headline`, `bodyText`, `tags`, `campaignId`, `clientId`, `confirmMove`; takes `idempotencyKey` |
| `upload_asset` | File an image, a video or a piece of ad copy under the right client and campaign. | `creatives:write` | write | optional: `mediaType`, `sourceUrl`, `uploadId`, `name`, `platform`, `platformAccountId`, `clientId`, `campaignId`, `headline`, `bodyText`, `landingPageUrl`, `tags`, `adLink`; takes `idempotencyKey` |
| `whoami` | Shows which API key, owner and business this connection is using, the scopes it holds, and the clients it is limited to (key.allowedClients; null means every client). | any key | read only | none |
