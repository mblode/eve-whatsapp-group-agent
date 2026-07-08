import { defineConfig, configDefaults } from "vitest/config";

/**
 * Only run our own unit tests. `eve dev` / `eve eval` write source snapshots
 * under `.eve/dev-runtime/snapshots/` (copies of the .test.ts files), so without
 * excluding `.eve` vitest globs every snapshot copy and reports inflated, duplicated
 * counts. Evals live in `evals/` and run via `eve eval`, not vitest. The `bridge/`
 * package is plain ESM with no vitest; its tests run via `node --test` (see
 * bridge/package.json), so keep vitest out of it.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.eve/**", "evals/**", "bridge/**"],
  },
});
