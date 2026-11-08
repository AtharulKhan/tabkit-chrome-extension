// TabKit instant redirect. This file loads before any styling or content on
// the new tab page. If a redirect page is set, go there immediately.
// Otherwise mark the page as a launcher so the hidden page is revealed.
// (This logic lives in its own file because Chrome blocks inline scripts
// on extension pages.)
(function () {
  function launcher() { document.documentElement.classList.add("tk-launcher"); }
  try {
    // Settings live in sync storage since v1.14.0. On the very first run
    // after the upgrade the sync copy may not exist yet, so fall back to
    // the old local copy once.
    chrome.storage.sync.get("settings", function (d) {
      if (d && d.settings) { decide(d.settings); return; }
      chrome.storage.local.get("settings", function (d2) {
        decide((d2 && d2.settings) || {});
      });
    });
    function decide(settings) {
      var s = settings || {};
      var u = (s.newTabUrl || "").trim();
      if (s.newTabMode === "url" && u) {
        if (!/^(https?|chrome|about|file):/i.test(u) && u.indexOf(" ") === -1 && u.indexOf(".") > -1) {
          u = "https://" + u;
        }
        location.replace(u);
      } else {
        launcher();
      }
    }
  } catch (e) { launcher(); }
})();
