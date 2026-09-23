import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_CONTENT_SOURCES,
  MAX_CONTENT_SOURCE_BYTES,
  MAX_CONTENT_TEXT_BYTES,
  MAX_CONTENT_TOTAL_BYTES,
  MAX_CONTENT_UNITS,
  contentByteOffsets,
  contentSourceId,
  contentSourceSupportsText,
  contentUnitId,
  finalizeContentIR,
  type ContentIR,
  type ContentJsonValueKind,
  type ContentSource,
  type ContentUnit,
  type ContentWarning,
} from '../domain/content-ir.js';
import { mimeForPresentationFile, resolvePresentationFilePath } from '../../presentation-files.js';

export type { ContentIR, ContentSource, ContentUnit } from '../domain/content-ir.js';
export { validateContentIR } from '../domain/content-ir.js';

export type ContentCompilerErrorCode =
  | 'INVALID_CONTENT_SELECTION'
  | 'INVALID_CONTENT_PATH'
  | 'CONTENT_FILE_NOT_FOUND'
  | 'CONTENT_FILE_NOT_REGULAR'
  | 'CONTENT_SOURCE_TOO_LARGE'
  | 'CONTENT_SELECTION_TOO_LARGE'
  | 'CONTENT_TEXT_TOO_LARGE'
  | 'CONTENT_UNIT_LIMIT_EXCEEDED'
  | 'SOURCE_CHANGED_DURING_COMPILE'
  | 'CONTENT_READ_FAILED';

export class ContentCompilerError extends Error {
  readonly code: ContentCompilerErrorCode;
  readonly status: number;

  constructor(code: ContentCompilerErrorCode, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContentCompilerError';
    this.code = code;
    this.status = status;
  }
}

interface SelectedSource {
  sourcePath: string;
  absolutePath: string;
  byteLength: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface UnitDraft extends Omit<ContentUnit, 'id'> {}

class ParseFailure extends Error {}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mediaTypeFor(sourcePath: string): string {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  if (extension === '.csv') return 'text/csv; charset=utf-8';
  if (extension === '.tsv') return 'text/tab-separated-values; charset=utf-8';
  return mimeForPresentationFile(sourcePath);
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith('image/');
}

function contentError(error: unknown, sourcePath?: string): ContentCompilerError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ContentCompilerError('CONTENT_FILE_NOT_FOUND', `Evidence file was not found${sourcePath ? `: ${sourcePath}` : ''}.`, 404, { cause: error });
  }
  return new ContentCompilerError('CONTENT_READ_FAILED', `Could not read evidence file${sourcePath ? `: ${sourcePath}` : ''}.`, 500, {
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}

async function resolveSources(projectsRoot: string, projectId: string, filePaths: readonly string[]): Promise<SelectedSource[]> {
  const sources: SelectedSource[] = [];
  const normalizedPaths = new Set<string>();
  let selectedBytes = 0;
  for (const requestedPath of filePaths) {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
      throw new ContentCompilerError('INVALID_CONTENT_PATH', 'Evidence file paths must be non-empty project-relative paths.', 400);
    }
    let resolved: Awaited<ReturnType<typeof resolvePresentationFilePath>>;
    try {
      resolved = await resolvePresentationFilePath(projectsRoot, projectId, requestedPath, { requireExisting: true });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : '';
      if (code === 'ENOENT' || code === 'ENOTDIR') throw contentError(error, requestedPath);
      throw new ContentCompilerError('INVALID_CONTENT_PATH', 'Evidence files must stay inside the project folder.', 400, { cause: error });
    }
    const normalizedPath = resolved.name.normalize('NFC').toLowerCase();
    if (normalizedPaths.has(normalizedPath)) {
      throw new ContentCompilerError('INVALID_CONTENT_SELECTION', 'The same evidence path cannot be selected more than once.', 400);
    }
    normalizedPaths.add(normalizedPath);
    let info;
    try {
      info = await stat(resolved.absolute);
    } catch (error) {
      throw contentError(error, resolved.name);
    }
    if (!info.isFile()) {
      throw new ContentCompilerError('CONTENT_FILE_NOT_REGULAR', `Evidence source is not a regular file: ${resolved.name}.`, 400);
    }
    if (info.size > MAX_CONTENT_SOURCE_BYTES) {
      throw new ContentCompilerError('CONTENT_SOURCE_TOO_LARGE', `Evidence source exceeds the 16 MiB limit: ${resolved.name}.`, 413);
    }
    selectedBytes += info.size;
    if (selectedBytes > MAX_CONTENT_TOTAL_BYTES) {
      throw new ContentCompilerError('CONTENT_SELECTION_TOO_LARGE', 'Selected evidence exceeds the 32 MiB total limit.', 413);
    }
    sources.push({
      sourcePath: resolved.name,
      absolutePath: resolved.absolute,
      byteLength: info.size,
      mtimeMs: info.mtimeMs,
      dev: info.dev,
      ino: info.ino,
    });
  }
  return sources;
}

