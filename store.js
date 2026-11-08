// TabKit shared data helpers (used by background, popup, options, newtab)
export const DEFAULT_SETTINGS = {
  newTabMode: "launcher",        // "launcher" | "url"
  newTabUrl: "",                 // any page for new tabs, e.g. chatgpt.com
  startupUrl: "",                // any page opened when Chrome starts (optional)
  discardMinutes: 10,            // idle minutes before a tab is put to sleep
  maxLoadedTabs: 15,             // hard cap on awake tabs per window (0 = off)
  discardPinned: true,           // pinned tabs may be put to sleep too
  protectAudible: true,          // tabs playing sound are never put to sleep
  sleepOnOpen: true,             // tabs opened from a set start asleep
  exceptions: [],                // domain substrings never put to sleep
  startupSetId: null,            // set opened (pinned part) at browser startup
  pinnedSetIds: [],              // sets pinned to the top of the popup for quick access
};

// ---- Where the data lives (v1.14.0) ----
// Settings, rename rules, quick tabs, and tab sets live in
// chrome.storage.sync, so they follow the user's Google sign-in to every
// Chrome profile that runs TabKit under the same pinned extension ID
// (the "key" field in manifest.json). Stats stay in chrome.storage.local:
// they change too often for sync write limits and gain nothing by syncing.
// Sync limits that shape the layout: about 100 KB total, 8 KB per item.
//   settings             -> one item
//   renames, quickTabs   -> chunked arrays (base, base#1, ... plus base$n)
//   setIndex             -> [{ id, local }] one entry per set
//   set:<id>             -> one set per item
// A set that is too big for one sync item, or saved when sync storage is
// nearly full, falls back to chrome.storage.local (localSets) and is
// flagged local:true in the index, so it still works on that machine.
const SYNC = chrome.storage.sync;
const LOCAL = chrome.storage.local;
const ITEM_SAFE = 7000;    // stay under the 8192 per-item cap
const SYNC_SOFT_CAP = 94000; // stay under the 102400 total cap

function byteSize(key, value) {
  return key.length + JSON.stringify(value).length;
}

// One-time copy of pre-v1.14 data from local storage into sync storage.
// Only fills keys that sync does not have yet, so two machines upgrading
// do not fight: the first one's data wins, the second keeps its local
// copy untouched as a backup.
let migratePromise = null;
function ensureMigrated() {
  if (!migratePromise) {
    migratePromise = (async () => {
      try {
        const { syncMigrated } = await LOCAL.get("syncMigrated");
        if (syncMigrated) return;
        const local = await LOCAL.get(["settings", "sets", "renames", "quickTabs"]);
        const syncHas = await SYNC.get(["settings", "setIndex", "renames", "quickTabs"]);
        if (local.settings && !syncHas.settings) await SYNC.set({ settings: local.settings });
        if (Array.isArray(local.renames) && local.renames.length && !syncHas.renames) await writeChunked("renames", local.renames);
        if (Array.isArray(local.quickTabs) && local.quickTabs.length && !syncHas.quickTabs) await writeChunked("quickTabs", local.quickTabs);
        if (Array.isArray(local.sets) && local.sets.length && !syncHas.setIndex) await writeSetsToSync(local.sets);
        await LOCAL.set({ syncMigrated: true });
      } catch { /* sync storage unavailable: getters still read sync area, which behaves like local when sync is off */ }
    })();
  }
  return migratePromise;
}

