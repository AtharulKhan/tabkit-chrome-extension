import { getSets, hostOf } from "./store.js";

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };

async function refreshStats() {
  const tabs = await chrome.tabs.query({});
  const awake = tabs.filter((t) => !t.discarded).length;
  const asleep = tabs.length - awake;
  $("awake-count").textContent = `${awake} awake · ${asleep} asleep`;
  $("bar").style.width = tabs.length ? `${Math.round((asleep / tabs.length) * 100)}%` : "0%";
  const { stats } = await chrome.storage.local.get("stats");
  const today = new Date().toISOString().slice(0, 10);
  const n = stats && stats.day === today ? stats.sleptToday : 0;
  $("slept-today").textContent = `${n} put to sleep today`;
}

async function refreshSets() {
  const sets = await getSets();
  const wrap = $("sets");
  wrap.innerHTML = "";
  if (!sets.length) {
    wrap.innerHTML = '<div class="muted" style="padding:2px 0 6px">No sets yet. Arrange a window, name it below, and save it. Sets you save show up here, one click to open.</div>';
    return;
  }
  const win = await chrome.windows.getLastFocused();
  const cur = await chrome.runtime.sendMessage({ type: "window-set", windowId: win.id }).catch(() => null);
  const currentSetId = cur && cur.setId;
  for (const set of sets) {
    const pinned = set.tabs.filter((t) => t.pinned).length;
    const card = document.createElement("div");
    card.className = "card set-card";

    const top = document.createElement("div");
    top.className = "row spread";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = set.name;
    top.appendChild(name);
    if (set.id === currentSetId) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Open in this window";
      top.appendChild(badge);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${set.tabs.length} tabs · ${pinned} pinned`;

    const favs = document.createElement("div");
    favs.className = "favicons";
    for (const t of set.tabs.slice(0, 8)) {
      const img = document.createElement("img");
      img.src = `https://www.google.com/s2/favicons?domain=${hostOf(t.url)}&sz=32`;
      img.alt = "";
      favs.appendChild(img);
    }

    const actions = document.createElement("div");
    actions.className = "row";
    actions.style.marginTop = "9px";
    const open = document.createElement("button");
    open.className = "primary small";
    open.textContent = "Open";
    open.style.flex = "1";
    open.onclick = async () => {
      msg(`Opening "${set.name}"…`);
      const r = await chrome.runtime.sendMessage({ type: "open-set", setId: set.id, windowId: win.id });
      msg(r && r.ok ? `Opened "${set.name}".` : "Could not open the set.");
      refreshStats(); refreshSets();
    };
    const newWin = document.createElement("button");
    newWin.className = "small";
    newWin.textContent = "New window";
    newWin.onclick = async () => {
      msg(`Opening "${set.name}" in a new window…`);
      const r = await chrome.runtime.sendMessage({ type: "open-set-new-window", setId: set.id });
      msg(r && r.ok ? `Opened "${set.name}" in a new window.` : "Could not open the set.");
    };
    actions.append(open, newWin);

    card.append(top, meta, favs, actions);
    wrap.appendChild(card);
  }
}

$("open-options").onclick = () => chrome.runtime.openOptionsPage();

$("sleep-inactive").onclick = async () => {
  const win = await chrome.windows.getLastFocused();
  const r = await chrome.runtime.sendMessage({ type: "sleep-now", windowId: win.id });
  msg(r && r.ok ? `Put ${r.slept} tabs to sleep.` : "Nothing to sleep.");
  refreshStats();
};

$("sleep-others").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  let n = 0;
  for (const t of tabs) {
    if (t.id === tab.id || t.discarded) continue;
    const r = await chrome.runtime.sendMessage({ type: "sleep-tab", tabId: t.id });
    if (r && r.ok) n++;
  }
  msg(`Put ${n} tabs to sleep.`);
  refreshStats();
};

$("save-set-btn").onclick = async () => {
  const name = $("set-name").value.trim();
  if (!name) { msg("Give the set a name first."); return; }
  const win = await chrome.windows.getLastFocused();
  const r = await chrome.runtime.sendMessage({ type: "save-set", name, windowId: win.id });
  msg(r && r.ok ? `Saved "${name}" with ${r.set.tabs.length} tabs.` : "Could not save the set.");
  $("set-name").value = "";
  refreshSets();
};

const FAV_COLORS = ["#C15F3C", "#3E7C4F", "#2F5D8A", "#6B4E9E", "#B07D2B", "#2E7D74", "#A63A3A", "#6E6A5E"];
let selectedFavicon = null;

function paintSwatches() {
  const wrap = $("swatches");
  wrap.innerHTML = "";
  for (const color of FAV_COLORS) {
    const b = document.createElement("button");
    b.className = "swatch" + (selectedFavicon && selectedFavicon.kind === "badge" && selectedFavicon.color === color ? " sel" : "");
    b.style.background = color;
    b.title = "Colour badge";
    b.onclick = () => {
      selectedFavicon = { kind: "badge", color };
      $("favicon-emoji").value = "";
      paintSwatches();
    };
    wrap.appendChild(b);
  }
}

$("favicon-emoji").oninput = () => {
  const v = $("favicon-emoji").value.trim();
  selectedFavicon = v ? { kind: "emoji", value: v } : null;
  if (v) paintSwatches();
};

$("favicon-none").onclick = () => {
  selectedFavicon = null;
  $("favicon-emoji").value = "";
  paintSwatches();
};

$("rename-save").onclick = async () => {
  const title = $("rename-input").value.trim();
  let favicon = selectedFavicon;
  if (favicon && favicon.kind === "badge") {
    const letter = (title.match(/[a-z0-9]/i) || ["?"])[0].toUpperCase();
    favicon = { kind: "badge", color: favicon.color, letter };
  }
  await chrome.runtime.sendMessage({ type: "rename-current", title, favicon });
  msg(title || favicon ? "Saved for this page. It will keep this name and icon on reload." : "Rename cleared.");
};

$("shortcut-change").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) $("rename-input").placeholder = tab.title || "New title for this tab";
  paintSwatches();
  if (tab && tab.url) {
    try {
      const rule = await chrome.runtime.sendMessage({ type: "get-rename", url: tab.url });
      if (rule) {
        if (rule.title) $("rename-input").value = rule.title;
        if (rule.favicon) {
          selectedFavicon = rule.favicon;
          if (rule.favicon.kind === "emoji") $("favicon-emoji").value = rule.favicon.value;
          paintSwatches();
        }
      }
    } catch { /* no rule yet */ }
  }
  try {
    const cmds = await chrome.commands.getAll();
    const qs = cmds.find((c) => c.name === "quick-switch");
    $("shortcut-note").textContent = `Quick switch: ${qs && qs.shortcut ? qs.shortcut : "not set"}`;
  } catch { $("shortcut-note").textContent = "Quick switch"; }
  await refreshStats();
  await refreshSets();
})();
