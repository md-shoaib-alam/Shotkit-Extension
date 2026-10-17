(() => {
  if (window.__snapMasterListenerAdded) return;
  window.__snapMasterListenerAdded = true;

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

  function fullCssFor(el) {
    const s = window.getComputedStyle(el);
    const lines = [];
    for (const prop of s) {
      if (!prop || prop.startsWith("-") || prop.includes("_")) continue;
      let v;
      try {
        v = s.getPropertyValue(prop);
      } catch (e) {
        continue;
      }
      if (!v || DEFAULT_SKIP_CSS.has(v)) continue;
      if (prop === "background-color" && v === "transparent") continue;
      lines.push(`  ${prop}: ${v};`);
    }
    const tag = el.tagName.toLowerCase();
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).join(".")
        : "";
    return `/* ${tag}${cls} */\n${tag}${cls} {\n${lines.join("\n")}\n}`;
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

      sendResponse({
        fullHeight: Math.min(fullHeight, 16000),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        stepHeight: stepHeight,
        containerOffsetTop: containerOffsetTop,
        devicePixelRatio: window.devicePixelRatio || 1,
        originalScrollY: getScrollTop(scrollTarget),
        title: document.title,
        url: window.location.href,
      });
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

      setTimeout(
        () => {
          sendResponse({ actualScrollY: getScrollTop(scrollTarget) });
        },
        Math.max(520, request.speed || 550),
      );
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
    } else if (request.action === "launchStyleInspector") {
      if (document.getElementById("snapMasterStyleHUD")) return;

      const hud = document.createElement("div");
      hud.id = "snapMasterStyleHUD";
      hud.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 360px; background: #09090b; color: #fafafa;
        border: 1px solid #27272a; border-radius: 10px; padding: 14px; font-family: sans-serif; font-size: 12px;
        z-index: 2147483647; box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      `;
      hud.innerHTML = `
        <div style="font-weight:700; color:#10b981; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          <span>🎨 Style & Element Inspector</span>
          <div>
            <span style="font-size:10px; color:#a1a1aa; margin-right:8px;">Click = export · Alt+Click = measure</span>
            <button id="smCloseHUD" style="background:#27272a; color:#fff; border:none; padding:2px 6px; border-radius:4px; cursor:pointer;">✕</button>
          </div>
        </div>
        <div id="smStyleContent" style="display:flex; flex-direction:column; gap:4px; max-height:170px; overflow-y:auto; color:#d4d4d8;">
          Hover any element...
        </div>
        <div id="smBoxModel" style="margin-top:10px; display:none;"></div>
        <div id="smAnchorNote" style="margin-top:8px; font-size:10px; color:#10b981; display:none;"></div>
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

      function layer(label, vals, inner, bg) {
        return `<div style="background:${bg}; padding:5px 6px; border-radius:4px; font-size:10px; color:#e4e4e7;">
          <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
            <span style="opacity:.6">${label}</span><span>${vals.join("  ")}</span>
          </div>${inner}</div>`;
      }

      function boxModelHtml(el) {
        const s = window.getComputedStyle(el);
        const m = [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].map(pxOf);
        const bd = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(pxOf);
        const p = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(pxOf);
        const cw = Math.max(0, (el.clientWidth || 0) - p[1] - p[3]);
        const ch = Math.max(0, (el.clientHeight || 0) - p[0] - p[2]);
        const content = `<div style="background:rgba(74,144,226,.35); border-radius:4px; padding:5px 6px; font-size:10px; display:flex; justify-content:space-between;">
          <span style="opacity:.6">content</span><span>${cw} × ${ch}</span></div>`;
        return layer(
          "margin",
          m,
          layer(
            "border",
            bd,
            layer("padding", p, content, "rgba(253,224,139,.3)"),
            "rgba(196,224,150,.3)",
          ),
          "rgba(249,215,126,.22)",
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
        line.style.cssText = `position:fixed; left:${x}px; top:${y}px; width:${w}px; height:${h}px; background:repeating-linear-gradient(${vertical ? "to bottom" : "to right"}, #10b981 0 4px, transparent 4px 8px);`;
        paint(line);
        const tag = document.createElement("div");
        tag.textContent = label;
        tag.style.cssText = `position:fixed; left:${x + w / 2}px; top:${y + h / 2}px; transform:translate(-50%,-50%); background:#10b981; color:#000; font-size:10px; font-weight:700; padding:1px 5px; border-radius:3px; font-family:sans-serif;`;
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
        const styles = `
          <div><strong>Tag:</strong> &lt;${el.tagName.toLowerCase()}&gt;</div>
          <div><strong>Font:</strong> ${s.fontFamily.slice(0, 28)}</div>
          <div><strong>Size / Weight:</strong> ${s.fontSize} / ${s.fontWeight}</div>
          <div><strong>Color:</strong> <span style="color:${s.color}">${s.color}</span></div>
          <div><strong>Background:</strong> ${s.backgroundColor}</div>
          <div><strong>Radius / Shadow:</strong> ${s.borderRadius}</div>
        `;
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

        const cssCode = fullCssFor(el);
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
          background: #121215; color: #fafafa; border: 1px solid #27272a; border-radius: 12px;
          padding: 20px; z-index: 2147483647; box-shadow: 0 30px 60px rgba(0,0,0,0.8); font-family: sans-serif;
        `;
        modal.innerHTML = `
          <div style="font-weight:700; font-size:15px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
            <span>✨ Export Element Code</span>
            <button id="smCloseModal" style="background:transparent; color:#a1a1aa; border:none; font-size:16px; cursor:pointer;">✕</button>
          </div>
          <div id="smTabs" style="display:flex; gap:6px; margin-bottom:10px;"></div>
          <textarea id="smCodeArea" readonly style="width:100%; height:260px; background:#09090b; color:#d4d4d8; border:1px solid #27272a; border-radius:6px; padding:10px; font-family:monospace; font-size:11px; resize:vertical;"></textarea>
          <div style="display:flex; gap:8px; margin-top:14px;">
            <button id="smCopyCode" style="flex:1; padding:9px; background:#10b981; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Copy</button>
            <button id="smDownloadCode" style="flex:1; padding:9px; background:#27272a; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Download File</button>
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
            b.style.cssText = `padding:6px 16px; border-radius:6px; border:1px solid #27272a; cursor:pointer; font-weight:600; font-size:12px; ${
              t.id === activeTab
                ? "background:#10b981; color:#fff; border-color:#10b981;"
                : "background:#18181b; color:#a1a1aa;"
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
