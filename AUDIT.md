# Audit, repair, and preflight

## Purpose

Audit is a first-class product stage. It detects presentation defects, shows them on the affected slide, and lets the user choose what to repair.

The system keeps two classes separate:

- **deterministic findings** — reproducible checks with programmatic evidence;
- **contextual findings** — semantic/design judgments normally handled by the runtime Supervisor.

A finding must say which class produced it. Contextual audit is a Supervisor capability, not a third semantic agent.

The replaceable offline audit checks measured title/body/visual bounds and overlaps, selected-layout references, blank text slides, broken ContentIR/media references, numeric values plus explicit currencies/percentages/dates against cited units, table-cell provenance, chart categories/series labels/values and slide provenance, KPI numeric source cells, process step refs, common placeholder strings, duplicate slide text, more-than-six explicit bullets, bullets of at least twenty words, chart-series count, and table row/column limits. The long-bullet rule is a lexical warning, not a fit calculation. The compiler explicitly rejects a plan when no measured title/content slots can carry its text instead of publishing fallback geometry. Invalid image source paths, missing files, hash mismatches, and unsupported image formats produce typed Office Kit backend failures with an attached deterministic finding. Both render paths remove inactive source slides and speaker notes; source-only image, chart, and workbook parts are pruned only when unreachable from the generated package root. Office Kit render results include reopen, package validation, retained-source-part preservation, native object counts, and unresolved visual types; the custom renderer reports its unsupported visual types and leaves reopen/preservation status unknown. Numeric checking is lexical and does not infer conversions, derived-value validity, or semantic equivalence. Text overflow, crop/aspect distortion for unsupported image formats, inherited style/contrast, PowerPoint rendering, and semantic entailment remain unknown or belong to preview/contextual review. Preview overflow results are recorded but do not turn an approximate renderer into an export oracle. A compile-time or Office Kit package-validation pass is not a PowerPoint/LibreOffice export preflight pass.

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

Use stable slide/object ids so findings survive UI refresh/reconnect and can target local repair.

Suggested severities:

- `error` — export/integrity/editability or severe layout failure;
- `warning` — meaningful template/readability/semantic problem;
- `info` — non-blocking improvement.

## Deterministic checks

These checks do not call an LLM.

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
- slide not based on an allowed template layout/derived family;
- moved/altered protected logo/header/footer;
- insufficient measurable contrast.

### Density

- more than six bullets unless the template supports it;
- overly long bullet copy;
- table beyond practical row/column limits;
- chart with too many simultaneous series;
- obvious underfill/overfill against slide-density bounds.

Thresholds may be template-aware, but default case thresholds remain stable and testable.

### Integrity

- PPTX cannot be opened/parsed after export;
- placeholder/test/prompt text leaked into output;
- empty/title-only slide without intentional role;
- full slide exported as one raster image;
- chart missing required axes/units/legend;
- duplicate slides;
- broken/missing asset relationship.

## Contextual checks

Supervisor contextual review may use rendered screenshots plus structured checkpoint state. Return structured findings/evidence summaries, not hidden chain-of-thought.

Check whether:

- title states a useful conclusion rather than only a topic;
- content supports the title/takeaway;
- the slide has one clear takeaway;
- substantive content is present;
- images/icons/diagrams are relevant;
- prompt/system/speaker-note garbage leaked into visible content;
- language is consistent and obvious typos are absent;
- table rows/legend items/chart series serve the slide point;
- adjacent slides form a coherent narrative.

Source consistency may be checked against supplied content where tractable. Do not turn this into external research/fact-checking.

Supervisor should not re-audit every slide with a long call. Deterministic findings, ambiguity, risk, and remaining deadline decide where contextual review is worth the latency.

An internal, replaceable `ContextualSlideAuditPort` describes one bounded Supervisor capability over a rendered slide image, exact text, cited source evidence, and neighboring slide summaries. Its eight gates cover takeaway title, title support, one-sentence summary, factual grounding, visual relevance, prompt garbage, language consistency, and adjacent-slide narrative. Only the typed contract and local fake test exist: contextual findings are not wired to a model adapter, rendered-image pipeline, persistence, API, or UI. The current generation API/UI instead exposes deterministic findings persisted with each rendered variant.

