let stopRequested = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "START_CAPTURE") {
    stopRequested = false;
    chrome.storage.local.set({ isCapturing: true });
    runCaptureFlow(msg.mode, msg.settings);
    sendResponse({ started: true });
  } else if (msg.action === "STOP_CAPTURE") {
    stopRequested = true;
    chrome.storage.local.set({ isCapturing: false });
    sendResponse({ stopped: true });
  } else if (msg.action === "START_INSPECT") {
    runInspectorFlow();
    sendResponse({ started: true });
  }
  return false;
});

async function setBadge(text, color = "#10b981") {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

async function broadcastProgress(text, pct) {
  try {
    await chrome.runtime.sendMessage({ action: "UPDATE_PROGRESS", text, pct });
  } catch (e) {}
}

async function runInspectorFlow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.url.startsWith('chrome://')) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  chrome.tabs.sendMessage(tab.id, { action: "launchStyleInspector" });
}

async function captureTabSafe(windowId) {
  for (let i = 0; i < 4; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      await new Promise(r => setTimeout(r, 600));
    }
  }
  return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

function sendTabMessage(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function runCaptureFlow(mode, settings) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://')) {
      await setBadge("ERR", "#ef4444");
      setTimeout(() => setBadge(""), 2500);
      chrome.storage.local.set({ isCapturing: false });
      return;
    }

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    const delay = parseInt(settings.delay || 0, 10);
    for (let i = delay; i > 0; i--) {
      if (stopRequested) break;
      await setBadge(`${i}s`, "#f59e0b");
      await broadcastProgress(`Delay timer (${i}s)...`, ((delay - i) / delay) * 20);
      await new Promise(r => setTimeout(r, 1000));
    }

    if (stopRequested) {
      await setBadge("");
      chrome.storage.local.set({ isCapturing: false });
      return;
    }

    if (mode === "region" || mode === "element") {
      await setBadge("SEL", "#3b82f6");
      await broadcastProgress("Selecting area...", 30);
      const metrics = await sendTabMessage(tab.id, {
        action: "preparePage",
        hideScroll: settings.hideScroll,
        killCookies: settings.killCookies,
        forceDark: settings.forceDark
      });

      const rect = await sendTabMessage(tab.id, {
        action: mode === "region" ? "selectRegion" : "selectElement"
      });

      if (!rect || rect.width < 5 || rect.height < 5) {
        await sendTabMessage(tab.id, { action: "restorePage", y: metrics.originalScrollY });
        await setBadge("");
        chrome.storage.local.set({ isCapturing: false });
        return;
      }

      await new Promise(r => setTimeout(r, 150));
      const dataUrl = await captureTabSafe(tab.windowId);
      await sendTabMessage(tab.id, { action: "restorePage", y: metrics.originalScrollY });
      await saveAndOpenStudio({
        mode: "crop",
        dataUrl,
        cropRect: rect,
        dpr: metrics.devicePixelRatio,
        title: metrics.title,
        url: metrics.url
      });
      await setBadge("");
      chrome.storage.local.set({ isCapturing: false });
      return;
    }

    if (mode === "visible") {
      await setBadge("CAP", "#10b981");
      await broadcastProgress("Capturing visible screen...", 50);
      const metrics = await sendTabMessage(tab.id, {
        action: "preparePage",
        hideScroll: settings.hideScroll,
        killCookies: settings.killCookies,
        forceDark: settings.forceDark
      });
      await new Promise(r => setTimeout(r, 150));
      const dataUrl = await captureTabSafe(tab.windowId);
      await sendTabMessage(tab.id, { action: "restorePage", y: metrics.originalScrollY });
      await saveAndOpenStudio({
        mode: "single",
        dataUrl,
        title: metrics.title,
        url: metrics.url
      });
      await setBadge("");
      chrome.storage.local.set({ isCapturing: false });
      return;
    }

    await setBadge("0%", "#10b981");
    await broadcastProgress("Detecting page dimensions...", 5);
    const metrics = await sendTabMessage(tab.id, {
      action: "preparePage",
      hideScroll: settings.hideScroll,
      killCookies: settings.killCookies,
      forceDark: settings.forceDark
    });

    const { fullHeight, viewportWidth, viewportHeight, devicePixelRatio, originalScrollY, title, url } = metrics;
    const slices = [];
    let currentY = 0;
    let lastScrollY = -1;
    const overlap = 20;
    const step = Math.max(100, viewportHeight - overlap);
    const totalSteps = Math.max(1, Math.ceil(fullHeight / step));
    let stepCount = 0;

    while (currentY < fullHeight && !stopRequested) {
      const pct = Math.min(99, Math.round((currentY / fullHeight) * 100));
      await setBadge(`${pct}%`, "#10b981");
      await broadcastProgress(`Capturing slice ${++stepCount} of ~${totalSteps} (${pct}%)`, pct);

      const { actualScrollY } = await sendTabMessage(tab.id, {
        action: "scrollTo",
        y: currentY,
        hideFixed: settings.hideFixed,
        speed: parseInt(settings.speed || 550, 10)
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
      chrome.storage.local.set({ isCapturing: false });
      return;
    }

    await setBadge("100%", "#10b981");
    await broadcastProgress("Opening Studio...", 100);

    await saveAndOpenStudio({
      mode: "stitch",
      slices,
      viewportWidth,
      viewportHeight,
      fullHeight,
      dpr: devicePixelRatio,
      title,
      url
    });

    await setBadge("");
    chrome.storage.local.set({ isCapturing: false });
  } catch (err) {
    await setBadge("ERR", "#ef4444");
    chrome.storage.local.set({ isCapturing: false });
    setTimeout(() => setBadge(""), 3000);
  }
}

async function saveAndOpenStudio(payload) {
  payload.timestamp = new Date().toLocaleString();
  await chrome.storage.local.set({ pendingCapture: payload });
  await chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
}