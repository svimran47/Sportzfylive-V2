// Behaviour smoke test for player.html: runs its inline <script> in a stubbed
// DOM (node:vm) with a fake clock, fake <video> element and fake engine
// libraries that "load" when the player appends their <script> tag.
// Covers: the /api/play src guard, engine choice per ?type= (hls / ts / flv /
// dash / video / audio / auto), the iPhone ?format=hls path, lazy CDN loading
// with fallback (and never loading a library twice), the autoplay
// muted-retry + "Tap to unmute" button, and capped reconnects.
// Stream URLs here are synthetic; the player only ever sees /api/play paths.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../player.html", import.meta.url), "utf8");
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
assert.equal(inline.length, 1, "player.html has exactly one inline script");
const SCRIPT = inline[0];

const ORIGIN = "https://sportzfylive.example";
const CDN = {
  hls: [
    "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js",
    "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"
  ],
  mpegts: [
    "https://cdn.jsdelivr.net/npm/mpegts.js@1.8.0/dist/mpegts.js",
    "https://unpkg.com/mpegts.js@1.8.0/dist/mpegts.js"
  ],
  dash: [
    "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/dashjs/4.7.4/dash.all.min.js"
  ]
};
const TEXT = {
  unavailable: "This stream is not available.",
  load: "The stream could not be loaded. Try again later or pick another stream.",
  library: "The player could not be loaded. Check your connection and try again.",
  codec: "This stream uses a video or audio format this browser can't play. Try another browser or pick another stream."
};

let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok " + passed + " - " + name); };

// ---------------------------------------------------------------------------
// Stub environment.
// ---------------------------------------------------------------------------

function makeClassList() {
  const set = new Set();
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); }
  };
}

function makeElement(tag, id = "") {
  const listeners = {};
  const attrs = {};
  const el = {
    tagName: tag.toUpperCase(),
    id,
    hidden: false,
    textContent: "",
    parentNode: null,
    classList: makeClassList(),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners[type] || [])]) fn.call(el, { type, ...event });
    },
    listenerCount(type) { return (listeners[type] || []).length; },
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    removeAttribute(name) { delete attrs[name]; },
    hasAttribute(name) { return name in attrs; },
    focus() {}
  };
  return el;
}

function makeVideo(env) {
  const video = makeElement("video", "video");
  video.muted = false;
  video.volume = 1;
  video.paused = true;
  video.error = null;
  video.currentTime = 0;
  video.readyState = 0;
  video.playCalls = [];
  video.loads = 0;
  video.srcHistory = [];
  Object.defineProperty(video, "src", {
    get() { return video.getAttribute("src") || ""; },
    set(value) { video.setAttribute("src", value); video.srcHistory.push(String(value)); }
  });
  video.canPlayType = (mime) => (mime === "application/vnd.apple.mpegurl" && env.opts.nativeHls ? "maybe" : "");
  video.load = () => { video.loads += 1; video.error = null; };
  video.play = () => {
    video.playCalls.push({ muted: video.muted });
    if (env.opts.autoplay === "blocked" && !video.muted) {
      const err = new Error("play() failed because the user didn't interact with the document first.");
      err.name = "NotAllowedError";
      return Promise.reject(err);
    }
    if (env.opts.autoplay === "never") {
      const err = new Error("blocked");
      err.name = "NotAllowedError";
      return Promise.reject(err);
    }
    video.paused = false;
    return Promise.resolve();
  };
  return video;
}

// --- Fake engine libraries ------------------------------------------------

function fakeHls(env) {
  class Hls {
    static isSupported() { return env.opts.hlsSupported !== false; }
    constructor(config) {
      this.config = config;
      this.handlers = {};
      this.calls = [];
      this.destroyed = false;
      env.hlsInstances.push(this);
    }
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    emit(name, data) { for (const fn of this.handlers[name] || []) fn(name, data); }
    loadSource(url) { this.calls.push(["loadSource", url]); }
    attachMedia(media) { this.media = media; this.calls.push(["attachMedia"]); }
    startLoad() { this.calls.push(["startLoad"]); }
    recoverMediaError() { this.calls.push(["recoverMediaError"]); }
    swapAudioCodec() { this.calls.push(["swapAudioCodec"]); }
    destroy() { this.destroyed = true; }
  }
  Hls.Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
  Hls.ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" };
  return Hls;
}

