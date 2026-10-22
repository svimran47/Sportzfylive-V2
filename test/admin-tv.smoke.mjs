// Functional smoke test for the Live TV catalog, site settings and the admin
// features added on top of the match sync: playlist parsing (channels.json,
// M3U), seeding, playlist sync, health checks, import, playback redirects,
// live-window expiry and cleanup, featured/active flags, manual stream
// playback, password rotation, the fetch log and the storage report.
// The stream proxy itself (http streams, HLS rewriting, tokens, logos) is
// covered by test/stream-proxy.smoke.mjs.
// Drives the real worker.js against a mocked KV and fetch.

import assert from "node:assert/strict";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

class PolyfillResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
  }
  static json(data, init = {}) {
    return new PolyfillResponse(JSON.stringify(data), init);
  }
  async json() {
    return JSON.parse(this.body);
  }
  async text() {
    return this.body;
  }
}
globalThis.Response = PolyfillResponse;

const fetchLog = [];
let routes = {};
globalThis.fetch = async (url) => {
  const key = String(url);
  fetchLog.push(key);
  const route = routes[key];
  if (!route) throw new Error("unexpected fetch: " + key);
  if (route instanceof Error) throw route;
  return route;
};

function reply(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: async () => {} },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined || value === null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    }
  };
}

const worker = (await import("../worker.js")).default;
const kv = makeKV();
const queueLog = [];
const env = {
  SPORTZFY_DB: kv,
  ADMIN_TOKEN: "test-token",
  SPORTZFY_SYNC_QUEUE: { async send(message) { queueLog.push(message); } }
};
const waits = [];
const ctx = { waitUntil(promise) { waits.push(promise); } };

let ipCounter = 10;
function req(path, { method = "GET", headers = {}, body } = {}) {
  const map = new Map(Object.entries({ "cf-connecting-ip": "192.0.2." + ipCounter, ...headers })
    .map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url: "https://worker.test" + path,
    method,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    }
  };
}
const call = async (path, options) => worker.fetch(req(path, options), env, ctx);

let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok " + passed + " - " + name); };

const login = async (secret) => {
  ipCounter += 1;
  return call("/api/admin/login", { method: "POST", headers: { "X-Admin-Token": secret } });
};
const session = (await (await login("test-token")).json()).session;
assert.ok(session, "login issues a session");
const admin = (path, method = "GET", body) =>
  call(path, { method, headers: { "X-Admin-Session": session }, body });

// ---------------------------------------------------------------------------
// Fixtures: the channels.json format (a JavaScript snippet wrapping a JSON
// list, with &amp; chains in logos) served from the default playlist URL
// (any supported format works there), and an M3U playlist.
// ---------------------------------------------------------------------------

const PLAYLIST_URL = "https://raw.githubusercontent.com/svimran46/playlist.m3u/main/channels.json";
const channelsJs = (list) => "const channels = " + JSON.stringify(list, null, 2) + ";\n";
const UPSTREAM = [
  { name: "ESPN", logo: "https://img.example/espn.png?a=1&amp;amp;b=2", genre: "Sports", url: "https://tv.example/espn", sandbox: true },
  { name: "Willow Cricket", logo: "https://img.example/willow.png", genre: "Sports", url: "https://tv.example/willow", sandbox: "true" },
  { name: "Sky Sports Premier League", logo: "", genre: "Sports", url: "https://tv.example/skypl", sandbox: 1 },
  { name: "Cartoon Network", logo: "http://insecure.example/cn.png", genre: "Sports", url: "https://tv.example/cn" },
  { name: "Duplicate ESPN", logo: "", genre: "Sports", url: "https://tv.example/espn" },
  { name: "Plain HTTP", logo: "", genre: "Sports", url: "http://tv.example/plain" },
  { name: "", logo: "", genre: "Sports", url: "https://tv.example/noname" }
];

console.log("# Live TV catalog");

