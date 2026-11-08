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
//   setIndex             -> [{ id, chunks }] one entry per set
//   set:<id>             -> the set; for a big set this is the head item
//                           (all fields, tabs held in chunk items)
//   set:<id>#<i>         -> tab chunks for a big set, each under the cap
// A set only falls back to chrome.storage.local (localSets, flagged
// local:true in the index) when sync storage itself is nearly full.
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
        if (!syncMigrated) {
          const local = await LOCAL.get(["settings", "sets", "renames", "quickTabs"]);
          const syncHas = await SYNC.get(["settings", "setIndex", "renames", "quickTabs"]);
          if (local.settings && !syncHas.settings) await SYNC.set({ settings: local.settings });
          if (Array.isArray(local.renames) && local.renames.length && !syncHas.renames) await writeChunked("renames", local.renames);
          if (Array.isArray(local.quickTabs) && local.quickTabs.length && !syncHas.quickTabs) await writeChunked("quickTabs", local.quickTabs);
          if (Array.isArray(local.sets) && local.sets.length && !syncHas.setIndex) await writeSetsToSync(local.sets);
          await LOCAL.set({ syncMigrated: true });
        }
        // Repack (v1.14.1, re-run by v1.14.2 with favicon sanitizing):
        // sets parked in local storage for size are rewritten into sync
        // storage in chunks, so they sync.
        const { syncRepack142 } = await LOCAL.get("syncRepack142");
        if (!syncRepack142) {
          const { setIndex } = await SYNC.get("setIndex");
          if (Array.isArray(setIndex) && setIndex.some((e) => e.local)) {
            const all = await readAllSetsRaw();
            if (all.length) await writeSetsToSync(all);
          }
          await LOCAL.set({ syncRepack142: true });
        }
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

// Some sites hand out favicons as data: URLs, which can be several KB
// each and bloat a set past every sync limit (one real 12-tab set was
// 35 KB, a single tab 7.4 KB). For syncing, swap a data: favicon for
// the small web favicon for the same site. Titles, URLs and pinned
// flags are never touched.
function sanitizeSetForSync(s) {
  const tabs = (s.tabs || []).map((t) => {
    if (t.favIconUrl && t.favIconUrl.startsWith("data:")) {
      let fav = "";
      try { fav = "https://www.google.com/s2/favicons?domain=" + new URL(t.url).hostname + "&sz=64"; } catch { fav = ""; }
      return { ...t, favIconUrl: fav };
    }
    return t;
  });
  return { ...s, tabs };
}

// Plan the sync items for one set. A set that fits in one item is stored
// whole. A bigger set is split: a head item with every field except the
// tabs, plus one item per chunk of tabs. Returns null when even a single
// tab cannot fit an item (a safety net; with favicons sanitized this
// should not happen in real use).
function planSetItems(s) {
  const headKey = "set:" + s.id;
  if (byteSize(headKey, s) <= ITEM_SAFE) return [{ key: headKey, value: s }];
  const { tabs, ...rest } = s;
  const list = tabs || [];
  for (const t of list) {
    if (byteSize(headKey + "#0", { tabs: [t] }) > ITEM_SAFE) return null;
  }
  const chunks = [];
  let cur = [];
  for (const t of list) {
    const trial = [...cur, t];
    if (cur.length && byteSize(headKey + "#0", { tabs: trial }) > ITEM_SAFE) { chunks.push(cur); cur = [t]; }
    else cur = trial;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  const head = { ...rest, tabs: [], tabChunks: chunks.length };
  if (byteSize(headKey, head) > ITEM_SAFE) return null;
  const items = [{ key: headKey, value: head }];
  chunks.forEach((c, i) => items.push({ key: `${headKey}#${i}`, value: { tabs: c } }));
  return items;
}

async function writeSetsToSync(sets) {
  const all = await SYNC.get(null);
  let otherBytes = 0;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("set:") && k !== "setIndex") otherBytes += byteSize(k, v);
  }
  const oldIndex = Array.isArray(all.setIndex) ? all.setIndex : [];
  const writes = {};
  const newLocal = {};
  const newIndex = [];
  const plannedKeys = new Set();
  let used = otherBytes;
  for (const s of sets) {
    const clean = sanitizeSetForSync(s);
    const items = planSetItems(clean);
    const total = items ? items.reduce((n, it) => n + byteSize(it.key, it.value), 0) : Infinity;
    if (items && used + total <= SYNC_SOFT_CAP) {
      for (const it of items) { writes[it.key] = it.value; plannedKeys.add(it.key); }
      used += total;
      newIndex.push({ id: clean.id, chunks: items.length - 1 });
    } else {
      newLocal[clean.id] = clean;
      newIndex.push({ id: clean.id, local: true });
    }
  }
  const removals = [];
  for (const e of oldIndex) {
    if (e.local) continue;
    const oldKeys = ["set:" + e.id];
    for (let i = 0; i < (e.chunks || 0); i++) oldKeys.push(`set:${e.id}#${i}`);
    for (const k of oldKeys) if (!plannedKeys.has(k)) removals.push(k);
  }
  writes.setIndex = newIndex;
  await SYNC.set(writes);
  if (removals.length) await SYNC.remove(removals);
  await LOCAL.set({ localSets: newLocal });
}

// Reads every set from storage without running the migration first, so
// the migration itself can use it. Handles all layouts: single item,
// chunked, and the v1.14.0 local fallback.
async function readAllSetsRaw() {
  const { setIndex } = await SYNC.get("setIndex");
  const index = Array.isArray(setIndex) ? setIndex : [];
  if (!index.length) return [];
  const headKeys = index.filter((e) => !e.local).map((e) => "set:" + e.id);
  const heads = headKeys.length ? await SYNC.get(headKeys) : {};
  let localSets = {};
  if (index.some((e) => e.local)) {
    const r = await LOCAL.get("localSets");
    localSets = r.localSets || {};
  }
  const sets = [];
  for (const e of index) {
    if (e.local) {
      const s = localSets[e.id];
      if (s) sets.push(s);
      continue;
    }
    const head = heads["set:" + e.id];
    if (!head) continue;
    if (head.tabChunks) {
      const keys = [];
      for (let i = 0; i < head.tabChunks; i++) keys.push(`set:${e.id}#${i}`);
      const parts = await SYNC.get(keys);
      let tabs = [];
      for (const k of keys) if (parts[k] && Array.isArray(parts[k].tabs)) tabs = tabs.concat(parts[k].tabs);
      const { tabChunks, ...rest } = head;
      sets.push({ ...rest, tabs });
    } else {
      sets.push(head);
    }
  }
  return sets;
}
export async function getSets() {
  await ensureMigrated();
  return readAllSetsRaw();
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
