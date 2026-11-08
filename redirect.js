// TabKit instant redirect. This file loads before any styling or content on
// the new tab page. If a redirect page is set, go there immediately.
// Otherwise mark the page as a launcher so the hidden page is revealed.
// (This logic lives in its own file because Chrome blocks inline scripts
// on extension pages.)
(function () {
  function launcher() { document.documentElement.classList.add("tk-launcher"); }
  try {
    chrome.storage.local.get("settings", function (d) {
      var s = (d && d.settings) || {};
      var u = (s.newTabUrl || "").trim();
      if (s.newTabMode === "url" && u) {
        if (!/^(https?|chrome|about|file):/i.test(u) && u.indexOf(" ") === -1 && u.indexOf(".") > -1) {
          u = "https://" + u;
        }
        location.replace(u);
      } else {
        launcher();
      }
    });
  } catch (e) { launcher(); }
})();
