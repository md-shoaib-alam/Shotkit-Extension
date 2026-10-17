const canvas = document.getElementById("editorCanvas");
const ctx = canvas.getContext("2d");

let baseImage = new Image();
let captureMeta = {};
let annotations = [];
let currentTool = "pen";
let isDrawing = false;
let startX = 0,
  startY = 0;
let currentPath = [];
let stepCounter = 1;
let selectedAnnotation = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let imageLoaded = false;

const ui = {
  color: document.getElementById("strokeColor"),
  size: document.getElementById("strokeSize"),
  chkMac: document.getElementById("chkMacFrame"),
  chkWatermark: document.getElementById("chkWatermark"),
  padRange: document.getElementById("padRange"),
  radiusRange: document.getElementById("radiusRange"),
  gradientSelect: document.getElementById("gradientSelect"),
  bgColor: document.getElementById("bgColor"),
  filterSelect: document.getElementById("filterSelect"),
  fileName: document.getElementById("fileNameInput"),
  pdfMode: document.getElementById("pdfModeSelect"),
  qualityRange: document.getElementById("qualityRange"),
  qualityVal: document.getElementById("qualityVal"),
  dimBadge: document.getElementById("dimensionsBadge"),
  metaInfo: document.getElementById("metaInfo"),
  historyDrawer: document.getElementById("historyDrawer"),
  historyList: document.getElementById("historyList"),
  undo: document.getElementById("btnUndo"),
  clear: document.getElementById("btnClear"),
  canvasWrap: document.getElementById("canvasWrap"),
  zoomValue: document.getElementById("zoomValue"),
  zoomIn: document.getElementById("zoomIn"),
  zoomOut: document.getElementById("zoomOut"),
  zoomFit: document.getElementById("zoomFit"),
  colorPill: document.getElementById("colorPill"),
  colorSwatch: document.getElementById("colorSwatch"),
  copyHex: document.getElementById("copyHex"),
  copyRgb: document.getElementById("copyRgb"),
  copyHsl: document.getElementById("copyHsl"),
  colorClose: document.getElementById("colorClose"),
};

const toolButtons = Array.from(
  document.querySelectorAll(".tool-btn[data-tool]"),
);
const exportButtons = [
  "dlPng",
  "dlJpg",
  "dlWebp",
  "dlPdf",
  "btnCopy",
  "btnBase64",
  "btnPrint",
].map((id) => document.getElementById(id));

function refreshToolbarState() {
  for (const el of [...toolButtons, ui.color, ui.size, ...exportButtons]) {
    el.disabled = !imageLoaded;
  }
  const canEdit = imageLoaded && annotations.length > 0;
  ui.undo.disabled = !canEdit;
  ui.clear.disabled = !canEdit;
}

function setBaseImage(src) {
  imageLoaded = false;
  renderComposite();
  baseImage = new Image();
  baseImage.onload = () => {
    imageLoaded = true;
    renderComposite();
  };
  baseImage.onerror = () => {
    ui.dimBadge.textContent = "Image failed to load";
    renderComposite();
  };
  baseImage.src = src;
}

chrome.storage.local.get(
  ["uiTheme", "pendingCapture", "lastCapture", "captureHistory"],
  async (res) => {
    if (res.uiTheme === "light") document.body.classList.add("light");
    syncThemeLabel();

    try {
      if (res.pendingCapture) {
        const finalCapture = await buildCaptureFromPayload(res.pendingCapture);
        // Paint first. The history write is tens of megabytes and used to
        // block the image from appearing at all.
        loadCaptureIntoStudio(finalCapture);
        renderHistoryList(
          [finalCapture, ...(res.captureHistory || [])].slice(0, 10),
        );
        persistCapture(finalCapture, res.captureHistory || []);
      } else if (res.lastCapture) {
        loadCaptureIntoStudio(res.lastCapture);
        const hist = res.captureHistory || [];
        renderHistoryList(hist.length ? hist : [res.lastCapture], false);
      }
    } catch (err) {
      ui.dimBadge.textContent = "Failed to open capture: " + err.message;
    }
    refreshToolbarState();
  },
);

