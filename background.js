let stopRequested = false;

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-full") startCaptureFromShortcut("full");
  else if (command === "capture-visible") startCaptureFromShortcut("visible");
  else if (command === "capture-region") startCaptureFromShortcut("region");
});

async function startCaptureFromShortcut(mode) {
  const res = await chrome.storage.local.get(["settings"]);
  runCaptureFlow(mode, res.settings || {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "START_CAPTURE") {
    stopRequested = false;
    chrome.storage.local.set({
      isCapturing: true,
      captureProgress: { text: "Starting capture...", pct: 0 },
    });
    runCaptureFlow(msg.mode, msg.settings);
    sendResponse({ started: true });
  } else if (msg.action === "STOP_CAPTURE") {
    stopRequested = true;
    endCapture("Capture stopped");
    sendResponse({ stopped: true });
  } else if (msg.action === "START_INSPECT") {
    runInspectorFlow();
    sendResponse({ started: true });
  } else if (msg.action === "START_PICKER") {
    runPickerFlow();
    sendResponse({ started: true });
  } else if (msg.action === "GET_VISIBLE_BITMAP") {
    // The frame-sampling fallback reads real pixels off a shot of the tab.
    captureTabSafe(sender.tab && sender.tab.windowId)
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch(() => sendResponse(null));
    return true;
  }
  return false;
});

async function setBadge(text, color = "#10b981") {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

async function broadcastProgress(text, pct) {
  // The popup can be closed for most of a capture, so mirror every update
  // into storage; a reopened popup reads it instead of showing "Warming up".
  chrome.storage.local
    .set({ captureProgress: { text, pct } })
    .catch(() => {});
  try {
    await chrome.runtime.sendMessage({ action: "UPDATE_PROGRESS", text, pct });
  } catch (e) {}
}

function endCapture(finalText) {
  // A terminal message is kept so a reopened popup can still show why the
  // run ended; ordinary finishes clear it.
  return chrome.storage.local
    .set({
      isCapturing: false,
      captureProgress: finalText ? { text: finalText, pct: 0 } : null,
    })
    .catch(() => {});
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.url.startsWith("chrome://")) return null;
  return tab;
}

async function injectAndSend(action, tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  const { uiTheme } = await chrome.storage.local.get("uiTheme");
  chrome.tabs.sendMessage(tabId, { action, theme: uiTheme });
}

async function runInspectorFlow() {
  const tab = await getActiveTab();
  if (tab) await injectAndSend("launchStyleInspector", tab.id);
}

async function runPickerFlow() {
  const tab = await getActiveTab();
  if (tab) await injectAndSend("launchColorPicker", tab.id);
}

// Chrome rate-limits captureVisibleTab (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
// 2 calls/second documented and stricter on some builds), and the slice loop's
// adaptive settle can clear a static page in ~40ms, so a fast page outruns the
// quota and the capture aborts. A refusal is a timing problem, not an unfocused
// window: wait out the strictest limit, then keep a gap that only widens if a
// paced call is refused too.
const CAPTURE_RETRY_MS = 250;
const CAPTURE_QUOTA_BACKOFF_MS = 1100;
const CAPTURE_GAP_MS = [600, 1200];
let captureGapTier = -1;
let lastCaptureAttemptAt = 0;

async function captureTabSafe(windowId) {
  const gap = CAPTURE_GAP_MS[captureGapTier] || 0;
  const wait = lastCaptureAttemptAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const shoot = () => {
    lastCaptureAttemptAt = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  };
  try {
    return await shoot();
  } catch (err) {
    const quota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(err.message);
    if (quota) {
      captureGapTier = Math.min(captureGapTier + 1, CAPTURE_GAP_MS.length - 1);
    }
    const backoff = quota ? CAPTURE_QUOTA_BACKOFF_MS : CAPTURE_RETRY_MS;
    await new Promise((r) => setTimeout(r, backoff));
    try {
      return await shoot();
    } catch (err2) {
      throw new Error(
        `Chrome refused the screen capture (${err2.message}). Keep this window focused and capture again.`,
      );
    }
  }
}

