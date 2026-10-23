// Smoke test for the checked-in Sportzfy snapshot sources (EXTRA_TV_SOURCES):
// the admin playlist stays authoritative, snapshot channels merge behind it,
// snapshot URLs the main list carries are not duplicated, a failed snapshot
// fetch never fails a sync, and re-syncs keep ids stable and prune entries
// that disappear from the snapshot. Drives the real worker.js against a
// mocked KV and fetch.

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

const MAIN_PLAYLIST_URL = "https://raw.githubusercontent.com/svimran46/playlist.m3u/main/channels.json";
const SNAPSHOT_URL = "https://sportzfylive.svimranmy.workers.dev/sportzfy-channels.m3u";

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
const env = {
  SPORTZFY_DB: kv,
  ADMIN_TOKEN: "test-token",
  SPORTZFY_SYNC_QUEUE: { async send() {} }
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

const session = (await (await call("/api/admin/login", { method: "POST", headers: { "X-Admin-Token": "test-token" } })).json()).session;
assert.ok(session, "login issues a session");
const admin = (path, method = "GET", body) =>
  call(path, { method, headers: { "X-Admin-Session": session }, body });

const channelsJs = (channels) => "const channels = " + JSON.stringify(channels) + ";";
const catalog = async () => (await (await admin("/api/admin/tv/channels")).json()).channels;
const snapshotM3u = (names) => [
  "#EXTM3U",
  ...names.flatMap(name => [
    `#EXTINF:-1 tvg-logo="https://img.example/${name.toLowerCase()}.png" group-title="Sportzfy",${name}`,
    `https://sportz.example/${name.toLowerCase()}/index.m3u8`
  ])
].join("\n") + "\n";

// First sync: the main playlist brings one channel, the snapshot two more.
routes[MAIN_PLAYLIST_URL] = reply(200, channelsJs([
  { name: "ESPN", logo: "", url: "https://tv.example/espn" }
]));
routes[SNAPSHOT_URL] = reply(200, snapshotM3u(["TSports", "CricBuzz"]));
{
  const res = await admin("/api/admin/tv/sync", "POST");
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.deepEqual(result.extra, { merged: 2, failed: 0 }, "both snapshot channels merge");
  const list = await catalog();
  assert.equal(list.length, 3, "one main + two snapshot channels");
  const snapshotIds = list.filter(c => c.group === "Sportzfy").map(c => c.id);
  assert.deepEqual(snapshotIds, ["sportzfy-tsports", "sportzfy-cricbuzz"], "snapshot ids carry the group");
  assert.equal(list.find(c => c.id === "sportzfy-cricbuzz").category, "Cricket", "name rule picks the category");
  assert.equal(list.find(c => c.id === "sportzfy-tsports").kind, "hls", "plain HLS, no headers");
  assert.equal(list.find(c => c.id === "sportzfy-tsports").sandbox, false);
  // The app gets snapshot channels too: no headers, so they are not skipped.
  const m3u = await (await call("/api/tv/playlist.m3u")).text();
  assert.ok(m3u.includes("https://sportz.example/tsports/index.m3u8"), "snapshot channels reach the app playlist");
}
ok("snapshot channels merge behind the admin playlist on sync");

// The main playlist wins on URL collisions: a snapshot URL the admin playlist
// already carries is not merged again.
{
  routes[MAIN_PLAYLIST_URL] = reply(200, channelsJs([
    { name: "TSports HD (official)", logo: "", url: "https://sportz.example/tsports/index.m3u8" }
  ]));
  const res = await admin("/api/admin/tv/sync", "POST");
  const result = await res.json();
  assert.deepEqual(result.extra, { merged: 1, failed: 0 }, "only the colliding URL is skipped (CricBuzz still merges)");
  const list = await catalog();
  const tsports = list.filter(c => c.url === "https://sportz.example/tsports/index.m3u8");
  assert.equal(tsports.length, 1, "no duplicate URL");
  assert.equal(tsports[0].name, "TSports HD (official)", "the main playlist's fields win the matched URL");
  assert.equal(tsports[0].group, "", "the snapshot entry yields to the main list");
}
ok("the admin playlist is authoritative on colliding snapshot URLs");

// The snapshot participates in the normal sync lifecycle: entries it drops
// are removed, and id/url changes match back by URL.
{
  routes[MAIN_PLAYLIST_URL] = reply(200, channelsJs([
    { name: "ESPN", logo: "", url: "https://tv.example/espn" }
  ]));
  routes[SNAPSHOT_URL] = reply(200, snapshotM3u(["CricBuzz", "BEK"]));
  const before = await catalog();
  const cricId = before.find(c => c.name === "CricBuzz").id;
  const res = await admin("/api/admin/tv/sync", "POST");
  const result = await res.json();
  assert.equal(result.removed, 1, "dropped snapshot entry removed");
  const list = await catalog();
  assert.ok(list.some(c => c.id === cricId), "kept snapshot entry keeps its id");
  assert.ok(list.some(c => c.name === "BEK"), "new snapshot entry added");
  assert.ok(!list.some(c => c.name === "TSports"), "dropped snapshot entry gone");
}
ok("snapshot re-sync prunes dropped entries and keeps stable ids");

// A failed snapshot fetch never fails and never prunes a sync.
{
  routes[MAIN_PLAYLIST_URL] = reply(200, channelsJs([
    { name: "ESPN", logo: "", url: "https://tv.example/espn" }
  ]));
  routes[SNAPSHOT_URL] = new Error("origin down");
  const res = await admin("/api/admin/tv/sync", "POST");
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.deepEqual(result.extra, { merged: 0, failed: 1 }, "soft-failed snapshots are counted");
  const list = await catalog();
  assert.ok(list.some(c => c.name === "ESPN"), "main playlist channels synced");
  assert.ok(list.some(c => c.name === "BEK"), "snapshot channels from the last good sync survive");
}
ok("a failed snapshot fetch does not fail or prune the sync");

console.log("\nsportzfy-sync smoke: " + passed + " passed");