// First public read seeds the catalog from the default playlist. Stream checks
// are advice, so the whole active catalog is served rather than an empty one.
routes[PLAYLIST_URL] = reply(200, channelsJs(UPSTREAM));
{
  const res = await call("/api/tv/channels");
  assert.equal(res.status, 200);
  assert.ok((await res.json()).channels.length > 0, "an unprobed catalog is served, not emptied");
  // Stand in for the cron probe: every synced channel verified on its current URL.
  const seeded = JSON.parse(kv.store.get("tv_channels")).channels;
  kv.store.set("tv_health", JSON.stringify({ channels: Object.fromEntries(seeded.map(c => [c.id, { url: c.url, working: true }])) }));
}
{
  const res = await call("/api/tv/channels");
  assert.equal(res.status, 200);
  assert.match(res.headers["Cache-Control"], /max-age=60/);
  const data = await res.json();
  assert.deepEqual(data.channels.map(c => c.name), ["ESPN", "Willow Cricket", "Sky Sports Premier League", "Cartoon Network", "Plain HTTP"]);
  assert.deepEqual(data.channels.map(c => c.category), ["Sports", "Cricket", "Football", "Kids", "Sports"],
    "unmatched names fall back to the default category (Sports)");
  assert.equal(data.channels[0].logo, "https://img.example/espn.png?a=1&b=2", "&amp; chains decoded");
  assert.match(data.channels[3].logo, /^\/api\/tv\/logo\/cartoon-network\?v=[0-9a-z]+$/, "http logos go through the logo proxy");
  assert.equal(data.channels[4].logo, "");
  assert.equal(data.channels[0].kind, "embed");
  assert.deepEqual(data.channels.map(c => c.sandbox), [true, true, false, false, false],
    "only \"sandbox\": true (or \"true\") sandboxes a channel, as in the Android app");
  assert.ok(!JSON.stringify(data).includes("tv.example"), "public channel list never carries stream URLs");
  assert.ok(!JSON.stringify(data).includes("insecure.example"), "public channel list never carries http logo hosts");
  assert.deepEqual(data.categories, ["Sports", "Football", "Cricket", "Kids"]);
  assert.deepEqual(data.groups, [], "channels.json entries carry no group");
  const stored = JSON.parse(kv.store.get("tv_channels"));
  assert.equal(stored.lastSync.trigger, "seed");
  assert.equal(stored.lastSync.skipped, 2, "duplicate and nameless entries skipped (http streams are kept)");
}
ok("first /api/tv/channels read seeds from the playlist, public list has no URLs");

{
  const res = await call("/api/play/tv/espn");
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "https://tv.example/espn");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  const missing = await call("/api/play/tv/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["Content-Security-Policy"], "sandbox");

  // http streams are never handed to the browser: the Worker proxies them
  // (the upstream is unreachable here, so the proxy answers 502).
  const plain = await call("/api/play/tv/plain-http");
  assert.equal(plain.status, 502);
  assert.equal(plain.headers.Location, undefined, "an http stream is never redirected to");
  assert.equal(plain.headers["Content-Security-Policy"], "sandbox");
}
ok("/api/play/tv/:id redirects https streams, proxies http ones; unknown ids get a sandboxed 404");

