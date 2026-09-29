import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

import { createExemplarTemplate } from './exemplar-template-fixtures.mjs';

register();
const { inspectPptx } = await import('../src/presentation/adapters/python-inspector.ts');
const { createTemplateIR } = await import('../src/presentation/application/template-mapper.ts');
const { derivePlanningContentBudgets } = await import('../src/presentation/adapters/office-kit-planning-content-budgets.ts');

test('planning budgets use same-slide structural regions when semantic roles are absent or point across slides', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-office-kit-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'generic-budget-fixture';
  const projectDir = path.join(projectsRoot, projectId);
  await mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, 'template.pptx');
  await createExemplarTemplate(filePath, { includePicture: false });
  const bytes = await readFile(filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const inspection = await inspectPptx(filePath);
  const template = createTemplateIR(inspection, {
    filePath: 'template.pptx', originalName: 'template.pptx', sha256,
    compiledAt: '2026-09-29T00:00:00.000Z', compilerVersion: 'test',
  });

  const titleFromAnotherSlide = template.slides[1].elements.find((element) => element.text?.trim())?.id;
  const bodyFromAnotherSlide = template.slides[1].elements.filter((element) => element.text?.trim())[1]?.id;
  assert.ok(titleFromAnotherSlide && bodyFromAnotherSlide, 'fixture exposes native text regions for the foreign-role regression');
  const semanticProfile = {
    templateIRHash: template.hash,
    slides: template.slides.map((slide) => ({
      sourceSlideIndex: slide.index,
      archetype: 'content',
      supportedContentModes: ['text'],
      // Deliberately incomplete/foreign semantic evidence must be ignored, not copied into the budget contract.
      titleElementId: titleFromAnotherSlide,
      bodyElementIds: [bodyFromAnotherSlide],
      visualElementIds: [],
      preservedElementIds: [],
      replaceableTextElementIds: [],
      confidence: 0.1,
      reasonCodes: ['synthetic-incomplete-profile'],
    })),
  };

  const budgets = await derivePlanningContentBudgets({
    projectsRoot, projectId, template, semanticProfile, requestedSlideCount: 10,
  });
  assert.ok(budgets);
  assert.ok(budgets.candidateFamilies.length > 0, 'ordinary native text shapes with measured geometry provide usable families');
  assert.equal(budgets.slides.length, 10);
  assert.ok(budgets.candidateFamilies.every((family) => family.titleRegion.maxCharacters > 0
    && family.bodyRegions.length > 0 && family.body.maxCharacters > 0));
  assert.doesNotMatch(JSON.stringify(budgets), new RegExp(`${titleFromAnotherSlide}|${bodyFromAnotherSlide}`, 'u'),
    'foreign semantic IDs are not included in the planner budget contract');
});
