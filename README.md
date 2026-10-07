# Give Lively → Meta Conversions API (Cloudflare Worker)

Give Lively hosts its own checkout, so you can't put a Meta Pixel on it. This Worker
closes that gap: every few minutes it reads your event's **shareable ticket CSV link**
(or Give Lively's Zapier JSON feed), picks out paid **ticket sales for one event**, and sends
each order to Meta as a server-side **Purchase** event. Facebook and Instagram campaigns can
then optimize for, and report on, real ticket sales. It can also send donations to a
campaign as **Donate** events (`TRACK=donations` or `both`).

It replaces a Zapier Zap. It runs on the Cloudflare Workers free plan with a free D1
database, has no runtime dependencies, and you can set it up and run it entirely from a
phone using the Cloudflare dashboard.

- Plain donations and other events are ignored (unless you turn donations on).
- One order is one event: a 4-ticket order is one Purchase worth all 4 tickets.
- Each sale is sent exactly once, even when Give Lively shows the record again after an update.
- Email, name, phone and city/state/ZIP/country are SHA-256 hashed before they leave the
  Worker. Raw PII is never stored or logged.
- No secrets live in this repo. You enter them once in the Cloudflare dashboard.

## How it works

```
Cron (every 5 min) ─► fetch the CSV link (last 7 days) or JSON feed (since last run)
                   ─► keep paid tickets for EVENT_MATCH       (src/filter.ts)
                   ─► drop line items already sent            (D1)
                   ─► group by order, map + hash              (src/map.ts)
                   ─► one batched POST to Meta CAPI           (src/meta.ts)
                   ─► save sent IDs, advance cursor on success
```

If Meta or Give Lively fails, nothing is marked sent and the next run retries.

## Setup

You only do this once. Every later change is a GitHub commit, and Workers Builds deploys it.

### 1. Fork or copy this repo

If you're adapting this for your own organization, fork it. Nothing in it is specific
to one organization; your details all go into the dashboard.

### 2. Get your keys

| What | Where |
|---|---|
| **Event ticket CSV link** (recommended) | Give Lively Nonprofit Admin Portal → your event → ticketing reports → the shareable CSV ("dataclip") link. It ends in `/dataclips/<id>.csv`. |
| *or* **Give Lively org ID and API key** | Admin Portal → Integrations → Zapier → create an API key. Note: this JSON feed is behind Give Lively's bot protection and may be blocked from Cloudflare (see [Troubleshooting](#troubleshooting)). |
| **Meta Pixel (dataset) ID** | Meta Events Manager → Data sources → your pixel → the ID under its name. |
| **Meta access token** | Events Manager → your pixel → Settings → Conversions API → *Generate access token*. |
| **Admin token** | Any long random string. Generate one in your password manager and save it there. |

### 3. Connect the repo in Workers Builds

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Pick this GitHub repo.
3. **Project name: `givelively-facebook-pixel`**. It should match `"name"` in `wrangler.jsonc`
   (edit that file if you pick a different name).
4. Leave the build command empty. Keep the deploy command `npx wrangler deploy`.
5. **Save and Deploy**.

The first deploy creates the D1 database automatically. You don't need to create it
yourself or paste an ID anywhere (see [Troubleshooting](#troubleshooting) if it fails).

### 4. Add variables and secrets

Worker → **Settings** → **Variables and Secrets** → **Add**. Each one is entered once and
kept across deploys.

**Secrets** (choose type *Secret*):

| Name | Value |
|---|---|
| `GL_CSV_URL` | The event's shareable CSV link. **Treat it as a password**: anyone with it can download your attendee list. |
| `GL_API_KEY` | Only if using the JSON feed instead: Give Lively Zapier API key |
| `META_ACCESS_TOKEN` | Meta Conversions API token |
| `ADMIN_TOKEN` | Your admin token |

**Variables** (type *Text*):

| Name | Value | Needed for |
|---|---|---|
| `EVENT_PAGE_URL` | Public ticket page URL (the CSV has no page URL; Meta wants one) | Sending |
| `EVENT_MATCH` | JSON feed: text in the page name, slug or URL, e.g. `art-soup-2026-tickets`. CSV: optional, since the link is for one event | Sending (JSON) |
| `GL_ORG_ID` | Only for the JSON feed: Give Lively org ID | Reading (JSON) |
| `META_PIXEL_ID` | Pixel/dataset ID | Sending |
| `META_TEST_EVENT_CODE` | From Events Manager → Test events. Delete it to go live. | Testing |
| `SEND_TO_META` | `true` to start sending. Leave it unset until testing. | Sending |

Optional:

| Name | Default | Purpose |
|---|---|---|
| `TRACK` | `tickets` | `tickets` (Purchase), `donations` (Donate) or `both` |
| `VALUE_FIELD` | `original_amount` | JSON feed: `original_amount` = ticket price; `gross_amount` = incl. fees the buyer covered; `net_amount` = after fees. The CSV uses `Amount Spent` |
| `SEND_LOCATION` | `true` | `false` stops sending hashed city/state/ZIP/country |

| `CURRENCY` | `USD` | Purchase currency |
| `META_ACTION_SOURCE` | `website` | See [Troubleshooting](#troubleshooting) |

These live in the dashboard, not the repo, because `wrangler.jsonc` sets
`"keep_vars": true`. The repo only holds generic defaults (`META_API_VERSION`,
`OVERLAP_MS`, `BACKFILL_HOURS`). A variable defined in `wrangler.jsonc` overrides the
dashboard value on every deploy, so change those three by editing the file.

### 5. Open the admin console

Visit `https://givelively-facebook-pixel.<your-subdomain>.workers.dev/` on your phone. Paste your
admin token once; the page remembers it in that browser only. Buttons:

- **Status**: last run, cursor, counts, the last 10 event IDs, and any missing settings.
- **Dry run**: shows what would be sent from the look-back window (default 24 hours),
  with no sending or saving.
- **Run now**: runs one real poll (when `SEND_TO_META` is `true`).
- **Sample schema**: field names and types from the Give Lively feed. No values.
- **Test Give Lively**: calls the home page, the CSV link and/or the JSON key-validation
  endpoint and feed from the Worker, and reports status codes, whether DataDome answered,
  timing, the CSV's row count and column names, and the Worker's outbound IP. The link,
  key and record values are never shown.
  **Test, no User-Agent** repeats it without the Worker's User-Agent header.

The page itself holds no data. Every endpoint needs `Authorization: Bearer <ADMIN_TOKEN>`.

## The CSV link

Give Lively's event-ticketing CSV ("dataclip") link returns every purchase for one
event, one row per purchase. It has no ID column and no time filter, so the Worker:

- downloads the file each run and keeps rows bought in the last 7 days (Meta's limit),
  but never before the Worker's first run, so turning it on doesn't send old sales;
- gives each row a stable ID: a hash of the buyer's email, purchase time and tier.
  Already-sent IDs are skipped, so each purchase is sent once, and a pending payment
  is picked up when it turns `succeeded`.

| CSV column | Used for |
|---|---|
| `Status` | Must be `succeeded` |
| `Amount Spent` | Meta `value` |
| `Amount Refunded` | Refunded rows are skipped |
| `Date/Time of Purchase` (e.g. `2026-10-06 04:34:38 PM CDT`) | Meta `event_time` |
| `Tier Purchased` | Meta `content_ids` |
| `Tickets Purchased` | Meta `num_items` |
| `Page Name`, `Internal Name` | `EVENT_MATCH` (optional), Meta `content_name` |
| `Email`, `First Name`, `Last Name`, `Phone Number` | Hashed `em`, `fn`, `ln`, `ph` |
| `city`, `state`, `postal_code` | Hashed `ct`, `st`, `zp` (there is no country column) |

`EVENT_PAGE_URL` supplies Meta's `event_source_url`.

## The Zapier JSON feed

The feed returns one record per **line item** (one ticket, or one donation), newest
change first, filtered by `data_modified_timestamp` when `start_time_ms` is passed.
The fields this Worker uses (all mapped in `src/fields.ts`):

| Give Lively field | Used for |
|---|---|
| `line_item_id` | Dedupe (stored in D1) |
| `order_id` | Groups tickets bought together; Meta `event_id` and `order_id` |
| `ticket_id` | Present only on tickets. Tells tickets from donations; Meta `content_ids` |
| `page_name`, `page_slug`, `event_name`, `internal_name`, `campaign_name`, `page_url` | Matched against `EVENT_MATCH` |
| `payment_status` | Must be `Succeeded` |
| `total_refunded_amount`, `refund_status`, `disputed_at` | Refunded or disputed line items are skipped |
| `original_amount` (or `VALUE_FIELD`) | Meta `value` |
| `payment_succeeded_date` (fallback `date`) | Meta `event_time` |
| `email`, `first_name`, `last_name`, `donor_phone_number` | Hashed `em`, `fn`, `ln`, `ph` |
| `donor_mailing_city`, `_state`, `_zip`, `_country` (fallback billing ZIP/country) | Hashed `ct`, `st`, `zp`, `country` |
| `event_name` / `campaign_name` | Meta `content_name` |
| `page_url` | Meta `event_source_url` |

To check what your own feed looks like without exposing anyone's data, tap **Sample
schema** in the console. It returns field names, types and formats only. To see values
of non-personal fields, list them under *Show values for fields*, e.g.
`page_type, payment_status, page_slug`. Personal fields (email, names, address, phone,
dedications...) are always blocked. If `EVENT_MATCH` is set, `current_filter` shows how
the filter classifies each record in the window.

Before sending anything, tap **Dry run**. Each order appears as `would_send` (with its
value and ticket count) or `would_skip` (with a reason). Donations are absent unless
`TRACK` includes them.

## What is sent to Meta

| Meta parameter | Value |
|---|---|
| Event Name | `Purchase` (tickets) or `Donate` (donations) |
| Event ID | Give Lively `order_id` |
| Event Time | Payment time |
| Action Source | `website` (`META_ACTION_SOURCE`) |
| Event Source URL | Give Lively `page_url` |
| Value, Currency | Sum of the order's line items, `USD` |
| Order ID | Give Lively `order_id` |
| Content Name | Event or campaign name |
| Content Category | `Event Ticket` or `Donation` |
| Content Type, Content IDs | `product`, Give Lively `ticket_id`s (tickets only) |
| Email, First Name, Last Name, Phone | SHA-256 hashed |
| City, State, Zip Code, Country | SHA-256 hashed (`SEND_LOCATION`) |
| Client User Agent | Not sent: Give Lively doesn't provide it |

## Test with Meta Test Events, then go live

1. Set `EVENT_MATCH`, `META_PIXEL_ID`, `META_TEST_EVENT_CODE` and `SEND_TO_META=true`
   in the dashboard.
2. Buy a low-cost test ticket (complimentary tickets are excluded on purpose).
3. Tap **Run now**. In Events Manager → **Test events**, confirm a Purchase with the
   right value and matched customer info.
4. Tap **Run now** again. Confirm no duplicate.
5. Make a plain donation and run again. Confirm nothing is sent.
6. Delete `META_TEST_EVENT_CODE`. You're live, and the cron sends new sales every 5 minutes.

`BACKFILL_HOURS` (default `0`) controls how far back the very first run looks.
Leave it at `0` so launching doesn't flood Meta with old sales. Meta rejects
events older than 7 days in any case, so this Worker skips them.

## Settings reference

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `GL_CSV_URL` | secret | | Event ticket CSV link. When set, used instead of the JSON feed (never logged) |
| `GL_ORG_ID` | dashboard var | | Give Lively organization ID (JSON feed) |
| `GL_API_KEY` | secret | | Give Lively Zapier API key (JSON feed; part of the URL, never logged) |
| `META_PIXEL_ID` | dashboard var | | Pixel/dataset ID |
| `META_ACCESS_TOKEN` | secret | | Conversions API token (sent in the request body, never logged) |
| `META_API_VERSION` | `wrangler.jsonc` | `v26.0` | Graph API version |
| `META_TEST_EVENT_CODE` | dashboard var | | Send to Test Events instead of production |
| `META_ACTION_SOURCE` | dashboard var | `website` | Meta `action_source` |
| `EVENT_MATCH` | dashboard var | | Case-insensitive substring of the page name, slug or URL |
| `TRACK` | dashboard var | `tickets` | `tickets`, `donations` or `both` |
| `VALUE_FIELD` | dashboard var | `original_amount` | Feed field used as the value |
| `SEND_LOCATION` | dashboard var | `true` | Send hashed city/state/ZIP/country |
| `EVENT_PAGE_URL` | dashboard var | record `page_url` | Override for `event_source_url` |
| `CURRENCY` | dashboard var | `USD` | Purchase currency |
| `SEND_TO_META` | dashboard var | off | `true` enables sending |
| `OVERLAP_MS` | `wrangler.jsonc` | `600000` | Re-read window to catch late records |
| `BACKFILL_HOURS` | `wrangler.jsonc` | `0` | First-run look-back |
| `ADMIN_TOKEN` | secret | | Bearer token for `/status`, `/run`, `/sample` |
| `DB` | D1 binding | auto | Dedupe, cursor, run history |

The poll interval is `triggers.crons` in `wrangler.jsonc` (default every 5 minutes).

## Failure handling

- **Give Lively down / 404**: logged without the URL; nothing changes; retried next run.
- **Meta outage, rate limit, bad token or pixel ID**: nothing is marked sent and the
  cursor stays put. Events are never rejected for configuration problems.
- **Meta rejects the batch**: events are retried one by one. Accepted ones are saved
  as `sent`, invalid ones as `rejected`. If nothing in the run succeeds, an event is
  given up on only after 5 runs in a row.
- **Order that can't be mapped** (no email, too old, no timestamp): saved
  once as `skipped` with a reason code, never retried.
- **Pending payments** aren't recorded, so a sale sends once its status turns paid.
- **A ticket that shows up after the rest of its order was sent** goes out as its own
  Purchase with event ID `order_id:line_item_id`, so Meta doesn't drop it as a duplicate.
- Overlapping runs (cron plus **Run now**) are prevented with a short D1 lock.

## Troubleshooting

**"Give Lively's bot protection (DataDome) blocked the request (HTTP 403)".**
Give Lively's site sits behind DataDome, which blocks requests from cloud servers,
including Cloudflare Workers. The event CSV link is not behind it, so the simplest
fix is to set `GL_CSV_URL`. To keep using the JSON feed instead, ask Give Lively to
allow it. The JSON feed is meant for integrations and is already
protected by your API key, so ask Give Lively support to exempt it. You can send:

> We use the Zapier JSON endpoints (`/nonprofits/{id}/json_dataclips/...json`) from our
> own server, a Cloudflare Worker, to send ticket sales to the Meta Conversions API.
> Requests get HTTP 403 from DataDome (`x-datadome: protected`). Could you exempt the
> `json_dataclips` paths from bot protection, or allowlist requests with the User-Agent
> `givelively-capi-worker (+https://github.com/cobiadigital/givelively-facebook-pixel)`?
> The endpoint is already protected by our API key.

Tap **Test Give Lively** in the console to check whether the block applies to your
Worker; the verdict line says "Blocked" or "Not blocked".

This Worker doesn't try to get around the bot protection.

**First deploy fails creating the D1 database.** Automatic provisioning needs Wrangler
4.45+ (the repo pins it). If it still fails, create a database in the dashboard
(Storage & Databases → D1 → Create, name `givelively-capi`) and add its ID to
`wrangler.jsonc` as `"database_id"`. The ID isn't a credential, but it's specific to
your account.

**Events reach Meta but don't show in Test Events.** Meta wants a browser user agent
for `action_source: "website"`, and this Worker has none (Give Lively doesn't pass
one, and the Worker doesn't invent one). If website events get dropped, set
`META_ACTION_SOURCE` to `system_generated` or `other` in the dashboard.

**Dashboard variables disappeared after a deploy.** Check that `"keep_vars": true` is
still in `wrangler.jsonc` and that the variable isn't also defined there.

**Logs.** Worker → Logs (observability is on). Each run logs one `poll` summary line
with counts and reason codes only.

## Privacy

- Sends only hashed email, first name, last name, phone, city, state, ZIP and country
  (location can be turned off with `SEND_LOCATION=false`), plus the order details in
  the table above. No street address, dedications or payment details.
- D1 stores only line item and order IDs, timestamps, values and status codes.
- `/sample` returns field names and types, never values, unless you ask for specific
  non-personal fields.

## Development

```
npm install
npm run check   # typecheck + unit tests (vitest)
```

Tests use fake data and an in-memory store; they don't need Cloudflare. Code:

| File | Role |
|---|---|
| `src/index.ts` | `scheduled()` and `fetch()` entry points |
| `src/poll.ts` | One run: fetch, filter, dedupe, send, record |
| `src/fields.ts` | Give Lively field names |
| `src/filter.ts` | `isTicketSale()` / `classify()` |
| `src/map.ts` | Record → Meta event, hashing |
| `src/meta.ts` | Conversions API client |
| `src/giveLively.ts` | Feed client (URL kept secret) |
| `src/db.ts` | D1 tables (created automatically) and queries |
| `src/admin.ts`, `src/console.ts` | Admin endpoints and console page |
| `src/schema.ts` | Value-free schema for `/sample` |

## License

MIT
