# Product specification

## One-sentence definition

Upload a corporate PPTX template and source materials, receive a complete recommended deck, optionally choose the best of three alternatives for any slide or visual, selectively repair audit findings, and export an editable native presentation.

This document is the canonical source of truth for product behavior.

## Inputs and outputs

Inputs:

- an arbitrary PPTX template, including a template never seen before;
- a content package supplied by the user;
- a short brief: audience, purpose, expected outcome, and optional preferences;
- optional target slide count.

Primary outputs:

- a recommended presentation that follows the uploaded template;
- three alternatives for every slide;
- three candidates for each meaningful visual slot;
- coherent whole-deck A/B/C tracks;
- audit findings and selective repair;
- editable native PPTX, plus PDF and HTML.

## Product principles

### Good default first

Generation ends in a usable recommended deck without requiring the user to review alternatives. Every candidate set has a system-selected default.

Alternatives add control; they do not create mandatory work.

### Constrained choice

The system decides the semantic role first, then offers alternatives inside that role.

A photo slot produces photo candidates. A chart slot produces chart candidates. A table slot produces table candidates. Changing the semantic type is an explicit re-plan action because it can change composition and meaning.

### Preserve approved work

Users can lock a slide or valuable block such as a visual, chart, or headline. Local regeneration and repair must preserve those locks. If a requested edit conflicts with a lock, surface the conflict instead of silently modifying the locked item.

### Review by exception

The main presentation view shows the recommended result. Alternatives are available on demand. A "Needs attention" mode surfaces only audit findings, unresolved conflicts, or genuinely ambiguous decisions.

### Template fidelity is a constraint

The system must use the template's masters, layouts, placeholders, tokens, assets, and composition patterns where possible. It must not merely imitate screenshots.

### Native output

PPTX is a structured editable deliverable. Text, shapes, images, tables, charts, and other supported elements should remain native objects. A full-slide screenshot is not a valid primary implementation.

## Canonical user flow

1. Create a project.
2. Upload the PPTX template.
3. Upload source materials and enter a brief.
4. Analyze the template.
5. Show a lightweight "Template understood" inspector.
6. Generate a deck outline before expensive slide rendering.
7. Let the user optionally add/remove/reorder slides or adjust a slide purpose.
8. Generate the recommended deck plus A/B/C candidates for each slide.
9. Generate/select A/B/C candidates inside planned visual slots.
10. Let the user switch candidates, lock approved work, or request local regeneration.
11. Run built-in audit.
12. Let the user select findings to repair.
13. Run preflight.
14. Export PPTX/PDF/HTML.

The user may accept defaults at every optional review step.

## Template understanding

The uploaded PPTX is structured input, not a background image source.

Extract exact properties programmatically where possible:

- slide size/aspect ratio;
- masters and layouts;
- placeholders and geometry;
- theme colors;
- typography and paragraph styles;
- margins, guides, alignment, and spacing patterns;
- logos, headers, footers, repeated assets;
- images, shapes, icons, tables, and charts;
- relationships between slides, layouts, masters, and assets.

Derive semantic design information where useful:

- layout/composition families;
- semantic slot roles;
- visual hierarchy;
- density patterns;
- image treatment;
- chart/table conventions;
- reusable design rules.

The original PPTX remains immutable source material for native rendering/export.

## Template Inspector

After analysis, show a compact summary such as:

```text
12 layouts
8 colors
3 typography levels
17 reusable assets
4 chart patterns
6 composition families
```

The inspector may expose previews of layouts, colors, typography, assets, chart conventions, and detected rules. It is an explainability and confidence surface, not a full design-system editor.

Analyzed templates should be reusable across projects when practical. The product must still work on an unseen template without manual preconfiguration.

## Content and outline

Use the supplied content package to extract only what the deck planner needs: themes, claims, metrics, comparisons, chronology, entities, process steps, tables/data structures, imagery, conclusions, and supporting detail.

Do not make external research or broad fact-checking a core dependency. The primary task is correct use of the supplied context.

Before slide generation, create a storyboard. Each planned slide has at least:

- purpose;
- one-sentence takeaway;
- supporting content;
- intended semantic visual type;
- optional notes about density or evidence.

The outline is cheap to edit. Generation can continue with the system recommendation if the user does nothing.

## Slide planning

For each slide determine:

- slide intent and takeaway;
- compatible layout family;
- one selected layout or a small valid candidate set;
- semantic visual type;
- density target;
- required content slots.

The model selects among valid template structures. It does not get unrestricted authority to invent geometry.

## Slide alternatives — mandatory

Generate three alternatives for every slide from the same planned meaning.

A/B/C may vary by compatible layout, composition, grouping, emphasis, density, or visualization treatment. All three must comply with the same template and preserve the slide's core message.

The system recommends one candidate.

The product also preserves coherent Deck A, Deck B, and Deck C tracks so three full presentation variants can be demonstrated/exported. The user-selected presentation may mix candidates slide by slide.

## Visual alternatives — mandatory

A meaningful visual slot has one planned semantic type:

- image/photo;
- chart;
- table;
- diagram;
- icon/pictogram;
- SmartArt-like structure;
- text-only/no visual.

Generate or select up to three useful candidates inside the chosen type and recommend one by default.

Ordinary candidate switching must never silently turn a photo into a chart or a chart into a diagram. Type changes are explicit re-plans.

## Local regeneration

Support targeted operations before whole-deck regeneration:

- three more slide variants;
- another compatible template layout;
- lower/higher density within safe bounds;
- shorter copy or stronger headline;
- three more image candidates;
- another compatible chart/diagram treatment.

Unrelated slides and locked elements must remain stable.

## Audit, repair, and preflight

Audit is part of the generation loop, not an afterthought.

The UI highlights findings on the slide and lists them with selectable repair actions. Deterministic findings and contextual findings remain distinguishable. Repairs are local and respect locks.

`AUDIT.md` is the canonical audit contract.

## Hackathon acceptance behavior

The implementation is designed around:

- unseen PPTX templates;
- approximately 10–15 slides or user-selected count;
- normal generation within five minutes;
- structure/content planning before slide rendering;
- charts, tables, diagrams, icons/pictograms, and SmartArt-like elements;
- image generation;
- three visibly distinct results for the same template/content;
- integrated audit and user-selectable repair;
- editable native PPTX objects;
- versioned skills/prompts/agents;
- tests and reproducible setup;
- explicit parsing, generation, layout, audit, and export boundaries;
- desktop operation in current/previous major browsers required by the case.

## Non-goals

Do not spend hackathon time on:

- universal vector editing;
- replacing desktop presentation software;
- multiplayer collaboration;
- enterprise roles/permissions;
- marketplace/community mechanics;
- video/audio generation;
- mobile apps;
- generic website/prototype generation;
- a large external research/fact-checking system;
- dozens of expert settings that weaken the default workflow.

Low-cost designer conveniences are welcome when they directly improve presentation work.

## Ideal live demo

1. Upload an unseen PPTX.
2. Upload a content package and enter a brief.
3. Show Template Inspector.
4. Show and optionally edit the outline.
5. Generate the recommended deck.
6. Switch one slide between A/B/C.
7. Switch one photo/chart/diagram between three same-type candidates.
8. Lock an approved visual.
9. Regenerate its slide and show the lock is preserved.
10. Open Visual Audit.
11. Select and repair one finding.
12. Run preflight.
13. Export PPTX and show editable text/shapes/charts/images.
