# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-20

First public release of **ora** — a calendar your agents read AND write.
(Developed under the working name *gregorian*; published as `@mquan/ora`.)

### Added

- **Schedule local agent runs.** `ora add` queues a Claude Code or Codex run at a
  given time/cwd/prompt; the daemon arms new events live, no restart required.
  Reuses your existing `claude`/`codex` login — no API key needed.
- **Record runs automatically.** A watcher discovers ad-hoc `claude`/`codex`
  sessions you start yourself and captures them — with generated minutes and
  duration — unprompted. In-flight runs survive a daemon restart with no loss or
  duplication.
- **Web timeline + transcript viewer.** A Google-Calendar-style web UI shows
  scheduled and recorded runs on a timeline, with a syntax-highlighted transcript
  and minutes panel per run.
- **launchd keep-alive (macOS).** `ora install` registers a `dev.ora.daemon`
  launchd agent so the daemon stays running across logins; state lives in `~/.ora`
  (override with `ORA_HOME`).

[0.1.0]: https://github.com/mquan/ora/releases/tag/v0.1.0
