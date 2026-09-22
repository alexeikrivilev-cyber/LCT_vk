# Testing and evaluation

## Goal

Tests must prove the system works on unseen templates and preserves the architectural contracts, not merely that individual functions execute.

The most important regression surface is:

```text
unknown PPTX + content + brief
  -> design system
  -> plan
  -> variants
  -> native render
  -> audit/repair
  -> export
```

## Repository checks

Run the relevant commands before finishing work:

```bash
pnpm check:boundary
pnpm lint:craft
pnpm typecheck
pnpm build
```

`pnpm lint:craft` is required when skills/craft bindings change. Typecheck/build are required when their corresponding code paths change.

Add subsystem tests as the compiler modules land; do not defer all verification to one final E2E demo.

## Test layers

### Unit tests

Prioritize deterministic code:

- OOXML/PPTX parsing helpers;
- geometry and unit conversion;
- template token/style extraction;
- layout compatibility;
- slot mapping;
- lock-aware mutation;
- density calculations;
- deterministic audit rules;
- export relationship/object construction.

Tests should use small fixtures and exact assertions.

### Golden template fixtures

Maintain several compact PPTX fixtures with known expected extraction results:

- masters/layout ids and counts;
- placeholder geometry/types;
- theme colors/fonts;
- repeated assets;
- chart/table examples;
- unusual but valid structures.

Golden output should compare normalized `TemplateIR`/design-system data, not unstable ZIP timestamps or relationship ordering that has no semantic meaning.

### Integration tests

Exercise boundaries:

- upload template/source files;
- compile template;
- persist/reload project state;
- plan deck from structured content;
- generate A/B/C slide specs;
- generate same-type visual candidates;
- render native PPTX;
- run audit;
- apply a local repair;
- export/reopen result.

### Variant invariants

For every planned slide:

- three candidates exist when requested;
- candidates preserve the same core slide intent/takeaway;
- each candidate uses an allowed template layout/family;
- coherent Deck A/B/C tracks can be reconstructed;
- user-selected mixed deck remains valid.

For visual slots:

- candidate type equals planned slot type;
- switching candidate does not change layout semantics unexpectedly;
- explicit type change goes through re-plan.

### Lock tests

Locks require dedicated regression coverage:

- locked slide survives unrelated regeneration;
- locked visual survives slide regeneration;
- repair targeting another object does not alter locks;
- conflicting action returns a conflict instead of mutating the lock;
- save/reload preserves lock ids.

### Audit tests

Follow `AUDIT.md`.

Deterministic findings use exact fixture assertions. Contextual checks use a benchmark set with expected pass/fail tendencies and reviewable outputs.

### Native PPTX/export tests

Validate the exported file structurally:

- ZIP/OOXML opens;
- slide relationships resolve;
- text remains text;
- images remain image objects;
- supported charts/tables remain native where expected;
- slide is not one full-slide image;
- dimensions/master/layout references are valid;
- presentation can be reopened by the parser.

Where practical, render exported slides to images and compare with expected geometry/tolerance; visual comparison supplements structural checks and never replaces them.

### Browser smoke tests

Cover the main desktop journey:

- create project;
- upload template/content;
- inspect template;
- view outline;
- view/switch slide alternatives;
- switch a visual candidate;
- lock;
- local regenerate;
- open audit;
- repair selected issue;
- export.

Do not build a broad UI automation suite before this critical path is reliable.

## Hackathon benchmark

Maintain a repeatable benchmark separate from ad-hoc demos.

At minimum include:

- multiple structurally different templates;
- text-heavy, data-heavy, and visual content packs;
- tables/charts/diagrams;
- long/short titles and edge-case density;
- at least one template intentionally held out from prompt/skill tuning.

Qualification/final rehearsal should cover three layout variants on the same content across three templates, producing the required nine variant outputs.

Track:

- generation success rate;
- total runtime;
- deterministic audit pass rate;
- overflow/overlap counts;
- template compliance;
- native-object/editability checks;
- lock preservation;
- contextual audit score/review;
- failures by pipeline stage.

Normal 10–15 slide generation should target <= 5 minutes.

## Prompt/skill regression

Prompt and skill changes are code changes.

For a candidate change:

1. run the fixed benchmark with the current version;
2. run the candidate version;
3. compare deterministic metrics and reviewed contextual quality;
4. inspect regressions by failure class;
5. accept only when the aggregate result improves without violating hard gates;
6. record the new version.

Do not tune only on the live demo templates.

## Definition of done

A feature is done when:

- the requested behavior works end-to-end;
- relevant deterministic contracts have tests;
- failure states are handled without corrupting project state;
- locks and selections remain stable where applicable;
- audit/preflight implications are covered;
- source-of-truth documentation is updated if behavior/architecture changed;
- applicable repository checks have run successfully, or the exact blocked checks are reported.

A screenshot or one successful manual run is not sufficient evidence for parser, renderer, audit, or export changes.
