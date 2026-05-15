// Chrome Native Messaging host. Speaks 4-byte LE length-prefixed JSON over
// stdin/stdout. Spawned by Chrome on chrome.runtime.connectNative() and
// reaped on port disconnect. One PTY per host instance.
//
// Protocol (same as the WS bridge so the sidepanel.js stays simple):
//   ext  -> host: {type:"init", cwd, cols, rows} | {type:"input", data} | {type:"resize", cols, rows}
//   host -> ext : {type:"ready", cwd, pid} | {type:"output", data} | {type:"exit", code}

const fs = require("fs");
const os = require("os");
const path = require("path");
const pty = require("node-pty");

const SHELL = process.env.SHELL || "/bin/zsh";
const MAX_OUT = 256 * 1024; // safely under Chrome's 1 MB host->ext cap

// ---- framing -------------------------------------------------------------

let buf = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    let msg;
    try { msg = JSON.parse(buf.slice(4, 4 + len).toString("utf8")); }
    catch (e) { logErr("bad json from chrome:", e.message); buf = buf.slice(4 + len); continue; }
    buf = buf.slice(4 + len);
    handle(msg);
  }
});

process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", (e) => { logErr("stdin error:", e.message); shutdown(1); });
process.stdout.on("error", () => shutdown(1)); // EPIPE = chrome went away

function send(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  try { process.stdout.write(header); process.stdout.write(json); } catch {}
}

function logErr(...args) {
  // anything on stdout would corrupt the protocol; debug goes to stderr,
  // which Chrome captures to its native_messaging.log when --enable-logging.
  try { process.stderr.write("[cts-host] " + args.join(" ") + "\n"); } catch {}
}

// ---- pty -----------------------------------------------------------------

let term = null;

function handle(msg) {
  if (msg.type === "init" && !term) {
    const cwd = (msg.cwd && fs.existsSync(msg.cwd)) ? msg.cwd : os.homedir();
    try {
      term = pty.spawn(SHELL, [], {
        name: "xterm-256color",
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (e) {
      send({ type: "output", data: `\r\n\x1b[31m[cts] spawn ${SHELL} failed: ${e.message}\x1b[0m\r\n` });
      send({ type: "exit", code: -1 });
      shutdown(1);
      return;
    }
    send({ type: "ready", cwd, pid: term.pid });
    term.onData((data) => {
      // Chunk to stay under Chrome's per-message size cap.
      for (let i = 0; i < data.length; i += MAX_OUT) {
        send({ type: "output", data: data.slice(i, i + MAX_OUT) });
      }
    });
    term.onExit(({ exitCode }) => { send({ type: "exit", code: exitCode }); shutdown(0); });
  } else if (msg.type === "input" && term) {
    term.write(msg.data);
  } else if (msg.type === "resize" && term) {
    term.resize(msg.cols || 80, msg.rows || 24);
  }
}

function shutdown(code) {
  if (term) { try { term.kill(); } catch {} }
  // Give stdout a tick to flush the final 'exit' frame.
  setTimeout(() => process.exit(code), 30);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT",  () => shutdown(0));
