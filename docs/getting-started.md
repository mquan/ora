# Getting started

Schedule your first agent run and read its minutes — about 60 seconds end to end.

> **Requirements:** Node.js `>=20 <23` (better-sqlite3 ships prebuilt binaries for that range, so
> `npx` never has to compile). No `ANTHROPIC_API_KEY` needed — ora launches your local
> `claude` / `codex` binaries and reuses their existing login.

> **Install:** the examples below use the `ora` command. Get it with
> `npm install -g @mquan/ora`, or prefix any command with `npx @mquan/ora` to run without
> installing (e.g. `npx @mquan/ora list`).

## 0. The one-command launch

```bash
npx @mquan/ora
```

With no command, `ora` launches the app: it ensures the daemon is running and opens the web timeline in
your browser. That's the fastest way in — the rest of this guide breaks down the same pieces (start the
daemon, schedule a run, read the minutes) so you can drive them from the CLI too.

## 1. Start the daemon

The daemon is the scheduler + recorder: it fires scheduled runs and records their output. The
`add` / `list` / `show` commands are thin clients that talk to it, so it has to be running.

**macOS (keep it alive across logout/login) — recommended:**

```bash
ora install
```

This writes and loads a launchd agent (`~/Library/LaunchAgents/dev.ora.daemon.plist`) that
starts the daemon now and at every login. Re-run it after changing your `$PATH`. Remove it later with
`ora uninstall`.

**Any platform (foreground, for a quick try):**

```bash
ora daemon
```

Leave it running in its own terminal. (Linux/Windows keep-alive is manual for now — see the README.)

## 2. Schedule a run one minute out

In another terminal:

```bash
ora add --engine claude --at +1m --prompt 'list the files in this directory'
```

- `--engine claude` (or `codex`) — which agent to launch.
- `--at +1m` — fire one minute from now. Also accepts `+30s`, `+2h`, `+1d`, or an ISO timestamp.
- `--cwd <path>` — working directory for the run (defaults to the current directory).
- `--prompt` — what to run. (Or attach a skill/doc with `--mention`.)

`add` prints the new event's id.

## 3. Watch it fire

```bash
ora list
```

You'll see the event move from scheduled to done (with an exit code) once the minute elapses. Prefer a
timeline view? Open the web UI:

```bash
ora ui      # or just `ora` with no command — same thing
```

This ensures the daemon is up and opens the week/month/agenda timeline in your browser.

## 4. Read the minutes

```bash
ora show <id>
```

This renders the run's auto-generated **minutes** — a structured summary of what the agent did — along
with its exit status and the path to the full transcript.

---

That's the loop: **schedule → fire → record → read.** From here, schedule recurring work, attach
skills with `--mention`, or browse everything on the timeline with `ora ui`.