function fakeMpegts(env) {
  return {
    Events: { ERROR: "error", LOADING_COMPLETE: "loading_complete" },
    ErrorTypes: { NETWORK_ERROR: "NetworkError", MEDIA_ERROR: "MediaError", OTHER_ERROR: "OtherError" },
    ErrorDetails: {
      NETWORK_EXCEPTION: "Exception",
      MEDIA_MSE_ERROR: "MediaMSEError",
      MEDIA_FORMAT_ERROR: "FormatError",
      MEDIA_FORMAT_UNSUPPORTED: "FormatUnsupported",
      MEDIA_CODEC_UNSUPPORTED: "CodecUnsupported"
    },
    getFeatureList() { return { mseLivePlayback: env.opts.mpegtsSupported !== false }; },
    isSupported() { return env.opts.mpegtsSupported !== false; },
    createPlayer(source, config) {
      const player = {
        source,
        config,
        handlers: {},
        calls: [],
        destroyed: false,
        on(name, fn) { (player.handlers[name] = player.handlers[name] || []).push(fn); },
        emit(name, ...args) { for (const fn of player.handlers[name] || []) fn(...args); },
        attachMediaElement(media) { player.media = media; player.calls.push("attach"); },
        load() { player.calls.push("load"); },
        destroy() { player.destroyed = true; }
      };
      env.mpegtsPlayers.push(player);
      return player;
    }
  };
}

function fakeDash(env) {
  function MediaPlayer() {
    return {
      create() {
        const player = {
          handlers: {},
          resetCalled: false,
          on(name, fn) { (player.handlers[name] = player.handlers[name] || []).push(fn); },
          emit(name, data) { for (const fn of player.handlers[name] || []) fn(data); },
          initialize(media, url, autoPlay) { player.init = { media, url, autoPlay }; },
          setProtectionData(data) { player.protectionData = data; },
          reset() { player.resetCalled = true; }
        };
        env.dashPlayers.push(player);
        return player;
      }
    };
  }
  MediaPlayer.events = { ERROR: "error", PLAYBACK_NOT_ALLOWED: "playbackNotAllowed" };
  return { MediaPlayer, supportsMediaSource: () => env.opts.mse !== false };
}

const GLOBAL_FOR = (url) => (/hls\.js|hls\.min/.test(url) ? "Hls" : /mpegts/.test(url) ? "mpegts" : /dash/.test(url) ? "dashjs" : null);

// --- Boot -------------------------------------------------------------------

function boot(search, opts = {}) {
  const env = {
    opts: { nativeHls: false, mse: true, autoplay: "allowed", cdnFail: [], ...opts },
    scripts: [],
    hlsInstances: [],
    mpegtsPlayers: [],
    dashPlayers: [],
    timers: [],
    now: 0,
    nextTimer: 1
  };
  const video = makeVideo(env);
  const elements = {
    video,
    msg: makeElement("div", "msg"),
    spinner: makeElement("div", "spinner"),
    unmute: makeElement("button", "unmute")
  };
  elements.unmute.hidden = true;
  const head = makeElement("head");
  head.children = [];
  head.appendChild = (node) => {
    node.parentNode = head;
    head.children.push(node);
    env.scripts.push(node);
    // Network: the tag "loads" (or fails) on the next tick.
    env.setTimeout(() => {
      if (env.opts.cdnFail.includes(node.src)) {
        node.onerror && node.onerror();
        return;
      }
      const name = GLOBAL_FOR(node.src);
      if (name === "Hls") context.Hls = fakeHls(env);
      if (name === "mpegts") context.mpegts = fakeMpegts(env);
      if (name === "dashjs") context.dashjs = fakeDash(env);
      node.onload && node.onload();
    }, 0);
  };
  head.removeChild = (node) => {
    head.children = head.children.filter((n) => n !== node);
    node.parentNode = null;
  };
  const document = {
    head,
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => makeElement(tag)
  };

  env.setTimeout = (fn, ms = 0) => {
    const id = env.nextTimer++;
    env.timers.push({ id, at: env.now + Math.max(0, Number(ms) || 0), fn });
    return id;
  };
  env.clearTimeout = (id) => { env.timers = env.timers.filter((t) => t.id !== id); };

  const windowListeners = {};
  const context = {
    document,
    location: { search, origin: ORIGIN, href: ORIGIN + "/player.html" + search },
    URL,
    URLSearchParams,
    console,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); }
  };
  if (env.opts.mse) context.MediaSource = function MediaSource() {};
  if (env.opts.mms) context.ManagedMediaSource = function ManagedMediaSource() {};
  if (env.opts.fetch) context.fetch = env.opts.fetch;
  context.window = context;
  env.context = context;
  env.video = video;
  env.el = elements;
  env.fireWindow = (type, event = {}) => { for (const fn of windowListeners[type] || []) fn({ type, ...event }); };

  // Advance the fake clock, running due timers in order and letting promise
  // callbacks settle in between.
  env.tick = async (ms = 0) => {
    const target = env.now + ms;
    await flush();
    for (;;) {
      const due = env.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      env.timers = env.timers.filter((t) => t !== due);
      env.now = due.at;
      due.fn();
      await flush();
    }
    env.now = target;
  };

  vm.createContext(context);
  vm.runInContext(SCRIPT, context, { filename: "player.html#script" });
  return env;
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const msgShown = (env) => env.el.msg.classList.contains("show");
const spinnerShown = (env) => env.el.spinner.classList.contains("show");
const SRC = "/api/play/tv/italy-eurosport-2-hd";
const URL_FOR = ORIGIN + SRC;
const query = (params) => "?" + new URLSearchParams(params).toString();

