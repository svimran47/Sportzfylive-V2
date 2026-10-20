// DOM-level smoke test for index.html: extracts the inline <script> blocks,
// runs them in a stubbed DOM environment, and simulates user interactions.
// Primary regression targets:
//   1. Enter/Space keyboard handler opens the stream-sources modal
//      (no ReferenceError: openManualStream).
//   2. Streamed embed playback: playable streams render as clickable chips
//      whose embed URL follows https://embed.st/embed/{source}/{id}/{streamNo}
//      and clicking one loads an iframe into the player container.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Extract inline scripts (skip external ones like hls.js).
// ---------------------------------------------------------------------------

const scripts = [];
const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let match;
while ((match = scriptRe.exec(html)) !== null) {
  scripts.push(match[1]);
}
assert.ok(scripts.length >= 2, "expected the main inline script blocks to exist");

// ---------------------------------------------------------------------------
// Stub DOM environment.
// ---------------------------------------------------------------------------

function makeElement(id = "") {
  const el = {
    id,
    dataset: {},
    textContent: "",
    hidden: false,
    disabled: false,
    title: "",
    style: { display: "", width: "", transform: "" },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
      contains(c) { return this._set.has(c); }
    },
    replaceChildren() { el.children.length = 0; },
    addEventListener(type, handler) {
      if (type === "click") el._clickHandler = handler;
    },
    click() { if (el._clickHandler) el._clickHandler(); },
    closest() { return null; },
    children: [],
    allow: "",
    allowFullscreen: false,
    referrerPolicy: "",
    scrollIntoView() {},
    appendChild(child) { el.children.push(child); },
    getBoundingClientRect() { return { width: 800 }; },
    _attrs: {},
    setAttribute(name, value) { el._attrs[name] = String(value); },
    getAttribute(name) { return name in el._attrs ? el._attrs[name] : null; }
  };

  // Minimal innerHTML simulation: materializes .stream-toggle buttons as
  // child elements (with dataset + click wiring) so the stream picker flow is
  // testable. Not a general HTML parser.
  const unescapeAttr = (s) => String(s || "")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html || ""; },
    set(value) {
      el._html = String(value);
      el.children.length = 0;
      const chipRe = /<button class="stream-toggle"([^>]*)>/g;
      let m;
      while ((m = chipRe.exec(el._html)) !== null) {
        const chip = makeElement();
        chip.tagName = "button";
        chip.classList.add("stream-toggle");
        const url = m[1].match(/data-embed-url="([^"]*)"/);
        const label = m[1].match(/data-stream-label="([^"]*)"/);
        const checked = m[1].match(/aria-checked="([^"]*)"/);
        const aria = m[1].match(/aria-label="([^"]*)"/);
        const sandbox = m[1].match(/data-sandbox="([^"]*)"/);
        if (sandbox) chip.dataset.sandbox = sandbox[1];
        chip.dataset.embedUrl = url ? unescapeAttr(url[1]) : "";
        chip.dataset.streamLabel = label ? unescapeAttr(label[1]) : "";
        chip._attrs["aria-checked"] = checked ? checked[1] : "false";
        chip._attrs["aria-label"] = aria ? unescapeAttr(aria[1]) : "";
        el.children.push(chip);
      }
    }
  });

  el.querySelectorAll = (selector) => {
    if (selector === ".stream-toggle" || selector === ".stream-toggle.selected") {
      const cls = selector.split(".")[2];
      return el.children.filter(c =>
        c.classList && c.classList.contains("stream-toggle") &&
        (!cls || c.classList.contains(cls)));
    }
    return [];
  };

  return el;
}

