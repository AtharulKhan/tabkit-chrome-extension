import { getSettings, saveSettings, getSets, saveSets, getRenames, saveRenames, getQuickTabs, saveQuickTabs, uid } from "./store.js";

const $ = (id) => document.getElementById(id);
const msg = (t) => { $("msg").textContent = t || ""; };

async function renderSets() {
  const sets = await getSets();
  const settings = await getSettings();
  const list = $("set-list");
  list.innerHTML = sets.length ? "" : '<div class="muted" style="font-size:13px">No sets yet. Arrange a window, name it below, save it.</div>';
  for (const set of sets) {
    const pinned = set.tabs.filter((t) => t.pinned).length;
    const row = document.createElement("div");
    row.className = "set-row";
    const top = document.createElement("div");
    top.className = "row spread";
    const name = document.createElement("strong");
    name.textContent = set.name;
    const counts = document.createElement("span");
    counts.className = "muted";
    counts.style.fontSize = "12px";
    counts.textContent = `${set.tabs.length} tabs · ${pinned} pinned`;
    top.append(name, counts);
    const names = document.createElement("div");
    names.className = "names";
    names.textContent = set.tabs.slice(0, 4).map((t) => t.title || t.url).join(" · ") + (set.tabs.length > 4 ? ` · +${set.tabs.length - 4} more` : "");
    const actions = document.createElement("div");
    actions.className = "row";
    actions.style.marginTop = "6px";
    const open = document.createElement("button");
    open.className = "primary small"; open.textContent = "Open";
    open.onclick = async () => {
      const win = await chrome.windows.getLastFocused();
      const r = await chrome.runtime.sendMessage({ type: "open-set", setId: set.id, windowId: win.id });
      msg(r && r.ok ? `Opened "${set.name}".` : "Could not open the set.");
    };
    const star = document.createElement("button");
    star.className = "small";
    star.textContent = settings.startupSetId === set.id ? "Startup set ✓" : "Make startup set";
    star.onclick = async () => {
      await saveSettings({ startupSetId: settings.startupSetId === set.id ? null : set.id });
      msg("Startup set updated.");
      renderSets();
    };
    const del = document.createElement("button");
    del.className = "danger small"; del.textContent = "Delete";
    del.onclick = async () => {
      await saveSets((await getSets()).filter((s) => s.id !== set.id));
      if (settings.startupSetId === set.id) await saveSettings({ startupSetId: null });
      msg(`Deleted "${set.name}".`);
      renderSets();
    };
    actions.append(open, star, del);
    row.append(top, names, actions);
    list.appendChild(row);
  }
}

async function renderRenames() {
  const renames = await getRenames();
  const list = $("rename-list");
  list.innerHTML = renames.length ? "" : '<div class="muted" style="font-size:12.5px">No rename rules yet. Rename from the popup, or add one here.</div>';
  for (const r of renames) {
    const line = document.createElement("div");
    line.className = "rename-line";
    const pat = document.createElement("span"); pat.textContent = r.pattern; pat.style.flex = "1";
    const title = document.createElement("strong"); title.textContent = r.title || "(icon only)";
    if (r.favicon) {
      const mark = document.createElement("span");
      if (r.favicon.kind === "emoji") { mark.textContent = r.favicon.value; }
      else if (r.favicon.kind === "badge") {
        mark.textContent = (r.favicon.letter || "?").slice(0, 1).toUpperCase();
        mark.style.cssText = `background:${r.favicon.color}; color:#fff; border-radius:5px; padding:1px 5px; font-size:11px; font-weight:700`;
      } else { mark.textContent = "🖼"; }
      line.appendChild(mark);
    }
    const del = document.createElement("button");
    del.className = "danger small"; del.textContent = "Delete";
    del.onclick = async () => {
      await saveRenames((await getRenames()).filter((x) => x.id !== r.id));
      renderRenames();
    };
    line.append(pat, title, del);
    list.appendChild(line);
  }
}