// ---------------------------------------------------------------------------
// 1. Only the Worker's /api/play paths are accepted.
// ---------------------------------------------------------------------------

console.log("# src guard");

for (const bad of [
  "",
  "http://iptv.example:8080/live/user/pass/1001.ts",
  "//evil.example/api/play/tv/x",
  "/api/play/tv/",
  "/api/play/tv/a/b",
  "/api/play/tv/x?format=hls",
  "/api/play/stream/only-match",
  "/api/other/tv/x"
]) {
  for (const type of ["hls", "ts", "dash", "video", "auto"]) {
    const env = boot(query({ src: bad, type }));
    await env.tick(1000);
    assert.ok(msgShown(env), "error overlay for " + JSON.stringify(bad));
    assert.equal(env.el.msg.textContent, TEXT.unavailable);
    assert.equal(env.scripts.length, 0, "no engine is loaded for " + JSON.stringify(bad));
    assert.equal(env.video.srcHistory.length, 0, "the video gets no src for " + JSON.stringify(bad));
    assert.ok(!spinnerShown(env), "no spinner behind the error");
  }
}
ok("invalid src shows a message and loads nothing");

{
  const env = boot(query({ src: "/api/play/stream/match-1/stream-2", type: "video" }));
  assert.equal(env.video.src, ORIGIN + "/api/play/stream/match-1/stream-2");
  assert.ok(!msgShown(env));
}
ok("match stream paths are accepted");

// ---------------------------------------------------------------------------
// 2. HLS (the default type).
// ---------------------------------------------------------------------------

console.log("# hls");

{
  const env = boot(query({ src: SRC }), { nativeHls: true });
  assert.equal(env.video.src, URL_FOR, "native HLS plays the absolute /api/play URL");
  assert.equal(env.scripts.length, 0, "no library for native HLS");
  assert.ok(env.video.playCalls.length >= 1, "play() is attempted");
  assert.ok(spinnerShown(env), "spinner while the stream starts");
  env.video.dispatch("playing");
  assert.ok(!spinnerShown(env), "spinner hidden once playing");
  env.video.dispatch("waiting");
  assert.ok(spinnerShown(env), "spinner on waiting");
  env.video.dispatch("playing");
  env.video.dispatch("stalled");
  assert.ok(spinnerShown(env), "spinner on stalled");
  env.video.readyState = 4;
  env.video.currentTime = 12;
  env.video.dispatch("timeupdate");
  assert.ok(!spinnerShown(env), "real progress after a stall hides the spinner");
}
ok("no type -> native HLS when the browser supports it");

