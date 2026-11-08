// TabKit renamer content script: asks the background for a rename rule for
// this page (exact URL first, then domain) and keeps the custom title and
// favicon in place even when the page changes its own.
(() => {
  let wantedTitle = null;
  let faviconSpec = null;
  let faviconUrl = null;
  let started = false;
  let applying = false;

  function makeFaviconUrl(spec) {
    if (!spec) return null;
    if (spec.kind === "image" && spec.value) return spec.value;
    try {
      const c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      const x = c.getContext("2d");
      if (spec.kind === "emoji" && spec.value) {
        x.font = '50px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
        x.textAlign = "center"; x.textBaseline = "middle";
        x.fillText(spec.value, 32, 36);
      } else if (spec.kind === "badge") {
        const color = spec.color || "#C15F3C";
        const letter = (spec.letter || "?").slice(0, 1).toUpperCase();
        x.beginPath();
        x.roundRect(2, 2, 60, 60, 16);
        x.fillStyle = color; x.fill();
        x.font = "700 38px system-ui, sans-serif";
        x.fillStyle = "#fff"; x.textAlign = "center"; x.textBaseline = "middle";
        x.fillText(letter, 32, 35);
      } else return null;
      return c.toDataURL("image/png");
    } catch { return null; }
  }

  function apply() {
    if (applying) return;
    applying = true;
    try {
      if (wantedTitle && document.title !== wantedTitle) document.title = wantedTitle;
      if (faviconUrl) {
        let links = document.querySelectorAll('link[rel~="icon"]');
        if (!links.length) {
          const l = document.createElement("link");
          l.rel = "icon";
          document.head.appendChild(l);
          links = [l];
        }
        links.forEach((l) => { if (l.getAttribute("href") !== faviconUrl) l.setAttribute("href", faviconUrl); });
      }
    } finally { applying = false; }
  }

  function start() {
    if (started) return;
    started = true;
    apply();
    const titleEl = document.querySelector("title");
    if (titleEl) new MutationObserver(apply).observe(titleEl, { childList: true, characterData: true, subtree: true });
    if (document.head) new MutationObserver(apply).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "rel"] });
    setInterval(apply, 3000);
  }

  function fetchRule() {
    chrome.runtime.sendMessage({ type: "get-rename", url: location.href }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      wantedTitle = res.title || null;
      faviconSpec = res.favicon || null;
      faviconUrl = makeFaviconUrl(faviconSpec);
      if (wantedTitle || faviconUrl) start();
      apply();
    });
  }

  fetchRule();
  // A rename saved from the popup lands in storage; pick it up live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.renames) fetchRule();
  });
})();
