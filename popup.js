const els = {
  normalView: document.getElementById("normalView"),
  captureView: document.getElementById("captureView"),
  captureStatusText: document.getElementById("captureStatusText"),
  captureProgressBar: document.getElementById("captureProgressBar"),
  btnStopCapture: document.getElementById("btnStopCapture"),
  btnFull: document.getElementById("btnFull"),
  btnVisible: document.getElementById("btnVisible"),
  btnRegion: document.getElementById("btnRegion"),
  btnElement: document.getElementById("btnElement"),
  btnStyleInspect: document.getElementById("btnStyleInspect"),
  btnTheme: document.getElementById("btnTheme"),
  btnOpenStudio: document.getElementById("btnOpenStudio"),
  delaySelect: document.getElementById("delaySelect"),
  speedSelect: document.getElementById("speedSelect"),
  hideFixed: document.getElementById("hideFixed"),
  killCookies: document.getElementById("killCookies"),
};

chrome.storage.local.get(["settings", "uiTheme", "isCapturing"], (res) => {
  if (res.uiTheme === "light") document.body.classList.add("light");
  if (res.settings) {
    els.delaySelect.value = res.settings.delay || "0";
    els.speedSelect.value = res.settings.speed || "550";
    els.hideFixed.checked = res.settings.hideFixed ?? true;
    els.killCookies.checked = res.settings.killCookies ?? true;
  }
  if (res.isCapturing) {
    showCapturingUI();
  }
});

function getSettings() {
  return {
    delay: els.delaySelect.value,
    speed: els.speedSelect.value,
    hideFixed: els.hideFixed.checked,
    killCookies: els.killCookies.checked,
    hideScroll: true,
    forceDark: false,
  };
}

function saveSettings() {
  chrome.storage.local.set({ settings: getSettings() });
}

[els.delaySelect, els.speedSelect, els.hideFixed, els.killCookies].forEach(
  (el) => {
    el.addEventListener("change", saveSettings);
  },
);

els.btnTheme.addEventListener("click", () => {
  const isLight = document.body.classList.toggle("light");
  chrome.storage.local.set({ uiTheme: isLight ? "light" : "dark" });
});

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
  chrome.runtime.sendMessage({
    action: "START_CAPTURE",
    mode: mode,
    settings: getSettings(),
  });
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

els.btnStopCapture.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "STOP_CAPTURE" }, () => {
    chrome.storage.local.set({ isCapturing: false });
    window.close();
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "UPDATE_PROGRESS") {
    els.captureStatusText.textContent = msg.text;
    els.captureProgressBar.style.width = `${msg.pct}%`;
  }
});
