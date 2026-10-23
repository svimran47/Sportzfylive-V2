# Sportzfy for Android

A standalone Kotlin and Jetpack Compose client for live sports streams. It reads the Streamed API directly and needs no Cloudflare Worker.

## Stack

| Concern | Choice |
|---|---|
| Language | Kotlin 2.2 (coroutines, Flow) |
| UI | Jetpack Compose and Material 3, dark only |
| Architecture | Clean Architecture (data → domain → presentation), MVVM |
| DI | Koin |
| Networking | Retrofit 3, OkHttp 4, kotlinx.serialization |
| Images | Coil 3 |
| Playback | Media3 ExoPlayer for HLS, DASH and progressive streams (MPEG-TS, MP4…) and for match streams resolved out of their embed page; WebView for other web pages (sandboxed iframe by default) |

## Layout

```
app/src/main/java/com/sportzfy/live/
├── core/network/   Retrofit service, browser-header interceptor, error mapping
├── core/player/    URL policy, ad-host list, media vs embed detection
├── core/theme/     colors, typography, shapes
├── core/time/      injectable clock
├── data/model/     wire DTOs
├── data/mapper/    DTO → domain, today/live merge, stream sanitizing
├── data/repository/ cached match feed, per-source stream resolver
├── domain/model/   Match, Team, StreamItem, SportCategory, EmbedUrl, MatchFeed
├── domain/repository/
├── presentation/
│   ├── catalog/      MatchCatalogScreen + CatalogViewModel
│   ├── watch/        WatchStudioScreen + WatchViewModel
│   │   └── player/   StreamPlayer: WebView + Media3 (HLS, DASH, progressive)
│   ├── components/   MatchCard, HeroSpotlight, CategoryPills, StreamChip, LiveBadge, TeamCrest
│   ├── model/        UI state + pure logic (filtering, labels, related matches)
│   └── navigation/   type-safe routes and NavHost
└── SportzfyApp.kt
```

## Build

Requires JDK 17+ and the Android SDK (platform 36).

```bash
./gradlew assembleDebug        # debug APK
./gradlew testDebugUnitTest    # JVM unit tests + Robolectric Compose UI tests
./gradlew assembleRelease      # R8-shrunk release APK (runs lint vital)
```

## Data flow

- **Matches:** `MatchRepository` fetches `all-today` and `live` from `https://streamed.pk/api/matches/` at the same time and tags the matches in the live feed as `LIVE`. Results are cached in memory for 60 seconds.
  - Only the live feed can mark a match as `LIVE`; kick-off time never does. If the live feed fails, its last good copy is reused for up to 5 minutes. After that, nothing is marked live, matches that have kicked off show as **Started**, and the app says it couldn't check live matches instead of claiming there are none.
  - A forced refresh that was queued behind a running one is dropped, so repeated taps on Refresh never stack requests.
  - If every feed fails, the last matches stay on screen with an error banner. Once the last live list is more than 5 minutes old, LIVE badges are dropped too.
  - A match fetched as upcoming whose kick-off has since passed shows as **Started** until the next refresh. It never shows as Live.
  - The 60-second auto-refresh is silent: spinners only show for refreshes you start.
  - If `all-today` fails, the last good copy is merged with the fresh live feed.
- **Streams:** `StreamRepository` resolves each source group from `/api/stream/{source}/{id}` in parallel and caches each one for 60 seconds. If that direct call fails or comes back blocked, the group is fetched again through the website's Worker (`/api/streamed/streams`, see `streamProxyUrl`).
  - A group that fails (429, 5xx or a timeout) is reported back as failed. It never takes down the other groups, and its last good result is served while it is failing.
- **Playback:** stream URLs are always built as `https://embed.st/embed/{source}/{id}/{streamNo}`. Any `embedUrl` sent by upstream is ignored.

## Playback

`StreamPlayer(url)` chooses an engine from the URL's extension, or from a channel's `type` when it has one:

| Format | Recognised by | Engine |
|---|---|---|
| HLS | `.m3u8`, or `"type": "hls"` | Media3 |
| MPEG-DASH | `.mpd`, or `"type": "dash"` | Media3 |
| Progressive: MPEG-TS, MP4, Matroska/WebM, FLV, MP3, AAC | `.ts` `.mts` `.m2ts` `.mp4` `.m4v` `.mkv` `.webm` `.mov` `.flv` `.mp3` `.aac` `.m4a`, or `"type": "ts"` / `"mp4"` / `"progressive"` | Media3 (the container is sniffed from the bytes) |
| Web page | anything else, or `"type": "embed"` | WebView |

