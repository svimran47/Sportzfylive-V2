# Sportzfylive V2

[![Deploy to Cloudflare](https://github.com/svimran46/Sportzfylive-V2/actions/workflows/deploy.yml/badge.svg)](https://github.com/svimran46/Sportzfylive-V2/actions/workflows/deploy.yml)

A modern, responsive web application for streaming live sports matches and 24/7 TV channels. The public site is static HTML/JS; the backend is a Cloudflare Worker that syncs matches from the Streamed API, resolves per-source stream metadata, runs the Live TV channel catalog, and backs the admin panel.

## Features

- ⚽ **Match Listing**: Live and upcoming fixtures grouped by sport, synced from the Streamed API every 10 minutes
- 🎬 **Smart Player**: Automatically detects and plays HLS streams (.m3u8) or iframe embeds
- 🔍 **Advanced Search**: Real-time search across all available matches
- 🏷️ **Category Filtering**: Filter matches by sport (FOOTBALL, CRICKET, TENNIS, and more)
- 🛡️ **Secure**: Playback URLs are resolved server-side only and never exposed to the client; XSS-safe rendering
- ⚠️ **Error Handling**: Per-source failure isolation — one bad Streamed source never breaks a match list
- 🎯 **Watch page**: match identity (crests + share) on top, the player, stream chips labelled with language/provider/HD, then a rail of other matches — all rendered from the match list already in memory, so opening a match costs no extra requests
- 🔗 **Shareable matches**: share buttons emit `#match=<id>` links, and the site opens that match directly on load
- 📺 **Live TV** (`/live-tv`): the channels from the [`channels.json`](https://github.com/svimran46/playlist.m3u) list on `main` — country filter, sport chips, search, a universal player (HLS, MPEG-TS, DASH, FLV, MP4/WebM, audio, embeds) with previous/next, reload, full screen and share, `#ch=<id>` deep links, and an "Up next" rail on wide screens
- 🛠️ **Admin panel** (`/admin`): dashboard, match management (filters, bulk actions, featured/active flags, streams picked from the TV catalog), Live TV channel management (playlist sync, import from URL with stream health checks), fetch logs and site settings — no redeploy needed for any of it
- 📱 **Responsive Design**: Fully responsive grid layout for mobile, tablet, and desktop
- 🎨 **Modern UI**: Dark theme with smooth animations and transitions

## Live TV playback checks

The Worker probes every active Live TV channel on the 10-minute cron, 100 per run (oldest check first, so a new catalog is fully probed within a few hours). A probe reads real media, not just the HTTP status:

- **HLS:** the playlist must list a segment, and that segment must be MPEG-TS (sync bytes) or fMP4 with at least 16 KB of data. Master playlists are followed one level.
- **MPEG-TS / FLV / progressive:** at least 16 KB of data with valid container bytes; an HTML page fails.
- **DASH:** the manifest must be a valid MPD. Segments are not fetched, so DASH is verified less strictly than HLS.
- **Web-page embeds:** never *verified* — they can't be probed without a browser.
- Probes time out after 10 seconds, and that limit covers the body read too.

Results are one KV record (`tv_health`), written once per run, and `GET /api/admin/tv/health` returns them. A channel is called *working* after 2 good probes in a row and *failed* after 3 bad ones in a row; a changed stream URL starts over, and a channel that has not been probed yet is *unchecked*.

**Checks are advice, never a gate.** The public channel list, the site's Live TV page and `/api/tv/playlist.m3u` (which the app reads) serve **every active channel** — checked or not, working or failed — and only `active: false` (or a missing stream URL, or one that needs custom request headers the app can't send) leaves a channel out. The probes fill the admin's per-channel check column so the owner can see which streams are dead; they cannot hide a channel from viewers.

That is deliberate, because a probe is not evidence about a viewer: probes run from Cloudflare's network, not the viewer's device. A panel that refuses Cloudflare's egress entirely (a line allowing a single connection, a provider that answers only residential IPs, or a transient 4xx/5xx window) makes every probe fail while the streams play perfectly on a phone. Gating the directory on that verdict emptied Live TV for every viewer at once, and it could not recover quickly either — 100 probes per run, oldest first, two passes before a channel lists — so the check reports and nothing more.

A channel that needs custom request headers is probed with them, but left out of the app playlist because the app can't send them.

## Architecture

```
Streamed API ──▶ Cloudflare Worker (worker.js)
channels.json ─▶ ├─ 10-min cron sync + source resolution (SWR cache in KV) + live-window cleanup
                 ├─ Live TV catalog: playlist sync (cron every 6 h + on demand), manual channels
                 ├─ Android app config: /api/app/config (edited on the admin "Android app" page)
                 ├─ Public API: /api/matches/all-today, /api/site-content, /api/tv/channels
                 │    (sanitized: no embedUrl, no stream URLs, no admin fields)
                 ├─ Playback redirects: /api/play/tv/:id, /api/play/stream/:matchId/:streamId
                 ├─ Image proxy: /api/images?url= (same-origin posters/crests, streamed.pk only)
                 ├─ On-demand resolver: /api/streamed/streams?source=&id=
                 └─ Admin API (password → 24h session; matches, channels, settings, logs)
                       │
index.html   ◀────────┤  Public site (match cards, stream picker, notice, featured row)
live-tv.html ◀────────┤  Live TV page (channel grid + sandboxed player)
player.html  ◀────────┤  HLS player for .m3u8 streams
admin.html + admin.js     Admin SPA (dashboard, matches, Live TV, fetch logs, settings)
```

## File Structure

```
Sportzfylive-V2/
├── worker.js          # Cloudflare Worker: API, auth, Streamed sync + resolver
├── index.html         # Public site (embedded CSS and JavaScript) — source copy
├── live-tv.html       # Live TV page — source copy
├── player.html        # HLS (.m3u8) player page framed by the watch view and Live TV — source copy
├── admin.html         # Admin shell (markup + styles) — source copy
├── admin.js           # Admin SPA (hash-routed: dashboard, matches, Live TV, logs, settings) — source copy
├── og-card.png        # Social share card — source copy
├── public/            # The entire published site (Worker static assets)
│   ├── index.html     #   published copy of the root pages above
│   ├── live-tv.html
│   ├── player.html
│   ├── admin.html
│   ├── admin.js
│   ├── og-card.png
│   ├── fonts/         #   self-hosted DM Sans woff2
│   ├── _headers       #   response headers for static assets
│   ├── robots.txt
│   └── sitemap.xml
├── test/              # Node smoke suites (UI contracts, worker logic, deploy)
├── .github/workflows/ # Cloudflare deploy on push to main
├── wrangler.jsonc     # Worker config (KV, queue, cron, assets)
└── README.md          # This file
```

## Getting Started

### Prerequisites
- A modern web browser (Chrome, Firefox, Safari, Edge)
- For HLS streams: Browser must support Media Source Extensions (MSE)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/svimran46/Sportzfylive-V2.git
cd Sportzfylive-V2
```

2. Preview locally (serves the same `public/` directory the Worker publishes):
```bash
bun install     # installs wrangler for deploys
bun run serve   # http://localhost:3000
```

The local server has no API — match data and the `/api/images` poster proxy come
from the deployed Worker, so the page talks to `PROXY_URL` in `index.html` while
you develop.

## Usage

### Admin panel

Open `/admin` and sign in with the admin password (the `ADMIN_TOKEN` Worker
secret, or a password set later under Settings → Admin password). The panel is
a hash-routed single page app, so the browser Back button and bookmarks work:

| Page | Route | What it does |
| --- | --- | --- |
| Dashboard | `#/` | Totals (matches, active, live now, streams), last fetch + health, quick actions, content overview, publishing checklist |
| Matches | `#/matches` | Search, date filter, chips (All / Live / Today / Upcoming / Past / Active / Inactive / Featured / Manual), bulk activate/deactivate/feature/delete, ★ to pin a match to the homepage Featured row, Delete all |
| Create / edit match | `#/matches/new`, `#/matches/:id/edit` | Event, kickoff (your time zone, with the UK time shown), competition, sport (or Auto from the event text), teams, featured image, featured/active flags, status, live-window override |
| Match detail | `#/matches/:id` | Everything about the match plus its streams: add one from the Live TV catalog (search, or **Bulk add** several), edit, copy, reorder (arrows or drag) — changes save immediately |
| Live TV | `#/tv` | All channels with status toggles, filters and bulk actions; **Sync Playlist**, **Import from URL** (M3U or JSON; every new stream is health-checked first), **Add Channel**, Delete All |
| Android app | `#/app` | Remote control for the Android app: maintenance mode, forced updates (minimum version + update link), announcement banner, featured match, hidden sports, player mode and ad blocking, channel list and stream proxy URLs, and whether match pages are resolved to the native player, plus the exact JSON installed apps receive (`GET /api/app/config`). Changes reach installed apps within a minute |
| Fetch Logs | `#/logs` | The last 30 schedule fetches (manual or cron) with counts, duration and errors, plus the last Live TV playlist sync |
| Settings | `#/settings` | Schedule ingest, TV source, live windows, site notice, analytics + house banner, site identity, maintenance (fetch / playlist sync / cleanup), admin password, data storage report |

Matches are synced from the Streamed API every 10 minutes. The feed owns a
streamed match's title, sport, kickoff and status; everything an admin sets
(teams, streams, featured image, featured/active flags, live-window override)
survives every sync.

**Live windows** decide how long after kickoff a match stays on the site: a
per-match override, then match-type keyword rules (e.g. *Cricket T20*: `t20,
ipl, bbl` → 5 h), then the sport category, then the site default. Matches past
their window are hidden at once and deleted on the next fetch (or by Run
Cleanup). A match the feed reports live is never removed.

### Live TV

`/live-tv` lists the active channels from the Worker's catalog. The catalog is
synced from the TV source playlist — by default the latest commit of
`channels.json` on `main` of `svimran46/playlist.m3u` (a JavaScript snippet
wrapping a JSON list of named channels). It is
seeded on first use, re-synced every hour by the cron when *Re-sync
automatically* is on (and at once when the source URL changes), and on demand
from the admin. A sync replaces every synced channel, so only the playlist's
channels stay on the page; channels added by hand in the admin are kept until
deleted there. Each channel keeps its `group-title` as its group (the country
filter); categories (Football, Cricket, Motorsport, Fight, Tennis, Golf,
Basketball, Horse Racing, Sports, …) come from the name, with *Default
category* (Settings → TV source) as the fallback.

The public channel list never contains stream URLs. Channels play through
`/api/play/tv/:id`:

- **https HLS/DASH/video/audio/embeds** redirect to the stream, as before.
- **http streams, raw MPEG-TS/FLV, channels with request headers
  (`#EXTVLCOPT:http-user-agent`/`http-referrer`, Kodi `|User-Agent=…`) or the
  admin's *Play through the Worker* flag** are proxied by the Worker: the
  browser never sees the upstream URL (Xtream URLs carry the account login),
  there is no mixed content, and HLS playlists are rewritten so every segment
  goes through `/api/play/tv/:id/s/<token>` (AES-GCM sealed, 12 h, bound to
  the channel). DASH uses `/b/<token>/…`. `?format=hls` asks for the `.m3u8`
  sibling of an Xtream `.ts` stream (iPhones without MSE).
- http logos are served from `/api/tv/logo/:id` (images only, edge-cached).

Tokens are sealed with `STREAM_PROXY_SECRET` when set, else `ADMIN_TOKEN`.
Note that most Xtream accounts allow only one or two simultaneous
connections, and each viewer of a proxied channel holds one.

### Playback

`player.html` picks an engine from the channel's kind: native HLS or hls.js
for `.m3u8`, mpegts.js for MPEG-TS and FLV (falling back to the Worker's HLS
version on iPhones without MSE), dash.js for `.mpd`, and the native player for
MP4/WebM/audio. Libraries load lazily from pinned CDN versions. Blocked
autoplay retries muted with a *Tap to unmute* button; network drops reconnect
with backoff. Embed pages open in an iframe (sandboxed when flagged).

### Watch page

Opening a match shows the watch view, top to bottom: match title with live status,
both teams with crests and their initials as fallback, share controls, the player,
the stream list (one chip per stream with its language, provider and an HD tag),
and a rail of related matches. The rail is capped at 8 matches, prefers the same
sport, reuses the homepage card markup, and is lazily rendered
(`content-visibility`) so scrolling stays smooth.

## Technologies Used

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Player**: hls.js for HLS stream playback
- **Video API**: Native HTML5 `<video>` element

## Testing

Five Node smoke suites cover the UI contracts, the Worker logic and the deploy
configuration. Run them all:

```bash
bun run test     # or: npm test
# equivalent to:
#   node test/dom-ux.smoke.mjs    # keyboard access, modal behavior, stream picker selection
#   node test/ui-polish.smoke.mjs # design-system structure, layout order, a11y semantics
#   node test/resolver.smoke.mjs  # Streamed sync, per-source failure isolation, API shaping, image proxy
#   node test/live-tv.smoke.mjs   # Live TV page: filters, batching, kind routing, deep links
#   node test/player.smoke.mjs    # universal player engine selection, fallbacks, autoplay
#   node test/stream-proxy.smoke.mjs # Worker stream proxy, sealing, HLS/DASH rewriting, logos
#   node test/admin-tv.smoke.mjs  # Live TV catalog, playlist parsing/sync/import, play redirects,
#                                 # settings, live windows + cleanup, password rotation, fetch log
#   node test/deploy.smoke.mjs    # published copies in sync, no host leftovers, deploy workflow
```

The DOM and UI suites parse the real `index.html` and run its JavaScript against a DOM stub, so changes to markup, styles or interaction code are validated against the shipped page — not a copy.

## Error Handling

The application provides user-friendly error messages for:
- Network connectivity issues
- Invalid/corrupted streams
- Unsupported media formats
- Failed embed loading

Errors auto-dismiss after 5 seconds or when a new channel is selected.

## Security

- **XSS Prevention**: All user data is sanitized and rendered safely using DOM methods
- **Embeds**: Streamed match embeds are not sandboxed (those players refuse to run inside a sandbox); they get `no-referrer` and only the autoplay/fullscreen permissions they need. A Live TV channel marked `"sandbox": true` in `channels.json` runs in a sandboxed iframe (no pop-ups, no top-level navigation) on the website and when attached to a match (the Android app sandboxes by default too — its pop-up shim keeps `window.open` from answering `null`, so the embed's anti-sandbox check passes — and additionally traps pop-ups and ad redirects in the WebView, refuses ad frames, images and beacons, and still lets the embeds' own ad scripts load so the player does not go black; `embedSandbox: false` in the app's remote config turns its sandbox off; the app also runs each `embed.st` page in a hidden WebView just long enough to capture the real media URL, then plays that in its own Media3 player — `embedResolve: false` turns that off too); other channels load directly, because some render a black frame inside a sandbox. Admins can flip the flag per channel or per stream
- **Playback URLs**: public JSON never carries TV channel or admin stream URLs; `/api/play/*` redirects to them (errors answer as sandboxed plain text), and `player.html` only plays those `/api/play/*` paths
- **Admin password**: `ADMIN_TOKEN` signs sessions and is the bootstrap login. A password set in Settings is stored as a salted PBKDF2 hash in KV and replaces it for logins until reset; logins and password changes share the per-IP failure throttle. Locked out? Delete the `admin_credential` key in the KV namespace
- **Input Validation**: All data is validated before rendering

## Browser Support

| Browser | HLS Support | Iframe Support |
|---------|-------------|----------------|
| Chrome 43+ | ✅ Yes | ✅ Yes |
| Firefox 42+ | ✅ Yes (with MSE) | ✅ Yes |
| Safari 11+ | ✅ Yes (native) | ✅ Yes |
| Edge 79+ | ✅ Yes | ✅ Yes |

## Deployment (Cloudflare Workers)

One Worker is the whole production surface: it serves the API **and** the static
site in `public/` from the same origin, so there is no second host to keep in
sync. Bindings live in `wrangler.jsonc`.

### Deploy from your machine

```bash
bun install                            # installs wrangler
bun run deploy                         # wrangler deploy: worker.js + ./public
npx wrangler secret put ADMIN_TOKEN    # admin panel token (once)
```

Wrangler authenticates with `wrangler login`, or with the `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` environment variables when you want it
non-interactive. The site is live at
`https://sportzfylive.svimranmy.workers.dev/`.

### Secrets

Secrets never live in the repository. They go into the Worker:

```bash
npx wrangler secret put ADMIN_TOKEN   # admin panel token
```

For local work (`wrangler dev`), put the same names in `.dev.vars` at the repo
root — it is gitignored, as are `.env` and `.env.local`. `wrangler deploy` only
ever reads Worker secrets, so a local file can never be published.

`npx wrangler dev` (port 8787) runs the whole stack locally — API, public pages,
Live TV and the admin panel — against a local KV. The pages detect port 8787
and call the local Worker instead of the deployed one.

### Deploy on every push (GitHub Actions)

`.github/workflows/deploy.yml` runs the smoke suites and then `wrangler deploy`
on each push to `main`. Two repository secrets arm the deploy
(Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token created from the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID from the Cloudflare dashboard |

While they are unset the workflow still runs the tests and stays green: the
preflight names which secret is missing and the publish step is skipped, so
`bun run deploy` is the manual path until the secrets are added. No workflow
change is needed when they appear — the next push deploys automatically.

### First-time setup on a fresh Cloudflare account

1. Create the KV namespace and put the printed id in `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create SPORTZFY_DB
   ```
2. Create the sync queue — or, on the Workers **free** plan (Queues need the paid
   plan), delete the `queues` block from `wrangler.jsonc`; the 10-minute cron then
   runs the same sync inline in `scheduled()`.
3. `npx wrangler secret put ADMIN_TOKEN`
4. `bun run deploy`, then trigger one sync (Admin panel → Sync & Automation).

### Custom domain

Add a route in `wrangler.jsonc` and update the canonical origin in `index.html`
(`og:url`, the `canonical` link, `og:image`, `twitter:image`) plus
`public/robots.txt` and `public/sitemap.xml`:

```jsonc
"routes": [{ "pattern": "example.com", "custom_domain": true }]
```

### Caching and headers

`public/_headers` sets the static-asset response headers (`/fonts/*` cached for a
year, `nosniff` + `Referrer-Policy`); Worker-generated responses set their own.
Assets ship with `Cache-Control: public, max-age=0, must-revalidate` and an ETag,
so a deploy is visible immediately, while `/api/images` responses are cached at
the edge for 24 hours.

### Keeping the published copy in sync

The repo root holds the source of `index.html`, `admin.html`, `admin.js` and
`og-card.png`; `public/` holds the published copies. Edit the root file, copy it
into `public/`, and run `bun run test` — the deploy suite fails when the two
diverge. (`public/` is also the only thing uploaded, so anything placed there
becomes public.)

### Self-hosted static copy (optional)

`public/` can be dropped on any static host, but the API, the admin panel and the
`/api/images` poster proxy still run on the Worker — keep `PROXY_URL` in
`index.html` and `API` in `admin.js` pointed at the deployed Worker origin and
serve over HTTPS for embedded content.

## Performance

- **Lightweight**: ~18KB total (HTML + CSS + JS)
- **No Dependencies**: Except hls.js (CDN loaded)
- **Fast Load**: Optimized grid rendering for 100+ channels
- **Responsive**: Smooth animations at 60fps

## Troubleshooting

### Matches not loading?
- Verify the Worker is deployed and `/api/status` responds
- Check browser console for errors (F12 → Console)

### Streams not playing?
- Verify the stream URL is correct and accessible
- Check if the stream URL is CORS-enabled
- Some streams may require a VPN or geolocation

### Posters or team crests missing on desktop?
- Poster art is hotlinked from `streamed.pk`; a blocked or filtered request retries
  once through `/api/images?url=` (same origin) and then falls back to team initials
- If every image is missing, redeploy so `/api/images` is live: `bun run deploy`
- Matches the Streamed API ships without a badge (`badge: ""`) show team initials by design

### A change is not showing up on the live site?
- Run `bun run test`: the deploy suite fails when `public/index.html` drifts from `index.html`
- Confirm the latest deploy succeeded: `gh run list --workflow=deploy.yml`

### Performance issues?
- Clear browser cache (Ctrl+Shift+Delete)
- Close unused tabs
- Try a different browser

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is open source and available under the MIT License.

## Acknowledgments

- [hls.js](https://github.com/video-dev/hls.js) - HLS streaming library
- [Wikimedia Commons](https://commons.wikimedia.org/) - Channel logos
- All streaming partners and providers

## Support

For issues, questions, or suggestions, please open an issue on GitHub.
