// TabKit background service worker (Manifest V3, module)
// Jobs: smart tab sleeping, tab sets + pinned sets, quick switch (MRU),
// startup set restore, context menus, keyboard commands, rename lookups.
import {
  getSettings, getSets, saveSets, getRenames, saveRenames,
  uid, hostOf, isSleepableUrl, matchesException, findRename, normalizeUrl,
} from "./store.js";

/* ---------------------------------- MRU ---------------------------------- */
// Most-recently-used tab order, kept in session storage so it survives the
// service worker sleeping. Used by Alt+Q quick switch.
async function mruGet() {
  const { mru } = await chrome.storage.session.get("mru");
  return Array.isArray(mru) ? mru : [];
}
async function mruPush(tabId) {
  let mru = await mruGet();
  mru = [tabId, ...mru.filter((id) => id !== tabId)].slice(0, 50);
  await chrome.storage.session.set({ mru });
}
async function mruPrune() {
  const tabs = await chrome.tabs.query({});
  const alive = new Set(tabs.map((t) => t.id));
  const mru = (await mruGet()).filter((id) => alive.has(id));
  await chrome.storage.session.set({ mru });
}
chrome.tabs.onActivated.addListener(({ tabId }) => { mruPush(tabId); });
chrome.tabs.onRemoved.addListener(() => { mruPrune(); });

async function quickSwitch() {
  const mru = await mruGet();
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const id of mru) {
    if (active && id === active.id) continue;
    try {
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(id, { active: true });
      return;
    } catch { /* tab is gone, try the next one */ }
  }
}

/* -------------------------------- Sleeping ------------------------------- */
async function discardTab(tab) {
  if (!tab || tab.discarded || tab.active) return false;
  try { await chrome.tabs.discard(tab.id); return true; }
  catch { return false; }
}

// Create a tab already frozen (discarded). It appears in the tab strip at
// once with its title and icon, uses no memory, and loads only when the
// user clicks it. Chrome requires a title when creating a discarded tab;
// if that fails, fall back to creating it loaded and sleeping it at once.
async function createFrozen(createProps, item) {
  const favIconUrl = item.favIconUrl || `https://www.google.com/s2/favicons?domain=${hostOf(item.url)}&sz=64`;
  try {
    return await chrome.tabs.create({ ...createProps, discarded: true, title: item.title || item.url, favIconUrl });
  } catch {
    return createAsleep(createProps);
  }
}

// Create a tab and put it straight to sleep once it has started loading.
// Chrome will not discard a tab that has never committed a page, so we wait
// for the first complete (or a short timeout), then discard.
function createAsleep(createProps) {
  return new Promise((resolve) => {
    chrome.tabs.create(createProps, (tab) => {
      if (!tab) return resolve(null);
      let done = false;
      const finish = async () => {
        if (done) return; done = true;
        chrome.tabs.onUpdated.removeListener(onUpd);
        await discardTab({ id: tab.id, discarded: false, active: false });
        resolve(tab);
      };
      const onUpd = (id, info) => { if (id === tab.id && info.status === "complete") finish(); };
      chrome.tabs.onUpdated.addListener(onUpd);
      setTimeout(finish, 4000);
    });
  });
}

async function discardPass() {
  const s = await getSettings();
  const now = Date.now();
  const idleMs = Math.max(0, s.discardMinutes) * 60 * 1000;
  const tabs = await chrome.tabs.query({});
  let slept = 0;

  // Pass 1: idle timeout
  if (idleMs > 0) {
    for (const tab of tabs) {
      if (tab.active || tab.discarded) continue;
      if (tab.audible && s.protectAudible) continue;
      if (tab.pinned && !s.discardPinned) continue;
      if (!isSleepableUrl(tab.url)) continue;
      if (matchesException(tab.url, s.exceptions)) continue;
      const last = tab.lastAccessed || now;
      if (now - last >= idleMs) { if (await discardTab(tab)) slept++; }
    }
  }

  // Pass 2: per-window cap on awake tabs; sleep the longest-idle first
  if (s.maxLoadedTabs > 0) {
    const byWindow = new Map();
    for (const tab of await chrome.tabs.query({})) {
      if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
      byWindow.get(tab.windowId).push(tab);
    }
    for (const list of byWindow.values()) {
      const awake = list.filter((t) => !t.discarded && !t.active && isSleepableUrl(t.url)
        && !matchesException(t.url, s.exceptions) && (s.discardPinned || !t.pinned) && (!s.protectAudible || !t.audible))
        .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
      const awakeCount = list.filter((t) => !t.discarded).length;
      let over = awakeCount - s.maxLoadedTabs;
      for (const tab of awake) {
        if (over <= 0) break;
        if (await discardTab(tab)) { slept++; over--; }
      }
    }
  }
  if (slept) bumpSleptStat(slept);
  return slept;
}

