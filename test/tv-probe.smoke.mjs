// Smoke test for the Live TV probe in worker.js: the probe reads real media and
// records what it found. Its verdicts are advice for the admin — they never
// gate the public list, which serves every active channel. Serves fake streams
// through a mocked fetch and drives the real playlist route.

import assert from "node:assert/strict";

// A stalled stream must time out quickly in the test, not after 10 seconds.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms ?? 0, 150), ...rest);

const worker = (await import("../worker.js")).default;
const { probeChannel, workingChannels, activeChannels, runTvProbe, channelCheck, checkSummary } = await import("../worker.js");

// A transport-stream packet run: 0x47 at the start of every 188-byte packet.
function tsBytes(packets = 200) {
  const bytes = new Uint8Array(packets * 188);
  for (let i = 0; i < packets; i++) bytes[i * 188] = 0x47;
  return bytes;
}

const routes = {
  "https://ok.example/live.m3u8": () => new Response("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg1.ts\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } }),
  "https://ok.example/seg1.ts": () => new Response(tsBytes(), { headers: { "content-type": "video/mp2t" } }),
  "https://ok.example/direct.ts": () => new Response(tsBytes(), { headers: { "content-type": "video/mp2t" } }),
  "https://dead.example/live.m3u8": () => new Response("gone", { status: 404 }),
  "https://html.example/live.ts": () => new Response("<html>blocked</html>", { headers: { "content-type": "text/html" } }),
  "https://junk.example/live.ts": () => new Response(new Uint8Array(40000).fill(1), { headers: { "content-type": "video/mp2t" } }),
  // Headers arrive, then the body stalls until the caller aborts, as a live stream can.
  "https://stall.example/live.ts": (signal) => new Response(new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  }), { headers: { "content-type": "video/mp2t" } }),
};

// A stream that only answers the User-Agent its channel row stores.
routes["https://ua.example/live.ts"] = (signal, headers) => headers["User-Agent"] === "VLC/3.0"
  ? new Response(tsBytes(), { headers: { "content-type": "video/mp2t" } })
  : new Response("forbidden", { status: 403 });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input.url ?? input);
  const make = routes[url];
  if (!make) throw new TypeError("no route for " + url);
  return make(init.signal, init.headers ?? {});
};

function kvStore(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const db = {
    get: async (key, type) => (map.has(key) ? (type === "json" ? JSON.parse(map.get(key)) : map.get(key)) : null),
    put: async (key, value) => map.set(key, value),
  };
  return { SPORTZFY_DB: db, raw: map };
}

const channel = (id, url, extra = {}) => ({
  id, name: id.toUpperCase(), group: "Italy", logo: "https://img.example/" + id + ".png", url,
  category: "Sports", active: true, origin: "synced", ...extra,
});

// 1. Verdicts from real media.
assert.equal((await probeChannel({ url: "https://ok.example/live.m3u8" })).ok, true, "HLS with a valid segment passes");
assert.equal((await probeChannel({ url: "https://ok.example/direct.ts" })).ok, true, "MPEG-TS passes");

let verdict = await probeChannel({ url: "https://dead.example/live.m3u8" });
assert.equal(verdict.ok, false);
assert.equal(verdict.reason, "HTTP 404");

verdict = await probeChannel({ url: "https://html.example/live.ts" });
assert.equal(verdict.ok, false, "a web page served as a stream fails");

verdict = await probeChannel({ url: "https://junk.example/live.ts" });
assert.equal(verdict.ok, false, "bytes without MPEG-TS sync fail");
assert.match(verdict.reason, /MPEG-TS/);

verdict = await probeChannel({ url: "https://stall.example/live.ts" });
assert.equal(verdict.ok, false, "a stalled stream times out");
assert.equal(verdict.reason, "timeout");

