import { getSettings, getSets, getQuickTabs, saveQuickTabs, hostOf, normalizeUrl, uid } from "./store.js";

// redirect.js (loaded in the head) makes the redirect call first. This is
// the safety net: if we are still here and a redirect page is set, go.
async function init() {
  const s = await getSettings();
  if (s.newTabMode === "url" && s.newTabUrl) {
    location.replace(normalizeUrl(s.newTabUrl));
    return;
  }
  document.documentElement.classList.add("tk-launcher");

  const tick = () => {
    const now = new Date();
    document.getElementById("clock").textContent =
      now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, "");
    document.getElementById("date").textContent =
      now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  };
  tick();
  setInterval(tick, 15000);

  document.getElementById("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("search").value.trim();
    if (!q) return;
    const looksLikeUrl = /^https?:\/\//.test(q) || (!q.includes(" ") && q.includes("."));
    location.href = looksLikeUrl
      ? (q.startsWith("http") ? q : `https://${q}`)
      : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  });

  // Live results from open tabs, bookmarks, and history as you type.
  const input = document.getElementById("search");
  const results = document.getElementById("results");
  let searchTimer = null;
  const hitRow = (item) => {
    const row = document.createElement("div");
    row.className = "hit";
    const img = document.createElement("img");
    img.src = `https://www.google.com/s2/favicons?domain=${hostOf(item.url)}&sz=32`;
    img.alt = "";
    const t = document.createElement("span");
    t.className = "t"; t.textContent = item.title || item.url;
    const u = document.createElement("span");
    u.className = "u"; u.textContent = hostOf(item.url);
    row.append(img, t, u);
    row.onclick = item.onOpen;
    return row;
  };
  const groupLabel = (text) => {
    const g = document.createElement("div");
    g.className = "group"; g.textContent = text;
    return g;
  };
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = input.value.trim().toLowerCase();
      results.innerHTML = "";
      if (q.length < 2) { results.style.display = "none"; return; }
      let shown = 0;
      try {
        const tabs = await chrome.tabs.query({});
        const hits = tabs.filter((t) => (t.title || "").toLowerCase().includes(q) || (t.url || "").toLowerCase().includes(q)).slice(0, 5);
        if (hits.length) {
          results.appendChild(groupLabel("Open tabs"));
          for (const t of hits) {
            results.appendChild(hitRow({ title: t.title, url: t.url, onOpen: async () => {
              await chrome.windows.update(t.windowId, { focused: true });
              await chrome.tabs.update(t.id, { active: true });
            } }));
            shown++;
          }
        }
      } catch { /* tabs unavailable */ }
      try {
        const bms = await chrome.bookmarks.search(q);
        const hits = bms.filter((b) => b.url).slice(0, 6);
        if (hits.length) {
          results.appendChild(groupLabel("Bookmarks"));
          for (const b of hits) {
            results.appendChild(hitRow({ title: b.title, url: b.url, onOpen: () => { location.href = b.url; } }));
            shown++;
          }
        }
      } catch { /* bookmarks unavailable */ }
      try {
        const hist = await chrome.history.search({ text: q, maxResults: 6 });
        if (hist.length) {
          results.appendChild(groupLabel("History"));
          for (const h of hist) {
            results.appendChild(hitRow({ title: h.title, url: h.url, onOpen: () => { location.href = h.url; } }));
            shown++;
          }
        }
      } catch { /* history unavailable */ }
      results.style.display = shown ? "block" : "none";
    }, 130);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { results.style.display = "none"; }
  });

  // Quick tabs: favorite sites, grouped, one click to open, "Open all"
  // opens a whole group frozen except the first.
  const quickArea = document.getElementById("quick-area");
  async function renderQuickTabs() {
    const items = await getQuickTabs();
    quickArea.innerHTML = "";
    const groups = new Map();
    for (const it of items) {
      const g = (it.group || "").trim();
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    const renderGroup = (groupName, list) => {
      const head = document.createElement("div");
      head.className = "section-head";
      head.style.marginTop = quickArea.children.length ? "22px" : "4px";
      const label = document.createElement("span");
      label.textContent = groupName || "Quick tabs";
      head.appendChild(label);
      if (list.length > 1) {
        const openAll = document.createElement("button");
        openAll.className = "small";
        openAll.textContent = "Open all";
        openAll.onclick = async () => {
          const win = await chrome.windows.getLastFocused();
          let first = null;
          for (const [i, it] of list.entries()) {
            if (i === 0) {
              first = await chrome.tabs.create({ windowId: win.id, url: it.url, active: true });
            } else {
              try {
                await chrome.tabs.create({ windowId: win.id, url: it.url, active: false, discarded: true, title: it.title || it.url, favIconUrl: `https://www.google.com/s2/favicons?domain=${hostOf(it.url)}&sz=64` });
              } catch { await chrome.tabs.create({ windowId: win.id, url: it.url, active: false }); }
            }
          }
          const self = await chrome.tabs.getCurrent();
          if (self && first) { try { await chrome.tabs.remove(self.id); } catch { /* ignore */ } }
        };
        head.appendChild(openAll);
      }
      quickArea.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "qt-grid";
      for (const it of list) {
        const tile = document.createElement("div");
        tile.className = "card qt";
        const img = document.createElement("img");
        img.src = `https://www.google.com/s2/favicons?domain=${hostOf(it.url)}&sz=64`;
        img.alt = "";
        const nm = document.createElement("div");
        nm.className = "qt-name";
        nm.textContent = it.title || hostOf(it.url);
        const x = document.createElement("button");
        x.className = "qt-x";
        x.textContent = "×";
        x.title = "Remove";
        x.onclick = async (e) => {
          e.stopPropagation();
          await saveQuickTabs((await getQuickTabs()).filter((q) => q.id !== it.id));
          renderQuickTabs();
        };
        tile.append(img, nm, x);
        tile.onclick = () => { location.href = it.url; };
        grid.appendChild(tile);
      }
      quickArea.appendChild(grid);
    };
    for (const [g, list] of groups) renderGroup(g, list);

    const addHead = document.createElement("div");
    addHead.className = "section-head";
    const addBtn = document.createElement("button");
    addBtn.className = "small";
    addBtn.textContent = "+ Add a quick tab";
    addBtn.style.marginLeft = "0";
    addHead.appendChild(addBtn);
    quickArea.appendChild(addHead);
    const form = document.createElement("div");
    form.id = "qt-form";
    form.className = "card";
    form.innerHTML = "";
    const r1 = document.createElement("div"); r1.className = "row";
    const inUrl = document.createElement("input"); inUrl.type = "text"; inUrl.placeholder = "Site, like youtube.com";
    const inName = document.createElement("input"); inName.type = "text"; inName.placeholder = "Name (optional)";
    r1.append(inUrl, inName);
    const r2 = document.createElement("div"); r2.className = "row";
    const inGroup = document.createElement("input"); inGroup.type = "text"; inGroup.placeholder = "Group (optional), like Work or Fun";
    const save = document.createElement("button"); save.className = "primary small"; save.textContent = "Add";
    r2.append(inGroup, save);
    form.append(r1, r2);
    quickArea.appendChild(form);
    addBtn.onclick = () => { form.style.display = form.style.display === "block" ? "none" : "block"; inUrl.focus(); };
    save.onclick = async () => {
      const url = normalizeUrl(inUrl.value);
      if (!url) return;
      const all = await getQuickTabs();
      all.push({ id: uid(), title: inName.value.trim(), url, group: inGroup.value.trim() });
      await saveQuickTabs(all);
      renderQuickTabs();
    };
  }
  await renderQuickTabs();

  const sets = await getSets();
  if (sets.length) document.getElementById("sets-head").hidden = false;
  const tiles = document.getElementById("tiles");
  for (const set of sets) {
    const pinned = set.tabs.filter((t) => t.pinned).length;
    const tile = document.createElement("div");
    tile.className = "card tile";
    const h = document.createElement("h3");
    h.textContent = set.name;
    const favs = document.createElement("div");
    favs.className = "favicons";
    for (const t of set.tabs.slice(0, 10)) {
      const img = document.createElement("img");
      img.src = `https://www.google.com/s2/favicons?domain=${hostOf(t.url)}&sz=32`;
      img.title = t.title || t.url;
      img.alt = "";
      favs.appendChild(img);
    }
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.style.fontSize = "12.5px";
    meta.textContent = `${set.tabs.length} tabs · ${pinned} pinned · opens asleep`;
    tile.append(h, favs, meta);
    tile.onclick = async () => {
      const win = await chrome.windows.getLastFocused();
      await chrome.runtime.sendMessage({ type: "open-set", setId: set.id, windowId: win.id });
    };
    tiles.appendChild(tile);
  }

  const tabs = await chrome.tabs.query({});
  const asleep = tabs.filter((t) => t.discarded).length;
  if (asleep > 0) {
    const pill = document.getElementById("saved");
    pill.hidden = false;
    pill.textContent = `${asleep} tabs asleep right now, saving memory`;
  }
}
init();