{
  const env = boot(query({ src: SRC }), { nativeHls: true });
  for (let i = 0; i < 5; i += 1) {
    const before = env.video.srcHistory.length;
    env.video.error = { code: 4 };
    env.video.dispatch("error");
    await env.tick(1000 * 2 ** i - 1);
    assert.equal(env.video.srcHistory.length, before, "no reload before the backoff delay");
    await env.tick(1);
    assert.equal(env.video.srcHistory.length, before + 1, "native HLS reloads after " + 2 ** i + "s");
  }
  env.video.error = { code: 4 };
  env.video.dispatch("error");
  await env.tick(60000);
  assert.ok(msgShown(env), "native HLS gives up after 5 reloads");
  assert.equal(env.el.msg.textContent, TEXT.load);
}
ok("native HLS errors retry with backoff, capped at 5");

{
  const env = boot(query({ src: SRC, type: "hls" }), { nativeHls: false });
  assert.deepEqual(env.scripts.map((s) => s.src), [CDN.hls[0]], "hls.js requested from cdnjs first");
  assert.equal(env.scripts[0].crossOrigin, "anonymous");
  await env.tick(0);
  const hls = env.hlsInstances[0];
  assert.ok(hls, "hls.js player created");
  assert.equal(hls.config.enableWorker, true);
  assert.equal(hls.config.lowLatencyMode, false, "low-latency mode is off for IPTV");
  assert.deepEqual(hls.calls.slice(0, 2), [["loadSource", URL_FOR], ["attachMedia"]]);
  assert.equal(hls.media, env.video);
  const plays = env.video.playCalls.length;
  hls.emit("hlsManifestParsed", {});
  assert.equal(env.video.playCalls.length, plays + 1, "play() after MANIFEST_PARSED");

  // Media errors: recoverMediaError twice (second with swapAudioCodec), then give up.
  hls.emit("hlsError", { fatal: false, type: "networkError", details: "fragLoadError" });
  assert.ok(!msgShown(env), "non-fatal errors are left to hls.js");
  hls.emit("hlsError", { fatal: true, type: "mediaError", details: "bufferStalledError" });
  hls.emit("hlsError", { fatal: true, type: "mediaError", details: "bufferStalledError" });
  assert.deepEqual(hls.calls.filter((c) => c[0] !== "loadSource" && c[0] !== "attachMedia").map((c) => c[0]),
    ["recoverMediaError", "swapAudioCodec", "recoverMediaError"]);
  hls.emit("hlsError", { fatal: true, type: "mediaError", details: "bufferStalledError" });
  assert.ok(msgShown(env));
  assert.equal(env.el.msg.textContent, TEXT.codec);
  assert.ok(hls.destroyed, "hls.js destroyed on failure");
}
ok("type=hls without native support -> hls.js; media errors recover twice then fail");

{
  const env = boot(query({ src: SRC }), { nativeHls: false });
  await env.tick(0);
  const hls = env.hlsInstances[0];
  hls.emit("hlsError", { fatal: true, type: "networkError", details: "manifestLoadError" });
  await env.tick(1000);
  assert.deepEqual(hls.calls.at(-1), ["loadSource", URL_FOR], "a playlist that never loaded is reloaded");
  for (let i = 1; i < 5; i += 1) {
    hls.emit("hlsError", { fatal: true, type: "networkError", details: "fragLoadError" });
    await env.tick(1000 * 2 ** i);
    assert.deepEqual(hls.calls.at(-1), ["startLoad"], "segment errors resume with startLoad");
  }
  hls.emit("hlsError", { fatal: true, type: "networkError", details: "fragLoadError" });
  await env.tick(60000);
  assert.ok(msgShown(env), "fatal network errors give up after 5 retries");
  assert.equal(env.el.msg.textContent, TEXT.load);
  assert.equal(env.hlsInstances.length, 1, "hls.js is never re-created or re-loaded");
}
{
  const env = boot(query({ src: SRC }), { nativeHls: false });
  await env.tick(0);
  env.hlsInstances[0].emit("hlsError", { fatal: true, type: "mediaError", details: "manifestIncompatibleCodecsError" });
  assert.equal(env.el.msg.textContent, TEXT.codec, "incompatible codecs fail at once");
}
ok("hls.js network errors retry with backoff (max 5); codec errors fail fast");

