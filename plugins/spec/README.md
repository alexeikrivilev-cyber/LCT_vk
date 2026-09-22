# LCT Plugin Spec Kit

Language: English | [简体中文](README.zh-CN.md)

This folder is the shareable specification kit for LCT plugin authors. It documents the portable plugin contract for human authors and product integrations.

LCT plugins follow the same portable shape as Agent Skills: a folder with `SKILL.md` plus optional assets, references, scripts, and examples. LCT adds `lct.json` as a sidecar so the same folder can appear in the LCT plugin gallery, hydrate the home composer, declare inputs and GenUI surfaces, run an atom pipeline, and participate in publish or PR flows.

## Folder Map

- [`SPEC.md`](SPEC.md) - the portable plugin spec and taxonomy.
- [`README.md`](README.md) - this authoring and validation guide.
- [`PUBLISHING-REGISTRIES.md`](PUBLISHING-REGISTRIES.md) - strategies for skills.sh, ClawHub, GitHub, and LCT publishing.
- [`templates/`](templates/) - blank starter files.
- [`examples/`](examples/) - complete example plugin folders and a sample marketplace index.

Chinese mirrors:

- [`SPEC.zh-CN.md`](SPEC.zh-CN.md)
- [`README.zh-CN.md`](README.zh-CN.md)
- [`PUBLISHING-REGISTRIES.zh-CN.md`](PUBLISHING-REGISTRIES.zh-CN.md)
- [`examples/README.zh-CN.md`](examples/README.zh-CN.md)

## What To Build

Workflow lanes:

- Import - Figma, GitHub, code folders, URLs, screenshots, PDFs, PPTX, Framer, Webflow.
- Create - prototypes, slide decks, live artifacts, image assets, video prompts, HyperFrames compositions, audio assets.
- Export - PPTX, PDF, HTML, ZIP, Markdown, Figma handoff, Next.js, React, Vue, Svelte, Astro, Angular, Tailwind.
- Share - public links, GitHub PRs, Gists, Slack, Discord, Notion, Linear, Jira.
- Deploy - Vercel, Cloudflare Pages, Netlify, GitHub Pages, Fly.io, Render.
- Refine - critique, patch, tune, brand swap, A/B variants, stakeholder review.
- Extend - plugin authoring, marketplace publishing, internal catalog automation.

## Five Minute Start

1. Copy `templates/` to a new plugin folder.
2. Rename the folder and frontmatter `name` to a lowercase id such as `launch-deck`.
3. Write a pushy `description` in `SKILL.md`: "Use this plugin when..."
4. Fill `lct.json`: `specVersion`, title, plugin `version`, tags, `od.taskKind`, `od.mode`, `od.useCase.query`, `od.pipeline`, inputs, and capabilities.
5. Add a small `examples/` or `preview/` artifact if the plugin is visual.
6. Validate locally:

```bash
pnpm guard
pnpm --filter @lct/plugin-runtime typecheck
```

When the daemon CLI is built:

```bash
od plugin validate ./path/to/plugin
od plugin install ./path/to/plugin
od plugin apply <plugin-id> --input key=value
```

## Compatibility Promise

A folder with `SKILL.md` can be used as a plain skill in Agent Skills compatible clients. Adding `lct.json` should never make the skill less portable; it only adds LCT product behavior.

References:

- Agent Skills overview: https://agentskills.io/home
- Agent Skills specification: https://agentskills.io/specification
- LCT plugin spec: ../../docs/plugins-spec.md