function sendTabMessage(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (res) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// How much of a long page is worth shooting, worked out from the page's own
// geometry. A slice is the viewport at device resolution, so rows cost width ×
// dpr²: 320M device pixels is exactly what the old fixed 40000 spent in a
// 1920px window at dpr 2, which holds that window's cost flat and lets a 1x
// window reach further for the same bytes. The second bound mirrors studio.js:
// past 32768 px on a side it cannot composite even at its smallest 0.25 scale,
// so rows beyond it are only ever thrown away.
const MAX_SLICE_DEVICE_PIXELS = 320000000;
const STUDIO_MAX_SIDE = 32768;
const STUDIO_EDITOR_PAD_H = 260;
const STUDIO_MIN_SCALE = 0.25;

function captureHeightLimit({ viewportWidth, viewportHeight, devicePixelRatio }) {
  const rowsFromMemory =
    MAX_SLICE_DEVICE_PIXELS /
    (viewportWidth * devicePixelRatio * devicePixelRatio);
  const rowsFromCanvas = (STUDIO_MAX_SIDE - STUDIO_EDITOR_PAD_H) / STUDIO_MIN_SCALE;
  // Never talk a page out of at least two viewports, however tall the window.
  return Math.max(
    Math.floor(Math.min(rowsFromMemory, rowsFromCanvas)),
    Math.floor(viewportHeight * 2),
  );
}

function capHeight(geo) {
  return { ...geo, fullHeight: Math.min(geo.fullHeight, captureHeightLimit(geo)) };
}

async function runCaptureFlow(mode, rawSettings) {
  const settings = {
    delay: 0,
    speed: 550,
    hideFixed: true,
    killCookies: false,
    hideScroll: true,
    forceDark: false,
    ...rawSettings,
  };
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (
      !tab ||
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("chrome-extension://")
    ) {
      await setBadge("ERR", "#ef4444");
      endCapture("This page cannot be captured");
      setTimeout(() => setBadge(""), 2500);
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    const delay = parseInt(settings.delay || 0, 10);
    for (let i = delay; i > 0; i--) {
      if (stopRequested) break;
      await setBadge(`${i}s`, "#f59e0b");
      await broadcastProgress(
        `Delay timer (${i}s)...`,
        ((delay - i) / delay) * 20,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (stopRequested) {
      await setBadge("");
      endCapture();
      return;
    }

    if (mode === "region" || mode === "element") {
      await setBadge("SEL", "#3b82f6");
      await broadcastProgress("Selecting area...", 30);
      const metrics = await sendTabMessage(tab.id, {
        action: "preparePage",
        hideScroll: settings.hideScroll,
        killCookies: settings.killCookies,
        forceDark: settings.forceDark,
      });

      const rect = await sendTabMessage(tab.id, {
        action: mode === "region" ? "selectRegion" : "selectElement",
      });

      if (!rect || rect.width < 5 || rect.height < 5) {
        await sendTabMessage(tab.id, {
          action: "restorePage",
          y: metrics.originalScrollY,
        });
        await setBadge("");
        endCapture();
        return;
      }

      await new Promise((r) => setTimeout(r, 150));
      const dataUrl = await captureTabSafe(tab.windowId);
      await sendTabMessage(tab.id, {
        action: "restorePage",
        y: metrics.originalScrollY,
      });
      await saveAndOpenStudio({
        mode: "crop",
        dataUrl,
        cropRect: rect,
        dpr: metrics.devicePixelRatio,
        title: metrics.title,
        url: metrics.url,
      });
      await setBadge("");
      endCapture();
      return;
    }

    if (mode === "visible") {
      await setBadge("CAP", "#10b981");
      await broadcastProgress("Capturing visible screen...", 50);
      const metrics = await sendTabMessage(tab.id, {
        action: "preparePage",
        hideScroll: settings.hideScroll,
        killCookies: settings.killCookies,
        forceDark: settings.forceDark,
      });
      await new Promise((r) => setTimeout(r, 150));
      const dataUrl = await captureTabSafe(tab.windowId);
      await sendTabMessage(tab.id, {
        action: "restorePage",
        y: metrics.originalScrollY,
      });
      await saveAndOpenStudio({
        mode: "single",
        dataUrl,
        title: metrics.title,
        url: metrics.url,
      });
      await setBadge("");
      endCapture();
      return;
    }

    await setBadge("0%", "#10b981");
    await broadcastProgress("Detecting page dimensions...", 5);
    const metrics = await sendTabMessage(tab.id, {
      action: "preparePage",
      hideScroll: settings.hideScroll,
      killCookies: settings.killCookies,
      forceDark: settings.forceDark,
    });

    let {
      fullHeight,
      viewportWidth,
      viewportHeight,
      stepHeight,
      containerOffsetTop,
      devicePixelRatio,
      originalScrollY,
      title,
      url,
    } = capHeight(metrics);
    let measuredHeight = metrics.fullHeight;
    if (fullHeight < measuredHeight) {
      await broadcastProgress(
        `Page is ${measuredHeight}px tall; taking the first ${fullHeight}px`,
        5,
      );
    }

    // Prime pass. `preparePage` reports the height the page had on arrival,
    // which on a lazy page is shorter than the one worth capturing, and its
    // content is still blank below the first viewport. Scroll the whole page
    // without shooting a single frame, let each stop settle on images and
    // height, extend the run if the page grows under us, then take the
    // geometry again.
    const primeStep = stepHeight || viewportHeight;
    let primeY = 0;
    let primeHeight = fullHeight;
    let primeLastY = -1;
    let primeStops = 0;
    while (primeY < primeHeight && !stopRequested) {
      primeStops++;
      await broadcastProgress(
        `Warming up page (${primeStops} of ~${Math.max(1, Math.ceil(primeHeight / primeStep))})`,
        Math.min(12, Math.round((primeY / primeHeight) * 12)),
      );
      const { actualScrollY } = await sendTabMessage(tab.id, {
        action: "scrollTo",
        y: primeY,
        speed: 250,
      });
      const grownRaw = await sendTabMessage(tab.id, { action: "measurePage" });
      if (grownRaw.fullHeight > measuredHeight) {
        measuredHeight = grownRaw.fullHeight;
      }
      const grown = capHeight(grownRaw);
      if (grown.fullHeight > primeHeight) primeHeight = grown.fullHeight;
      if (primeY > 0 && actualScrollY === primeLastY) break;
      primeLastY = actualScrollY;
      primeY += primeStep;
    }

    if (!stopRequested) {
      await sendTabMessage(tab.id, { action: "scrollTo", y: 0, speed: 150 });
      const freshRaw = await sendTabMessage(tab.id, { action: "measurePage" });
      const fresh = capHeight(freshRaw);
      measuredHeight = freshRaw.fullHeight;
      fullHeight = fresh.fullHeight;
      viewportWidth = fresh.viewportWidth;
      viewportHeight = fresh.viewportHeight;
      stepHeight = fresh.stepHeight;
      containerOffsetTop = fresh.containerOffsetTop;
      devicePixelRatio = fresh.devicePixelRatio;
    }

    const slices = [];
    let currentY = 0;
    let lastScrollY = -1;
    const overlap = 20;
    const sliceH = stepHeight || viewportHeight;
    const step = Math.max(100, sliceH - overlap);
    const totalSteps = Math.max(1, Math.ceil(fullHeight / step));
    let stepCount = 0;

    while (currentY < fullHeight && !stopRequested) {
      const pct = Math.min(99, Math.round((currentY / fullHeight) * 100));
      await setBadge(`${pct}%`, "#10b981");
      await broadcastProgress(
        `Capturing slice ${++stepCount} of ~${totalSteps} (${pct}%)`,
        pct,
      );

      const { actualScrollY } = await sendTabMessage(tab.id, {
        action: "scrollTo",
        y: currentY,
        hideFixed: settings.hideFixed,
        speed: parseInt(settings.speed || 550, 10),
      });

      const sliceUrl = await captureTabSafe(tab.windowId);
      slices.push({ dataUrl: sliceUrl, y: actualScrollY });

      if (currentY > 0 && actualScrollY === lastScrollY) {
        break;
      }
      lastScrollY = actualScrollY;
      currentY += step;
      if (currentY >= fullHeight - overlap) break;
    }

    await sendTabMessage(tab.id, { action: "restorePage", y: originalScrollY });

    if (stopRequested) {
      await setBadge("");
      endCapture();
      return;
    }

    await setBadge("100%", "#10b981");
    await broadcastProgress("Opening Studio...", 100);

    await saveAndOpenStudio({
      mode: "stitch",
      slices,
      viewportWidth,
      viewportHeight,
      sliceHeight: sliceH,
      containerOffsetTop: containerOffsetTop || 0,
      fullHeight,
      dpr: devicePixelRatio,
      title,
      url,
    });

    await setBadge("");
    endCapture(
      measuredHeight > fullHeight
        ? `Captured the first ${fullHeight}px of a ${measuredHeight}px page`
        : undefined,
    );
  } catch (err) {
    await setBadge("ERR", "#ef4444");
    endCapture(`Capture failed: ${err.message}`);
    setTimeout(() => setBadge(""), 3000);
  }
}

async function saveAndOpenStudio(payload) {
  payload.timestamp = new Date().toLocaleString();
  await chrome.storage.local.set({ pendingCapture: payload });
  await chrome.tabs.create({ url: chrome.runtime.getURL("studio.html") });
}
