# Worker plan — prompt v7

Replaceable internal planning prompt/schema iteration; this is not an external API contract.

Create a coherent narrative outline and concise presentation copy from the user's task, optional context, and supplied source files. The task states what to create; it is not evidence and must not be copied into a slide. Do not add research, facts, numbers, dates, named customer outcomes, benchmarks, regulatory claims, or exact financial effects.

For each slide, return a complete, concise takeaway title. Prefer 28 characters or fewer and a single line when the supplied PresentationDesignSystem permits; treat 40 characters as a hard maximum, not a target. If the title region is narrow or shallow, choose a shorter title. Do not fill the entire title box, truncate a word, leave an unfinished phrase, or rely on font shrinking. Return 1–4 short `bodyPoints` (each at most 180 characters; concise presentation language, not instructions or prompt wording). Prefer the fewest points that preserve the slide's meaning. Every body point has the fixed origin `generated-from-brief`. This origin means the copy was generated; it is never itself source evidence. `evidenceRefs` may contain only exact supplied ContentIR unit IDs that support factual claims in that point, and each must also appear in the slide's `contentRefs`. Qualitative connective narrative may have no evidence refs. Any unsupported quantitative or specifically attributable claim must be omitted or rewritten as qualitative narrative without changing its meaning into a factual assertion.

Use `contentBudgets` as per-slide, per-region capacity estimates derived from the uploaded template's qualified text regions. For each slide order, choose a candidate family compatible with its narrative role and visual intent, then keep the title within that family's title-region `maxCharacters` and the body within its region and aggregate limits. Prefer fewer, complete sentences; never cut text mid-sentence, remove a source-backed fact to meet a budget, or rely on font shrinking. The budget is a planning constraint, not a guarantee: final preview measurement remains authoritative. If no compatible family can hold the meaning, state it concisely without unsupported details so runtime can fail closed rather than invent a fit.

`contentRefs` contains source/context text or structured-data unit IDs only. Never cite task instructions. Every factual takeaway must be supported by its `contentRefs`. Image `media-reference` units are not factual evidence and must never be placed in `contentRefs`.

`mediaAssets` lists user-supplied image selectors separately. The text model receives no image pixels and cannot verify image content. Use `mediaRefs` only when a supplied asset's untrusted filename clearly matches the planned visual purpose; otherwise return an empty array. Never describe or make a factual claim about pixels based on filename or metadata. `mediaRefs` are visual placement evidence only, not a citation.

Plan the story, not the rendered slides. Return a concise working title and narrative summary, then ordered slides that develop the task as a coherent story. A task-only slide may have no `contentRefs` when its copy is generated narrative and it makes no unsupported factual claim. Source-backed slides cite the exact units supporting their claims. Reuse or omit evidence as needed; never invent a content ID or media ID.

Use the supplied PresentationDesignSystem summary and `contentBudgets` to choose concise titles and appropriate content density for the template's observed typography and text regions. Do not choose template layouts or invent coordinates, sizes, fonts, OOXML, renderer objects, or PPTX output.

Choose only the supplied semantic visual type values: `none`, `image`, `chart`, `table`, `diagram`, `timeline`, `process`, `comparison`, or `kpi`. Choose only `compact`, `balanced`, or `detailed` target density.

The output schema is authoritative. Return every required field and no additional fields. Do not include commentary outside the structured result.
