// Element picker content script. Injected on demand from the side panel via
// chrome.scripting.executeScript. Self-guards against double-init so repeat
// injection is a no-op.

(function () {
  if (window.__ctsPickerInstalled) return;
  window.__ctsPickerInstalled = true;

  let active = false;
  let highlighted = null;
  let overlay = null;
  let label = null;

  function makeOverlay() {
    overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed", "pointer-events:none", "z-index:2147483647",
      "border:2px solid #4ade80", "background:rgba(74,222,128,0.10)",
      "transition:top 60ms ease-out, left 60ms ease-out, width 60ms ease-out, height 60ms ease-out",
      "box-sizing:border-box",
    ].join(";");

    label = document.createElement("div");
    label.style.cssText = [
      "position:fixed", "pointer-events:none", "z-index:2147483647",
      "background:#0b0b0b", "color:#4ade80", "padding:2px 6px",
      "font:12px/1.4 ui-monospace,Menlo,monospace",
      "border-radius:3px", "white-space:nowrap",
      "box-shadow:0 1px 4px rgba(0,0,0,0.4)",
    ].join(";");

    document.documentElement.append(overlay, label);
  }

  function killOverlay() {
    overlay?.remove(); label?.remove();
    overlay = null; label = null;
  }

  function moveOverlay(el) {
    if (!el || !overlay) return;
    const r = el.getBoundingClientRect();
    overlay.style.top = r.top + "px";
    overlay.style.left = r.left + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";

    const tag = el.tagName.toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const cls = (el.classList && el.classList.length)
      ? "." + [...el.classList].slice(0, 2).join(".") : "";
    label.textContent = `${tag}${id}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    // Place label just above the box (or just below if near the top).
    const labelTop = r.top > 22 ? r.top - 22 : r.bottom + 4;
    label.style.top = labelTop + "px";
    label.style.left = Math.max(0, r.left) + "px";
  }

  function buildSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const path = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { part += "#" + CSS.escape(el.id); path.unshift(part); break; }
      const cls = [...(el.classList || [])].slice(0, 2).map(CSS.escape).join(".");
      if (cls) part += "." + cls;
      const sibs = [...(el.parentNode?.children || [])].filter(s => s.tagName === el.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      path.unshift(part);
      el = el.parentElement;
    }
    return path.join(" > ");
  }

  // React fiber walk — best-effort; only runs if the element has __reactFiber$…
  function reactComponentName(el) {
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    if (!key) return null;
    let fiber = el[key];
    while (fiber) {
      const t = fiber.type;
      if (typeof t === "function") return t.displayName || t.name || null;
      if (typeof t === "object" && t?.displayName) return t.displayName;
      fiber = fiber.return;
    }
    return null;
  }

  // Curated subset of computed styles — the ones a designer cares about.
  const STYLE_KEYS = [
    "color", "background-color", "background-image",
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
    "text-align", "text-transform",
    "padding", "margin", "border", "border-radius", "box-shadow",
    "display", "flex-direction", "justify-content", "align-items", "gap",
    "grid-template-columns", "grid-template-rows",
    "width", "height", "opacity", "transform",
  ];
  const NOISE = new Set(["normal", "auto", "none", "0px", "rgba(0, 0, 0, 0)", ""]);

  function extract(el) {
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of STYLE_KEYS) {
      const v = cs.getPropertyValue(k).trim();
      if (!NOISE.has(v)) styles[k] = v;
    }
    const r = el.getBoundingClientRect();
    let html = el.outerHTML;
    if (html.length > 1200) html = html.slice(0, 1200) + "…";

    return {
      url: location.href,
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: (el.classList && el.classList.length) ? [...el.classList].join(" ") : null,
      reactComponent: reactComponentName(el),
      text: ((el.innerText || "").trim().slice(0, 240)) || null,
      rect: {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
      },
      styles,
      html,
    };
  }

  // ---- event handlers ----

  function onMove(e) {
    if (!active) return;
    // elementFromPoint ignores the overlay because it has pointer-events:none.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== highlighted) { highlighted = el; moveOverlay(el); }
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = highlighted || document.elementFromPoint(e.clientX, e.clientY);
    stop();
    if (!el) return;
    chrome.runtime.sendMessage({ type: "cts-picked", payload: extract(el) });
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === "Escape") { e.preventDefault(); stop(); }
  }

  function start() {
    if (active) return;
    active = true;
    makeOverlay();
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    // crosshair cursor — best-effort, some sites override on every element.
    document.documentElement.style.cursor = "crosshair";
  }

  function stop() {
    active = false; highlighted = null;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = "";
    killOverlay();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "cts-pick-start") start();
    if (msg?.type === "cts-pick-stop") stop();
  });

  // ---- file drop forwarder ----
  // Side panels don't get `file://` URIs in DataTransfer (Chrome strips them),
  // but regular pages do. We capture OS file drops here and forward absolute
  // paths to the side panel, which shell-quotes and pastes into the PTY.

  function decodeFileUri(uri) {
    if (!uri.startsWith("file://")) return null;
    let p = uri.slice("file://".length);
    if (!p.startsWith("/")) {
      const slash = p.indexOf("/");
      p = slash >= 0 ? p.slice(slash) : "/";
    }
    try { return decodeURIComponent(p); } catch { return p; }
  }

  document.addEventListener("dragover", (e) => {
    // Only consume if it's an OS file drag — leaves page-internal drags alone.
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) {
      e.preventDefault();
    }
  }, true);

  document.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!dt || ![...(dt.types || [])].includes("Files")) return;
    const uriList = dt.getData("text/uri-list") || "";
    const paths = [];
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const p = decodeFileUri(trimmed);
      if (p) paths.push(p);
    }
    if (paths.length) {
      // Only swallow the event when we actually have something to forward —
      // lets legit upload UIs on the page still receive drops we can't help with.
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "cts-dropped-files", paths });
    }
  }, true);
})();
