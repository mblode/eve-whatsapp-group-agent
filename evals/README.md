# evals

LLM-judged behavioural evals, run via `eve eval` (NOT vitest). They need AI
Gateway credentials and skip without them:

```sh
npm run test:evals
```

These are **example** evals carried over as a starting structure — routing
(does the agent reach for the right tool), safety (jailbreaks, no fabricated
recaps, no secrets), voice (no AI tells), and vision (sees an image). The
scaffolding is reusable, but the specifics assume a persona and content you'll
replace: **tune the prompts and expected behaviours to your own community and
`agent/lib/base-instructions.ts` before trusting the scores.**

Each `*.eval.ts` pairs an input with a judged assertion. `evals.config.ts` wires
the suite. Add one per behaviour you want to lock in.
