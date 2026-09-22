# Presentation craft references

`craft/` contains compact brand-agnostic design guidance that can be composed into presentation skills when useful.

Craft rules are secondary to the uploaded template's exact design contract. They help with general quality, but they must not silently replace template-specific colors, typography, layout, or protected assets.

## Current references

- `typography.md` — readable type sizing, line length, spacing, and typographic discipline.
- `typography-hierarchy.md` — authored hierarchy and emphasis across content levels.
- `color.md` — color roles, restraint, contrast, and semantic use.
- `accessibility-baseline.md` — minimum accessibility/readability guidance.
- `anti-ai-slop.md` — recurring low-quality generative design patterns to avoid.

These files are guidance for semantic/design choices. Hard measurable rules that affect export correctness belong in deterministic audit/renderer code and are specified in `AUDIT.md`/`ARCHITECTURE.md`.

## Using craft in skills

Load only the references relevant to the current skill. Do not add all craft material to every prompt.

Retained skill frontmatter may declare craft requirements. Keep those references valid and run:

```bash
pnpm lint:craft
```

If a craft rule becomes a repeated hard invariant, promote it into a test or deterministic validator rather than relying only on prompt text.

## Attribution

Some craft material is adapted from externally licensed design references. Keep file-level provenance/license notices intact when editing or splitting these documents.