function makeThumb(dataUrl, maxSide = 240) {
  return loadImg(dataUrl).then((img) => {
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    const ratio = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * ratio));
    c.height = Math.max(1, Math.round(h * ratio));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.72);
  });
}

async function persistCapture(finalCapture, existing) {
  try {
    finalCapture.thumbUrl = await makeThumb(finalCapture.dataUrl);
  } catch (e) {
    // A missing thumb only costs the drawer a bigger image.
  }
  const history = [finalCapture, ...existing].slice(0, 10);
  try {
    await chrome.storage.local.set({
      lastCapture: finalCapture,
      pendingCapture: null,
      captureHistory: history,
    });
  } catch (e) {
    // History is best-effort; never let it lose the capture itself.
    await chrome.storage.local
      .set({ lastCapture: finalCapture, pendingCapture: null })
      .catch(() => {});
    return;
  }
  renderHistoryList(history);
}

async function buildCaptureFromPayload(payload) {
  if (payload.mode === "single") {
    return {
      dataUrl: payload.dataUrl,
      title: payload.title,
      url: payload.url,
      timestamp: payload.timestamp,
    };
  }
  if (payload.mode === "crop") {
    const img = await loadImg(payload.dataUrl);
    const dpr = payload.dpr || 1;
    const r = payload.cropRect;
    const c = document.createElement("canvas");
    c.width = r.width * dpr;
    c.height = r.height * dpr;
    c.getContext("2d").drawImage(
      img,
      r.x * dpr,
      r.y * dpr,
      r.width * dpr,
      r.height * dpr,
      0,
      0,
      r.width * dpr,
      r.height * dpr,
    );
    return {
      dataUrl: c.toDataURL("image/png"),
      title: payload.title,
      url: payload.url,
      timestamp: payload.timestamp,
    };
  }
  if (payload.mode === "stitch") {
    const dpr = payload.dpr || 1;
    const vw = payload.viewportWidth;
    const vh = payload.sliceHeight || payload.viewportHeight;
    const offsetTop = payload.containerOffsetTop || 0;
    const lastSlice = payload.slices[payload.slices.length - 1];
    const totalHeight = Math.min(
      payload.fullHeight,
      lastSlice ? offsetTop + lastSlice.y + vh : vh,
    );
    const c = document.createElement("canvas");

    // Past the browser's canvas ceiling toDataURL quietly returns null, so
    // trade resolution for completeness instead of failing. Studio redraws
    // this bitmap into an editor canvas that adds up to 180x260 px of
    // padding, chrome bar and footer, so budget for that growth too.
    const EDITOR_PAD_W = 180;
    const EDITOR_PAD_H = 260;
    const MAX_PIXELS = 100000000;
    const MAX_SIDE = 32768;
    let scale = dpr;
    const fits = (s) =>
      (vw * s + EDITOR_PAD_W) * (totalHeight * s + EDITOR_PAD_H) <= MAX_PIXELS &&
      totalHeight * s + EDITOR_PAD_H <= MAX_SIDE &&
      vw * s + EDITOR_PAD_W <= MAX_SIDE;
    while (scale > 0.25 && !fits(scale)) {
      scale /= 2;
    }

    c.width = Math.round(vw * scale);
    c.height = Math.round(totalHeight * scale);
    const sctx = c.getContext("2d");
    if (!sctx) throw new Error("Canvas too large to render");

    // A slice is the whole viewport. The scrolling band sits at
    // `offsetTop` inside it and holds `sliceHeight` of container content,
    // which belongs at canvas row `offsetTop + slice.y`. For document
    // scrolling offsetTop is 0 and sliceHeight is the viewport height, so
    // this reduces to a plain 1:1 stack.
    let chromeFilled = false;
    for (const slice of payload.slices) {
      const img = await loadImg(slice.dataUrl);
      const imgH = img.naturalHeight || img.height;
      const imgW = img.naturalWidth || img.width;
      if (!chromeFilled && offsetTop > 0) {
        const chromeCss = Math.min(offsetTop, imgH / dpr);
        if (chromeCss > 0) {
          sctx.drawImage(
            img,
            0,
            0,
            imgW,
            chromeCss * dpr,
            0,
            0,
            c.width,
            chromeCss * scale,
          );
        }
        chromeFilled = true;
      }
      const bandCss = Math.min(vh, totalHeight - offsetTop - slice.y);
      if (bandCss <= 0) continue;
      const srcY = offsetTop * dpr;
      const srcH = Math.min(bandCss * dpr, imgH - srcY);
      if (srcH <= 0) continue;
      sctx.drawImage(
        img,
        0,
        srcY,
        imgW,
        srcH,
        0,
        Math.round((offsetTop + slice.y) * scale),
        c.width,
        Math.round(srcH * (scale / dpr)),
      );
    }
    const stitchUrl = c.toDataURL("image/png");
    if (!stitchUrl || stitchUrl.length < 64) {
      throw new Error("Stitched image exceeded the canvas limit");
    }
    return {
      dataUrl: stitchUrl,
      title: payload.title,
      url: payload.url,
      timestamp: payload.timestamp,
    };
  }
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
}