- Media3 fetches everything through the app's OkHttp client, so it carries the same browser headers as API calls.
- Streams may be **http or https**. Cleartext is allowed app-wide (`res/xml/network_security_config.xml`) because many IPTV feeds have no TLS; the app's own calls (APIs, remote config, images) stay https. `PlayerConfig.allowHttpStreams` is the switch for http streams.
- A live stream that falls behind its window jumps back to the live edge on its own.
- Errors say what happened: a feed that stopped offers **Retry**; a stream the device can't decode, or one that is DRM-protected, says so with no Retry, since it won't help.

By default (`playerMode: "direct"`, `embedSandbox: true`), the embed runs inside a **sandboxed iframe** in a wrapper page served from a host no site owns (`sandbox.sportzfy.invalid`), so the frame itself — not only the WebView — refuses pop-ups, top-level navigation, downloads and pointer lock, while scripts, same-origin, forms and dialogs stay allowed so the player runs and its session cookies renew. This works because an embed checks for a sandbox by opening a pop-up and seeing whether `window.open` answered `null`: `PopupShim` never lets it answer `null`, so the check passes (see **Pop-ups**). Set `embedSandbox: false` to load the page directly instead, as the WebView's own page like a browser tab, with no referer (embed.st's `admin` streams stay black when a top-level load sends streamed.pk as the referer); that is the fallback for an embed that shows only a black frame inside a sandbox. With `playerMode: "iframe"` and `embedSandbox: false`, the embed runs in a **plain iframe with no `sandbox` attribute**, the same way the website plays it (`allow="autoplay; fullscreen; encrypted-media; picture-in-picture"`, `allowfullscreen`, `referrerpolicy="no-referrer"`). A Live TV channel marked `"sandbox": true` in the channel list is sandboxed too. Each match also has an **Open in browser** button for a stream that won't play in the app.

**Match streams play in the app's own player.** An `embed.st` page never names its stream in the markup: the real `.m3u8`/`.mpd` URL is built inside the page's obfuscated JavaScript at play time, and the Worker only strips Streamed's `embedUrl` metadata, so there is no fixed link to fetch. With `embedResolve: true` (the default) the app instead runs the page in a **hidden 1 dp WebView** (`EmbedResolverHost`) just long enough for its own JavaScript to request the manifest; `EmbedManifest` recognises that request, takes its URL and the Referer/cookie headers it used, and hands both to Media3, which then plays the stream natively — no web player, no pop-ups, with picture-in-picture and background audio. The page resolves under the same ad-blocking policy as the visible player, so an ad's stream is never mistaken for the real one. If nothing is captured within **8 s** (or the page fails to load), the stream falls back to the visible web player described above, exactly as before. `embedResolve: false` turns the whole step off.

- **Pop-ups:** `setSupportMultipleWindows(true)` and `javaScriptCanOpenWindowsAutomatically = true`, as in a browser, so every `window.open` or `target=_blank` reaches `onCreateWindow`. There it gets a throwaway WebView that is never shown, refuses every load and is destroyed a few seconds later. `window.open` still returns a live window (destroyed 1.5 s later), so the player's anti-sandbox check passes, but nothing renders or leaves the app. Some WebViews still answer `null`, which embed.st's admin player reads as a sandbox ("please remove Sandbox from iframe tab or add allow-popups", remembered for an hour), so one document-start script (`PopupShim`, every frame, where the WebView supports `DOCUMENT_START_SCRIPT`) wraps `window.open`: a real window passes through, and a `null` or an exception becomes an inert stand-in window that navigates nowhere. The default sandboxed embed depends on this shim: it is what lets the player's anti-sandbox check pass inside the frame.
- **Navigation:** handled by `PlayerUrlPolicy`, keyed on the stream being played.
  - The outer page stays on the active stream URL's host (its subdomains and `www.`-less form count too), or `embed.st`. Server redirects of the first load are followed, and the host they land on is allowed from then on. Every other top-level navigation (`top.location` hijacks, ad redirects) is cancelled.
  - Subframes load from any host or scheme, so nested cross-domain players (JWPlayer, Clappr and the like) start — except the ad networks, whose frames are the ads themselves.
  - At the top level, `intent:`, `market:`, `file:` and other schemes are refused.
