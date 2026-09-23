# Audit, repair, and preflight

## Purpose

Audit is a first-class product stage. It detects presentation defects, shows them on the affected slide, and lets the user choose what to repair.

The system keeps two classes separate:

- **deterministic findings** — reproducible checks with programmatic evidence;
- **contextual findings** — semantic/design judgments that may use the runtime supervisor.

A finding must say which class produced it.

The two-agent runtime remains intact: contextual audit is normally a supervisor capability/skill, not a third semantic agent. The worker owns broad generation/re-planning; deterministic code owns machine-checkable audit.

## Finding contract

A practical `AuditFinding` should carry:

```text
id
slideId
objectIds[]          optional
ruleId
category
severity
deterministic        boolean
message
evidence             structured when possible
repairable
suggestedAction      optional
checkpointVersion    when model review/repair is involved
```

Use stable slide/object ids so findings survive UI refreshes and can target local repair.

Suggested severities:

- `error` — export/integrity/editability or severe layout failure;
- `warning` — meaningful template/readability/semantic problem;
- `info` — non-blocking improvement.

## Deterministic checks

These checks should not call an LLM.

### Geometry and layout

- object outside slide bounds;
- unintended object overlap;
- text overflow/clipping;
- guide/alignment violations;
- unsafe edge margins;
- distorted image aspect ratio.

### Template compliance

- font outside the template's allowed set;
- excessive font families on one slide;
- font size outside the template scale;
- color outside allowed palette/roles;
- slide not based on an allowed template layout/derived layout family;
- moved or altered protected logo/header/footer;
- insufficient text/background contrast where measurable.

### Density

- more than six bullets unless the template explicitly supports it;
- overly long bullet copy;
- table beyond practical row/column limits;
- chart with too many simultaneous series;
- obvious underfill/overfill against slide-density bounds.

The exact threshold can be template-aware, but default case thresholds should remain stable and testable.

### Integrity

- PPTX cannot be opened/parsed after export;
- placeholder/test/prompt text leaked into output;
- empty or title-only slide without an intentional semantic role;
- full slide exported as one raster image;
- chart missing required axes/units/legend;
- duplicate slides;
- broken/missing asset relationship.

## Contextual checks

These are normally executed by the supervisor against a versioned checkpoint and may use rendered screenshots. Return structured findings/evidence summaries, not hidden chain-of-thought.

Check whether:

- the title states a useful conclusion rather than merely naming a topic;
- content supports the title/takeaway;
- the slide can be summarized by one clear sentence;
- substantive content is present;
- images/icons/diagrams are relevant;
- prompt/system/speaker-note garbage leaked into visible content;
- language is consistent and obvious typos are absent;
- table rows/legend items/chart series serve the slide point;
- adjacent slides form a coherent narrative.

Source consistency may be checked against the supplied content package where tractable. Do not turn this into an external research/fact-checking subsystem.

The supervisor should not re-audit every slide with a long model call. Deterministic findings, ambiguity, risk, and deadline remaining should decide where contextual review is valuable.

## When audit runs

Recommended stages:

1. **Spec validation** — before rendering; reject impossible slots/layout mappings.
2. **Post-render deterministic audit** — geometry, style, density, object integrity.
3. **Supervisor contextual review** — on high-value/ambiguous rendered/spec states and batches, using deterministic findings as evidence.
4. **Repair loop** — user-selected, supervisor-proposed, or safe automatic local fixes.
5. **Preflight** — final blocking checks immediately before export.

Audit must also be runnable on demand.

## Visual Audit UX

The presentation view should overlay findings on the affected regions where coordinates/object ids are known.

The issue panel should support:

- filter by severity/category;
- distinguish deterministic/contextual checks;
- select one or multiple repairable findings;
- `Fix selected`;
- jump to slide/object;
- show resolved/unresolved state.

The user is not required to repair every warning before export unless it is a preflight-blocking error.

## Repair contract

Repair is local.

A repair receives the finding, current `SlideSpec`, relevant template/design-system context, locks, and the expected checkpoint version. It returns an explicit mutation, a local re-plan request, or a conflict.

Rules:

- never change locked objects silently;
- reject stale checkpoint-targeted patches;
- do not regenerate unrelated slides;
- deterministic repairs should stay deterministic when possible;
- semantic repairs may be proposed by the supervisor but must pass schema/constraint/mutation validation;
- broad narrative or visual-type changes route back to the worker as a local re-plan;
- rerun affected deterministic checks after every repair;
- keep repair lineage for undo/debugging.

Examples:

- overflow -> shorten/fitsafe text or choose compatible text treatment;
- palette violation -> map to nearest allowed semantic color role;
- moved protected footer -> restore template position;
- weak title -> supervisor proposes title-only semantic patch;
- irrelevant image -> request/select new image candidates for the same image slot type.

The supervisor has no privileged mutation path. Its repair proposal uses the same lock-aware application boundary as user/worker edits.

## Automatic repair

Safe, meaning-preserving deterministic fixes may run automatically if they are reversible and cannot materially change the user's chosen design/content.

A supervisor-proposed semantic repair may be auto-applied only when product policy explicitly classifies that repair as safe, it passes validation, it does not touch locks, and the change remains visible/reversible. Otherwise surface it for selection or route through normal repair UX.

Anything that changes meaning, chart semantics, layout family, visual type, or a locked item requires explicit user action or a clearly visible re-plan.

## Preflight gates

PPTX export should be blocked or clearly fail when:

- the file cannot be produced/opened;
- a slide is represented primarily as a full-slide raster;
- severe overflow/out-of-bounds content remains;
- required protected template elements are corrupted;
- a required relationship/asset is broken.

Other warnings can remain exportable with visible status.

Preflight should report a compact summary, e.g.:

```text
15/15 slides structurally valid
0 blocking overflows
0 broken assets
0 rasterized slides
native object checks passed
3 non-blocking warnings
```

Preflight must respect the generation deadline. Never replace deterministic preflight with one more unbounded supervisor pass.

## Determinism and tests

Every deterministic rule needs fixture-based tests with both positive and negative examples.

Given the same rendered/spec state and audit version, deterministic findings must be identical.

Contextual rules need benchmark examples and regression scoring rather than pretending to be bit-for-bit deterministic. Track supervisor false positives, accepted repairs, regressions, and latency contribution.

`TESTING.md` defines the broader coverage strategy.
