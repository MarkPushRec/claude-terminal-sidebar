// Wires xterm.js <-> local PTY via Chrome Native Messaging.
// Chrome forks the host on connectNative() and SIGTERMs it on port disconnect,
// so the shell's lifecycle == the side panel's lifecycle.
//
// Wire protocol (JSON objects, Chrome handles framing):
//   ext  -> host: {type:"init", cwd, cols, rows} | {type:"input", data} | {type:"resize", cols, rows}
//   host -> ext : {type:"ready", cwd, pid} | {type:"output", data} | {type:"exit", code}

const HOST = "com.cts.bridge";

const term = new Terminal({
  fontFamily: 'ui-monospace, Menlo, "JetBrains Mono", monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: "#0b0b0b" },
  scrollback: 10000,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));
fit.fit();

const statusEl = document.getElementById("status");
const cwdEl = document.getElementById("cwd");
let port = null;
let ready = false;

async function getActiveTabCwdHint() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      const saved = await chrome.storage.local.get(["lastCwd"]);
      return saved.lastCwd || null;
    }
  } catch {}
  return null;
}

function connect() {
  statusEl.classList.remove("up", "down");
  cwdEl.textContent = "starting shell…";
  ready = false;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    cwdEl.textContent = "connectNative threw: " + e.message;
    statusEl.classList.add("down");
    return;
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === "ready") {
      ready = true;
      statusEl.classList.add("up");
      cwdEl.textContent = msg.cwd + "  •  pid " + msg.pid;
      chrome.storage.local.set({ lastCwd: msg.cwd });
    } else if (msg.type === "output") {
      term.write(msg.data);
    } else if (msg.type === "exit") {
      term.write(`\r\n\x1b[33m[shell exited ${msg.code}]\x1b[0m\r\n`);
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "host exited";
    statusEl.classList.remove("up");
    statusEl.classList.add("down");
    cwdEl.textContent = "disconnected — " + err;
    port = null; ready = false;
  });

  // Send init *before* awaiting the tab hint to minimize first-byte latency;
  // a follow-up cwd is only useful on first launch anyway.
  getActiveTabCwdHint().then((hint) => {
    port?.postMessage({ type: "init", cwd: hint, cols: term.cols, rows: term.rows });
  });
}

term.onData((d) => {
  if (port && ready) port.postMessage({ type: "input", data: d });
});

const ro = new ResizeObserver(() => {
  fit.fit();
  if (port && ready) port.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
});
ro.observe(document.getElementById("term"));

// Port closes automatically when the panel page unloads, but disconnect
// explicitly to be a good citizen on quick navigations.
window.addEventListener("pagehide", () => { try { port?.disconnect(); } catch {} });

// ---------- drag & drop ----------
// macOS Finder (and most file managers) put real OS paths in `text/uri-list`
// as `file://` URLs alongside the sandboxed File objects. We pull from there.

const termEl = document.getElementById("term");

function shellQuote(p) {
  // POSIX single-quote: wrap in '...', escape internal ' as '\''
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

function decodeFileUri(uri) {
  if (!uri.startsWith("file://")) return null;
  let p = uri.slice("file://".length);
  // Handle file://host/path — strip the optional host segment.
  if (!p.startsWith("/")) {
    const slash = p.indexOf("/");
    p = slash >= 0 ? p.slice(slash) : "/";
  }
  try { return decodeURIComponent(p); } catch { return p; }
}

function sendInput(data) {
  if (port && ready) port.postMessage({ type: "input", data });
}

["dragenter", "dragover"].forEach((ev) =>
  termEl.addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types?.length) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    termEl.classList.add("drag");
  }, { capture: true })
);
["dragleave", "dragend"].forEach((ev) =>
  termEl.addEventListener(ev, () => termEl.classList.remove("drag"),
    { capture: true })
);

termEl.addEventListener("drop", (e) => {
  e.preventDefault();
  termEl.classList.remove("drag");
  const dt = e.dataTransfer;

  const paths = [];
  const uriList = dt.getData("text/uri-list");
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const p = decodeFileUri(trimmed);
      if (p) paths.push(p);
    }
  }

  if (paths.length) {
    sendInput(paths.map(shellQuote).join(" "));
    return;
  }

  // No file:// paths — paste plain text (tab URLs, selected text, etc).
  const text = dt.getData("text/plain");
  if (text) { sendInput(text); return; }

  // Last resort: bare filenames. Chrome strips OS paths from DataTransfer
  // in side-panel context — drop on the page itself for full paths
  // (handled by content.js → cts-dropped-files).
  if (dt.files?.length) {
    const names = [...dt.files].map((f) => shellQuote(f.name));
    sendInput(names.join(" "));
    flashStatus("filename only — drop on the page for full paths");
  }
}, { capture: true });

