import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `web/` is a self-contained Vite SPA package (its own React/TS toolchain + `tsc --noEmit` typecheck);
    // the daemon's flat config has no React plugins, so it never lints into web/ (source or built dist).
    ignores: ["dist/**", "node_modules/**", ".worktrees/**", "web/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  {
    // Plain JS build scripts run under Node — give them Node globals so no-undef passes.
    files: ["**/*.mjs", "scripts/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
);