## Audit during progressive generation

Audit must support continuous slide-pack generation rather than forcing a serial review workflow. In the implemented application slice, each variant receives deterministic audit before the complete A/B/C pack is published, and the findings are stored with the variant. The client reads changes through persisted REST snapshots; no push event transport is implemented.

For each slide pack:

1. validate the three `SlideSpec` candidates before publication;
2. run blocking deterministic render/integrity checks required for a usable pack;
3. publish the valid A/B/C pack;
4. continue generation of later slides immediately;
5. run contextual review and any follow-up review asynchronously where appropriate;
6. make later findings or repairs visible in the persisted snapshot. A future streaming client may notify the user with `audit.updated` / `slide.updated` events.

A severe deterministic problem may prevent publication of the affected pack until repaired. Ordinary warnings and contextual Supervisor review must not hold the entire generation queue.

Visual candidates that arrive later receive their own deterministic/contextual checks without resetting the slide pack or blocking unrelated future slides.

Audit must also be runnable on demand.

## Visual Audit UX

The presentation view should overlay findings on affected regions where coordinates/object ids are known.

The current generation panel shows stored deterministic findings and exposes the available safe local layout repair. The broader audit UX should support:

- filter by severity/category;
- distinguish deterministic/contextual checks;
- select one or multiple repairable findings;
- `Fix selected`;
- jump to slide/object;
- show resolved/unresolved state.

The user is not required to repair every warning before export unless it is preflight-blocking.

## Repair contract

Repair is local.

A repair receives the finding, current `SlideSpec`, relevant template/design-system context, locks, and expected checkpoint version. It returns an explicit mutation, a local re-plan request, or a conflict.

Rules:

- never change locked objects silently;
- reject stale checkpoint-targeted patches;
- do not regenerate unrelated slides;
- deterministic repairs stay deterministic when possible;
- Supervisor semantic repairs must pass schema/constraint/mutation validation;
- broad narrative or visual-type changes route back to Worker as a local re-plan;
- rerun affected deterministic checks after repair;
- keep repair lineage for undo/debugging;
- do not pause unrelated background slide generation unless the repair invalidates shared future state.

Examples:

- overflow -> shorten/fitsafe text or compatible text treatment;
- palette violation -> map to allowed semantic color role;
- moved protected footer -> restore template position;
- weak title -> title-only semantic patch;
- irrelevant image -> request/select new image candidates for the same image slot type.

Supervisor has no privileged mutation path.

## Automatic repair

Safe, meaning-preserving deterministic fixes may run automatically when reversible and unable to materially change the user's chosen design/content.

A Supervisor-proposed semantic repair may be auto-applied only when product policy marks it safe, validation passes, locks are untouched, and the change remains visible/reversible. Otherwise surface it for selection or route through normal repair UX.

Anything that changes meaning, chart semantics, layout family, visual type, or a locked item requires explicit action or visible re-plan.

The offline compiler has a one-attempt alternate-layout helper. Phase 2 connects a slide-local deterministic layout change to persisted generation state: it checks the finding, lock and expected slide version, renders/audits only the affected variant, and rejects the repair if the blocking issue remains. It never edits text or factual content. Contextual semantic repair and multi-finding repair selection are not implemented.

## Preflight gates

PPTX export should block/fail when:

- the file cannot be produced/opened;
- a slide is primarily a full-slide raster;
- severe overflow/out-of-bounds content remains;
- protected template elements are corrupted;
- a required relationship/asset is broken.

Other warnings may remain exportable with visible status.

Example summary:

```text
15/15 slides structurally valid
0 blocking overflows
0 broken assets
0 rasterized slides
native object checks passed
3 non-blocking warnings
```

Preflight respects the generation deadline. Never replace deterministic preflight with an unbounded Supervisor pass.

## Determinism and tests

Every deterministic rule needs positive/negative fixture tests. Given the same rendered/spec state and audit version, deterministic findings must be identical.

Contextual rules use benchmark examples/regression scoring. Track Supervisor false positives, accepted repairs, regressions, and latency contribution.

`TESTING.md` defines broader coverage.
