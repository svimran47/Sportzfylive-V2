// Functional smoke test for Live TV playback through the Worker: playlist
// formats (an IPTV M3U shape: groups, http Xtream streams, http logos; and the
// channels.json JS snippet),
// the stream proxy (http and raw MPEG-TS streams, request headers, HLS playlist
// rewriting, DASH, sealed /s/ and /b/ tokens, Range), the logo proxy, the
// default category and the playlist source switch.
// Drives the real worker.js with Node's native Request/Response/Headers and a
// mocked KV and fetch. Every URL here is synthetic: tests must never contain
// the real playlist's hosts or credentials.

import assert from "node:assert/strict";

const worker = (await import("../worker.js")).default;

const BASE = "https://worker.test";
const PLAYLIST_URL = "https://raw.githubusercontent.com/svimran46/playlist.m3u/main/channels.json";
const LEGACY_URL = "https://raw.githubusercontent.com/svimran46/Sportzfylive-V2/main/public/sports.m3u";

// Strings that must never reach a viewer: upstream hosts and the login.
const SECRETS = [
  "iptv.example", "user/pass", "203.0.113.10", "dash.example", "secure.example",
  "pipe.example", "keys.example", "other.example", "edge.example",
  "player.example", "real.example", "trap.example"
];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const upstreamLog = [];
let upstream = {};
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const call = { url, method: init.method || "GET", headers: new Headers(init.headers || {}) };
  upstreamLog.push(call);
  const handler = upstream[url];
  if (!handler) throw new TypeError("unexpected fetch: " + url);
  return handler(call);
};

// A native Response; `url` (the final URL after redirects) is settable.
function respond(body, { status = 200, headers = {}, url } = {}) {
  const response = new Response(body, { status, headers });
  if (url) Object.defineProperty(response, "url", { value: url });
  return response;
}

// An endless live MPEG-TS stream that records how far it was read.
function liveStream() {
  const state = { pulls: 0, cancelled: false };
  state.stream = new ReadableStream({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new Uint8Array(188).fill(0x47));
    },
    cancel() {
      state.cancelled = true;
    }
  });
  return state;
}