async function bumpSleptStat(n) {
  const { stats } = await chrome.storage.local.get("stats");
  const st = stats || { sleptTotal: 0, sleptToday: 0, day: "" };
  const today = new Date().toISOString().slice(0, 10);
  if (st.day !== today) { st.day = today; st.sleptToday = 0; }
  st.sleptTotal += n; st.sleptToday += n;
  await chrome.storage.local.set({ stats: st });
}

/* ---------------------------------- Sets --------------------------------- */
// A set is a list of tabs: { url, title, pinned }.
// Opening a set in a window: tabs of the set that are already open in that
// window get pinned/unpinned to match and are left alone (no duplicates);
// missing tabs are created (asleep when sleepOnOpen is on, except we wake
// the first regular tab so the window lands somewhere alive). When the
// window was showing a different set, that set's tabs are closed first
// (set switching in one window).
async function getWindowSetMap() {
  const { winSets } = await chrome.storage.session.get("winSets");
  return winSets || {};
}
async function setWindowSet(windowId, setId) {
  const map = await getWindowSetMap();
  map[windowId] = setId;
  await chrome.storage.session.set({ winSets: map });
}

// Tabs that are not part of the incoming set: hand-opened tabs, restored
// tabs, anything the user picked up since. The launcher tab itself never
// counts (the user is usually standing on it when they pick a set).
export function strayTabs(set, tabs) {
  const ownNewtab = `chrome-extension://${chrome.runtime.id}/newtab.html`;
  const counts = new Map();
  for (const t of set.tabs) counts.set(t.url, (counts.get(t.url) || 0) + 1);
  return tabs.filter((t) => {
    if (t.url === "chrome://newtab/" || t.url === ownNewtab || t.url === "about:blank") return false;
    const c = counts.get(t.url) || 0;
    if (c > 0) { counts.set(t.url, c - 1); return false; }
    return true;
  });
}

export async function openSet(setId, windowId, { switchMode = true, onlyPinned = false, closeStrays = false } = {}) {
  const sets = await getSets();
  const found = sets.find((x) => x.id === setId);
  if (!found) return { ok: false, error: "Set not found" };
  const set = onlyPinned ? { ...found, tabs: found.tabs.filter((t) => t.pinned) } : found;
  const s = await getSettings();
  const win = windowId ? await chrome.windows.get(windowId) : await chrome.windows.getLastFocused();
  const existing = await chrome.tabs.query({ windowId: win.id });
  const map = await getWindowSetMap();
  const prevSetId = map[win.id];

  // The user was asked about stray tabs and chose to close them: every tab
  // that is not part of the incoming set goes.
  if (closeStrays) {
    for (const t of strayTabs(set, existing)) { try { await chrome.tabs.remove(t.id); } catch { /* already gone */ } }
  } else if (switchMode && prevSetId && prevSetId !== setId) {
    // Switching: close the previous set's tabs that are not part of the new set
    const prev = sets.find((x) => x.id === prevSetId);
    if (prev) {
      const keep = new Set(set.tabs.map((t) => t.url));
      const toClose = existing.filter((t) => prev.tabs.some((p) => p.url === t.url) && !keep.has(t.url));
      for (const t of toClose) { try { await chrome.tabs.remove(t.id); } catch { /* already gone */ } }
    }
  }

  const nowTabs = await chrome.tabs.query({ windowId: win.id });
  const byUrl = new Map(nowTabs.map((t) => [t.url, t]));
  const toCreate = [];
  for (const item of set.tabs) {
    const found = byUrl.get(item.url);
    if (found) {
      if (!!found.pinned !== !!item.pinned) {
        try { await chrome.tabs.update(found.id, { pinned: !!item.pinned }); } catch { /* ignore */ }
      }
      continue;
    }
    toCreate.push(item);
  }
  // The window lands on the set's first pinned tab (or its first tab):
  // that one loads for real. Every other new tab is created frozen, all at
  // once, so the strip fills instantly and nothing loads in the background.
  const landingItem = set.tabs.find((t) => t.pinned) || set.tabs[0] || null;
  await Promise.all(toCreate.map(async (item) => {
    const props = { windowId: win.id, url: item.url, pinned: !!item.pinned, active: false };
    if (s.sleepOnOpen && (!landingItem || item.url !== landingItem.url)) {
      await createFrozen(props, item);
    } else {
      await chrome.tabs.create(props);
    }
  }));
  const opened = toCreate.length;
  if (landingItem) {
    const finalTabs = await chrome.tabs.query({ windowId: win.id });
    const land = finalTabs.find((t) => t.url === landingItem.url);
    if (land && !land.active) { try { await chrome.tabs.update(land.id, { active: true }); } catch { /* ignore */ } }
  }
  await setWindowSet(win.id, setId);
  return { ok: true, opened, name: set.name };
}

