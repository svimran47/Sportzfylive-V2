// Sportzfy admin panel: a hash-routed single page app on top of the Worker's
// /api/admin/* endpoints. Pages: Dashboard, Matches (+ create/detail/streams),
// Live TV channels (+ import/sync), Fetch Logs and Settings.
"use strict";

// Same origin when the Worker serves this page (workers.dev, or `wrangler dev`
// on its default port); the deployed Worker otherwise (static preview server).
const API = (location.hostname.endsWith("workers.dev") || location.port === "8787")
  ? location.origin
  : "https://sportzfylive.svimranmy.workers.dev";
// The Worker serves the public site from the same origin as the API.
const SITE = API;
const SESSION_KEY = "sportzfy_admin_session";
const MATCH_PAGE_SIZE = 50;
const CHECK_BATCH = 25;
const TV_PAGE_SIZE = 100;
const CATALOG_LIMIT = 200;
const LANGUAGES = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Arabic", "Hindi", "Bengali", "Urdu", "Polish", "Turkish", "Dutch", "Russian", "Multi-language", "Other"];
const QUALITIES = ["HD", "SD", "FHD", "4K"];
// The Worker's TV categories, used until /api/admin/settings provides its list.
const TV_CATEGORIES = ["Sports", "Football", "Cricket", "Motorsport", "Fight", "Tennis", "Golf", "Basketball", "Horse Racing", "Entertainment", "Kids", "News", "Movies"];
const STREAM_URL_HINT = "http or https — an HLS (.m3u8), DASH (.mpd), MPEG-TS (.ts), FLV, MP4/WebM, audio stream, or an embed page. http streams play through the Worker.";
// Client-side pre-check only (scheme + host); the Worker validates the rest.
const STREAM_URL_RE = /^https?:\/\/[^\s/?#|]+/i;
const NOTICE_SWATCHES = ["#7f1d1d", "#111827", "#166534", "#1d4ed8", "#6d28d9", "#c2410c"];

const state = {
  session: localStorage.getItem(SESSION_KEY) || "",
  matches: null,
  tv: null,
  settings: null,
  syncLog: null,
  renderId: 0,
  matchFilter: { q: "", date: "", chip: "all", page: 1 },
  matchSelection: new Set(),
  tvFilter: { q: "", chip: "all", category: "", group: "", page: 1 },
  tvSelection: new Set(),
  currentMatch: null,
  streamModal: null,
  importRun: null
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
const plural = (n, word, many = word + "s") => n + " " + (n === 1 ? word : many);

const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  tick: '<path d="M20 6 9 17l-5-5"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  tv: '<rect x="2" y="7" width="20" height="15" rx="2"/><path d="m17 2-5 5-5-5"/>',
  edit: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4Z"/>',
  logs: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6M8 18v-2M12 18v-4M16 18v-6"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  signal: '<path d="M2 12h3M19 12h3M7.76 7.76a6 6 0 0 0 0 8.48M16.24 7.76a6 6 0 0 1 0 8.48"/><circle cx="12" cy="12" r="2"/>',
  id: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M15 8h2M15 12h2M7 16h10"/>'
};

function icon(name, size = 22) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
}

function toast(message, kind = "info") {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", kind === "error");
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 5000 : 2800);
}

async function api(path, options = {}) {
  const headers = {
    "Accept": "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(state.session ? { "X-Admin-Session": state.session } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(API + path, { ...options, headers });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (response.status === 401 && state.session) {
    showLogin();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!response.ok) throw new Error(data?.error || "Request failed (HTTP " + response.status + ")");
  return data;
}

