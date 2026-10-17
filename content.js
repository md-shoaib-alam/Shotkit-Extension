(() => {
  if (window.__shotkitListenerAdded) return;
  window.__shotkitListenerAdded = true;

  let fixedElements = [];
  let hiddenBanners = [];
  let styleTag = null;
  let scrollTarget = null;

  function findScrollableElement() {
    const docEl = document.scrollingElement || document.documentElement;
    if (docEl.scrollHeight > window.innerHeight + 10) {
      const bStyle = window.getComputedStyle(document.body);
      const hStyle = window.getComputedStyle(document.documentElement);
      if (bStyle.overflowY !== "hidden" && hStyle.overflowY !== "hidden")
        return docEl;
    }
    let bestEl = docEl;
    let maxScroll = docEl.scrollHeight;
    const candidates = document.querySelectorAll(
      'main, div, section, article, [class*="scroll"], [class*="content"]',
    );
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      const canScroll =
        ["auto", "scroll"].includes(style.overflowY) ||
        ["auto", "scroll"].includes(style.overflow);
      if (
        canScroll &&
        el.scrollHeight > el.clientHeight + 20 &&
        el.clientWidth > window.innerWidth * 0.4
      ) {
        if (el.scrollHeight > maxScroll) {
          maxScroll = el.scrollHeight;
          bestEl = el;
        }
      }
    }
    return bestEl;
  }

  function setScrollTop(el, y) {
    if (
      el === document.scrollingElement ||
      el === document.documentElement ||
      el === document.body
    ) {
      window.scrollTo({ top: y, left: 0, behavior: "instant" });
    } else {
      el.scrollTo({ top: y, left: 0, behavior: "instant" });
      el.scrollTop = y;
    }
  }

  function getScrollTop(el) {
    if (
      el === document.scrollingElement ||
      el === document.documentElement ||
      el === document.body
    ) {
      return window.scrollY || document.documentElement.scrollTop || 0;
    }
    return el.scrollTop || 0;
  }

  const DEFAULT_SKIP_CSS = new Set([
    "none",
    "normal",
    "auto",
    "static",
    "visible",
    "middle",
    "baseline",
    "0px",
    "rgba(0, 0, 0, 0)",
  ]);

  // The inspector HUD and its export modal are the extension's own chrome
  // sitting on someone else's page, so they carry the same two themes as the
  // popup and Studio. background.js tells us which one is active.
  const HUD_THEMES = {
    dark: {
      bg: "#09090b",
      card: "#121215",
      inset: "#18181b",
      border: "#27272a",
      swatchBorder: "#52525b",
      text: "#fafafa",
      body: "#d4d4d8",
      muted: "#a1a1aa",
      accent: "#10b981",
      onAccent: "#ffffff",
      chipBg: "#27272a",
      chipFg: "#ffffff",
      shadow: "rgba(0, 0, 0, 0.6)",
      modalShadow: "rgba(0, 0, 0, 0.8)",
      // Box-model rings, outermost first. Opaque because nesting translucent
      // fills composites them into one olive smear; the edge array draws each
      // ring's own border so the layers separate by line as well as hue.
      box: ["#2f2a1a", "#2c4022", "#57481f", "#24405c"],
      boxEdge: ["#a89352", "#82b566", "#c9ae4e", "#6fa8dd"],
    },
    light: {
      bg: "#ffffff",
      card: "#f8fafc",
      inset: "#f1f5f9",
      border: "#e2e8f0",
      swatchBorder: "#cbd5e1",
      text: "#0f172a",
      body: "#334155",
      muted: "#64748b",
      accent: "#059669",
      onAccent: "#ffffff",
      chipBg: "#e2e8f0",
      chipFg: "#0f172a",
      shadow: "rgba(15, 23, 42, 0.18)",
      modalShadow: "rgba(15, 23, 42, 0.3)",
      box: ["#fdf3d9", "#e3efd6", "#f7e6a8", "#cfe2f5"],
      boxEdge: ["#a67f22", "#5c8442", "#8a701d", "#4a7dab"],
    },
  };

  // Logical twins of a property we already print, or values derived from the
  // element's own box, so they differ from the probe on every element.
  const DERIVED_CSS = new Set([
    "block-size",
    "inline-size",
    "transform-origin",
    "perspective-origin",
    "contain-intrinsic-block-size",
    "contain-intrinsic-inline-size",
  ]);

  function escapeText(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).join(".")
        : "";
    return tag + cls;
  }

  function cssOverridesFor(el) {
    const s = window.getComputedStyle(el);
    // A bare same-tag element resolves the UA defaults for that tag, so a
    // value that differs from it was set by the page. Without this comparison
    // the export is ~140 lines of `border-collapse: separate` and
    // `animation-composition: replace` that nobody asked for.
    const probe = document.createElement(el.tagName.toLowerCase());
    document.documentElement.appendChild(probe);
    const ps = window.getComputedStyle(probe);
    const lines = [];
    try {
      for (const prop of s) {
        if (!prop || prop.startsWith("-") || prop.includes("_")) continue;
        if (DERIVED_CSS.has(prop)) continue;
        let v;
        try {
          v = s.getPropertyValue(prop);
        } catch (e) {
          continue;
        }
        if (!v || DEFAULT_SKIP_CSS.has(v)) continue;
        if (prop === "background-color" && v === "transparent") continue;
        let def;
        try {
          def = ps.getPropertyValue(prop);
        } catch (e) {
          def = null;
        }
        if (v === def) continue;
        lines.push(`  ${prop}: ${v};`);
      }
    } finally {
      probe.remove();
    }
    const sel = selectorFor(el);
    if (!lines.length) {
      return `/* ${sel} */\n/* no style overrides — the element uses browser defaults */`;
    }
    return `/* ${sel} */\n${sel} {\n${lines.join("\n")}\n}`;
  }

  function toJsxAttrName(name) {
    if (name === "class") return "className";
    if (name === "for") return "htmlFor";
    if (/^on[a-z]/.test(name)) {
      return (
        "on" +
        name
          .slice(2)
          .split("-")
          .map((p) => p[0].toUpperCase() + p.slice(1))
          .join("")
      );
    }
    if (name.startsWith("data-") || name.startsWith("aria-")) {
      return name.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());
    }
    return name;
  }

  function styleStringToObject(str) {
    const parts = [];
    let depth = 0,
      quote = null,
      cur = "";
    for (const ch of str) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === "(") {
        depth++;
        cur += ch;
      } else if (ch === ")") {
        depth--;
        cur += ch;
      } else if (ch === ";" && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const props = parts
      .map((p) => {
        const i = p.indexOf(":");
        if (i === -1) return null;
        const key = p.slice(0, i).trim().replace(/^-/, "");
        const rawVal = p.slice(i + 1).trim();
        if (!key || !rawVal) return null;
        const camel = key.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());
        const num = /^-?\d+(\.0+)?$/.exec(rawVal);
        return `${camel}: ${num ? num[0] : JSON.stringify(rawVal)}`;
      })
      .filter(Boolean);
    return props.length ? `{ ${props.join(", ")} }` : "";
  }

  function decodeEntities(s) {
    const map = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&apos;": "'",
      "&nbsp;": " ",
    };
    return String(s)
      .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => map[m])
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)));
  }

  function attrToJsx(name, value) {
    value = decodeEntities(value);
    if (name === "style") {
      const obj = styleStringToObject(value || "");
      return obj ? `style={${obj}}` : null;
    }
    const jsxName = toJsxAttrName(name);
    if (jsxName.startsWith("on") && /^[A-Za-z][\w]*$/.test(value || "")) {
      return `${jsxName}={${value}}`;
    }
    return `${jsxName}=${JSON.stringify(value == null ? "" : String(value))}`;
  }

  function toJsx(html) {
    const VOID = new Set([
      "area", "base", "br", "col", "embed", "hr", "img", "input",
      "link", "meta", "param", "source", "track", "wbr",
    ]);
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
    let out = "",
      last = 0,
      m;
    while ((m = re.exec(html))) {
      out += html.slice(last, m.index);
      last = re.lastIndex;
      if (m[0].startsWith("<!--")) continue;
      if (m[1]) {
        out += `</${m[1]}>`;
      } else {
        const tag = m[2];
        const attrsSrc = m[3] || "";
        const selfClose = m[4] === "/" || VOID.has(tag.toLowerCase());
        const ar = /([a-zA-Z-:@\[][^\s=]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        const rendered = [];
        const seen = new Set();
        let a;
        while ((a = ar.exec(attrsSrc))) {
          const name = a[1];
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const value =
            a[3] !== undefined
              ? a[3]
              : a[4] !== undefined
                ? a[4]
                : a[5] !== undefined
                  ? a[5]
                  : "";
          const attr = attrToJsx(name, value);
          if (attr) rendered.push(" " + attr);
        }
        out += `<${tag}${rendered.join("")}${selfClose ? " /" : ""}>`;
      }
    }
    out += html.slice(last);
    return out;
  }

  function shouldHideSticky(el, vw, vh) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!w || !h) return false;
    if (w * h > vw * vh * 0.5) return false;
    return h < vh * 0.35 || w < vw * 0.35;
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Reported raw: the page's own width and device ratio set how much of it is
  // worth capturing, and that decision belongs to the capture loop, not here.
  function measurePage() {
    if (!scrollTarget) scrollTarget = findScrollableElement();
    const fullHeight = Math.max(
      scrollTarget.scrollHeight,
      document.body.scrollHeight,
      window.innerHeight,
    );
    const isDocument =
      scrollTarget === document.scrollingElement ||
      scrollTarget === document.documentElement;
    const stepHeight = isDocument
      ? window.innerHeight
      : scrollTarget.clientHeight || window.innerHeight;
    const containerOffsetTop = isDocument
      ? 0
      : Math.max(0, scrollTarget.getBoundingClientRect().top);
    return {
      fullHeight: fullHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      stepHeight: stepHeight,
      containerOffsetTop: containerOffsetTop,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHsl({ r, g, b }) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h =
        max === rn
          ? (gn - bn) / d + (gn < bn ? 6 : 0)
          : max === gn
            ? (bn - rn) / d + 2
            : (rn - gn) / d + 4;
      h /= 6;
    }
    return {
      h: Math.round(h * 360),
      s: Math.round(s * 100),
      l: Math.round(l * 100),
    };
  }

  function colorFormats(hex) {
    const { r, g, b } = hexToRgb(hex);
    const { h, s, l } = rgbToHsl({ r, g, b });
    return {
      hex: hex.toUpperCase(),
      rgb: `rgb(${r}, ${g}, ${b})`,
      hsl: `hsl(${h}, ${s}%, ${l}%)`,
    };
  }

  // navigator.clipboard is missing on http pages, so keep the legacy path
  // that still works there.
  async function copyColor(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText =
        "position:fixed;top:-10px;left:-10px;opacity:0;pointer-events:none;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  function showColorChip(x, y, hex, theme, extra = {}) {
    document.getElementById("smColorChip")?.remove();
    const format = extra.format || "hex";
    const formats = colorFormats(hex);
    const chip = document.createElement("div");
    chip.id = "smColorChip";
    chip.style.cssText = `
      position: fixed; z-index: 2147483647; font-family: sans-serif;
      left: ${Math.max(8, Math.min(x, window.innerWidth - 212))}px;
      top: ${Math.max(8, Math.min(y, window.innerHeight - 100))}px;
      width: 196px; padding: 10px; border-radius: 10px;
      background: ${theme.bg}; color: ${theme.text};
      border: 1px solid ${theme.border}; box-shadow: 0 16px 32px ${theme.shadow};
    `;
    const picks = extra.picks || [];
    chip.innerHTML = `
      <style>
        #smColorChip button { transition: background 0.12s, color 0.12s; }
        #smColorChip button:hover { background: ${theme.chipBg}; color: ${theme.chipFg}; }
      </style>
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
        <span style="width:22px; height:22px; flex:none; border-radius:5px;
          border:1px solid ${theme.swatchBorder}; background:${formats.hex};"></span>
        <span data-value style="font-size:12px; font-weight:600; overflow-wrap:anywhere;">${formats[format]}</span>
        <button data-close aria-label="Dismiss" style="margin-left:auto; flex:none; background:none;
          border:none; color:${theme.muted}; cursor:pointer; font-size:11px;">&#10005;</button>
      </div>
      <div style="display:flex; gap:6px;">
        ${["hex", "rgb", "hsl"]
          .map(
            (k) =>
              `<button data-fmt="${k}" style="flex:1; padding:5px 0; cursor:pointer; text-transform:uppercase;
                font-size:11px; font-weight:600; border-radius:6px;
                background:${k === format ? theme.accent : theme.inset};
                border:1px solid ${theme.border};
                color:${k === format ? theme.onAccent : theme.body};">${k}</button>`,
          )
          .join("")}
      </div>
      ${
        picks.length > 1
          ? `<div style="margin-top:8px; padding-top:8px; border-top:1px solid ${theme.border};">
              <div style="font-size:10px; color:${theme.muted}; margin-bottom:5px;">
                Picks &middot; ${picks.length}</div>
              ${picks
                .map(
                  (item, i) =>
                    `<button data-pick="${i}" style="display:flex; align-items:center; gap:7px; width:100%;
                      padding:3px 4px; margin-bottom:2px; cursor:pointer; border-radius:6px; border:1px solid transparent;
                      background:${theme.inset}; color:${theme.body}; font-size:11px; font-weight:600;">
                      <span style="width:12px; height:12px; flex:none; border-radius:3px;
                        border:1px solid ${theme.swatchBorder}; background:${item};"></span>
                      ${item}</button>`,
                )
                .join("")}
            </div>`
          : ""
      }
      ${
        extra.onDone
          ? `<button data-done style="margin-top:8px; width:100%; padding:6px 0; cursor:pointer;
              border-radius:7px; border:1px solid ${theme.border};
              background:${theme.card}; color:${theme.text}; font-size:11px; font-weight:600;">
              Done &middot; Esc</button>`
          : ""
      }`;
    document.body.appendChild(chip);

    const value = chip.querySelector("[data-value]");
    // Rows copy in whichever format was chosen last, even after this render.
    let activeFormat = format;
    chip.querySelectorAll("[data-fmt]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        activeFormat = btn.dataset.fmt;
        const text = colorFormats(hex)[activeFormat];
        value.textContent = text;
        await copyColor(text);
        if (extra.onFormat) extra.onFormat(activeFormat);
      });
    });
    chip.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = colorFormats(picks[Number(btn.dataset.pick)])[activeFormat];
        value.textContent = text;
        copyColor(text);
      });
    });
    chip.querySelector("[data-close]").addEventListener("click", () => chip.remove());
    if (extra.onDone) {
      chip.querySelector("[data-done]").addEventListener("click", extra.onDone);
    }
    copyColor(formats.hex);
  }

  const PICK_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <g fill="none" stroke-linecap="round">
      <path d="M15.9 3.4 22.6 10.1" stroke="#0f172a" stroke-width="4.6"/>
      <path d="M15.9 3.4 22.6 10.1" stroke="#ffffff" stroke-width="2.4"/>
      <path d="M18 7.4 9.3 16.1" stroke="#0f172a" stroke-width="3.8"/>
      <path d="M18 7.4 9.3 16.1" stroke="#ffffff" stroke-width="1.9"/>
      <path d="M9.1 16.3 4.6 23.2" stroke="#0f172a" stroke-width="3"/>
      <path d="M9.1 16.3 4.6 23.2" stroke="#10b981" stroke-width="1.3"/>
    </g></svg>`;

  // Hotspot is the dropper tip, so the sampled pixel is the one the tip points at.
  const PICK_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
    PICK_CURSOR_SVG,
  )}") 5 23, crosshair`;

  const PICK_HINT =
    "Click a colour to copy it &middot; pick as many as you need &middot; Esc to stop";

  function createPickBadge(theme) {
    const badge = document.createElement("div");
    badge.id = "smPickBadge";
    badge.style.cssText = `
      position: fixed; z-index: 2147483647; pointer-events: none; display: none;
      align-items: center; gap: 6px; padding: 5px 7px;
      border-radius: 7px; font-family: sans-serif; font-size: 11px; font-weight: 600;
      background: ${theme.bg}; color: ${theme.text};
      border: 1px solid ${theme.border}; box-shadow: 0 8px 20px ${theme.shadow};`;
    badge.innerHTML = `<span data-dot style="width:13px; height:13px; flex:none; border-radius:4px;
      border:1px solid ${theme.swatchBorder};"></span><span data-hex>&mdash;</span>`;
    const dot = badge.querySelector("[data-dot]");
    const hexLabel = badge.querySelector("[data-hex]");
    document.body.appendChild(badge);
    return {
      el: badge,
      // null hex means the frame behind the pointer is no longer trustworthy.
      show(x, y, hex) {
        badge.style.display = "flex";
        hexLabel.textContent = hex || "\u2014";
        dot.style.background = hex || "transparent";
        const flipX = x > window.innerWidth - 130;
        const flipY = y > window.innerHeight - 60;
        badge.style.left = (flipX ? x - 118 : x + 16) + "px";
        badge.style.top = (flipY ? y - 34 : y + 18) + "px";
      },
      remove() {
        badge.remove();
      },
    };
  }

  function showPickNotice(theme, text) {
    document.getElementById("smPickNotice")?.remove();
    const pill = document.createElement("div");
    pill.id = "smPickNotice";
    pill.style.cssText = `
      position: fixed; z-index: 2147483647; left: 50%; top: 12px;
      transform: translateX(-50%); max-width: 92vw; padding: 9px 13px;
      border-radius: 9px; font-family: sans-serif; font-size: 12px;
      background: ${theme.bg}; color: ${theme.text};
      border: 1px solid ${theme.border}; box-shadow: 0 16px 32px ${theme.shadow};`;
    pill.textContent = text;
    document.body.appendChild(pill);
    setTimeout(() => pill.remove(), 5000);
    return pill;
  }

  async function requestVisibleFrame() {
    try {
      return await chrome.runtime.sendMessage({ action: "GET_VISIBLE_BITMAP" });
    } catch (e) {
      return null;
    }
  }

  // Reads true rendered pixels off a still shot of the tab, so canvas art,
  // images and gradients all answer. Chrome does not expose the native
  // EyeDropper to an injected script, and this path needs no user gesture.
  async function grabFrame() {
    const frame = await requestVisibleFrame();
    if (!frame || !frame.dataUrl) return null;
    const img = new Image();
    const loaded = await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = frame.dataUrl;
    });
    if (!loaded) return null;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx || !canvas.width || !canvas.height) return null;
    ctx.drawImage(img, 0, 0);
    return ctx;
  }

  function hexFromFrame(ctx, x, y, dpr) {
    const sx = Math.min(ctx.canvas.width - 1, Math.max(0, Math.round(x * dpr)));
    const sy = Math.min(ctx.canvas.height - 1, Math.max(0, Math.round(y * dpr)));
    const [r, g, b] = ctx.getImageData(sx, sy, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  const MAX_PICKS = 12;
  const FRAME_REFRESH_MS = 250;

  async function startColorPicker(themeName) {
    const theme = HUD_THEMES[themeName === "dark" ? "dark" : "light"];
    if (document.getElementById("smPickVeil")) return;

    let ctx = await grabFrame();
    if (!ctx) {
      showPickNotice(
        theme,
        "Shotkit could not read this tab, so there is no colour to sample. Reload the page and try again.",
      );
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const picks = [];
    let format = "hex";
    // False between a scroll and the retake that follows it: until then every
    // pixel in the still shot belongs to a page that is no longer there.
    let frameIsCurrent = true;
    let pointer = { x: -1, y: -1 };

    const veil = document.createElement("div");
    veil.id = "smPickVeil";
    // Deliberately untinted: the sampler shows the user the same pixels they
    // are picking from, so any dimming here would make the copied colour
    // disagree with what is on screen under the tip.
    veil.style.cssText = `position:fixed; inset:0; z-index:2147483646; background:none; cursor:${PICK_CURSOR};`;
    veil.innerHTML = `<div style="position:absolute; top:12px; left:50%; transform:translateX(-50%);
      padding:9px 13px; border-radius:9px; font-family:sans-serif; font-size:12px;
      background:${theme.bg}; color:${theme.text}; border:1px solid ${theme.border};
      box-shadow:0 16px 32px ${theme.shadow};">${PICK_HINT}</div>`;
    document.body.appendChild(veil);

    const badge = createPickBadge(theme);

    let frameQueued = false;
    const paintBadge = () => {
      badge.show(
        pointer.x,
        pointer.y,
        frameIsCurrent
          ? hexFromFrame(ctx, pointer.x, pointer.y, dpr).toUpperCase()
          : null,
      );
    };
    const onMove = (ev) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      // One pixel read per animation frame keeps getImageData off the move path.
      if (frameQueued) return;
      frameQueued = true;
      requestAnimationFrame(() => {
        frameQueued = false;
        paintBadge();
      });
    };

    let refreshTimer = null;
    let refreshing = false;
    let retakeWanted = false;
    let stopped = false;
    const scheduleRetake = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (stopped) return;
        // A scroll during a capture means that capture is already history;
        // mark it and the tail below takes a third pass.
        if (refreshing) {
          retakeWanted = true;
          return;
        }
        retakeWanted = false;
        refreshing = true;
        grabFrame().then((next) => {
          refreshing = false;
          if (stopped) return;
          if (!next) {
            showPickNotice(
              theme,
              "Shotkit lost the tab while you were picking, so colours stopped updating.",
            );
            return;
          }
          ctx = next;
          frameIsCurrent = true;
          if (pointer.x >= 0) paintBadge();
          if (retakeWanted) scheduleRetake();
        });
      }, FRAME_REFRESH_MS);
    };
    const onPageMoved = () => {
      if (frameIsCurrent) {
        frameIsCurrent = false;
        if (pointer.x >= 0) badge.show(pointer.x, pointer.y, null);
      }
      scheduleRetake();
    };

    const finish = () => {
      stopped = true;
      veil.remove();
      badge.remove();
      veil.removeEventListener("click", onPick, true);
      veil.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onPageMoved, true);
      window.removeEventListener("resize", onPageMoved, true);
      if (refreshTimer) clearTimeout(refreshTimer);
    };

    function onPick(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      // A stale frame would hand back a colour from before the scroll.
      if (!frameIsCurrent) return;
      const hex = hexFromFrame(ctx, ev.clientX, ev.clientY, dpr).toUpperCase();
      picks.unshift(hex);
      if (picks.length > MAX_PICKS) picks.length = MAX_PICKS;
      showColorChip(ev.clientX, ev.clientY, hex, theme, {
        picks,
        format,
        onFormat: (next) => {
          format = next;
        },
        onDone: finish,
      });
    }

    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        finish();
      }
    };

    veil.addEventListener("click", onPick, true);
    veil.addEventListener("pointermove", onMove, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onPageMoved, true);
    window.addEventListener("resize", onPageMoved, true);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "preparePage") {
      scrollTarget = findScrollableElement();
      if (styleTag) styleTag.remove();
      styleTag = document.createElement("style");
      let css = `* { scroll-behavior: auto !important; transition: none !important; } `;
      if (request.hideScroll)
        css += `::-webkit-scrollbar { display: none !important; } `;
      if (request.forceDark)
        css += `html { filter: invert(1) hue-rotate(180deg) !important; background: #111 !important; }`;
      styleTag.textContent = css;
      document.head.appendChild(styleTag);

      if (request.killCookies) {
        const selectors = [
          '[id*="cookie" i]',
          '[class*="cookie" i]',
          '[id*="gdpr" i]',
          '[class*="consent" i]',
          "#onetrust-banner-sdk",
        ];
        document.querySelectorAll(selectors.join(",")).forEach((el) => {
          const s = window.getComputedStyle(el);
          if (
            s.position === "fixed" ||
            s.position === "sticky" ||
            parseInt(s.zIndex, 10) > 50
          ) {
            hiddenBanners.push({ el, vis: el.style.visibility });
            el.style.visibility = "hidden";
          }
        });
      }

      sendResponse({
        ...measurePage(),
        originalScrollY: getScrollTop(scrollTarget),
        title: document.title,
        url: window.location.href,
      });
      return false;
    } else if (request.action === "measurePage") {
      sendResponse(measurePage());
      return false;
    } else if (request.action === "scrollTo") {
      if (!scrollTarget) scrollTarget = findScrollableElement();
      setScrollTop(scrollTarget, request.y);

      if (request.hideFixed && request.y > 0) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        document.querySelectorAll("*").forEach((el) => {
          if (!shouldHideSticky(el, vw, vh)) return;
          const style = window.getComputedStyle(el);
          if (
            (style.position === "fixed" || style.position === "sticky") &&
            el !== scrollTarget &&
            !el.contains(scrollTarget)
          ) {
            if (!fixedElements.some((item) => item.el === el)) {
              fixedElements.push({
                el,
                originalVisibility: el.style.visibility,
              });
            }
            el.style.visibility = "hidden";
          }
        });
      }

      // The scroll itself is instant, so the only reason to wait is lazy-load.
      // A stop is ready when nothing intersecting it is still decoding and the
      // document has stopped growing, because a block that injects markup
      // after its images land would otherwise be photographed half-built.
      // `speed` stays the ceiling for both, never a fixed sleep per slice.
      const cap = Math.max(150, request.speed || 550);
      const startedAt = performance.now();
      const pageHeight = () =>
        Math.max(scrollTarget.scrollHeight, document.body.scrollHeight);
      const pendingInView = () => {
        let n = 0;
        for (const img of document.images) {
          if (img.complete && img.naturalWidth !== 0) continue;
          const r = img.getBoundingClientRect();
          if (r.bottom > 0 && r.top < window.innerHeight) n++;
        }
        return n;
      };
      let lastHeight = pageHeight();
      let stableReads = 0;
      const settle = () => {
        const waited = performance.now() - startedAt;
        const height = pageHeight();
        stableReads = height === lastHeight ? stableReads + 1 : 0;
        lastHeight = height;
        const busy =
          waited < 40 ||
          (pendingInView() > 0 && waited < cap) ||
          (stableReads < 1 && waited < cap);
        if (busy) {
          setTimeout(settle, 24);
          return;
        }
        sendResponse({ actualScrollY: getScrollTop(scrollTarget) });
      };
      settle();
      return true;
    } else if (request.action === "restorePage") {
      fixedElements.forEach((item) => {
        item.el.style.visibility = item.originalVisibility;
      });
      fixedElements = [];
      hiddenBanners.forEach((item) => {
        item.el.style.visibility = item.vis;
      });
      hiddenBanners = [];
      if (styleTag) {
        styleTag.remove();
        styleTag = null;
      }
      if (scrollTarget) setScrollTop(scrollTarget, request.y || 0);
      sendResponse({ done: true });
      return false;
    } else if (request.action === "selectRegion") {
      const overlay = document.createElement("div");
      overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:rgba(9,9,11,0.45);cursor:crosshair;`;
      const box = document.createElement("div");
      box.style.cssText = `position:fixed;border:1.5px solid #10b981;background:rgba(16,185,129,0.12);display:none;pointer-events:none;`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      let sx = 0,
        sy = 0,
        dragging = false;
      const onEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          cleanup();
          document.removeEventListener("mousemove", onMoveSel, true);
          sendResponse(null);
        }
      };
      const cleanup = () => {
        overlay.remove();
        window.removeEventListener("keydown", onEsc, true);
      };
      const onMoveSel = (e) => {
        if (!dragging) return;
        box.style.left = Math.min(sx, e.clientX) + "px";
        box.style.top = Math.min(sy, e.clientY) + "px";
        box.style.width = Math.abs(e.clientX - sx) + "px";
        box.style.height = Math.abs(e.clientY - sy) + "px";
      };
      overlay.addEventListener("mousedown", (e) => {
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        box.style.display = "block";
      });
      overlay.addEventListener("mousemove", onMoveSel);
      window.addEventListener("keydown", onEsc, true);
      overlay.addEventListener("mouseup", (e) => {
        if (!dragging) return;
        dragging = false;
        const rect = {
          x: Math.min(sx, e.clientX),
          y: Math.min(sy, e.clientY),
          width: Math.abs(e.clientX - sx),
          height: Math.abs(e.clientY - sy),
        };
        cleanup();
        document.removeEventListener("mousemove", onMoveSel);
        sendResponse(rect);
      });
      return true;
    } else if (request.action === "selectElement") {
      const highlight = document.createElement("div");
      highlight.style.cssText = `position:fixed;border:2px solid #10b981;background:rgba(16,185,129,0.12);pointer-events:none;z-index:2147483647;`;
      document.body.appendChild(highlight);
      let currentRect = null;
      const onKey = (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          cleanup();
          sendResponse(null);
        }
      };
      const cleanup = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        window.removeEventListener("keydown", onKey, true);
        highlight.remove();
      };
      const onMove = (e) => {
        highlight.style.display = "none";
        const el = document.elementFromPoint(e.clientX, e.clientY);
        highlight.style.display = "";
        if (!el) return;
        const r = el.getBoundingClientRect();
        currentRect = {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          width: r.width,
          height: r.height,
        };
        highlight.style.left = currentRect.x + "px";
        highlight.style.top = currentRect.y + "px";
        highlight.style.width = currentRect.width + "px";
        highlight.style.height = currentRect.height + "px";
      };
      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        sendResponse(currentRect);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKey, true);
      return true;
    } else if (request.action === "launchColorPicker") {
      startColorPicker(request.theme);
      sendResponse({ started: true });
    } else if (request.action === "launchStyleInspector") {
      if (document.getElementById("shotkitStyleHUD")) return;

      const theme = HUD_THEMES[request.theme === "dark" ? "dark" : "light"];
      const hud = document.createElement("div");
      hud.id = "shotkitStyleHUD";
      hud.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 360px; background: ${theme.bg}; color: ${theme.text};
        border: 1px solid ${theme.border}; border-radius: 10px; padding: 14px; font-family: sans-serif; font-size: 12px;
        z-index: 2147483647; box-shadow: 0 20px 40px ${theme.shadow};
      `;
      hud.innerHTML = `
        <style>
          #smCloseHUD { transition: background 0.12s, border-color 0.12s, color 0.12s; }
          #smCloseHUD:hover {
            background: ${theme.chipBg};
            border-color: ${theme.swatchBorder};
            color: ${theme.text};
          }
        </style>
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
          <div style="font-weight:700; color:${theme.accent}; line-height:1.35;">Style &amp; Element Inspector</div>
          <button id="smCloseHUD" aria-label="Close inspector" title="Close" style="flex:none; width:22px; height:22px; display:flex; align-items:center; justify-content:center; background:${theme.inset}; color:${theme.muted}; border:1px solid ${theme.border}; border-radius:6px; font-size:12px; line-height:1; cursor:pointer;">✕</button>
        </div>
        <div style="font-size:10px; color:${theme.muted}; margin:3px 0 10px;">Click = export · Alt+Click = measure</div>
        <div id="smStyleContent" style="display:flex; flex-direction:column; gap:4px; max-height:210px; overflow-y:auto; color:${theme.body}; line-height:1.45; overflow-wrap:anywhere;">
          Hover any element...
        </div>
        <div id="smBoxModel" style="margin-top:10px; display:none;"></div>
        <div id="smAnchorNote" style="margin-top:8px; font-size:10px; color:${theme.accent}; display:none;"></div>
      `;
      document.body.appendChild(hud);

      const highlight = document.createElement("div");
      highlight.style.cssText = `position:fixed; border:2px solid #3b82f6; background:rgba(59,130,246,0.1); pointer-events:none; z-index:2147483646; transition:all 0.05s;`;
      document.body.appendChild(highlight);

      const measure = document.createElement("div");
      measure.id = "smMeasureLayer";
      measure.style.cssText = `position:fixed; inset:0; pointer-events:none; z-index:2147483645;`;
      document.body.appendChild(measure);

      let anchorEl = null;
      const pxOf = (v) => Math.round(parseFloat(v)) || 0;
      const boxOf = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };

      const cells = (vals) =>
        `<span style="min-width:16px; text-align:right;">${vals.join(
          "</span><span style=\"min-width:16px; text-align:right;\">",
        )}</span>`;

      function ring(label, values, inner, i) {
        return `<div style="background:${theme.box[i]}; border:1px solid ${theme.boxEdge[i]}; border-radius:5px; padding:5px 6px; font-size:10px;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;${inner ? " margin-bottom:3px;" : ""}">
            <span style="color:${theme.body}">${label}</span>
            <span style="display:flex; gap:7px; color:${theme.text}; font-variant-numeric:tabular-nums;">${values}</span>
          </div>${inner || ""}</div>`;
      }

      function boxModelHtml(el) {
        const s = window.getComputedStyle(el);
        const m = [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].map(pxOf);
        const bd = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(pxOf);
        const p = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(pxOf);
        const cw = Math.max(0, (el.clientWidth || 0) - p[1] - p[3]);
        const ch = Math.max(0, (el.clientHeight || 0) - p[0] - p[2]);
        return ring(
          "margin",
          cells(m),
          ring(
            "border",
            cells(bd),
            ring("padding", cells(p), ring("content", `${cw} × ${ch}`, "", 3), 2),
            1,
          ),
          0,
        );
      }

      function paint(node) {
        measure.appendChild(node);
      }

      function outline(el, color) {
        const r = boxOf(el);
        const d = document.createElement("div");
        d.style.cssText = `position:fixed; left:${r.left}px; top:${r.top}px; width:${r.right - r.left}px; height:${r.bottom - r.top}px; border:1px solid ${color}; background:${color.replace("rgb", "rgba").replace(")", ",0.08)")};`;
        paint(d);
      }

      function guide(x, y, w, h, label, vertical) {
        const line = document.createElement("div");
        line.style.cssText = `position:fixed; left:${x}px; top:${y}px; width:${w}px; height:${h}px; background:repeating-linear-gradient(${vertical ? "to bottom" : "to right"}, ${theme.accent} 0 4px, transparent 4px 8px);`;
        paint(line);
        const tag = document.createElement("div");
        tag.textContent = label;
        tag.style.cssText = `position:fixed; left:${x + w / 2}px; top:${y + h / 2}px; transform:translate(-50%,-50%); background:${theme.accent}; color:#000; font-size:10px; font-weight:700; padding:1px 5px; border-radius:3px; font-family:sans-serif;`;
        paint(tag);
      }

      function drawGap(a, b) {
        let dx = 0;
        if (b.left >= a.right) dx = b.left - a.right;
        else if (a.left >= b.right) dx = a.left - b.right;
        if (dx > 0) {
          const yMid = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
          guide(a.right < b.left ? a.right : b.right, yMid, dx, 1, `${Math.round(dx)}px`, false);
        }
        let dy = 0;
        if (b.top >= a.bottom) dy = b.top - a.bottom;
        else if (a.top >= b.bottom) dy = a.top - b.bottom;
        if (dy > 0) {
          const xMid = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
          guide(xMid, a.bottom < b.top ? a.bottom : b.bottom, 1, dy, `${Math.round(dy)}px`, true);
        }
      }

      function redrawMeasure(target) {
        measure.innerHTML = "";
        if (!anchorEl || !document.contains(anchorEl)) {
          anchorEl = null;
          return;
        }
        outline(anchorEl, "rgb(16,185,129)");
        if (target && target !== anchorEl) {
          outline(target, "rgb(59,130,246)");
          drawGap(boxOf(anchorEl), boxOf(target));
        }
      }

      let frozen = false;

      const cleanupInspector = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        window.removeEventListener("keydown", onKey, true);
        hud.remove();
        highlight.remove();
        measure.remove();
        const existingModal = document.getElementById("smCodeModal");
        if (existingModal) existingModal.remove();
      };

      document.getElementById("smCloseHUD").addEventListener("click", (e) => {
        e.stopPropagation();
        cleanupInspector();
      });

      const onMove = (e) => {
        if (frozen) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === hud || hud.contains(el)) return;

        const r = el.getBoundingClientRect();
        highlight.style.left = r.left + "px";
        highlight.style.top = r.top + "px";
        highlight.style.width = r.width + "px";
        highlight.style.height = r.height + "px";

        const s = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const isTransparent =
          !s.backgroundColor ||
          s.backgroundColor === "transparent" ||
          s.backgroundColor === "rgba(0, 0, 0, 0)";
        const swatch = (c) =>
          `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;border:1px solid ${theme.swatchBorder};background:${c};vertical-align:-1px;margin-right:5px;"></span>`;
        const row = (k, v) => `<div><strong>${k}:</strong> ${v}</div>`;
        const clip = (v, n) => (v.length > n ? v.slice(0, n) + "…" : v);
        const shadow = s.boxShadow && s.boxShadow !== "none" ? s.boxShadow : "none";
        const styles = [
          row("Element", `&lt;${escapeText(selectorFor(el))}&gt;`),
          row(
            "Box",
            `${Math.round(rect.width)} × ${Math.round(rect.height)}`,
          ),
          row(
            "Font",
            clip(
              `${s.fontFamily.split(",")[0].replace(/["']/g, "")} ${s.fontSize} / ${s.fontWeight}`,
              34,
            ),
          ),
          row("Line height", s.lineHeight),
          row("Color", `${swatch(s.color)}${s.color}`),
          isTransparent
            ? ""
            : row("Background", `${swatch(s.backgroundColor)}${s.backgroundColor}`),
          row("Radius", s.borderRadius),
          row("Shadow", clip(shadow, 40)),
        ].join("");
        document.getElementById("smStyleContent").innerHTML = styles;

        const box = document.getElementById("smBoxModel");
        box.innerHTML = boxModelHtml(el);
        box.style.display = "block";
        redrawMeasure(el);
      };

      const onClick = (e) => {
        // This listener is on document in the capture phase, so it runs
        // before the modal's own button handlers. Without this guard a click
        // on Copy or a tab tore the modal down and reopened it for whatever
        // element happened to be underneath.
        if (hud.contains(e.target) || e.target.closest("#smCodeModal")) return;
        const prevModal = document.getElementById("smCodeModal");
        if (prevModal) prevModal.remove();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || hud.contains(el)) return;

        if (e.altKey) {
          anchorEl = el;
          const note = document.getElementById("smAnchorNote");
          note.textContent = `Measuring from <${el.tagName.toLowerCase()}> · hover another element to see the gap`;
          note.style.display = "block";
          redrawMeasure(el);
          return;
        }

        frozen = true;

        const cssCode = cssOverridesFor(el);
        const htmlCode = el.outerHTML;
        const jsxCode = toJsx(htmlCode);
        const tabs = [
          { id: "css", label: "CSS", code: cssCode, file: "element.css" },
          { id: "html", label: "HTML", code: htmlCode, file: "element.html" },
          { id: "jsx", label: "JSX", code: jsxCode, file: "Element.jsx" },
        ];
        let activeTab = "css";

        const modal = document.createElement("div");
        modal.id = "smCodeModal";
        modal.style.cssText = `
          position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 520px; max-width: 92vw;
          background: ${theme.card}; color: ${theme.text}; border: 1px solid ${theme.border}; border-radius: 12px;
          padding: 20px; z-index: 2147483647; box-shadow: 0 30px 60px ${theme.modalShadow}; font-family: sans-serif;
        `;
        modal.innerHTML = `
          <div style="font-weight:700; font-size:15px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
            <span>Export Element Code</span>
            <button id="smCloseModal" style="background:transparent; color:${theme.muted}; border:none; font-size:16px; cursor:pointer;">✕</button>
          </div>
          <div id="smTabs" style="display:flex; gap:6px; margin-bottom:10px;"></div>
          <textarea id="smCodeArea" readonly style="width:100%; height:260px; background:${theme.bg}; color:${theme.body}; border:1px solid ${theme.border}; border-radius:6px; padding:10px; font-family:monospace; font-size:11px; resize:vertical;"></textarea>
          <div style="display:flex; gap:8px; margin-top:14px;">
            <button id="smCopyCode" style="flex:1; padding:9px; background:${theme.accent}; color:${theme.onAccent}; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Copy</button>
            <button id="smDownloadCode" style="flex:1; padding:9px; background:${theme.chipBg}; color:${theme.chipFg}; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Download File</button>
          </div>
        `;
        document.body.appendChild(modal);

        const tabsWrap = modal.querySelector("#smTabs");
        const area = modal.querySelector("#smCodeArea");

        function renderTabs() {
          tabsWrap.innerHTML = "";
          tabs.forEach((t) => {
            const b = document.createElement("button");
            b.textContent = t.label;
            b.style.cssText = `padding:6px 16px; border-radius:6px; border:1px solid ${theme.border}; cursor:pointer; font-weight:600; font-size:12px; ${
              t.id === activeTab
                ? `background:${theme.accent}; color:${theme.onAccent}; border-color:${theme.accent};`
                : `background:${theme.inset}; color:${theme.muted};`
            }`;
            b.onclick = () => {
              activeTab = t.id;
              renderTabs();
            };
            tabsWrap.appendChild(b);
          });
          const cur = tabs.find((t) => t.id === activeTab);
          area.value = cur.code;
          modal.querySelector("#smDownloadCode").textContent =
            "Download " + cur.file;
        }
        renderTabs();

        modal.querySelector("#smCloseModal").onclick = () => {
          modal.remove();
          frozen = false;
        };
        modal.querySelector("#smCopyCode").onclick = async (ev) => {
          const btn = ev.currentTarget;
          try {
            await navigator.clipboard.writeText(area.value);
            btn.textContent = "Copied!";
          } catch (err) {
            area.select();
            document.execCommand("copy");
            btn.textContent = "Copied!";
          }
          setTimeout(() => (btn.textContent = "Copy"), 1400);
        };
        modal.querySelector("#smDownloadCode").onclick = () => {
          const cur = tabs.find((t) => t.id === activeTab);
          downloadText(cur.file, cur.code);
        };
      };

      const onKey = (e) => {
        if (e.key !== "Escape") return;
        if (anchorEl) {
          anchorEl = null;
          measure.innerHTML = "";
          document.getElementById("smAnchorNote").style.display = "none";
          return;
        }
        cleanupInspector();
      };

      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKey, true);
      sendResponse({ success: true });
      return false;
    }
  });
})();