async function readBoundedFile(source: SelectedSource, maxAllowedBytes: number): Promise<Buffer> {
  const stream = createReadStream(source.absolutePath, { highWaterMark: 64 * 1024 });
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.length;
      if (byteLength > maxAllowedBytes) {
        stream.destroy();
        throw new ContentCompilerError(
          maxAllowedBytes < MAX_CONTENT_SOURCE_BYTES ? 'CONTENT_SELECTION_TOO_LARGE' : 'CONTENT_SOURCE_TOO_LARGE',
          'Evidence changed while being read and exceeded the configured byte limit.',
          413,
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ContentCompilerError) throw error;
    throw contentError(error, source.sourcePath);
  }
  return Buffer.concat(chunks, byteLength);
}

function warning(code: string, message: string): ContentWarning {
  return { code, message };
}

function makeUnit(sourceId: string, draft: UnitDraft): ContentUnit {
  return { id: contentUnitId(sourceId, draft), ...draft };
}

function appendUnit(drafts: UnitDraft[], draft: Omit<UnitDraft, 'order'>): void {
  if (drafts.length >= MAX_CONTENT_UNITS) {
    throw new ContentCompilerError('CONTENT_UNIT_LIMIT_EXCEEDED', 'Extracted evidence exceeds the 4096 unit limit.', 413);
  }
  drafts.push({ ...draft, order: drafts.length });
}

function parseTextUnits(sourceId: string, text: string, offsets: Uint32Array, markdown: boolean): UnitDraft[] {
  const units: UnitDraft[] = [];
  const lineBreak = /\r\n|\n|\r/g;
  let lineStart = 0;
  let paragraphStart: number | null = null;
  let paragraphEnd = 0;
  const flushParagraph = () => {
    if (paragraphStart === null) return;
    appendUnit(units, {
      sourceId,
      kind: 'text',
      locator: { startByte: offsets[paragraphStart], endByte: offsets[paragraphEnd] },
      text: text.slice(paragraphStart, paragraphEnd),
    });
    paragraphStart = null;
  };
  const finishLine = (lineEnd: number) => {
    const line = text.slice(lineStart, lineEnd);
    const heading = markdown && /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line);
    if (heading) {
      flushParagraph();
      if (line.trim()) {
        appendUnit(units, {
          sourceId,
          kind: 'heading',
          locator: { startByte: offsets[lineStart], endByte: offsets[lineEnd] },
          text: line,
        });
      }
      return;
    }
    if (!line.trim()) {
      flushParagraph();
    } else {
      if (paragraphStart === null) paragraphStart = lineStart;
      paragraphEnd = lineEnd;
    }
  };

  let match: RegExpExecArray | null;
  while ((match = lineBreak.exec(text)) !== null) {
    finishLine(match.index);
    lineStart = match.index + match[0].length;
  }
  finishLine(text.length);
  flushParagraph();
  return units;
}