// Admin edits: manual channel, duplicate URL, bad URL, category lock, order.
{
  const created = await admin("/api/admin/tv/channels", "POST", {
    name: "BeIN Sports FIFA", logo: "https://img.example/bein.png", url: "https://cdn.example/bein/index.m3u8", sort: "", active: true
  });
  assert.equal(created.status, 201);
  const channel = (await created.json()).channel;
  assert.equal(channel.id, "bein-sports-fifa");
  assert.equal(channel.origin, "manual");
  assert.equal(channel.kind, "hls", ".m3u8 streams are played as HLS");
  assert.equal(channel.sandbox, false, "manual channels are not sandboxed unless asked");

  const dup = await admin("/api/admin/tv/channels", "POST", { name: "Copy", url: "https://cdn.example/bein/index.m3u8" });
  assert.equal(dup.status, 409);
  const bad = await admin("/api/admin/tv/channels", "POST", { name: "Bad", url: "ftp://insecure.example/live" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /http or https/);
  const badLogo = await admin("/api/admin/tv/channels", "POST", { name: "Bad logo", url: "https://cdn.example/x.m3u8", logo: "javascript:alert(1)" });
  assert.equal(badLogo.status, 400);

  // http streams and logos are accepted (and played through the Worker); a
  // Kodi `|User-Agent=` suffix becomes request headers.
  const http = await admin("/api/admin/tv/channels", "POST", {
    name: "Rai Sport HD", group: "Italy", logo: "http://203.0.113.5/logos/rai.png",
    url: "http://iptv.example:8080/live/user/pass/1001.ts|User-Agent=VLC%2F3.0&Referer=https://ref.example/", proxy: "false"
  });
  assert.equal(http.status, 201);
  const httpChannel = (await http.json()).channel;
  assert.equal(httpChannel.id, "italy-rai-sport-hd", "ids include the group");
  assert.equal(httpChannel.url, "http://iptv.example:8080/live/user/pass/1001.ts", "pipe headers stripped from the URL");
  assert.deepEqual(httpChannel.headers, { userAgent: "VLC/3.0", referer: "https://ref.example/" });
  assert.equal(httpChannel.kind, "ts");
  assert.equal(httpChannel.proxied, true);
  assert.equal(httpChannel.proxy, false);
  assert.equal(httpChannel.category, "Sports");
  assert.match(httpChannel.logoSrc, /^\/api\/tv\/logo\/italy-rai-sport-hd\?v=/);
  const proxied = await admin("/api/admin/tv/channels/italy-rai-sport-hd", "PUT", { proxy: true, group: "Italia" });
  const proxiedChannel = (await proxied.json()).channel;
  assert.equal(proxiedChannel.proxy, true);
  assert.equal(proxiedChannel.group, "Italia");
  assert.equal(proxiedChannel.id, "italy-rai-sport-hd", "edits keep the id");
  assert.deepEqual(proxiedChannel.headers, { userAgent: "VLC/3.0", referer: "https://ref.example/" }, "headers survive edits");
  assert.equal((await admin("/api/admin/tv/channels/italy-rai-sport-hd", "DELETE")).status, 200);

  const edited = await admin("/api/admin/tv/channels/espn", "PUT", { category: "News", sort: 1, active: false });
  assert.equal(edited.status, 200);
  const espn = (await edited.json()).channel;
  assert.equal(espn.category, "News");
  assert.equal(espn.categoryLocked, true);
  assert.equal(espn.sort, 1);

  // Stand in for the cron probe again: the current catalog verified on its current URLs.
  const current = JSON.parse(kv.store.get("tv_channels")).channels;
  kv.store.set("tv_health", JSON.stringify({ channels: Object.fromEntries(current.map(c => [c.id, { url: c.url, working: true }])) }));
  const publicList = await (await call("/api/tv/channels")).json();
  assert.ok(!publicList.channels.some(c => c.id === "espn"), "inactive channels are hidden publicly");
  assert.equal((await call("/api/play/tv/espn")).status, 404, "inactive channels do not play");
  assert.equal(publicList.channels.find(c => c.id === "bein-sports-fifa").kind, "hls");
}
ok("admin channel CRUD validates https URLs, rejects duplicates, locks categories");

// Re-sync: upstream renames a channel, drops one and adds one. Manual channels
// survive; admin status/order/category on synced channels survive.
{
  routes[PLAYLIST_URL] = reply(200, channelsJs([
    { name: "ESPN", logo: "", url: "https://tv.example/espn", sandbox: false },
    { name: "Willow Cricket", logo: "", url: "https://tv.example/willow-v2" },
    { name: "NBA TV", logo: "", url: "https://tv.example/nba" }
  ]));
  const res = await admin("/api/admin/tv/sync", "POST");
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.added, 1);
  assert.equal(result.removed, 3, "Sky Sports PL, Cartoon Network and Plain HTTP dropped upstream");

  const list = (await (await admin("/api/admin/tv/channels")).json()).channels;
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  assert.equal(byId.espn.active, false, "admin deactivation survives a sync");
  assert.equal(byId.espn.category, "News", "locked category survives a sync");
  assert.equal(byId.espn.sort, 1);
  assert.equal(byId.espn.sandbox, false, "the playlist's sandbox flag is followed on every sync");
  assert.equal(byId["willow-cricket"].url, "https://tv.example/willow-v2", "URL refreshed, id kept (matched by name)");
  assert.ok(byId["bein-sports-fifa"], "manual channel survives a sync");
  assert.equal(list[0].id, "espn", "explicit sort order comes first");
}
ok("playlist sync refreshes synced channels and keeps manual ones and admin choices");

