# gregorian

A calendar your agents read AND write. Schedule and record local AI agent runs (Claude Code, Codex) on one timeline, with auto-generated "minutes."

Status: scaffolding (DRI project, milestone m1).

## Requirements

- Node.js `>=20 <23` (better-sqlite3 prebuilt-binary coverage)
- npm

## Develop

```bash
npm install        # install dependencies
npm run build      # compile TypeScript to dist/
npm test           # run the vitest suite
npm run lint       # eslint
```

After building, the CLI is runnable:

```bash
node dist/cli/index.js --help
```

## Keep-alive (run the daemon at login)

The daemon must be running for scheduled runs to fire and for ad-hoc runs to be recorded. On macOS,
let the OS keep it alive across logout/login:

```bash
gregorian install      # write + load a launchd LaunchAgent; the daemon starts now and at every login
gregorian uninstall    # unload + remove it
```

`install` writes `~/Library/LaunchAgents/dev.gregorian.daemon.plist` (label `dev.gregorian.daemon`)
with `RunAtLoad` + `KeepAlive`, pointing at the Node binary and CLI entry you ran it from, and bakes in
your current `$PATH` so the daemon can find the `claude`/`codex` binaries it launches. Re-run `install`
after changing your `$PATH` (or moving the install) to refresh it. Daemon logs go to
`~/.gregorian/daemon.log`.

**Linux / Windows — manual for v1** (no automated installer yet):

- **Linux (systemd user service):** create `~/.config/systemd/user/gregorian.service` with
  `ExecStart=<path-to-node> <path-to>/dist/cli/index.js daemon`, then
  `systemctl --user enable --now gregorian` (and `loginctl enable-linger $USER` to survive logout).
- **Windows:** run `gregorian daemon` at login via Task Scheduler ("At log on" trigger) or a shortcut
  in the Startup folder.

> gregorian needs Node `>=20 <23` — better-sqlite3 ships prebuilt binaries for that range, so `npx`
> never has to compile. On an unsupported Node the CLI prints a friendly message instead of a crash.

## Layout

```
src/
  cli/index.ts   # CLI entry (bin: gregorian)
  index.ts       # library entry
  types.ts       # shared types (filled in by later tasks)
  install/       # macOS launchd keep-alive + native-module first-run check
```