- **Ad networks:** the page's scripts are never blocked, ad scripts included: inline player setup calls into them (`aclib.js` and the like), and refusing them leaves a black player. Everything else from the ad hosts is refused: their iframes, images, beacons and XHR are answered with an empty `200`, and the top-level page can never go to the pop-up networks in `AdHosts.ALWAYS_BLOCKED` (popads, popcash, adsterra, propellerads, doubleclick, googlesyndication, onclkds, acscdn, histats), or to the wider `AdHosts.DEFAULT` list with `adBlocking` on. The request's `Sec-Fetch-Dest` header says whether a request is a script when the WebView reports one; on older WebViews the URL extension and `Accept` header decide, and an ambiguous request is left alone rather than risk a black player.
- **Mixed content:** always allowed, so https embeds can pull http playlists and segments.
- **Dialogs and permissions:** JavaScript dialogs, permission requests, downloads, file access and long-press menus are all disabled.
- **Fullscreen:** `onShowCustomView` and `onHideCustomView` move the video into a fullscreen landscape view with the system bars hidden. Back exits fullscreen.
- **Renderer crashes:** if the renderer dies, the player rebuilds its WebView instead of crashing the app.

## Navigation and dates

A fixed bottom bar has four destinations: **Today** (the start screen), **Tomorrow**, **Live TV** and **All Matches**. It sits above the system navigation bar, hides while the keyboard is open, and isn't shown on the full-screen player. Back from any tab returns to Today; back from Today leaves the app.

- **One feed:** matches come from Streamed's `all-today`, `all` (later days) and `live` endpoints, merged into one list with duplicates removed.
- **Daylight saving:** days where daylight saving skips midnight (Chile, Cairo, Havana) start at 01:00, and that never shifts the neighbouring days. The tabs re-check every minute and exactly at local midnight.
- **Timezone:** "Today" and "Tomorrow" mean the **device's local calendar day** (`ZoneProvider`, `TimeZone.getDefault()`). All the day logic is in `MatchDays`, built on calendar arithmetic, so month and year changes and daylight-saving days are handled. The day boundaries are re-checked every minute, so the tabs roll over at midnight.
- **Today (Home):** today's matches, meaning those live right now (even if they started yesterday), kicking off today, or with no announced time. A **Live | Upcoming | All** switch picks what's shown, and it opens on **Live**:
  - **Live:** only matches in Streamed's live feed. The heading reads "Live Matches" with a live count, which is hidden if the live feed couldn't be checked.
  - **Upcoming:** today's matches that haven't kicked off yet, or have no announced time.
  - **All:** everything for today, grouped as Live now, Started, Upcoming and Earlier today. The All Matches tab is the same idea across every day.
  - **Refresh** reloads the feed, shows a spinner and can't be tapped again until it finishes. The switch, sport filter and search stay as they were.
  - Each empty view suggests where to look next, e.g. "No live matches right now" offers Upcoming and All today, and an empty Upcoming offers Tomorrow.