// Health check: 200 and bot-blocking 403 pass; 404, 5xx and dead hosts fail.
{
  routes["https://check.example/a"] = reply(200, "");
  routes["https://check.example/b"] = reply(403, "");
  routes["https://check.example/c"] = reply(404, "");
  routes["https://check.example/d"] = reply(522, "");
  routes["https://check.example/e"] = new TypeError("dns failure");
  routes["http://check.example/f"] = reply(200, "");
  const res = await admin("/api/admin/tv/check", "POST", {
    urls: ["https://check.example/a", "https://check.example/b", "https://check.example/c", "https://check.example/d", "https://check.example/e", "http://check.example/f", "ftp://check.example/g"]
  });
  const results = (await res.json()).results;
  assert.deepEqual(results.map(r => r.ok), [true, true, false, false, false, true, false], "http streams can be checked too");
  assert.equal(results[4].error, "unreachable");
  assert.equal(results[6].error, "not an http(s) URL");

  const tooMany = await admin("/api/admin/tv/check", "POST", { urls: Array.from({ length: 26 }, (_, i) => "https://x.example/" + i) });
  assert.equal(tooMany.status, 400, "batches are capped to stay inside the subrequest limit");
}
ok("stream health check classifies live and dead streams");

// Import from URL: an M3U playlist is parsed (quoted commas, group-title
// categories), known URLs are flagged, and import adds only new channels.
{
  routes["https://lists.example/sports.m3u"] = reply(200, [
    "#EXTM3U",
    "#EXTINF:-1 tvg-id=\"a\" tvg-logo=\"https://img.example/a.png\" group-title=\"Football\",Channel, With Comma",
    "#EXTVLCOPT:http-user-agent=Mozilla",
    "https://m3u.example/a.m3u8",
    "#EXTINF:-1 group-title=\"News\",Known ESPN",
    "https://tv.example/espn",
    "#EXTINF:-1,Third",
    "https://m3u.example/c"
  ].join("\n"));
  const parsed = await (await admin("/api/admin/tv/parse", "POST", { url: "https://lists.example/sports.m3u" })).json();
  assert.equal(parsed.total, 3);
  assert.equal(parsed.entries[0].name, "Channel, With Comma");
  assert.equal(parsed.entries[0].category, "Football");
  assert.equal(parsed.entries[0].group, "Football");
  assert.deepEqual(parsed.entries[0].headers, { userAgent: "Mozilla" }, "#EXTVLCOPT user agent is kept");
  assert.equal(parsed.entries[0].logo, "https://img.example/a.png");
  assert.equal(parsed.entries[1].exists, true, "already-known stream URLs are flagged");
  assert.equal(parsed.entries[2].category, "Sports", "no group or name match: the default category");

  const imported = await (await admin("/api/admin/tv/import", "POST", { channels: parsed.entries })).json();
  assert.equal(imported.added, 2);
  assert.equal(imported.skipped, 1);
  const catalog = (await (await admin("/api/admin/tv/channels")).json()).channels;
  const withComma = catalog.find(c => c.id === "football-channel-with-comma");
  assert.ok(withComma, "imported ids include the group");
  assert.deepEqual(withComma.headers, { userAgent: "Mozilla" });
  assert.equal(withComma.proxied, true, "channels with request headers play through the Worker");

  const notJson = await admin("/api/admin/tv/parse", "POST", { url: "https://lists.example/sports.m3u-bad" });
  assert.equal(notJson.status, 400, "an unreachable playlist is a clean 400");
}
ok("import parses M3U playlists and adds only channels not already in the catalog");

{
  const res = await admin("/api/admin/tv/channels/bulk", "POST", { action: "deactivate", ids: ["third", "nba-tv"] });
  assert.equal((await res.json()).affected, 2);
  assert.equal((await admin("/api/admin/tv/channels", "DELETE")).status, 400, "delete-all needs confirm=all");
  const wiped = await (await admin("/api/admin/tv/channels?confirm=all", "DELETE")).json();
  assert.ok(wiped.removed >= 5);
  const after = await (await call("/api/tv/channels")).json();
  assert.equal(after.channels.length, 0, "an emptied catalog is not silently re-seeded");
}
ok("bulk status changes and delete-all (with confirmation)");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