function loadCaptureIntoStudio(cap) {
  captureMeta = cap;
  annotations = [];
  stepCounter = 1;
  ui.colorPill.classList.remove("open");
  const cleanTitle = (cap.title || "screenshot")
    .replace(/[^a-z0-9-_]/gi, "_")
    .slice(0, 40);
  ui.fileName.value = `SnapMaster_${cleanTitle}_${Date.now()}`;
  ui.metaInfo.innerHTML = `
    <div><strong>Title:</strong> ${escapeHtml(cap.title || "Untitled")}</div>
    <div><strong>URL:</strong> ${escapeHtml(cap.url || "N/A")}</div>
    <div><strong>Captured:</strong> ${escapeHtml(cap.timestamp || "")}</div>
  `;
  setBaseImage(cap.dataUrl);
}
function renderHistoryList(items, persistDeletes = true) {
  ui.historyList.innerHTML = "";
  if (!items || items.length === 0) {
    ui.historyList.innerHTML =
      '<div style="font-size:11px; color:var(--muted); text-align:center; padding:10px;">No history captures yet.</div>';
    return;
  }

  items.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "history-card";
    card.innerHTML = `
      <img src="${item.thumbUrl || item.dataUrl}" class="history-thumb" alt="thumb">
      <div class="history-info">
        <div class="history-title">${escapeHtml(item.title || "Capture")}</div>
        <div class="history-date">${escapeHtml(item.timestamp || "")}</div>
      </div>
      <button class="history-del" title="Delete capture" data-idx="${index}">✕</button>
    `;

    card.querySelector(".history-thumb").addEventListener("click", () => {
      loadCaptureIntoStudio(item);
      ui.historyDrawer.classList.remove("open");
    });
    card.querySelector(".history-info").addEventListener("click", () => {
      loadCaptureIntoStudio(item);
      ui.historyDrawer.classList.remove("open");
    });

    card.querySelector(".history-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      items.splice(index, 1);
      if (persistDeletes) {
        await chrome.storage.local.set({ captureHistory: items });
      }
      renderHistoryList(items, persistDeletes);
    });

    ui.historyList.appendChild(card);
  });
}

document
  .getElementById("btnClearHistory")
  .addEventListener("click", async () => {
    await chrome.storage.local.set({ captureHistory: [] });
    renderHistoryList([]);
  });

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}

document.getElementById("btnThemeStudio").addEventListener("click", () => {
  const isLight = document.body.classList.toggle("light");
  chrome.storage.local.set({ uiTheme: isLight ? "light" : "dark" });
  syncThemeLabel();
});

function syncThemeLabel() {
  const label = document.body.classList.contains("light")
    ? "Switch to dark mode"
    : "Switch to light mode";
  const btn = document.getElementById("btnThemeStudio");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

document.getElementById("btnHistory").addEventListener("click", () => {
  ui.historyDrawer.classList.toggle("open");
});

document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tool-btn[data-tool]")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentTool = btn.dataset.tool;
  });
});

