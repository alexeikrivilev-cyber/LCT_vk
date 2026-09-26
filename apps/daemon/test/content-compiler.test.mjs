import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compileContentIR,
  ContentCompilerError,
  validateContentIR,
} from '../src/presentation/application/content-compiler.ts';

async function projectFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-content-ir-'));
  const projectId = 'project-content';
  const projectDir = path.join(root, projectId);
  await mkdir(projectDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    projectId,
    projectDir,
    write: async (name, content) => {
      const target = path.join(projectDir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
  };
}

function hasCode(code) {
  return (error) => error instanceof ContentCompilerError && error.code === code;
}

test('compiles selected UTF-8 text, Markdown headings, lossless JSON numbers, and delimited cells deterministically', async (t) => {
  const fixture = await projectFixture(t);
  const md = '# Итог\n\nВыручка выросла на 12%.\nПродолжение абзаца.\n\n## Риски\n\nПоставки ограничены.\n';
  const json = '{"metrics":[{"amount":90071992547409931234567890.001e+4,"label":"точно"}],"empty":[]}';
  const csv = 'Показатель,Значение\r\nВыручка,"001.230e+2"\r\nЗаметка,"строка 1\nстрока 2"';
  const tsv = 'год\tзначение\n2026\t-0.00\n';
  await fixture.write('evidence/notes.md', md);
  await fixture.write('evidence/data.json', json);
  await fixture.write('evidence/data.csv', csv);
  await fixture.write('evidence/data.tsv', tsv);

  const paths = ['evidence/notes.md', 'evidence/data.json', 'evidence/data.csv', 'evidence/data.tsv'];
  const result = await compileContentIR(fixture.root, fixture.projectId, paths);
  const repeated = await compileContentIR(fixture.root, fixture.projectId, paths);

  assert.equal(result.hash, repeated.hash);
  assert.equal(result.id, `cir_${result.hash.slice(0, 24)}`);
  assert.equal(result.id, repeated.id);
  assert.deepEqual(result.sources.map(({ sourcePath, originalName, order, kind }) => ({ sourcePath, originalName, order, kind })), [
    { sourcePath: 'evidence/notes.md', originalName: 'notes.md', order: 0, kind: 'text' },
    { sourcePath: 'evidence/data.json', originalName: 'data.json', order: 1, kind: 'text' },
    { sourcePath: 'evidence/data.csv', originalName: 'data.csv', order: 2, kind: 'text' },
    { sourcePath: 'evidence/data.tsv', originalName: 'data.tsv', order: 3, kind: 'text' },
  ]);
  assert.deepEqual(result.sources.map((source) => source.sha256), repeated.sources.map((source) => source.sha256));

  const markdownUnits = result.units.filter((unit) => unit.sourceId === result.sources[0].id);
  assert.deepEqual(markdownUnits.map((unit) => [unit.kind, unit.text]), [
    ['heading', '# Итог'],
    ['text', 'Выручка выросла на 12%.\nПродолжение абзаца.'],
    ['heading', '## Риски'],
    ['text', 'Поставки ограничены.'],
  ]);
  for (const unit of markdownUnits) {
    const source = result.sources[0];
    const exact = Buffer.from(source.text).subarray(unit.locator.startByte, unit.locator.endByte).toString('utf8');
    assert.equal(exact, unit.text);
  }

  const amount = result.units.find((unit) => unit.kind === 'json-value' && unit.locator.jsonPointer === '/metrics/0/amount');
  assert.equal(amount.numericLexeme, '90071992547409931234567890.001e+4');
  assert.equal(amount.text, undefined);
  const jsonLabel = result.units.find((unit) => unit.kind === 'json-value' && unit.locator.jsonPointer === '/metrics/0/label');
  assert.equal(jsonLabel.text, 'точно');
  assert.equal(result.units.find((unit) => unit.locator.jsonPointer === '/empty').text, '[]');

  const csvCells = result.units.filter((unit) => unit.kind === 'table-cell' && unit.sourceId === result.sources[2].id);
  assert.equal(csvCells.find((unit) => unit.locator.rowIndex === 1 && unit.locator.columnIndex === 1).numericLexeme, '001.230e+2');
  assert.equal(csvCells.find((unit) => unit.locator.rowIndex === 2 && unit.locator.columnIndex === 1).cellValue, 'строка 1\nстрока 2');
  const tsvCells = result.units.filter((unit) => unit.sourceId === result.sources[3].id);
  assert.equal(tsvCells.find((unit) => unit.locator.rowIndex === 1 && unit.locator.columnIndex === 1).numericLexeme, '-0.00');
  assert.deepEqual(validateContentIR(result), result);
});

test('inventories images and unsupported documents by source hash with explicit no-parser warnings', async (t) => {
  const fixture = await projectFixture(t);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const pdf = Buffer.from('%PDF-1.7\nnot parsed');
  const pptx = Buffer.from('PK\x03\x04synthetic-not-a-real-package');
  await fixture.write('image.png', image);
  await fixture.write('brief.pdf', pdf);
  await fixture.write('template.pptx', pptx);

  const result = await compileContentIR(fixture.root, fixture.projectId, ['image.png', 'brief.pdf', 'template.pptx']);
  assert.deepEqual(result.sources.map((source) => source.kind), ['image', 'unsupported', 'unsupported']);
  assert.deepEqual(result.sources.map((source) => source.text), [null, null, null]);
  assert.deepEqual(result.sources.map((source) => source.sha256), [image, pdf, pptx]
    .map((bytes) => createHash('sha256').update(bytes).digest('hex')));
  assert.equal(result.sources[0].warnings[0].code, 'IMAGE_INVENTORIED_NOT_EXTRACTED');
  assert.match(result.sources[1].warnings[0].message, /Office, PDF, OCR/);
  assert.deepEqual(result.warnings.map(({ sourceId }) => sourceId), result.sources.map(({ id }) => id));
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].kind, 'media-reference');
  assert.equal(result.units[0].sourceId, result.sources[0].id);
  assert.deepEqual(result.units[0].locator, { startByte: 0, endByte: image.byteLength });
  assert.deepEqual(validateContentIR(result), result);
});

