// Functional smoke test for the Live TV short-link page resolver
// (resolveTvLikeChannel + its play-route and probe integrations in worker.js).
//
// The channels.json catalog serves most channels as short links that open a
// throwaway player page on a rotating domain — pages that refuse to render in
// a frame (sandbox/referrer self-wipe + pop-unders), which is why the Live TV
// page's channels "never load" when the iframe falls into them. The worker now
// replays the page's own loader server-side: decode the encoded evaluator,
// fetch the signed binary list, XOR-decode it, and serve the real playlist
// through the sealed stream proxy.
//
// Everything here is synthetic: no real playlist hosts or credentials.

import assert from "node:assert/strict";

const worker = (await import("../worker.js")).default;

const BASE = "https://worker.test";
const PLAYLIST_URL = "https://raw.githubusercontent.com/svimran46/playlist.m3u/main/channels.json";
const PAGE_HOST = "links.example";      // the rotating short-link host
const LIST_HOST = "lists.example";      // the signed encrypted list (never may leak)
const MEDIA_HOST = "cdn.example";       // the resolved playlist + its segments

const PAGE_URL_A = "https://" + PAGE_HOST + "/abcdef45-3028";
const PAGE_URL_B = "https://" + PAGE_HOST + "/zzzz6666-7777";   // page without a decode-able loader
const TOKEN_URL_A = "https://" + LIST_HOST + "/p/8d4d778b85b0ad13581813f2101dfa06";
const REAL_PLAYLIST_A = "https://" + LIST_HOST + "/main/secure/cafe1234/1792727286/alpha-usa.m3u8";
const SEGMENT_URL = "https://" + MEDIA_HOST + "/seg-0001.ts";
const PLAIN_M3U = "https://media.example/live/alpha.m3u8";
const PLAIN_PAGE = "https://player.example/watch";   // a plain embed page: not a short link

// Strings that must never reach a viewer.
const SECRETS = [PAGE_HOST + "/", LIST_HOST + "/p/", LIST_HOST + "/main", "http" + "://" + PAGE_HOST];

// ---------------------------------------------------------------------------
// Mocks (native Request/Response/Headers + scriptable fetch + mocked KV)
// ---------------------------------------------------------------------------

const upstreamLog = [];
let upstream = {};          // url -> (call) => Response
let missingUrls = new Set(); // transient holes (fallback paths)
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const call = { url, method: init.method || "GET", headers: new Headers(init.headers || {}) };
  upstreamLog.push(call);
  if (missingUrls.has(url)) throw new TypeError("fetch failed: " + url);
  const handler = upstream[url] || upstream[url + "/"] && upstream[url + "/"] || null;
  if (!handler) throw new TypeError("unexpected fetch: " + url);
  return handler(call);
};