function makeKV() {
  const store = new Map();
  const kv = {
    store,
    gets: 0,
    async get(key, type) {
      kv.gets++;
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
  return kv;
}

function makeEnv(extra = {}) {
  return {
    SPORTZFY_DB: makeKV(),
    ADMIN_TOKEN: "test-token",
    SPORTZFY_SYNC_QUEUE: { async send() {} },
    ...extra
  };
}

const waits = [];
const ctx = { waitUntil(promise) { waits.push(promise); } };
async function drain() {
  while (waits.length) await waits.shift().catch(() => {});
}

let ipCounter = 1;
function call(env, path, { method = "GET", headers = {}, body } = {}) {
  const request = new Request(BASE + path, {
    method,
    headers: { "cf-connecting-ip": "192.0.2." + ipCounter, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  return worker.fetch(request, env, ctx);
}

async function adminSession(env) {
  ipCounter++;
  const res = await call(env, "/api/admin/login", { method: "POST", headers: { "X-Admin-Token": env.ADMIN_TOKEN || "test-token" } });
  const { session } = await res.json();
  assert.ok(session, "admin login");
  return (path, method = "GET", body) => call(env, path, { method, headers: { "X-Admin-Session": session }, body });
}

function headerBlob(res) {
  return [...res.headers].map(([name, value]) => name + ": " + value).join("\n");
}

function assertPrivate(label, ...texts) {
  const blob = texts.join("\n");
  for (const secret of SECRETS) {
    assert.ok(!blob.includes(secret), label + " must not contain " + secret);
  }
}

// /api/play/... paths in a rewritten playlist, in order.
function playlistUris(text) {
  return text.split("\n").filter(line => line && !line.startsWith("#"));
}

// Moves the clock (Date.now and new Date()) forward by offsetMs.
const RealDate = Date;
function travel(offsetMs) {
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + offsetMs);
    }
    static now() {
      return RealDate.now() + offsetMs;
    }
  };
}
function restoreClock() {
  globalThis.Date = RealDate;
}

let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok " + passed + " - " + name); };

// ---------------------------------------------------------------------------
// Fixture: shaped like the M3U playlists IPTV panels publish (header with url-tvg, tvg-id /
// tvg-name / tvg-logo / group-title, http Xtream live .ts streams, names
// repeated across groups) plus a few channels exercising other formats.
// ---------------------------------------------------------------------------

const xtream = (id) => "http://iptv.example:8080/live/user/pass/" + id + ".ts";
const entry = (group, name, logo, url, extra = []) => [
  "#EXTINF:-1 tvg-id=\"\" tvg-name=\"" + name + "\" tvg-logo=\"" + logo + "\" group-title=\"" + group + "\"," + name,
  ...extra,
  url
];
const SPORTS_M3U = [
  "#EXTM3U url-tvg=\"http://iptv.example:8080/xmltv.php?username=user&password=pass\" x-tvg-url=\"http://iptv.example:8080/xmltv.php?username=user&password=pass\"",
  ...entry("Afghanistan", "RTA SPORTS HD", "http://203.0.113.10/logos/rta.png", xtream(1000)),
  ...entry("France", "EUROSPORT 2 HD", "http://203.0.113.10/logos/es2.png", xtream(1002)),
  ...entry("Italy", "EUROSPORT 2 HD", "http://203.0.113.10/logos/es2.png", xtream(1001)),
  ...entry("United Kingdom", "SKY SPORTS F1 HD", "https://logos.example/f1.png", xtream(1003)),
  ...entry("World", "HISTORY CHANNEL", "", xtream(1006)),
  ...entry("World", "SPORT HLS", "", "https://cdn.example/live/master.m3u8"),
  ...entry("World", "DASH SPORT", "", "https://dash.example/live/stream/manifest.mpd?auth=1", ["#EXTVLCOPT:http-referrer=https://ref.example/"]),
  ...entry("Serbia", "ARENA SPORT 1", "", "https://secure.example/arena/index.m3u8", [
    "#EXTVLCOPT:http-user-agent=MyAgent/1.0",
    "#EXTVLCOPT:http-referrer=https://ref.example/page",
    "#EXTVLCOPT:http-origin=https://ref.example"
  ]),
  ...entry("Spain", "PIPE TV", "", "http://pipe.example/live/stream.flv|User-Agent=Pipe%20Agent&Referer=https://pipe-ref.example/"),
  ...entry("Cricket", "WILLOW HD", "", xtream(1004)),
  ...entry("Horse Racing", "SKY RACING 1", "", xtream(1005))
].join("\r\n") + "\r\n";

upstream[PLAYLIST_URL] = () => respond(SPORTS_M3U, { headers: { "Content-Type": "audio/x-mpegurl" } });

const env = makeEnv();
const admin = await adminSession(env);

console.log("# M3U playlist catalog");

let catalog;
{
  // The first read seeds the catalog. Stream checks are advice, so the whole
  // active catalog is served whether or not anything has been probed.
  const unverified = await call(env, "/api/tv/channels");
  const unprobed = JSON.parse(await unverified.text());
  assert.ok(unprobed.channels.length > 0, "an unprobed catalog is served, not emptied");
  assert.ok(unprobed.channels.some(c => c.id === "italy-eurosport-2-hd"), "…with its channels in it");
  // Stand in for the cron probe: every synced channel verified on its current URL.
  const seeded = JSON.parse(env.SPORTZFY_DB.store.get("tv_channels")).channels;
  env.SPORTZFY_DB.store.set("tv_health", JSON.stringify({ channels: Object.fromEntries(seeded.map(c => [c.id, { url: c.url, working: true }])) }));
  const res = await call(env, "/api/tv/channels");
  assert.equal(res.status, 200);
  const text = await res.text();
  catalog = JSON.parse(text);
  const byId = Object.fromEntries(catalog.channels.map(c => [c.id, c]));
  assert.deepEqual(catalog.channels.map(c => c.id), [
    "afghanistan-rta-sports-hd", "france-eurosport-2-hd", "italy-eurosport-2-hd", "united-kingdom-sky-sports-f1-hd",
    "world-history-channel", "world-sport-hls", "world-dash-sport", "serbia-arena-sport-1", "spain-pipe-tv",
    "cricket-willow-hd", "horse-racing-sky-racing-1"
  ], "ids are slug(group + name): repeated names stay distinct");
  assert.equal(byId["italy-eurosport-2-hd"].group, "Italy");
  assert.equal(byId["italy-eurosport-2-hd"].kind, "ts", "Xtream .ts streams play as MPEG-TS");
  assert.equal(byId["world-sport-hls"].kind, "hls");
  assert.equal(byId["world-dash-sport"].kind, "dash");
  assert.equal(byId["spain-pipe-tv"].kind, "flv");
  assert.deepEqual(
    ["united-kingdom-sky-sports-f1-hd", "cricket-willow-hd", "horse-racing-sky-racing-1", "world-history-channel", "afghanistan-rta-sports-hd"]
      .map(id => byId[id].category),
    ["Motorsport", "Cricket", "Horse Racing", "Sports", "Sports"],
    "group-title names a category when it can; names next; then the default (Sports)"
  );
  assert.match(byId["italy-eurosport-2-hd"].logo, /^\/api\/tv\/logo\/italy-eurosport-2-hd\?v=[0-9a-z]+$/, "http logos become a root-relative logo path");
  assert.equal(byId["united-kingdom-sky-sports-f1-hd"].logo, "https://logos.example/f1.png", "https logos stay as they are");
  assert.equal(byId["world-history-channel"].logo, "");
  assert.deepEqual(catalog.groups, ["Afghanistan", "France", "Italy", "United Kingdom", "World", "Serbia", "Spain", "Cricket", "Horse Racing"]);
  assert.deepEqual(catalog.categories, ["Sports", "Cricket", "Motorsport", "Horse Racing"]);
  for (const channel of catalog.channels) {
    assert.deepEqual(Object.keys(channel).sort(), ["category", "group", "id", "kind", "logo", "name", "sandbox"]);
  }
  assertPrivate("public channel list", text, headerBlob(res));
  assert.ok(!text.includes("ref.example") && !text.includes("MyAgent"), "request headers stay private");

  const stored = JSON.parse(env.SPORTZFY_DB.store.get("tv_channels"));
  const arena = stored.channels.find(c => c.id === "serbia-arena-sport-1");
  assert.deepEqual(arena.headers, { userAgent: "MyAgent/1.0", referer: "https://ref.example/page", origin: "https://ref.example" });
  const pipe = stored.channels.find(c => c.id === "spain-pipe-tv");
  assert.equal(pipe.url, "http://pipe.example/live/stream.flv", "Kodi pipe headers are stripped from the URL");
  assert.deepEqual(pipe.headers, { userAgent: "Pipe Agent", referer: "https://pipe-ref.example/" });
  assert.ok(!("headers" in stored.channels.find(c => c.id === "italy-eurosport-2-hd")), "no headers: the field is omitted");
  assert.equal(stored.source, PLAYLIST_URL);
}
ok("M3U-shaped playlist: group ids, kinds, categories, groups, logo paths, nothing private in public JSON");

{
  const list = (await (await admin("/api/admin/tv/channels")).json()).channels;
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  assert.equal(byId["italy-eurosport-2-hd"].proxied, true);
  assert.equal(byId["world-sport-hls"].proxied, false, "https HLS without headers is redirected");
  assert.equal(byId["serbia-arena-sport-1"].proxied, true, "request headers need the proxy");
  assert.equal(byId["italy-eurosport-2-hd"].logoSrc, catalog.channels.find(c => c.id === "italy-eurosport-2-hd").logo);
}
ok("admin channel list reports kind, logoSrc and whether the Worker proxies the channel");

console.log("# playback");

{
  const res = await call(env, "/api/play/tv/world-sport-hls");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://cdn.example/live/master.m3u8");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal((await call(env, "/api/play/tv/world-sport-hls", { method: "HEAD" })).status, 302);
}
ok("https HLS channels still redirect, exactly as before");

{
  const live = liveStream();
  upstream[xtream(1001)] = () => respond(live.stream, { headers: { "Content-Type": "application/octet-stream", "Set-Cookie": "sid=1" } });
  upstreamLog.length = 0;
  const res = await call(env, "/api/play/tv/italy-eurosport-2-hd");
  assert.equal(res.status, 200, "http streams are proxied, never redirected");
  assert.equal(res.headers.get("Location"), null);
  assert.equal(res.headers.get("Content-Type"), "video/mp2t", "octet-stream upstream: typed from the stream kind");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(res.headers.get("Set-Cookie"), null, "upstream cookies are never forwarded");
  assertPrivate("proxied stream headers", headerBlob(res));
  assert.equal(upstreamLog.length, 1);
  assert.equal(upstreamLog[0].url, xtream(1001));
  assert.equal(upstreamLog[0].headers.get("User-Agent"), "VLC/3.0.21 LibVLC/3.0.21");
  assert.equal(upstreamLog[0].headers.get("Accept"), "*/*");

  // An endless live stream: the first packets arrive without the Worker
  // buffering the body, and closing the player closes the upstream.
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(first.value[0], 0x47, "MPEG-TS sync byte passed through");
  assert.ok(live.pulls < 50, "the body is streamed, not buffered (" + live.pulls + " pulls)");
  await reader.cancel();
  assert.equal(live.cancelled, true, "client disconnect cancels the upstream body");
}
ok("http MPEG-TS channel streams through the Worker: no redirect, no buffering, no upstream URL");

{
  const live = liveStream();
  upstream[xtream(1001)] = () => respond(live.stream, { headers: { "Content-Type": "video/mp2t" } });
  const res = await call(env, "/api/play/tv/italy-eurosport-2-hd", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "video/mp2t");
  assert.equal(await res.text(), "", "HEAD has no body");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(live.cancelled, true, "HEAD cancels the upstream body");
}
ok("HEAD answers the same headers without a body");

let mediaToken;
let lowPath;
{
  const MASTER = [
    "#EXTM3U",
    "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"https://keys.example/session.key\"",
    "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",URI=\"audio/eng.m3u8\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"aud\"",
    "low/index.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2000000",
    "http://other.example/high/index.m3u8?token=abc",
    "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI=\"/iframes/index.m3u8\""
  ].join("\r\n");
  // Xtream redirects the .m3u8 to an edge server: relative entries resolve
  // against that final URL.
  upstream["http://iptv.example:8080/live/user/pass/1001.m3u8"] = () =>
    respond(MASTER, { headers: { "Content-Type": "application/x-mpegURL" }, url: "http://edge.example:8000/hls/abc/1001.m3u8" });
  upstreamLog.length = 0;
  const res = await call(env, "/api/play/tv/italy-eurosport-2-hd?format=hls");
  assert.equal(upstreamLog[0].url, "http://iptv.example:8080/live/user/pass/1001.m3u8", "format=hls asks Xtream for the .m3u8 sibling");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/vnd.apple.mpegurl");
  const text = await res.text();
  assertPrivate("rewritten master playlist", text, headerBlob(res));
  const prefix = "/api/play/tv/italy-eurosport-2-hd/s/";
  const uris = playlistUris(text);
  assert.equal(uris.length, 2);
  assert.ok(uris.every(uri => uri.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(uri.slice(prefix.length))), "URI lines become sealed /s/ paths");
  const attributes = [...text.matchAll(/URI="([^"]*)"/g)].map(m => m[1]);
  assert.equal(attributes.length, 3);
  assert.ok(attributes.every(uri => uri.startsWith(prefix)), "URI=\"…\" attributes are rewritten too");
  assert.match(text, /^#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="\/api/, "tags keep their shape");
  assert.match(text, /#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"\n\/api/);
  lowPath = uris[0];

  // Each token opens to the right absolute upstream URL.
  const expected = [
    ["low/index.m3u8", uris[0], "http://edge.example:8000/hls/abc/low/index.m3u8"],
    ["absolute variant", uris[1], "http://other.example/high/index.m3u8?token=abc"],
    ["session key", attributes[0], "https://keys.example/session.key"],
    ["audio rendition", attributes[1], "http://edge.example:8000/hls/abc/audio/eng.m3u8"],
    ["root-relative iframe playlist", attributes[2], "http://edge.example:8000/iframes/index.m3u8"]
  ];
  for (const [label, path, target] of expected) {
    upstream[target] = () => respond("key-or-playlist", { headers: { "Content-Type": "application/octet-stream" } });
    upstreamLog.length = 0;
    const opened = await call(env, path);
    assert.equal(upstreamLog[0]?.url, target, label + " resolves against the final upstream URL");
    await opened.arrayBuffer();
  }
}
ok("HLS master playlist: URI lines and URI=\"…\" attributes rewritten to sealed /s/ paths (relative, root-relative, absolute)");

{
  const MEDIA = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:100",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x0123456789abcdef0123456789abcdef",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXTINF:6.0,",
    "seg100.ts",
    "#EXTINF:6.0,",
    "/abs/seg101.ts",
    "#EXTINF:6.0,",
    "http://other.example/cdn/seg102.ts",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAECAwQFBgcICQoLDA0ODw==\"",
    "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key-id-1\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
    "#EXTINF:6.0,",
    "seg103.ts",
    ""
  ].join("\n");
  upstream["http://edge.example:8000/hls/abc/low/index.m3u8"] = () =>
    respond(MEDIA, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
  const res = await call(env, lowPath);
  assert.equal(res.status, 200);
  const text = await res.text();
  assertPrivate("rewritten media playlist", text);
  assert.match(text, /#EXT-X-KEY:METHOD=AES-128,URI="\/api\/play\/tv\/italy-eurosport-2-hd\/s\/[A-Za-z0-9_-]+",IV=0x0123456789abcdef0123456789abcdef/, "EXT-X-KEY rewritten, IV kept");
  assert.match(text, /#EXT-X-MAP:URI="\/api\/play\/tv\/italy-eurosport-2-hd\/s\/[A-Za-z0-9_-]+"/, "EXT-X-MAP rewritten");
  assert.ok(text.includes("URI=\"data:text/plain;base64,AAECAwQFBgcICQoLDA0ODw==\""), "data: URIs untouched");
  assert.ok(text.includes("URI=\"skd://key-id-1\""), "skd: URIs untouched");
  assert.ok(text.includes("#EXT-X-MEDIA-SEQUENCE:100\n"));
  const segments = playlistUris(text);
  assert.equal(segments.length, 4);

  const targets = [
    "http://edge.example:8000/hls/abc/low/seg100.ts",
    "http://edge.example:8000/abs/seg101.ts",
    "http://other.example/cdn/seg102.ts",
    "http://edge.example:8000/hls/abc/low/seg103.ts"
  ];
  for (let i = 0; i < targets.length; i++) {
    upstream[targets[i]] = () => respond(new Uint8Array([0x47, i]), { headers: { "Content-Type": "application/octet-stream", "Content-Length": "2" } });
    upstreamLog.length = 0;
    const segment = await call(env, segments[i]);
    assert.equal(upstreamLog[0].url, targets[i]);
    assert.equal(segment.status, 200);
    assert.equal(segment.headers.get("Content-Type"), "video/mp2t");
    assert.equal(segment.headers.get("Content-Length"), "2");
    assert.deepEqual([...new Uint8Array(await segment.arrayBuffer())], [0x47, i]);
  }
  mediaToken = segments[0].split("/s/")[1];
}
ok("HLS media playlist: segments, EXT-X-KEY and EXT-X-MAP rewritten; data:/skd: untouched; /s/ tokens round-trip");

{
  const path = (id, token) => "/api/play/tv/" + id + "/s/" + token;
  const flipped = mediaToken.slice(0, 20) + (mediaToken[20] === "A" ? "B" : "A") + mediaToken.slice(21);
  upstreamLog.length = 0;
  assert.equal((await call(env, path("italy-eurosport-2-hd", flipped))).status, 404, "tampered token");
  assert.equal((await call(env, path("italy-eurosport-2-hd", mediaToken.slice(0, -4)))).status, 404, "truncated token");
  assert.equal((await call(env, path("italy-eurosport-2-hd", "not-a-token"))).status, 404, "garbage token");
  assert.equal((await call(env, path("france-eurosport-2-hd", mediaToken))).status, 404, "a token only opens under its own channel");
  assert.equal((await call(env, "/api/play/stream/italy-eurosport-2-hd/x/s/" + mediaToken)).status, 404, "...and not under a match stream");
  const otherSecret = makeEnv({ ADMIN_TOKEN: "another-secret" });
  assert.equal((await call(otherSecret, path("italy-eurosport-2-hd", mediaToken))).status, 404, "tokens are bound to the Worker secret");
  travel(13 * 60 * 60 * 1000);
  try {
    assert.equal((await call(env, path("italy-eurosport-2-hd", mediaToken))).status, 404, "expired token (12 h)");
  } finally {
    restoreClock();
  }
  assert.equal(upstreamLog.length, 0, "rejected tokens never reach the upstream");
  const missing = await call(env, path("italy-eurosport-2-hd", flipped));
  assert.equal(missing.headers.get("Content-Security-Policy"), "sandbox");
  assert.equal((await call(env, path("italy-eurosport-2-hd", mediaToken) + "/extra")).status, 404, "/s/ takes no sub-path");
  assert.equal((await call(env, "/api/play/tv/italy-eurosport-2-hd/b/" + mediaToken)).status, 404, "/b/ needs a path");
  assert.equal((await call(env, "/api/play/tv/%E0%A4%A")).status, 404, "malformed ids are a clean 404");
  assert.equal((await call(env, path("italy-eurosport-2-hd", mediaToken), { method: "POST" })).status, 404, "only GET and HEAD play");
}
ok("sealed tokens: tampered, foreign-scope, foreign-secret and expired tokens are 404 without an upstream fetch");

{
  upstream["http://edge.example:8000/hls/abc/low/seg100.ts"] = (request) => {
    assert.equal(request.headers.get("Range"), "bytes=100-199", "Range is forwarded");
    return respond(new Uint8Array(100), {
      status: 206,
      headers: { "Content-Type": "video/mp2t", "Content-Range": "bytes 100-199/1000", "Content-Length": "100", "Accept-Ranges": "bytes" }
    });
  };
  const res = await call(env, "/api/play/tv/italy-eurosport-2-hd/s/" + mediaToken, { headers: { Range: "bytes=100-199" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.equal(res.headers.get("Content-Length"), "100");
  assert.equal(res.headers.get("Accept-Ranges"), "bytes");
  assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Length, Content-Range, Accept-Ranges");
  assert.equal((await res.arrayBuffer()).byteLength, 100);

  upstream["http://edge.example:8000/hls/abc/low/seg100.ts"] = () =>
    respond(new Uint8Array(10), { headers: { "Content-Type": "video/mp2t", "Content-Encoding": "gzip", "Content-Length": "4" } });
  const decoded = await call(env, "/api/play/tv/italy-eurosport-2-hd/s/" + mediaToken);
  assert.equal(decoded.headers.get("Content-Length"), null, "no stale length for a body fetch already decoded");
  await decoded.arrayBuffer().catch(() => {});
}
ok("Range requests are forwarded and 206 partial content passes through");

{
  const cases = [
    ["upstream 403", () => respond("Forbidden", { status: 403 })],
    ["upstream 404", () => respond("Not found", { status: 404, headers: { "Content-Type": "text/plain" } })],
    ["upstream 500", () => respond("boom", { status: 500 })],
    ["upstream HTML page", () => respond("<html><script>alert(1)</script></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } })],
    ["upstream XHTML page", () => respond("<html/>", { headers: { "Content-Type": "application/xhtml+xml" } })],
    ["unreachable upstream", () => { throw new TypeError("connection refused"); }],
    ["m3u8 path that is not a playlist", () => respond("{\"error\":true}", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } })]
  ];
  for (const [label, handler] of cases) {
    upstream[xtream(1001)] = handler;
    upstream["http://iptv.example:8080/live/user/pass/1001.m3u8"] = handler;
    const res = await call(env, "/api/play/tv/italy-eurosport-2-hd" + (label.includes("m3u8") ? "?format=hls" : ""));
    assert.equal(res.status, 502, label + " -> 502");
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8", label);
    assert.equal(res.headers.get("Content-Security-Policy"), "sandbox", label);
    const text = await res.text();
    assert.ok(!text.includes("<html") && !text.includes("Forbidden"), label + ": upstream body never re-served");
  }
}
ok("upstream errors, HTML pages and fake playlists answer a sandboxed plain-text 502");

{
  // An explicit media type wins over the URL's extension.
  upstream["http://iptv.example:8080/live/user/pass/1001.m3u8"] = () => respond(new Uint8Array([0x47, 0x40]), { headers: { "Content-Type": "video/mp2t" } });
  const res = await call(env, "/api/play/tv/italy-eurosport-2-hd?format=hls");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "video/mp2t");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x47, 0x40]);
}
ok("a .m3u8 URL that answers with a media type is passed through, not rewritten");

{
  const PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchunk-1.ts\n";
  upstream["https://secure.example/arena/index.m3u8"] = () => respond(PLAYLIST, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
  upstream["https://secure.example/arena/chunk-1.ts"] = () => respond(new Uint8Array([0x47]), { headers: { "Content-Type": "video/mp2t" } });
  upstreamLog.length = 0;
  const res = await call(env, "/api/play/tv/serbia-arena-sport-1");
  assert.equal(res.status, 200, "https channel with request headers is proxied");
  const segment = playlistUris(await res.text())[0];
  await (await call(env, segment)).arrayBuffer();
  assert.deepEqual(upstreamLog.map(c => c.url), ["https://secure.example/arena/index.m3u8", "https://secure.example/arena/chunk-1.ts"]);
  for (const request of upstreamLog) {
    assert.equal(request.headers.get("User-Agent"), "MyAgent/1.0", "#EXTVLCOPT user agent forwarded (" + request.url + ")");
    assert.equal(request.headers.get("Referer"), "https://ref.example/page", "#EXTVLCOPT referrer forwarded");
    assert.equal(request.headers.get("Origin"), "https://ref.example", "#EXTVLCOPT origin forwarded");
  }

  upstream["http://pipe.example/live/stream.flv"] = () => respond(new Uint8Array([0x46, 0x4c, 0x56]), { headers: { "Content-Type": "application/octet-stream" } });
  upstreamLog.length = 0;
  const flv = await call(env, "/api/play/tv/spain-pipe-tv");
  assert.equal(flv.status, 200);
  assert.equal(flv.headers.get("Content-Type"), "video/x-flv");
  assert.equal(upstreamLog[0].headers.get("User-Agent"), "Pipe Agent", "Kodi pipe user agent forwarded");
  assert.equal(upstreamLog[0].headers.get("Referer"), "https://pipe-ref.example/");
  await flv.arrayBuffer();
}
ok("custom request headers (#EXTVLCOPT and Kodi pipe) are forwarded upstream, segments included");

{
  const MPD = [
    "<?xml version=\"1.0\"?>",
    "<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" type=\"dynamic\">",
    "  <BaseURL>https://dash.example/cdn/v1/</BaseURL>",
    "  <Period>",
    "    <AdaptationSet mimeType=\"video/mp4\">",
    "      <BaseURL>video/</BaseURL>",
    "      <SegmentTemplate media=\"chunk-$Number$.m4s\" initialization=\"init.mp4\"/>",
    "    </AdaptationSet>",
    "    <AdaptationSet mimeType=\"audio/mp4\">",
    "      <BaseURL serviceLocation=\"b\">https://dash.example/cdn/v2/audio.mp4?a=1&amp;b=2</BaseURL>",
    "    </AdaptationSet>",
    "  </Period>",
    "</MPD>"
  ].join("\n");
  let manifestFetches = 0;
  upstream["https://dash.example/live/stream/manifest.mpd?auth=1"] = () => {
    manifestFetches++;
    return respond(MPD, { headers: { "Content-Type": "application/dash+xml" } });
  };
  const first = await call(env, "/api/play/tv/world-dash-sport");
  assert.equal(first.status, 302, "a DASH manifest is re-requested under /b/");
  const location = first.headers.get("Location");
  assert.match(location, /^\/api\/play\/tv\/world-dash-sport\/b\/[A-Za-z0-9_-]+\/manifest\.mpd\?auth=1$/);
  assertPrivate("DASH redirect", headerBlob(first));

  const res = await call(env, location);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/dash+xml");
  assert.equal(manifestFetches, 2);
  const text = await res.text();
  assertPrivate("rewritten MPD", text);
  assert.match(text, /<BaseURL>\/api\/play\/tv\/world-dash-sport\/b\/[A-Za-z0-9_-]+\/<\/BaseURL>/, "absolute BaseURL rewritten to a /b/ directory");
  assert.ok(text.includes("<BaseURL>video/</BaseURL>"), "relative BaseURL untouched");
  const fileBase = text.match(/<BaseURL serviceLocation="b">([^<]+)<\/BaseURL>/)[1];
  assert.match(fileBase, /^\/api\/play\/tv\/world-dash-sport\/b\/[A-Za-z0-9_-]+\/audio\.mp4\?a=1&amp;b=2$/, "a file BaseURL keeps its name and query, XML-escaped");

  // Relative segments resolve under the manifest's own sealed directory.
  const directory = location.slice(0, location.lastIndexOf("/") + 1);
  upstream["https://dash.example/live/stream/video/chunk-7.m4s"] = () => respond(new Uint8Array(4), { headers: { "Content-Type": "video/iso.segment" } });
  upstreamLog.length = 0;
  const segment = await call(env, directory + "video/chunk-7.m4s");
  assert.equal(segment.status, 200);
  assert.equal(upstreamLog[0].url, "https://dash.example/live/stream/video/chunk-7.m4s");
  assert.equal(upstreamLog[0].headers.get("Referer"), "https://ref.example/", "sealed headers ride along");
  assert.equal(segment.headers.get("Content-Type"), "video/iso.segment");
  await segment.arrayBuffer();

  const cdnBase = text.match(/<BaseURL>(\/api\/play\/tv\/world-dash-sport\/b\/[^<]+)<\/BaseURL>/)[1];
  upstream["https://dash.example/cdn/v1/video/init.mp4"] = () => respond(new Uint8Array(2), { headers: { "Content-Type": "video/mp4" } });
  upstreamLog.length = 0;
  await (await call(env, cdnBase + "video/init.mp4")).arrayBuffer();
  assert.equal(upstreamLog[0].url, "https://dash.example/cdn/v1/video/init.mp4", "rewritten BaseURL resolves on the CDN");

  upstream["https://dash.example/cdn/v2/audio.mp4?a=1&b=2"] = () => respond(new Uint8Array(2), { headers: { "Content-Type": "audio/mp4" } });
  upstreamLog.length = 0;
  await (await call(env, fileBase.replace("&amp;", "&"))).arrayBuffer();
  assert.equal(upstreamLog[0].url, "https://dash.example/cdn/v2/audio.mp4?a=1&b=2");

  upstreamLog.length = 0;
  assert.equal((await call(env, directory + "//evil.example/x")).status, 404, "//host escapes are refused (same origin only)");
  assert.equal((await call(env, directory + "https://evil.example/x")).status, 404, "absolute URLs are refused");
  assert.equal((await call(env, "/api/play/tv/world-dash-sport/b/" + mediaToken + "/x")).status, 404, "/b/ tokens are scoped too");
  assert.equal(upstreamLog.length, 0);
}
ok("DASH: manifest redirected to /b/, absolute BaseURLs rewritten, relative paths resolve, /b/ stays same-origin");

console.log("# logos");

{
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const logoPath = catalog.channels.find(c => c.id === "italy-eurosport-2-hd").logo;
  upstream["http://203.0.113.10/logos/es2.png"] = (request) => {
    assert.match(request.headers.get("Accept"), /image\/\*/);
    return respond(PNG, { headers: { "Content-Type": "image/png", "Set-Cookie": "x=1" } });
  };
  const res = await call(env, logoPath);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/png");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG]);
  assertPrivate("logo response", headerBlob(res));

  upstream["http://203.0.113.10/logos/es2.png"] = () => respond(PNG, { headers: { "Content-Type": "application/octet-stream" } });
  const sniffed = await call(env, logoPath);
  assert.equal(sniffed.headers.get("Content-Type"), "image/png", "octet-stream logos are typed from their bytes");
  await sniffed.arrayBuffer();

  const rejects = [
    ["JSON", () => respond("{}", { headers: { "Content-Type": "application/json" } })],
    ["SVG", () => respond("<svg onload=\"alert(1)\"/>", { headers: { "Content-Type": "image/svg+xml" } })],
    ["HTML", () => respond("<html></html>", { headers: { "Content-Type": "text/html" } })],
    ["octet-stream that is not an image", () => respond("MZ", { headers: { "Content-Type": "application/octet-stream" } })],
    ["over 1 MB", () => respond(new Uint8Array(1024 * 1024 + 1), { headers: { "Content-Type": "image/png" } })],
    ["upstream 404", () => respond("", { status: 404 })]
  ];
  for (const [label, handler] of rejects) {
    upstream["http://203.0.113.10/logos/es2.png"] = handler;
    const rejected = await call(env, logoPath);
    assert.equal(rejected.status, 502, label + " logo rejected");
    assert.notEqual(rejected.headers.get("Content-Type"), "image/svg+xml");
    await rejected.arrayBuffer();
  }
  assert.equal((await call(env, "/api/tv/logo/world-history-channel")).status, 404, "channel without a logo");
  assert.equal((await call(env, "/api/tv/logo/no-such-channel")).status, 404, "unknown channel");
}
ok("logo proxy serves http logos as images and rejects non-images, SVG and oversized files");

{
  // Edge cache: the second request is answered before any KV read or fetch.
  const cached = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = cached.get(String(key));
        return hit ? hit.clone() : undefined;
      },
      async put(key, response) {
        cached.set(String(key), response);
      }
    }
  };
  try {
    const cacheEnv = makeEnv();
    upstream[PLAYLIST_URL] = () => respond(SPORTS_M3U);
    await call(cacheEnv, "/api/tv/channels"); // seeds the catalog
    // Stand in for the cron probe: the catalog verified on its current URLs.
    const seeded = JSON.parse(cacheEnv.SPORTZFY_DB.store.get("tv_channels")).channels;
    cacheEnv.SPORTZFY_DB.store.set("tv_health", JSON.stringify({ channels: Object.fromEntries(seeded.map(c => [c.id, { url: c.url, working: true }])) }));
    const logoPath = (await (await call(cacheEnv, "/api/tv/channels")).json()).channels.find(c => c.id === "france-eurosport-2-hd").logo;
    upstream["http://203.0.113.10/logos/es2.png"] = () => respond(new Uint8Array([0xff, 0xd8, 0xff, 0]), { headers: { "Content-Type": "image/jpeg" } });
    const first = await call(cacheEnv, logoPath);
    assert.equal(first.status, 200);
    await drain();
    assert.ok(cached.has(BASE + logoPath), "logo stored under the request URL");
    const gets = cacheEnv.SPORTZFY_DB.gets;
    upstreamLog.length = 0;
    const second = await call(cacheEnv, logoPath);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("Content-Type"), "image/jpeg");
    assert.equal(cacheEnv.SPORTZFY_DB.gets, gets, "cache hit reads no KV");
    assert.equal(upstreamLog.length, 0, "cache hit fetches nothing");
  } finally {
    delete globalThis.caches;
  }
}
ok("logo proxy answers from the edge cache before touching KV");

console.log("# match streams");

{
  const created = await admin("/api/admin/matches", "POST", {
    title: "Derby", category: "FOOTBALL",
    streams: [
      { id: "iptv", name: "IPTV", url: "http://iptv.example:8080/live/user/pass/2001.m3u8" },
      { id: "web", name: "Web", url: "https://player.example/embed/1" }
    ]
  });
  assert.equal(created.status, 201);
  const matchId = (await created.json()).match.id;
  const publicList = await (await call(env, "/api/matches/all-today")).text();
  assertPrivate("public match list", publicList);
  const match = JSON.parse(publicList).find(m => m.id === matchId);
  assert.deepEqual(match.manual.streams.map(s => [s.id, s.kind]), [["iptv", "hls"], ["web", "embed"]]);

  upstream["http://iptv.example:8080/live/user/pass/2001.m3u8"] = () =>
    respond("#EXTM3U\n#EXTINF:4,\nseg-1.ts\n", { headers: { "Content-Type": "text/plain" } });
  const scope = "/api/play/stream/" + encodeURIComponent(matchId) + "/iptv";
  const res = await call(env, scope);
  assert.equal(res.status, 200, "http match streams are proxied");
  const text = await res.text();
  assertPrivate("match stream playlist", text);
  const segment = playlistUris(text)[0];
  assert.ok(segment.startsWith(scope + "/s/"), "tokens live under the match stream's own path");
  upstream["http://iptv.example:8080/live/user/pass/seg-1.ts"] = () => respond(new Uint8Array([0x47]));
  const media = await call(env, segment);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("Content-Type"), "video/mp2t");
  await media.arrayBuffer();
  const token = segment.split("/s/")[1];
  assert.equal((await call(env, "/api/play/tv/italy-eurosport-2-hd/s/" + token)).status, 404, "match tokens do not open TV scopes");

  const web = await call(env, "/api/play/stream/" + encodeURIComponent(matchId) + "/web");
  assert.equal(web.status, 302, "https embed match streams still redirect");
  assert.equal(web.headers.get("Location"), "https://player.example/embed/1");
}
ok("match streams: http URL accepted and proxied (text/plain playlist sniffed), tokens scoped per stream");

console.log("# settings and sync");

{
  // Sync keeps ids (matched by URL, then group + name), the admin's proxy
  // switch and activity, and follows playlist header changes.
  assert.equal((await admin("/api/admin/tv/channels/italy-eurosport-2-hd", "PUT", { proxy: true, active: false })).status, 200);
  const changed = SPORTS_M3U
    .replace(xtream(1001), xtream(1011))
    .replace("http-user-agent=MyAgent/1.0", "http-user-agent=MyAgent/2.0");
  upstream[PLAYLIST_URL] = () => respond(changed);
  const result = await (await admin("/api/admin/tv/sync", "POST")).json();
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.updated, 2);
  const list = (await (await admin("/api/admin/tv/channels")).json()).channels;
  const italy = list.find(c => c.id === "italy-eurosport-2-hd");
  assert.equal(italy.url, xtream(1011), "URL refreshed; id kept via group + name");
  assert.equal(italy.proxy, true, "proxy is admin-owned and survives a sync");
  assert.equal(italy.active, false);
  assert.equal(italy.group, "Italy");
  assert.equal(list.find(c => c.id === "serbia-arena-sport-1").headers.userAgent, "MyAgent/2.0");
  assert.equal(list.find(c => c.id === "france-eurosport-2-hd").url, xtream(1002));
  assert.equal((await call(env, "/api/play/tv/italy-eurosport-2-hd")).status, 404, "inactive channels do not play");
  const publicIds = (await (await call(env, "/api/tv/channels")).json()).channels.map(c => c.id);
  assert.ok(!publicIds.includes("italy-eurosport-2-hd"), "the memoized catalog follows admin writes");
}
ok("re-sync keeps ids, the proxy switch and admin status; follows URL and header changes");

{
  const saved = await (await admin("/api/admin/settings/tvSource", "PUT", { defaultCategory: "Entertainment" })).json();
  assert.equal(saved.settings.tvSource.defaultCategory, "Entertainment");
  assert.equal(saved.tvSync, undefined, "same source: no resync");
  await admin("/api/admin/tv/sync", "POST");
  const byId = Object.fromEntries((await (await call(env, "/api/tv/channels")).json()).channels.map(c => [c.id, c]));
  assert.equal(byId["world-history-channel"].category, "Entertainment", "unmatched names take the default category");
  assert.equal(byId["afghanistan-rta-sports-hd"].category, "Sports", "name rules still win over the default");
  assert.equal(byId["cricket-willow-hd"].category, "Cricket", "group-title categories still win");

  const manual = await (await admin("/api/admin/tv/channels", "POST", { name: "Mystery", url: "https://cdn.example/mystery.m3u8" })).json();
  assert.equal(manual.channel.category, "Entertainment", "manual channels use the default category too");
}
ok("tvSource.defaultCategory is the fallback for playlist and manual channels");

{
  // A new source syncs as soon as it is saved.
  const OTHER = "https://lists.example/other.m3u";
  upstream[OTHER] = () => respond("#EXTM3U\n#EXTINF:-1 group-title=\"Brazil\",SPORTV\nhttp://iptv.example:8080/live/user/pass/3001.ts\n");
  const saved = await (await admin("/api/admin/settings/tvSource", "PUT", { url: OTHER })).json();
  assert.equal(saved.tvSync.ok, true);
  assert.equal(saved.tvSync.trigger, "settings");
  // Stand in for the cron probe: the new catalog verified on its current URLs.
  const current = JSON.parse(env.SPORTZFY_DB.store.get("tv_channels")).channels;
  env.SPORTZFY_DB.store.set("tv_health", JSON.stringify({ channels: Object.fromEntries(current.map(c => [c.id, { url: c.url, working: true }])) }));
  const list = (await (await call(env, "/api/tv/channels")).json()).channels;
  assert.deepEqual(list.map(c => c.id), ["brazil-sportv", "mystery"], "only the new playlist's channels, plus manual ones");

  // Back to the default; a failing source is reported, not thrown.
  upstream[PLAYLIST_URL] = () => respond("Not found", { status: 404 });
  const failed = await (await admin("/api/admin/settings/tvSource", "PUT", { url: "" })).json();
  assert.equal(failed.settings.tvSource.url, PLAYLIST_URL, "empty URL means the default source");
  assert.equal(failed.tvSync.ok, false);
  assert.match(failed.tvSync.error, /HTTP 404/);
}
ok("saving a new playlist source resyncs at once and reports failures");

{
  // Deployments that saved settings (and synced) with the retired sports.m3u
  // list go back to channels.json on the next cron run, even within the hour.
  const legacyEnv = makeEnv();
  const db = legacyEnv.SPORTZFY_DB;
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.store.set("site_settings", JSON.stringify({ tvSource: { url: LEGACY_URL, autoSync: true, timeoutSec: 60 } }));
  db.store.set("tv_channels", JSON.stringify({
    source: LEGACY_URL, syncedAt: recent, lastAttemptAt: recent, lastSync: { ok: true },
    channels: [
      { id: "eurosport-2-hd", name: "EUROSPORT 2 HD", url: "https://old.example/es2", origin: "synced", active: false, sort: 3 },
      { id: "old-channel", name: "Old Channel", url: "https://old.example/old", origin: "synced" },
      { id: "my-channel", name: "My Channel", url: "https://mine.example/live.m3u8", origin: "manual" }
    ]
  }));
  const admin2 = await adminSession(legacyEnv);
  const settings = (await (await admin2("/api/admin/settings")).json()).settings;
  assert.equal(settings.tvSource.url, PLAYLIST_URL, "a stored sports.m3u URL reads as the channels.json default");
  assert.equal(settings.tvSource.defaultCategory, "Sports");

  upstream[PLAYLIST_URL] = () => respond(SPORTS_M3U);
  const fetchesOf = () => upstreamLog.filter(c => c.url === PLAYLIST_URL).length;
  upstreamLog.length = 0;
  await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, legacyEnv);
  assert.equal(fetchesOf(), 1, "source changed: synced on the first cron run");
  const state = JSON.parse(db.store.get("tv_channels"));
  assert.equal(state.source, PLAYLIST_URL);
  assert.equal(state.lastSync.trigger, "cron");
  const ids = state.channels.map(c => c.id);
  assert.ok(!ids.includes("old-channel"), "the old list's channels are gone");
  assert.ok(ids.includes("my-channel"), "manual channels are kept");
  const inherited = state.channels.find(c => c.id === "eurosport-2-hd");
  assert.equal(inherited.group, "France", "an old group-less record is matched by name once");
  assert.equal(inherited.active, false);
  assert.equal(inherited.sort, 3);
  assert.ok(ids.includes("italy-eurosport-2-hd"), "the next same-named channel gets a group id");

  await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, legacyEnv);
  assert.equal(fetchesOf(), 1, "same source, synced recently: no new pull");

  travel(61 * 60 * 1000);
  try {
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, legacyEnv);
  } finally {
    restoreClock();
  }
  assert.equal(fetchesOf(), 2, "re-pulled after an hour");

  // A failed pull waits 30 minutes before the next try.
  upstream[PLAYLIST_URL] = () => { throw new TypeError("offline"); };
  const later = (minutes) => travel(minutes * 60 * 1000);
  try {
    later(125);
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, legacyEnv);
    assert.equal(fetchesOf(), 3);
    assert.equal(JSON.parse(db.store.get("tv_channels")).lastSync.ok, false);
    later(140);
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, legacyEnv);
    assert.equal(fetchesOf(), 3, "no retry within 30 minutes of a failure");
    later(160);
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, legacyEnv);
    assert.equal(fetchesOf(), 4, "retried after 30 minutes");
  } finally {
    restoreClock();
  }
}
ok("legacy source URL maps to channels.json and the cron syncs at once on a source change, hourly after, 30 min after failures");

