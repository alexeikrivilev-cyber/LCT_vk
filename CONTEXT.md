# LCT — Canonical Product Context

## Product identity

LCT is a focused corporate presentation product for the LCT/VK Tech case.

The product is a **presentation compiler with guided generative editing**, not a generic presentation chatbot and not a full Canva/Figma/PowerPoint replacement.

Input:

- arbitrary corporate PPTX template, including templates never seen before;
- content pack;
- short brief and purpose;
- optional slide count and lightweight preferences.

Output:

- complete recommended presentation matching the template's design/composition rules;
- controlled alternatives at slide and visual level;
- built-in review/audit/repair;
- editable native PPTX plus PDF/HTML.

## Core business value

The product removes repetitive manual work between "I have content" and "I have a corporate-quality deck": understanding a template, selecting slide patterns, fitting content to brand rules, choosing/generating visuals and charts, fixing layout defects, and preparing an editable deck.

The user should make a small number of meaningful choices, not manually recreate a design system.

## Product principles

### Good default first

The system always produces a complete recommended result. Alternatives provide control but are never mandatory blockers. Every candidate set has a system-selected default.

### Constrained choice, not an infinite editor

The system decides the semantic role of each slide and visual block, then offers alternatives inside that decision.

If a slot is a photo, normal alternatives are three photos. If a slot is a chart, normal alternatives are three compatible chart treatments. Changing semantic type is an explicit re-plan action, not ordinary candidate selection.

### Local changes preserve approved work

Users can lock approved slides/visuals/headlines. Regeneration elsewhere must not casually alter them. Local edits are preferred over full-deck regeneration.

### Review by exception

The system chooses strong defaults and surfaces optional alternatives plus items that need attention. The user should not inspect every candidate manually.

### Template fidelity is a system constraint

The system should understand/reuse template rules, layouts, tokens, assets, and native presentation structure, not merely imitate screenshots.

## Canonical end-to-end flow

`template + content + brief -> template understanding -> content understanding -> deck outline -> outline review -> slide planning -> layout/visual-type selection -> A/B/C slide candidates -> A/B/C visual candidates -> recommended defaults -> user overrides/locks -> audit -> selective repair -> preflight -> editable export`

## Template understanding

The PPTX is treated as structured design source material. Derive an internal presentation design system including where available:

- dimensions/aspect ratio;
- masters/layouts;
- placeholders/semantic slots;
- theme colors and roles;
- typography hierarchy/scales;
- grid/guides/margins/spacing;
- logos/headers/footers/repeated assets;
- reusable shapes/icons/image treatments;
- chart/table conventions;
- composition families;
- information-density patterns;
- recurring visual rules/constraints.

The original PPTX remains an important source of truth for native output.

## Template Inspector

After analysis show a lightweight "Template understood" surface, for example:

- 12 layouts
- 8 colors
- 3 typography levels
- 17 reusable assets
- 4 chart patterns
- 6 composition families

The user may inspect detected colors, typography, layouts, assets, charts, and rules. This is primarily confidence/explainability UX, not a complex manual design-system editor.

Analyzed corporate templates should be reusable across projects, while unseen templates must still work without manual preconfiguration.

## Content understanding

Use the supplied content pack to extract what planning needs: themes, statements, metrics/numeric series, comparisons, chronology, entities, process steps, tables/data structures, available imagery, conclusions and supporting evidence.

Do not make a heavy external research/fact-checking subsystem a core product dependency. The primary task is to use supplied context correctly.

## Deck outline before design

Before expensive layout generation, create a storyboard. For every planned slide define:

- purpose;
- main message/takeaway;
- supporting content;
- intended semantic visual type if any.

Example:

`Slide 05 — Explain market growth — takeaway: ... — visual: line chart`

The user gets a lightweight outline review and can add/remove/reorder slides or edit a slide purpose/message. If the user does nothing, generation proceeds with the recommendation.

## Slide planning

For each slide determine:

- slide intent;
- conclusion/message;
- compatible template layout family;
- specific allowed layout or small candidate set;
- semantic visual type;
- intended density;
- required content slots.

The model should choose among valid template structures rather than invent arbitrary geometry.

