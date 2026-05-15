# Claude Terminal Sidebar

A Chrome extension that docks a real terminal into the side panel — so you
can run `claude`, `npm run dev`, `git`, etc. **next to** the localhost page
you're working on. Includes a click-to-pick element inspector that pastes
DOM context (selector, computed styles, React component name) straight into
the running `claude` prompt.

```
┌──────────────────────────────┬─────────────────┐
│                              │ ● ~/proj  pid…  │
│    your localhost dev page   │ $ claude        │
│      ┌────────────┐          │ > [Pasted #1]   │
│      │ pick this  │ ← green  │   make it match │
│      └────────────┘   outline│   the secondary │
│                              │   buttons       │
└──────────────────────────────┴─────────────────┘
```

## Features

- **Real PTY**, not a fake shell — `claude`, `vim`, `htop`, prompts, colors,
  Ctrl-C all work.
- **Lifecycle == panel** — the shell starts when you open the side panel and
  is reaped the moment you close it. No background daemons, no port to bind,
  no `npm start` window to babysit.
- **Click-to-pick element inspector** — hit `pick`, click any element on
  your localhost page (or any local `file://` HTML), and a structured context
  blob is bracketed-pasted into the running `claude` session as a single
  collapsed chip. You add the question; the model sees the full context.
- **Drag & drop** — drop files from Finder onto the terminal to insert their
  shell-quoted absolute paths; drop URLs or text to paste them.

## Install

Requires **Node 18+** and a Chromium-family browser (Chrome, Brave, Arc,
Chromium, etc.) on macOS or Linux.

```sh
git clone https://github.com/MarkPushRec/claude-terminal-sidebar.git
cd claude-terminal-sidebar
./install.sh
```

The script will:

1. `npm install` the server deps (`node-pty`).
2. Template the wrapper script with your absolute `node` path.
3. Walk you through loading the unpacked extension and capture its ID.
4. Drop the native-messaging manifest into every Chromium-family browser
   profile dir it can find.

Then click the extension's toolbar icon — the side panel opens, the shell
starts, you're done.

## Architecture

```
┌─────────────────────────────┐  chrome.runtime.connectNative()
│ side panel  (xterm.js + UI) │ ───────────────────────────────┐
└─────────────────────────────┘                                │
                                                               ▼
                                              ┌─────────────────────────────┐
                                              │  cts-native-host.sh         │
                                              │   └─ node native-host.js    │
                                              │        └─ pty.spawn(zsh)    │
                                              └─────────────────────────────┘
```

- **Side panel** (`extension/`) — MV3 extension. Renders [xterm.js], talks
  to the host process over stdio via Chrome Native Messaging. Drops the WS
  ports, host_permissions, and Origin checks an old-school local-server
  approach would need.
- **Native host** (`server/native-host.js`) — tiny Node script. Reads
  4-byte-LE-length-prefixed JSON frames from stdin, spawns a PTY via
  [`node-pty`], pipes bytes both ways. Chunks PTY output at 256 KB to
  stay under Chrome's 1 MB per-message cap.
- **Element picker** (`extension/content.js`) — on-demand content script
  injected into the active localhost (or `file://`) tab. Generates a CSS
  selector, walks React fiber for component names, and ships a curated
  ~25-style subset back via `chrome.runtime.sendMessage`.

## Configuration

- **Allow access to file URLs** — for the picker to work on local `.html`
  files, open `chrome://extensions`, click **Details** on the extension,
  and toggle **Allow access to file URLs** on. (Manifest declaration is not
  enough; Chrome locks `file://` access behind a per-extension switch.)
- **Different shell** — the host inherits `$SHELL`. Override per-session
  by editing `server/native-host.js` (or set it before launching Chrome).

## Uninstall

```sh
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.cts.bridge.json"
# (and the equivalent path for any other Chromium-family browser you installed it into)
```

Then remove the extension from `chrome://extensions`.

## Security notes

- The host only runs while the panel is open; Chrome SIGTERMs it on
  disconnect.
- Native messaging traffic is local stdio between Chrome and the host —
  no port is opened, nothing on your network or other local processes can
  reach it.
- The manifest's `allowed_origins` whitelist scopes the host to *one*
  specific extension ID. Other extensions can't use it.
- The picker only injects into URLs declared in `host_permissions`
  (localhost, `127.0.0.1`, and `file://` if you enable it).

## License

MIT — see [LICENSE](LICENSE).

[xterm.js]: https://xtermjs.org/
[`node-pty`]: https://github.com/microsoft/node-pty