{
  // No Worker secret: a random key is generated once and kept in KV.
  const bare = makeEnv({ ADMIN_TOKEN: undefined });
  upstream[PLAYLIST_URL] = () => respond(SPORTS_M3U);
  await call(bare, "/api/tv/channels");
  upstream["http://iptv.example:8080/live/user/pass/1001.m3u8"] = () =>
    respond("#EXTM3U\n#EXTINF:4,\nseg.ts\n", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
  const res = await call(bare, "/api/play/tv/italy-eurosport-2-hd?format=hls");
  const segment = playlistUris(await res.text())[0];
  const secret = bare.SPORTZFY_DB.store.get("stream_proxy_secret");
  assert.match(secret, /^[0-9a-f]{64}$/);
  upstream["http://iptv.example:8080/live/user/pass/seg.ts"] = () => respond(new Uint8Array([0x47]));
  const media = await call(bare, segment);
  assert.equal(media.status, 200, "tokens open with the KV-kept secret");
  await media.arrayBuffer();

  // A new binding object over the same store, as another isolate would see.
  const sameKv = { ...bare, SPORTZFY_DB: { ...bare.SPORTZFY_DB } };
  const again = await call(sameKv, segment);
  assert.equal(again.status, 200, "another isolate reading the same KV opens the same tokens");
  await again.arrayBuffer();
}
ok("without STREAM_PROXY_SECRET or ADMIN_TOKEN the sealing key comes from a KV-kept random secret");

{
  // Route table: play routes do not swallow each other or unknown paths.
  assert.equal((await call(env, "/api/play/tv/world-sport-hls/")).status, 404);
  assert.equal((await call(env, "/api/play/tv/world-sport-hls/x/abc")).status, 404);
  assert.equal((await call(env, "/api/play/tv/world-sport-hls/s/")).status, 404);
  const unknown = await call(env, "/api/play/nothing");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "Unknown endpoint");
}
ok("play routes match exactly; anything else is a 404");

