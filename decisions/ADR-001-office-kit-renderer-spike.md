# ADR-001: Office Kit renderer reuse spike

- **Status:** accepted for an isolated spike; production adoption deferred
- **Date:** 2026-09-25

## Context

`native-pptx-renderer.ts` currently edits the PPTX package and constructs editable DrawingML shapes and tables. The deterministic template mapper, layout selection, provenance checks, audit policy, immutable source handling, and offline matrix runner are LCT-owned. Replacing those together would mix package-level reuse with unproven product behavior.

No real user PPTX template is present in this checkout. A synthetic template generated with the repository's PptxGenJS dependency is available for a bounded package round-trip test.

## Decision

Choose **Option C: hybrid**. Pin `@office-kit/pptx@0.21.0` and `@office-kit/pptx-preview@0.11.0` as exact daemon development dependencies and exercise them through the replaceable `PptxDocumentAdapter` spike boundary. Do not connect the adapter to the application flow yet.

If adoption proceeds, Office Kit is a candidate for OPC package loading/saving, template-layout slide creation, and native text, table, image, chart, shape, and connector authoring. LCT keeps TemplateIR/PDS, content-to-slide mapping, semantic provenance, layout policy, policy audit, persistence, and application/API behavior. `@office-kit/pptx-preview` is a diagnostic aid; its output is not a PowerPoint visual-fidelity oracle.

The existing renderer remains available until a held-out template corpus demonstrates acceptable preservation, editability, and native application rendering. The choice between retaining source sample slides and replacing the active slide list is an unresolved output-policy decision for that migration.

## Evidence from the local spike

The test generated a valid synthetic template with PptxGenJS, added an opaque package XML part, opened and saved it with Office Kit, then reopened and edited it. The run verified:

- all original file parts and the injected opaque part survived round-trip;
- the master, layouts, theme, and original speaker notes survived;
- a new slide was created from an existing layout and its title placeholder remained editable;
- native table, image with contain fit, image crop, chart, connector, and speaker notes survived save/reopen;
- `validatePresentation` returned no issues;
- the preview emitted SVG and PNG, and `auditTextLayout` returned no findings for the fixture.

No real template was available. The ignored inspector fixtures in `.lct/` are deliberately minimal structural test inputs, not valid Office Kit compatibility fixtures. The package-level validator is lightweight and does not replace ECMA-376/Open XML validation. The preview is approximate and does not audit table cell text. Text mutation may collapse mixed run formatting and drops paragraph-end formatting.

## Compatibility and licensing

The registry reported these exact versions on 2026-09-25:

- `@office-kit/pptx@0.21.0` — MIT, ESM, Node `>=22.18`, one runtime dependency (`fflate`);
- `@office-kit/pptx-preview@0.11.0` — MIT, ESM, Node `>=22.18`, peer range `@office-kit/pptx@^0.21.0`.

The repository uses Node `~24`, TypeScript `5.9.3`, and ESM. Office Kit is pre-1.0: exact pins are required, and its public API may change between minor versions.

## Reuse from other projects

- **EthanGuo2022/OpenDesign:** adapt isolated native table/image/notes and provenance techniques; reference its critic prompts and bounded revision policy. Do not copy Python private-API template cloning or hardcoded archetype-to-template mappings.
- **Pandemonium-Research/OpenDesign:** reference its small structured deck exporter and token ingestion experiments. Do not adopt its web routes, auth/database coupling, fixed-layout exporter, or schema as an LCT contract.
- **CasualOffice/slides:** reference opaque OOXML passthrough as a preservation strategy; do not import its Univer editor stack.
- **anotb/pptx-masters:** reference template decomposition ideas only. Its generated PptxGenJS masters approximate source decks and overlap with the existing TemplateIR/PDS inventory.

All reviewed donor repositories use MIT or Apache-2.0 licenses. Retain upstream notices for any adapted code; this ADR adopts no donor implementation code.

## Follow-up gates

1. Run the adapter against held-out real templates, including multiple masters, layouts, inherited styles, rich text, charts, media, and unsupported OOXML parts.
2. Validate output with an ECMA-376/Open XML validator and open/render it in PowerPoint or LibreOffice.
3. Decide the generated-slide versus source-slide preservation policy.
4. Only then compare renderer fidelity and migration effort against the current renderer and consider connecting the adapter to compilation.