// ---------------------------------------------------------------------------
// 3. MPEG-TS / FLV through mpegts.js, and the iPhone HLS path.
// ---------------------------------------------------------------------------

console.log("# mpeg-ts");

{
  const env = boot(query({ src: SRC, type: "ts" }), { nativeHls: true, mse: true });
  assert.deepEqual(env.scripts.map((s) => s.src), [CDN.mpegts[0]], "mpegts.js requested from jsdelivr");
  assert.equal(env.scripts[0].crossOrigin, "anonymous");
  await env.tick(0);
  assert.equal(env.mpegtsPlayers.length, 1);
  const player = env.mpegtsPlayers[0];
  assert.deepEqual({ ...player.source }, { type: "mpegts", isLive: true, url: URL_FOR });
  assert.equal(player.config.enableWorker, true);
  assert.equal(player.config.lazyLoad, false);
  assert.equal(player.config.liveBufferLatencyChasing, true);
  assert.ok(player.config.liveBufferLatencyMaxLatency > player.config.liveBufferLatencyMinRemain);
  assert.equal(player.config.seekType, "range");
  assert.deepEqual(player.calls, ["attach", "load"]);
  assert.equal(player.media, env.video);
  assert.ok(env.video.playCalls.length >= 1, "play() after load");
  assert.equal(env.video.srcHistory.length, 0, "mpegts.js owns the video source");
  assert.equal(env.hlsInstances.length + env.dashPlayers.length, 0, "only the needed library loads");
}
ok("type=ts with MSE -> mpegts.js from jsdelivr, live config, absolute url");

{
  const env = boot(query({ src: SRC, type: "flv" }));
  await env.tick(0);
  assert.equal(env.mpegtsPlayers[0].source.type, "flv");
}
ok("type=flv -> mpegts.js flv player");

for (const type of ["ts", "flv", "TS"]) {
  const env = boot(query({ src: SRC, type }), { nativeHls: true, mse: false });
  assert.equal(env.video.src, URL_FOR + "?format=hls", "iPhone plays the HLS rendition");
  assert.ok(env.video.src.endsWith("?format=hls"));
  assert.equal(env.scripts.length, 0, "no library on the iPhone path");
}
{
  // iOS 17.1+ has ManagedMediaSource: mpegts.js handles it there.
  const env = boot(query({ src: SRC, type: "ts" }), { nativeHls: true, mse: false, mms: true });
  assert.deepEqual(env.scripts.map((s) => s.src), [CDN.mpegts[0]]);
  await env.tick(0);
  assert.equal(env.mpegtsPlayers.length, 1);
  assert.equal(env.video.srcHistory.length, 0);
}
ok("type=ts/flv without MSE but native HLS -> <video src=...?format=hls>; ManagedMediaSource -> mpegts.js");

{
  const env = boot(query({ src: SRC, type: "ts" }), { nativeHls: false, mpegtsSupported: false });
  await env.tick(0);
  assert.equal(env.mpegtsPlayers.length, 0);
  assert.ok(msgShown(env), "unsupported browsers get a message");
  assert.match(env.el.msg.textContent, /browser can't play this stream/);
  const env2 = boot(query({ src: SRC, type: "ts" }), { nativeHls: true, mse: true, mpegtsSupported: false });
  await env2.tick(0);
  await env2.tick(0);
  assert.equal(env2.video.src, URL_FOR + "?format=hls", "mpegts.js unsupported but native HLS -> HLS rendition");
  assert.ok(!msgShown(env2));
}
ok("mpegts.js unsupported -> native HLS rendition or a clear message");

{
  const env = boot(query({ src: SRC, type: "ts" }));
  await env.tick(0);
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < delays.length; i += 1) {
    const current = env.mpegtsPlayers.at(-1);
    current.emit("error", "NetworkError", "HttpStatusCodeInvalid", { code: 502 });
    assert.ok(current.destroyed, "the failed player is destroyed at once");
    assert.ok(spinnerShown(env), "spinner while reconnecting");
    // A duplicate error from the dead player must not double-schedule.
    current.emit("error", "NetworkError", "Exception", {});
    await env.tick(delays[i] - 1);
    assert.equal(env.mpegtsPlayers.length, i + 1, "no reconnect before " + delays[i] + "ms");
    await env.tick(1);
    assert.equal(env.mpegtsPlayers.length, i + 2, "reconnect #" + (i + 1) + " after " + delays[i] + "ms");
    assert.deepEqual(env.mpegtsPlayers.at(-1).source.url, URL_FOR);
  }
  env.mpegtsPlayers.at(-1).emit("error", "NetworkError", "Exception", {});
  await env.tick(120000);
  assert.equal(env.mpegtsPlayers.length, 6, "reconnects are capped at 5");
  assert.ok(msgShown(env));
  assert.equal(env.el.msg.textContent, TEXT.load);
  assert.ok(!spinnerShown(env), "spinner hidden behind the error");
  assert.ok(env.mpegtsPlayers.every((p) => p.destroyed), "every player was destroyed");
}
ok("mpegts.js network errors reconnect with 1s/2s/4s/8s/16s backoff, max 5 tries");