console.log("# settings");

{
  const data = await (await admin("/api/admin/settings")).json();
  assert.equal(data.settings.tvSource.url, PLAYLIST_URL);
  assert.equal(data.settings.tvSource.defaultCategory, "Sports");
  assert.ok(data.tvCategories.includes("Motorsport") && data.tvCategories.includes("Horse Racing"));

  const badCategory = await admin("/api/admin/settings/tvSource", "PUT", { defaultCategory: "Quidditch" });
  assert.equal(badCategory.status, 400);
  const legacy = await (await admin("/api/admin/settings/tvSource", "PUT", {
    url: "https://raw.githubusercontent.com/svimran46/Sportzfylive-V2/main/public/sports.m3u", defaultCategory: "entertainment"
  })).json();
  assert.equal(legacy.settings.tvSource.url, PLAYLIST_URL, "the retired sports.m3u source maps to the default");
  assert.equal(legacy.settings.tvSource.defaultCategory, "Entertainment");
  assert.equal(legacy.tvSync, undefined, "same source: no resync");
  await admin("/api/admin/settings/tvSource", "PUT", { defaultCategory: "Sports" });
  assert.equal(data.settings.liveWindows.defaultHours, 3);
  assert.equal(data.security.passwordSource, "env");
  assert.ok(data.sportCategories.some(c => c.key === "FIGHT" && c.label === "UFC & MMA"));

  const badColour = await admin("/api/admin/settings/notice", "PUT", { enabled: true, text: "Hi", bg: "blue" });
  assert.equal(badColour.status, 400);
  const badLink = await admin("/api/admin/settings/notice", "PUT", { enabled: true, text: "Hi", link: "javascript:alert(1)" });
  assert.equal(badLink.status, 400);
  const noGa = await admin("/api/admin/settings/analytics", "PUT", { gaEnabled: true, gaId: "" });
  assert.equal(noGa.status, 400);
  assert.equal((await admin("/api/admin/settings/nope", "PUT", {})).status, 404);

  assert.equal((await admin("/api/admin/settings/notice", "PUT", {
    enabled: true, text: "Get the app", link: "/live-tv", newTab: false, bg: "#1D4ED8", marquee: true
  })).status, 200);
  assert.equal((await admin("/api/admin/settings/analytics", "PUT", { gaEnabled: true, gaId: "g-6sbqpdx9k4" })).status, 200);
  assert.equal((await admin("/api/admin/settings/identity", "PUT", { siteName: "Sportzfy Play", contactEmail: "info@sportzfyplay.com" })).status, 200);

  const content = await (await call("/api/site-content")).json();
  assert.equal(content.notice.enabled, true);
  assert.equal(content.notice.bg, "#1d4ed8");
  assert.equal(content.notice.link, "/live-tv");
  assert.equal(content.analytics.gaId, "G-6SBQPDX9K4");
  assert.equal(content.identity.siteName, "Sportzfy Play");
  assert.ok(!("tvSource" in content) && !("liveWindows" in content), "only public settings are published");
  const stored = JSON.parse(kv.store.get("site_settings"));
  assert.ok(stored.updated.notice, "each section records when it last changed");
}
ok("settings validate per section and publish only the public parts");

console.log("# android app config");