async function loadSettings() {
  const s = await getSettings();
  $("discard-minutes").value = s.discardMinutes;
  $("discard-pinned").checked = !!s.discardPinned;
  $("sleep-on-open").checked = !!s.sleepOnOpen;
  $("protect-audible").checked = s.protectAudible !== false;
  $("newtab-mode").value = s.newTabMode;
  $("newtab-url").value = s.newTabUrl || "";
  $("startup-url").value = s.startupUrl || "";
  $("exceptions-text").value = (s.exceptions || []).join(", ");
}

$("save-window-set").onclick = async () => {
  const name = $("new-set-name").value.trim();
  if (!name) { msg("Give the set a name first."); return; }
  const win = await chrome.windows.getLastFocused();
  const r = await chrome.runtime.sendMessage({ type: "save-set", name, windowId: win.id });
  msg(r && r.ok ? `Saved "${name}" with ${r.set.tabs.length} tabs.` : "Could not save.");
  $("new-set-name").value = "";
  renderSets();
};

$("rename-add").onclick = async () => {
  const pattern = $("rename-pattern").value.trim();
  const title = $("rename-title").value.trim();
  const emoji = $("rename-emoji").value.trim();
  const color = $("rename-color").value;
  if (!pattern || (!title && !emoji && !color)) { msg("A rename rule needs the site, plus a title or an icon."); return; }
  const match = pattern.includes("://") ? "exact" : "domain";
  let favicon = null;
  if (emoji) favicon = { kind: "emoji", value: emoji };
  else if (color) favicon = { kind: "badge", color, letter: (title.match(/[a-z0-9]/i) || ["?"])[0].toUpperCase() };
  const rule = { id: uid(), match, pattern, title };
  if (favicon) rule.favicon = favicon;
  const renames = await getRenames();
  renames.unshift(rule);
  await saveRenames(renames);
  $("rename-pattern").value = ""; $("rename-title").value = ""; $("rename-emoji").value = ""; $("rename-color").value = "";
  msg("Rename rule added.");
  renderRenames();
};

$("save-all").onclick = async () => {
  await saveSettings({
    discardMinutes: Math.max(0, parseInt($("discard-minutes").value || "0", 10)),
    discardPinned: $("discard-pinned").checked,
    sleepOnOpen: $("sleep-on-open").checked,
    protectAudible: $("protect-audible").checked,
    newTabMode: $("newtab-mode").value,
    newTabUrl: $("newtab-url").value.trim(),
    startupUrl: $("startup-url").value.trim(),
    exceptions: $("exceptions-text").value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean),
  });
  msg("Options saved.");
};

$("export-btn").onclick = async () => {
  const data = await chrome.storage.local.get(["settings", "sets", "renames", "quickTabs"]);
  const backup = {
    app: "TabKit",
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    settings: data.settings || {},
    sets: data.sets || [],
    renames: data.renames || [],
    quickTabs: data.quickTabs || [],
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tabkit-setup.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  msg("Setup exported: settings, sets, rename rules with their icons, and quick tabs in one file.");
};

$("import-btn").onclick = () => $("import-file").click();
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || parsed.app !== "TabKit") throw new Error("not a TabKit file");
    if (parsed.settings) await saveSettings(parsed.settings);
    if (Array.isArray(parsed.sets)) await saveSets(parsed.sets);
    if (Array.isArray(parsed.renames)) await saveRenames(parsed.renames);
    if (Array.isArray(parsed.quickTabs)) await saveQuickTabs(parsed.quickTabs);
    msg("Setup imported. This browser now matches the file, icons included.");
    await loadSettings();
    await renderSets();
    await renderRenames();
  } catch {
    msg("That file could not be imported. Pick a tabkit-setup.json file exported from TabKit.");
  }
  e.target.value = "";
});

(async () => { await loadSettings(); await renderSets(); await renderRenames(); })();
