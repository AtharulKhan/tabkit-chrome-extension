import { getSets, saveSets, getSettings, saveSettings, hostOf } from "./store.js";

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };
let query = "";

$("open-settings").onclick = () => chrome.runtime.openOptionsPage();
$("search").oninput = () => { query = $("search").value.trim().toLowerCase(); render(); };

function matches(set) {
  if (!query) return true;
  if (set.name.toLowerCase().includes(query)) return true;
  return set.tabs.some((t) => (t.title || "").toLowerCase().includes(query) || (t.url || "").toLowerCase().includes(query));
}

async function currentWindowId() {
  const win = await chrome.windows.getCurrent();
  return win.id;
}

async function doOpen(set, windowId, closeStrays) {
  $("switch-prompt").style.display = "none";
  const r = await chrome.runtime.sendMessage({ type: "open-set", setId: set.id, windowId, closeStrays });
  msg(r && r.ok ? `Opened "${set.name}".` : "Could not open the set.");
  render();
}

function showSwitchPrompt(set, windowId, strays) {
  const box = $("switch-prompt");
  box.innerHTML = "";
  const head = document.createElement("div");
  head.style.cssText = "font-size:15px; font-weight:650";
  head.textContent = `${strays.count} other tab${strays.count === 1 ? "" : "s"} open in this window`;
  const sub = document.createElement("div");
  sub.className = "muted";
  sub.style.marginTop = "3px";
  sub.textContent = `They are not in "${set.name}". What should happen to them?`;
  const row = document.createElement("div");
  row.style.cssText = "display:flex; gap:8px; margin-top:11px; flex-wrap:wrap";
  const mk = (label, primary, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.onclick = async () => { box.style.display = "none"; await fn(); };
    return b;
  };
  row.append(
    mk("Save them as a new set, then open", true, async () => {
      const now = new Date();
      const name = `Tabs ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      await chrome.runtime.sendMessage({ type: "save-tabs-set", name, tabIds: strays.tabs.map((t) => t.id) });
      await doOpen(set, windowId, true);
    }),
    mk("Just close them", false, () => doOpen(set, windowId, true)),
    mk("Keep them", false, () => doOpen(set, windowId, false)),
  );
  box.append(head, sub, row);
  box.style.display = "block";
  box.scrollIntoView({ block: "nearest" });
}

async function render() {
  const sets = await getSets();
  const settings = await getSettings();
  const wrap = $("sets");
  wrap.innerHTML = "";
  const shown = sets.filter(matches);
  $("count").textContent = sets.length
    ? (query ? `${shown.length} of ${sets.length} sets match` : `${sets.length} set${sets.length === 1 ? "" : "s"}`)
    : "";
  if (!sets.length) {
    wrap.innerHTML = '<div class="muted">No sets yet. Save one from the TabKit popup.</div>';
    return;
  }
  if (!shown.length) {
    wrap.innerHTML = '<div class="muted">No set matches that search.</div>';
    return;
  }
  const windowId = await currentWindowId();
  const cur = await chrome.runtime.sendMessage({ type: "window-set", windowId }).catch(() => null);
  const currentSetId = cur && cur.setId;

  for (const set of shown) {
    const pinned = set.tabs.filter((t) => t.pinned).length;
    const card = document.createElement("div");
    card.className = "card set-card";

    const top = document.createElement("div");
    top.className = "row spread";
    const h = document.createElement("h2");
    h.textContent = set.name;
    top.appendChild(h);
    if (set.id === currentSetId) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Open in this window";
      top.appendChild(badge);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${set.tabs.length} tabs · ${pinned} pinned`;

    const list = document.createElement("div");
    list.className = "tab-list";
    for (const t of set.tabs) {
      const line = document.createElement("div");
      line.className = "tab-line";
      const img = document.createElement("img");
      img.src = t.favIconUrl || `https://www.google.com/s2/favicons?domain=${hostOf(t.url)}&sz=32`;
      img.alt = "";
      const a = document.createElement("a");
      a.href = t.url;
      a.textContent = t.title || t.url;
      a.title = t.url;
      a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: t.url }); };
      line.appendChild(img);
      line.appendChild(a);
      if (t.pinned) { const p = document.createElement("span"); p.className = "pin"; p.textContent = "pinned"; line.appendChild(p); }
      list.appendChild(line);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const open = document.createElement("button");
    open.className = "primary small";
    open.textContent = "Open";
    open.onclick = async () => {
      const ex = await chrome.runtime.sendMessage({ type: "window-strays", setId: set.id, windowId }).catch(() => null);
      if (!ex || !ex.count) { await doOpen(set, windowId, false); return; }
      showSwitchPrompt(set, windowId, ex);
    };
    const newWin = document.createElement("button");
    newWin.className = "small";
    newWin.textContent = "New window";
    newWin.onclick = async () => {
      const r = await chrome.runtime.sendMessage({ type: "open-set-new-window", setId: set.id });
      msg(r && r.ok ? `Opened "${set.name}" in a new window.` : "Could not open the set.");
    };
    const upd = document.createElement("button");
    upd.className = "small";
    upd.textContent = "Update to this window";
    upd.onclick = async () => {
      const r = await chrome.runtime.sendMessage({ type: "update-set", setId: set.id, windowId });
      msg(r && r.ok ? `Updated "${set.name}" with this window's ${r.set.tabs.length} tabs.` : "Could not update the set.");
      render();
    };
    const star = document.createElement("button");
    star.className = "small";
    star.textContent = settings.startupSetId === set.id ? "Startup set ✓" : "Make startup set";
    star.onclick = async () => {
      await saveSettings({ startupSetId: settings.startupSetId === set.id ? null : set.id });
      msg("Startup set updated.");
      render();
    };
    const rename = document.createElement("button");
    rename.className = "small";
    rename.textContent = "Rename";
    rename.onclick = async () => {
      const name = window.prompt("New name for this set:", set.name);
      if (!name || !name.trim() || name.trim() === set.name) return;
      const all = await getSets();
      const target = all.find((x) => x.id === set.id);
      if (target) { target.name = name.trim(); await saveSets(all); }
      msg(`Renamed to "${name.trim()}".`);
      render();
    };
    const del = document.createElement("button");
    del.className = "danger small";
    del.textContent = "Delete";
    let armed = false;
    let armTimer = null;
    del.onclick = async () => {
      if (!armed) {
        armed = true;
        del.textContent = "Sure?";
        armTimer = setTimeout(() => { armed = false; del.textContent = "Delete"; }, 3000);
        return;
      }
      clearTimeout(armTimer);
      await saveSets((await getSets()).filter((x) => x.id !== set.id));
      if (settings.startupSetId === set.id) await saveSettings({ startupSetId: null });
      msg(`Deleted "${set.name}".`);
      render();
    };
    actions.append(open, newWin, upd, star, rename, del);
    card.append(top, meta, list, actions);
    wrap.appendChild(card);
  }
}

render();