// Belt-and-suspenders: if the user misses the terminal area, prevent the
// side panel from navigating away to the dropped file.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------- toolbar buttons ----------
// Briefly show a message in the toolbar's cwd slot, then restore. Lets us
// surface picker errors without writing into the PTY (which would corrupt
// claude code's TUI render).
let _statusRestore = null;
function flashStatus(msg, ms = 1800) {
  const prev = cwdEl.textContent;
  cwdEl.textContent = msg;
  cwdEl.style.color = "#fbbf24";
  if (_statusRestore) clearTimeout(_statusRestore);
  _statusRestore = setTimeout(() => {
    cwdEl.textContent = prev;
    cwdEl.style.color = "";
    _statusRestore = null;
  }, ms);
}

// ---------- element picker ----------
// "Pick" injects content.js into the active localhost tab, then signals it to
// enter pick mode. The content script sends a payload back via runtime
// messaging; we format it and bracketed-paste it into the PTY as one message.

const PASTE_START = "\x1b[200~";
const PASTE_END   = "\x1b[201~";

function formatPick(p) {
  const lines = [
    "<picked-element>",
    `url:        ${p.url}`,
    `selector:   ${p.selector}`,
    `tag:        <${p.tag}>`,
  ];
  if (p.id)             lines.push(`id:         ${p.id}`);
  if (p.classes)        lines.push(`classes:    ${p.classes}`);
  if (p.reactComponent) lines.push(`component:  <${p.reactComponent}>`);
  lines.push(`rect:       ${p.rect.width}×${p.rect.height} at (${p.rect.x}, ${p.rect.y})`);
  if (p.text)           lines.push(`text:       ${JSON.stringify(p.text)}`);
  lines.push("");
  lines.push("computed styles:");
  for (const [k, v] of Object.entries(p.styles)) lines.push(`  ${k}: ${v}`);
  lines.push("");
  lines.push("outerHTML:");
  lines.push(p.html);
  lines.push("</picked-element>");
  return lines.join("\n");
}

async function startPick() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const url = tab.url || "";
  const ok = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)
          || /^file:\/\//i.test(url);
  if (!ok) {
    flashStatus("not localhost or file://");
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "cts-pick-start" });
    // No terminal write — the in-page green outline is the visual signal,
    // and any write into a running TUI (claude code) corrupts its render.
  } catch (e) {
    console.error("[cts] pick failed:", e);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "cts-dropped-files") {
    if (!port || !ready) { flashStatus("no shell yet"); return; }
    sendInput(msg.paths.map(shellQuote).join(" "));
    return;
  }
  if (msg?.type !== "cts-picked") return;
  if (!port || !ready) {
    flashStatus("no shell yet");
    return;
  }
  const body = formatPick(msg.payload);
  // Bracketed-paste so multi-line content lands as ONE atomic paste — claude
  // code's TUI auto-collapses it to a "[Pasted text #N +M lines]" chip while
  // holding the full text for the actual model message. No trailing CR: the
  // user composes their question after the chip and hits Enter themselves.
  port.postMessage({ type: "input", data: PASTE_START + body + PASTE_END });
});

document.getElementById("pick").onclick = startPick;

// Keep content.js installed on the active localhost/file tab so its drop
// forwarder is always live (drops on the page → real paths to the panel).
// Idempotent: content.js self-guards against double-init.
async function ensureContentScript(tabId, url) {
  const ok = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url || "")
          || /^file:\/\//i.test(url || "");
  if (!ok) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch { /* tab gone, no host perm, etc. — silent */ }
}
async function ensureForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) ensureContentScript(tab.id, tab.url);
}
ensureForActiveTab();
chrome.tabs.onActivated.addListener(({ tabId }) =>
  chrome.tabs.get(tabId).then((t) => ensureContentScript(t.id, t.url)).catch(() => {})
);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete") ensureContentScript(tabId, tab.url);
});

document.getElementById("claude").onclick = () => sendInput("claude\r");
document.getElementById("reconnect").onclick = () => {
  try { port?.disconnect(); } catch {}
  port = null; ready = false;
  term.reset();
  connect();
};

connect();
