# Claude Swarm

A desktop app for Windows, macOS and Linux that runs many Claude Code sessions at once.
You chat with a **commander**; it breaks your request into **worker** sessions, starts them in your
workspace folder, waits for them and reports back. Every worker is a complete Claude Code
conversation working in one folder. The app lives in the tray / menu bar, so sessions keep working
when the window is closed.

It drives the official `claude` command-line tool with your own Claude login. It never talks to
Anthropic directly and has no key of its own. Because parallel sessions use your plan's limits
quickly, the app checks for a Claude Max subscription before it starts sessions (you can turn the
check off in Settings).

## What you need

- Windows 10/11, macOS 12+, or a Linux desktop with a system tray
- Claude Code CLI, logged in with a Claude Max account. Either:

```bash
npm install -g @anthropic-ai/claude-code
```

  or the native installer on macOS/Linux:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Then run `claude` once in a terminal and sign in. The app reads the login state with
`claude auth status`. On macOS and Linux the app asks your login shell for its PATH at startup, so
a CLI installed by npm, Homebrew, Volta or the native installer is found even when the app is
started from the Dock or a launcher. If it still cannot find it, set the path in Settings.

## Run from source

Needs Node.js 20 or newer.

```bash
npm install
```

```bash
npm start
```

## Build an installer

Each platform builds its own package; electron-builder cannot cross-build macOS packages from
Windows or Linux.

| On      | Command              | Output in `dist/`                      |
|---------|----------------------|----------------------------------------|
| Windows | `npm run dist:win`   | `ClaudeSwarm-<version>.exe` (portable) |
| macOS   | `npm run dist:mac`   | `.dmg` and `.zip` for Apple Silicon and Intel |
| Linux   | `npm run dist:linux` | `.AppImage` and `.deb`                 |

The packages are unsigned. Windows SmartScreen may warn the first time; on macOS right-click the
app and choose Open the first time; on Linux make the AppImage executable (`chmod +x`).

On Windows, build from a short path. NSIS, which electron-builder uses for the portable exe, fails
on paths longer than about 260 characters.

## Using it

The window has a sidebar with three kinds of entries and a main area showing the selected one.

### Commander

1. Open **Commander** and choose a workspace folder. New projects go into subfolders of it.
2. Type what you want, for example "build a small Express API with tests, and separately write a
   README for it", and press Send (Ctrl+Enter, Cmd+Enter on a Mac).
3. The commander creates workers, each with a self-contained prompt. They appear in the sidebar
   and on the Overview. It waits for them, reads their results and summarizes.
4. Keep talking to it: ask for changes, ask what a worker did, tell it to stop or remove a worker.

The commander only has read tools plus the swarm tools; every file change is done by a worker. It
picks `bypassPermissions` for workers that must run commands (install, build, test) and
`acceptEdits` for pure editing.

### Overview

All workers side by side, each card a live preview of its transcript. Click a card to open the
worker. **Send to idle** sends one prompt to every worker that is not busy. **Stop all** stops
everything.

### A worker

Its full transcript, a prompt box to continue its conversation, and buttons to open its folder,
stop the current turn, or remove it. Use the **+** in the sidebar (Ctrl+N) to add a worker by hand:
name, folder, optional git worktree and branch, permission mode, model, and a first prompt.

Shortcuts: Ctrl+N new worker, Ctrl+1 overview, Ctrl+2 commander, Ctrl+, settings. On a Mac use Cmd.

Closing the window keeps the app in the tray or menu bar. Right-click (or click, on a Mac) the
icon for Stop all, Start at login, and Quit. Quitting stops every running session.

## How it works

- `src/main.js`: Electron main process, window, tray, menu (macOS), settings, IPC.
- `src/sessions.js`: the session manager. Each turn spawns
  `claude -p --output-format stream-json --verbose [--resume <id>]` in the session folder, writes the
  prompt to stdin, parses the JSON lines it prints, and forwards them to the UI. The conversation id
  from the first turn is reused with `--resume` on later turns. Stop kills the whole process tree
  (taskkill on Windows, a process group signal elsewhere).
- `src/preflight.js`: finds the CLI, reads version and login state, reports the subscription type,
  and fixes PATH for GUI-launched apps on macOS and Linux.
- `src/bridge.js` and `src/mcp-server.js`: the commander's tools. The commander is a normal
  headless Claude Code session launched with `--mcp-config` pointing at a tiny MCP server
  (`mcp-server.js`, no dependencies). That server forwards each tool call (`create_session`,
  `send_prompt`, `wait_for_sessions`, `get_output`, `stop_session`, `remove_session`,
  `list_sessions`) to the app over a localhost HTTP bridge protected by a random token.
- `src/commander-prompt.js`: the system prompt that tells the commander how to delegate.
- `src/renderer/`: the UI, plain HTML, CSS and JavaScript. No framework.
- `scripts/make-icon.js`: generates every icon (ico, png, macOS template tray icons) from code.

Sessions, settings and per-session logs are stored in the per-user app data folder:
`%APPDATA%\Claude Swarm` on Windows, `~/Library/Application Support/Claude Swarm` on macOS,
`~/.config/Claude Swarm` on Linux.

## Limits and notes

- Headless sessions cannot ask you permission questions, so in `default` mode any tool that would
  need approval is simply refused. `acceptEdits` is the practical default; `bypassPermissions` lets
  a worker run shell commands without asking, so point it at folders you are comfortable with.
- Every session consumes your Claude usage limits. Watch the cost figures.
- Workers do not talk to each other directly; the commander is the hub.
- Developed and tested on Windows. The macOS and Linux paths (PATH discovery, process groups, tray
  icons, menu) are written to the platform APIs but have not yet been exercised on those systems.
- This is for your own machine and your own account. Do not route other people's usage through
  your login.

## License

MIT. See [LICENSE](LICENSE).
