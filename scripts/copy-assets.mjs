/**
 * Copy non-TS assets that `tsc` ignores (currently `*.sql`) from `src/` into `dist/`,
 * preserving the relative path. The Store reads `schema.sql` next to its compiled module
 * via `import.meta.url`, so the .sql must sit beside `store.js` in `dist/`. Cross-platform
 * (no `cp`) so `npm run build` works on macOS, Linux, and Windows.
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");
const distDir = join(root, "dist");

/** Recursively yield absolute paths of files under `dir` matching `ext`. */
function* walk(dir, ext) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, ext);
    else if (entry.name.endsWith(ext)) yield full;
  }
}

let count = 0;
for (const file of walk(srcDir, ".sql")) {
  const dest = join(distDir, relative(srcDir, file));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
  count++;
}
console.log(`copy-assets: copied ${count} .sql file(s) into dist/`);