{
  const env = boot(query({ src: SRC, type: "ts" }));
  await env.tick(0);
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 4; i += 1) {
      env.mpegtsPlayers.at(-1).emit("error", "NetworkError", "Exception", {});
      // Longest backoff here is 8s; stay under the 20s stall watchdog.
      await env.tick(16000);
    }
    env.video.dispatch("playing");
    await env.tick(20000);
  }
  assert.equal(env.mpegtsPlayers.length, 13, "12 reconnects across three stable periods");
  assert.ok(!msgShown(env), "the retry budget resets after 20s of playback");
}
ok("retry budget resets after ~20s of stable playback");

{
  const env = boot(query({ src: SRC, type: "ts" }));
  await env.tick(0);
  env.mpegtsPlayers[0].emit("error", "MediaError", "CodecUnsupported", {});
  await env.tick(60000);
  assert.equal(env.mpegtsPlayers.length, 1, "no reconnect for unsupported codecs");
  assert.equal(env.el.msg.textContent, TEXT.codec);

  const env2 = boot(query({ src: SRC, type: "ts" }));
  await env2.tick(0);
  env2.mpegtsPlayers[0].emit("error", "MediaError", "MediaMSEError", {});
  // The same failure also surfaces on the <video> element: counted once.
  env2.video.error = { code: 3 };
  env2.video.dispatch("error");
  await env2.tick(1000);
  assert.equal(env2.mpegtsPlayers.length, 2, "one reconnect after an MSE error");
  assert.ok(!msgShown(env2));
  env2.video.error = { code: 4 };
  env2.video.dispatch("error");
  await env2.tick(60000);
  assert.equal(env2.mpegtsPlayers.length, 2, "a second media failure is final");
  assert.equal(env2.el.msg.textContent, TEXT.codec);
}
ok("codec / MSE errors end with a clear message instead of endless retries");

{
  const env = boot(query({ src: SRC, type: "ts" }));
  await env.tick(0);
  env.mpegtsPlayers[0].emit("loading_complete");
  await env.tick(1000);
  assert.equal(env.mpegtsPlayers.length, 2, "an upstream that closes the live stream is reconnected");

  // Stuck buffering for 20s while "playing" -> reconnect.
  env.video.dispatch("playing");
  env.video.dispatch("waiting");
  await env.tick(19999);
  assert.equal(env.mpegtsPlayers.length, 2);
  await env.tick(1 + 2000);
  assert.equal(env.mpegtsPlayers.length, 3, "a 20s stall triggers a reconnect");
}
ok("live stream end and long stalls reconnect");

{
  const env = boot(query({ src: SRC, type: "ts" }));
  await env.tick(0);
  env.fireWindow("pagehide", { persisted: true });
  assert.ok(env.mpegtsPlayers[0].destroyed, "engine destroyed on pagehide");
  env.mpegtsPlayers[0].emit("error", "NetworkError", "Exception", {});
  await env.tick(60000);
  assert.equal(env.mpegtsPlayers.length, 1, "nothing reconnects after pagehide");
  assert.ok(!msgShown(env));
  env.fireWindow("pageshow", { persisted: true });
  await env.tick(0);
  assert.equal(env.mpegtsPlayers.length, 2, "playback resumes from the back/forward cache");
  assert.equal(env.scripts.length, 1, "the library is never loaded twice");
}
ok("pagehide cleans up; bfcache restore resumes without reloading the library");

