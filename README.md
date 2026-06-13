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

## Layout

```
src/
  cli/index.ts   # CLI entry (bin: gregorian)
  index.ts       # library entry
  types.ts       # shared types (filled in by later tasks)
```
