# ora

A calendar your agents read AND write. Schedule and record local AI agent runs (Claude Code, Codex) on one timeline, with auto-generated "minutes."

## Get started in 60 seconds

```bash
npx @mquan/ora                                                    # launch it: starts the daemon, opens the timeline in your browser
```

That one command is the whole app — it ensures the recorder daemon is running and opens the web
timeline. From there (or the CLI) you can schedule and inspect runs:

```bash
npx @mquan/ora add --engine claude --at +1m --prompt 'list files' # schedule a run one minute out
npx @mquan/ora list                                               # watch it fire
npx @mquan/ora show <id>                                          # read the auto-generated minutes
npx @mquan/ora --help                                             # all commands and flags
```

Prefer to type just `ora`? `npm install -g @mquan/ora` first. No `ANTHROPIC_API_KEY`
required — ora drives your existing local `claude` / `codex` login. To keep the daemon running
across logout/login on macOS, see [Keep-alive](#keep-alive-run-the-daemon-at-login) below. Full
walkthrough, flags, and the web timeline: [docs/getting-started.md](docs/getting-started.md).

## Requirements

- Node.js `20`, or `22`–`26` (better-sqlite3 prebuilt-binary coverage)
- npm

## Develop

```bash
npm install        # install dependencies
npm run dev        # run the daemon + web dev server together (one command)
npm run build      # compile TypeScript to dist/
npm test           # run the vitest suite
npm run lint       # eslint
```

`npm run dev` boots **both** processes with [`concurrently`](https://www.npmjs.com/package/concurrently):
the daemon (`node dist/cli/index.js daemon`) and the Vite dev server for `web/`. `Ctrl-C` stops both.
The Vite dev proxy auto-attaches the daemon's bearer token, so <http://localhost:5173> works with no
manual `?token=`. (`predev` builds `dist/` and installs `web/` deps first; the daemon runs from
`dist/`, so a backend change needs a `npm run dev` restart to pick up — backend hot-reload isn't wired
yet.) To run the daemon alone, use `npm run cli daemon`.

After building, the CLI is runnable:

```bash
node dist/cli/index.js --help
```

## Keep-alive (run the daemon at login)

The daemon must be running for scheduled runs to fire and for ad-hoc runs to be recorded. On macOS,
let the OS keep it alive across logout/login:

```bash
ora install      # write + load a launchd LaunchAgent; the daemon starts now and at every login
ora uninstall    # unload + remove it
```

`install` writes `~/Library/LaunchAgents/dev.ora.daemon.plist` (label `dev.ora.daemon`)
with `RunAtLoad` + `KeepAlive`, pointing at the Node binary and CLI entry you ran it from, and bakes in
your current `$PATH` so the daemon can find the `claude`/`codex` binaries it launches. Re-run `install`
after changing your `$PATH` (or moving the install) to refresh it. Daemon logs go to
`~/.ora/daemon.log`.

**Linux / Windows — manual for v1** (no automated installer yet):

- **Linux (systemd user service):** create `~/.config/systemd/user/ora.service` with
  `ExecStart=<path-to-node> <path-to>/dist/cli/index.js daemon`, then
  `systemctl --user enable --now ora` (and `loginctl enable-linger $USER` to survive logout).
- **Windows:** run `ora daemon` at login via Task Scheduler ("At log on" trigger) or a shortcut
  in the Startup folder.

> ora needs Node `20`, or `22`–`26` — better-sqlite3 ships prebuilt binaries for those versions,
> so `npx` never has to compile. On an unsupported Node the CLI prints a friendly message instead of a crash.

## Layout

```
src/
  cli/index.ts   # CLI entry (bin: ora)
  index.ts       # library entry
  types.ts       # shared types (filled in by later tasks)
  install/       # macOS launchd keep-alive + native-module first-run check
```