{
  // Untouched, the app gets exactly what android/remote-config.json ships.
  const res = await call("/api/app/config");
  assert.equal(res.status, 200);
  assert.match(res.headers["Cache-Control"], /max-age=30/);
  const fresh = await res.json();
  assert.equal(fresh.maintenance.enabled, false);
  assert.equal(fresh.minVersionCode, 0);
  assert.equal(fresh.playerMode, "direct");
  assert.ok(!("streamProxyUrl" in fresh), "app default proxy applies when nothing is set");

  const settings = await (await admin("/api/admin/settings")).json();
  assert.ok(settings.appSports.some(sport => sport.key === "motor-sports"), "dashboard lists the app's sports");

  const bad = (body) => admin("/api/admin/settings/app", "PUT", body);
  assert.equal((await bad({ hiddenCategories: ["quidditch"] })).status, 400);
  assert.equal((await bad({ extraBlockedHosts: "not a host!" })).status, 400);
  assert.equal((await bad({ updateUrl: "http://insecure.example/app.apk" })).status, 400);
  assert.equal((await bad({ minVersionCode: 5, updateUrl: "" })).status, 400, "a forced update needs somewhere to go");
  assert.equal((await bad({ announcementUrl: "javascript:alert(1)" })).status, 400);
  assert.equal((await bad({ channelsUrl: "http://x.example/c.json" })).status, 400);

  const saved = await admin("/api/admin/settings/app", "PUT", {
    maintenanceEnabled: true, maintenanceMessage: "Back at 9pm",
    minVersionCode: "7", updateUrl: "https://example.com/sportzfy.apk",
    announcementMessage: "  Final tonight!  ", announcementUrl: "https://t.me/sportzfy",
    featuredMatchId: "match-1", hiddenCategories: ["Fight", "motor_sports", "fight"],
    adBlocking: true, extraBlockedHosts: "*.Bad-Ads.com.\nevil.net evil.net",
    playerMode: "iframe", channelsUrl: "https://example.com/channels.json",
    streamProxyEnabled: false
  });
  assert.equal(saved.status, 200);

  const config = await (await call("/api/app/config")).json();
  assert.deepEqual(config, {
    announcement: { message: "Final tonight!", url: "https://t.me/sportzfy" },
    featuredMatchId: "match-1",
    hiddenCategories: ["fight", "motor-sports"],
    adBlocking: true,
    extraBlockedHosts: ["bad-ads.com", "evil.net"],
    playerMode: "iframe",
    minVersionCode: 7,
    updateUrl: "https://example.com/sportzfy.apk",
    maintenance: { enabled: true, message: "Back at 9pm" },
    channelsUrl: "https://example.com/channels.json",
    streamProxyUrl: ""
  });

  // Partial saves keep the other fields, and a custom proxy is passed through.
  await admin("/api/admin/settings/app", "PUT", { maintenanceEnabled: false, streamProxyEnabled: true, streamProxyUrl: "https://proxy.example.com" });
  const after = await (await call("/api/app/config")).json();
  assert.equal(after.maintenance.enabled, false);
  assert.equal(after.announcement.message, "Final tonight!");
  assert.equal(after.streamProxyUrl, "https://proxy.example.com/");

  const content = await (await call("/api/site-content")).json();
  assert.ok(!("app" in content) && !JSON.stringify(content).includes("Final tonight"), "app config never leaks into the website's content");
  assert.equal((await call("/api/app/config", { method: "POST" })).status, 404);

  // Put the shared KV back so later suites see the defaults.
  const reset = JSON.parse(kv.store.get("site_settings"));
  delete reset.app;
  kv.store.set("site_settings", JSON.stringify(reset));
}
ok("app config validates, publishes the app's wire shape and stays off the website");

// ---------------------------------------------------------------------------
// Matches: auto sport, featured image, active/featured flags, manual stream
// playback, live windows and cleanup.
// ---------------------------------------------------------------------------

console.log("# matches");