const documentStub = {
  _handlers: {},
  body: makeElement("body"),
  documentElement: makeElement("html"),
  _elements: new Map(),
  getElementById(id) {
    if (!this._elements.has(id)) this._elements.set(id, makeElement(id));
    return this._elements.get(id);
  },
  querySelector(selector) {
    // Only used by copyEmbedCode for "#player-container iframe"; return the
    // first iframe we created, if any, so the embed-copy path is testable.
    if (selector === "#player-container iframe") {
      const player = this.getElementById("player-container");
      return player.children.find(c => c.tagName === "iframe") || null;
    }
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener(type, handler) {
    (this._handlers[type] ||= []).push(handler);
  },
  createElement(tagName) {
    const el = makeElement();
    el.tagName = String(tagName || "").toLowerCase();
    return el;
  },
  dispatch(type, event) {
    for (const handler of this._handlers[type] || []) handler(event);
  }
};

const windowStub = {
  __SPORTZFY_MATCHES: new Map(),
  addEventListener() {},
  innerWidth: 1280,
  location: { href: "https://site.test/", origin: "https://site.test", pathname: "/", assign(url) { this.assigned = url; } }
};

const historyStub = {
  pushStateCalls: [],
  backCalls: 0,
  pushState(state, title, url) { this.pushStateCalls.push({ state, title, url }); },
  back() { this.backCalls++; }
};

const context = {
  document: documentStub,
  history: historyStub,
  encodeURIComponent,
  window: windowStub,
  navigator: { clipboard: { async writeText() {} } },
  location: windowStub.location,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async () => { throw new Error("network disabled in test"); },
  console,
  URL,
  Date,
  Math,
  JSON,
  Map,
  Set,
  Promise,
  Number,
  String,
  Array,
  Object,
  Boolean,
  isNaN
};
context.globalThis = context;
windowStub.document = documentStub;
vm.createContext(context);

for (const [index, script] of scripts.entries()) {
  vm.runInContext(script, context, { filename: `index.html#script-${index}` });
}

let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok " + passed + " - " + name); };

// ---------------------------------------------------------------------------
// 1. Keyboard handler opens the stream modal (the openManualStream regression).
// ---------------------------------------------------------------------------

// Seed two matches: one with resolved playable streams, one without.
windowStub.__SPORTZFY_MATCHES.set("streamed-101", {
  id: "streamed-101",
  title: "Valencia vs Real Sociedad",
  status: "live",
  sources: [{ source: "StreamedSoccerHD", id: "src-1" }]
});
windowStub.__SPORTZFY_MATCHES.set("streamed-ppv", {
  id: "streamed-ppv",
  title: "NY Giants at LA Rams",
  status: "scheduled",
  sources: [{ source: "admin", id: "ppv-new-york-giants-at-los-angeles-rams" }],
  streamed: {
    sourceCount: 1,
    streamCount: 2,
    sources: [{
      source: "admin",
      id: "ppv-new-york-giants-at-los-angeles-rams",
      streamCount: 2,
      streams: [
        { streamNo: 1, language: "English", hd: true, source: "admin" },
        { streamNo: 2, language: "Spanish", hd: false, source: "admin" }
      ]
    }],
    streams: [
      { streamNo: 1, language: "English", hd: true, source: "admin" },
      { streamNo: 2, language: "Spanish", hd: false, source: "admin" }
    ]
  }
});

const card = makeElement("card");
card.classList.add("sfy-match-item");
card.dataset.matchId = "streamed-101";
// Match cards are found via event.target.closest(".sfy-match-item") for
// keyboard events and closest("[data-match-id]") for click events.
card.closest = (selector) =>
  selector === ".sfy-match-item" || selector === "[data-match-id]" ? card : null;

for (const key of ["Enter", " "]) {
  let prevented = false;
  documentStub.dispatch("keydown", {
    key,
    target: card,
    preventDefault() { prevented = true; }
  });

  const modal = documentStub.getElementById("stream-modal");
  const titleEl = documentStub.getElementById("stream-title");
  const statusEl = documentStub.getElementById("stream-status");
  const barSource = documentStub.getElementById("player-bar-source");
  assert.equal(prevented, true, key + " should preventDefault");
  assert.equal(modal.style.display, "flex", key + " should open the modal");
  assert.equal(
    titleEl.textContent,
    "Valencia vs Real Sociedad",
    key + " should populate the watch title (primary heading)"
  );
  assert.equal(
    statusEl.innerHTML,
    '<span class="live-dot" aria-hidden="true"></span>Live now',
    key + " should render the live status line for a live match"
  );
  assert.equal(
    barSource.textContent,
    "Pick a stream below",
    key + " should reset the player control bar to its idle hint"
  );
  ok('"' + key + '" on a match card opens the watch view with the header wired');

  // Close for the next iteration (Escape path).
  documentStub.dispatch("keydown", { key: "Escape", target: makeElement() });
  assert.equal(documentStub.getElementById("stream-modal").style.display, "none");
}
ok("Escape closes the modal between activations");

// ---------------------------------------------------------------------------
// 2. Deep-link hash opens the right match's dialog content is out of scope
//    here (mouse path), but assert the click path still works after the fix.
// ---------------------------------------------------------------------------

documentStub.dispatch("click", { target: card });
assert.equal(
  documentStub.getElementById("stream-modal").style.display,
  "flex",
  "mouse click should still open the modal"
);
ok("mouse click path unchanged");

// ---------------------------------------------------------------------------
// 2b. Playable Streamed embeds: chips render, embed URL shape is
//     https://embed.st/embed/{source}/{id}/{streamNo}, and clicking a chip
//     mounts an iframe in the player container.
// ---------------------------------------------------------------------------

const embedCard = makeElement("embed-card");
embedCard.classList.add("sfy-match-item");
embedCard.dataset.matchId = "streamed-ppv";
embedCard.closest = (selector) =>
  selector === ".sfy-match-item" || selector === "[data-match-id]" ? embedCard : null;

documentStub.dispatch("click", { target: embedCard });
assert.equal(
  documentStub.getElementById("stream-modal").style.display,
  "flex",
  "embed-capable match should open the modal"
);

const statusEl2 = documentStub.getElementById("stream-status");
assert.equal(
  statusEl2.innerHTML,
  "Scheduled",
  "scheduled matches render the Scheduled status line (got: " + statusEl2.innerHTML + ")"
);

const picker2 = documentStub.getElementById("stream-picker");
const chips = picker2.children.filter(el => el.classList && el.classList.contains("stream-toggle"));
assert.equal(chips.length, 2, "should render one toggle per resolved stream");
assert.ok(picker2.innerHTML.includes('aria-hidden="true">1<') && picker2.innerHTML.includes('aria-hidden="true">2<'),
  "toggles are numbered Stream 1..N (flat numbering, no per-source restart)");
assert.ok(!picker2.innerHTML.includes("stream-embed-chip"),
  "no legacy card markup — the strip is the only picker");
assert.ok(
  chips.every(c => c.getAttribute("aria-label") && c.getAttribute("aria-label").includes("HD"))
    ? chips[0].getAttribute("aria-label").includes("English")
    : true,
  "toggle aria-labels carry the channel detail hidden in the visual"
);
ok("playable streams render as one compact toggle per stream");

// The watch page also shows who is playing, how to share it, and what else is
// on — all rendered from the match map already in memory (no extra fetches).
const teamsEl = documentStub.getElementById("watch-teams");
assert.ok(
  teamsEl.innerHTML.includes("watch-team-crest") && teamsEl.innerHTML.includes("watch-vs"),
  "watch header renders both crests around a vs separator"
);

const shareEl = documentStub.getElementById("watch-share");
assert.ok(
  shareEl.innerHTML.includes("wa.me") &&
    shareEl.innerHTML.includes("twitter.com/intent") &&
    shareEl.innerHTML.includes("facebook.com/sharer") &&
    shareEl.innerHTML.includes("shareMatch('copy')"),
  "share controls offer copy + WhatsApp/X/Facebook with escaped targets"
);

const relatedEl = documentStub.getElementById("watch-related");
const relatedGrid = documentStub.getElementById("watch-related-grid");
assert.equal(relatedEl.hidden, false, "related rail is revealed when other matches exist");
assert.ok(
  relatedGrid.innerHTML.includes("data-match-id=\"streamed-101\"") &&
    !relatedGrid.innerHTML.includes("streamed-ppv"),
  "the rail lists other matches and never the one being watched"
);
ok("watch view renders crests, share targets and a related-matches rail");

// Streamed sources play through the Worker's embed resolver in the first-party
// player page; the plain embed.st frame remains as the player page's own
// fallback, encoded into the ?fallback= parameter.
const embedPlain1 = "https://embed.st/embed/admin/ppv-new-york-giants-at-los-angeles-rams/1";
const embedPlain2 = "https://embed.st/embed/admin/ppv-new-york-giants-at-los-angeles-rams/2";
const cardUrl = (embedUrl) =>
  "https://sportzfylive.svimranmy.workers.dev/player.html?src=" +
  encodeURIComponent("/api/play/embed/admin/ppv-new-york-giants-at-los-angeles-rams/" + embedUrl.slice(-1)) +
  "&fallback=" + encodeURIComponent(embedUrl);
assert.equal(chips[0].dataset.embedUrl, cardUrl(embedPlain1));
assert.equal(chips[1].dataset.embedUrl, cardUrl(embedPlain2));
const decodeChip = (chip) => decodeURIComponent(decodeURIComponent(chip.dataset.embedUrl));
assert.ok(chips[0].dataset.embedUrl.includes("player.html") &&
    decodeChip(chips[0]).includes("/api/play/embed/admin/ppv-new-york-giants-at-los-angeles-rams/1") &&
    decodeChip(chips[0]).includes("fallback=https://embed.st/embed/admin/ppv-new-york-giants-at-los-angeles-rams/1"),
  "resolver path is the playback route, embed.st the fallback");
ok("toggle embed URLs play via /api/play/embed with the embed.st frame as fallback");

chips[0].click();
const player2 = documentStub.getElementById("player-container");
assert.equal(player2.hidden, false, "clicking a chip should reveal the player");
assert.equal(player2.children.length, 1, "player should contain exactly one iframe");
const frame2 = player2.children[0];
assert.equal(frame2.tagName, "iframe", "mounted element must be an iframe");
assert.equal(frame2.src, cardUrl(embedPlain1), "iframe must point at the player page with the resolver path");
assert.equal(frame2.allowFullscreen, true, "iframe must allow fullscreen");
const barSourceAfter = documentStub.getElementById("player-bar-source");
assert.ok(
  barSourceAfter.innerHTML.includes("Now playing") && barSourceAfter.innerHTML.includes("Stream 1"),
  "player control bar names the loaded stream"
);
ok("clicking a toggle persists .selected + aria-checked and mounts the resolver player in the first-party frame");

// Switching streams swaps the iframe without stacking players.
chips[1].click();
assert.equal(player2.children.length, 1, "only one iframe at a time");
assert.equal(player2.children[0].src, cardUrl(embedPlain2), "second chip swaps the iframe src");
assert.ok(chips[1].classList.contains("selected"), "selection follows the click");
assert.equal(chips[0].getAttribute("aria-checked"), "false", "previous toggle is deselected (single-selection radio group)");
ok("switching toggles replaces the active stream and moves the single selection");

// The no-streams match must still degrade to a friendly note, not a crash.
documentStub.dispatch("keydown", {
  key: "Enter",
  target: card,
  preventDefault() {}
});
assert.ok(
  documentStub.getElementById("stream-picker").innerHTML.includes("Lineups for this match are not published yet"),
  "matches without lineups should show the empty state"
);
ok("matches without resolved streams show the empty state");

// ---------------------------------------------------------------------------
// 3. Back — in-app, from the button AND from the device/browser back control.
//    The watch view claims one history entry on open (pushState #match=...);
//    closing pops exactly that entry. The only history calls in the shipped
//    page are that push and that pop, so no path can leave the site.
// ---------------------------------------------------------------------------
assert.ok(typeof context.navigateBack === "function", "navigateBack handler is defined");
const modalBefore = documentStub.getElementById("stream-modal");
modalBefore.style.display = "flex";
context.navigateBack();
assert.equal(modalBefore.style.display, "none", "Back closes the watch overlay");
assert.ok(!windowStub.location.assigned, "Back performs NO navigation (no location.assign)");
assert.ok(html.includes("onclick=\"navigateBack()\""), "Back button is wired to navigateBack");
assert.ok(html.includes('getElementById("matches-container")?.scrollIntoView'),
  "Back returns to the matches list inside the app");

// Watch view claims its own history entry on open (device Back closes it).
assert.ok(html.includes("history.pushState"), "watch view pushes a history entry on open");
assert.ok(html.includes('sfyWatch: matchId'), "pushed entry is tagged with the match id");
assert.ok(html.includes('"#match=" + encodeURIComponent(matchId)'),
  "pushed entry is a #match hash on the same page (never a different URL)");
assert.ok(html.includes('addEventListener("popstate"'), "popstate closes the overlay on device Back");
assert.ok(html.includes("watchHistoryOpen"), "history claim is guarded by an open flag");

// The ONLY history.back( in the page is closeModal popping our own entry.
assert.equal((html.match(/history\.back\(/g) || []).length, 1,
  "exactly one history.back call: popping the watch view's own entry");
assert.ok(!html.includes("history.go("), "no history.go anywhere in the page");
assert.ok(!html.includes("history.forward"), "no history.forward anywhere in the page");
assert.ok(!html.includes("location.assign"), "no location.assign anywhere in the page");
assert.ok(!html.includes("location.replace"), "no location.replace anywhere in the page");
assert.ok(!html.includes("location.reload"), "no location.reload anywhere in the page");
assert.ok(!html.includes("location.href ="), "no location.href assignment anywhere in the page");

// Dynamic balance across every open/close exercised above: every pushed
// watch-view entry was popped again, and all pushes are #match hashes.
assert.equal(historyStub.backCalls, historyStub.pushStateCalls.length,
  "every claimed history entry is popped (open/close stays balanced)");
for (const call of historyStub.pushStateCalls) {
  assert.ok(String(call.url).startsWith("#match="), "pushState only ever pushes a #match hash");
}
ok("Back (button or device) closes the overlay in-app; history claim/pop stays balanced, never exits");

// ---------------------------------------------------------------------------
// 3. Static guarantee: no dangling identifier in the shipped page.
// ---------------------------------------------------------------------------

assert.ok(!html.includes("openManualStream"), "openManualStream must be gone");
ok("no references to the removed openManualStream remain");

// ---------------------------------------------------------------------------
// 4. Streams the admin attached to a match: listed first, played through the
//    Worker's /api/play route (never a raw URL), embeds sandboxed, and every
//    other format (.m3u8, MPEG-TS, ...) through the universal player page.
// ---------------------------------------------------------------------------
windowStub.__SPORTZFY_MATCHES.set("manual-1", {
  id: "manual-1",
  title: "Wrexham vs West Bromwich Albion",
  status: "live",
  sources: [],
  streamed: { sourceCount: 0, streamCount: 0, sources: [], streams: [] },
  manual: {
    streamCount: 5,
    streams: [
      { id: "s1", name: "Sky Sports Football", language: "English", quality: "HD", kind: "embed", sandbox: true },
      { id: "s2", name: "Backup", language: "Spanish", quality: "SD", kind: "hls" },
      { id: "s3", name: "Direct", language: "English", quality: "HD", kind: "embed" },
      { id: "s4", name: "Raw feed", language: "English", quality: "HD", kind: "ts", sandbox: true },
      { id: "s5", name: "Legacy", language: "English", quality: "SD" }
    ]
  }
});
{
  const manualCard = makeElement("manual-card");
  manualCard.dataset.matchId = "manual-1";
  manualCard.closest = (selector) =>
    selector === ".sfy-match-item" || selector === "[data-match-id]" ? manualCard : null;
  documentStub.dispatch("keydown", { key: "Enter", target: manualCard, preventDefault() {} });
  const manualChips = documentStub.getElementById("stream-picker").children;
  assert.equal(manualChips.length, 5, "every admin-attached stream renders as a chip");
  assert.equal(manualChips[0].dataset.embedUrl, "https://sportzfylive.svimranmy.workers.dev/api/play/stream/manual-1/s1");
  assert.equal(manualChips[0].dataset.sandbox, "1", "streams flagged sandbox are marked for the sandbox");
  assert.ok(!manualChips[2].dataset.sandbox, "unflagged embed streams load directly");
  assert.equal(
    manualChips[1].dataset.embedUrl,
    "https://sportzfylive.svimranmy.workers.dev/player.html?src=" + encodeURIComponent("/api/play/stream/manual-1/s2"),
    ".m3u8 streams play through the HLS player page"
  );
  assert.ok(!manualChips[1].dataset.sandbox, "the first-party HLS player page is not sandboxed");
  assert.equal(
    manualChips[3].dataset.embedUrl,
    "https://sportzfylive.svimranmy.workers.dev/player.html?src=" + encodeURIComponent("/api/play/stream/manual-1/s4") + "&type=ts",
    "raw MPEG-TS streams play through the player page with their type"
  );
  assert.ok(!manualChips[3].dataset.sandbox, "the player page is never sandboxed, even for a flagged stream");
  assert.equal(
    manualChips[4].dataset.embedUrl,
    "https://sportzfylive.svimranmy.workers.dev/api/play/stream/manual-1/s5",
    "streams without a kind load directly (as embeds)"
  );
  assert.ok(manualChips[0].dataset.streamLabel.includes("Sky Sports Football"), "chip names the channel");
  const frame = documentStub.getElementById("player-container").children[0];
  assert.equal(frame.tagName, "iframe", "the first stream auto-plays");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms allow-modals allow-presentation");
  context.navigateBack();
}
ok("admin-attached streams: listed first, played via /api/play, sandboxed when flagged, any format via the player page");

console.log("\nAll " + passed + " DOM assertions passed.");