async function saveWindowAsSet(name, windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const items = tabs.filter((t) => isSleepableUrl(t.url) || t.pinned)
    .map((t) => ({ url: t.url, title: t.title || t.url, pinned: !!t.pinned, favIconUrl: t.favIconUrl || "" }));
  const sets = await getSets();
  const set = { id: uid(), name: name || "My set", tabs: items, createdAt: Date.now() };
  sets.push(set);
  await saveSets(sets);
  await setWindowSet(windowId, set.id);
  return set;
}

/* ------------------------------- Startup --------------------------------- */
async function restoreStartupSet() {
  const s = await getSettings();
  if (!s.startupSetId) return;
  const sets = await getSets();
  const set = sets.find((x) => x.id === s.startupSetId);
  if (!set) return;
  // Only the pinned part is restored at startup (that is the Save Pinned
  // Tabs job). It lands asleep so startup stays light.
  await openSet(s.startupSetId, undefined, { switchMode: false, onlyPinned: true });
}
// Optional: open any page the user picked (for example chatgpt.com) when
// Chrome starts. Extensions cannot set Chrome's own startup pages setting,
// so TabKit opens it itself, once, in the first window.
async function openStartupPage() {
  const s = await getSettings();
  const url = normalizeUrl(s.startupUrl);
  if (!url) return;
  const tryOpen = async () => {
    const wins = await chrome.windows.getAll();
    if (!wins.length) return false;
    await chrome.tabs.create({ windowId: wins[0].id, url, active: true });
    return true;
  };
  try { if (!(await tryOpen())) setTimeout(tryOpen, 3000); }
  catch { setTimeout(tryOpen, 3000); }
}
chrome.runtime.onStartup.addListener(() => { restoreStartupSet(); openStartupPage(); });

/* ----------------------------- Context menus ------------------------------ */
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    const parent = chrome.contextMenus.create({ id: "tabkit", title: "TabKit", contexts: ["action"] });
    void parent;
    chrome.contextMenus.create({ id: "sleep-tab", title: "Sleep this tab", contexts: ["action"] });
    chrome.contextMenus.create({ id: "sleep-others", title: "Sleep all other tabs in this window", contexts: ["action"] });
    chrome.contextMenus.create({ id: "sleep-window", title: "Sleep every inactive tab", contexts: ["action"] });
    chrome.contextMenus.create({ id: "quick-switch", title: "Switch to previous tab (Alt+Q)", contexts: ["action"] });
  });
}
chrome.runtime.onInstalled.addListener(() => {
  buildMenus();
  chrome.alarms.create("discard-pass", { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("discard-pass", { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "discard-pass") discardPass(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "sleep-tab" && tab) {
    // Cannot discard the active tab; move to the previous tab first.
    await quickSwitch();
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    if (fresh) await discardTab(fresh);
  } else if (info.menuItemId === "sleep-others" && tab) {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    for (const t of tabs) if (t.id !== tab.id) await discardTab(t);
  } else if (info.menuItemId === "sleep-window") {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (!t.active) await discardTab(t);
  } else if (info.menuItemId === "quick-switch") {
    quickSwitch();
  }
});

/* ------------------------------- Commands --------------------------------- */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "quick-switch") { quickSwitch(); return; }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  if (command === "discard-tab") {
    await quickSwitch();
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    if (fresh) await discardTab(fresh);
  } else if (command === "discard-others") {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    for (const t of tabs) if (t.id !== tab.id) await discardTab(t);
  } else if (command === "rename-tab") {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (current) => window.prompt("Rename this tab (clear to reset):", current),
        args: [tab.title || ""],
      });
      if (res && typeof res.result === "string") {
        await applyRename(tab, res.result.trim());
      }
    } catch { /* page does not allow injection */ }
  }
});

