# Product specification

## Final product definition

LCT is a presentation compiler, not a slide editor. A user provides an arbitrary PPTX template, source materials, and a brief. The system understands the template, plans the narrative, generates a recommended editable deck, provides controlled alternatives, audits the result, repairs issues selectively, and exports a native presentation.

The product UI and visual design system are allowed to be redesigned completely. Future implementation must follow this product contract and workflow, not preserve the current interface.

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

The system always produces a usable recommended deck. Alternatives increase control but are never mandatory workflow steps.

### Constrained creativity

The system chooses semantic intent first, then generates alternatives inside valid template and content constraints.

A photo slot receives photo candidates. A chart slot receives chart candidates. A type change is an explicit re-plan operation.

### Preserve user decisions

Users can lock approved slides and blocks. Local regeneration and repair must preserve locks or explicitly report conflicts.

### Template as structure

PPTX is not a screenshot source. Masters, layouts, placeholders, tokens, assets, geometry, and relationships are structural input.

### Native deliverable

The exported PPTX remains editable. Text, shapes, charts, tables, and images should remain native objects. Full-slide rasterization is not an acceptable implementation.

## Canonical workflow

1. Create project.
2. Upload template.
3. Upload content and brief.
4. Analyze template.
5. Show template understanding summary.
6. Build editable storyboard.
7. Generate recommended deck and A/B/C slide alternatives.
8. Generate/select same-type visual candidates.
9. Allow switching, locking, and local regeneration.
10. Run audit.
11. Repair selected findings.
12. Run preflight.
13. Export.

## Acceptance criteria

The implementation must support:

- unseen PPTX templates;
- 10–15 slide generation target;
- planning before rendering;
- charts, tables, diagrams, icons, and image generation;
- three distinct variants from the same meaning;
- integrated audit and repair;
- native editable export;
- versioned skills/prompts;
- explicit parser, planning, rendering, audit, and export boundaries.

## Non-goals

Do not turn the product into:

- a universal graphics editor;
- a replacement for desktop presentation software;
- a generic website builder;
- a research/fact-checking platform;
- a complex expert-configurable design tool.

Low-cost features are valid only when they improve presentation creation.

## Demo path

The final demo should prove:

1. Upload unseen PPTX.
2. Analyze template.
3. Show template understanding.
4. Generate recommended deck.
5. Compare A/B/C slide variants.
6. Compare same-type visual candidates.
7. Lock approved content.
8. Regenerate locally while preserving locks.
9. Audit and repair.
10. Export editable PPTX.
