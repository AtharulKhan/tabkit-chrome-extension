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

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}
export async function getSets() {
  const { sets } = await chrome.storage.local.get("sets");
  return Array.isArray(sets) ? sets : [];
}
export async function saveSets(sets) {
  await chrome.storage.local.set({ sets });
}
export async function getRenames() {
  const { renames } = await chrome.storage.local.get("renames");
  return Array.isArray(renames) ? renames : [];
}
export async function saveRenames(renames) {
  await chrome.storage.local.set({ renames });
}
// Quick tabs: favorite single sites pinned on the new tab page, optionally
// grouped. Item: { id, title, url, group }
export async function getQuickTabs() {
  const { quickTabs } = await chrome.storage.local.get("quickTabs");
  return Array.isArray(quickTabs) ? quickTabs : [];
}
export async function saveQuickTabs(quickTabs) {
  await chrome.storage.local.set({ quickTabs });
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