[
  ui.chkMac,
  ui.chkWatermark,
  ui.padRange,
  ui.radiusRange,
  ui.gradientSelect,
  ui.bgColor,
  ui.filterSelect,
].forEach((el) => {
  el.addEventListener("input", renderComposite);
  el.addEventListener("change", renderComposite);
});

ui.qualityRange.addEventListener("input", () => {
  ui.qualityVal.textContent = `${ui.qualityRange.value}%`;
});

function fillBackdrop(w, h) {
  const style = ui.gradientSelect.value;
  if (style === "solid") {
    ctx.fillStyle = ui.bgColor.value;
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    const presets = {
      emerald: ["#064e3b", "#10b981", "#047857"],
      sunset: ["#7c2d12", "#ef4444", "#f59e0b"],
      ocean: ["#0c4a6e", "#0284c7", "#38bdf8"],
      midnight: ["#09090b", "#18181b", "#27272a"],
      royal: ["#3b0764", "#6d28d9", "#ec4899"],
    };
    const colors = presets[style] || presets.emerald;
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(0.5, colors[1]);
    grad.addColorStop(1, colors[2]);
    ctx.fillStyle = grad;
  }
  ctx.fillRect(0, 0, w, h);
}

function roundedRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
let zoomLevel = null;

function currentScale() {
  if (zoomLevel !== null) return zoomLevel;
  const rect = canvas.getBoundingClientRect();
  return canvas.width ? rect.width / canvas.width : 1;
}

function applyZoom() {
  if (zoomLevel === null) {
    canvas.style.maxWidth = "100%";
    canvas.style.width = "";
  } else {
    // Above fit, the container's max-width would just shrink it straight back.
    canvas.style.maxWidth = "none";
    canvas.style.width = Math.round(canvas.width * zoomLevel) + "px";
  }
  const s = currentScale();
  ui.zoomValue.textContent =
    zoomLevel === null && Math.abs(s - 1) < 0.005
      ? "Fit"
      : Math.round(s * 100) + "%";
  ui.zoomOut.disabled = !imageLoaded || s <= ZOOM_STEPS[0];
  ui.zoomIn.disabled = !imageLoaded || s >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
  ui.zoomFit.disabled = zoomLevel === null;
}

function stepZoom(dir) {
  const cur = currentScale();
  const up = dir > 0;
  const pool = up ? ZOOM_STEPS : ZOOM_STEPS.slice().reverse();
  const next = pool.find((z) => (up ? z > cur + 0.001 : z < cur - 0.001));
  zoomLevel = next === undefined ? cur : next;
  applyZoom();
}

ui.zoomIn.addEventListener("click", () => stepZoom(1));
ui.zoomOut.addEventListener("click", () => stepZoom(-1));
ui.zoomFit.addEventListener("click", () => {
  zoomLevel = null;
  applyZoom();
});
ui.zoomValue.addEventListener("click", () => {
  zoomLevel = 1;
  applyZoom();
});
ui.canvasWrap.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey || !imageLoaded) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