// ---------------------------------------------------------------------------
// 4. CDN fallback.
// ---------------------------------------------------------------------------

console.log("# cdn fallback");

{
  const env = boot(query({ src: SRC, type: "ts" }), { cdnFail: [CDN.mpegts[0]] });
  await env.tick(0);
  assert.deepEqual(env.scripts.map((s) => s.src), CDN.mpegts, "falls back to unpkg");
  assert.ok(env.scripts.every((s) => s.crossOrigin === "anonymous"));
  assert.equal(env.scripts[0].parentNode, null, "the failed tag is removed");
  assert.equal(env.mpegtsPlayers.length, 1, "player created from the fallback copy");
}
{
  const env = boot(query({ src: SRC, type: "dash" }), { cdnFail: CDN.dash });
  await env.tick(0);
  assert.deepEqual(env.scripts.map((s) => s.src), CDN.dash);
  assert.equal(env.el.msg.textContent, TEXT.library, "every CDN failing -> library message");
  assert.ok(!spinnerShown(env));
}
{
  const env = boot(query({ src: SRC, type: "hls" }), { cdnFail: [CDN.hls[0]] });
  await env.tick(0);
  assert.deepEqual(env.scripts.map((s) => s.src), CDN.hls);
  assert.equal(env.hlsInstances.length, 1);
}
ok("CDN fallback on script error, and a message when every CDN fails");

// ---------------------------------------------------------------------------
// 5. DASH, plain video/audio, auto.
// ---------------------------------------------------------------------------

console.log("# other kinds");

{
  const env = boot(query({ src: SRC, type: "dash" }));
  assert.deepEqual(env.scripts.map((s) => s.src), [CDN.dash[0]], "dash.js from jsdelivr");
  await env.tick(0);
  const player = env.dashPlayers[0];
  assert.deepEqual(player.init, { media: env.video, url: URL_FOR, autoPlay: true });
  player.emit("playbackNotAllowed", {});
  assert.equal(env.video.muted, true, "dash autoplay refusal -> muted");
  assert.equal(env.el.unmute.hidden, false);
  player.emit("error", { error: { code: 27, message: "Codec is not supported" } });
  assert.equal(env.el.msg.textContent, TEXT.codec);
  assert.ok(player.resetCalled, "dash.js reset on failure");
}
ok("type=dash -> dash.js MediaPlayer().create().initialize(video, url, true)");

{
  const fetchCalls = [];
  const env = boot(query({ src: SRC, type: "dash", drm: "/api/drm/tv/clearkey-ch" }), {
    fetch: (url) => {
      fetchCalls.push(String(url));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ keys: [{ kty: "oct", kid: "ESIzRFVmd4iZABEiM0RVZg", key: "S4ByTQ74a8ssIfeZnWdznQ" }] })
      });
    }
  });
  await env.tick(0);
  const player = env.dashPlayers[0];
  assert.equal(
    JSON.stringify(player.protectionData),
    JSON.stringify({ "com.w3.clearkey": { clearkeys: { ESIzRFVmd4iZABEiM0RVZg: "S4ByTQ74a8ssIfeZnWdznQ" } } }),
    "the license response becomes ClearKey protectionData"
  );
  assert.deepEqual(player.init, { media: env.video, url: URL_FOR, autoPlay: true }, "initialize happens after the license fetch");
  assert.deepEqual(fetchCalls, [ORIGIN + "/api/drm/tv/clearkey-ch"], "the license route is fetched same-origin");
}
ok("ClearKey dash: the drm route's license becomes dash.js protectionData before initialize");
{
  const env = boot(query({ src: SRC, type: "dash", drm: "/api/drm/tv/void" }), {
    fetch: () => Promise.reject(new Error("no network"))
  });
  await env.tick(0);
  assert.equal(env.dashPlayers[0].init.url, URL_FOR, "a dead license route still initializes");
  assert.ok(!msgShown(env));
}
ok("a dead license route does not block initialization");