- **Tomorrow:** matches that kick off on the next local day and aren't live.
- **All Matches:** everything, with live matches first, then one section per day (Yesterday, Today, Tomorrow, then dated days), then matches with no announced time. Every match appears once.
- **Search and filters:** one `CatalogViewModel` serves all three fixture tabs, so search and the sport and Saved filters carry across them.
- **Live TV:** a channel directory, separate from match fixtures. See [Live TV](#live-tv).

## Screens

- **Catalog**
  - **Header:** the Sportzfy wordmark, a live-match counter with a pulsing dot, and instant search over team names and sports.
  - **Spotlight banner:** shows the featured match, preferring popular live matches, with a Watch button.
  - **Sport pills:** All, Football, Cricket, Basketball, Tennis and Motorsport, plus any other sport in today's feed. Each pill shows its match count.
  - **Match list:** an adaptive grid with Live now, Upcoming and Earlier today sections. Pull down to refresh; the list also refreshes every 60 seconds while the screen is on.
- **Watch Studio**
  - **Top bar:** Back, plus the sport and match title.
  - **Player:** a 16:9 player that stays pinned above the rest of the screen.
  - **Match details:** both teams with their crests.
  - **Stream pills:** labelled like "Stream 1 HD • English". Picking a pill reloads only the player. The screen also shows how many pop-ups were blocked.
  - **More matches:** a rail of other live and upcoming matches, which switch in place.
  - **Wide screens:** on screens 840dp or wider, the rail becomes a side column. The player instance is kept when the layout changes, so rotating the device doesn't restart the stream.

## Drawer, Settings and About

- **Drawer:** opened by the menu button at the top left of every tab. It covers about 80% of the screen width, up to 320dp. The page behind it dims, it scrolls on short screens, and it stays clear of the status and navigation bars. Tapping outside it, the ✕ or Back closes it, and so does picking an entry. It can't be swiped open, so swipes on sport pills and rails never pull it out by mistake.
  - **Browse:** Live Matches (Home on Live, filters cleared), Live TV, Fixtures (All Matches, filters cleared), Saved Matches (All Matches filtered to saved), and Search (All Matches with the search field open).
  - **Sports:** Football and Cricket filter All Matches to that sport. Other Sports shows everything except football and cricket.
  - **Footer:** Settings and About.
  - **Selected entry:** it shows a pink accent bar and icon on a subtle surface. Filters live in the same shared catalog state as the tabs, so the drawer and the bottom bar always agree.
- **Settings** (stored on the device):
  - **Preferred stream language** (default English, or "Any language"). The player starts on a stream in that language, HD first, when one exists. Otherwise it falls back to any HD stream, then the first stream.
  - **Time format:** System, 12-hour or 24-hour. Applies to every kick-off time.
  - **Clear saved matches:** asks for confirmation first.
  - **App version.**
- **About:** version, where matches, streams and channels come from, and a note that saved matches and settings never leave the device.

## Live TV

- **Channel list:** the Worker's playlist, `/api/tv/playlist.m3u`. It lists every active channel; the Worker's stream checks are advice for the admin only and never hide one (see the root README, *Live TV playback checks*), so a source that fails every check, such as a provider that blocks Cloudflare's egress or an expired line, can't leave Live TV empty. The URL comes from the remote config (`channelsUrl`, served by the Worker's `/api/app/config`). If the config can't be loaded, the app falls back to the raw `channels.json` (unverified), the list `remote-config.json` ships to builds that read it from GitHub. The fallback deliberately doesn't name the Worker playlist, so the app keeps working against a Worker that hasn't been redeployed yet. An admin can point the app at another file with `channelsUrl`.
  - **Short-link channels:** the upstream playlist now lists many channels as short-link ad pages that Media3 can't play. The Worker's playlist hands those entries the Worker's play route instead (`/api/play/tv/:id`), which resolves the short link server-side to the real playlist and streams it sealed, and marks them `type="hls"` so the app doesn't classify the extension-less URL as a web page. A channel whose short link is dead upstream still won't play; everything else is unchanged.
  - The file can be the JavaScript snippet it is today (`const channels = [...]`), a plain JSON array, or an **M3U playlist** (`#EXTM3U` with `#EXTINF` entries, as IPTV providers publish; the title, `tvg-logo` and `group-title`/`#EXTGRP` are read, plus an optional `type` attribute (`"hls"`, `"dash"`…) that marks a URL whose extension doesn't — that is how the Worker's playlist flags the short-link channels it routes through `/api/play/tv/:id`).
  - Each JSON entry needs a `name` and an http(s) `url`. `logo` is optional. `type` (`hls`, `dash`, `ts`, `mp4`, `embed`) says how to play a URL whose extension doesn't, such as an IPTV feed at `http://host:8080/user/pass/123`; an M3U `type` attribute means the same.
  - Entries without a name or an http(s) stream are skipped, and so are repeated streams. Logo URLs have their repeated `&amp;` escaping undone. Logos may be http or https (some IPTV playlists' picon servers have no TLS); anything else shows the channel's initials.
  - The list is kept for 30 minutes. If a reload fails, the last good list stays on screen with a banner.
- **Groups:** **Football**, **Cricket** and **Others**. Every entry upstream has `"genre": "Sports"`, cartoon channels included, so genre can't be used to group them. Instead:
  - An entry's optional `category` field (`football`, `cricket` or `others`) decides its group.
  - Otherwise the name decides, then the category text (an M3U `group-title` like "UK Football"). "Cricket" or "Willow" means Cricket. "Football", "Fussball", "LaLiga", "Bundesliga", "Premier League" and similar mean Football. Everything else is Others.
  - A chip only appears for a group that has channels.
- **Country:** an M3U `group-title` (or a JSON `country`) is the channel's country. The **Country** button opens a sheet with World (every channel) and each country A–Z with its channel count, plus a filter field. The sport chips count only the chosen country. A list with no countries shows no button.
- **Browse / A–Z:** Browse keeps the playlist's order; A–Z sorts by name.
- **Recent and Favorites:** chips ahead of the sports, shown once they hold a channel. Recent is the last 30 channels played, newest first; the star on a tile or on the player saves a channel to Favorites. Both cover every country and sport, and stay on the device (`channel_library` DataStore).
- **Search:** matches every word you type against the channel's name, group and country.
- **LIVE marker:** only the channel playing now is outlined and marked LIVE. The directory doesn't say whether the others are on air, so the app doesn't claim it.
- **Player:** tapping a tile plays it in place, docked above the grid (the grid scrolls, the picture stays), with the channel, country and sport, a star, **Mini player** and **Full screen** under it.
  - Over a Media3 stream, a tap shows previous / play-pause / next (through the grid the channel was picked from, wrapping round), mute and full screen; they hide after a few seconds of playback. A web page keeps its own controls.
  - **Full screen:** landscape with the system bars hidden; the title bar, picture-in-picture and exit sit on top. Back leaves full screen.
  - **Mini player:** a floating window over the whole app. Leaving the Live TV tab (or pressing Mini player) moves the picture into it without restarting the stream. Drag it anywhere (it settles against the nearer side), tap it to go back to Live TV, or close it with ×. It has play-pause and mute for media streams.
  - **Picture-in-picture:** while a channel plays, Home or Recents moves it into a system PiP window (Android 8+, on devices that support it); full screen also has a button for it.
  - The one player is drawn above every screen ([`TvPlayerLayer`](app/src/main/java/com/sportzfy/live/presentation/livetv/player/TvPlayerLayer.kt)) and only moves between the docked slot, the mini window and full screen, so switching never rebuffers. Opening a match stops the channel, so two streams never play at once.
- **Playback:** a media stream (HLS, DASH, MPEG-TS…) plays in Media3, as above. A web page opens like a browser tab.
  - Its page is loaded directly, not inside a frame (many channel pages refuse to run in someone else's frame).
  - It may hand off to its real player on another site.
  - No streamed.pk referrer is sent.
  - Pop-up windows and known ad hosts stay blocked, and fullscreen works as for matches.
  - A web page channel gets an **Open in browser** button under the player as a fallback.

## Search, saved matches and Android TV

- **Search:** results update as you type. A match is shown when every word you type appears in its title (which is where upstream puts league names, e.g. "Premier League: …"), its team names, its sport, or a common nickname for that sport ("soccer", "F1", "UFC", "NBA", "IPL" and so on).
- **Saved matches:** tap the star on a card, or in the Watch top bar, to save a match. Saved IDs are kept on the device with DataStore, newest first and capped at 200. The **Saved** pill filters the catalog down to them.
- **Android TV:**
  - The app appears in the TV launcher (`LEANBACK_LAUNCHER`) with its own banner, and neither touch nor leanback support is required to install it.
  - Anything you can select gets a 2dp rose border and a slight scale-up when the D-pad focuses it (`Modifier.tvFocus`).
  - Inside the player, Up/Down always move focus out of the WebView, so the remote can't get stuck in the page.

## Remote control

Every installed app reads its config from the Worker (`GET /api/app/config`) when it starts, and again every 5 minutes while it is open. Change it from the admin panel's **Android app** page (`/admin#/app`): maintenance mode, forced updates, the announcement banner, the featured match, hidden sports, player options and data sources. Saves reach installed apps within a minute, with no new APK needed. The last good config is saved on each device, so settings like maintenance mode still apply when the user is offline. If the Worker can't be reached, apps keep the previous config.

The page edits the fields below, and the Worker serves them in this shape. [`remote-config.json`](remote-config.json) holds the same shape. Builds released before the Worker config (version code 2 and earlier) still read that file from GitHub, so edit it too if you need to reach them.

| Field | Effect |
|---|---|
| `announcement.message` | A banner at the top of the catalog. Leave it `""` to hide the banner. |
| `announcement.url` | Optional https link that opens when the banner is tapped. |
| `featuredMatchId` | Pins this match into the spotlight while it's in today's feed. Match IDs are in the Streamed API (`/api/matches/all-today`). |
| `hiddenCategories` | Sports to hide completely, e.g. `["fight", "motor-sports"]`. Uses the Streamed category keys. |
| `adBlocking` | `true` also keeps the top-level page off the wider built-in ad list. Pop-ups and ad redirects stay blocked either way. |
| `extraBlockedHosts` | More hosts for the player to refuse, e.g. `["newads.example"]`. Subdomains are included. |
| `playerMode` | `"direct"` (the default; the embed page is the WebView itself, like a browser tab) or `"iframe"` (a plain, unsandboxed iframe, like the website). Ignored while `embedSandbox` is on, which always uses a frame. |
| `embedSandbox` | `true` (the default) runs the embed in a sandboxed iframe, so the frame itself refuses pop-ups, top-level navigation, downloads and pointer lock. The pop-up shim keeps `window.open` from answering `null`, so the embed's anti-sandbox check passes. Turn it off for a stream that refuses to play inside a sandbox. |
| `embedResolve` | `true` (the default) resolves an `embed.st` match page's real stream URL in a hidden WebView and plays it in Media3, with the page's own headers. Falls back to the web player when the URL can't be captured in 8 s. Turn it off to always use the web player. |
| `minVersionCode` | Builds with a lower `versionCode` (in `app/build.gradle.kts`) show an "Update required" screen. |
| `updateUrl` | Where that screen's button sends the user (https only). |
| `maintenance.enabled` / `maintenance.message` | `true` replaces the whole app with a maintenance screen showing the message. |
| `streamProxyUrl` | The website's Worker, which the app asks for a match's streams when streamed.pk blocks the phone (it sits behind DDoS-Guard). Defaults to `https://sportzfylive.svimranmy.workers.dev`; `""` turns the fallback off. |
| `channelsUrl` | Where Live TV loads its channel list from (https only). Defaults to `channels.json` in the playlist repo. |

## Testing

All tests run on the JVM with `./gradlew testDebugUnitTest`. No emulator is needed.

| Layer | What is covered |
|---|---|
| Network | Request paths, URL encoding and browser headers, against MockWebServer; mapping error codes to user-facing errors |
| Data | Merging the today and live feeds and setting match status, the stream-data cleanup, the 60-second caches, each failure-isolation path in both repositories, and reading channel lists (channels.json, plain JSON, M3U) |
| Domain / player | The `embed.st` URL builder, the WebView navigation and ad rules, choosing the engine and format (extension, `type` hint, http switch) and the Media3 error messages |
| Presentation logic | Filtering, search with aliases, the Saved filter, the spotlight pick, related matches, the default stream, and time labels |
| ViewModels | `CatalogViewModel` (sport filter, search, saving matches) and `WatchViewModel` (default stream, stream picker, switching match, missing match, failed sources, favourites) |
| UI (Robolectric) | Tapping a sport pill filters the rendered list; search narrows it; tapping a stream chip makes it the selected stream |

## Release builds

`assembleRelease` shrinks the code and resources with R8. Media3 (including the HLS and DASH modules it loads by reflection), Coil, OkHttp, Retrofit, kotlinx.serialization and Koin all ship their own keep rules. `app/proguard-rules.pro` adds only the app-specific ones: the generated serializers, the Retrofit service, and keeping line numbers so crash traces can be mapped back.

**Signing.** Set `SPORTZFY_KEYSTORE_FILE`, `SPORTZFY_KEYSTORE_PASSWORD`, `SPORTZFY_KEY_ALIAS` and `SPORTZFY_KEY_PASSWORD` to sign with your own key. Without them, the release APK is signed with the debug key so it can still be installed for testing.

**CI.** CI builds the release APK the same way. To sign with your own key there, add these repository secrets:
- `SPORTZFY_KEYSTORE_BASE64` (the base64-encoded `.jks` file)
- `SPORTZFY_KEYSTORE_PASSWORD`
- `SPORTZFY_KEY_ALIAS`
- `SPORTZFY_KEY_PASSWORD`

Each run uploads three artifacts: `sportzfy-release-apk` (the release APK plus `mapping.txt`), `sportzfy-debug-apk`, and, if the run fails, `test-reports`.
