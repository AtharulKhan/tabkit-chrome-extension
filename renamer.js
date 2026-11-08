// TabKit renamer content script: asks the background for a rename rule for
// this page (exact URL first, then domain) and keeps the custom title in
// place even when the page changes its own title.
(() => {
  let wanted = null;
  let applying = false;

  function apply() {
    if (!wanted || applying) return;
    if (document.title !== wanted) {
      applying = true;
      document.title = wanted;
      applying = false;
    }
  }

  chrome.runtime.sendMessage({ type: "get-rename", url: location.href }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.title) {
      wanted = res.title;
      apply();
      const titleEl = document.querySelector("title");
      if (titleEl) {
        new MutationObserver(apply).observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
      // SPA navigations can retitle the page without touching the <title> node list order; poll lightly.
      setInterval(apply, 3000);
    }
  });
})();
