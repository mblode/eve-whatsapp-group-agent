import { defineEvalConfig } from "eve/evals";

/**
 * Shared eval config. The judge model grades the fuzzy assertions (voice,
 * refusals) and is always separate from the agent under test. A string model id
 * routes through the Vercel AI Gateway, so it needs AI_GATEWAY_API_KEY or
 * VERCEL_OIDC_TOKEN; without creds the judge-backed evals skip visibly rather
 * than failing. Run with `npm run test:evals` (eve eval --strict).
 */
export default defineEvalConfig({
  judge: { model: "anthropic/claude-opus-4.8" },
});