async function applyRename(tab, title, favicon) {
  const renames = await getRenames();
  const existing = renames.find((r) => r.match === "exact" && r.pattern === tab.url);
  const filtered = renames.filter((r) => !(r.match === "exact" && r.pattern === tab.url));
  // favicon undefined means keep the one already on the rule, null clears it.
  const fav = favicon === undefined ? (existing && existing.favicon) || null : favicon;
  if (title || fav) {
    const rule = { id: uid(), match: "exact", pattern: tab.url, title: title || "" };
    if (fav) rule.favicon = fav;
    filtered.unshift(rule);
  }
  await saveRenames(filtered);
  if (title) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (t) => { document.title = t; },
        args: [title],
      });
    } catch { /* ignore */ }
  }
}

/* ------------------------------- Messages --------------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "get-rename": {
          const renames = await getRenames();
          const hit = findRename(renames, msg.url);
          sendResponse({ title: hit ? hit.title || null : null, favicon: hit ? hit.favicon || null : null });
          break;
        }
        case "open-set": {
          const r = await openSet(msg.setId, msg.windowId, { switchMode: msg.switchMode !== false, closeStrays: !!msg.closeStrays });
          sendResponse(r);
          break;
        }
        case "window-strays": {
          const sets = await getSets();
          const set = sets.find((x) => x.id === msg.setId);
          if (!set) { sendResponse({ count: 0, tabs: [] }); break; }
          const tabs = await chrome.tabs.query({ windowId: msg.windowId });
          const strays = strayTabs(set, tabs);
          sendResponse({ count: strays.length, tabs: strays.map((t) => ({ id: t.id, title: t.title || t.url, url: t.url })) });
          break;
        }
        case "save-tabs-set": {
          const items = [];
          for (const id of msg.tabIds || []) {
            const t = await chrome.tabs.get(id).catch(() => null);
            if (t && (isSleepableUrl(t.url) || t.pinned)) items.push({ url: t.url, title: t.title || t.url, pinned: !!t.pinned, favIconUrl: t.favIconUrl || "" });
          }
          if (!items.length) { sendResponse({ ok: false, error: "Nothing to save" }); break; }
          const sets = await getSets();
          const set = { id: uid(), name: msg.name || "Saved tabs", tabs: items, createdAt: Date.now() };
          sets.push(set);
          await saveSets(sets);
          sendResponse({ ok: true, set });
          break;
        }
        case "open-set-new-window": {
          const sets = await getSets();
          const set = sets.find((x) => x.id === msg.setId);
          if (!set || !set.tabs.length) { sendResponse({ ok: false, error: "Set is empty" }); break; }
          const win = await chrome.windows.create({ url: set.tabs[0].url, focused: true });
          const r = await openSet(msg.setId, win.id, { switchMode: false });
          sendResponse(r);
          break;
        }
        case "window-set": {
          const map = await getWindowSetMap();
          sendResponse({ setId: map[msg.windowId] || null });
          break;
        }
        case "save-set": {
          const set = await saveWindowAsSet(msg.name, msg.windowId);
          sendResponse({ ok: true, set });
          break;
        }
        case "sleep-now": {
          const tabs = await chrome.tabs.query(msg.allWindows ? {} : { windowId: msg.windowId });
          let n = 0;
          for (const t of tabs) if (!t.active && (await discardTab(t))) n++;
          if (n) bumpSleptStat(n);
          sendResponse({ ok: true, slept: n });
          break;
        }
        case "sleep-tab": {
          const t = await chrome.tabs.get(msg.tabId).catch(() => null);
          sendResponse({ ok: !!(t && (await discardTab(t))) });
          break;
        }
        case "quick-switch": { await quickSwitch(); sendResponse({ ok: true }); break; }
        case "discard-pass": { const n = await discardPass(); sendResponse({ ok: true, slept: n }); break; }
        case "rename-current": {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab) {
            await applyRename(tab, (msg.title || "").trim(), msg.favicon);
            // Inject the renamer fresh so the new name and icon land even on a
            // tab that was opened before the extension was (re)loaded.
            try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["renamer.js"] }); } catch { /* page does not allow injection */ }
          }
          sendResponse({ ok: true });
          break;
        }
        default: sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // async response
});