## Fixed semantic visual type

Each visual slot receives one planned type:

- photo/image;
- chart;
- table;
- diagram;
- icon/pictogram;
- SmartArt-like structure;
- text-only/no visual.

Normal alternatives stay inside the planned type. Changing type requires explicit re-planning.

## Three variants per slide — mandatory

The primary product UX is three alternatives for **each slide**, not merely three separate presentation files.

For every slide create A/B/C variants with the same intended message but controlled visual differences such as compatible layout, density, grouping, emphasis, composition, or data visualization treatment. All must follow the same template.

The system recommends one by default. The user may instantly switch.

Example: `Slide 04: A | B (recommended) | C`.

## Preserve three coherent whole-deck tracks

The product must still be able to export/show coherent Deck A, Deck B, and Deck C for the formal hackathon requirement.

Additionally, the user can assemble a custom mixed deck from preferred per-slide variants, e.g. `A1, B2, B3, C4, A5...`.

## Three candidates per visual slot — mandatory

After the semantic visual role is fixed, generate/select three candidates inside that role:

- photo slot -> three photos;
- chart slot -> three compatible chart treatments;
- diagram slot -> three diagrams;
- similarly for tables/icons/SmartArt-like elements when meaningful.

The system recommends one candidate by default. Normal selection never silently changes the slot type.

## Variation hierarchy

Keep four levels distinct:

1. **Deck structure** — which slides exist and in what order.
2. **Slide composition** — A/B/C variants of one slide intent.
3. **Visual-slot content** — three candidates inside one fixed visual type.
4. **Micro-edits** — shorter text, stronger headline, less dense, another image, another compatible chart treatment, etc.

## Lock / Pin

Allow locking at useful levels such as entire slide, image/visual, chart, headline, or another valuable content block.

Regeneration preserves locks. If the requested action is impossible without changing a locked item, surface the conflict instead of silently modifying it.

## Local regeneration

Prefer local operations.

For a slide: three more variants, another compatible template layout, less dense, more visual, more concise.

For text: shorter, more direct, rewrite headline.

For image: three more candidates or replace image while keeping slot role.

For chart/diagram: three more candidates, simplify, choose another compatible treatment.

Unrelated slides and locked elements remain unchanged.

## Review by exception

The main review UX has three conceptual modes:

- **Presentation** — complete recommended deck.
- **Alternatives** — A/B/C slides and visual candidates.
- **Needs attention** — only slides/elements with audit findings, unresolved ambiguity, or explicit action required.

## Built-in audit

Audit is part of the generation pipeline.

### Deterministic checks

Examples:

- object outside slide bounds;
- overlap;
- text overflow/cropping;
- guide/alignment/margin violations;
- distorted image aspect ratio;
- non-template fonts/sizes/colors/layouts;
- moved logo/footer;
- low contrast;
- excessive bullet/table/chart density;
- underfilled/overfilled slide;
- placeholder garbage;
- empty slide;
- slide exported as a single raster rather than editable objects;
- missing chart labels/units/legend where required;
- duplicate slides;
- broken export.

### Contextual checks

Examples:

- title states a conclusion rather than merely naming a topic;
- content supports the title;
- slide has a clear one-sentence takeaway;
- visuals are relevant;
- no prompt/system garbage appears;
- language is consistent;
- adjacent slides form a logical narrative;
- charts/tables serve the slide message.

Do not over-invest in a separate fact-checking product during the hackathon.

## Visual Audit and selective repair

Audit findings should be visible on the slide, not hidden in logs. Highlight relevant regions and list issues with checkboxes.

The user chooses which issues to fix. Repairs are local and respect locks.

Safe deterministic corrections may happen automatically when they cannot materially change meaning/design intent.

## Preflight

Before export run a final check for slide validity, overflow/overlap, template compliance, native object editability, and lock preservation. If issues remain, navigate directly to affected slides.

## Export

Required product outputs:

- editable native PPTX;
- PDF;
- HTML.

Whole-slide raster screenshots are not a valid primary PPTX strategy. Preserve native editable presentation semantics wherever required.

## Lightweight history

Keep undo/redo and meaningful checkpoints if cheap to retain. Do not build a complex version-control product for the hackathon.