console.log("# embed resolver");

{
  // The /api/play/embed route digs the real media out of the embed.st player
  // chain server-side: embed page -> nested player page -> manifest, then
  // plays it through the sealed-token proxy like every other stream.
  const env = makeEnv();
  upstream["https://embed.st/embed/lteam/id-42/1"] = () =>
    respond(
      '<html><body><iframe src="//player.example/frame.html"></iframe></body></html>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  upstream["https://player.example/frame.html"] = () =>
    respond(
      '<html><script>source="https://edge.example/live/master.m3u8?token=Z";</script></html>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  upstream["https://edge.example/live/master.m3u8?token=Z"] = () =>
    respond("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://edge.example/live/720p.m3u8\n",
      { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
  upstream["https://edge.example/live/720p.m3u8"] = () =>
    respond("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://edge.example/live/key.enc\"\n#EXTINF:6,\nseg-1.ts\n",
      { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });

  const scope = "/api/play/embed/lteam/id-42/1";
  const res = await call(env, scope);
  assert.equal(res.status, 200, "the resolved media plays through the proxy");
  assert.equal(res.headers.get("Content-Type"), "application/vnd.apple.mpegurl");
  const text = await res.text();
  assertPrivate("embed-resolved playlist", text);
  const uris = playlistUris(text);
  assert.equal(uris.length, 1, "master playlist has one variant");
  assert.ok(uris[0].startsWith(scope + "/s/"), "sealed variant tokens live under the embed route");

  // The /s/<token> playlist round-trips; key and segment are re-sealed.
  const variant = await call(env, uris[0]);
  assert.equal(variant.status, 200, "sealed variant opens under its own scope");
  const media = await variant.text();
  assertPrivate("embed media playlist", media);
  const parts = playlistUris(media);
  assert.equal(parts.length, 1, "media playlist: segments only as URI lines");
  assert.ok(parts[0].startsWith(scope + "/s/"), "segment re-sealed to the same scope");
  assert.ok(media.includes('#EXT-X-KEY:METHOD=AES-128,URI="' + scope + "/s/"), "the EXT-X-KEY is sealed too");
  upstream["https://edge.example/live/key.enc"] = () =>
    respond(new Uint8Array(32), { headers: { "Content-Type": "application/octet-stream" } });
  upstream["https://edge.example/live/seg-1.ts"] = () =>
    respond(new Uint8Array(188).fill(0x47), { headers: { "Content-Type": "video/mp2t" } });
  for (const part of parts) {
    const response = await call(env, part);
    assert.equal(response.status, 200, "sealed subresource opens");
    await response.arrayBuffer();
  }

  // A second playback request is served from the resolve cache and never
  // walks the embed pages again.
  const embedFetches = upstreamLog.filter(c => c.url === "https://embed.st/embed/lteam/id-42/1").length;
  const again = await call(env, scope);
  assert.equal(again.status, 200);
  await again.text();
  assert.equal(upstreamLog.filter(c => c.url === "https://embed.st/embed/lteam/id-42/1").length, embedFetches, "resolve result is cached");

  // Tokens stay scoped: a garbage token is refused without an upstream fetch.
  assert.equal((await call(env, scope + "/s/not-a-real-token")).status, 404);
}
ok("embed resolver: media extracted behind embed.st plays through the first-party proxy");

{
  // Nothing findable: the route answers the sandboxed "unavailable" notice,
  // nothing is cached, and the player page falls back to the embed frame.
  const env = makeEnv();
  upstream["https://embed.st/embed/lteam/dead/2"] = () =>
    respond("<html><body>offline</body></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const res = await call(env, "/api/play/embed/lteam/dead/2");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Content-Security-Policy"), "sandbox");
  assert.equal(await res.text(), "This stream is not available.");
  assert.ok(![...env.SPORTZFY_DB.store.keys()].some(k => k.startsWith("embed_resolve:")), "misses write no cache record");
}
ok("embed resolver: unresolved lookups fall back cleanly (404, no cache)");

{
  // An HTML answer never impersonates media: the .m3u8 that serves a web page
  // fails the probe and the real playlist (checked after it) wins.
  const env = makeEnv();
  upstream["https://embed.st/embed/g2real/a/3"] = () =>
    respond('<html>file="https://trap.example/wrap.m3u8" src="https://real.example/live/master.m3u8"</html>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } });
  upstream["https://trap.example/wrap.m3u8"] = () =>
    respond("<html>you are being probed</html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  upstream["https://real.example/live/master.m3u8"] = () =>
    respond("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n",
      { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
  const res = await call(env, "/api/play/embed/g2real/a/3");
  assert.equal(res.status, 200);
  const text = await res.text();
  assertPrivate("resolver playlist", text);
  assert.ok(text.startsWith("#EXTM3U"), "the real playlist is served, not the HTML decoy");
}
ok("embed resolver: HTML answers fail the probe and the real playlist is used");

console.log("\nAll " + passed + " stream proxy assertions passed.");