function renderComposite() {
  refreshToolbarState();
  if (!baseImage.width) {
    applyZoom();
    return;
  }
  const pad = parseInt(ui.padRange.value, 10) || 0;
  const radius = parseInt(ui.radiusRange.value, 10) || 0;
  const macBar = ui.chkMac.checked ? 44 : 0;
  const footer = ui.chkWatermark.checked ? 36 : 0;

  const innerW = baseImage.width;
  const innerH = baseImage.height + macBar + footer;
  const totalW = innerW + pad * 2;
  const totalH = innerH + pad * 2;

  canvas.width = totalW;
  canvas.height = totalH;
  ui.dimBadge.textContent = `${totalW} × ${totalH} px`;

  ctx.save();

  if (pad > 0) {
    fillBackdrop(totalW, totalH);
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 32;
    ctx.shadowOffsetY = 14;
    roundedRectPath(pad, pad, innerW, innerH, radius);
    ctx.fillStyle = "#09090b";
    ctx.fill();
    ctx.shadowColor = "transparent";
  }

  ctx.save();
  if (radius > 0) {
    roundedRectPath(pad, pad, innerW, innerH, radius);
    ctx.clip();
  }

  const contentX = pad;
  const contentY = pad + macBar;

  if (ui.chkMac.checked) {
    ctx.fillStyle = "#18181b";
    ctx.fillRect(pad, pad, innerW, macBar);
    ["#ef4444", "#f59e0b", "#10b981"].forEach((c, idx) => {
      ctx.beginPath();
      ctx.fillStyle = c;
      ctx.arc(pad + 22 + idx * 20, pad + macBar / 2, 6, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#09090b";
    const barW = Math.min(640, Math.max(120, innerW - 180));
    ctx.fillRect(pad + 96, pad + 9, barW, macBar - 18);
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "12px sans-serif";
    ctx.fillText(
      (captureMeta.url || "").slice(0, 80),
      pad + 110,
      pad + macBar / 2 + 4,
    );
  }

  ctx.filter = ui.filterSelect.value || "none";
  ctx.drawImage(baseImage, contentX, contentY);
  ctx.filter = "none";

  if (ui.chkWatermark.checked) {
    const footY = contentY + baseImage.height;
    ctx.fillStyle = "#121215";
    ctx.fillRect(pad, footY, innerW, footer);
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "12px sans-serif";
    ctx.fillText(
      `SnapMaster Studio  |  ${captureMeta.timestamp || ""}  |  ${captureMeta.url || ""}`,
      pad + 16,
      footY + 22,
    );
  }

  ctx.restore();

  annotations.forEach((item) => drawAnnotation(item));
  ctx.restore();
  applyZoom();
}

function drawAnnotation(item) {
  ctx.save();
  ctx.strokeStyle = item.color;
  ctx.fillStyle = item.color;
  ctx.lineWidth = item.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (item.type === "pen" || item.type === "highlight") {
    if (item.type === "highlight") {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = item.size * 4;
    }
    ctx.beginPath();
    item.points.forEach((pt, idx) =>
      idx === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y),
    );
    ctx.stroke();
  } else if (item.type === "rect") {
    ctx.strokeRect(item.x, item.y, item.w, item.h);
  } else if (item.type === "arrow") {
    const headlen = 14 + item.size;
    const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
    ctx.beginPath();
    ctx.moveTo(item.x1, item.y1);
    ctx.lineTo(item.x2, item.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(item.x2, item.y2);
    ctx.lineTo(
      item.x2 - headlen * Math.cos(angle - Math.PI / 6),
      item.y2 - headlen * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      item.x2 - headlen * Math.cos(angle + Math.PI / 6),
      item.y2 - headlen * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  } else if (item.type === "step") {
    const r = 14 + item.size;
    ctx.beginPath();
    ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${12 + Math.floor(item.size / 2)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(item.num), item.x, item.y);
  } else if (item.type === "loupe") {
    const r = Math.max(20, item.r);
    const snap = document.createElement("canvas");
    snap.width = canvas.width;
    snap.height = canvas.height;
    snap.getContext("2d").drawImage(canvas, 0, 0);

    ctx.save();
    ctx.beginPath();
    ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      snap,
      item.x - r,
      item.y - r,
      r * 2,
      r * 2,
      item.x - r * 2,
      item.y - r * 2,
      r * 4,
      r * 4,
    );
    ctx.restore();

    ctx.lineWidth = 3;
    ctx.strokeStyle = item.color;
    ctx.beginPath();
    ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
    ctx.stroke();
  } else if (item.type === "text") {
    ctx.font = `600 ${14 + item.size * 2}px sans-serif`;
    ctx.fillText(item.text, item.x, item.y);
  } else if (item.type === "blur") {
    const w = Math.abs(item.w),
      h = Math.abs(item.h);
    const sx = Math.min(item.x, item.x + item.w),
      sy = Math.min(item.y, item.y + item.h);
    if (w > 4 && h > 4) {
      const sample = document.createElement("canvas");
      const block = 12;
      sample.width = Math.max(1, Math.floor(w / block));
      sample.height = Math.max(1, Math.floor(h / block));
      const sctx = sample.getContext("2d");
      sctx.drawImage(canvas, sx, sy, w, h, 0, 0, sample.width, sample.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sample, 0, 0, sample.width, sample.height, sx, sy, w, h);
      ctx.imageSmoothingEnabled = true;
    }
  }
  ctx.restore();
}

async function copyText(text, okLabel) {
  try {
    await navigator.clipboard.writeText(text);
    ui.dimBadge.textContent = okLabel;
  } catch (e) {
    ui.dimBadge.textContent = "Clipboard blocked — refocus and retry";
  }
}

let lastColors = { hex: "", rgb: "", hsl: "" };

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function rgbToHsl(r, g, b) {
  const [n1, n2, n3] = [r, g, b].map((v) => v / 255);
  const max = Math.max(n1, n2, n3);
  const min = Math.min(n1, n2, n3);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === n1) h = (n2 - n3) / d + (n2 < n3 ? 6 : 0);
    else if (max === n2) h = (n3 - n1) / d + 2;
    else h = (n1 - n2) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function showColorReadout(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  lastColors = {
    hex: rgbToHex(r, g, b).toUpperCase(),
    rgb: `rgb(${r}, ${g}, ${b})`,
    hsl: `hsl(${h}, ${s}%, ${l}%)`,
  };
  ui.colorSwatch.style.background = lastColors.hex;
  ui.copyHex.textContent = lastColors.hex;
  ui.copyRgb.textContent = lastColors.rgb;
  ui.copyHsl.textContent = lastColors.hsl;
  ui.colorPill.classList.add("open");
}

[
  [ui.copyHex, "hex"],
  [ui.copyRgb, "rgb"],
  [ui.copyHsl, "hsl"],
].forEach(([btn, key]) => {
  btn.addEventListener("click", () => {
    copyText(lastColors[key], `Copied ${lastColors[key]}`);
  });
});

ui.colorClose.addEventListener("click", () => {
  ui.colorPill.classList.remove("open");
});

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  // The mouseup listener is on window, so the pointer can be well outside
  // the canvas when a stroke ends.
  return {
    x: Math.max(0, Math.min(canvas.width, x)),
    y: Math.max(0, Math.min(canvas.height, y)),
  };
}

function findClickedAnnotation(x, y) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    if (ann.type === "loupe" || ann.type === "step") {
      const dist = Math.hypot(ann.x - x, ann.y - y);
      if (dist <= (ann.r || 30)) return ann;
    } else if (ann.type === "rect" || ann.type === "blur") {
      const minX = Math.min(ann.x, ann.x + ann.w);
      const maxX = Math.max(ann.x, ann.x + ann.w);
      const minY = Math.min(ann.y, ann.y + ann.h);
      const maxY = Math.max(ann.y, ann.y + ann.h);
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) return ann;
    }
  }
  return null;
}