test('retains malformed UTF-8 and malformed JSON or CSV with warnings instead of silently parsing partial data', async (t) => {
  const fixture = await projectFixture(t);
  await fixture.write('bad.txt', Buffer.from([0xc3, 0x28]));
  await fixture.write('bad.json', '{"amount":1,}');
  await fixture.write('bad.csv', 'a,"unfinished');

  const result = await compileContentIR(fixture.root, fixture.projectId, ['bad.txt', 'bad.json', 'bad.csv']);
  assert.equal(result.sources[0].kind, 'unsupported');
  assert.equal(result.sources[0].warnings[0].code, 'INVALID_UTF8_NOT_EXTRACTED');
  assert.equal(result.sources[1].text, '{"amount":1,}');
  assert.equal(result.sources[1].warnings[0].code, 'INVALID_JSON_NOT_PARSED');
  assert.equal(result.sources[2].text, 'a,"unfinished');
  assert.equal(result.sources[2].warnings[0].code, 'INVALID_TABLE_NOT_PARSED');
  assert.equal(result.units.length, 0);
});

test('rejects traversal, duplicate normalized sources, and source-count overflow', async (t) => {
  const fixture = await projectFixture(t);
  await fixture.write('notes.txt', 'evidence');
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, ['../outside.txt']), hasCode('INVALID_CONTENT_PATH'));
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, ['notes.txt', 'notes.txt']), hasCode('INVALID_CONTENT_SELECTION'));
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, Array.from({ length: 13 }, (_, index) => `${index}.txt`)), hasCode('INVALID_CONTENT_SELECTION'));
});

test('rejects per-file, total-selection, extracted-text, and unit limit overflow', async (t) => {
  const fixture = await projectFixture(t);
  const sixteenMiB = 16 * 1024 * 1024;
  await fixture.write('too-large.bin', Buffer.alloc(sixteenMiB + 1));
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, ['too-large.bin']), hasCode('CONTENT_SOURCE_TOO_LARGE'));

  await fixture.write('a.bin', Buffer.alloc(sixteenMiB));
  await fixture.write('b.bin', Buffer.alloc(sixteenMiB));
  await fixture.write('c.bin', Buffer.alloc(1));
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, ['a.bin', 'b.bin', 'c.bin']), hasCode('CONTENT_SELECTION_TOO_LARGE'));

  await fixture.write('too-much.txt', 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, ['too-much.txt']), hasCode('CONTENT_TEXT_TOO_LARGE'));

  await fixture.write('too-many.json', `[${Array.from({ length: 4097 }, () => '0').join(',')}]`);
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, ['too-many.json']), hasCode('CONTENT_UNIT_LIMIT_EXCEEDED'));
});

test('validator rejects a changed source and a changed derived hash/id', async (t) => {
  const fixture = await projectFixture(t);
  await fixture.write('note.txt', 'A concise source paragraph.');
  const result = await compileContentIR(fixture.root, fixture.projectId, ['note.txt']);

  const changedSource = structuredClone(result);
  changedSource.sources[0].text = 'tampered';
  assert.throws(() => validateContentIR(changedSource), /text does not match its source hash/);

  const changedId = structuredClone(result);
  changedId.id = 'cir_000000000000000000000000';
  assert.throws(() => validateContentIR(changedId), /id does not match/);
});

test('compiles a required task and optional context into deterministic provenance sources without temporary files', async (t) => {
  const fixture = await projectFixture(t);
  await fixture.write('evidence.md', '# Evidence\n\nThe supplied source remains additive.');
  const intent = { task: 'Explain the onboarding goal without inventing metrics.', context: 'Preserve the product constraints.' };

  const taskOnly = await compileContentIR(fixture.root, fixture.projectId, [], { task: intent.task });
  const repeated = await compileContentIR(fixture.root, fixture.projectId, [], { task: intent.task });
  const additive = await compileContentIR(fixture.root, fixture.projectId, ['evidence.md'], intent);

  assert.equal(taskOnly.hash, repeated.hash);
  assert.deepEqual(taskOnly.sources.map((source) => source.kind), ['brief-task']);
  assert.equal(taskOnly.sources[0].sourcePath, '__lct_input__/task.md');
  assert.equal(taskOnly.units[0].sourceId, taskOnly.sources[0].id);
  assert.match(taskOnly.units[0].text, /onboarding goal/);
  assert.deepEqual(validateContentIR(taskOnly), taskOnly);
  assert.deepEqual(additive.sources.map((source) => source.kind), ['text', 'brief-task', 'brief-context']);
  assert.ok(additive.units.some((unit) => unit.sourceId === additive.sources[0].id && unit.text.includes('additive')));
  assert.notEqual(additive.hash, taskOnly.hash);
  await assert.rejects(compileContentIR(fixture.root, fixture.projectId, [], { task: ' ' }), hasCode('INVALID_CONTENT_SELECTION'));
});
