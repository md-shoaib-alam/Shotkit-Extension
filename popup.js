const els = {
  normalView: document.getElementById("normalView"),
  captureView: document.getElementById("captureView"),
  captureStatusText: document.getElementById("captureStatusText"),
  captureProgressBar: document.getElementById("captureProgressBar"),
  btnStopCapture: document.getElementById("btnStopCapture"),
  btnPartial: document.getElementById("btnPartial"),
  btnFull: document.getElementById("btnFull"),
  btnVisible: document.getElementById("btnVisible"),
  btnRegion: document.getElementById("btnRegion"),
  btnElement: document.getElementById("btnElement"),
  btnStyleInspect: document.getElementById("btnStyleInspect"),
  btnPicker: document.getElementById("btnPicker"),
  btnTheme: document.getElementById("btnTheme"),
  btnOpenStudio: document.getElementById("btnOpenStudio"),
  delaySelect: document.getElementById("delaySelect"),
  speedSelect: document.getElementById("speedSelect"),
  hideFixed: document.getElementById("hideFixed"),
  killCookies: document.getElementById("killCookies"),
  hideScroll: document.getElementById("hideScroll"),
  forceDark: document.getElementById("forceDark"),
};

chrome.storage.local.get(
  ["settings", "uiTheme", "isCapturing", "captureProgress"],
  (res) => {
    // Light ships as the default and is already on <body>, so only an
    // explicit "dark" has to pull it off — and the first paint never flashes.
    if (res.uiTheme === "dark") document.body.classList.remove("light");
    syncThemeLabel();
    if (res.settings) {
      els.delaySelect.value = res.settings.delay || "0";
      els.speedSelect.value = res.settings.speed || "550";
      els.hideFixed.checked = res.settings.hideFixed ?? true;
      els.killCookies.checked = res.settings.killCookies ?? true;
      els.hideScroll.checked = res.settings.hideScroll ?? true;
      els.forceDark.checked = res.settings.forceDark ?? false;
    }
    renderProgress(res.captureProgress);
    if (res.isCapturing) showCapturingUI();
  },
);

function renderProgress(progress) {
  if (!progress || !progress.text) return;
  els.captureStatusText.textContent = progress.text;
  els.captureProgressBar.style.width = `${progress.pct || 0}%`;
}

// Progress lives in storage, not just in messages, so a popup reopened
// mid-capture catches up to the running slice instead of showing "Warming up".
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.captureProgress) renderProgress(changes.captureProgress.newValue);
  if (changes.isCapturing && changes.isCapturing.newValue) showCapturingUI();
});

function getSettings() {
  return {
    delay: els.delaySelect.value,
    speed: els.speedSelect.value,
    hideFixed: els.hideFixed.checked,
    killCookies: els.killCookies.checked,
    hideScroll: els.hideScroll.checked,
    forceDark: els.forceDark.checked,
  };
}

function saveSettings() {
  chrome.storage.local.set({ settings: getSettings() });
}

[
  els.delaySelect,
  els.speedSelect,
  els.hideFixed,
  els.killCookies,
  els.hideScroll,
  els.forceDark,
].forEach((el) => {
  el.addEventListener("change", saveSettings);
});

els.btnTheme.addEventListener("click", () => {
  const isLight = document.body.classList.toggle("light");
  chrome.storage.local.set({ uiTheme: isLight ? "light" : "dark" });
  syncThemeLabel();
});

function syncThemeLabel() {
  const label = document.body.classList.contains("light")
    ? "Switch to dark mode"
    : "Switch to light mode";
  els.btnTheme.title = label;
  els.btnTheme.setAttribute("aria-label", label);
}

els.btnOpenStudio.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("studio.html") });
  window.close();
});

function showCapturingUI() {
  els.normalView.style.display = "none";
  els.captureView.style.display = "block";
}

function triggerCapture(mode) {
  saveSettings();
  showCapturingUI();
  chrome.runtime.sendMessage(
    { action: "START_CAPTURE", mode: mode, settings: getSettings() },
    () => {
      // Close the popup so it neither occludes the page nor the
      // region/element selection overlay.
      window.close();
    },
  );
}

els.btnFull.addEventListener("click", () => triggerCapture("full"));
els.btnVisible.addEventListener("click", () => triggerCapture("visible"));
els.btnRegion.addEventListener("click", () => triggerCapture("region"));
els.btnElement.addEventListener("click", () => triggerCapture("element"));

els.btnStyleInspect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "START_INSPECT" }, () => {
    window.close();
  });
});

els.btnPicker.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "START_PICKER" }, () => {
    window.close();
  });
});

els.btnStopCapture.addEventListener("click", () => {
  // background's endCapture() clears isCapturing and stores "Capture stopped".
  chrome.runtime.sendMessage({ action: "STOP_CAPTURE" }, () => window.close());
});

els.btnPartial.addEventListener("click", () => {
  // Abandon the running full-page capture and restart it as a region pick.
  chrome.runtime.sendMessage({ action: "STOP_CAPTURE" }, () => {
    triggerCapture("region");
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "UPDATE_PROGRESS") renderProgress(msg);
});
