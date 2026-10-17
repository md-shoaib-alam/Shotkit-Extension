# Shotkit

Capture full-page screenshots, annotate them, and inspect any element's styles — a zero-dependency Manifest V3 Chrome extension.

Plain JavaScript files loaded straight as an unpacked extension. No bundler, no framework, no `node_modules`, no build step, and no remote code: nothing in this repository makes a network request.

## Capture

Four modes, from the popup or the keyboard:

| mode | what it shoots |
| --- | --- |
| Full page | the entire scrollable page, stitched from viewport slices |
| Visible viewport | exactly what is on screen |
| Region | a rectangle you drag on the page |
| Element | a single element you click |

Page cleanup you can toggle per capture:

- strip cookie, GDPR and consent banners
- hide sticky/fixed headers so they do not repeat down the stitch
- hide scrollbars
- force a dark rendering (`invert` + `hue-rotate`)
- start delay and scroll speed

## Studio

Every capture opens in the Studio tab, which holds the image on a canvas:

- **10 tools** — pen, highlighter, rectangle, arrow, numbered step, loupe (draggable magnifier), text, blur, crop, and a pixel colour picker
- **Colour card** — pick any pixel and copy it as HEX, RGB or HSL
- **Zoom** — in, out, fit to width, reset
- **History drawer** — past captures with generated thumbnails, reopen or delete
- **Export** — PNG, JPEG, WebP, PDF, clipboard, print; plus device frame, watermark, padding, corner radius, gradient background, filter and quality before export
- Undo (`Ctrl+Z`), reset all, light/dark theme

## Style inspector

Hover the page to read an element's computed styles, box model and spacing, then export a snippet as HTML, CSS or JSX — only the properties that override the browser defaults.

## Keyboard shortcuts

| keys | action |
| --- | --- |
| `Alt+Shift+F` | capture full page |
| `Alt+Shift+V` | capture visible viewport |
| `Alt+Shift+S` | capture selected region |
| `Ctrl+Z` | undo, inside Studio |

Defined in `manifest.json` under `commands`; rebindable at `chrome://extensions/shortcuts`.

## Install

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin Shotkit to the toolbar, then press `Alt+Shift+F` on any page.

To edit: change the files, hit **Reload** on the extension card. Chrome 137 and later ignore `--load-extension`, so loading unpacked through the UI is the only way to test a change.

## How full-page capture works

A full-page shot is not one browser call — `captureVisibleTab` only shoots the viewport — so the extension scrolls and stitches.

1. **Prime pass.** Scroll the whole page once without capturing, so lazy-loaded sections, images and infinite-height blocks exist before any frame is shot.
2. **Slice pass.** Scroll one viewport at a time and capture each. Before every shot it waits for the page to be quiet: at least 40 ms elapsed, no image still loading in view, and the document height no longer growing. The configured speed is a ceiling for that wait, never a fixed sleep.
3. **Overlap.** Slices step by `viewport height - 20 px`; the repeated rows give the stitcher something to line up on inside scroll containers.
4. **Height limit.** How far to shoot is computed from the page, not a constant. Slice memory scales with `width x devicePixelRatio^2`, so a 1920 px window at dpr 2 reaches 41,666 px while the same window at dpr 1 reaches 130,032 px — the old fixed 40,000 px cap gave both of them the same answer, which was wrong for one of them. Beyond roughly 32,768 px the browser cannot composite the canvas anyway, so those rows would be thrown away. If a page is taller than the limit, the badge message tells you how much was taken.
5. **Stitch.** `studio.js` draws the slices onto one canvas at the largest resolution that still fits the browser's canvas budget, halving the scale until it does.

Inner scroll containers are handled by finding the real scrollable element and offsetting its chrome band, so a page whose list scrolls inside a fixed shell stitches without a duplicated header.

## Files

| file | role |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions, popup, shortcuts |
| `background.js` | service worker — orchestrates scroll, capture, storage, badge |
| `content.js` | injected into the page — scrolling, cleanup, region/element picking, inspector |
| `popup.html` / `popup.js` | toolbar popup: modes, settings, live capture progress |
| `studio.html` / `studio.js` | the editor tab — stitching, canvas, tools, history, export |

Captures are held in `chrome.storage.local` (the manifest requests `unlimitedStorage`). Nothing leaves the browser.

## Licence

Released under the MIT licence — see [LICENSE](LICENSE).