canvas.addEventListener("mousedown", (e) => {
  if (!imageLoaded) return;
  const { x, y } = getCanvasCoords(e);
  const color = ui.color.value;
  const size = parseInt(ui.size.value, 10);

  if (currentTool === "picker") {
    const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(x)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(y)));
    const p = ctx.getImageData(px, py, 1, 1).data;
    showColorReadout(p[0], p[1], p[2]);
    ui.color.value = rgbToHex(p[0], p[1], p[2]);
    return;
  }

  selectedAnnotation = findClickedAnnotation(x, y);
  if (selectedAnnotation) {
    isDrawing = true;
    startX = x;
    startY = y;
    dragOffsetX = x - selectedAnnotation.x;
    dragOffsetY = y - selectedAnnotation.y;
    return;
  }

  if (currentTool === "step") {
    annotations.push({ type: "step", x, y, num: stepCounter++, color, size });
    renderComposite();
    return;
  }

  if (currentTool === "text") {
    const text = prompt("Enter text label:");
    if (text && text.trim()) {
      annotations.push({ type: "text", x, y, text: text.trim(), color, size });
      renderComposite();
    }
    return;
  }

  isDrawing = true;
  startX = x;
  startY = y;
  currentPath = [{ x, y }];
});

canvas.addEventListener("mousemove", (e) => {
  if (!isDrawing) return;
  const { x, y } = getCanvasCoords(e);
  const color = ui.color.value;
  const size = parseInt(ui.size.value, 10);

  if (selectedAnnotation) {
    selectedAnnotation.x = x - dragOffsetX;
    selectedAnnotation.y = y - dragOffsetY;
    renderComposite();
    return;
  }

  renderComposite();

  if (currentTool === "pen" || currentTool === "highlight") {
    currentPath.push({ x, y });
    drawAnnotation({ type: currentTool, points: currentPath, color, size });
  } else if (
    currentTool === "rect" ||
    currentTool === "blur" ||
    currentTool === "crop"
  ) {
    drawAnnotation({
      type: currentTool === "crop" ? "rect" : currentTool,
      x: startX,
      y: startY,
      w: x - startX,
      h: y - startY,
      color: currentTool === "crop" ? "#10b981" : color,
      size: 2,
    });
  } else if (currentTool === "arrow") {
    drawAnnotation({
      type: "arrow",
      x1: startX,
      y1: startY,
      x2: x,
      y2: y,
      color,
      size,
    });
  } else if (currentTool === "loupe") {
    const r = Math.hypot(x - startX, y - startY);
    drawAnnotation({ type: "loupe", x: startX, y: startY, r, color, size });
  }
});

