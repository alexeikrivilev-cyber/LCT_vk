# Product specification

## Final product definition

LCT is a presentation compiler, not a slide editor. A user provides an arbitrary PPTX template, source materials, and a brief. The system understands the template, plans the narrative, continuously generates slide packs, provides controlled alternatives, audits and repairs the result, and exports a native editable presentation.

The product UI and visual design may be redesigned completely. Future implementation must follow this product contract and workflow, not preserve the current interface.

This document is the canonical source of truth for product behavior.

## Inputs and outputs

Inputs:

- arbitrary PPTX template, including unseen templates;
- supplied content package;
- brief: audience, purpose, expected outcome, preferences;
- optional slide count.

Outputs:

- recommended presentation;
- A/B/C alternatives for every slide;
- A/B/C candidates for meaningful visual slots;
- coherent full-deck A/B/C tracks;
- audit findings and selective repair;
- editable native PPTX plus PDF and HTML derivatives.

## Core product principles

### Default result first

The system always produces a usable recommended deck. Alternatives increase control but never create mandatory review steps.

### Constrained creativity

The system chooses semantic intent first, then generates alternatives inside valid template and content constraints.

A photo slot receives photo candidates. A chart slot receives chart candidates. A type change is an explicit re-plan operation.

### Preserve user decisions

Users can lock approved slides and blocks. Local regeneration and repair must preserve locks or explicitly report conflicts.

### Template as structure

PPTX is not a screenshot source. Masters, layouts, placeholders, tokens, assets, geometry, and relationships are structural input.

### Native deliverable

The exported PPTX remains editable. Text, shapes, charts, tables, and images should remain native objects. Full-slide rasterization is not an acceptable implementation.

## Progressive generation UX

After the deck outline/plan exists, generation runs continuously until the requested deck is complete. The user is not asked to approve each slide before the next one starts.

A **slide pack** is the three A/B/C variants for one planned slide. The product should publish slide packs progressively in deck order. A pack becomes visible when its three structural variants are valid enough to inspect; generation of later slides continues immediately in the background.

The interface should surface progress without interrupting the user, for example a persistent top status such as `5 / 12 slides ready` and a lightweight indication that new slides appeared. Avoid modal approval loops and repeated "continue" actions.

While generation continues, the user may inspect already-ready slides, switch A/B/C, choose visual candidates, lock approved elements, or request a local edit. Those actions must not restart or pause unrelated pending slides. Only explicit pause/cancel, a user action that truly invalidates future plan state, or a blocking system failure may stop forward generation.

Internal computation may pipeline adjacent work for throughput, but user-visible publication stays coherent and ordered. Do not expose half-created A/B/C groups as if they were complete slide choices.

### Visual candidates during progressive generation

The slide plan fixes each visual slot type before candidate generation. A structural slide pack may become available while an image/photo slot is still producing its three candidates; the slot should show a clear generating state and update in place when candidates arrive.

Native charts, tables, diagrams, icons, and SmartArt-like structures should be produced through the presentation pipeline rather than treated as raster media. Their alternatives still remain inside the planned semantic type.

The system always chooses a recommended default when candidates are ready. The user never has to stop deck generation to choose one.

## Canonical workflow

1. Create project.
2. Upload template.
3. Upload content and brief.
4. Analyze template.
5. Show template-understanding summary.
6. Build editable storyboard/deck plan.
7. Start continuous generation.
8. Publish slide 1 A/B/C, then slide 2 A/B/C, and so on while generation continues.
9. Generate same-type visual candidates in the background and update ready slides in place.
10. Allow switching, locking, and local regeneration without resetting unrelated pending work.
11. Run deterministic audit continuously and contextual/supervisor review where valuable.
12. Repair selected or safe local findings.
13. Run preflight.
14. Export.

The user may accept defaults at every optional interaction point.

## Slide alternatives

Every planned slide receives three alternatives derived from the same intended meaning.

A/B/C may differ in compatible layout, composition, grouping, emphasis, density, or visualization treatment, but must preserve the slide's core message and template compliance.

The system selects one recommended candidate. Coherent Deck A, Deck B, and Deck C tracks must remain reconstructable for the formal three-variant requirement, while the user's selected deck may mix candidates slide by slide.

## Visual alternatives

A meaningful visual slot has one planned semantic type, such as:

- image/photo;
- chart;
- table;
- diagram;
- icon/pictogram;
- SmartArt-like structure;
- text-only/no visual.

Generate/select up to three useful candidates inside the type and recommend one by default. Ordinary candidate switching must never silently change semantic type; type changes are explicit re-plans.

## Locks and local regeneration

Locks may protect a slide or valuable block such as a visual, chart, headline, or other content unit.

Prefer targeted operations:

- three more slide variants;
- another compatible layout;
- lower/higher density within safe bounds;
- shorter copy or stronger headline;
- three more image candidates;
- another compatible chart/diagram treatment.

Local operations must preserve unrelated ready slides and must not reset the still-running generation queue unless the affected plan state actually changes.

## Audit and review by exception

Audit is part of generation, not a final afterthought. Deterministic checks run as soon as a slide/render is available. Contextual/supervisor review is targeted to high-value or uncertain checkpoints and must not become a mandatory serial gate between slide packs.

The primary deck view shows the recommended result. Alternatives remain available on demand. A "Needs attention" surface should focus the user on unresolved audit findings, conflicts, or genuinely ambiguous decisions.

`AUDIT.md` is the canonical audit/repair contract.

## Acceptance criteria

The implementation must support:

- unseen PPTX templates;
- approximately 10–15 slides or user-selected count;
- a normal deck completed within 300 seconds with a warm inference service;
- progressive slide-pack availability before the whole deck is finished;
- uninterrupted background generation without per-pack user approval;
- planning before rendering;
- charts, tables, diagrams, icons/pictograms, SmartArt-like structures, and image generation;
- three distinct variants per slide from one shared meaning/plan;
- three same-type candidates for meaningful visual slots;
- integrated audit and selective repair;
- locks and local regeneration;
- native editable PPTX export;
- versioned skills/prompts/agent instructions;
- tests and reproducible setup;
- explicit parser, planning, rendering, audit, inference, and export boundaries.

## Non-goals

Do not turn the product into:

- a universal graphics editor;
- a replacement for desktop presentation software;
- a generic website builder;
- a research/fact-checking platform;
- a complex expert-configurable design tool;
- an approval workflow that forces the user to babysit generation slide by slide.

Low-cost features are valid only when they improve presentation creation.

## Demo path

The final demo should prove:

1. Upload an unseen PPTX.
2. Analyze template and show template understanding.
3. Show/accept the deck outline.
4. Start generation once.
5. Watch slide packs appear progressively while the system keeps generating.
6. Inspect/switch one already-ready A/B/C slide without stopping background generation.
7. Watch three same-type visual candidates arrive/update a slot.
8. Lock approved content and locally regenerate without disturbing unrelated slides.
9. Open audit and repair a selected finding.
10. Run preflight and export an editable native PPTX.