verdict = await probeChannel({ url: "https://embed.example/player/abc" });
assert.equal(verdict.ok, false, "web-page embeds are never verified");
assert.match(verdict.reason, /can't be verified/);

// Stored stream headers reach the upstream under their HTTP names.
assert.equal((await probeChannel({ url: "https://ua.example/live.ts", headers: { userAgent: "VLC/3.0" } })).ok, true, "stored User-Agent is sent");
assert.equal((await probeChannel({ url: "https://ua.example/live.ts" })).ok, false, "without it the stream refuses");

// 2. Two good probes in a row call a channel working; a dead one never does.
// What that verdict then does — and doesn't do — to the public list is 4b.
const env = kvStore({
  tv_channels: { channels: [
    channel("good", "https://ok.example/live.m3u8"),
    channel("dead", "https://dead.example/live.m3u8"),
    channel("off", "https://ok.example/direct.ts", { active: false }),
  ] },
});

await runTvProbe(env);
let health = JSON.parse(env.raw.get("tv_health"));
assert.equal(health.channels.good.working, false, "one good probe is not enough");
assert.equal(health.channels.dead.working, false);
assert.equal(health.channels.off, undefined, "inactive channels are not probed");

await runTvProbe(env);
health = JSON.parse(env.raw.get("tv_health"));
assert.equal(health.channels.good.working, true, "two good probes call the channel working");
assert.equal(health.channels.dead.working, false);

// 3. A working channel survives one bad probe, then is called failed after three.
globalThis.fetch = async () => new Response("gone", { status: 404 });
await runTvProbe(env);
health = JSON.parse(env.raw.get("tv_health"));
assert.equal(health.channels.good.working, true, "one bad probe keeps it working");
await runTvProbe(env);
await runTvProbe(env);
health = JSON.parse(env.raw.get("tv_health"));
assert.equal(health.channels.good.working, false, "three bad probes in a row drop it");

// 4. A changed stream URL starts over: the old verdict doesn't count.
globalThis.fetch = async (input, init = {}) => routes[String(input.url ?? input)](init.signal, init.headers ?? {});
const catalog = [channel("good", "https://ok.example/direct.ts")];
assert.deepEqual(workingChannels(catalog, health), [], "an entry for another URL doesn't count");

// 4b. Checks are advice, not a gate: a channel the probe has proved dead is
// still served. Only `active: false` hides one.
{
  const list = [
    channel("good", "https://ok.example/a.ts"),
    channel("dead", "https://dead.example/live.m3u8"),
    channel("off", "https://ok.example/off.ts", { active: false }),
  ];
  assert.deepEqual(
    activeChannels(list).map(c => c.id),
    ["good", "dead"],
    "a failed check never hides a channel; an inactive one is never served"
  );
}

// 5. The public playlist: every active channel whose URL the app can fetch,
// checked or not. Channels needing request headers are still left out,
// because the app can't send them.
const env2 = kvStore({
  tv_channels: { channels: [
    channel("good", "https://ok.example/live.m3u8", { headers: undefined }),
    channel("dead", "https://dead.example/live.m3u8"),
    channel("with-headers", "https://ok.example/direct.ts", { headers: { Referer: "https://x.example/" } }),
  ] },
});
await runTvProbe(env2);
await runTvProbe(env2);
const response = await worker.fetch(new Request("https://sportzfylive.example/api/tv/playlist.m3u"), env2, { waitUntil() {} });
const body = await response.text();
assert.match(body, /^#EXTM3U/);
assert.match(body, /tvg-name="GOOD"/);
assert.match(body, /group-title="Italy"/);
assert.match(body, /https:\/\/ok\.example\/live\.m3u8/);
assert.match(body, /tvg-name="DEAD"/, "a channel that failed its check is listed anyway: checks only advise");
assert.doesNotMatch(body, /WITH-HEADERS/, "channels needing request headers are left out");
assert.equal(response.headers.get("content-type"), "audio/x-mpegurl; charset=utf-8");

// 6. Admin view: each channel's check state and the counts.
{
  const url = "https://ok.example/live.m3u8";
  const health = { updatedAt: "2026-10-16T12:00:00.000Z", channels: {
    good: { url, working: true, ok: true, passes: 2 },
    half: { url, working: false, ok: true, passes: 1 },
    bad: { url, working: false, ok: false, fails: 1, reason: "HTTP 404" },
    moved: { url: "https://old.example/x.m3u8", working: true, ok: true },
    off: { url, working: true, ok: true },
  } };
  const list = [
    channel("good", url), channel("half", url), channel("bad", url),
    channel("moved", url), channel("never", url), channel("off", url, { active: false }),
  ];
  const states = Object.fromEntries(list.map(c => [c.id, channelCheck(c, health).state]));
  assert.deepEqual(states, {
    good: "working", half: "verifying", bad: "failed", moved: "unchecked", never: "unchecked", off: "unchecked",
  }, "states follow the probe; a changed URL or an inactive channel reads as not checked");
  assert.equal(channelCheck(list[2], health).reason, "HTTP 404");
  assert.equal(channelCheck(list[0], health).reason, "", "no reason on a passing channel");
  const summary = checkSummary(list, health);
  assert.deepEqual({ ...summary, updatedAt: undefined, batch: undefined },
    { working: 1, verifying: 1, failed: 1, unchecked: 2, updatedAt: undefined, batch: undefined }, "inactive channels aren't counted");
  assert.equal(summary.updatedAt, "2026-10-16T12:00:00.000Z");
}

console.log("tv-probe smoke: all checks passed");