window.addEventListener("mouseup", (e) => {
  if (!isDrawing) return;
  isDrawing = false;
  selectedAnnotation = null;
  const { x, y } = getCanvasCoords(e);
  const color = ui.color.value;
  const size = parseInt(ui.size.value, 10);

  if (currentTool === "crop") {
    const cw = Math.abs(x - startX),
      ch = Math.abs(y - startY);
    const cx = Math.min(startX, x),
      cy = Math.min(startY, y);
    if (cw > 20 && ch > 20) {
      renderComposite();
      const temp = document.createElement("canvas");
      temp.width = cw;
      temp.height = ch;
      temp.getContext("2d").drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
      annotations = [];
      stepCounter = 1;
      ui.padRange.value = 0;
      ui.chkMac.checked = false;
      ui.chkWatermark.checked = false;
      setBaseImage(temp.toDataURL("image/png"));
    } else {
      renderComposite();
    }
    return;
  }

  if (currentTool === "pen" || currentTool === "highlight") {
    annotations.push({ type: currentTool, points: currentPath, color, size });
  } else if (currentTool === "rect" || currentTool === "blur") {
    if (Math.abs(x - startX) > 3 && Math.abs(y - startY) > 3) {
      annotations.push({
        type: currentTool,
        x: Math.min(startX, x),
        y: Math.min(startY, y),
        w: Math.abs(x - startX),
        h: Math.abs(y - startY),
        color,
        size,
      });
      currentTool = "pen";
      document
        .querySelectorAll(".tool-btn[data-tool]")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelector('.tool-btn[data-tool="pen"]')
        .classList.add("active");
    }
  } else if (currentTool === "arrow") {
    if (Math.hypot(x - startX, y - startY) > 5) {
      annotations.push({
        type: "arrow",
        x1: startX,
        y1: startY,
        x2: x,
        y2: y,
        color,
        size,
      });
      currentTool = "pen";
      document
        .querySelectorAll(".tool-btn[data-tool]")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelector('.tool-btn[data-tool="pen"]')
        .classList.add("active");
    }
  } else if (currentTool === "loupe") {
    const r = Math.hypot(x - startX, y - startY);
    if (r > 15) {
      annotations.push({ type: "loupe", x: startX, y: startY, r, color, size });
      currentTool = "pen";
      document
        .querySelectorAll(".tool-btn[data-tool]")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelector('.tool-btn[data-tool="pen"]')
        .classList.add("active");
    }
  }
  renderComposite();
});

function undoAnnotation() {
  const removed = annotations.pop();
  if (removed && removed.type === "step") {
    stepCounter = Math.max(1, stepCounter - 1);
  }
  renderComposite();
}

document.getElementById("btnUndo").addEventListener("click", undoAnnotation);

document.getElementById("btnClear").addEventListener("click", () => {
  annotations = [];
  stepCounter = 1;
  renderComposite();
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.preventDefault();
    undoAnnotation();
  }
});