function respond(body, { status = 200, headers = {}, url } = {}) {
  const response = new Response(body, { status, headers });
  if (url) Object.defineProperty(response, "url", { value: url });
  return response;
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
let ipCounter = 1;
function call(env, path, { method = "GET", headers = {} } = {}) {
  const request = new Request(BASE + path, {
    method,
    headers: { "cf-connecting-ip": "192.0.2." + (ipCounter++), ...headers }
  });
  return worker.fetch(request, env, ctx);
}

const fetchesTo = (part) => upstreamLog.filter((call) => call.url.includes(part)).length;

// ---------------------------------------------------------------------------
// Fixtures: a channels.json snippet with a short-link channel, a short link
// whose page is unresolvable, a plain embed page channel and a plain HLS one.
// ---------------------------------------------------------------------------

// Encodes `source` the way the pages do: byte = ((char + offset) % 256) ^ base,
// wrapped in the same scramble-and-eval script shape as the upstream player
// pages (with realistic per-request-randomised variable names).
function encodeLoaderScript(source, base, off) {
  let nums = [];
  for (let i = 0; i < source.length; i++) {
    nums.push(((source.charCodeAt(i) + off) % 256) ^ base);
  }
  return "(function(){var _ok9=[" + nums.join(",") + "],_qt7=" + base + ",_nw3=" + off +
    ',_le1="",_hb2;for(_hb2=0;_hb2<_ok9.length;_hb2++){_le1+=String.fromCharCode(((_ok9[_hb2]^_qt7)-_nw3+256)%256);}' +
    'window["ev"+"al"](_le1);})();';
}

// The real player page content: a stub of the loader the decoded source must
// read like (only the loadStreamUrl("token url") line matters to the resolver).
const LOADER_SOURCE = `
function loadStreamUrl(tUrl, ok, fail) { var x = new XMLHttpRequest(); get...; }
  loadStreamUrl("` + TOKEN_URL_A + `", function(SIGNED_URL) {
  function init() {
    var opts = { file: SIGNED_URL, type: "hls", width: "100%", height: "100%" };
  }
});
`;

// Rebuilds the encrypted binary list from the playlist URL it hides.
function encryptedList(playlistUrl, seed) {
  const tokenPart = TOKEN_URL_A.slice(TOKEN_URL_A.lastIndexOf("/") + 1);
  const out = new Uint8Array(playlistUrl.length + 1);
  out[0] = seed;
  for (let i = 1; i <= playlistUrl.length; i++) {
    out[i] = playlistUrl.charCodeAt(i - 1) ^ tokenPart.charCodeAt((i - 1) % tokenPart.length) ^ ((seed + i - 1) & 255);
  }
  return out;
}

const MANIFEST_A = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:3.75,\n" + SEGMENT_URL + "\n";
// 17 KB of MPEG-TS sync bytes for the strict probe.
const TS_SEGMENT = new Uint8Array(17 * 1024).fill(0x47);

const shortLinkPage = (function () {
  const script = encodeLoaderScript(LOADER_SOURCE, 137, 50);
  return "<!doctype html><html><head><title>player</title></head><body>" +
    '<div id="player" data-id="alpha-usa"></div>' +
    "<script>" + script + "<\/script>" +
    "<script>aclib.runPop({ zoneId: '1234' });<\/script>" +
    "</body></html>";
})();

const UPSTREAM = [
  { name: "Alpha USA", logo: "https://img.example/alpha.png", genre: "Sports", url: PAGE_URL_A },
  { name: "Broken Beam", logo: "", genre: "Sports", url: PAGE_URL_B },
  { name: "Plain Page", logo: "", genre: "Sports", url: PLAIN_PAGE },
  { name: "Plain HLS", logo: "", genre: "Sports", url: PLAIN_M3U }
];
const channelsJs = "const channels = " + JSON.stringify(UPSTREAM, null, 2) + ";\n";

upstream[PLAYLIST_URL] = () => respond(channelsJs, { headers: { "Content-Type": "text/plain" } });
upstream[PAGE_URL_A] = () => respond(shortLinkPage, { url: "https://" + PAGE_HOST + "/play/jwthere", headers: { "Content-Type": "text/html; charset=utf-8" } });
upstream[PAGE_URL_B] = () => respond("<!doctype html><html><body>under maintenance</body></html>", { headers: { "Content-Type": "text/html" } });
upstream[PLAIN_PAGE] = () => respond("<html><body>plain embed page</body></html>", { headers: { "Content-Type": "text/html" } });
upstream[TOKEN_URL_A] = () => respond(encryptedList(REAL_PLAYLIST_A, 7), { headers: { "Content-Type": "application/octet-stream" } });
upstream[REAL_PLAYLIST_A] = () => respond(MANIFEST_A, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
upstream[SEGMENT_URL] = () => respond(TS_SEGMENT, { headers: { "Content-Type": "video/mp2t" } });
upstream[PLAIN_M3U] = () => respond("#EXTM3U\n#EXTINF:4,\nhttps://media.example/live/alpha-seg.ts\n", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });

let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok " + passed + " - " + name); };

// ---------------------------------------------------------------------------
// The catalog: the short-link channel is public as HLS; others stay as they were.
// ---------------------------------------------------------------------------

const env = makeEnv();

console.log("# catalog shaping");
{
  const res = await call(env, "/api/tv/channels");
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  const byId = Object.fromEntries(data.channels.map(c => [c.id, c]));
  assert.deepEqual(
    data.channels.map(c => c.id),
    ["alpha-usa", "broken-beam", "plain-page", "plain-hls"],
    "all channels still listed (checks are advice, never a gate)"
  );
  assert.equal(byId["alpha-usa"].kind, "hls", "short-link channels play through the first-party player, not an iframe of the page");
  assert.equal(byId["broken-beam"].kind, "hls", "…same shape, the resolver decides per play");
  assert.equal(byId["plain-page"].kind, "embed", "a plain embed page keeps the old behavior");
  assert.equal(byId["plain-hls"].kind, "hls", "real HLS streams unchanged");
  assert.ok(!JSON.stringify(data).includes(PAGE_HOST + "/"), "public list never carries the short links either");
  ok("the catalog marks short-link channels hls and leaves everything else alone");
}

// ---------------------------------------------------------------------------
// Playback: the playlist is resolved and served through the sealed proxy.
// ---------------------------------------------------------------------------

console.log("# play route");
{
  upstreamLog.length = 0;
  missingUrls.clear();
  const res = await call(env, "/api/play/tv/alpha-usa");
  assert.equal(res.status, 200, "resolved playback, not a redirect into the ad page");
  const text = await res.text();
  assert.match(text, /#EXTM3U/, "an HLS playlist is served");
  const lines = text.split("\n").filter(line => line && !line.startsWith("#"));
  assert.equal(lines.length, 1);
  const uri = new URL(lines[0], BASE);
  assert.ok(uri.pathname.startsWith("/api/play/tv/alpha-usa/s/"), "the segment points back at the sealed /s/ route");
  assert.ok(uri.pathname.length > "/api/play/tv/alpha-usa/s/".length, "the segment token is sealed, not an upstream URL");
  assert.ok(!text.includes(LIST_HOST) && !text.includes(PAGE_HOST), "neither the short-link host nor the list host leaks");
  const sent = [...upstreamLog].reverse().find(call => call.url === REAL_PLAYLIST_A);
  assert.ok(sent, "the worker fetched the resolved playlist");
  assert.equal(sent.headers.get("Referer"), "https://" + PAGE_HOST + "/", "the playlist request carries the page's origin as referer");
  assert.match(sent.headers.get("User-Agent") || "", /Chrome/, "…with a browser user agent");
  ok("short-link channel resolves server-side and streams through the sealed proxy");
}
{
  const pagePlusList = fetchesTo(PAGE_HOST) + fetchesTo("/p/");
  assert.ok(pagePlusList <= 2, "one page and one list fetch per play window (" + pagePlusList + ")");

  // Second play within the fresh window: no page re-resolution, token reuse.
  upstreamLog.length = 0;
  await call(env, "/api/play/tv/alpha-usa").then(res => res.text());
  assert.equal(fetchesTo(PAGE_HOST), 0, "the fresh record answers without re-resolving the page");
  assert.equal(fetchesTo(REAL_PLAYLIST_A), 1, "the proxy still streams the playlist upstream");
  ok("fresh cache answers repeat plays without touching the page again");
}

// ---------------------------------------------------------------------------
// Fallbacks: an unresolvable page keeps today's plain redirect, and a plain
// embed page never enters the resolver at all.
// ---------------------------------------------------------------------------

console.log("# fallbacks");
{
  const res = await call(env, "/api/play/tv/broken-beam");
  assert.equal(res.status, 302, "an unresolvable page falls back to the redirect");
  assert.equal(res.headers.get("Location"), PAGE_URL_B, "…onto the very link the playlist carried");
  const res2 = await call(env, "/api/play/tv/plain-page");
  assert.equal(res2.status, 302);
  assert.equal(res2.headers.get("Location"), PLAIN_PAGE, "a plain embed page is unaffected");
  ok("unresolvable short links and plain embed pages keep the old redirect");
}

// ---------------------------------------------------------------------------
// Probes: the strict check digs the page out too, and warms the play cache.
// ---------------------------------------------------------------------------

console.log("# probes");
{
  const { probeChannel } = await import("../worker.js");
  const state = JSON.parse(env.SPORTZFY_DB.store.get("tv_channels"));
  const alpha = state.channels.find(c => c.id === "alpha-usa");
  const broken = state.channels.find(c => c.id === "broken-beam");
  const plain = state.channels.find(c => c.id === "plain-page");

  const goodProbe = await probeChannel(alpha, env);
  assert.equal(goodProbe.ok, true, "the resolved playlist verifies: " + goodProbe.reason);
  assert.equal(goodProbe.kind, "hls", "the probe names the kind it verified");
  const fresh = JSON.parse(env.SPORTZFY_DB.store.get("tv_like:tv/alpha-usa"));
  assert.ok(fresh && fresh.src === PAGE_URL_A && typeof fresh.found === "number", "the probe wrote the same cache record the play route uses");

  const badProbe = await probeChannel(broken, env);
  assert.equal(badProbe.ok, false);
  assert.equal(badProbe.reason, "page did not resolve", "an unresolvable page fails with a specific reason");
  const plainProbe = await probeChannel(plain);
  assert.equal(plainProbe.ok, false);
  assert.equal(plainProbe.reason, "web page: playback can't be verified", "plain embed pages keep the old verdict");
  ok("the strict probe verifies the resolved playlist and keeps old verdicts elsewhere");
}

// The probe's cache answer feeds a play without a fresh page fetch.
{
  upstreamLog.length = 0;
  const res = await call(env, "/api/play/tv/alpha-usa");
  const text = await res.text();
  assert.match(text, /#EXTM3U/);
  assert.equal(fetchesTo(PAGE_HOST), 0, "the warmed record answers without another page load");
  ok("play after probe warms straight from the cache");
}

// ---------------------------------------------------------------------------
// Guard rail: a catalog without short links works exactly as before.
// ---------------------------------------------------------------------------

console.log("# no short links");
{
  const other = makeEnv();
  upstream[PLAYLIST_URL] = () => respond("const channels = " + JSON.stringify([
    { name: "Plain HLS", logo: "", genre: "Sports", url: PLAIN_M3U },
    { name: "Plain Page", logo: "", genre: "Sports", url: PLAIN_PAGE }
  ]) + ";\n");
  const data = JSON.parse(await (await call(other, "/api/tv/channels")).text());
  const byId = Object.fromEntries(data.channels.map(c => [c.id, c]));
  assert.equal(byId["plain-hls"].kind, "hls");
  assert.equal(byId["plain-page"].kind, "embed");
  assert.equal((await call(other, "/api/play/tv/plain-page")).status, 302, "plain embed pages keep the redirect");
  assert.equal((await call(other, "/api/play/tv/plain-hls")).status, 302, "plain https HLS keeps the redirect");
  ok("catalogs without short links are untouched end to end");
}

console.log("\nAll " + passed + " TV short-link resolver assertions passed.");
