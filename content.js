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
      const stepHeight =
        scrollTarget === document.scrollingElement ||
        scrollTarget === document.documentElement
          ? window.innerHeight
          : scrollTarget.clientHeight || window.innerHeight;

      sendResponse({
        fullHeight: Math.min(fullHeight, 16000),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        stepHeight: stepHeight,
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
        document.querySelectorAll("*").forEach((el) => {
          const style = window.getComputedStyle(el);
          if (
            (style.position === "fixed" || style.position === "sticky") &&
            el !== scrollTarget &&
            !el.contains(scrollTarget)
          ) {
            if (
              el.offsetWidth < window.innerWidth * 0.8 &&
              el.offsetHeight < window.innerHeight * 0.8
            ) {
              if (!fixedElements.some((item) => item.el === el)) {
                fixedElements.push({
                  el,
                  originalVisibility: el.style.visibility,
                });
              }
              el.style.visibility = "hidden";
            }
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
      const cleanup = () => {
        overlay.remove();
      };
      overlay.addEventListener("mousedown", (e) => {
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        box.style.display = "block";
      });
      overlay.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        box.style.left = Math.min(sx, e.clientX) + "px";
        box.style.top = Math.min(sy, e.clientY) + "px";
        box.style.width = Math.abs(e.clientX - sx) + "px";
        box.style.height = Math.abs(e.clientY - sy) + "px";
      });
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
        sendResponse(rect);
      });
      return true;
    } else if (request.action === "selectElement") {
      const highlight = document.createElement("div");
      highlight.style.cssText = `position:fixed;border:2px solid #10b981;background:rgba(16,185,129,0.12);pointer-events:none;z-index:2147483647;`;
      document.body.appendChild(highlight);
      let currentRect = null;
      const cleanup = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        highlight.remove();
      };
      const onMove = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
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
            <span style="font-size:10px; color:#a1a1aa; margin-right:8px;">Click to export code</span>
            <button id="smCloseHUD" style="background:#27272a; color:#fff; border:none; padding:2px 6px; border-radius:4px; cursor:pointer;">✕</button>
          </div>
        </div>
        <div id="smStyleContent" style="display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto; color:#d4d4d8;">
          Hover any element...
        </div>
      `;
      document.body.appendChild(hud);

      const highlight = document.createElement("div");
      highlight.style.cssText = `position:fixed; border:2px solid #3b82f6; background:rgba(59,130,246,0.1); pointer-events:none; z-index:2147483646; transition:all 0.05s;`;
      document.body.appendChild(highlight);

      let frozen = false;

      const cleanupInspector = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        window.removeEventListener("keydown", onKey, true);
        hud.remove();
        highlight.remove();
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
      };

      const onClick = (e) => {
        if (hud.contains(e.target)) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || hud.contains(el)) return;
        frozen = true;

        const s = window.getComputedStyle(el);
        const cssCode = `font-family: ${s.fontFamily};\nfont-size: ${s.fontSize};\nfont-weight: ${s.fontWeight};\ncolor: ${s.color};\nbackground: ${s.backgroundColor};\nborder-radius: ${s.borderRadius};\nbox-shadow: ${s.boxShadow};`;
        const htmlCode =
          el.outerHTML.slice(0, 450) + (el.outerHTML.length > 450 ? "..." : "");

        // Show Sleek Code Modal instead of alert()
        const modal = document.createElement("div");
        modal.id = "smCodeModal";
        modal.style.cssText = `
          position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 440px;
          background: #121215; color: #fafafa; border: 1px solid #27272a; border-radius: 12px;
          padding: 20px; z-index: 2147483647; box-shadow: 0 30px 60px rgba(0,0,0,0.8); font-family: sans-serif;
        `;
        modal.innerHTML = `
          <div style="font-weight:700; font-size:15px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
            <span>✨ Inspected Element Code</span>
            <button id="smCloseModal" style="background:transparent; color:#a1a1aa; border:none; font-size:16px; cursor:pointer;">✕</button>
          </div>
          <div style="font-size:11px; color:#10b981; margin-bottom:6px;">CSS Properties:</div>
          <textarea readonly style="width:100%; height:80px; background:#09090b; color:#d4d4d8; border:1px solid #27272a; border-radius:6px; padding:8px; font-family:monospace; font-size:11px; resize:none;">${cssCode}</textarea>
          
          <div style="font-size:11px; color:#3b82f6; margin-top:10px; margin-bottom:6px;">HTML Snippet:</div>
          <textarea readonly style="width:100%; height:70px; background:#09090b; color:#d4d4d8; border:1px solid #27272a; border-radius:6px; padding:8px; font-family:monospace; font-size:11px; resize:none;">${htmlCode}</textarea>

          <div style="display:flex; gap:8px; margin-top:14px;">
            <button id="smCopyCss" style="flex:1; padding:9px; background:#10b981; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Copy CSS</button>
            <button id="smCopyHtml" style="flex:1; padding:9px; background:#27272a; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Copy HTML</button>
          </div>
        `;
        document.body.appendChild(modal);

        document.getElementById("smCloseModal").onclick = () => {
          modal.remove();
          frozen = false;
        };
        document.getElementById("smCopyCss").onclick = () => {
          navigator.clipboard.writeText(cssCode);
          alert("CSS Copied!");
        };
        document.getElementById("smCopyHtml").onclick = () => {
          navigator.clipboard.writeText(el.outerHTML);
          alert("HTML Copied!");
        };
      };

      const onKey = (e) => {
        if (e.key === "Escape") cleanupInspector();
      };

      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKey, true);
      sendResponse({ success: true });
      return false;
    }
  });
})();
