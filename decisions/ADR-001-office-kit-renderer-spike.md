# ADR-001: Office Kit renderer reuse and qualification

- **Status:** accepted for selectable offline qualification; application/export adoption deferred
- **Date:** 2026-09-25

## Context

`native-pptx-renderer.ts` currently edits the PPTX package and constructs editable DrawingML shapes and tables. The deterministic template mapper, layout selection, provenance checks, audit policy, immutable source handling, and offline matrix runner are LCT-owned. Replacing those together would mix package-level reuse with unproven product behavior.

No real user PPTX template is present in this checkout. A synthetic template generated with the repository's PptxGenJS dependency is available for a bounded package round-trip test.

## Decision

Keep **Option C: hybrid** for this replaceable offline experiment. The existing `@office-kit/pptx@0.21.0` package is an exact runtime dependency behind internal renderer/document adapters; `@office-kit/pptx-preview@0.11.0` remains an exact development-only diagnostic dependency. The Office Kit backend is selectable by the offline matrix/harness through `LCT_PPTX_BACKEND=office-kit`. The custom backend remains the default until adoption gates pass. Neither backend is connected to the application generation/export path.

The offline backend uses Office Kit for OPC package loading/saving, template-layout slide creation, and native text, table, image, chart, shape, and connector authoring. LCT keeps TemplateIR/PDS, content-to-slide mapping, semantic provenance, layout policy, policy audit, persistence, and application/API behavior. This does not set a final product process boundary or export contract. `@office-kit/pptx-preview` is a diagnostic aid; its output is not a PowerPoint visual-fidelity oracle.

For this offline experiment, uploaded PPTX is treated as a design/template source: output contains generated slides in the active slide list and retains masters, layouts, theme, static/media and opaque package parts that the backend can preserve. Source sample slides and their speaker notes are not active output slides. This remains a provisional replaceable projection choice, not a final product contract. The Office Kit renderer checks preserved non-slide package parts byte-for-byte and refuses to claim a safe production backend while real held-out templates and a native Office open/save pass are unavailable.

## Evidence from the local spike

The initial spike generated a valid PptxGenJS template, added an opaque package XML part, opened and saved it with Office Kit, then reopened and edited it. The expanded synthetic corpus has five materially different PptxGenJS families: corporate, split visual, data/dashboard, editorial, and stress. T5 adds mixed runs, image crop, chart, table, connector, notes, a second master, and opaque XML. It exercises:

- all retained template file parts and the injected opaque part survived no-op round-trip and generated-slide projection;
- masters, layouts, themes, media, and opaque package parts retained byte identity;
- generated outputs contain only requested active slides and do not expose source sample slide text;
- a new slide was created from an existing layout and its title placeholder remained editable;
- native table, image with contain fit, image crop, chart, connector, and speaker notes survived save/reopen;
- `validatePresentation` returned no issues;
- the preview emitted SVG and PNG, and `auditTextLayout` returned no findings for the fixture.
- a five-template × three-variant zero-inference matrix produced 15 reopened and audited outputs;
- source-backed image/table/chart/KPI/process compilation, factual equivalence, and bounded layout repair have focused regressions.

No real user/organizer template has been qualified. The package-level validator is lightweight and does not replace ECMA-376/Open XML validation. The preview is approximate and does not audit table-cell text. Text mutation may collapse mixed-run formatting and drops paragraph-end formatting. The current report deliberately keeps `SAFE_FOR_OFFICE_KIT_BACKEND=no` until real templates and a PowerPoint/LibreOffice open-save gate pass.

## Compatibility and licensing

The registry reported these exact versions on 2026-09-25:

- `@office-kit/pptx@0.21.0` — MIT, ESM, Node `>=22.18`, one runtime dependency (`fflate`), exact runtime pin;
- `@office-kit/pptx-preview@0.11.0` — MIT, ESM, Node `>=22.18`, peer range `@office-kit/pptx@^0.21.0`.

The repository uses Node `~24`, TypeScript `5.9.3`, and ESM. Office Kit is pre-1.0: exact pins are required, and its public API may change between minor versions.

## Reuse from other projects

- **EthanGuo2022/OpenDesign:** adapt isolated native table/image/notes and provenance techniques; reference its critic prompts and bounded revision policy. Do not copy Python private-API template cloning or hardcoded archetype-to-template mappings.
- **Pandemonium-Research/OpenDesign:** reference its small structured deck exporter and token ingestion experiments. Do not adopt its web routes, auth/database coupling, fixed-layout exporter, or schema as an LCT contract.
- **CasualOffice/slides:** reference opaque OOXML passthrough as a preservation strategy; do not import its Univer editor stack.
- **anotb/pptx-masters:** reference template decomposition ideas only. Its generated PptxGenJS masters approximate source decks and overlap with the existing TemplateIR/PDS inventory.

All reviewed donor repositories use MIT or Apache-2.0 licenses. Retain upstream notices for any adapted code; this ADR adopts no donor implementation code.

## Follow-up gates

1. Run the compatibility harness against held-out organizer/user templates, including multiple masters/layouts, inherited styles, rich text, charts/media, and unsupported OOXML parts.
2. Validate output with an ECMA-376/Open XML validator and open/save/render it in PowerPoint or LibreOffice.
3. Inspect generated and source-backed visual slides for slot fit, inherited styles, notes behavior, and table-cell overflow.
4. Only then compare renderer fidelity and migration effort against the custom backend and consider application/export integration.