const HOUR = 60 * 60 * 1000;
let fightId;
let oldId;
{
  const created = await admin("/api/admin/matches", "POST", {
    title: "Dana White's Contender Series: Season 10, Week 10",
    category: "AUTO",
    startTime: new Date(Date.now() - HOUR).toISOString(),
    image: "https://img.example/banner.jpg",
    featured: true,
    streams: [
      { id: "s1", name: "Stream 1", language: "English", quality: "HD", url: "https://tv.example/ufc", sandbox: true },
      { id: "s2", name: "Stream 2", language: "English", quality: "SD", url: "https://cdn.example/ufc.m3u8" },
      { id: "s3", name: "Notes only", language: "English", quality: "SD" },
      { id: "s4", name: "Stream 4", language: "English", quality: "HD", url: "http://iptv.example:8080/live/user/pass/1001.ts" }
    ]
  });
  assert.equal(created.status, 201);
  const match = (await created.json()).match;
  fightId = match.id;
  assert.equal(match.category, "FIGHT", "sport detected from the event text");
  assert.equal(match.status, "auto");
  const expires = Date.parse(match.expiresAt) - Date.parse(match.startTime);
  assert.equal(expires, 5.5 * HOUR, "UFC & MMA window applied");

  const badStream = await admin("/api/admin/matches", "POST", { title: "X", streams: [{ name: "Bad", url: "javascript:alert(1)" }] });
  assert.equal(badStream.status, 400);

  const old = await (await admin("/api/admin/matches", "POST", {
    title: "Old Cup Final", category: "FOOTBALL", startTime: new Date(Date.now() - 10 * HOUR).toISOString()
  })).json();
  oldId = old.match.id;
}
{
  const list = await (await call("/api/matches/all-today")).json();
  const fight = list.find(m => m.id === fightId);
  assert.equal(fight.status, "live", "auto status is live inside the window");
  assert.equal(fight.poster, "https://img.example/banner.jpg", "featured image replaces the feed poster");
  assert.equal(fight.featured, true);
  assert.deepEqual(fight.manual.streams.map(s => [s.id, s.kind, s.sandbox]), [["s1", "embed", true], ["s2", "hls", false], ["s4", "ts", false]]);
  assert.ok(!JSON.stringify(list).includes("tv.example"), "manual stream URLs stay private");
  assert.ok(!list.some(m => m.id === oldId), "matches past their live window are hidden publicly");

  const play = await call("/api/play/stream/" + encodeURIComponent(fightId) + "/s1");
  assert.equal(play.status, 302);
  assert.equal(play.headers.Location, "https://tv.example/ufc");
  assert.equal((await call("/api/play/stream/" + encodeURIComponent(fightId) + "/s3")).status, 404);
  const proxiedStream = await call("/api/play/stream/" + encodeURIComponent(fightId) + "/s4");
  assert.equal(proxiedStream.status, 502, "http match streams play through the Worker (upstream unreachable here)");
  assert.equal(proxiedStream.headers.Location, undefined);

  const content = await (await call("/api/site-content")).json();
  assert.equal(content.featuredMatches[0].id, fightId);
  assert.equal(content.featuredMatch.id, fightId);
}
ok("manual matches: auto sport, featured image, featured list, stream playback via redirect");

{
  const off = await admin("/api/admin/matches/bulk", "POST", { action: "deactivate", ids: [fightId] });
  assert.equal((await off.json()).affected, 1);
  const list = await (await call("/api/matches/all-today")).json();
  assert.ok(!list.some(m => m.id === fightId), "inactive matches are hidden publicly");
  assert.equal((await call("/api/play/stream/" + encodeURIComponent(fightId) + "/s1")).status, 404, "inactive matches do not play");
  await admin("/api/admin/matches/bulk", "POST", { action: "activate", ids: [fightId] });

  const override = await (await admin("/api/admin/matches/" + encodeURIComponent(fightId), "PUT", { liveWindowOverride: 30 })).json();
  assert.equal(Date.parse(override.match.expiresAt) - Date.parse(override.match.startTime), 30 * 60 * 1000, "per-match override wins");
  assert.equal((await admin("/api/admin/matches/" + encodeURIComponent(fightId), "PUT", { liveWindowOverride: "abc" })).status, 400);
  await admin("/api/admin/matches/" + encodeURIComponent(fightId), "PUT", { liveWindowOverride: "" });

  // Raising the football window brings the old match back; cleanup then
  // deletes what is still past its window.
  const saved = await (await admin("/api/admin/settings/liveWindows", "PUT", {
    defaultHours: 3,
    categories: { FOOTBALL: 12 },
    types: [{ name: "Cup finals", keywords: "cup final", hours: 1 }]
  })).json();
  assert.ok(saved.matchesUpdated >= 1, "stored expiries follow new rules");
  const stillHidden = await (await call("/api/matches/all-today")).json();
  assert.ok(!stillHidden.some(m => m.id === oldId), "match-type keywords beat the category window");

  const cleanup = await (await admin("/api/admin/cleanup", "POST")).json();
  assert.equal(cleanup.removed, 1);
  const stored = JSON.parse(kv.store.get("matches"));
  assert.ok(!stored.some(m => m.id === oldId), "cleanup deletes expired matches");
  assert.ok(stored.some(m => m.id === fightId));
}
ok("active flag, per-match override, live-window rules and cleanup");