function jsonPointerChild(pointer: string, segment: string): string {
  return `${pointer}/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function parseJsonUnits(sourceId: string, text: string, offsets: Uint32Array): UnitDraft[] {
  const units: UnitDraft[] = [];
  let index = 0;

  const fail = (): never => { throw new ParseFailure('JSON is invalid or exceeds the supported nesting depth.'); };
  const whitespace = () => { while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1; };
  const expect = (character: string) => {
    if (text[index] !== character) fail();
    index += 1;
  };
  const parseString = (): { value: string; start: number; end: number } => {
    const start = index;
    expect('"');
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        const end = index;
        try {
          return { value: JSON.parse(text.slice(start, end)) as string, start, end };
        } catch {
          return fail();
        }
      }
      if (code < 0x20) return fail();
      if (code === 0x5c) {
        index += 1;
        if (index >= text.length) return fail();
        const escaped = text[index];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) return fail();
          index += 5;
        } else {
          if (!'"\\/bfnrt'.includes(escaped)) return fail();
          index += 1;
        }
      } else index += 1;
    }
    return fail();
  };

  const parseValue = (pointer: string, depth: number): void => {
    if (depth > 128) return fail();
    whitespace();
    const start = index;
    const unitIndex = units.length;
    if (unitIndex >= MAX_CONTENT_UNITS) {
      throw new ContentCompilerError('CONTENT_UNIT_LIMIT_EXCEEDED', 'Extracted evidence exceeds the 4096 unit limit.', 413);
    }
    let valueKind: ContentJsonValueKind;
    let decodedText: string | undefined;
    let numericLexeme: string | undefined;
    let end: number;
    let hasChildren = false;
    const character = text[index];
    if (character === '{') {
      valueKind = 'object';
      index += 1;
      whitespace();
      if (text[index] !== '}') {
        while (true) {
          whitespace();
          if (text[index] !== '"') return fail();
          const key = parseString().value;
          whitespace();
          expect(':');
          const beforeChildren = units.length;
          parseValue(jsonPointerChild(pointer, key), depth + 1);
          hasChildren ||= units.length !== beforeChildren;
          whitespace();
          if (text[index] === '}') break;
          expect(',');
        }
      }
      expect('}');
      end = index;
    } else if (character === '[') {
      valueKind = 'array';
      index += 1;
      whitespace();
      let itemIndex = 0;
      if (text[index] !== ']') {
        while (true) {
          const beforeChildren = units.length;
          parseValue(jsonPointerChild(pointer, String(itemIndex)), depth + 1);
          hasChildren ||= units.length !== beforeChildren;
          itemIndex += 1;
          whitespace();
          if (text[index] === ']') break;
          expect(',');
        }
      }
      expect(']');
      end = index;
    } else if (character === '"') {
      valueKind = 'string';
      const parsed = parseString();
      decodedText = parsed.value;
      end = parsed.end;
    } else if (character === 't' && text.startsWith('true', index)) {
      valueKind = 'boolean';
      decodedText = 'true';
      index += 4;
      end = index;
    } else if (character === 'f' && text.startsWith('false', index)) {
      valueKind = 'boolean';
      decodedText = 'false';
      index += 5;
      end = index;
    } else if (character === 'n' && text.startsWith('null', index)) {
      valueKind = 'null';
      decodedText = 'null';
      index += 4;
      end = index;
    } else {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (!match) return fail();
      valueKind = 'number';
      numericLexeme = match[0];
      index += match[0].length;
      end = index;
    }
    // Containers with children are represented by their leaf descendants and
    // JSON Pointers. Empty containers are retained as exact lexical values.
    if ((valueKind === 'object' || valueKind === 'array') && hasChildren) return;
    const draft: UnitDraft = {
      sourceId,
      order: unitIndex,
      kind: 'json-value',
      locator: { startByte: offsets[start], endByte: offsets[end], jsonPointer: pointer },
      valueKind,
      ...(decodedText !== undefined ? { text: decodedText } : {}),
      ...((valueKind === 'object' || valueKind === 'array') ? { text: text.slice(start, end) } : {}),
      ...(numericLexeme !== undefined ? { numericLexeme } : {}),
    };
    units.push(draft);
  };

  whitespace();
  if (!text.length) throw new ParseFailure('JSON is empty.');
  parseValue('', 0);
  whitespace();
  if (index !== text.length) throw new ParseFailure('JSON contains trailing content.');
  // Values were appended after their children so sort by source range and then
  // by descending span for parent-before-child order at the same start offset.
  units.sort((left, right) => left.locator.startByte - right.locator.startByte
    || left.locator.endByte - right.locator.endByte);
  return units;
}

interface ParsedCell {
  value: string;
  start: number;
  end: number;
}

function parseDelimitedRows(text: string, delimiter: ',' | '\t'): ParsedCell[][] {
  if (!text.length) return [];
  const rows: ParsedCell[][] = [];
  let index = 0;
  while (index < text.length) {
    const row: ParsedCell[] = [];
    let rowFinished = false;
    while (!rowFinished) {
      const start = index;
      let value = '';
      if (text[index] === '"') {
        index += 1;
        let closed = false;
        while (index < text.length) {
          if (text[index] === '"') {
            if (text[index + 1] === '"') {
              value += '"';
              index += 2;
            } else {
              index += 1;
              closed = true;
              break;
            }
          } else {
            value += text[index];
            index += 1;
          }
        }
        if (!closed || (index < text.length && text[index] !== delimiter && text[index] !== '\r' && text[index] !== '\n')) {
          throw new ParseFailure('Delimited text contains an invalid quoted field.');
        }
      } else {
        while (index < text.length && text[index] !== delimiter && text[index] !== '\r' && text[index] !== '\n') {
          if (text[index] === '"') throw new ParseFailure('Delimited text contains a quote inside an unquoted field.');
          index += 1;
        }
        value = text.slice(start, index);
      }
      const end = index;
      row.push({ value, start, end });
      if (index >= text.length) {
        rowFinished = true;
      } else if (text[index] === delimiter) {
        index += 1;
        if (index === text.length) {
          row.push({ value: '', start: index, end: index });
          rowFinished = true;
        }
      } else {
        if (text[index] === '\r' && text[index + 1] === '\n') index += 2;
        else index += 1;
        rowFinished = true;
      }
    }
    rows.push(row);
  }
  return rows;
}

const NUMERIC_CELL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseTableUnits(sourceId: string, text: string, offsets: Uint32Array, delimiter: ',' | '\t'): UnitDraft[] {
  const rows = parseDelimitedRows(text, delimiter);
  const units: UnitDraft[] = [];
  rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    appendUnit(units, {
      sourceId,
      kind: 'table-cell',
      locator: {
        startByte: offsets[cell.start],
        endByte: offsets[cell.end],
        rowIndex,
        columnIndex,
      },
      cellValue: cell.value,
      ...(NUMERIC_CELL_PATTERN.test(cell.value) ? { numericLexeme: cell.value } : {}),
    });
  }));
  return units;
}

function createSource(
  sourcePath: string,
  order: number,
  bytes: Buffer,
  kind: ContentSource['kind'],
  text: string | null,
  warnings: ContentWarning[],
): ContentSource {
  const sha = sha256(bytes);
  return {
    id: contentSourceId(sourcePath, order, sha),
    sourcePath,
    originalName: path.posix.basename(sourcePath),
    mediaType: mediaTypeFor(sourcePath),
    sha256: sha,
    order,
    byteLength: bytes.byteLength,
    kind,
    text,
    warnings,
  };
}

/**
 * Compile only user-selected project files into replaceable internal ContentIR.
 * The compiler inventories binary assets but never parses Office/PDF content,
 * runs OCR, or calls a model.
 */
export async function compileContentIR(
  projectsRoot: string,
  projectId: string,
  filePaths: readonly string[],
): Promise<ContentIR> {
  if (!Array.isArray(filePaths) || filePaths.length > MAX_CONTENT_SOURCES) {
    throw new ContentCompilerError('INVALID_CONTENT_SELECTION', 'Select no more than 12 evidence files.', 413);
  }

  const selected = await resolveSources(projectsRoot, projectId, filePaths);
  const sources: ContentSource[] = [];
  const unitDrafts: UnitDraft[] = [];
  let totalTextBytes = 0;
  let totalReadBytes = 0;

  for (let sourceOrder = 0; sourceOrder < selected.length; sourceOrder += 1) {
    const selectedSource = selected[sourceOrder];
    const remainingBytes = MAX_CONTENT_TOTAL_BYTES - totalReadBytes;
    const bytes = await readBoundedFile(selectedSource, Math.min(MAX_CONTENT_SOURCE_BYTES, remainingBytes));
    totalReadBytes += bytes.byteLength;
    const afterRead = await stat(selectedSource.absolutePath).catch((error) => { throw contentError(error, selectedSource.sourcePath); });
    if (afterRead.size !== selectedSource.byteLength || afterRead.mtimeMs !== selectedSource.mtimeMs
        || afterRead.dev !== selectedSource.dev || afterRead.ino !== selectedSource.ino) {
      throw new ContentCompilerError('SOURCE_CHANGED_DURING_COMPILE', `Evidence changed while being compiled: ${selectedSource.sourcePath}.`, 409);
    }

    const mediaType = mediaTypeFor(selectedSource.sourcePath);
    if (isImageMediaType(mediaType)) {
      const source = createSource(selectedSource.sourcePath, sourceOrder, bytes, 'image', null, [
        warning('IMAGE_INVENTORIED_NOT_EXTRACTED', 'Image source was inventoried by path and hash; pixels and embedded text were not extracted.'),
      ]);
      sources.push(source);
      appendUnit(unitDrafts, {
        sourceId: source.id,
        kind: 'media-reference',
        locator: { startByte: 0, endByte: bytes.byteLength },
      });
      continue;
    }
    if (!contentSourceSupportsText(selectedSource.sourcePath)) {
      sources.push(createSource(selectedSource.sourcePath, sourceOrder, bytes, 'unsupported', null, [
        warning('UNSUPPORTED_FORMAT_NOT_PARSED', 'This file type is retained as source metadata only; Office, PDF, OCR, and binary parsing are not performed.'),
      ]));
      continue;
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      sources.push(createSource(selectedSource.sourcePath, sourceOrder, bytes, 'unsupported', null, [
        warning('INVALID_UTF8_NOT_EXTRACTED', 'The file is not valid UTF-8; source bytes are inventoried without text extraction.'),
      ]));
      continue;
    }
    totalTextBytes += bytes.byteLength;
    if (totalTextBytes > MAX_CONTENT_TEXT_BYTES) {
      throw new ContentCompilerError('CONTENT_TEXT_TOO_LARGE', 'Extracted textual evidence exceeds the 256 KiB limit.', 413);
    }

    const source = createSource(selectedSource.sourcePath, sourceOrder, bytes, 'text', text, []);
    const offsets = contentByteOffsets(text);
    const extension = path.posix.extname(selectedSource.sourcePath).toLowerCase();
    let parsed: UnitDraft[] = [];
    const warnings: ContentWarning[] = [];
    if (extension === '.txt' || extension === '.md') {
      parsed = parseTextUnits(source.id, text, offsets, extension === '.md');
    } else if (extension === '.json') {
      try {
        parsed = parseJsonUnits(source.id, text, offsets);
      } catch (error) {
        if (error instanceof ContentCompilerError) throw error;
        warnings.push(warning('INVALID_JSON_NOT_PARSED', 'Raw UTF-8 source is retained, but JSON structure could not be extracted.'));
      }
    } else if (extension === '.csv' || extension === '.tsv') {
      try {
        parsed = parseTableUnits(source.id, text, offsets, extension === '.csv' ? ',' : '\t');
      } catch (error) {
        if (error instanceof ContentCompilerError) throw error;
        warnings.push(warning('INVALID_TABLE_NOT_PARSED', 'Raw UTF-8 source is retained, but table cells could not be extracted.'));
      }
    }
    if (unitDrafts.length + parsed.length > MAX_CONTENT_UNITS) {
      throw new ContentCompilerError('CONTENT_UNIT_LIMIT_EXCEEDED', 'Extracted evidence exceeds the 4096 unit limit.', 413);
    }
    source.warnings.push(...warnings);
    sources.push(source);
    for (const draft of parsed) {
      const withGlobalOrder = { ...draft, order: unitDrafts.length };
      unitDrafts.push(withGlobalOrder);
    }
  }

  const units = unitDrafts.map((draft) => makeUnit(draft.sourceId, draft));
  return finalizeContentIR(sources, units);
}