const send = (path, method, body) => api(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

// Buttons show progress while an action runs and can't be double-submitted.
async function busy(button, label, task) {
  if (!button) return task();
  const original = button.innerHTML;
  button.disabled = true;
  if (label) button.textContent = label;
  try {
    return await task();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

const TZ_LABEL = (() => {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date())
      .find(p => p.type === "timeZoneName");
    return part ? part.value : "local";
  } catch (_) {
    return "local";
  }
})();

const toMs = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : null;
};
const pad = (n) => String(n).padStart(2, "0");
function localDate(iso) {
  const t = toMs(iso);
  if (t === null) return "";
  const d = new Date(t);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function localTime(iso) {
  const t = toMs(iso);
  if (t === null) return "";
  const d = new Date(t);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function clock(iso, timeZone) {
  const t = toMs(iso);
  if (t === null) return "";
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}
function stamp(iso) {
  const t = toMs(iso);
  return t === null ? "—" : new Date(t).toLocaleString("en-GB", { hour12: true });
}
function ago(iso) {
  const t = toMs(iso);
  if (t === null) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const text = a < 45 ? "just now"
    : a < 3600 ? Math.round(a / 60) + "m"
    : a < 86400 ? Math.round(a / 3600) + "h"
    : Math.round(a / 86400) + "d";
  if (text === "just now") return text;
  return future ? "in " + text : text + " ago";
}
function composeIso(date, time) {
  if (!date) return "";
  const d = new Date(date + "T" + (time || "00:00"));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/* ------------------------------------------------------------------ */
/* Match helpers (mirror the Worker's rules)                           */
/* ------------------------------------------------------------------ */

const isStreamed = (m) => m?.source === "streamed";
const startMs = (m) => toMs(m?.startTime);
function isExpired(m, now = Date.now()) {
  if (!m || String(m.status || "").toLowerCase() === "live") return false;
  const end = toMs(m.expiresAt);
  return end !== null && end <= now;
}
function isLiveNow(m, now = Date.now()) {
  const status = String(m?.status || "").toLowerCase();
  if (status === "live") return true;
  if (status && status !== "auto") return false;
  const start = startMs(m);
  if (start === null || now < start) return false;
  const end = toMs(m.expiresAt);
  return end === null || now < end;
}
const isActive = (m) => m?.active !== false && !isExpired(m);
const manualStreams = (m) => (Array.isArray(m?.streams) ? m.streams : []);
const resolvedStreams = (m) => Number(m?.streamedSummary?.streamCount) || 0;
const streamTotal = (m) => manualStreams(m).length + resolvedStreams(m);
const teamName = (v) => (typeof v === "string" ? v : (v && typeof v === "object" ? String(v.name || "") : ""));

function sportKey(category) {
  const value = String(category || "").trim().toUpperCase().replace(/_/g, " ");
  const aliases = { "AMERICAN-FOOTBALL": "AMERICAN FOOTBALL", "MOTORSPORTS": "MOTOR-SPORTS", "MOTORSPORT": "MOTOR-SPORTS", "MOTOR SPORTS": "MOTOR-SPORTS", "UFC": "FIGHT", "MMA": "FIGHT", "BOXING": "FIGHT" };
  return aliases[value] || value || "OTHER";
}
function sportLabel(category) {
  const key = sportKey(category);
  const known = (state.settings?.sportCategories || []).find(c => c.key === key);
  if (known) return known.label;
  return key.toLowerCase().replace(/(^|[\s-])\w/g, s => s.toUpperCase());
}
function keywordHit(text, keyword) {
  const word = String(keyword || "").trim().toLowerCase();
  if (!word) return false;
  return new RegExp("(^|[^a-z0-9])" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z0-9])").test(text);
}
function liveWindowFor(m) {
  const rules = state.settings?.settings?.liveWindows || { defaultHours: 3, categories: {}, types: [] };
  const override = Number(m?.liveWindowOverride);
  if (m?.liveWindowOverride !== null && m?.liveWindowOverride !== undefined && m?.liveWindowOverride !== "" && Number.isFinite(override) && override > 0) {
    return { minutes: Math.round(override), source: "match override" };
  }
  const text = (String(m?.title || "") + " " + String(m?.competition || "")).toLowerCase();
  for (const type of rules.types || []) {
    if ((type.keywords || []).some(k => keywordHit(text, k))) return { minutes: Math.round(type.hours * 60), source: type.name };
  }
  const hours = rules.categories?.[sportKey(m?.category)];
  if (Number.isFinite(hours)) return { minutes: Math.round(hours * 60), source: "sport default" };
  return { minutes: Math.round((rules.defaultHours || 3) * 60), source: "site default" };
}
const publicMatchUrl = (id) => SITE + "/#match=" + encodeURIComponent(id);

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function loadMatches(force = false) {
  if (!state.matches || force) {
    const data = await api("/api/admin/matches");
    state.matches = Array.isArray(data) ? data : [];
  }
  return state.matches;
}
async function loadChannels(force = false) {
  if (!state.tv || force) state.tv = await api("/api/admin/tv/channels");
  return state.tv;
}
async function loadSettings(force = false) {
  if (!state.settings || force) {
    state.settings = await api("/api/admin/settings");
    applyIdentity();
  }
  return state.settings;
}
async function loadSyncLog(force = false) {
  if (!state.syncLog || force) state.syncLog = await api("/api/admin/sync-log");
  return state.syncLog;
}
const siteName = () => state.settings?.settings?.identity?.siteName || "Sportzfy Play";

function applyIdentity() {
  const name = siteName();
  $("#brandName").textContent = name;
  $("#footer").textContent = name + " · Admin v2.1";
  document.title = name + " Admin";
}

function replaceMatch(updated) {
  if (!state.matches) return;
  const index = state.matches.findIndex(m => String(m.id) === String(updated.id));
  if (index >= 0) state.matches[index] = updated;
  else state.matches.push(updated);
}

/* ------------------------------------------------------------------ */
/* Shell: navigation, routing, login                                   */
/* ------------------------------------------------------------------ */

const NAV = [
  { label: "Management" },
  { route: "", page: "dashboard", text: "Dashboard", icon: "home" },
  { route: "matches", page: "matches", text: "Matches", icon: "calendar" },
  { route: "tv", page: "tv", text: "Live TV", icon: "tv" },
  { route: "app", page: "app", text: "Android app", icon: "signal" },
  { route: "logs", page: "logs", text: "Fetch Logs", icon: "logs" },
  { route: "settings", page: "settings", text: "Settings", icon: "settings" },
  { label: "Public site" },
  { href: SITE + "/", text: "View site", icon: "external" },
  { href: SITE + "/live-tv", text: "Live TV page", icon: "signal" },
  { label: "Account" },
  { action: "logout", text: "Logout", icon: "logout" }
];

function renderNav(activePage) {
  $("#nav").innerHTML = NAV.map(item => {
    if (item.label) return '<div class="nav-label">' + esc(item.label) + "</div>";
    if (item.href) return '<a class="nav-item" href="' + esc(item.href) + '" target="_blank" rel="noopener">' + icon(item.icon) + esc(item.text) + "</a>";
    if (item.action) return '<button class="nav-item" type="button" data-action="' + item.action + '">' + icon(item.icon) + esc(item.text) + "</button>";
    return '<a class="nav-item' + (item.page === activePage ? " active" : "") + '" href="#/' + item.route + '"' +
      (item.page === activePage ? ' aria-current="page"' : "") + ">" + icon(item.icon) + esc(item.text) + "</a>";
  }).join("");
}

const ROUTES = [
  { re: /^$/, page: "dashboard", title: "Dashboard", render: () => renderDashboard() },
  { re: /^matches$/, page: "matches", title: "Matches", render: () => renderMatches() },
  { re: /^matches\/new$/, page: "matches", title: "Create Match", render: () => renderMatchForm(null) },
  { re: /^matches\/([^/]+)\/edit$/, page: "matches", title: "Edit Match", render: (id) => renderMatchForm(id) },
  { re: /^matches\/([^/]+)$/, page: "matches", title: "Edit Match", render: (id) => renderMatchDetail(id) },
  { re: /^tv$/, page: "tv", title: "Live TV", render: () => renderChannels() },
  { re: /^tv\/new$/, page: "tv", title: "Add TV Channel", render: () => renderChannelForm(null) },
  { re: /^tv\/([^/]+)$/, page: "tv", title: "Edit TV Channel", render: (id) => renderChannelForm(id) },
  { re: /^app$/, page: "app", title: "Android app", render: () => renderApp() },
  { re: /^logs$/, page: "logs", title: "Fetch Logs", render: () => renderLogs() },
  { re: /^settings(?:\/([A-Za-z]+))?$/, page: "settings", title: "Settings", render: (section) => renderSettings(section) }
];

async function route() {
  if (!state.session) return;
  closeModal();
  document.body.classList.remove("nav-open");
  $("#avatarMenu").classList.add("hidden");
  const path = location.hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  const found = ROUTES.find(r => r.re.test(path)) || ROUTES[0];
  const params = (path.match(found.re) || []).slice(1).map(p => (p === undefined ? undefined : decodeURIComponent(p)));
  const renderId = ++state.renderId;
  renderNav(found.page);
  $("#pageTitle").textContent = found.title;
  const view = $("#view");
  view.innerHTML = '<div class="skeleton" style="height:90px;margin-bottom:22px"></div><div class="skeleton"></div>';
  window.scrollTo(0, 0);
  try {
    if (!state.settings) await loadSettings();
    await found.render(...params);
  } catch (error) {
    if (renderId !== state.renderId) return;
    view.innerHTML = '<div class="error-box">' + esc(error.message || "Something went wrong.") +
      ' <button class="text-btn green" type="button" data-action="reload-route">Try again</button></div>';
  }
}
// Renders bail out when the admin navigated elsewhere while data loaded.
const stale = (renderId) => renderId !== state.renderId;

function setView(html) {
  $("#view").innerHTML = html;
}

function showLogin() {
  localStorage.removeItem(SESSION_KEY);
  state.session = "";
  state.matches = state.tv = state.settings = state.syncLog = null;
  closeModal();
  $("#login").classList.remove("hidden");
  $("#adminToken").value = "";
  setTimeout(() => $("#adminToken").focus(), 50);
}

async function login(form) {
  const secret = form.elements.adminToken.value.trim();
  if (!secret) return;
  $("#loginError").textContent = "";
  const button = form.querySelector("button[type=submit]");
  await busy(button, "Signing in…", async () => {
    try {
      const response = await fetch(API + "/api/admin/login", {
        method: "POST",
        headers: { "Accept": "application/json", "X-Admin-Token": secret }
      });
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok || !data?.session) {
        throw new Error(data?.error || (response.status === 401 ? "Invalid admin password" : "Sign-in failed (HTTP " + response.status + ")"));
      }
      state.session = data.session;
      localStorage.setItem(SESSION_KEY, state.session);
      $("#login").classList.add("hidden");
      route();
    } catch (error) {
      $("#loginError").textContent = error.message || "Sign-in failed.";
    }
  });
}

async function logout() {
  const session = state.session;
  try {
    if (session) await fetch(API + "/api/admin/logout", { method: "POST", headers: { "X-Admin-Session": session } });
  } catch (_) {}
  showLogin();
}

/* ------------------------------------------------------------------ */
/* Shared page parts                                                   */
/* ------------------------------------------------------------------ */

function pageHead(title, text, actions = "") {
  return '<div class="head"><h1>' + esc(title) + "</h1>" + (text ? "<p>" + text + "</p>" : "") +
    (actions ? '<div class="head-actions">' + actions + "</div>" : "") + "</div>";
}
function panel(title, text, body, extraHead = "") {
  return '<section class="panel"><div class="panel-head"><h2>' + title + "</h2>" + (text ? "<p>" + text + "</p>" : "") + extraHead + "</div>" + body + "</section>";
}
function emptyState(title, text) {
  return '<div class="empty"><div class="empty-icon">' + icon("inbox", 28) + "</div><h3>" + esc(title) + "</h3><p>" + esc(text) + "</p></div>";
}
const kv = (label, value) => '<div class="kv"><span class="kv-label">' + label + '</span><span class="kv-value">' + value + "</span></div>";

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

async function renderDashboard() {
  const renderId = state.renderId;
  const [matches, tv, log] = await Promise.all([loadMatches(true), loadChannels(), loadSyncLog(true)]);
  if (stale(renderId)) return;

  const now = Date.now();
  const total = matches.length;
  const active = matches.filter(isActive).length;
  const live = matches.filter(m => isLiveNow(m, now) && m.active !== false).length;
  const streams = matches.reduce((n, m) => n + streamTotal(m), 0);
  const channels = tv.channels || [];
  const activeChannels = channels.filter(c => c.active !== false).length;
  const runs = log.runs || [];
  const lastRun = runs[0] || null;
  const healthy = lastRun ? lastRun.ok : null;
  const recentErrors = runs.filter(r => !r.ok && now - (toMs(r.at) || 0) < 24 * 3600 * 1000).length;
  const healthText = healthy === null ? "Never run" : healthy ? "Healthy" : "Failing";
  const healthPill = '<span class="pill ' + (healthy === null ? "grey" : healthy ? "" : "red") + '">' + healthText + "</span>";
  const percent = total ? Math.round((active / total) * 100) : 0;

  const stat = (label, value, ico, sub = "") =>
    '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + "</div>" +
    (sub ? '<div class="stat-sub">' + sub + "</div>" : "") + '<div class="stat-icon">' + icon(ico, 26) + "</div></div>";
  const qa = (href, ico, title, text, external = false) =>
    '<a class="qa" href="' + esc(href) + '"' + (external ? ' target="_blank" rel="noopener"' : "") + '><span class="qa-icon">' + icon(ico, 26) +
    "</span><span><h3>" + esc(title) + "</h3><p>" + esc(text) + "</p></span></a>";
  const checkItem = (done, text) =>
    '<li><span class="check-dot' + (done ? "" : " off") + '">' + icon(done ? "tick" : "x", 18) + "</span>" + esc(text) + "</li>";

  setView(
    pageHead("Dashboard", "At a glance — content, streams, and system health for " + esc(siteName()) + ".",
      '<button class="btn" type="button" data-action="refresh-dashboard">' + icon("refresh") + "Refresh</button>" +
      '<button class="btn primary" type="button" data-action="run-maintenance">Fetch &amp; Maintenance</button>') +
    '<div class="stats">' +
      stat("Total Matches", total, "calendar") +
      stat("Active Matches", active, "check") +
      stat("Live Now", live, "dot", live ? "On air right now" : "No live events") +
      stat("Total Streams", streams, "video") +
      '<div class="stat wide"><div class="stat-label">Last Fetch</div><div class="stat-value num">' +
        (lastRun ? esc(stamp(lastRun.at)) : "No fetch recorded yet") + '</div><div class="stat-sub"><b class="' +
        (healthy === false ? "red" : "green") + '">' + healthText + "</b>" +
        (lastRun && !lastRun.ok ? " · " + esc(lastRun.error || "") : "") + "</div></div>" +
    "</div>" +
    '<div class="stack">' +
      panel("System health", "Schedule source and background jobs.",
        '<div>' + kv("Fetch source", healthPill) + kv("Recent errors", '<span class="num">' + recentErrors + "</span>") +
        kv("Last run", '<span class="muted num">' + (lastRun ? esc(stamp(lastRun.at)) : "—") + "</span>") +
        kv("Live TV playlist", log.tv?.lastSync ? (log.tv.lastSync.ok ? '<span class="pill">Synced ' + esc(ago(log.tv.lastSync.at)) + "</span>" : '<span class="pill red">Sync failed</span>') : '<span class="pill grey">Not synced</span>') +
        '</div><div class="kv-actions"><a class="btn sm" href="#/logs">View fetch logs</a><a class="btn sm" href="#/settings">Open settings</a></div>') +
      panel("Quick actions", "The tasks you reach for most.",
        '<div class="qa-list">' +
          qa("#/matches", "edit", "Manage Matches", "View, edit, and delete matches and their streams") +
          qa("#/matches/new", "plus", "Add a Match", "Create a manual match and attach Live TV streams") +
          qa("#/tv", "tv", "Manage Live TV", "Add, edit, import and sync Live TV channels") +
          qa("#/app", "signal", "Control the app", "Maintenance mode, forced updates, announcements and what the Android app shows") +
          qa("#/logs", "logs", "Fetch Logs", "View schedule fetch history and errors") +
          qa("#/settings", "settings", "Settings", "Stream delivery, live windows, site notice, and maintenance") +
        "</div>") +
      panel("Content overview", "Where your library stands today.",
        "<div>" + kv("Published matches", '<span class="num">' + total + "</span>") +
        kv("Active", '<span class="num green">' + active + "</span>") +
        kv("Streams attached", '<span class="num">' + streams + "</span>") +
        kv("Live TV channels", '<span class="num">' + activeChannels + " / " + channels.length + "</span>") +
        '</div><div class="pad" style="padding-top:4px"><div class="progress" role="progressbar" aria-valuenow="' + percent + '" aria-valuemin="0" aria-valuemax="100"><span style="width:' + percent + '%"></span></div><div class="faint">' +
        active + " of " + plural(total, "match", "matches") + " active</div></div>") +
      panel("Publishing checklist", "Keep the front page healthy.",
        '<ul class="checklist">' +
          checkItem(total > 0, "Matches imported") +
          checkItem(streams > 0, "Streams attached") +
          checkItem(healthy === true, "Source healthy") +
          checkItem(activeChannels > 0, "Live TV channels on air") +
        "</ul>") +
      panel("At a glance", "Activity summary.",
        '<div class="glance">' +
          kv('<span class="num">' + live + "</span> live now", '<a href="' + esc(SITE + "/") + '" target="_blank" rel="noopener">View</a>') +
          kv('<span class="num">' + total + "</span> matches", '<a href="#/matches">Manage</a>') +
          kv('<span class="num">' + streams + "</span> match streams", '<a href="#/matches">Streams</a>') +
          kv('<span class="num">' + channels.length + "</span> TV channels", '<a href="#/tv">Channels</a>') +
          kv("Fetch: " + healthText, '<a href="#/logs">Logs</a>') +
        "</div>") +
    "</div>"
  );
}

async function runMaintenance(button) {
  await busy(button, "Running…", async () => {
    try {
      const sync = await send("/api/admin/sync-streamed", "POST");
      const cleanup = await send("/api/admin/cleanup", "POST");
      toast("Fetched " + plural(sync.streamedCount || 0, "match", "matches") + " · cleaned up " + ((sync.expired || 0) + (cleanup.removed || 0)) + " expired");
    } catch (error) {
      toast(error.message, "error");
    }
  });
  state.matches = null;
  if (location.hash.replace(/^#\/?/, "") === "") route();
}

/* ------------------------------------------------------------------ */
/* Matches list                                                        */
/* ------------------------------------------------------------------ */

const MATCH_CHIPS = [
  ["all", "All"], ["live", "Live"], ["today", "Today"], ["upcoming", "Upcoming"], ["past", "Past"],
  ["active", "Active"], ["inactive", "Inactive"], ["featured", "Featured"], ["manual", "Manual"]
];

function filteredMatches() {
  const { q, date, chip } = state.matchFilter;
  const now = Date.now();
  const today = localDate(new Date().toISOString());
  const query = q.trim().toLowerCase();
  return (state.matches || []).filter(m => {
    if (query) {
      const haystack = [m.title, m.competition, m.category, teamName(m.teams?.home), teamName(m.teams?.away)].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (date && localDate(m.startTime) !== date) return false;
    const start = startMs(m);
    switch (chip) {
      case "live": return isLiveNow(m, now);
      case "today": return localDate(m.startTime) === today;
      case "upcoming": return start !== null && start > now;
      case "past": return start !== null && start <= now && !isLiveNow(m, now);
      case "active": return isActive(m);
      case "inactive": return !isActive(m);
      case "featured": return Boolean(m.featured);
      case "manual": return !isStreamed(m);
      default: return true;
    }
  }).sort((a, b) => (startMs(b) ?? -Infinity) - (startMs(a) ?? -Infinity));
}

async function renderMatches() {
  const renderId = state.renderId;
  await loadMatches(true);
  if (stale(renderId)) return;
  state.matchSelection.clear();
  const f = state.matchFilter;
  setView(
    '<div class="head"><h1>Matches</h1><p id="matchCount"></p><div class="head-actions">' +
      '<button class="btn danger" type="button" data-action="matches-delete-all">Delete all</button>' +
      '<a class="btn primary" href="#/matches/new">+ Add Match</a></div></div>' +
    '<div class="filters">' +
      '<div class="search-wrap">' + icon("search") + '<input class="input" type="search" placeholder="Search event or competition…" aria-label="Search matches" data-filter="match-q" value="' + esc(f.q) + '"></div>' +
      '<div class="filter-row"><input class="input" type="date" aria-label="Filter by date" data-filter="match-date" value="' + esc(f.date) + '"></div>' +
      '<div class="chips" role="group" aria-label="Match filters">' +
        MATCH_CHIPS.map(([key, label]) => '<button type="button" class="chip' + (f.chip === key ? " active" : "") + '" data-action="match-chip" data-chip="' + key + '" aria-pressed="' + (f.chip === key) + '">' + label + "</button>").join("") +
      "</div></div>" +
    '<div id="matchBulk"></div><div id="matchTable"></div>'
  );
  renderMatchTable();
}

function renderMatchTable() {
  const list = filteredMatches();
  const total = (state.matches || []).length;
  const pages = Math.max(1, Math.ceil(list.length / MATCH_PAGE_SIZE));
  state.matchFilter.page = Math.min(state.matchFilter.page, pages);
  const page = state.matchFilter.page;
  const items = list.slice((page - 1) * MATCH_PAGE_SIZE, page * MATCH_PAGE_SIZE);
  $("#matchCount").textContent = plural(total, "match", "matches") + " · " + list.length + " shown";
  renderMatchBulk();

  if (!items.length) {
    $("#matchTable").innerHTML = emptyState(total ? "No matches found" : "No matches yet", total ? "Try a different search or filter." : "Run a fetch or add a match by hand.");
    return;
  }
  const now = Date.now();
  const allSelected = items.every(m => state.matchSelection.has(String(m.id)));
  const rows = items.map(m => {
    const id = String(m.id);
    const tags = [
      isLiveNow(m, now) ? '<span class="tag live">LIVE</span>' : "",
      m.active === false ? '<span class="tag">INACTIVE</span>' : isExpired(m, now) ? '<span class="tag">ENDED</span>' : "",
      !isStreamed(m) ? '<span class="tag green">MANUAL</span>' : ""
    ].join("");
    const when = m.startTime ? localDate(m.startTime) + " · " + clock(m.startTime) : "No kickoff time";
    return "<tr>" +
      '<td class="cb"><input type="checkbox" aria-label="Select ' + esc(m.title) + '" data-action="match-select" data-id="' + esc(id) + '"' + (state.matchSelection.has(id) ? " checked" : "") + "></td>" +
      '<td><a class="row-title" href="#/matches/' + encodeURIComponent(id) + '">' + esc(m.title || "Untitled") + "</a>" + tags +
        '<div class="row-meta">' + esc(when) + " · " + esc(sportLabel(m.category)) + (m.competition ? " · " + esc(m.competition) : "") + "</div></td>" +
      '<td class="num" style="font-weight:800;font-size:18px">' + streamTotal(m) + "</td>" +
      '<td><div class="row-actions">' +
        '<button type="button" class="star' + (m.featured ? " on" : "") + '" data-action="match-feature" data-id="' + esc(id) + '" aria-pressed="' + Boolean(m.featured) + '" title="' + (m.featured ? "Unfeature" : "Feature on homepage") + '" aria-label="' + (m.featured ? "Unfeature " : "Feature ") + esc(m.title) + '">' + icon("star", 26) + "</button>" +
        '<a class="text-btn" href="' + esc(publicMatchUrl(id)) + '" target="_blank" rel="noopener">View</a>' +
        '<a class="text-btn green" href="#/matches/' + encodeURIComponent(id) + '/edit">Edit</a>' +
        '<button type="button" class="text-btn red" data-action="match-delete" data-id="' + esc(id) + '">Delete</button>' +
      "</div></td></tr>";
  }).join("");

  $("#matchTable").innerHTML = '<section class="panel"><div class="table-wrap"><table><thead><tr>' +
    '<th class="cb"><input type="checkbox" aria-label="Select all on this page" data-action="match-select-all"' + (allSelected ? " checked" : "") + "></th>" +
    '<th>Event</th><th>Streams</th><th style="text-align:right">Actions</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    (pages > 1
      ? '<div class="pager"><button class="btn sm" type="button" data-action="match-page" data-page="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + '>Previous</button><span>Page ' + page + " of " + pages +
        '</span><button class="btn sm" type="button" data-action="match-page" data-page="' + (page + 1) + '"' + (page >= pages ? " disabled" : "") + ">Next</button></div>"
      : "") +
    "</section>";
}

function renderMatchBulk() {
  const count = state.matchSelection.size;
  $("#matchBulk").innerHTML = count
    ? '<div class="bulk-bar"><strong>' + plural(count, "match", "matches") + " selected</strong>" +
      [["activate", "Activate"], ["deactivate", "Deactivate"], ["feature", "Feature"], ["unfeature", "Unfeature"]]
        .map(([action, label]) => '<button class="btn sm" type="button" data-action="match-bulk" data-bulk="' + action + '">' + label + "</button>").join("") +
      '<button class="btn sm danger" type="button" data-action="match-bulk" data-bulk="delete">Delete</button>' +
      '<button class="text-btn" type="button" data-action="match-clear-selection">Clear</button></div>'
    : "";
}

async function matchBulk(action, button) {
  const ids = [...state.matchSelection];
  if (!ids.length) return;
  if (action === "delete" && !confirm("Delete " + plural(ids.length, "match", "matches") + "? Streamed matches return on the next fetch if the feed still lists them.")) return;
  await busy(button, "", async () => {
    try {
      const result = await send("/api/admin/matches/bulk", "POST", { action, ids });
      toast(plural(result.affected || 0, "match", "matches") + " updated");
      state.matchSelection.clear();
      await loadMatches(true);
      renderMatchTable();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function toggleFeatured(id, button) {
  const match = (state.matches || []).find(m => String(m.id) === String(id));
  if (!match) return;
  await busy(button, "", async () => {
    try {
      const result = await send("/api/admin/matches/" + encodeURIComponent(id), "PUT", { featured: !match.featured });
      replaceMatch(result.match);
      toast(result.match.featured ? "Pinned to the homepage Featured section" : "Removed from Featured");
      if ($("#matchTable")) renderMatchTable();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function deleteMatch(id, after) {
  const match = (state.matches || []).find(m => String(m.id) === String(id)) || state.currentMatch;
  if (!confirm("Delete \"" + (match?.title || "this match") + "\"?" + (isStreamed(match) ? " It returns on the next fetch if the feed still lists it — deactivate it instead to keep it hidden." : ""))) return;
  try {
    await send("/api/admin/matches/" + encodeURIComponent(id), "DELETE");
    state.matches = (state.matches || []).filter(m => String(m.id) !== String(id));
    state.matchSelection.delete(String(id));
    toast("Match deleted");
    if (after) after();
    else if ($("#matchTable")) renderMatchTable();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteAllMatches(button) {
  const count = (state.matches || []).length;
  if (!count) return toast("There are no matches to delete");
  if (!confirm("Delete all " + count + " matches? Manual matches are gone for good; streamed matches return on the next fetch.")) return;
  await busy(button, "Deleting…", async () => {
    try {
      const result = await send("/api/admin/matches?confirm=all", "DELETE");
      toast(plural(result.removed || 0, "match", "matches") + " deleted");
      state.matchSelection.clear();
      await loadMatches(true);
      renderMatchTable();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

/* ------------------------------------------------------------------ */
/* Match form (create / edit)                                          */
/* ------------------------------------------------------------------ */

function sportOptions(selected, includeAuto) {
  const categories = state.settings?.sportCategories || [];
  const key = selected ? sportKey(selected) : "";
  const known = categories.some(c => c.key === key);
  return (includeAuto ? '<option value="AUTO"' + (!selected ? " selected" : "") + ">Auto (from event text)</option>" : "") +
    categories.map(c => '<option value="' + esc(c.key) + '"' + (c.key === key ? " selected" : "") + ">" + esc(c.label) + "</option>").join("") +
    (key && !known ? '<option value="' + esc(selected) + '" selected>' + esc(sportLabel(selected)) + "</option>" : "");
}

async function renderMatchForm(id) {
  const renderId = state.renderId;
  const matches = await loadMatches();
  if (stale(renderId)) return;
  const match = id ? matches.find(m => String(m.id) === String(id)) : null;
  if (id && !match) {
    setView(emptyState("Match not found", "It may have been deleted or removed by a fetch.") + '<p style="text-align:center"><a class="text-btn green" href="#/matches">← All matches</a></p>');
    return;
  }
  const m = match || { status: "auto", active: true };
  const feed = isStreamed(m);
  const lock = feed ? " disabled" : "";
  const defaultDate = match ? localDate(m.startTime) : localDate(new Date().toISOString());
  const defaultTime = match ? localTime(m.startTime) : "20:00";
  const rule = liveWindowFor({ ...m, liveWindowOverride: null });

  setView(
    '<a class="back-link" href="' + (match ? "#/matches/" + encodeURIComponent(m.id) : "#/matches") + '">' + icon("left", 18) + (match ? "Back to match" : "All matches") + "</a>" +
    pageHead(match ? "Edit Match" : "Create Match",
      match ? esc(m.title) : "Add a match by hand. Attach streams from the Live TV catalog after creating it.") +
    '<form class="card" data-submit="match-save" data-id="' + esc(match ? m.id : "") + '" novalidate>' +
      (feed ? '<p class="warn">This match comes from the Streamed feed: its name, sport, kickoff and status refresh on every fetch. Everything else here is yours to edit and survives fetches.</p>' : "") +
      '<div class="field"><label for="f-title">Event Name <span class="req">*</span></label><input id="f-title" name="title" class="input" required maxlength="200" value="' + esc(m.title || "") + '"' + lock + "></div>" +
      '<div class="grid-2">' +
        '<div class="field"><label for="f-date">Date <span class="req">*</span></label><input id="f-date" name="date" type="date" class="input" required value="' + esc(defaultDate) + '"' + lock + "></div>" +
        '<div class="field"><label for="f-time">Time (' + esc(TZ_LABEL) + ') <span class="req">*</span></label><input id="f-time" name="time" type="time" class="input" required value="' + esc(defaultTime) + '"' + lock + ' data-input="uk-hint"><div class="hint" id="ukHint"></div></div>' +
      "</div>" +
      '<div class="field"><label for="f-competition">Competition</label><input id="f-competition" name="competition" class="input" maxlength="120" value="' + esc(m.competition || "") + '"></div>' +
      '<div class="field"><label for="f-sport">Sport</label><select id="f-sport" name="category" class="select"' + lock + ">" + sportOptions(match ? m.category : "", !feed) + "</select></div>" +
      '<div class="grid-2">' +
        '<div class="field"><label for="f-home">Home Team</label><input id="f-home" name="home" class="input" maxlength="120" value="' + esc(m.home || teamName(m.teams?.home)) + '"></div>' +
        '<div class="field"><label for="f-away">Away Team</label><input id="f-away" name="away" class="input" maxlength="120" value="' + esc(m.away || teamName(m.teams?.away)) + '"></div>' +
      "</div>" +
      '<div class="field"><label for="f-image">Featured Image</label><div class="with-thumb">' +
        '<input id="f-image" name="image" class="input" placeholder="https://example.com/image.jpg" value="' + esc(m.image || "") + '" data-input="thumb" data-thumb="imgThumb">' +
        '<img id="imgThumb" class="thumb' + (m.image ? "" : " hidden") + '" alt="" src="' + esc(m.image || "") + '" onerror="this.classList.add(\'hidden\')"></div>' +
        '<div class="hint">Paste an image URL (https, or a same-origin path like /images/banner.jpg). Shown in the homepage Featured section and on match cards.</div></div>' +
      '<label class="check"><input type="checkbox" name="featured"' + (m.featured ? " checked" : "") + '><span><b>Feature on homepage</b> <small>— pins this match to the top of the Featured Matches section</small></span></label>' +
      '<label class="check"><input type="checkbox" name="active"' + (m.active !== false ? " checked" : "") + '><span><b>Active</b> <small>— show this match on the public site</small></span></label>' +
      '<div class="grid-2">' +
        '<div class="field"><label for="f-status">Status</label><select id="f-status" name="status" class="select"' + lock + ">" +
          [["auto", "Auto (from kickoff & live window)"], ["scheduled", "Scheduled"], ["live", "Live"], ["finished", "Finished"]]
            .map(([v, l]) => '<option value="' + v + '"' + ((m.status || "auto") === v ? " selected" : "") + ">" + l + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="f-window">Live window override</label><div class="suffix-wrap"><input id="f-window" name="liveWindowOverride" type="number" min="1" max="10080" class="input" placeholder="' + esc(rule.minutes + " (" + rule.source + ")") + '" value="' + esc(m.liveWindowOverride ?? "") + '"><span class="suffix">min</span></div><div class="hint">Leave empty to follow the live-window rules in Settings.</div></div>' +
      "</div>" +
      '<div class="field"><label for="f-description">Description</label><textarea id="f-description" name="description" class="textarea" maxlength="2000">' + esc(m.description || "") + "</textarea></div>" +
      '<div class="form-actions"><button class="btn primary block" type="submit">' + (match ? "Save changes" : "Create Match") + '</button></div><p class="hint" id="formStatus" role="status"></p>' +
    "</form>"
  );
  updateUkHint();
}

function updateUkHint() {
  const hint = $("#ukHint");
  if (!hint) return;
  const iso = composeIso($("#f-date")?.value, $("#f-time")?.value);
  hint.textContent = iso ? "Stored as " + clock(iso, "Europe/London") + " UK" : "";
}

async function saveMatch(form) {
  const id = form.dataset.id;
  const match = id ? (state.matches || []).find(m => String(m.id) === id) : null;
  const feed = isStreamed(match);
  const v = (name) => form.elements[name]?.value.trim() ?? "";
  const body = {
    competition: v("competition"),
    home: v("home"),
    away: v("away"),
    image: v("image"),
    featured: form.elements.featured.checked,
    active: form.elements.active.checked,
    liveWindowOverride: v("liveWindowOverride"),
    description: form.elements.description.value
  };
  if (!feed) {
    if (!v("title")) return void ($("#formStatus").textContent = "Event name is required.");
    if (!v("date") || !v("time")) return void ($("#formStatus").textContent = "Date and time are required.");
    Object.assign(body, { title: v("title"), startTime: composeIso(v("date"), v("time")), category: v("category"), status: v("status") });
  }
  const button = form.querySelector("button[type=submit]");
  await busy(button, "Saving…", async () => {
    try {
      const result = id
        ? await send("/api/admin/matches/" + encodeURIComponent(id), "PUT", body)
        : await send("/api/admin/matches", "POST", body);
      replaceMatch(result.match);
      toast(id ? "Match saved" : "Match created — now attach streams");
      location.hash = "#/matches/" + encodeURIComponent(result.match.id);
    } catch (error) {
      $("#formStatus").textContent = error.message;
      toast(error.message, "error");
    }
  });
}

/* ------------------------------------------------------------------ */
/* Match detail + streams                                              */
/* ------------------------------------------------------------------ */

async function renderMatchDetail(id) {
  const renderId = state.renderId;
  const matches = await loadMatches();
  if (stale(renderId)) return;
  const match = matches.find(m => String(m.id) === String(id));
  if (!match) {
    setView(emptyState("Match not found", "It may have been deleted or removed by a fetch.") + '<p style="text-align:center"><a class="text-btn green" href="#/matches">← All matches</a></p>');
    return;
  }
  state.currentMatch = JSON.parse(JSON.stringify(match));
  const m = state.currentMatch;
  const rule = liveWindowFor(m);
  const summary = m.streamedSummary;
  const home = teamName(m.teams?.home) || m.home;
  const away = teamName(m.teams?.away) || m.away;
  const statusText = m.active === false ? "Inactive" : isExpired(m) ? "Ended (past live window)" : isLiveNow(m) ? "Active · live now" : "Active";

  setView(
    '<div class="title-row"><a class="icon-btn" href="#/matches" aria-label="All matches">' + icon("left", 26) + '</a><h1 title="' + esc(m.title) + '">' + esc(m.title || "Untitled") + "</h1></div>" +
    '<div class="link-actions">' +
      '<button class="text-btn" type="button" data-action="match-share">' + icon("copy", 20) + "Share</button>" +
      '<a class="text-btn green" href="#/matches/' + encodeURIComponent(m.id) + '/edit">Edit</a>' +
      '<button class="text-btn red" type="button" data-action="match-delete-current">Delete</button>' +
      '<a class="text-btn" href="' + esc(publicMatchUrl(m.id)) + '" target="_blank" rel="noopener">View on site ' + icon("external", 16) + "</a>" +
    "</div>" +
    '<section class="panel"><div class="info-grid">' +
      "<div>Date: <b>" + esc(localDate(m.startTime) || "—") + "</b></div>" +
      "<div>Time: <b>" + (m.startTime ? esc(clock(m.startTime) + " " + TZ_LABEL) + "</b> · " + esc(clock(m.startTime, "Europe/London")) + " UK" : "<b>—</b>") + "</div>" +
      "<div>Competition: <b>" + esc(m.competition || "—") + "</b></div>" +
      "<div>Sport: <b>" + esc(sportLabel(m.category)) + "</b></div>" +
      "<div>Home: <b>" + esc(home || "—") + "</b></div>" +
      "<div>Away: <b>" + esc(away || "—") + "</b></div>" +
      "<div>Status: <b>" + esc(statusText) + "</b></div>" +
      "<div>Featured: <b>" + (m.featured ? "Yes" : "No") + "</b></div>" +
      "<div>Featured image: " + (m.image ? '<a href="' + esc(m.image) + '" target="_blank" rel="noopener">' + esc(m.image) + "</a>" : "— (falls back to the feed poster)") + "</div>" +
      "<div>Live window: <b>" + rule.minutes + " min</b> (" + esc(rule.source) + ")</div>" +
      "<div>Updated: <b>" + esc(ago(m.updatedAt)) + "</b></div>" +
      '<div>URL: <a class="mono" href="' + esc(publicMatchUrl(m.id)) + '" target="_blank" rel="noopener">/#match=' + esc(m.id) + "</a></div>" +
      "<div>Source: <b>" + (isStreamed(m) ? "Streamed feed" : "Manual") + "</b></div>" +
      (m.expiresAt ? "<div>Removed after: <b>" + esc(stamp(m.expiresAt)) + "</b></div>" : "") +
    "</div></section>" +
    (isStreamed(m)
      ? panel("Streamed sources", "Read-only. Resolved from the Streamed feed on every fetch — these play on the match page alongside your streams.",
          (summary && summary.sources?.length
            ? '<div class="pad" style="padding-bottom:12px">' + plural(Number(summary.sourceCount) || 0, "source group") + " · " + plural(Number(summary.streamCount) || 0, "resolved stream") + '</div><ul class="streamed-list">' +
              summary.sources.map(g => "<li><span><b>" + esc(g.source) + '</b> <span class="faint">(' + esc(g.id) + ")</span></span><span class=\"muted\">" +
                esc(plural(Number(g.streamCount) || 0, "stream") + (g.stale ? " · stale cache" : "") + (g.error ? " · " + g.error : "")) + "</span></li>").join("") + "</ul>"
            : '<div class="pad muted">No resolved Streamed streams yet. Sources resolve gradually over the next fetches.</div>'))
      : "") +
    '<section class="panel"><div class="panel-head"><h2><span>Streams (<span id="streamCount">0</span>)</span></h2><p>Drag rows to reorder. Lower numbers show first on the match page.</p>' +
      '<div style="margin-top:20px"><button class="btn primary" type="button" data-action="stream-add">+ Add Stream</button></div></div>' +
      '<div id="streamRows"></div></section>'
  );
  renderStreamRows();
}

function renderStreamRows() {
  const streams = manualStreams(state.currentMatch);
  $("#streamCount").textContent = streams.length;
  const host = $("#streamRows");
  if (!streams.length) {
    host.innerHTML = '<div class="pad muted">No streams yet. Add one from the Live TV catalog or paste a stream URL.</div>';
    return;
  }
  host.innerHTML = streams.map((s, i) => {
    let hostName = "";
    try { hostName = s.url ? new URL(s.url).host : ""; } catch (_) {}
    return '<div class="stream-row" draggable="true" data-index="' + i + '">' +
      '<span class="num">' + (i + 1) + "</span>" +
      '<span class="reorder"><button type="button" data-action="stream-move" data-index="' + i + '" data-dir="-1" aria-label="Move up"' + (i === 0 ? " disabled" : "") + ">" + icon("up", 22) +
      '</button><button type="button" data-action="stream-move" data-index="' + i + '" data-dir="1" aria-label="Move down"' + (i === streams.length - 1 ? " disabled" : "") + ">" + icon("down", 22) + "</button></span>" +
      '<div style="min-width:0"><span class="stream-name">' + esc(s.name) + '</span><span class="stream-meta">' + esc([s.language, s.quality].filter(Boolean).join(" · ")) + "</span>" +
        '<div class="stream-url">' + (s.url ? esc(hostName) + (s.channelId ? " · Live TV: " + esc(s.channelId) : "") : '<span class="amber">No URL — not playable</span>') + "</div></div>" +
      '<span class="stream-actions">' +
        '<button type="button" class="text-btn" data-action="stream-copy" data-index="' + i + '" aria-label="Copy stream URL" title="Copy stream URL">' + icon("copy", 20) + "</button>" +
        '<button type="button" class="text-btn green" data-action="stream-edit" data-index="' + i + '">Edit</button>' +
        '<button type="button" class="text-btn red" data-action="stream-delete" data-index="' + i + '">Delete</button>' +
      "</span></div>";
  }).join("");
}

async function saveStreams(message) {
  const m = state.currentMatch;
  try {
    const result = await send("/api/admin/matches/" + encodeURIComponent(m.id), "PUT", { streams: manualStreams(m) });
    state.currentMatch = JSON.parse(JSON.stringify(result.match));
    replaceMatch(result.match);
    if ($("#streamRows")) renderStreamRows();
    if (message) toast(message);
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

let reorderTimer = null;
function moveStream(from, to) {
  const streams = manualStreams(state.currentMatch).slice();
  if (to < 0 || to >= streams.length || from === to) return;
  const [item] = streams.splice(from, 1);
  streams.splice(to, 0, item);
  state.currentMatch.streams = streams;
  renderStreamRows();
  clearTimeout(reorderTimer);
  reorderTimer = setTimeout(() => saveStreams("Stream order saved"), 700);
}

/* ---------- Stream modal with the Live TV catalog picker ---------- */

async function openStreamModal(index = -1) {
  const stream = index >= 0 ? manualStreams(state.currentMatch)[index] : { name: "", language: "English", url: "", quality: "HD", channelId: "", sandbox: false };
  state.streamModal = { index, bulk: false, picked: new Set(), query: "" };
  const languages = LANGUAGES.includes(stream.language) ? LANGUAGES : [stream.language, ...LANGUAGES];
  openModal(
    '<form data-submit="stream-save" novalidate><div class="modal-head"><h3>' + (index >= 0 ? "Edit Stream" : "Add Stream") + '</h3><button class="icon-btn" type="button" data-action="modal-close" aria-label="Close">' + icon("x") + "</button></div>" +
    '<div class="modal-body">' +
      '<div class="catalog"><div class="catalog-top"><span class="label" style="margin:0">Pick from TV catalog</span><button class="text-btn green" type="button" data-action="catalog-bulk-toggle" id="bulkToggle">Bulk add</button></div>' +
        '<input class="input" type="search" placeholder="Search channels by name…" aria-label="Search channels" data-filter="catalog-q">' +
        '<div class="hint" id="catalogCount">Loading channels…</div><div class="catalog-list" id="catalogList" role="listbox" aria-label="Live TV channels"></div>' +
        '<div class="hint">Selecting a channel fills the name and URL below. You can still edit them manually.</div></div>' +
      '<div class="field"><label for="s-name">Channel</label><input id="s-name" name="name" class="input" maxlength="120" value="' + esc(stream.name) + '"></div>' +
      '<div class="grid-2"><div class="field"><label for="s-language">Language</label><select id="s-language" name="language" class="select">' +
        languages.map(l => "<option" + (l === stream.language ? " selected" : "") + ">" + esc(l) + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="s-quality">Quality</label><select id="s-quality" name="quality" class="select">' +
        QUALITIES.map(q => "<option" + (q === stream.quality ? " selected" : "") + ">" + q + "</option>").join("") + "</select></div></div>" +
      '<div class="field"><label for="s-url">URL</label><input id="s-url" name="url" class="input mono" inputmode="url" placeholder="https://… or http://…" value="' + esc(stream.url || "") + '"><div class="hint">' + esc(STREAM_URL_HINT) + "</div></div>" +
      '<label class="check"><input type="checkbox" name="sandbox"' + (stream.sandbox ? " checked" : "") + '><span>Run in a sandbox <small>— blocks pop-ups and redirects; some pages show a black frame inside one. Set from the channel when you pick one above.</small></span></label>' +
      '<input type="hidden" name="channelId" value="' + esc(stream.channelId || "") + '">' +
    "</div>" +
    '<div class="modal-foot" id="streamFoot"><button class="btn" type="button" data-action="modal-close">Cancel</button><button class="btn primary" type="submit">Save Stream</button></div></form>'
  );
  try {
    await loadChannels();
    renderCatalog();
  } catch (error) {
    $("#catalogCount").textContent = "Could not load the TV catalog: " + error.message;
  }
}

function renderCatalog() {
  const modal = state.streamModal;
  const list = $("#catalogList");
  if (!modal || !list) return;
  const query = modal.query.trim().toLowerCase();
  const channels = (state.tv?.channels || []).filter(c => !query || channelMatches(c, query));
  // Playlists run to thousands of channels: list the first few hundred and
  // let the search narrow the rest down.
  const shown = channels.slice(0, CATALOG_LIMIT);
  $("#catalogCount").textContent = plural(channels.length, "channel") + " available" +
    (channels.length > shown.length ? " · first " + shown.length + " listed, search to narrow" : "") +
    (modal.bulk ? " · " + modal.picked.size + " picked" : "");
  list.innerHTML = shown.length
    ? shown.map(c => '<button type="button" class="catalog-item' + (modal.picked.has(c.id) ? " picked" : "") + '" data-action="catalog-pick" data-id="' + esc(c.id) + '" role="option">' +
        (modal.bulk ? '<input type="checkbox" tabindex="-1" aria-hidden="true"' + (modal.picked.has(c.id) ? " checked" : "") + ">" : "") +
        "<span>" + esc(c.name) + "</span>" + (c.active === false ? '<span class="faint">inactive</span>' : '<span class="faint">' + esc([c.group, c.category].filter(Boolean).join(" · ")) + "</span>") + "</button>").join("")
    : '<div class="pad muted">No channels match.</div>';
  $("#bulkToggle").textContent = modal.bulk ? "Single pick" : "Bulk add";
  $("#streamFoot").innerHTML = modal.bulk
    ? '<button class="btn" type="button" data-action="modal-close">Cancel</button><button class="btn primary" type="button" data-action="catalog-bulk-add"' + (modal.picked.size ? "" : " disabled") + ">Add " + plural(modal.picked.size, "stream") + "</button>"
    : '<button class="btn" type="button" data-action="modal-close">Cancel</button><button class="btn primary" type="submit">Save Stream</button>';
}

function pickCatalogChannel(id) {
  const modal = state.streamModal;
  const channel = (state.tv?.channels || []).find(c => c.id === id);
  if (!modal || !channel) return;
  if (modal.bulk) {
    if (modal.picked.has(id)) modal.picked.delete(id);
    else modal.picked.add(id);
    renderCatalog();
    return;
  }
  const form = $("#modalRoot form");
  form.elements.name.value = channel.name;
  form.elements.url.value = channel.url;
  form.elements.channelId.value = channel.id;
  form.elements.sandbox.checked = Boolean(channel.sandbox);
  $$(".catalog-item.picked").forEach(el => el.classList.remove("picked"));
  $$('.catalog-item[data-id="' + CSS.escape(id) + '"]').forEach(el => el.classList.add("picked"));
}

async function saveStreamFromModal(form) {
  const modal = state.streamModal;
  const url = form.elements.url.value.trim();
  if (url && !STREAM_URL_RE.test(url)) return toast("Stream URL must start with http:// or https://", "error");
  const streams = manualStreams(state.currentMatch).slice();
  const current = modal.index >= 0 ? streams[modal.index] : null;
  const item = {
    id: current?.id || crypto.randomUUID(),
    name: form.elements.name.value.trim() || "Stream " + (modal.index >= 0 ? modal.index + 1 : streams.length + 1),
    language: form.elements.language.value,
    quality: form.elements.quality.value,
    league: current?.league || "",
    url,
    channelId: url === current?.url || form.elements.channelId.value ? form.elements.channelId.value : "",
    sandbox: form.elements.sandbox.checked
  };
  if (modal.index >= 0) streams[modal.index] = item;
  else streams.push(item);
  state.currentMatch.streams = streams;
  const button = form.querySelector("button[type=submit]");
  await busy(button, "Saving…", async () => {
    if (await saveStreams(modal.index >= 0 ? "Stream updated" : "Stream added")) closeModal();
  });
}

async function bulkAddStreams(button) {
  const modal = state.streamModal;
  const form = $("#modalRoot form");
  const channels = (state.tv?.channels || []).filter(c => modal.picked.has(c.id));
  if (!channels.length) return;
  const streams = manualStreams(state.currentMatch).slice();
  for (const c of channels) {
    streams.push({ id: crypto.randomUUID(), name: c.name, language: form.elements.language.value, quality: form.elements.quality.value, league: "", url: c.url, channelId: c.id, sandbox: Boolean(c.sandbox) });
  }
  state.currentMatch.streams = streams;
  await busy(button, "Adding…", async () => {
    if (await saveStreams(plural(channels.length, "stream") + " added")) closeModal();
  });
}

/* ------------------------------------------------------------------ */
/* Live TV channels                                                    */
/* ------------------------------------------------------------------ */

const TV_CHIPS = [["all", "all"], ["active", "active"], ["inactive", "inactive"], ["manual", "manual"], ["synced", "synced"],
  ["working", "working"], ["failed", "failed"], ["pending", "pending check"]];

// Stream check states from the Worker's probe (see channelCheck in worker.js).
const CHECK_PILLS = {
  working: ["", "Working", "Passed the stream check — advice only: checks never hide a channel"],
  verifying: ["amber", "Verifying", "One good check so far; called working after the next one passes"],
  failed: ["red", "Failed", "Failed the stream check — still listed; turn the channel off to hide it"],
  unchecked: ["grey", "Not checked", "Not checked yet on its current stream URL"]
};
const checkState = (c) => c.check?.state || "unchecked";
const KIND_LABELS = { hls: "HLS", ts: "MPEG-TS", dash: "DASH", flv: "FLV", video: "Video", audio: "Audio", embed: "Embed" };

// Mirrors the Worker's streamKind(): how a stream URL plays. Only a fallback —
// /api/admin/tv/channels sends each channel's kind.
const STREAM_EXTENSIONS = {
  m3u8: "hls", m3u: "hls", mpd: "dash", ts: "ts", mts: "ts", m2ts: "ts", flv: "flv",
  mp4: "video", m4v: "video", webm: "video", mov: "video", mkv: "video", ogv: "video",
  mp3: "audio", aac: "audio", m4a: "audio", ogg: "audio", oga: "audio", opus: "audio", flac: "audio", wav: "audio"
};
const STREAM_QUERY_KINDS = { m3u8: "hls", hls: "hls", ts: "ts", mpegts: "ts", mpd: "dash", dash: "dash", flv: "flv", mp4: "video" };
function streamKind(value) {
  let url;
  try { url = new URL(String(value ?? "").split("|")[0].trim()); } catch (_) { return "embed"; }
  const extension = ((url.pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
  if (Object.hasOwn(STREAM_EXTENSIONS, extension)) return STREAM_EXTENSIONS[extension];
  if (/\/live\/[^/]+\/[^/]+\/\d+$/.test(url.pathname)) return "ts";
  for (const key of ["type", "format", "output", "extension"]) {
    const kind = String(url.searchParams.get(key) ?? "").trim().toLowerCase();
    if (Object.hasOwn(STREAM_QUERY_KINDS, kind)) return STREAM_QUERY_KINDS[kind];
  }
  return "embed";
}
const channelKind = (c) => (Object.hasOwn(KIND_LABELS, c?.kind) ? c.kind : streamKind(c?.url));

// Request headers the Worker sends upstream (from the playlist).
const HEADER_LABELS = [["userAgent", "User-Agent"], ["referer", "Referer"], ["origin", "Origin"]];
const channelHeaders = (c) => HEADER_LABELS
  .map(([key, label]) => [label, typeof c?.headers?.[key] === "string" ? c.headers[key].trim() : ""])
  .filter(([, value]) => value);

// Same rule as the Worker's needsProxy(): plain-http streams, admin-forced
// proxying, request headers and raw MPEG-TS/FLV play through the Worker.
function channelProxied(c) {
  if (c?.proxied === true) return true;
  const kind = channelKind(c);
  return /^http:/i.test(String(c?.url || "")) || c?.proxy === true || channelHeaders(c).length > 0 || kind === "ts" || kind === "flv";
}

// The logo the admin page can show: the Worker's logoSrc (https as-is, http
// relayed through /api/tv/logo/:id), else the stored logo when it is https.
// http logos never load directly — this page is https (mixed content).
function channelLogo(c) {
  const src = String(c?.logoSrc || "");
  if (src.startsWith("/") && !src.startsWith("//")) return API + src;
  if (/^https:\/\//i.test(src)) return src;
  const logo = String(c?.logo || "");
  return /^https:\/\//i.test(logo) ? logo : "";
}

// Distinct non-empty groups (countries etc.), in catalog order.
function channelGroups(channels) {
  const seen = new Set();
  for (const c of channels || []) {
    const group = String(c.group || "").trim();
    if (group) seen.add(group);
  }
  return [...seen];
}

const channelMatches = (c, query) =>
  String(c.name || "").toLowerCase().includes(query) || String(c.group || "").toLowerCase().includes(query);

function filteredChannels() {
  const { q, chip, category, group } = state.tvFilter;
  const query = q.trim().toLowerCase();
  return (state.tv?.channels || []).filter(c => {
    if (query && !channelMatches(c, query)) return false;
    if (category && c.category !== category) return false;
    if (group && String(c.group || "").trim() !== group) return false;
    if (chip === "active") return c.active !== false;
    if (chip === "inactive") return c.active === false;
    if (chip === "manual") return c.origin !== "synced";
    if (chip === "synced") return c.origin === "synced";
    if (chip === "working") return checkState(c) === "working";
    if (chip === "failed") return checkState(c) === "failed";
    if (chip === "pending") return c.active !== false && (checkState(c) === "unchecked" || checkState(c) === "verifying");
    return true;
  });
}

function lastSyncLine(tv) {
  const s = tv.lastSync;
  if (!s) return "Playlist never synced.";
  if (!s.ok) return '<span class="red">Last playlist sync failed ' + esc(ago(s.at)) + ": " + esc(s.error || "") + "</span>";
  return "Playlist synced " + esc(ago(s.at)) + " · " + s.added + " added · " + s.updated + " updated · " + s.removed + " removed";
}

// "Stream checks: 312 working · 40 verifying · 1480 failed · 398 not checked · last run 4 min ago"
function checkLine(tv) {
  const c = tv.checks;
  if (!c) return "";
  const parts = [
    '<span class="green">' + c.working + " working</span>",
    c.verifying ? '<span class="amber">' + c.verifying + " verifying</span>" : "",
    c.failed ? '<span class="red">' + c.failed + " failed</span>" : "",
    c.unchecked ? c.unchecked + " not checked yet" : "",
    c.updatedAt ? "last run " + esc(ago(c.updatedAt)) : "no check has run yet",
  ].filter(Boolean);
  return '<p class="hint" style="font-size:15px;margin-top:4px">Stream checks: ' + parts.join(" · ") +
    " · " + c.batch + " channels every 10 minutes · <b>advice only</b>: every active channel is listed on " +
    "the site and in the app whether or not a check has passed. Turn a channel off below to hide it.</p>";
}

async function renderChannels() {
  const renderId = state.renderId;
  const tv = await loadChannels(true);
  if (stale(renderId)) return;
  state.tvSelection.clear();
  const f = state.tvFilter;
  const groups = channelGroups(tv.channels);
  // A group that a sync removed would filter everything out invisibly.
  if (f.group && !groups.includes(f.group)) f.group = "";
  f.page = 1;
  setView(
    '<div class="head"><h1>Live TV</h1><p>Manage the channels shown on the public <a class="green" href="' + esc(SITE + "/live-tv") + '" target="_blank" rel="noopener">Live TV page</a> · <span id="tvCount"></span></p>' +
    '<p class="hint" style="font-size:15px;margin-top:8px">' + lastSyncLine(tv) + "</p>" + checkLine(tv) +
    '<div class="head-actions">' +
      '<button class="btn danger" type="button" data-action="tv-delete-all">Delete All</button>' +
      '<button class="btn" type="button" data-action="tv-import-open">' + icon("download") + "Import from URL</button>" +
      '<button class="btn" type="button" data-action="tv-sync">' + icon("refresh") + "Sync Playlist</button>" +
      '<a class="btn primary" href="#/tv/new">+ Add Channel</a>' +
    "</div></div>" +
    '<div class="filters">' +
      '<div class="search-wrap">' + icon("search") + '<input class="input" type="search" placeholder="Search channels or countries…" aria-label="Search channels" data-filter="tv-q" value="' + esc(f.q) + '"></div>' +
      '<div class="filter-row"><select class="select" aria-label="Category" data-filter="tv-category"><option value="">All categories</option>' +
        (tv.categories || []).map(c => '<option value="' + esc(c) + '"' + (f.category === c ? " selected" : "") + ">" + esc(c) + "</option>").join("") + "</select>" +
        (groups.length
          ? '<select class="select" aria-label="Group" data-filter="tv-group"><option value="">All groups (' + groups.length + ")</option>" +
            groups.map(g => '<option value="' + esc(g) + '"' + (f.group === g ? " selected" : "") + ">" + esc(g) + "</option>").join("") + "</select>"
          : "") +
      "</div>" +
      '<div class="chips" role="group" aria-label="Channel filters">' +
        TV_CHIPS.map(([key, label]) => '<button type="button" class="chip' + (f.chip === key ? " active" : "") + '" data-action="tv-chip" data-chip="' + key + '" aria-pressed="' + (f.chip === key) + '">' + label + "</button>").join("") +
      "</div></div>" +
    '<div id="tvBulk"></div><div id="tvTable"></div>'
  );
  renderChannelTable();
}

function checkPill(c) {
  if (c.active === false) return "";
  const [tone, label, hint] = CHECK_PILLS[checkState(c)];
  const when = c.check?.checkedAt ? " · checked " + ago(c.check.checkedAt) : "";
  return '<span class="pill' + (tone ? " " + tone : "") + '" title="' + esc(hint + when) + '">' + label + "</span>";
}

function channelRowMeta(c) {
  const kind = channelKind(c);
  return [
    c.group ? String(c.group) : "",
    c.category || "",
    c.origin === "synced" ? "synced" : "manual",
    KIND_LABELS[kind],
    channelProxied(c) ? "via Worker" : "",
    c.sandbox ? "sandboxed" : "",
    Number.isFinite(c.sort) ? "order " + c.sort : ""
  ].filter(Boolean).map(esc).join(" · ");
}

function renderChannelTable() {
  const all = state.tv?.channels || [];
  const list = filteredChannels();
  const pages = Math.max(1, Math.ceil(list.length / TV_PAGE_SIZE));
  state.tvFilter.page = Math.min(Math.max(1, state.tvFilter.page || 1), pages);
  const page = state.tvFilter.page;
  const items = list.slice((page - 1) * TV_PAGE_SIZE, page * TV_PAGE_SIZE);
  $("#tvCount").textContent = plural(all.length, "channel") + (list.length !== all.length ? " · " + list.length + " shown" : "");
  const count = state.tvSelection.size;
  $("#tvBulk").innerHTML = count
    ? '<div class="bulk-bar"><strong>' + plural(count, "channel") + " selected</strong>" +
      '<button class="btn sm" type="button" data-action="tv-bulk" data-bulk="activate">Activate</button>' +
      '<button class="btn sm" type="button" data-action="tv-bulk" data-bulk="deactivate">Deactivate</button>' +
      '<button class="btn sm danger" type="button" data-action="tv-bulk" data-bulk="delete">Delete</button>' +
      '<button class="text-btn" type="button" data-action="tv-clear-selection">Clear</button></div>'
    : "";
  if (!list.length) {
    $("#tvTable").innerHTML = emptyState(all.length ? "No channels found" : "No channels yet", all.length ? "Try a different search or filter." : "Sync the playlist, import one from a URL, or add a channel by hand.");
    return;
  }
  // The header checkbox covers every channel the filters match, on all pages.
  const allSelected = list.every(c => state.tvSelection.has(c.id));
  $("#tvTable").innerHTML = '<section class="panel"><div class="table-wrap"><table><thead><tr>' +
    '<th class="cb"><input type="checkbox" aria-label="' + esc("Select all " + plural(list.length, "matching channel")) + '" title="Select all ' + list.length + ' matching" data-action="tv-select-all"' + (allSelected ? " checked" : "") + "></th>" +
    '<th>Channel</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
    items.map(c => {
      const initials = esc(String(c.name || "").slice(0, 2).toUpperCase());
      const logo = channelLogo(c);
      return "<tr>" +
      '<td class="cb"><input type="checkbox" aria-label="Select ' + esc(c.name) + '" data-action="tv-select" data-id="' + esc(c.id) + '"' + (state.tvSelection.has(c.id) ? " checked" : "") + "></td>" +
      '<td><div class="logo-cell"><span class="logo-box">' + (logo ? '<img src="' + esc(logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-initials="' + initials + '" onerror="this.replaceWith(document.createTextNode(this.dataset.initials))">' : initials) + "</span>" +
        '<span><a class="row-title" href="#/tv/' + encodeURIComponent(c.id) + '">' + esc(c.name) + "</a>" +
        '<div class="row-meta">' + channelRowMeta(c) + "</div></span></div></td>" +
      '<td><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
        '<button type="button" class="pill' + (c.active === false ? " grey" : "") + '" data-action="tv-toggle-active" data-id="' + esc(c.id) + '" title="Click to ' + (c.active === false ? "activate" : "deactivate") + '">' + (c.active === false ? "Inactive" : "Active") + "</button>" +
        checkPill(c) + "</div>" +
        (checkState(c) === "failed" && c.check.reason ? '<div class="row-meta"><span class="red">' + esc(c.check.reason) + "</span></div>" : "") +
      "</td>" +
      '<td><div class="row-actions">' +
        '<button type="button" class="text-btn" data-action="tv-test" data-id="' + esc(c.id) + '">Test</button>' +
        '<a class="text-btn" href="' + esc(SITE + "/live-tv#ch=" + encodeURIComponent(c.id)) + '" target="_blank" rel="noopener">Preview</a>' +
        '<a class="text-btn green" href="#/tv/' + encodeURIComponent(c.id) + '">Edit</a>' +
        '<button type="button" class="text-btn red" data-action="tv-delete" data-id="' + esc(c.id) + '">Delete</button>' +
      "</div></td></tr>";
    }).join("") +
    "</tbody></table></div>" +
    (pages > 1
      ? '<div class="pager"><button class="btn sm" type="button" data-action="tv-page" data-page="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + '>Previous</button><span>Page ' + page + " of " + pages +
        '</span><button class="btn sm" type="button" data-action="tv-page" data-page="' + (page + 1) + '"' + (page >= pages ? " disabled" : "") + ">Next</button></div>"
      : "") +
    "</section>";
}

async function updateChannel(id, body, message) {
  const result = await send("/api/admin/tv/channels/" + encodeURIComponent(id), "PUT", body);
  const index = state.tv.channels.findIndex(c => c.id === id);
  if (index >= 0) state.tv.channels[index] = result.channel;
  if (message) toast(message);
  return result.channel;
}

async function tvAction(name, el) {
  const id = el.dataset.id;
  const channel = (state.tv?.channels || []).find(c => c.id === id);
  try {
    if (name === "tv-toggle-active" && channel) {
      await busy(el, "", () => updateChannel(id, { active: channel.active === false }, channel.active === false ? channel.name + " is live on the Live TV page" : channel.name + " hidden from the Live TV page"));
      renderChannelTable();
    } else if (name === "tv-delete" && channel) {
      if (!confirm("Delete " + channel.name + "?" + (channel.origin === "synced" ? " Synced channels come back on the next playlist sync — deactivate it to keep it hidden." : ""))) return;
      await send("/api/admin/tv/channels/" + encodeURIComponent(id), "DELETE");
      state.tv.channels = state.tv.channels.filter(c => c.id !== id);
      state.tvSelection.delete(id);
      toast("Channel deleted");
      if ($("#tvTable")) renderChannelTable();
      else location.hash = "#/tv";
    } else if (name === "tv-test" && channel) {
      await busy(el, "Testing…", async () => {
        const result = (await send("/api/admin/tv/check", "POST", { urls: [channel.url] })).results[0];
        toast(result.ok ? channel.name + " responds (" + (result.status || "ok") + ", " + result.ms + " ms)" : channel.name + " failed: " + (result.error || "HTTP " + result.status), result.ok ? "info" : "error");
      });
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function tvBulk(action, button) {
  const ids = [...state.tvSelection];
  if (!ids.length) return;
  if (action === "delete" && !confirm("Delete " + plural(ids.length, "channel") + "?")) return;
  await busy(button, "", async () => {
    try {
      const result = await send("/api/admin/tv/channels/bulk", "POST", { action, ids });
      toast(plural(result.affected || 0, "channel") + " updated");
      state.tvSelection.clear();
      await loadChannels(true);
      renderChannelTable();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function tvDeleteAll(button) {
  const count = (state.tv?.channels || []).length;
  if (!count) return toast("There are no channels to delete");
  if (!confirm("Delete all " + count + " channels? Sync Playlist brings the playlist's channels back.")) return;
  await busy(button, "Deleting…", async () => {
    try {
      const result = await send("/api/admin/tv/channels?confirm=all", "DELETE");
      toast(plural(result.removed || 0, "channel") + " deleted");
      await loadChannels(true);
      renderChannels();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function tvSync(button) {
  await busy(button, "Syncing…", async () => {
    try {
      const r = await send("/api/admin/tv/sync", "POST");
      toast("Playlist synced: " + r.added + " added, " + r.updated + " updated, " + r.removed + " removed");
      state.tv = null;
      if (location.hash.startsWith("#/tv")) renderChannels();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

/* ---------- Import from URL ---------- */

function openImportModal() {
  state.importRun = null;
  openModal(
    '<form data-submit="tv-import" novalidate><div class="modal-head"><h3>Import from URL</h3><button class="icon-btn" type="button" data-action="modal-close" aria-label="Close">' + icon("x") + "</button></div>" +
    '<div class="modal-body"><p>Paste an https link to an M3U or JSON playlist. Its streams may be http or https, in any format the player supports.</p>' +
      '<label class="sr-only" for="importUrl">Playlist URL</label><input id="importUrl" name="url" class="input mono" inputmode="url" placeholder="https://example.com/playlist.m3u or .json" required>' +
      '<label class="check" style="margin-top:18px"><input type="checkbox" name="test" checked><span>Test each stream before adding <small>— only working channels are offered. Testing opens one connection per stream, and Xtream accounts often allow only one or two at a time, so untick this for large IPTV playlists.</small></span></label>' +
      '<div id="importStatus" class="import-progress" role="status"></div></div>' +
    '<div class="modal-foot" id="importFoot"><button class="btn" type="button" data-action="modal-close">Cancel</button><button class="btn primary" type="submit">Import</button></div></form>'
  );
  setTimeout(() => $("#importUrl")?.focus(), 30);
}

async function runImport(form) {
  const url = form.elements.url.value.trim();
  if (!/^https:\/\//i.test(url)) return toast("Paste an https playlist URL", "error");
  const test = form.elements.test.checked;
  const run = { cancelled: false };
  state.importRun = run;
  const status = $("#importStatus");
  const foot = $("#importFoot");
  const retry = () => {
    foot.innerHTML = '<button class="btn" type="button" data-action="modal-close">Cancel</button><button class="btn primary" type="submit">Try again</button>';
  };
  foot.innerHTML = '<button class="btn" type="button" data-action="modal-close">Cancel</button><button class="btn primary" type="button" disabled>Working…</button>';
  try {
    status.innerHTML = '<div class="muted">Downloading and reading the playlist…</div>';
    const parsed = await send("/api/admin/tv/parse", "POST", { url });
    if (run.cancelled) return;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const fresh = entries.filter(e => !e.exists);
    const known = entries.length - fresh.length;
    const skipped = parsed?.skipped ? " · " + parsed.skipped + " unusable entries skipped" : "";
    run.all = fresh;

    if (!test) {
      // No stream checks: offer every new channel straight away.
      run.working = fresh;
      status.innerHTML = "<div><b class=\"green\">" + plural(fresh.length, "new channel") + "</b> · " + known + " already in the catalog" + esc(skipped) + "</div>" +
        (fresh.length ? '<div class="hint">Streams were not tested — use Test on the Live TV page to check one.</div>' : "");
      if (!fresh.length) return retry();
      foot.innerHTML = '<button class="btn" type="button" data-action="modal-close">Cancel</button>' +
        '<button class="btn primary" type="button" data-action="tv-import-add" data-mode="all">Add ' + plural(fresh.length, "channel") + "</button>";
      return;
    }

    const results = [];
    for (let i = 0; i < fresh.length; i += CHECK_BATCH) {
      if (run.cancelled) return;
      const done = Math.min(i, fresh.length);
      status.innerHTML = '<div class="muted">Testing streams: ' + done + " of " + fresh.length + '…</div><div class="progress"><span style="width:' + Math.round((done / fresh.length) * 100) + '%"></span></div>';
      const batch = fresh.slice(i, i + CHECK_BATCH);
      const r = await send("/api/admin/tv/check", "POST", { urls: batch.map(e => e.url) });
      // Keep results aligned with entries even if a batch answers short.
      batch.forEach((_, j) => results.push(r?.results?.[j]));
    }
    if (run.cancelled) return;
    run.working = fresh.filter((_, i) => results[i]?.ok);
    const failed = fresh.map((e, i) => ({ e, r: results[i] })).filter(item => !item.r?.ok);
    status.innerHTML = '<div class="progress"><span style="width:100%"></span></div>' +
      "<div><b class=\"green\">" + plural(run.working.length, "working channel") + "</b> · " + failed.length + " failed · " + known + " already in the catalog" + esc(skipped) + "</div>" +
      (failed.length ? '<div class="result-list">' + failed.slice(0, 200).map(({ e, r }) => esc(e.name) + " — " + esc(r?.error || "failed")).join("<br>") + "</div>" : "");
    if (!fresh.length) return retry();
    foot.innerHTML = '<button class="btn" type="button" data-action="modal-close">Cancel</button>' +
      (failed.length ? '<button class="btn" type="button" data-action="tv-import-add" data-mode="all">Add all ' + fresh.length + "</button>" : "") +
      '<button class="btn primary" type="button" data-action="tv-import-add" data-mode="working"' + (run.working.length ? "" : " disabled") + ">Add " + plural(run.working.length, "channel") + "</button>";
  } catch (error) {
    if (run.cancelled) return;
    status.innerHTML = '<div class="error-box">' + esc(error.message) + "</div>";
    retry();
  }
}

async function addImported(mode, button) {
  const run = state.importRun;
  const channels = mode === "all" ? run?.all : run?.working;
  if (!channels?.length) return;
  await busy(button, "Adding…", async () => {
    try {
      const result = await send("/api/admin/tv/import", "POST", { channels });
      toast(plural(result.added, "channel") + " imported");
      closeModal();
      state.tv = null;
      if (location.hash.startsWith("#/tv")) renderChannels();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

/* ---------- Channel form ---------- */

async function renderChannelForm(id) {
  const renderId = state.renderId;
  const tv = await loadChannels();
  if (stale(renderId)) return;
  const channel = id ? tv.channels.find(c => c.id === id) : null;
  if (id && !channel) {
    setView(emptyState("Channel not found", "It may have been deleted or dropped by a playlist sync.") + '<p style="text-align:center"><a class="text-btn green" href="#/tv">← All channels</a></p>');
    return;
  }
  const c = channel || { active: true };
  const synced = c.origin === "synced";
  const logoSrc = channel ? channelLogo(c) : "";
  const headers = channelHeaders(c);
  const groups = channelGroups(tv.channels);
  const kind = channel ? channelKind(c) : "";
  setView(
    pageHead(channel ? "Edit TV Channel" : "Add TV Channel",
      channel
        ? (synced ? "Synced from the playlist — its name, group, logo and stream URL refresh on every sync; status, order and a category you pick here are kept." : "Manual channel — it survives playlist syncs.")
        : "Add a channel manually — manual channels survive playlist syncs.") +
    '<a class="back-link" href="#/tv">← All channels</a>' +
    '<form class="card" data-submit="channel-save" data-id="' + esc(channel ? c.id : "") + '" novalidate>' +
      '<div class="field"><label for="c-name">Channel name <span class="req">*</span></label><input id="c-name" name="name" class="input" required maxlength="120" placeholder="BeIN Sports FIFA" value="' + esc(c.name || "") + '"></div>' +
      '<div class="field"><label for="c-group">Group</label><input id="c-group" name="group" class="input" maxlength="60" list="groupList" placeholder="Country or section, e.g. Italy" value="' + esc(c.group || "") + '">' +
        '<datalist id="groupList">' + groups.map(g => '<option value="' + esc(g) + '"></option>').join("") + "</datalist>" +
        '<div class="hint">Shown as the country/group filter on the Live TV page. Leave blank for none.</div></div>' +
      // The thumb shows the Worker-relayed logo while the field still holds
      // the saved value; a newly typed http logo cannot preview on this https page.
      '<div class="field"><label for="c-logo">Logo URL</label><div class="with-thumb"><input id="c-logo" name="logo" class="input" placeholder="https://…" value="' + esc(c.logo || "") + '" data-input="thumb" data-thumb="logoThumb"' +
        (logoSrc ? ' data-saved-value="' + esc(c.logo || "") + '" data-saved-src="' + esc(logoSrc) + '"' : "") + ">" +
        '<img id="logoThumb" class="thumb logo' + (logoSrc ? "" : " hidden") + '" alt="" src="' + esc(logoSrc) + '" referrerpolicy="no-referrer" onerror="this.classList.add(\'hidden\')"></div>' +
        '<div class="hint">https or http. http logos are relayed by the Worker once saved, so they do not preview here before that.</div></div>' +
      '<div class="field"><label for="c-url">Stream URL <span class="req">*</span></label><input id="c-url" name="url" class="input mono" required inputmode="url" placeholder="https://example.com/stream/index.m3u8" value="' + esc(c.url || "") + '"><div class="hint">' + esc(STREAM_URL_HINT) +
        (kind ? " Saved as: <b>" + esc(KIND_LABELS[kind]) + "</b>" + (channelProxied(c) ? " · plays through the Worker" : "") + "." : "") + "</div></div>" +
      (headers.length
        ? '<div class="field"><span class="label">Request headers</span><div class="mini-box">' +
            headers.map(([label, value]) => '<div class="label">' + esc(label) + '</div><div class="mono" style="overflow-wrap:anywhere;margin-bottom:8px">' + esc(value) + "</div>").join("") +
          '</div><div class="hint">Read-only. Set by the playlist (<code>#EXTVLCOPT</code> lines or a <code>URL|User-Agent=…</code> suffix); the Worker sends them when it fetches the stream.</div></div>'
        : "") +
      '<div class="grid-2"><div class="field"><label for="c-category">Category</label><select id="c-category" name="category" class="select"><option value="">Auto (from group and name)</option>' +
        (tv.categories || []).map(cat => '<option value="' + esc(cat) + '"' + (c.categoryLocked && c.category === cat ? " selected" : "") + ">" + esc(cat) + "</option>").join("") + "</select>" +
        (channel && !c.categoryLocked ? '<div class="hint">Currently ' + esc(c.category) + ".</div>" : "") + "</div>" +
        '<div class="field"><label for="c-sort">Sort order</label><input id="c-sort" name="sort" type="number" class="input" placeholder="Auto" value="' + esc(Number.isFinite(c.sort) ? c.sort : "") + '"><div class="hint">Lower numbers show first. Auto keeps playlist order.</div></div></div>' +
      '<label class="check"><input type="checkbox" name="proxy"' + (c.proxy === true ? " checked" : "") + "><span>Play through the Worker <small>— relay the stream through this site even when it is https. Use it for streams that refuse other websites (CORS) or need the headers above. http, MPEG-TS and FLV streams always play through the Worker.</small></span></label>" +
      '<label class="check"><input type="checkbox" name="sandbox"' + (c.sandbox ? " checked" : "") + "><span>Run in a sandbox <small>— blocks the page's pop-ups and redirects (embed pages only). Channels run sandboxed by default; untick only for a channel that shows a black frame inside one." +
        (synced ? " Synced channels follow <code>\"sandbox\": true</code> in the playlist on every sync." : "") + "</small></span></label>" +
      '<label class="check"><input type="checkbox" name="active"' + (c.active !== false ? " checked" : "") + "><span>Active on Live TV</span></label>" +
      '<div class="form-actions"><button class="btn primary" type="submit">' + (channel ? "Save changes" : "Create Channel") + "</button>" +
        (channel
          ? '<button class="btn" type="button" data-action="tv-test" data-id="' + esc(c.id) + '">Test stream</button>' +
            '<a class="btn" href="' + esc(SITE + "/live-tv#ch=" + encodeURIComponent(c.id)) + '" target="_blank" rel="noopener">Preview ' + icon("external", 18) + "</a>" +
            '<button class="btn outline-danger" type="button" data-action="tv-delete" data-id="' + esc(c.id) + '">Delete</button>'
          : "") +
      '</div><p class="hint" id="formStatus" role="status"></p></form>'
  );
}

async function saveChannel(form) {
  const id = form.dataset.id;
  const v = (name) => form.elements[name].value.trim();
  if (!v("name")) return void ($("#formStatus").textContent = "Channel name is required.");
  if (!STREAM_URL_RE.test(v("url"))) return void ($("#formStatus").textContent = "Stream URL must start with http:// or https://");
  if (v("logo") && !/^https?:\/\//i.test(v("logo"))) return void ($("#formStatus").textContent = "Logo URL must start with http:// or https://");
  const body = {
    name: v("name"), group: v("group").slice(0, 60), logo: v("logo"), url: v("url"), category: v("category"), sort: v("sort"),
    proxy: form.elements.proxy.checked, sandbox: form.elements.sandbox.checked, active: form.elements.active.checked
  };
  const button = form.querySelector("button[type=submit]");
  await busy(button, "Saving…", async () => {
    try {
      if (id) {
        await updateChannel(id, body, "Channel saved");
      } else {
        const result = await send("/api/admin/tv/channels", "POST", body);
        state.tv?.channels.push(result.channel);
        toast("Channel created");
      }
      location.hash = "#/tv";
    } catch (error) {
      $("#formStatus").textContent = error.message;
      toast(error.message, "error");
    }
  });
}

/* ------------------------------------------------------------------ */
/* Fetch logs                                                          */
/* ------------------------------------------------------------------ */

async function renderLogs() {
  const renderId = state.renderId;
  const log = await loadSyncLog(true);
  if (stale(renderId)) return;
  const runs = log.runs || [];
  const tv = log.tv;
  setView(
    pageHead("Fetch Logs", "Schedule fetch history and errors, newest first. The last 30 runs are kept.",
      '<button class="btn" type="button" data-action="logs-refresh">' + icon("refresh") + "Refresh</button>" +
      '<button class="btn primary" type="button" data-action="logs-fetch">Fetch now</button>') +
    (tv ? '<section class="panel" style="margin-bottom:22px">' +
      kv("Live TV playlist", tv.lastSync ? (tv.lastSync.ok ? '<span class="pill">Synced ' + esc(ago(tv.lastSync.at)) + "</span>" : '<span class="pill red">Failed ' + esc(ago(tv.lastSync.at)) + "</span>") : '<span class="pill grey">Not synced</span>') +
      (tv.lastSync ? kv("Last result", tv.lastSync.ok ? esc(tv.lastSync.added + " added · " + tv.lastSync.updated + " updated · " + tv.lastSync.removed + " removed · " + tv.total + " channels") : '<span class="red">' + esc(tv.lastSync.error || "") + "</span>") : "") +
      "</section>" : "") +
    (runs.length
      ? '<section class="panel"><div class="table-wrap"><table><thead><tr><th>Time</th><th>Trigger</th><th>Result</th><th>Matches</th><th>Removed</th><th>Streams</th><th>Duration</th></tr></thead><tbody>' +
        runs.map(r => "<tr>" +
          '<td class="num">' + esc(stamp(r.at)) + '<div class="row-meta">' + esc(ago(r.at)) + "</div></td>" +
          "<td>" + esc(r.trigger === "admin" ? "Manual" : r.trigger === "cron" ? "Schedule" : r.trigger || "—") + "</td>" +
          "<td>" + (r.ok ? '<span class="pill">Healthy</span>' : '<span class="pill red">Failed</span><div class="row-meta red">' + esc(r.error || "") + "</div>") + "</td>" +
          '<td class="num">' + (r.ok ? esc(r.streamed + " feed · " + r.total + " total") : "—") + "</td>" +
          '<td class="num">' + (r.ok ? esc((r.removed || 0) + " gone · " + (r.expired || 0) + " expired") : "—") + "</td>" +
          '<td class="num">' + (r.ok ? esc(r.resolved) : "—") + "</td>" +
          '<td class="num">' + esc(((r.ms || 0) / 1000).toFixed(1) + " s") + "</td></tr>").join("") +
        "</tbody></table></div></section>"
      : emptyState("No fetches yet", "Runs appear here after the next scheduled fetch, or press Fetch now."))
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS_TABS = [
  ["ingest", "Schedule ingest"], ["tvSource", "TV source"], ["liveWindows", "Live windows"], ["notice", "Site notice"],
  ["analytics", "Ads & analytics"], ["identity", "Site identity"], ["maintenance", "Maintenance"], ["password", "Admin password"], ["storage", "Data storage"]
];

const changed = (section) => {
  const at = state.settings?.settings?.updated?.[section];
  return at ? "Last changed " + stamp(at) : "Using built-in defaults.";
};
const card = (id, ico, title, desc, body) =>
  '<section class="card" id="set-' + id + '" data-section="' + id + '"><h2>' + icon(ico, 24) + esc(title) + '</h2><p class="desc">' + desc + "</p>" + body + "</section>";
const switchRow = (name, title, text, checked) =>
  '<div class="switch-row"><div><h3>' + esc(title) + "</h3><p>" + text + '</p></div><label class="switch"><input type="checkbox" name="' + name + '"' + (checked ? " checked" : "") + ' aria-label="' + esc(title) + '"><span></span></label></div>';
const saveRow = (label, section) =>
  '<div class="form-actions"><button class="btn primary" type="submit">' + esc(label) + '</button><span class="saved-note" data-saved="' + section + '">' + esc(changed(section)) + "</span></div>";

async function renderSettings(section) {
  const renderId = state.renderId;
  const data = await loadSettings(true);
  if (stale(renderId)) return;
  const s = data.settings;
  const lw = s.liveWindows;
  const n = s.notice;
  const tvCategories = Array.isArray(data.tvCategories) && data.tvCategories.length ? data.tvCategories.map(String) : TV_CATEGORIES;
  const tvDefault = tvCategories.includes(s.tvSource.defaultCategory) ? s.tvSource.defaultCategory : (tvCategories.includes("Sports") ? "Sports" : tvCategories[0]);

  const typeRow = (t = { name: "", keywords: [], hours: "" }) =>
    '<div class="type-entry" data-type-row><input class="input" placeholder="Name" aria-label="Match type name" data-type="name" value="' + esc(t.name) + '">' +
    '<input class="input" placeholder="Keywords, e.g. t20, ipl" aria-label="Keywords" data-type="keywords" value="' + esc((t.keywords || []).join(", ")) + '">' +
    '<div class="suffix-wrap"><input class="input" type="number" step="0.01" min="0.5" max="168" aria-label="Hours" data-type="hours" value="' + esc(t.hours) + '"><span class="suffix">h</span></div>' +
    '<button class="icon-square" type="button" data-action="lw-remove-type" aria-label="Remove ' + esc(t.name || "entry") + '">' + icon("trash", 20) + "</button></div>";

  const imageField = (field, label, value) =>
    '<div class="field"><label for="n-' + field + '">' + label + '</label><div class="with-thumb">' +
      '<img id="thumb-' + field + '" class="thumb' + (value ? "" : " hidden") + '" alt="" src="' + esc(value) + '" onerror="this.classList.add(\'hidden\')">' +
      '<input id="n-' + field + '" name="' + field + '" class="input" placeholder="https://…" value="' + esc(value) + '" data-input="notice-preview" data-thumb="thumb-' + field + '"></div>' +
      '<button class="text-btn red" type="button" data-action="notice-remove-image" data-field="' + field + '">Remove</button></div>';

  setView(
    pageHead("Settings", "Everything the public site reads — editable here, no redeploy.") +
    '<nav class="tabs" aria-label="Settings sections">' +
      SETTINGS_TABS.map(([id, label]) => '<button type="button" class="tab" data-action="settings-tab" data-target="' + id + '">' + esc(label) + "</button>").join("") + "</nav>" +

    '<div class="group-label">SOURCES</div>' +
    card("ingest", "calendar", "Schedule ingest", "Matches are fetched from the Streamed feed every 10 minutes by a cron trigger, then resolved into streams a few sources at a time.",
      '<form data-submit="settings-ingest">' +
        switchRow("autoSync", "Automatic fetch", "Run the 10-minute schedule fetch. Off: matches only change when you press Fetch.", s.ingest.autoSync) +
        '<div class="inline-field" style="margin-top:18px"><label for="i-budget">Streams resolved per fetch</label><input id="i-budget" name="resolveBudget" type="number" min="1" max="20" class="input" value="' + esc(s.ingest.resolveBudget) + '"></div>' +
        '<p class="hint" style="margin:-6px 0 22px">1–20. Higher resolves faster but uses more of the Worker\'s per-request subrequest budget (50 on the free plan).</p>' +
        saveRow("Save ingest settings", "ingest") + "</form>") +
    card("tvSource", "home", "TV source", "The playlist the Live TV sync imports from — by default the sports.m3u playlist (any M3U or JSON playlist works) — plus its fetch budget, health-check concurrency and the category for channels nothing else places. A sync replaces every synced channel with the playlist's current list; manual channels stay. All editable here — no redeploy.",
      '<form data-submit="settings-tvSource">' +
        '<div class="field"><label for="t-url">Playlist URL (M3U or JSON)</label><input id="t-url" name="url" class="input mono" inputmode="url" value="' + esc(s.tvSource.url) + '"></div>' +
        '<div class="field"><label for="t-category">Default category</label><select id="t-category" name="defaultCategory" class="select">' +
          tvCategories.map(cat => '<option value="' + esc(cat) + '"' + (cat === tvDefault ? " selected" : "") + ">" + esc(cat) + "</option>").join("") + "</select>" +
          '<div class="hint">For channels whose playlist group and name do not point to a category. Applies from the next sync.</div></div>' +
        '<div class="inline-field"><label for="t-timeout">Playlist fetch timeout (s)</label><input id="t-timeout" name="timeoutSec" type="number" min="5" max="300" class="input" value="' + esc(s.tvSource.timeoutSec) + '"></div>' +
        '<div class="inline-field"><label for="t-conc">Health-check concurrency</label><input id="t-conc" name="concurrency" type="number" min="1" max="10" class="input" value="' + esc(s.tvSource.concurrency) + '"></div>' +
        switchRow("autoSync", "Re-sync automatically", "Pull the playlist every hour (and soon after the URL changes) so new channels and changed stream links reach the Live TV page on their own.", s.tvSource.autoSync) +
        saveRow("Save TV source settings", "tvSource") + "</form>") +

    '<div class="group-label">CONTENT</div>' +
    card("liveWindows", "calendar", "Live windows", "How long after kickoff a match stays on the site before it is removed automatically. Set a default, override per sport category, or add match-type entries like Cricket T20. A match uses the first that applies: per-match override → match type → category → default.",
      '<form data-submit="settings-liveWindows">' +
        '<div class="field"><label for="lw-default" class="faint">Default — remove after (hours)</label><input id="lw-default" name="defaultHours" type="number" step="0.01" min="0.5" max="168" class="input" value="' + esc(lw.defaultHours) + '"><div class="hint">0.5–168 h. Applies when no match type or category matches.</div></div>' +
        '<h3 class="sub">Sport categories</h3><p class="sub-desc">Leave blank to use the default.</p><div class="cat-grid">' +
        data.sportCategories.map(c => '<div class="field"><label for="lw-' + esc(c.key) + '" class="faint">' + esc(c.label) + '</label><div class="suffix-wrap"><input id="lw-' + esc(c.key) + '" class="input" type="number" step="0.01" min="0.5" max="168" data-cat="' + esc(c.key) + '" placeholder="' + esc(lw.defaultHours + " h") + '" value="' + esc(lw.categories[c.key] ?? "") + '"><span class="suffix">h</span></div></div>').join("") +
        "</div>" +
        '<h3 class="sub">Match types</h3><p class="sub-desc">Keyword rules for formats with their own length — matched against the competition/event title, checked before the category.</p>' +
        '<div id="typeRows">' + lw.types.map(t => typeRow(t)).join("") + "</div>" +
        '<div class="type-entry" id="newType"><input class="input" placeholder="New entry name" aria-label="New entry name" data-new="name"><input class="input" placeholder="Keywords, e.g. t20, ipl" aria-label="New entry keywords" data-new="keywords"><div class="suffix-wrap"><input class="input" type="number" step="0.01" min="0.5" max="168" placeholder="5" aria-label="New entry hours" data-new="hours"><span class="suffix">h</span></div><span></span></div>' +
        '<button class="add-entry" type="button" data-action="lw-add-type">+ Add entry</button>' +
        saveRow("Save Live Windows", "liveWindows") + "</form>") +
    card("notice", "megaphone", "Site notice", "A banner just below the header on every public page. Add an optional link to make it clickable, or disable it to hide the banner site-wide. Set an image banner to show a picture instead of text. Saves apply within a few seconds.",
      '<form data-submit="settings-notice">' +
        imageField("image", "Image banner — desktop &amp; tablet (optional)", n.image) +
        imageField("imageMobile", "Image banner — mobile (optional)", n.imageMobile) +
        '<p class="hint" style="margin:-8px 0 22px">Paste an https image URL (or a same-origin path like /images/banner.webp). When set, the notice shows this image instead of the message — the message below becomes the image\'s alt text, and the background colour and scrolling are ignored. Recommended: 1376×160 px (8.6:1), mobile 750×200 px.</p>' +
        '<div class="field"><label for="n-text">Message</label><textarea id="n-text" name="text" class="textarea" maxlength="500" style="min-height:80px" data-input="notice-preview">' + esc(n.text) + "</textarea></div>" +
        '<div class="field"><label for="n-link">Link (optional)</label><input id="n-link" name="link" class="input" placeholder="https://… or /live-tv" value="' + esc(n.link) + '"><div class="hint">Makes the banner clickable. Can be a full URL like <code>https://play.google.com/…</code> or an in-site path like <code>/live-tv</code>. Blank = plain, non-clickable.</div></div>' +
        '<label class="check"><input type="checkbox" name="newTab"' + (n.newTab ? " checked" : "") + '><span>Open link in a new tab <small>(Leave unchecked to open in the same tab. Unchecked is recommended so Chrome and mobile pop-up blockers never block the banner).</small></span></label>' +
        '<span class="label">Background color</span><div class="swatches">' +
          NOTICE_SWATCHES.map(c => '<button type="button" class="swatch' + (n.bg === c ? " active" : "") + '" style="background:' + c + '" data-action="notice-swatch" data-color="' + c + '" aria-label="Background ' + c + '"></button>').join("") +
          '<span class="swatch-sep"></span><input type="color" class="color-input" aria-label="Custom background colour" value="' + esc(n.bg || "#12151d") + '" data-input="notice-color"></div>' +
        '<div class="field" style="max-width:220px"><input name="bg" class="input mono" placeholder="Theme default" value="' + esc(n.bg) + '" data-input="notice-preview" aria-label="Background hex colour"></div>' +
        '<span class="label">Preview</span><div class="notice-preview" id="noticePreview"></div>' +
        '<label class="check"><input type="checkbox" name="marquee"' + (n.marquee ? " checked" : "") + ' data-input="notice-preview"><span>Scroll the text (marquee)</span></label>' +
        '<p class="warn hidden" id="imageWarn">An image banner is set — the message, background colour and scrolling do not apply. Remove the image URL to go back to the text banner.</p>' +
        '<label class="check"><input type="checkbox" name="enabled"' + (n.enabled ? " checked" : "") + "><span>Show the notice on the public site</span></label>" +
        saveRow("Save Notice", "notice") + "</form>") +
    card("analytics", "chart", "Ads & analytics", "Google Analytics for every public page, plus a house banner shown under the header on the homepage. Toggle either off to disable it site-wide without losing its settings.",
      '<form data-submit="settings-analytics">' +
        switchRow("gaEnabled", "Google Analytics", "Loads GA4 (gtag.js) on the public pages.", s.analytics.gaEnabled) +
        '<div class="field" style="margin-top:12px"><label for="a-ga">GA4 measurement ID</label><input id="a-ga" name="gaId" class="input mono" placeholder="G-XXXXXXXXXX" value="' + esc(s.analytics.gaId) + '"><div class="hint">Format G-XXXX.</div></div>' +
        switchRow("bannerEnabled", "House banner", "An image banner (your own promo or sponsor) below the header on the homepage.", s.banner.enabled) +
        '<div class="field" style="margin-top:12px"><label for="b-image">Banner image</label><input id="b-image" name="bannerImage" class="input" placeholder="https://…" value="' + esc(s.banner.image) + '"></div>' +
        '<div class="grid-2"><div class="field"><label for="b-link">Banner link</label><input id="b-link" name="bannerLink" class="input" placeholder="https://… or /path" value="' + esc(s.banner.link) + '"></div>' +
        '<div class="field"><label for="b-alt">Alt text</label><input id="b-alt" name="bannerAlt" class="input" maxlength="200" value="' + esc(s.banner.alt) + '"></div></div>' +
        saveRow("Save ad settings", "analytics") + "</form>") +
    card("identity", "mail", "Site identity", "The brand name and tagline used in page titles and the site header and footer, plus the contact address shown in the footer.",
      '<form data-submit="settings-identity">' +
        '<div class="field"><label for="id-name">Site name</label><input id="id-name" name="siteName" class="input" maxlength="60" placeholder="Sportzfylive" value="' + esc(s.identity.siteName) + '"></div>' +
        '<div class="field"><label for="id-tag">Tagline</label><input id="id-tag" name="tagline" class="input" maxlength="160" placeholder="Live Sports" value="' + esc(s.identity.tagline) + '"></div>' +
        '<div class="field"><label for="id-mail">Contact email</label><input id="id-mail" name="contactEmail" type="email" class="input mono" maxlength="120" placeholder="info@example.com" value="' + esc(s.identity.contactEmail) + '"></div>' +
        saveRow("Save", "identity") + "</form>") +

    '<div class="group-label">MAINTENANCE</div>' +
    card("maintenance", "wrench", "Maintenance", "One-off operations you can trigger by hand. Schedule fetch and cleanup also run automatically on cron.",
      '<div class="maint"><button class="btn primary block" type="button" data-action="maint-fetch">Fetch Schedule</button><p>Pull the latest matches + streams from the source now.</p></div>' +
      '<div class="maint"><button class="btn block" type="button" data-action="maint-tv-sync">Sync Live TV playlist</button><p>Re-import the TV source playlist now. Manual channels and your status/order choices are kept.</p></div>' +
      '<div class="maint"><button class="btn outline-danger block" type="button" data-action="maint-cleanup">Run Cleanup</button><p>Delete finished matches past the live window (also runs on every scheduled fetch).</p></div>') +

    '<div class="group-label">SYSTEM</div>' +
    card("password", "lock", "Admin password", "Rotate the dashboard login without a redeploy. Your current session stays valid — the new password applies from the next login. The Worker secret ADMIN_TOKEN remains the bootstrap credential and takes over again if you reset.",
      '<form data-submit="password-change" autocomplete="off">' +
        '<div class="field"><label for="p-current">Current password</label><input id="p-current" name="current" type="password" class="input" autocomplete="current-password"></div>' +
        '<div class="field"><label for="p-next">New password</label><input id="p-next" name="next" type="password" class="input" placeholder="min 10 characters" autocomplete="new-password" minlength="10"></div>' +
        '<div class="field"><label for="p-confirm">Confirm new</label><input id="p-confirm" name="confirm" type="password" class="input" autocomplete="new-password"></div>' +
        '<div class="form-actions"><button class="btn primary" type="submit">Change password</button>' +
        (data.security.passwordSource === "custom" ? '<button class="btn outline-danger" type="button" data-action="password-reset">Reset to ADMIN_TOKEN</button>' : "") + "</div>" +
        '<p class="hint">' + (data.security.passwordSource === "custom"
          ? "Using a password set here on " + esc(stamp(data.security.passwordUpdatedAt)) + ". Locked out? Delete the <code>admin_credential</code> key in the KV namespace to fall back to ADMIN_TOKEN."
          : "Using the Worker secret ADMIN_TOKEN credential.") + "</p></form>") +
    card("storage", "archive", "Data storage", "Whether your admin edits (manual matches, channels, settings) survive a redeploy. Everything lives in the Cloudflare KV namespace bound as SPORTZFY_DB, which deploys never touch.",
      '<div id="storageReport"><div class="skeleton" style="height:90px"></div></div><button class="btn sm" type="button" data-action="storage-recheck" style="margin-top:6px">Re-check</button>')
  );

  updateNoticePreview();
  setupScrollSpy();
  loadStorageReport();
  if (section) {
    const target = $("#set-" + section);
    if (target) setTimeout(() => target.scrollIntoView({ block: "start" }), 30);
  }
}

/* ------------------------------------------------------------------ */
/* Android app control                                                 */
/* ------------------------------------------------------------------ */

async function renderApp() {
  const renderId = state.renderId;
  const [data, matches] = await Promise.all([loadSettings(true), loadMatches().catch(() => [])]);
  if (stale(renderId)) return;
  const a = data.settings.app;
  const hidden = new Set(a.hiddenCategories);
  const option = (value, label, current) => '<option value="' + value + '"' + (current === value ? " selected" : "") + ">" + label + "</option>";

  setView(
    pageHead("Android app", "Everything here reaches installed apps within a minute — no update to ship. The app keeps its last good copy when it is offline.") +
    '<div id="appStatus"></div>' +

    '<div class="group-label">AVAILABILITY</div>' +
    card("app-availability", "wrench", "Maintenance & updates", "Maintenance mode replaces the whole app with your message. A minimum version blocks every older build with an “update required” screen until it is replaced.",
      '<form data-submit="app-availability">' +
        switchRow("maintenanceEnabled", "Maintenance mode", "Takes the app offline for everyone, immediately. Turn it back off to restore it.", a.maintenanceEnabled) +
        '<div class="field" style="margin-top:12px"><label for="ap-mm">Maintenance message</label><textarea id="ap-mm" name="maintenanceMessage" class="textarea" maxlength="300" style="min-height:80px" placeholder="We’ll be back shortly.">' + esc(a.maintenanceMessage) + "</textarea></div>" +
        '<div class="grid-2"><div class="field"><label for="ap-min">Minimum version code</label><input id="ap-min" name="minVersionCode" type="number" min="0" class="input" value="' + esc(a.minVersionCode) + '"><div class="hint">Builds below this are forced to update. 0 turns it off. Use the <code>versionCode</code> from <code>build.gradle.kts</code>.</div></div>' +
        '<div class="field"><label for="ap-upd">Update link</label><input id="ap-upd" name="updateUrl" class="input mono" placeholder="https://… (download or store page)" value="' + esc(a.updateUrl) + '"></div></div>' +
        saveRow("Save availability", "app") + "</form>") +

    '<div class="group-label">CONTENT</div>' +
    card("app-announcement", "megaphone", "Announcement", "A banner above the match list. Leave the message blank to hide it.",
      '<form data-submit="app-announcement">' +
        '<div class="field"><label for="ap-am">Message</label><textarea id="ap-am" name="announcementMessage" class="textarea" maxlength="300" style="min-height:80px">' + esc(a.announcementMessage) + "</textarea></div>" +
        '<div class="field"><label for="ap-au">Link (optional)</label><input id="ap-au" name="announcementUrl" class="input mono" placeholder="https://…" value="' + esc(a.announcementUrl) + '"><div class="hint">Makes the banner tappable. https only.</div></div>' +
        saveRow("Save announcement", "app") + "</form>") +
    card("app-content", "calendar", "Catalog", "Pin a match into the spotlight and hide whole sports from the app.",
      '<form data-submit="app-content">' +
        '<div class="field"><label for="ap-fm">Featured match ID</label><input id="ap-fm" name="featuredMatchId" class="input mono" list="appMatchList" placeholder="Match ID (blank = automatic)" value="' + esc(a.featuredMatchId) + '">' +
        '<datalist id="appMatchList">' + matches.slice(0, 200).map(m => '<option value="' + esc(m.id) + '">' + esc(m.title || "") + "</option>").join("") + "</datalist>" +
        '<div class="hint">Shown in the spotlight while the match is in today’s feed. Start typing to pick from the site’s matches.</div></div>' +
        '<h3 class="sub">Hidden sports</h3><p class="sub-desc">Ticked sports disappear from the app’s catalog.</p><div class="cat-grid">' +
        data.appSports.map(sport => '<label class="check"><input type="checkbox" name="hide" value="' + esc(sport.key) + '"' + (hidden.has(sport.key) ? " checked" : "") + "><span>" + esc(sport.label) + "</span></label>").join("") + "</div>" +
        saveRow("Save catalog", "app") + "</form>") +

    '<div class="group-label">PLAYER &amp; SOURCES</div>' +
    card("app-player", "tv", "Player", "How embedded streams load, and the ad-network block list.",
      '<form data-submit="app-player">' +
        '<div class="field"><label for="ap-pm">Embed mode</label><select id="ap-pm" name="playerMode" class="select">' +
          option("direct", "Direct — page loads like a browser tab (recommended)", a.playerMode) +
          option("iframe", "Iframe — embed inside a plain iframe, like the website", a.playerMode) + "</select></div>" +
        switchRow("adBlocking", "Built-in ad blocking", "Off by default: most stream sites are paid for by their ads and refuse to play while they are blocked.", a.adBlocking) +
        '<div class="field" style="margin-top:12px"><label for="ap-bh">Extra blocked hosts</label><textarea id="ap-bh" name="extraBlockedHosts" class="textarea mono" style="min-height:90px" placeholder="ads.example.com">' + esc(a.extraBlockedHosts.join("\n")) + "</textarea><div class=\"hint\">One host per line. Applies to pop-ups and sub-resources in the player.</div></div>" +
        saveRow("Save player settings", "app") + "</form>") +
    card("app-sources", "inbox", "Data sources", "Where the app loads its channel list and falls back to when a stream host blocks the phone.",
      '<form data-submit="app-sources">' +
        '<div class="field"><label for="ap-ch">Channel list URL</label><input id="ap-ch" name="channelsUrl" class="input mono" placeholder="Blank = the app’s built-in channels.json" value="' + esc(a.channelsUrl) + '"><div class="hint">https only. A list in the channels.json format, or an M3U playlist. Streams in it may be http or https: HLS, DASH, MPEG-TS, MP4 or web pages.</div></div>' +
        switchRow("streamProxyEnabled", "Stream proxy fallback", "When streamed.pk blocks the phone, retry through a Worker. Off: no fallback.", a.streamProxyEnabled) +
        '<div class="field" style="margin-top:12px"><label for="ap-sp">Proxy URL</label><input id="ap-sp" name="streamProxyUrl" class="input mono" placeholder="Blank = this Worker" value="' + esc(a.streamProxyUrl) + '"></div>' +
        saveRow("Save sources", "app") + "</form>") +

    '<div class="group-label">LIVE VIEW</div>' +
    card("app-live", "logs", "What the app receives", "The exact JSON served to installed apps right now.",
      '<div id="appLive"><div class="skeleton" style="height:120px"></div></div>' +
      '<div class="form-actions"><button class="btn sm" type="button" data-action="app-refresh">Refresh</button><button class="btn sm" type="button" data-action="app-copy-url">Copy config URL</button></div>')
  );
  refreshAppLive();
}

async function refreshAppLive() {
  const host = $("#appLive");
  const status = $("#appStatus");
  if (!host) return;
  try {
    const response = await fetch(API + "/api/app/config", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const config = await response.json();
    if (!$("#appLive")) return;
    host.innerHTML = '<pre class="code-block">' + esc(JSON.stringify(config, null, 2)) + "</pre>";
    const maintenance = config.maintenance?.enabled;
    const forced = Number(config.minVersionCode) > 0;
    status.innerHTML = '<div class="status-box' + (maintenance ? " bad" : "") + '"><span class="status-dot"></span><div><b>' +
      (maintenance ? "App is in maintenance mode" : "App is live") + "</b>" +
      (maintenance ? "Every install shows the maintenance screen." : "Installed apps are serving normally.") +
      (forced ? " Builds below version code " + esc(config.minVersionCode) + " are forced to update." : "") +
      (config.announcement?.message ? " An announcement is showing." : "") + "</div></div>";
  } catch (error) {
    host.innerHTML = '<div class="error-box">Could not load the config: ' + esc(error.message) + "</div>";
  }
}

async function saveAppSection(form, body) {
  const result = await saveSection("app", body, form);
  if (result) refreshAppLive();
  return result;
}

function setupScrollSpy() {
  if (!("IntersectionObserver" in window)) return;
  const tabs = new Map($$(".tab").map(t => [t.dataset.target, t]));
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      tabs.forEach(t => t.classList.remove("active"));
      const tab = tabs.get(entry.target.dataset.section);
      if (tab) {
        tab.classList.add("active");
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
  }, { rootMargin: "-170px 0px -60% 0px" });
  $$(".card[data-section]").forEach(c => observer.observe(c));
}

function updateNoticePreview() {
  const form = $('form[data-submit="settings-notice"]');
  const preview = $("#noticePreview");
  if (!form || !preview) return;
  const image = form.elements.image.value.trim();
  const text = form.elements.text.value.trim() || "Your message appears here";
  const bg = /^#[0-9a-f]{6}$/i.test(form.elements.bg.value.trim()) ? form.elements.bg.value.trim() : "#12151d";
  $("#imageWarn").classList.toggle("hidden", !image);
  preview.innerHTML = image
    ? '<img src="' + esc(image) + '" alt="' + esc(text) + '" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'bar\',textContent:\'Image could not be loaded\'}))">'
    : '<div class="bar' + (form.elements.marquee.checked ? " marquee" : "") + '" style="background:' + bg + '"><span>' + esc(text) + "</span></div>";
  $$(".swatch").forEach(s => s.classList.toggle("active", s.dataset.color === form.elements.bg.value.trim().toLowerCase()));
}

async function loadStorageReport() {
  const host = $("#storageReport");
  if (!host) return;
  try {
    const r = await api("/api/admin/storage");
    if (!$("#storageReport")) return;
    const present = r.records.filter(x => x.present);
    host.innerHTML = (r.ok
      ? '<div class="status-box"><span class="status-dot"></span><div><b>Persisted</b>Admin data is in Cloudflare KV (' + esc(r.binding) + ") and survives every deploy and restart.</div></div>"
      : '<div class="status-box bad"><span class="status-dot"></span><div><b>Not persisted</b>' + esc(r.error || "KV is not reachable") + "</div></div>") +
      '<div class="mini-box"><div class="label">Binding</div><div class="mono">' + esc(r.binding) + " → Workers KV</div></div>" +
      '<details class="records"><summary>Stored records (' + present.length + "/" + r.records.length + ")</summary><ul>" +
        r.records.map(x => "<li><span>" + esc(x.label) + ' <span class="faint mono">' + esc(x.key) + "</span></span><span class=\"" + (x.present ? "green" : "faint") + '">' +
          (x.present ? esc((x.items !== undefined ? plural(x.items, "item") + " · " : "") + Math.max(1, Math.round(x.bytes / 1024)) + " KB") : "not set") + "</span></li>").join("") +
      "</ul></details>" +
      '<p class="hint">Checked ' + esc(stamp(r.checkedAt)) + "</p>";
  } catch (error) {
    host.innerHTML = '<div class="error-box">' + esc(error.message) + "</div>";
  }
}

async function saveSection(section, body, form) {
  const button = form?.querySelector("button[type=submit]");
  return busy(button, "Saving…", async () => {
    try {
      const result = await send("/api/admin/settings/" + section, "PUT", body);
      state.settings.settings = result.settings;
      const note = $('[data-saved="' + section + '"]');
      if (note) note.textContent = changed(section);
      if (section === "identity") applyIdentity();
      toast("Saved" + (result.matchesUpdated ? " — " + plural(result.matchesUpdated, "match", "matches") + " re-timed" : ""));
      return result;
    } catch (error) {
      toast(error.message, "error");
      return null;
    }
  });
}

const SETTINGS_SUBMIT = {
  "settings-ingest": (f) => saveSection("ingest", { autoSync: f.elements.autoSync.checked, resolveBudget: f.elements.resolveBudget.value }, f),
  "settings-tvSource": (f) => saveSection("tvSource", {
    url: f.elements.url.value.trim(), timeoutSec: f.elements.timeoutSec.value, concurrency: f.elements.concurrency.value, autoSync: f.elements.autoSync.checked,
    defaultCategory: f.elements.defaultCategory.value
  }, f),
  "settings-liveWindows": (f) => {
    const categories = {};
    $$("[data-cat]", f).forEach(input => {
      if (input.value.trim() !== "") categories[input.dataset.cat] = input.value.trim();
    });
    const types = $$("[data-type-row]", f).map(row => ({
      name: $('[data-type="name"]', row).value.trim(),
      keywords: $('[data-type="keywords"]', row).value,
      hours: $('[data-type="hours"]', row).value
    })).filter(t => t.name);
    return saveSection("liveWindows", { defaultHours: f.elements.defaultHours.value, categories, types }, f);
  },
  "settings-notice": (f) => saveSection("notice", {
    enabled: f.elements.enabled.checked, text: f.elements.text.value, link: f.elements.link.value.trim(), newTab: f.elements.newTab.checked,
    bg: f.elements.bg.value.trim(), marquee: f.elements.marquee.checked, image: f.elements.image.value.trim(), imageMobile: f.elements.imageMobile.value.trim()
  }, f),
  "settings-analytics": async (f) => {
    const ga = await saveSection("analytics", { gaEnabled: f.elements.gaEnabled.checked, gaId: f.elements.gaId.value.trim() }, f);
    if (!ga) return;
    await saveSection("banner", {
      enabled: f.elements.bannerEnabled.checked, image: f.elements.bannerImage.value.trim(), link: f.elements.bannerLink.value.trim(), alt: f.elements.bannerAlt.value.trim()
    }, f);
  },
  "app-availability": (f) => saveAppSection(f, {
    maintenanceEnabled: f.elements.maintenanceEnabled.checked, maintenanceMessage: f.elements.maintenanceMessage.value,
    minVersionCode: f.elements.minVersionCode.value, updateUrl: f.elements.updateUrl.value.trim()
  }),
  "app-announcement": (f) => saveAppSection(f, {
    announcementMessage: f.elements.announcementMessage.value, announcementUrl: f.elements.announcementUrl.value.trim()
  }),
  "app-content": (f) => saveAppSection(f, {
    featuredMatchId: f.elements.featuredMatchId.value.trim(),
    hiddenCategories: $$('input[name="hide"]:checked', f).map(input => input.value)
  }),
  "app-player": (f) => saveAppSection(f, {
    playerMode: f.elements.playerMode.value, adBlocking: f.elements.adBlocking.checked, extraBlockedHosts: f.elements.extraBlockedHosts.value
  }),
  "app-sources": (f) => saveAppSection(f, {
    channelsUrl: f.elements.channelsUrl.value.trim(), streamProxyEnabled: f.elements.streamProxyEnabled.checked, streamProxyUrl: f.elements.streamProxyUrl.value.trim()
  }),
  "settings-identity": (f) => saveSection("identity", {
    siteName: f.elements.siteName.value.trim(), tagline: f.elements.tagline.value.trim(), contactEmail: f.elements.contactEmail.value.trim()
  }, f)
};

async function changePassword(form) {
  const current = form.elements.current.value;
  const next = form.elements.next.value.trim();
  if (next.length < 10) return toast("New password must be at least 10 characters", "error");
  if (next !== form.elements.confirm.value.trim()) return toast("The new passwords do not match", "error");
  await busy(form.querySelector("button[type=submit]"), "Changing…", async () => {
    try {
      await send("/api/admin/password", "POST", { current, next });
      toast("Password changed — use it from your next sign-in");
      state.settings = null;
      route();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function resetPassword(button) {
  const current = $("#p-current")?.value || "";
  if (!current) return toast("Enter your current password first", "error");
  if (!confirm("Reset the login to the ADMIN_TOKEN Worker secret?")) return;
  await busy(button, "Resetting…", async () => {
    try {
      await send("/api/admin/password", "DELETE", { current });
      toast("Login reset to ADMIN_TOKEN");
      state.settings = null;
      route();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

function openModal(html) {
  $("#modalRoot").innerHTML = '<div class="modal-bg" data-action="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">' + html + "</div></div>";
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#modalRoot input:not([type=hidden])")?.focus(), 30);
}
function closeModal() {
  if (state.importRun) state.importRun.cancelled = true;
  state.streamModal = null;
  $("#modalRoot").innerHTML = "";
  document.body.style.overflow = "";
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

const ACTIONS = {
  "toggle-nav": () => document.body.classList.toggle("nav-open"),
  "close-nav": () => document.body.classList.remove("nav-open"),
  "toggle-avatar": (el) => {
    const menu = $("#avatarMenu");
    menu.innerHTML =
      '<a href="' + esc(SITE + "/") + '" target="_blank" rel="noopener" role="menuitem">' + icon("external", 18) + "View site</a>" +
      '<a href="' + esc(SITE + "/live-tv") + '" target="_blank" rel="noopener" role="menuitem">' + icon("signal", 18) + "Live TV page</a>" +
      '<button type="button" data-action="logout" role="menuitem">' + icon("logout", 18) + "Logout</button>";
    menu.classList.toggle("hidden");
    el.setAttribute("aria-expanded", String(!menu.classList.contains("hidden")));
  },
  "logout": () => logout(),
  "reload-route": () => route(),
  "refresh-dashboard": async (el) => {
    await busy(el, "Refreshing…", async () => {
      state.tv = null;
      await renderDashboard();
    });
    toast("Dashboard refreshed");
  },
  "run-maintenance": (el) => runMaintenance(el),

  "match-chip": (el) => {
    state.matchFilter.chip = el.dataset.chip;
    state.matchFilter.page = 1;
    $$('[data-action="match-chip"]').forEach(c => {
      c.classList.toggle("active", c === el);
      c.setAttribute("aria-pressed", String(c === el));
    });
    renderMatchTable();
  },
  "match-page": (el) => {
    state.matchFilter.page = Number(el.dataset.page) || 1;
    renderMatchTable();
    $("#matchTable").scrollIntoView({ block: "start" });
  },
  "match-select": (el) => {
    if (el.checked) state.matchSelection.add(el.dataset.id);
    else state.matchSelection.delete(el.dataset.id);
    renderMatchBulk();
  },
  "match-select-all": (el) => {
    const page = state.matchFilter.page;
    filteredMatches().slice((page - 1) * MATCH_PAGE_SIZE, page * MATCH_PAGE_SIZE)
      .forEach(m => (el.checked ? state.matchSelection.add(String(m.id)) : state.matchSelection.delete(String(m.id))));
    renderMatchTable();
  },
  "match-clear-selection": () => {
    state.matchSelection.clear();
    renderMatchTable();
  },
  "match-bulk": (el) => matchBulk(el.dataset.bulk, el),
  "match-feature": (el) => toggleFeatured(el.dataset.id, el),
  "match-delete": (el) => deleteMatch(el.dataset.id),
  "matches-delete-all": (el) => deleteAllMatches(el),
  "match-share": async () => {
    const url = publicMatchUrl(state.currentMatch.id);
    try {
      await navigator.clipboard.writeText(url);
      toast("Match link copied");
    } catch (_) {
      toast(url);
    }
  },
  "match-delete-current": () => deleteMatch(state.currentMatch.id, () => { location.hash = "#/matches"; }),

  "stream-add": () => openStreamModal(-1),
  "stream-edit": (el) => openStreamModal(Number(el.dataset.index)),
  "stream-delete": (el) => {
    const streams = manualStreams(state.currentMatch).slice();
    const index = Number(el.dataset.index);
    if (!confirm("Delete " + (streams[index]?.name || "this stream") + "?")) return;
    streams.splice(index, 1);
    state.currentMatch.streams = streams;
    renderStreamRows();
    saveStreams("Stream deleted");
  },
  "stream-copy": async (el) => {
    const stream = manualStreams(state.currentMatch)[Number(el.dataset.index)];
    if (!stream?.url) return toast("This stream has no URL", "error");
    try {
      await navigator.clipboard.writeText(stream.url);
      toast("Stream URL copied");
    } catch (_) {
      toast(stream.url);
    }
  },
  "stream-move": (el) => {
    const index = Number(el.dataset.index);
    moveStream(index, index + Number(el.dataset.dir));
  },
  "catalog-pick": (el) => pickCatalogChannel(el.dataset.id),
  "catalog-bulk-toggle": () => {
    state.streamModal.bulk = !state.streamModal.bulk;
    state.streamModal.picked.clear();
    renderCatalog();
  },
  "catalog-bulk-add": (el) => bulkAddStreams(el),
  "modal-close": () => closeModal(),

  "tv-chip": (el) => {
    state.tvFilter.chip = el.dataset.chip;
    state.tvFilter.page = 1;
    $$('[data-action="tv-chip"]').forEach(c => {
      c.classList.toggle("active", c === el);
      c.setAttribute("aria-pressed", String(c === el));
    });
    renderChannelTable();
  },
  "tv-select": (el) => {
    if (el.checked) state.tvSelection.add(el.dataset.id);
    else state.tvSelection.delete(el.dataset.id);
    renderChannelTable();
  },
  "tv-select-all": (el) => {
    filteredChannels().forEach(c => (el.checked ? state.tvSelection.add(c.id) : state.tvSelection.delete(c.id)));
    renderChannelTable();
  },
  "tv-page": (el) => {
    state.tvFilter.page = Number(el.dataset.page) || 1;
    renderChannelTable();
    $("#tvTable").scrollIntoView({ block: "start" });
  },
  "tv-clear-selection": () => {
    state.tvSelection.clear();
    renderChannelTable();
  },
  "tv-bulk": (el) => tvBulk(el.dataset.bulk, el),
  "tv-toggle-active": (el) => tvAction("tv-toggle-active", el),
  "tv-delete": (el) => tvAction("tv-delete", el),
  "tv-test": (el) => tvAction("tv-test", el),
  "tv-delete-all": (el) => tvDeleteAll(el),
  "tv-sync": (el) => tvSync(el),
  "tv-import-open": () => openImportModal(),
  "tv-import-add": (el) => addImported(el.dataset.mode, el),

  "logs-refresh": () => route(),
  "logs-fetch": async (el) => {
    await busy(el, "Fetching…", async () => {
      try {
        const r = await send("/api/admin/sync-streamed", "POST");
        toast("Fetched " + plural(r.streamedCount || 0, "match", "matches"));
      } catch (error) {
        toast(error.message, "error");
      }
    });
    state.matches = null;
    route();
  },

  "app-refresh": () => refreshAppLive(),
  "app-copy-url": async () => {
    const link = (API || location.origin) + "/api/app/config";
    try {
      await navigator.clipboard.writeText(link);
      toast("Config URL copied");
    } catch (_) {
      toast(link);
    }
  },
  "settings-tab": (el) => {
    const target = $("#set-" + el.dataset.target);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  },
  "lw-add-type": () => {
    const row = $("#newType");
    const read = (key) => $('[data-new="' + key + '"]', row).value.trim();
    if (!read("name") || !read("keywords")) return toast("Give the entry a name and at least one keyword", "error");
    const wrap = document.createElement("div");
    wrap.innerHTML = '<div class="type-entry" data-type-row><input class="input" aria-label="Match type name" data-type="name"><input class="input" aria-label="Keywords" data-type="keywords"><div class="suffix-wrap"><input class="input" type="number" step="0.01" min="0.5" max="168" aria-label="Hours" data-type="hours"><span class="suffix">h</span></div><button class="icon-square" type="button" data-action="lw-remove-type" aria-label="Remove entry">' + icon("trash", 20) + "</button></div>";
    const entry = wrap.firstElementChild;
    $('[data-type="name"]', entry).value = read("name");
    $('[data-type="keywords"]', entry).value = read("keywords");
    $('[data-type="hours"]', entry).value = read("hours") || "5";
    $("#typeRows").appendChild(entry);
    $$("[data-new]", row).forEach(input => { input.value = ""; });
    toast("Entry added — save to apply");
  },
  "lw-remove-type": (el) => el.closest("[data-type-row]")?.remove(),
  "notice-swatch": (el) => {
    const form = $('form[data-submit="settings-notice"]');
    form.elements.bg.value = el.dataset.color;
    const picker = $('[data-input="notice-color"]');
    if (picker) picker.value = el.dataset.color;
    updateNoticePreview();
  },
  "notice-remove-image": (el) => {
    const form = $('form[data-submit="settings-notice"]');
    form.elements[el.dataset.field].value = "";
    $("#thumb-" + el.dataset.field)?.classList.add("hidden");
    updateNoticePreview();
  },
  "maint-fetch": async (el) => {
    await busy(el, "Fetching…", async () => {
      try {
        const r = await send("/api/admin/sync-streamed", "POST");
        toast("Fetched " + plural(r.streamedCount || 0, "match", "matches") + " · " + plural(r.resolvedCount || 0, "stream") + " resolved");
        state.matches = null;
      } catch (error) {
        toast(error.message, "error");
      }
    });
  },
  "maint-tv-sync": (el) => tvSync(el),
  "maint-cleanup": async (el) => {
    if (!confirm("Delete every match that is past its live window now?")) return;
    await busy(el, "Cleaning…", async () => {
      try {
        const r = await send("/api/admin/cleanup", "POST");
        toast(plural(r.removed || 0, "finished match", "finished matches") + " removed");
        state.matches = null;
      } catch (error) {
        toast(error.message, "error");
      }
    });
  },
  "password-reset": (el) => resetPassword(el),
  "storage-recheck": (el) => busy(el, "Checking…", loadStorageReport)
};

const SUBMITS = {
  "match-save": saveMatch,
  "stream-save": saveStreamFromModal,
  "channel-save": saveChannel,
  "tv-import": runImport,
  "password-change": changePassword,
  ...SETTINGS_SUBMIT
};

document.addEventListener("click", (event) => {
  const menu = $("#avatarMenu");
  if (!menu.classList.contains("hidden") && !event.target.closest("#avatarMenu, .avatar")) menu.classList.add("hidden");
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const name = el.dataset.action;
  if (name === "modal-backdrop") {
    if (event.target === el) closeModal();
    return;
  }
  const handler = ACTIONS[name];
  if (!handler) return;
  if (el.tagName !== "INPUT") event.preventDefault();
  handler(el, event);
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-submit]");
  if (form && SUBMITS[form.dataset.submit]) {
    event.preventDefault();
    SUBMITS[form.dataset.submit](form);
  }
});

let filterTimer = null;
document.addEventListener("input", (event) => {
  const el = event.target;
  const filter = el.dataset?.filter;
  if (filter) {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (filter === "match-q") { state.matchFilter.q = el.value; state.matchFilter.page = 1; renderMatchTable(); }
      if (filter === "match-date") { state.matchFilter.date = el.value; state.matchFilter.page = 1; renderMatchTable(); }
      if (filter === "tv-q") { state.tvFilter.q = el.value; state.tvFilter.page = 1; renderChannelTable(); }
      if (filter === "tv-category") { state.tvFilter.category = el.value; state.tvFilter.page = 1; renderChannelTable(); }
      if (filter === "tv-group") { state.tvFilter.group = el.value; state.tvFilter.page = 1; renderChannelTable(); }
      if (filter === "catalog-q" && state.streamModal) { state.streamModal.query = el.value; renderCatalog(); }
    }, filter === "match-date" || filter === "tv-category" || filter === "tv-group" ? 0 : 150);
  }
  const kind = el.dataset?.input;
  if (kind === "uk-hint") updateUkHint();
  if (kind === "thumb" || (kind === "notice-preview" && el.dataset.thumb)) {
    const thumb = $("#" + el.dataset.thumb);
    if (thumb) {
      const value = el.value.trim();
      // A saved channel logo previews through the Worker (data-saved-src);
      // anything else only when https or same-origin — http would be
      // blocked as mixed content, so the thumb just stays hidden.
      const src = el.dataset.savedSrc && value === el.dataset.savedValue ? el.dataset.savedSrc
        : /^(https:\/\/|\/)/i.test(value) ? value : "";
      thumb.classList.toggle("hidden", !src);
      if (src) thumb.src = src;
    }
  }
  if (kind === "notice-preview") updateNoticePreview();
  if (kind === "notice-color") {
    const form = $('form[data-submit="settings-notice"]');
    form.elements.bg.value = el.value;
    updateNoticePreview();
  }
});
document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset?.filter === "tv-category") { state.tvFilter.category = el.value; state.tvFilter.page = 1; renderChannelTable(); }
  if (el.dataset?.filter === "tv-group") { state.tvFilter.group = el.value; state.tvFilter.page = 1; renderChannelTable(); }
  if (el.id === "f-date") updateUkHint();
  if (el.dataset?.input === "notice-preview") updateNoticePreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if ($("#modalRoot").innerHTML) closeModal();
    document.body.classList.remove("nav-open");
    $("#avatarMenu").classList.add("hidden");
  }
});

// Drag-and-drop reordering of match streams (desktop pointer devices).
let dragFrom = null;
document.addEventListener("dragstart", (event) => {
  const row = event.target.closest?.(".stream-row");
  if (!row) return;
  dragFrom = Number(row.dataset.index);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(dragFrom));
});
document.addEventListener("dragover", (event) => {
  const row = event.target.closest?.(".stream-row");
  if (!row || dragFrom === null) return;
  event.preventDefault();
  $$(".stream-row.drag-over").forEach(r => r.classList.remove("drag-over"));
  row.classList.add("drag-over");
});
document.addEventListener("drop", (event) => {
  const row = event.target.closest?.(".stream-row");
  if (!row || dragFrom === null) return;
  event.preventDefault();
  moveStream(dragFrom, Number(row.dataset.index));
  dragFrom = null;
});
document.addEventListener("dragend", () => {
  dragFrom = null;
  $$(".stream-row.drag-over").forEach(r => r.classList.remove("drag-over"));
});

$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  login(event.currentTarget);
});
window.addEventListener("hashchange", route);

(async function boot() {
  if (!state.session) return showLogin();
  try {
    await api("/api/admin/session");
    route();
  } catch (_) {
    showLogin();
  }
})();
