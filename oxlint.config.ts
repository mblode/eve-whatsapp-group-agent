import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
  // Agent-friendly guardrail: keep files small enough to hold in one context.
  // Warn (not error) so it flags growth without blocking; data blobs, tests, and
  // the bridge orchestrator (see its ARCHITECTURE marker) are exempt.
  overrides: [
    {
      files: [
        "**/*.test.ts",
        "agent/lib/data/**",
        "bridge/members.ts",
        "bridge/index.ts",
      ],
      rules: { "max-lines": "off" },
    },
  ],
  rules: {
    "max-lines": [
      "warn",
      { max: 500, skipBlankLines: true, skipComments: true },
    ],
  },
});