// Chunked arrays for values that can outgrow one sync item.
async function writeChunked(base, arr) {
  const chunks = [];
  let cur = [];
  for (const item of arr) {
    const trial = [...cur, item];
    if (cur.length && byteSize(base, trial) > ITEM_SAFE) { chunks.push(cur); cur = [item]; }
    else cur = trial;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  const countKey = base + "$n";
  const prev = await SYNC.get(countKey);
  const prevCount = prev[countKey] || 1;
  const out = { [countKey]: chunks.length };
  chunks.forEach((c, i) => { out[i === 0 ? base : `${base}#${i}`] = c; });
  await SYNC.set(out);
  const stale = [];
  for (let i = chunks.length; i < prevCount; i++) stale.push(`${base}#${i}`);
  if (stale.length) await SYNC.remove(stale);
}
async function readChunked(base) {
  const countKey = base + "$n";
  const head = await SYNC.get([base, countKey]);
  const count = head[countKey] || 1;
  let items = Array.isArray(head[base]) ? [...head[base]] : [];
  if (count > 1) {
    const keys = [];
    for (let i = 1; i < count; i++) keys.push(`${base}#${i}`);
    const rest = await SYNC.get(keys);
    for (const k of keys) if (Array.isArray(rest[k])) items = items.concat(rest[k]);
  }
  return items;
}

export async function getSettings() {
  await ensureMigrated();
  const { settings } = await SYNC.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  await SYNC.set({ settings: { ...cur, ...patch } });
}

async function writeSetsToSync(sets) {
  const all = await SYNC.get(null);
  let otherBytes = 0;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("set:") && k !== "setIndex") otherBytes += byteSize(k, v);
  }
  const oldIndex = Array.isArray(all.setIndex) ? all.setIndex : [];
  const writes = {};
  const removals = [];
  const newLocal = {};
  const newIndex = [];
  let used = otherBytes;
  for (const s of sets) {
    const key = "set:" + s.id;
    const size = byteSize(key, s);
    if (size <= ITEM_SAFE && used + size <= SYNC_SOFT_CAP) {
      writes[key] = s;
      used += size;
      newIndex.push({ id: s.id });
    } else {
      newLocal[s.id] = s;
      newIndex.push({ id: s.id, local: true });
    }
  }
  for (const e of oldIndex) {
    const key = "set:" + e.id;
    if (!(key in writes) && !e.local) removals.push(key);
  }
  writes.setIndex = newIndex;
  await SYNC.set(writes);
  if (removals.length) await SYNC.remove(removals);
  await LOCAL.set({ localSets: newLocal });
}
export async function getSets() {
  await ensureMigrated();
  const { setIndex } = await SYNC.get("setIndex");
  const index = Array.isArray(setIndex) ? setIndex : [];
  if (!index.length) return [];
  const syncKeys = index.filter((e) => !e.local).map((e) => "set:" + e.id);
  const data = syncKeys.length ? await SYNC.get(syncKeys) : {};
  let localSets = {};
  if (index.some((e) => e.local)) {
    const r = await LOCAL.get("localSets");
    localSets = r.localSets || {};
  }
  const sets = [];
  for (const e of index) {
    const s = e.local ? localSets[e.id] : data["set:" + e.id];
    if (s) sets.push(s);
  }
  return sets;
}
export async function saveSets(sets) {
  await ensureMigrated();
  await writeSetsToSync(sets);
}

export async function getRenames() {
  await ensureMigrated();
  return readChunked("renames");
}
export async function saveRenames(renames) {
  await ensureMigrated();
  await writeChunked("renames", renames);
}
// Quick tabs: favorite single sites pinned on the new tab page, optionally
// grouped. Item: { id, title, url, group }
export async function getQuickTabs() {
  await ensureMigrated();
  return readChunked("quickTabs");
}
export async function saveQuickTabs(quickTabs) {
  await ensureMigrated();
  await writeChunked("quickTabs", quickTabs);
}
export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}
// Accept anything a person would type: "chatgpt.com", "www.bbc.co.uk/news",
// or a full URL. Returns "" for empty input.
export function normalizeUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (/^(https?|chrome|about|file):/i.test(v)) return v;
  if (!v.includes(" ") && v.includes(".")) return "https://" + v;
  return "https://www.google.com/search?q=" + encodeURIComponent(v);
}
export function isSleepableUrl(url) {
  return /^https?:\/\//.test(url || "");
}
export function matchesException(url, exceptions) {
  const h = hostOf(url);
  return exceptions.some((ex) => ex && (h.includes(ex) || (url || "").includes(ex)));
}
export function findRename(renames, url) {
  // exact match wins, then domain match, newest first within each kind
  let domainHit = null;
  for (const r of renames) {
    if (r.match === "exact" && r.pattern === url) return r;
    if (r.match === "domain" && hostOf(url) === r.pattern) domainHit = domainHit || r;
  }
  return domainHit;
}