function downloadImage(mime, ext) {
  const quality = parseInt(ui.qualityRange.value, 10) / 100;
  const name = (ui.fileName.value.trim() || "screenshot") + "." + ext;
  canvas.toBlob(
    (blob) => {
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({ url, filename: name, saveAs: true });
    },
    mime,
    quality,
  );
}

document
  .getElementById("dlPng")
  .addEventListener("click", () => downloadImage("image/png", "png"));
document
  .getElementById("dlJpg")
  .addEventListener("click", () => downloadImage("image/jpeg", "jpg"));
document
  .getElementById("dlWebp")
  .addEventListener("click", () => downloadImage("image/webp", "webp"));

document.getElementById("dlPdf").addEventListener("click", () => {
  const quality = parseInt(ui.qualityRange.value, 10) / 100;
  const isA4 = ui.pdfMode.value === "a4";
  const pageChunks = [];

  if (!isA4) {
    pageChunks.push({
      dataUrl: canvas.toDataURL("image/jpeg", quality),
      w: canvas.width,
      h: canvas.height,
    });
  } else {
    const pageH = Math.round(canvas.width * 1.4142);
    let y = 0;
    while (y < canvas.height) {
      const sliceH = Math.min(pageH, canvas.height - y);
      const c = document.createElement("canvas");
      c.width = canvas.width;
      c.height = sliceH;
      c.getContext("2d").drawImage(
        canvas,
        0,
        y,
        canvas.width,
        sliceH,
        0,
        0,
        canvas.width,
        sliceH,
      );
      pageChunks.push({
        dataUrl: c.toDataURL("image/jpeg", quality),
        w: c.width,
        h: c.height,
      });
      y += sliceH;
    }
  }

  const pdfParts = [];
  const offsets = [];
  let length = 0;
  const addStr = (s) => {
    const b = new TextEncoder().encode(s);
    pdfParts.push(b);
    length += b.length;
  };
  const addBytes = (b) => {
    pdfParts.push(b);
    length += b.length;
  };
  const markObj = () => offsets.push(length);

  addStr("%PDF-1.4\n");
  markObj();
  addStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  const pageKids = pageChunks.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  markObj();
  addStr(
    `2 0 obj\n<< /Type /Pages /Kids [${pageKids}] /Count ${pageChunks.length} >>\nendobj\n`,
  );

  pageChunks.forEach((chunk, idx) => {
    const pageObjId = 3 + idx * 3;
    const imgObjId = pageObjId + 1;
    const contentObjId = pageObjId + 2;

    const bin = atob(chunk.dataUrl.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    markObj();
    addStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 ${imgObjId} 0 R >> >> /MediaBox [0 0 ${chunk.w} ${chunk.h}] /Contents ${contentObjId} 0 R >>\nendobj\n`,
    );

    markObj();
    addStr(
      `${imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${chunk.w} /Height ${chunk.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
    );
    addBytes(bytes);
    addStr("\nendstream\nendobj\n");

    const stream = `q ${chunk.w} 0 0 ${chunk.h} 0 0 cm /Im0 Do Q`;
    markObj();
    addStr(
      `${contentObjId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

  const xrefOffset = length;
  const totalObjs = offsets.length + 1;
  addStr(`xref\n0 ${totalObjs}\n0000000000 65535 f \n`);
  offsets.forEach((off) =>
    addStr(String(off).padStart(10, "0") + " 00000 n \n"),
  );
  addStr(
    `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  );

  const pdfBlob = new Blob(pdfParts, { type: "application/pdf" });
  chrome.downloads.download({
    url: URL.createObjectURL(pdfBlob),
    filename: (ui.fileName.value.trim() || "screenshot") + ".pdf",
    saveAs: true,
  });
});

document.getElementById("btnCopy").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = old), 1600);
    } catch (err) {
      ui.dimBadge.textContent = "Image copy blocked — refocus and retry";
    }
  }, "image/png");
});

document.getElementById("btnBase64").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  copyText(canvas.toDataURL("image/png"), "Copied Base64");
  const old = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = old), 1600);
});

document
  .getElementById("btnPrint")
  .addEventListener("click", () => window.print());
