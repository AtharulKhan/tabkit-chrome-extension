# TabKit

One Chrome extension that replaces five: New Tab Redirect, Save Pinned Tabs, Tab Renamer, Auto Tab Discard, and Quick Tab Switch.

## What it does

- **Tab sets and pinned sets.** Save any window as a named set, and update a set any time to match the window as it is right now. A full Sets page (from the popup or Settings) lists every set with its tabs and a search that matches set names and tab titles. Open a set in the same window (it closes the previous set's tabs there) or in a new window. If the window has other tabs that are not in the set, TabKit asks first: save them as a new set, just close them, or keep them. Tabs open frozen: the whole strip appears at once and each tab loads only when you click it, so opening a set costs almost no memory. Pinned tabs stay pinned. One set can be the startup set, its pinned tabs come back at every launch, frozen.
- **Memory saver.** Tabs idle for a set number of minutes (default 10) are put to sleep, with a per-window cap on awake tabs (default 15, longest idle sleeps first). Pinned tabs can sleep too, tabs playing sound are protected (optional), and an exceptions list keeps chosen sites awake forever.
- **Quick switch.** Alt+Z jumps between the two most recent tabs.
- **Tab renamer, with favicons.** Rename a tab from the popup or with Cmd+Shift+Y, or set rules per site; the name survives reloads. The popup also sets a custom tab icon for that exact page: tap an emoji in the picker grid (or paste any other emoji) and it applies right away. Because rules can match one exact page, every Google Sheet can get its own name and icon instead of the same green Sheets icon.
- **Instant new tab redirect, or a launcher.** Point every new tab at one page (a plain name like chatgpt.com works) and it goes there instantly. Or use the launcher: clock, live search across open tabs, bookmarks and history, your quick tabs, and your sets.
- **Quick tabs.** Favorite sites pinned on the new tab page, in groups, with an Open all that opens a group frozen except the first.
- **Startup page.** Any page can open when Chrome starts (for example chatgpt.com).
- **Backup and move.** Export your settings, sets, renames and quick tabs to one small file, import it on any other machine or browser.
- **Chrome sync.** Settings, sets, renames and quick tabs sync through your Google sign-in to every Chrome running TabKit (v1.14.0 and up). The extension ID is pinned by the "key" field in manifest.json (ID cpkbaoodffhmdcenhcegcpofbikdbfcd), which is what makes every install share one sync bucket. Big sets are split into chunks inside sync storage (a head item plus one item per chunk of tabs, each under the 8 KB per-item cap), so they sync too; a set stays on the local machine only when sync storage itself is nearly full (100 KB total). Sets that v1.14.0 parked in local storage are moved into sync automatically by v1.14.1.

## Install (unpacked)

1. Download or clone this repo.
2. Open chrome://extensions and turn on Developer mode.
3. Click "Load unpacked" and pick this folder.
4. Click the TabKit icon, open Settings, and set your options. If another extension also controls the new tab page (like New Tab Redirect), turn it off so they do not fight.

## Notes

- Light theme in a warm off-white and clay palette.
- Your settings, sets, renames and quick tabs live in Chrome's sync storage, so they travel with your Google account. Sleep stats stay in local storage. Nothing is sent to any server of ours.
- Upgrading from v1.13 or earlier: the pinned ID makes Chrome treat v1.14 as a new extension, and the old copy's data cannot move on its own. Export a backup from the old copy first (Settings, Backup and move), then load v1.14 and import that file once. After that, sync keeps every machine matched.
