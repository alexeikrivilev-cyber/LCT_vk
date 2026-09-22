# Audit, repair, and preflight

## Purpose

Audit is a first-class product stage. It detects presentation defects, shows them on the affected slide, and lets the user choose what to repair.

The system keeps two classes separate:

- **deterministic findings** — reproducible checks with programmatic evidence;
- **contextual findings** — semantic/design judgments that may use a model.

A finding must say which class produced it.

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

These may use a model/VLM and should return structured evidence/reasoning summaries, not hidden chain-of-thought.

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

## When audit runs

Recommended stages:

1. **Spec validation** — before rendering; reject impossible slots/layout mappings.
2. **Post-render deterministic audit** — geometry, style, density, object integrity.
3. **Contextual audit** — only on rendered/spec states that pass basic structural checks.
4. **Repair loop** — user-selected or safe automatic local fixes.
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

A repair receives the finding, current `SlideSpec`, relevant template/design-system context, and locks. It returns an explicit mutation or a conflict.

Rules:

- never change locked objects silently;
- do not regenerate unrelated slides;
- deterministic repairs should stay deterministic when possible;
- semantic repairs may call the model but must still pass schema/constraint validation;
- rerun affected deterministic checks after every repair;
- keep repair lineage for undo/debugging.

Examples:

- overflow -> shorten/fitsafe text or choose compatible text treatment;
- palette violation -> map to nearest allowed semantic color role;
- moved protected footer -> restore template position;
- weak title -> rewrite title only;
- irrelevant image -> generate/select new image candidates for the same image slot type.

## Automatic repair

Safe, meaning-preserving deterministic fixes may run automatically if they are reversible and cannot materially change the user's chosen design/content.

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

## Determinism and tests

Every deterministic rule needs fixture-based tests with both positive and negative examples.

Given the same rendered/spec state and audit version, deterministic findings must be identical.

Contextual rules need benchmark examples and regression scoring rather than pretending to be bit-for-bit deterministic.

`TESTING.md` defines the broader coverage strategy.