for (const type of ["video", "audio"]) {
  const env = boot(query({ src: SRC, type }));
  assert.equal(env.video.src, URL_FOR);
  assert.equal(env.scripts.length, 0);
  env.video.error = { code: 3 };
  env.video.dispatch("error");
  await env.tick(60000);
  assert.ok(msgShown(env), type + ": decode errors fail");
  assert.equal(env.el.msg.textContent, TEXT.codec);
}
{
  const env = boot(query({ src: SRC, type: "video" }));
  env.video.error = { code: 2 };
  env.video.dispatch("error");
  await env.tick(1000);
  assert.equal(env.video.srcHistory.length, 2, "network errors on files retry");
}
ok("type=video/audio -> native <video src>");

{
  const env = boot(query({ src: SRC, type: "something-else" }), { nativeHls: false });
  assert.equal(env.video.src, URL_FOR, "auto tries native playback first");
  env.video.error = { code: 4 };
  env.video.dispatch("error");
  await env.tick(0);
  assert.equal(env.video.src, "", "native attempt released");
  await env.tick(0);
  assert.deepEqual(env.scripts.map((s) => s.src), [CDN.hls[0]], "then hls.js");
  const hls = env.hlsInstances[0];
  hls.emit("hlsError", { fatal: true, type: "networkError", details: "manifestParsingError" });
  assert.ok(hls.destroyed);
  await env.tick(0);
  await env.tick(0);
  assert.deepEqual(env.scripts.map((s) => s.src), [CDN.hls[0], CDN.mpegts[0]], "then mpegts.js");
  assert.equal(env.mpegtsPlayers.length, 1);
  assert.equal(env.mpegtsPlayers[0].source.type, "mpegts");
  env.mpegtsPlayers[0].emit("error", "MediaError", "FormatError", {});
  await env.tick(1);
  assert.ok(msgShown(env), "auto fails once every engine was tried");
}
{
  const env = boot(query({ src: SRC, type: "auto" }));
  env.video.dispatch("canplay");
  env.video.dispatch("playing");
  await env.tick(60000);
  assert.equal(env.scripts.length, 0, "native success keeps native playback");
  assert.ok(!msgShown(env));
}
{
  const env = boot(query({ src: SRC, type: "auto" }));
  await env.tick(7999);
  assert.equal(env.scripts.length, 0);
  await env.tick(1);
  await env.tick(0);
  assert.equal(env.scripts.length, 1, "native probe times out after 8s");
}
ok("auto: native -> hls.js -> mpegts.js");

// ---------------------------------------------------------------------------
// 6. Autoplay policy.
// ---------------------------------------------------------------------------

console.log("# autoplay");

{
  const env = boot(query({ src: SRC }), { nativeHls: true, autoplay: "blocked" });
  assert.equal(env.el.unmute.hidden, true, "unmute button hidden initially");
  await env.tick(0);
  assert.equal(env.video.muted, true, "muted after NotAllowedError");
  assert.deepEqual(env.video.playCalls.map((c) => c.muted), [false, true], "play() retried muted");
  assert.equal(env.el.unmute.hidden, false, "Tap to unmute is visible");
  assert.match(html, /<button type="button" class="unmute" id="unmute" hidden>[\s\S]*?Tap to unmute<\/button>/,
    "the unmute control is a real (keyboard-focusable) button");
  env.el.unmute.dispatch("click");
  assert.equal(env.video.muted, false, "unmuted");
  assert.equal(env.el.unmute.hidden, true, "button hides itself");
}
{
  const env = boot(query({ src: SRC }), { nativeHls: true, autoplay: "blocked" });
  await env.tick(0);
  env.video.muted = false;
  env.video.dispatch("volumechange");
  assert.equal(env.el.unmute.hidden, true, "unmuting with the native controls hides the button");
}
{
  const env = boot(query({ src: SRC, type: "ts" }), { autoplay: "never" });
  await env.tick(0);
  assert.equal(env.video.playCalls.length, 2, "only one muted retry");
  assert.ok(!spinnerShown(env), "no endless spinner when even muted autoplay is refused");
  await env.tick(60000);
  assert.equal(env.mpegtsPlayers.length, 1, "a paused video is not treated as stalled");
}
ok("autoplay NotAllowedError -> muted retry + Tap to unmute");

console.log("\nAll " + passed + " player assertions passed.");