## Conceptual project state

A project contains:

- Template
  - derived design system
  - layouts
  - assets
  - rules
- Content
  - source materials
  - brief
- Deck Plan
  - slide intents/messages/visual types
- Generated Slides
  - A/B/C per slide
- Selected Deck
  - chosen variant per slide
- Visual Slots
  - candidate images/charts/diagrams/etc.
- Locks
- Audit Results
- Export state

## Model vs deterministic responsibilities

Use models for semantic decisions: narrative, slide purpose, wording, conclusion-style titles, semantic layout choice among valid candidates, visual type, contextual audit/repair suggestions.

Use deterministic/programmatic logic for exact template properties, geometry, constraints, layout compatibility, native object creation, lock preservation, deterministic audit, persistence, and export correctness.

The runtime model operates inside a constrained design space instead of freely inventing a complete presentation surface.

## Skill orchestration

Eventually use one top-level presentation orchestrator with smaller specialized skills beneath it:

`understand template -> understand content -> plan deck -> select valid layouts -> select visual types -> generate candidates -> select defaults -> audit -> repair -> export`

Do not implement this as one giant prompt. Prompts/configs/skills remain separate, versionable files.

## Offline behavioral distillation

Development strategy:

1. Maintain a fixed benchmark of templates, content packs, and briefs.
2. Generate with the intended runtime model and current skills.
3. Give outputs/screenshots/audit findings/instructions to a stronger offline critic.
4. Ask for concrete skill/prompt/example/constraint improvements.
5. Apply a candidate patch.
6. Re-run the full benchmark.
7. Accept only if quality improves without unacceptable regressions.
8. Version the accepted skill/instruction set.

Astra or another strong model may be used as an offline R&D critic. It is not a production/runtime dependency.

This is behavioral distillation into instructions, examples, retrieval/context structure, constraints, layout rules, validators, and repair policies — not weight distillation.

## LCT foundation policy

Preserve proven LCT components when they help and are cheap to maintain, especially project/workspace, files/persistence, design systems, skills/agents, image provider abstraction, preview/rendering, assets, local editing/regeneration, useful history/undo, shared designer UI, and relevant export foundations.

The fork's presentation-specific value begins at:

`unknown PPTX -> extracted presentation design system -> constrained presentation planning/generation -> native deck -> audit/repair`

## Non-goals

Do not spend significant hackathon effort on:

- universal vector editing;
- replacing PowerPoint/Figma/Canva;
- multiplayer collaboration;
- enterprise roles/permissions;
- marketplace/community mechanics;
- video/audio generation;
- mobile apps;
- general website/prototype generation;
- large research/fact-checking systems;
- dozens of advanced generation settings.

Keep only low-cost designer conveniences that directly improve presentation work.

## Hackathon constraints that shape the product

Design every decision around:

- unseen PPTX templates, not hardcoded provided templates;
- roughly 10–15 slides or user-defined count;
- deck generation within the case time budget;
- structure/content planning before layout;
- charts, tables, diagrams, icons/pictograms, SmartArt-like elements;
- image generation in the advanced/final workflow;
- three visually distinct results for the same template/content;
- integrated audit with user-selectable repair;
- native editable PPTX objects;
- versioned skills/agents;
- tests and reproducibility;
- clearly separated parsing, generation, layout, audit, and export responsibilities.

## Ideal live demo

1. Upload unseen PPTX.
2. Upload content pack and enter brief.
3. Show "Template understood" and extracted design rules/layouts.
4. Show deck outline.
5. Generate full recommended deck.
6. Switch one slide among A/B/C.
7. Switch one photo/chart/diagram among three candidates.
8. Lock an approved visual.
9. Regenerate its slide and show that the lock is respected.
10. Open Visual Audit.
11. Select and repair one issue.
12. Run preflight.
13. Export PPTX and show editable text/shapes/charts/images.

## One-sentence definition

**Upload a corporate PPTX template and source materials, receive a complete recommended deck, optionally choose the best of three alternatives for any slide or visual, selectively repair audit findings, and export an editable native presentation.**

All future implementation decisions should be evaluated against this definition.
