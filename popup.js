import { getSets, hostOf } from "./store.js";

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };

async function doOpenSet(set, windowId, closeStrays) {
  $("switch-prompt").style.display = "none";
  msg(`Opening "${set.name}"…`);
  const r = await chrome.runtime.sendMessage({ type: "open-set", setId: set.id, windowId, closeStrays });
  msg(r && r.ok ? `Opened "${set.name}".` : "Could not open the set.");
  refreshStats(); refreshSets();
}

function showSwitchPrompt(set, windowId, strays) {
  const box = $("switch-prompt");
  box.innerHTML = "";
  const head = document.createElement("div");
  head.style.cssText = "font-size:13.5px; font-weight:650; margin-bottom:4px";
  head.textContent = `${strays.count} other tab${strays.count === 1 ? "" : "s"} open in this window`;
  const sub = document.createElement("div");
  sub.className = "muted";
  sub.style.fontSize = "12.5px";
  sub.textContent = `They are not in "${set.name}". What should happen to them?`;
  const list = document.createElement("div");
  list.className = "muted";
  list.style.cssText = "font-size:12px; margin-top:5px";
  list.textContent = strays.tabs.slice(0, 4).map((t) => t.title).join(" · ") + (strays.count > 4 ? ` · and ${strays.count - 4} more` : "");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.style.marginTop = "9px";
  const now = new Date();
  nameInput.value = `Tabs ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "8px";
  const saveBtn = document.createElement("button");
  saveBtn.className = "primary small";
  saveBtn.textContent = "Save as a new set";
  saveBtn.style.flex = "1";
  saveBtn.onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: "save-tabs-set", name: nameInput.value.trim() || "Saved tabs", tabIds: strays.tabs.map((t) => t.id) });
    if (!r || !r.ok) { msg("Could not save those tabs as a set."); return; }
    await doOpenSet(set, windowId, true);
  };
  const closeBtn = document.createElement("button");
  closeBtn.className = "small";
  closeBtn.textContent = "Just close them";
  closeBtn.onclick = () => doOpenSet(set, windowId, true);
  const keepBtn = document.createElement("button");
  keepBtn.className = "small";
  keepBtn.textContent = "Keep them";
  keepBtn.onclick = () => doOpenSet(set, windowId, false);
  row.append(saveBtn, closeBtn, keepBtn);
  box.append(head, sub, list, nameInput, row);
  box.style.display = "block";
  box.scrollIntoView({ block: "nearest" });
}

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
      const ex = await chrome.runtime.sendMessage({ type: "window-strays", setId: set.id, windowId: win.id }).catch(() => null);
      if (!ex || !ex.count) { await doOpenSet(set, win.id, false); return; }
      showSwitchPrompt(set, win.id, ex);
    };
    const upd = document.createElement("button");
    upd.className = "small";
    upd.textContent = "Update";
    upd.title = "Replace this set's saved tabs with this window's tabs right now";
    let armed = false;
    let armTimer = null;
    upd.onclick = async () => {
      if (!armed) {
        armed = true;
        upd.textContent = "Sure?";
        armTimer = setTimeout(() => { armed = false; upd.textContent = "Update"; }, 3000);
        msg(`Tap Sure to replace "${set.name}" with this window's tabs as they are now.`);
        return;
      }
      clearTimeout(armTimer);
      const r = await chrome.runtime.sendMessage({ type: "update-set", setId: set.id, windowId: win.id });
      msg(r && r.ok ? `Updated "${set.name}": it now holds this window's ${r.set.tabs.length} tabs.` : "Could not update the set.");
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
    actions.append(open, upd, newWin);

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

const EMOJIS = ["📊", "📈", "💰", "🧾", "📋", "✅", "📅", "📧", "💬", "📞", "🛒", "🏦", "📁", "📝", "🔍", "⚙️", "🚀", "⭐", "🔥", "❤️", "🏠", "🎓", "📚", "🎵", "📷", "🌐", "💼", "🧠", "🤖", "🐛", "🔒", "⏰", "📌", "🗂️", "✈️", "🏥", "💊", "🏋️", "🍔", "☕", "🛠️", "📦", "🚗", "💡", "🎯", "📣", "👥", "🎨"];
let selectedFavicon = null;

function paintEmojiGrid() {
  const grid = $("emoji-grid");
  grid.innerHTML = "";
  for (const e of EMOJIS) {
    const b = document.createElement("button");
    b.className = "emoji-btn" + (selectedFavicon && selectedFavicon.kind === "emoji" && selectedFavicon.value === e ? " sel" : "");
    b.textContent = e;
    b.onclick = async () => {
      selectedFavicon = { kind: "emoji", value: e };
      $("favicon-emoji").value = e;
      paintEmojiGrid();
      await saveRename();
    };
    grid.appendChild(b);
  }
}

async function saveRename() {
  const title = $("rename-input").value.trim();
  await chrome.runtime.sendMessage({ type: "rename-current", title, favicon: selectedFavicon });
  msg(title || selectedFavicon ? "Saved for this page. Name and icon stick on reload." : "Rename cleared.");
}

let emojiSaveTimer = null;
$("favicon-emoji").oninput = () => {
  const v = $("favicon-emoji").value.trim();
  selectedFavicon = v ? { kind: "emoji", value: v } : null;
  paintEmojiGrid();
  // Custom emoji typed or pasted here saves on its own, like a grid tap.
  clearTimeout(emojiSaveTimer);
  if (v) emojiSaveTimer = setTimeout(saveRename, 450);
};
$("favicon-emoji").onchange = () => {
  clearTimeout(emojiSaveTimer);
  if (selectedFavicon) saveRename();
};

$("favicon-none").onclick = async () => {
  selectedFavicon = null;
  $("favicon-emoji").value = "";
  paintEmojiGrid();
  await saveRename();
};

$("rename-save").onclick = saveRename;

$("shortcut-change").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) $("rename-input").placeholder = tab.title || "New title for this tab";
  paintEmojiGrid();
  if (tab && tab.url) {
    try {
      const rule = await chrome.runtime.sendMessage({ type: "get-rename", url: tab.url });
      if (rule) {
        if (rule.title) $("rename-input").value = rule.title;
        if (rule.favicon && rule.favicon.kind === "emoji") {
          selectedFavicon = rule.favicon;
          $("favicon-emoji").value = rule.favicon.value;
          paintEmojiGrid();
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
