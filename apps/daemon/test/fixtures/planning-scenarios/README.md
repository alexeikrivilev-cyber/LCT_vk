# Offline planning scenarios

These five compact, synthetic cases are fixed inputs for tomorrow's manual
quality runs. Upload a scenario's `source.md`, compile a template, and use its
`brief.json` as the planning brief. The values are fictional and must not be
presented as real company evidence.

After a run, copy the project's `.planning/state.json` to a separate results
folder. Compare one or more saved state files with:

```bash
node --import tsx scripts/evaluate-planning-runs.mjs run-1/state.json run-2/state.json
```

The evaluator uses the existing ContentIR, Brief, DeckPlan, and Supervisor
validators. It reports unknown unsupported-claim counts as `null`; check those,
title quality, source fidelity, and narrative coherence manually. New planning
states retain bounded provider `finish_reason` values when available. Older
schemaVersion 1 states without that field remain readable and report `null`.