{
  assert.equal((await admin("/api/admin/matches", "DELETE")).status, 400, "delete-all needs confirm=all");
  const wiped = await (await admin("/api/admin/matches?confirm=all", "DELETE")).json();
  assert.equal(wiped.removed, 1);
  assert.deepEqual(JSON.parse(kv.store.get("matches")), []);
}
ok("delete all matches requires confirmation");

// ---------------------------------------------------------------------------
// Sync log, schedule ingest toggle, storage report.
// ---------------------------------------------------------------------------

console.log("# system");

{
  routes["https://streamed.pk/api/matches/all-today"] = reply(500, "[]");
  const failed = await admin("/api/admin/sync-streamed", "POST");
  assert.equal(failed.status, 502);
  routes["https://streamed.pk/api/matches/all-today"] = reply(200, JSON.stringify([
    { id: "201", title: "Lens vs Sporting CP", category: "football", date: Date.now(), sources: [] }
  ]));
  routes["https://streamed.pk/api/matches/live"] = reply(200, "[]");
  const good = await (await admin("/api/admin/sync-streamed", "POST")).json();
  assert.equal(good.streamedCount, 1);

  const log = await (await admin("/api/admin/sync-log")).json();
  assert.equal(log.runs.length, 2);
  assert.equal(log.runs[0].ok, true, "newest run first");
  assert.equal(log.runs[0].trigger, "admin");
  assert.equal(log.runs[1].ok, false);
  assert.match(log.runs[1].error, /500/);
  assert.ok(log.tv && log.tv.lastSync, "TV playlist sync status is reported too");
}
ok("fetch log records successful and failed syncs, newest first");

{
  await admin("/api/admin/settings/ingest", "PUT", { autoSync: false });
  await admin("/api/admin/settings/tvSource", "PUT", { autoSync: false });
  queueLog.length = 0;
  await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env);
  assert.equal(queueLog.length, 0, "auto sync off: cron does not queue a sync");
  await admin("/api/admin/settings/ingest", "PUT", { autoSync: true });
  await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env);
  assert.equal(queueLog.length, 1);
}
ok("schedule ingest toggle gates the cron sync");

{
  const report = await (await admin("/api/admin/storage")).json();
  assert.equal(report.ok, true);
  const byKey = Object.fromEntries(report.records.map(r => [r.key, r]));
  assert.equal(byKey.matches.present, true);
  assert.equal(byKey.matches.items, 1);
  assert.equal(byKey.tv_channels.present, true);
  assert.equal(byKey.admin_credential.present, false);
}
ok("storage report lists the KV records");

// ---------------------------------------------------------------------------
// Admin password rotation.
// ---------------------------------------------------------------------------

console.log("# admin password");

{
  const wrong = await admin("/api/admin/password", "POST", { current: "nope", next: "a-new-password" });
  assert.equal(wrong.status, 403);
  const short = await admin("/api/admin/password", "POST", { current: "test-token", next: "short" });
  assert.equal(short.status, 400);
  const changed = await admin("/api/admin/password", "POST", { current: "test-token", next: "a-new-password" });
  assert.equal(changed.status, 200);
  const credential = JSON.parse(kv.store.get("admin_credential"));
  assert.ok(!kv.store.get("admin_credential").includes("a-new-password"), "only a hash is stored");
  assert.match(credential.hash, /^[0-9a-f]{64}$/);

  assert.equal((await login("test-token")).status, 401, "the env token stops working once a password is set");
  assert.equal((await login("a-new-password")).status, 200, "the new password logs in");
  assert.equal((await admin("/api/admin/session")).status, 200, "existing sessions stay valid");
  assert.equal((await admin("/api/admin/settings").then(r => r.json())).security.passwordSource, "custom");

  const reset = await admin("/api/admin/password", "DELETE", { current: "a-new-password" });
  assert.equal(reset.status, 200);
  assert.equal((await login("test-token")).status, 200, "reset hands login back to ADMIN_TOKEN");
}
ok("password change stores a salted hash, replaces the env token, and resets");

{
  const unauth = await call("/api/admin/tv/channels");
  assert.equal(unauth.status, 401);
  const unauthSettings = await call("/api/admin/settings/notice", { method: "PUT", body: {} });
  assert.equal(unauthSettings.status, 401);
}
ok("every new admin route requires a session");

console.log("\nAll " + passed + " admin/TV assertions passed.");
