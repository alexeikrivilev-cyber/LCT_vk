import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface TemplateSource {
  filePath: string;
  originalName: string;
  sha256: string;
  compiledAt: string;
  compilerVersion: string;
}

export interface TemplateGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  unit: 'EMU';
}

export interface TemplateRelationship {
  /** IR-stable relationship id; `nativeId` retains the package's exact rId. */
  id: string;
  nativeId: string;
  sourcePart: string;
  type: string;
  target: string;
  targetPart: string | null;
  mode: 'internal' | 'external';
}

export interface TemplateWarning {
  code: string | null;
  message: string;
  sourcePart: string | null;
  elementId: string | null;
}

export interface DirectElementStyles {
  fonts: string[] | null;
  fontSizesPt: number[] | null;
  bold: boolean | null;
  italic: boolean | null;
  fillColor: string | null;
  lineColor: string | null;
}

export interface TemplateElement {
  id: string;
  kind: string;
  nativeId: string | null;
  name: string | null;
  order: number;
  parentId: string | null;
  nativeParentId: string | null;
  text: string | null;
  placeholder: {
    index: string | null;
    type: string | null;
    role: string | null;
  } | null;
  geometry: {
    direct: TemplateGeometry | null;
    resolved: TemplateGeometry | null;
    provenance: string | null;
  };
  /** Explicit OOXML style facts only; this does not contain resolved style cascade. */
  directStyles: DirectElementStyles;
  relationshipIds: string[];
  warnings: TemplateWarning[];
}

export interface TemplateMaster {
  id: string;
  sourcePart: string;
  declaredName: string | null;
  layoutIds: string[];
  relationships: TemplateRelationship[];
  background: TemplateBackground | null;
  colorMapping: TemplateColorMapping | null;
  elements: TemplateElement[];
  designElementIds: string[];
  warnings: TemplateWarning[];
}

export interface TemplateLayout {
  id: string;
  sourcePart: string;
  masterId: string | null;
  declaredName: string | null;
  declaredType: string | null;
  matchingName: string | null;
  preserve: boolean | null;
  relationships: TemplateRelationship[];
  background: TemplateBackground | null;
  colorMapping: TemplateColorMapping | null;
  elements: TemplateElement[];
  designElementIds: string[];
  warnings: TemplateWarning[];
}

export interface TemplateSlide {
  id: string;
  index: number;
  sourcePart: string;
  layoutId: string | null;
  masterId: string | null;
  relationships: TemplateRelationship[];
  background: TemplateBackground | null;
  elements: TemplateElement[];
  designElementIds: string[];
  warnings: TemplateWarning[];
}

export interface PartialTemplateTheme {
  sourcePart: string | null;
  colors: Record<string, string>;
  fonts: {
    major: string | null;
    minor: string | null;
  };
}

export type TemplateBackground =
  | { kind: 'scheme_reference'; index: string | null; schemeColor: string | null; schemeColorType: string | null }
  | { kind: 'explicit'; element: string; fill: TemplateBackgroundFill | null };

export interface TemplateBackgroundFill {
  kind: string;
  attributes: Record<string, string>;
  colors: Array<{ type: string; attributes: Record<string, string>; position: string | null }>;
  relationshipNativeId: string | null;
}

export interface TemplateColorMapping {
  masterMapping: Record<string, string> | null;
  layoutOverrides: Array<{ element: string; attributes: Record<string, string> }> | null;
}

export interface TemplateAsset {
  id: string;
  part: string;
  relationshipIds: string[];
  contentType: string | null;
  kind: 'media';
}

export interface UnsupportedObservation {
  id: string;
  kind: string;
  part: string;
  reason: string;
  slide: string | number | null;
  element: string | number | null;
  relationshipId: string | null;
  target: string | null;
}

export interface TemplateIR {
  id: string;
  hash: string;
  schemaVersion: 1;
  source: TemplateSource;
  slideSize: { width: number; height: number; unit: 'EMU' };
  masters: TemplateMaster[];
  layouts: TemplateLayout[];
  slides: TemplateSlide[];
  theme: PartialTemplateTheme | null;
  notesParts: string[];
  assets: TemplateAsset[];
  unsupported: UnsupportedObservation[];
  warnings: TemplateWarning[];
}

export interface DesignSystemLayout {
  id: string;
  sourcePart: string;
  declaredName: string | null;
  declaredType: string | null;
  matchingName: string | null;
  placeholderRoles: string[];
  elementCounts: { total: number; byKind: Record<string, number> };
  usageCount: number;
  relationshipIds: string[];
}

export interface DesignSystemAsset {
  id: string;
  part: string;
  relationshipIds: string[];
}

export interface PresentationDesignSystem {
  id: string;
  hash: string;
  schemaVersion: 1;
  templateIRId: string;
  templateIRHash: string;
  canvas: {
    width: number;
    height: number;
    unit: 'EMU';
    aspectRatio: number;
  };
  typography: {
    direct: Array<{ elementId: string; fonts: string[]; fontSizesPt: number[] }>;
    observedFonts: string[];
    observedSizesPt: number[];
    theme: { major: string | null; minor: string | null };
  };
  colors: {
    direct: Array<{ role: 'fill' | 'line'; value: string; uses: number; elementIds: string[] }>;
    theme: Array<{ name: string; value: string }>;
  };
  layouts: DesignSystemLayout[];
  assets: DesignSystemAsset[];
  warnings: TemplateWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isPart(value: unknown): value is string {
  return isString(value) && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isProjectRelativePath(value: unknown): value is string {
  return isString(value) && value.length > 0 && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.includes('\0') && value.replaceAll('\\', '/').split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function isGeometry(value: unknown): value is TemplateGeometry {
  if (!isRecord(value) || !exactKeys(value, ['x', 'y', 'width', 'height', 'rotation', 'unit'])) return false;
  return isSafeInteger(value.x) && isSafeInteger(value.y) && isSafeInteger(value.width)
    && isSafeInteger(value.height) && isFiniteNumber(value.rotation) && value.unit === 'EMU';
}

function isWarning(value: unknown): value is TemplateWarning {
  if (!isRecord(value) || !exactKeys(value, ['code', 'message', 'sourcePart', 'elementId'])) return false;
  return isNullableString(value.code) && isString(value.message) && isNullableString(value.sourcePart)
    && isNullableString(value.elementId);
}

function isWarnings(value: unknown): value is TemplateWarning[] {
  return Array.isArray(value) && value.every(isWarning);
}

function isRelationship(value: unknown): value is TemplateRelationship {
  if (!isRecord(value) || !exactKeys(value, ['id', 'nativeId', 'sourcePart', 'type', 'target', 'targetPart', 'mode'])) return false;
  return isString(value.id) && isString(value.nativeId) && isPart(value.sourcePart) && isString(value.type)
    && isString(value.target) && (value.targetPart === null || isPart(value.targetPart))
    && (value.mode === 'internal' || value.mode === 'external');
}

function isElement(value: unknown): value is TemplateElement {
  if (!isRecord(value) || !exactKeys(value, [
    'id', 'kind', 'nativeId', 'name', 'order', 'parentId', 'nativeParentId', 'text', 'placeholder',
    'geometry', 'directStyles', 'relationshipIds', 'warnings',
  ])) return false;
  const placeholder = value.placeholder;
  const geometry = value.geometry;
  const placeholderValid = placeholder === null || (isRecord(placeholder)
    && exactKeys(placeholder, ['index', 'type', 'role']) && isNullableString(placeholder.index)
    && isNullableString(placeholder.type) && isNullableString(placeholder.role));
  const geometryValid = isRecord(geometry) && exactKeys(geometry, ['direct', 'resolved', 'provenance'])
    && (geometry.direct === null || isGeometry(geometry.direct))
    && (geometry.resolved === null || isGeometry(geometry.resolved)) && isNullableString(geometry.provenance);
  return isString(value.id) && isString(value.kind) && isNullableString(value.nativeId) && isNullableString(value.name)
    && isSafeInteger(value.order) && value.order >= 0 && isNullableString(value.parentId)
    && isNullableString(value.nativeParentId) && isNullableString(value.text) && placeholderValid && geometryValid
    && isDirectStyles(value.directStyles) && Array.isArray(value.relationshipIds)
    && value.relationshipIds.every(isString) && isWarnings(value.warnings);
}

function isDirectStyles(value: unknown): value is DirectElementStyles {
  if (!isRecord(value) || !exactKeys(value, ['fonts', 'fontSizesPt', 'bold', 'italic', 'fillColor', 'lineColor'])) return false;
  return (value.fonts === null || (Array.isArray(value.fonts) && value.fonts.every(isString)))
    && (value.fontSizesPt === null || (Array.isArray(value.fontSizesPt) && value.fontSizesPt.every((size) => isFiniteNumber(size) && size >= 0)))
    && (value.bold === null || typeof value.bold === 'boolean') && (value.italic === null || typeof value.italic === 'boolean')
    && isNullableString(value.fillColor) && isNullableString(value.lineColor);
}

function isElements(value: unknown): value is TemplateElement[] {
  return Array.isArray(value) && value.every(isElement);
}

function isRelationships(value: unknown): value is TemplateRelationship[] {
  return Array.isArray(value) && value.every(isRelationship);
}

function isGroupCore(value: Record<string, unknown>): boolean {
  return isString(value.id) && isPart(value.sourcePart) && isNullableString(value.declaredName)
    && isRelationships(value.relationships) && isElements(value.elements)
    && Array.isArray(value.designElementIds) && value.designElementIds.every(isString)
    && isWarnings(value.warnings);
}

function isMaster(value: unknown): value is TemplateMaster {
  if (!isRecord(value) || !exactKeys(value, [
    'id', 'sourcePart', 'declaredName', 'layoutIds', 'relationships', 'background', 'colorMapping', 'elements', 'designElementIds', 'warnings',
  ]) || !isGroupCore(value)) return false;
  return Array.isArray(value.layoutIds) && value.layoutIds.every(isString)
    && (value.background === null || isBackground(value.background))
    && (value.colorMapping === null || isColorMapping(value.colorMapping));
}

function isLayout(value: unknown): value is TemplateLayout {
  if (!isRecord(value) || !exactKeys(value, [
    'id', 'sourcePart', 'masterId', 'declaredName', 'declaredType', 'matchingName', 'preserve', 'relationships', 'elements',
    'background', 'colorMapping', 'designElementIds', 'warnings',
  ]) || !isGroupCore(value)) return false;
  return isNullableString(value.masterId) && isNullableString(value.declaredType) && isNullableString(value.matchingName)
    && (value.preserve === null || typeof value.preserve === 'boolean')
    && (value.background === null || isBackground(value.background))
    && (value.colorMapping === null || isColorMapping(value.colorMapping));
}

function isBackground(value: unknown): value is TemplateBackground {
  if (!isRecord(value)) return false;
  if (value.kind === 'scheme_reference') {
    return exactKeys(value, ['kind', 'index', 'schemeColor', 'schemeColorType'])
      && isNullableString(value.index) && isNullableString(value.schemeColor) && isNullableString(value.schemeColorType);
  }
  return value.kind === 'explicit' && exactKeys(value, ['kind', 'element', 'fill']) && isString(value.element)
    && (value.fill === null || isBackgroundFill(value.fill));
}

function isBackgroundFill(value: unknown): value is TemplateBackgroundFill {
  return isRecord(value) && exactKeys(value, ['kind', 'attributes', 'colors', 'relationshipNativeId'])
    && isString(value.kind) && isRecord(value.attributes) && Object.values(value.attributes).every(isString)
    && Array.isArray(value.colors) && value.colors.every((color) => isRecord(color)
      && exactKeys(color, ['type', 'attributes', 'position']) && isString(color.type)
      && isRecord(color.attributes) && Object.values(color.attributes).every(isString) && isNullableString(color.position))
    && isNullableString(value.relationshipNativeId);
}

function isColorMapping(value: unknown): value is TemplateColorMapping {
  return isRecord(value) && exactKeys(value, ['masterMapping', 'layoutOverrides'])
    && (value.masterMapping === null || (isRecord(value.masterMapping) && Object.values(value.masterMapping).every(isString)))
    && (value.layoutOverrides === null || (Array.isArray(value.layoutOverrides) && value.layoutOverrides.every((entry) =>
      isRecord(entry) && exactKeys(entry, ['element', 'attributes']) && isString(entry.element)
        && isRecord(entry.attributes) && Object.values(entry.attributes).every(isString))));
}

function isSlide(value: unknown): value is TemplateSlide {
  if (!isRecord(value) || !exactKeys(value, [
    'id', 'index', 'sourcePart', 'layoutId', 'masterId', 'relationships', 'background', 'elements', 'designElementIds', 'warnings',
  ])) return false;
  return isString(value.id) && isSafeInteger(value.index) && value.index > 0 && isPart(value.sourcePart)
    && isNullableString(value.layoutId) && isNullableString(value.masterId) && isRelationships(value.relationships)
    && (value.background === null || isBackground(value.background))
    && isElements(value.elements) && Array.isArray(value.designElementIds) && value.designElementIds.every(isString)
    && isWarnings(value.warnings);
}

function isTheme(value: unknown): value is PartialTemplateTheme {
  if (!isRecord(value) || !exactKeys(value, ['sourcePart', 'colors', 'fonts'])) return false;
  const fonts = value.fonts;
  return isNullableString(value.sourcePart) && isRecord(value.colors)
    && Object.entries(value.colors).every(([key, color]) => key.length > 0 && isString(color))
    && isRecord(fonts) && exactKeys(fonts, ['major', 'minor']) && isNullableString(fonts.major)
    && isNullableString(fonts.minor);
}

function isAsset(value: unknown): value is TemplateAsset {
  if (!isRecord(value) || !exactKeys(value, ['id', 'part', 'relationshipIds', 'contentType', 'kind'])) return false;
  return isString(value.id) && isPart(value.part) && Array.isArray(value.relationshipIds)
    && value.relationshipIds.every(isString) && isNullableString(value.contentType) && value.kind === 'media'
    ;
}

function isUnsupported(value: unknown): value is UnsupportedObservation {
  if (!isRecord(value) || !exactKeys(value, [
    'id', 'kind', 'part', 'reason', 'slide', 'element', 'relationshipId', 'target',
  ])) return false;
  return isString(value.id) && isString(value.kind) && isPart(value.part) && isString(value.reason)
    && (value.slide === null || isString(value.slide) || isSafeInteger(value.slide))
    && (value.element === null || isString(value.element) || isSafeInteger(value.element))
    && isNullableString(value.relationshipId) && isNullableString(value.target);
}

function sortedObject(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!isRecord(value)) return value;
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) result[key] = sortedObject(value[key] as JsonValue);
  return result;
}

/** Canonical serialization for deterministic private IR hashes. */
export function canonicalTemplateJson(value: JsonValue): string {
  return JSON.stringify(sortedObject(value));
}

export function templateIRHashPayload(templateIR: Omit<TemplateIR, 'hash'> | TemplateIR): JsonValue {
  const payload = JSON.parse(JSON.stringify(templateIR)) as JsonObject;
  delete payload.hash;
  const source = payload.source;
  if (isRecord(source)) delete source.compiledAt;
  return payload;
}

export function presentationDesignSystemHashPayload(
  designSystem: Omit<PresentationDesignSystem, 'hash'> | PresentationDesignSystem,
): JsonValue {
  const payload = JSON.parse(JSON.stringify(designSystem)) as JsonObject;
  delete payload.hash;
  return payload;
}

export function sha256Json(value: JsonValue): string {
  return createHash('sha256').update(canonicalTemplateJson(value)).digest('hex');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid persisted presentation value: ${message}`);
}

export function validateTemplateIR(value: unknown): TemplateIR {
  assert(isRecord(value) && exactKeys(value, [
    'id', 'hash', 'schemaVersion', 'source', 'slideSize', 'masters', 'layouts', 'slides', 'theme', 'notesParts', 'assets', 'unsupported', 'warnings',
  ]), 'TemplateIR fields');
  assert(value.schemaVersion === 1 && isString(value.id) && isString(value.hash), 'TemplateIR version/id/hash');
  const source = value.source;
  assert(isRecord(source) && exactKeys(source, ['filePath', 'originalName', 'sha256', 'compiledAt', 'compilerVersion'])
    && isProjectRelativePath(source.filePath) && isString(source.originalName) && source.originalName.length > 0
    && /^[a-f0-9]{64}$/.test(String(source.sha256)) && isString(source.compiledAt) && source.compiledAt.length > 0
    && isString(source.compilerVersion) && source.compilerVersion.length > 0, 'TemplateIR source');
  assert(value.id === `tir_${String(source.sha256).slice(0, 16)}`, 'TemplateIR deterministic id');
  const slideSize = value.slideSize;
  assert(isRecord(slideSize) && exactKeys(slideSize, ['width', 'height', 'unit'])
    && isSafeInteger(slideSize.width) && slideSize.width > 0 && isSafeInteger(slideSize.height)
    && slideSize.height > 0 && slideSize.unit === 'EMU', 'TemplateIR slide size');
  assert(Array.isArray(value.masters) && value.masters.every(isMaster), 'TemplateIR masters');
  assert(Array.isArray(value.layouts) && value.layouts.every(isLayout), 'TemplateIR layouts');
  assert(Array.isArray(value.slides) && value.slides.every(isSlide), 'TemplateIR slides');
  assert(value.theme === null || isTheme(value.theme), 'TemplateIR partial theme');
  assert(Array.isArray(value.notesParts) && value.notesParts.every(isPart), 'TemplateIR notes parts');
  assert(Array.isArray(value.assets) && value.assets.every(isAsset), 'TemplateIR assets');
  assert(Array.isArray(value.unsupported) && value.unsupported.every(isUnsupported), 'TemplateIR unsupported observations');
  assert(isWarnings(value.warnings), 'TemplateIR warnings');

  const ir = value as unknown as TemplateIR;
  const mastersById = new Map(ir.masters.map((item) => [item.id, item]));
  const layoutsById = new Map(ir.layouts.map((item) => [item.id, item]));
  const elementsById = new Set<string>();
  const relationshipById = new Map<string, TemplateRelationship>();
  const entityIds = new Set<string>([ir.id]);
  for (const collection of [ir.masters, ir.layouts, ir.slides]) {
    for (const item of collection) {
      assert(!entityIds.has(item.id), `duplicate entity id ${item.id}`);
      entityIds.add(item.id);
      for (const relationship of item.relationships) {
        assert(!relationshipById.has(relationship.id), `duplicate relationship id ${relationship.id}`);
        relationshipById.set(relationship.id, relationship);
      }
      for (const element of item.elements) {
        assert(!elementsById.has(element.id), `duplicate element id ${element.id}`);
        elementsById.add(element.id);
        assert(!entityIds.has(element.id), `duplicate entity id ${element.id}`);
        entityIds.add(element.id);
      }
      for (const elementId of item.designElementIds) assert(item.elements.some((element) => element.id === elementId), 'design element reference');
      const backgroundNativeId = item.background?.kind === 'explicit' ? item.background.fill?.relationshipNativeId : null;
      if (backgroundNativeId !== null && backgroundNativeId !== undefined) {
        assert(item.relationships.some((relationship) => relationship.nativeId === backgroundNativeId
          && relationship.sourcePart === item.sourcePart), 'background relationship reference');
      }
    }
  }
  const allRelationships = [
    ...ir.masters.flatMap((item) => item.relationships),
    ...ir.layouts.flatMap((item) => item.relationships),
    ...ir.slides.flatMap((item) => item.relationships),
  ];
  for (const relationship of allRelationships) {
    assert(relationship.id.length > 0 && relationship.nativeId.length > 0, 'relationship id');
  }
  const slideParts = new Set(ir.slides.map((slide) => slide.sourcePart));
  const relationIds = new Set(allRelationships.map((relationship) => relationship.id));
  for (const group of [...ir.masters, ...ir.layouts, ...ir.slides]) {
    for (const element of group.elements) {
      for (const relationshipId of element.relationshipIds) {
        assert(relationIds.has(relationshipId), `element relationship reference ${relationshipId}`);
      }
    }
  }
  for (const master of ir.masters) for (const layoutId of master.layoutIds) assert(layoutsById.has(layoutId), `master layout reference ${layoutId}`);
  for (const layout of ir.layouts) assert(layout.masterId === null || mastersById.has(layout.masterId), 'layout master reference');
  for (const slide of ir.slides) {
    assert(slide.layoutId === null || layoutsById.has(slide.layoutId), 'slide layout reference');
    assert(slide.masterId === null || mastersById.has(slide.masterId), 'slide master reference');
  }
  for (const asset of ir.assets) {
    for (const relationshipId of asset.relationshipIds) {
      assert(relationIds.has(relationshipId), `asset relationship reference ${relationshipId}`);
      assert(allRelationships.some((relationship) => relationship.id === relationshipId && relationship.mode === 'internal'
        && relationship.targetPart === asset.part), `asset relationship target ${relationshipId}`);
    }
  }
  for (const unsupported of ir.unsupported) {
    if (typeof unsupported.slide === 'string' && unsupported.slide.startsWith('ppt/slides/')) {
      assert(slideParts.has(unsupported.slide), `unsupported slide source ${unsupported.slide}`);
    }
  }
  assert(/^[a-f0-9]{64}$/.test(ir.hash), 'TemplateIR hash format');
  assert(sha256Json(templateIRHashPayload(ir)) === ir.hash, 'TemplateIR content hash');
  return ir;
}

export function validatePresentationDesignSystem(value: unknown, sourceTemplateIR?: TemplateIR): PresentationDesignSystem {
  assert(isRecord(value) && exactKeys(value, [
    'id', 'hash', 'schemaVersion', 'templateIRId', 'templateIRHash', 'canvas', 'typography', 'colors', 'layouts', 'assets', 'warnings',
  ]), 'PresentationDesignSystem fields');
  assert(value.schemaVersion === 1 && isString(value.id) && isString(value.hash)
    && isString(value.templateIRId) && isString(value.templateIRHash), 'PresentationDesignSystem version/id/hash');
  assert(/^tir_[a-f0-9]{16}$/.test(value.templateIRId) && /^[a-f0-9]{64}$/.test(value.templateIRHash), 'PresentationDesignSystem TemplateIR reference');
  assert(value.id === `pds_${value.templateIRHash.slice(0, 16)}`, 'PresentationDesignSystem deterministic id');
  const canvas = value.canvas;
  assert(isRecord(canvas) && exactKeys(canvas, ['width', 'height', 'unit', 'aspectRatio'])
    && isSafeInteger(canvas.width) && canvas.width > 0 && isSafeInteger(canvas.height) && canvas.height > 0
    && canvas.unit === 'EMU' && isFiniteNumber(canvas.aspectRatio) && canvas.aspectRatio > 0
    && Math.abs(canvas.aspectRatio - canvas.width / canvas.height) < 1e-12, 'PresentationDesignSystem canvas');
  const typography = value.typography;
  assert(isRecord(typography) && exactKeys(typography, ['direct', 'observedFonts', 'observedSizesPt', 'theme']) && Array.isArray(typography.direct)
    && typography.direct.every((entry) => isRecord(entry) && exactKeys(entry, ['elementId', 'fonts', 'fontSizesPt'])
      && isString(entry.elementId) && Array.isArray(entry.fonts) && entry.fonts.every(isString)
      && Array.isArray(entry.fontSizesPt) && entry.fontSizesPt.every((size) => isFiniteNumber(size) && size >= 0))
    && Array.isArray(typography.observedFonts) && typography.observedFonts.every(isString)
    && Array.isArray(typography.observedSizesPt) && typography.observedSizesPt.every((size) => isFiniteNumber(size) && size >= 0)
    && isRecord(typography.theme) && exactKeys(typography.theme, ['major', 'minor'])
    && isNullableString(typography.theme.major) && isNullableString(typography.theme.minor), 'PresentationDesignSystem typography');
  const colors = value.colors;
  assert(isRecord(colors) && exactKeys(colors, ['direct', 'theme']) && Array.isArray(colors.direct)
    && colors.direct.every((entry) => isRecord(entry) && exactKeys(entry, ['role', 'value', 'uses', 'elementIds'])
      && (entry.role === 'fill' || entry.role === 'line') && isString(entry.value)
      && isSafeInteger(entry.uses) && entry.uses > 0 && Array.isArray(entry.elementIds)
      && entry.elementIds.length === entry.uses && entry.elementIds.every(isString))
    && Array.isArray(colors.theme) && colors.theme.every((entry) => isRecord(entry)
      && exactKeys(entry, ['name', 'value']) && isString(entry.name) && isString(entry.value)), 'PresentationDesignSystem colors');
  assert(Array.isArray(value.layouts) && value.layouts.every((layout) => isRecord(layout)
    && exactKeys(layout, ['id', 'sourcePart', 'declaredName', 'declaredType', 'matchingName', 'placeholderRoles', 'elementCounts', 'usageCount', 'relationshipIds'])
    && isString(layout.id) && isPart(layout.sourcePart) && isNullableString(layout.declaredName)
    && isNullableString(layout.declaredType) && isNullableString(layout.matchingName)
    && Array.isArray(layout.placeholderRoles) && layout.placeholderRoles.every(isString)
    && isRecord(layout.elementCounts) && exactKeys(layout.elementCounts, ['total', 'byKind'])
    && isSafeInteger(layout.elementCounts.total) && layout.elementCounts.total >= 0 && isRecord(layout.elementCounts.byKind)
    && Object.values(layout.elementCounts.byKind).every((count) => isSafeInteger(count) && count >= 0)
    && isSafeInteger(layout.usageCount) && layout.usageCount >= 0
    && Array.isArray(layout.relationshipIds) && layout.relationshipIds.every(isString)), 'PresentationDesignSystem layouts');
  assert(Array.isArray(value.assets) && value.assets.every((asset) => isRecord(asset)
    && exactKeys(asset, ['id', 'part', 'relationshipIds']) && isString(asset.id) && isPart(asset.part)
    && Array.isArray(asset.relationshipIds) && asset.relationshipIds.every(isString)), 'PresentationDesignSystem assets');
  assert(isWarnings(value.warnings), 'PresentationDesignSystem warnings');

  const pds = value as unknown as PresentationDesignSystem;
  const elementIds = new Set<string>();
  for (const layout of pds.layouts) {
    for (const relationshipId of layout.relationshipIds) assert(isString(relationshipId) && relationshipId.length > 0, 'layout relationship id');
  }
  for (const entry of pds.typography.direct) elementIds.add(entry.elementId);
  for (const color of pds.colors.direct) for (const elementId of color.elementIds) elementIds.add(elementId);
  const expectedFonts = [...new Set(pds.typography.direct.flatMap((entry) => entry.fonts))].sort(compareCodepoints);
  const expectedSizes = [...new Set(pds.typography.direct.flatMap((entry) => entry.fontSizesPt))].sort((a, b) => a - b);
  assert(JSON.stringify(pds.typography.observedFonts) === JSON.stringify(expectedFonts), 'PresentationDesignSystem observed fonts');
  assert(JSON.stringify(pds.typography.observedSizesPt) === JSON.stringify(expectedSizes), 'PresentationDesignSystem observed font sizes');
  const colorKeys = new Set<string>();
  let previousColorKey = '';
  for (const color of pds.colors.direct) {
    const key = `${color.role}\0${color.value}`;
    assert(!colorKeys.has(key), 'duplicate aggregated direct color');
    colorKeys.add(key);
    assert(new Set(color.elementIds).size === color.elementIds.length, 'duplicate direct color element reference');
    assert(compareCodepoints(key, previousColorKey) >= 0, 'direct color aggregation order');
    previousColorKey = key;
  }
  assert(pds.layouts.every((layout) => layout.placeholderRoles.length <= layout.elementCounts.total), 'layout placeholder count');
  assert(new Set(pds.assets.map((asset) => asset.id)).size === pds.assets.length, 'duplicate design-system asset id');
  if (sourceTemplateIR !== undefined) {
    const ir = validateTemplateIR(sourceTemplateIR);
    assert(pds.templateIRId === ir.id && pds.templateIRHash === ir.hash, 'PresentationDesignSystem source reference');
    const knownLayoutIds = new Set(ir.layouts.map((layout) => layout.id));
    const knownAssetIds = new Map(ir.assets.map((asset) => [asset.id, asset]));
    const knownElementIds = new Set([
      ...ir.masters.flatMap((master) => master.elements.map((element) => element.id)),
      ...ir.layouts.flatMap((layout) => layout.elements.map((element) => element.id)),
      ...ir.slides.flatMap((slide) => slide.elements.map((element) => element.id)),
    ]);
    const knownRelationships = new Map([
      ...ir.masters.flatMap((master) => master.relationships),
      ...ir.layouts.flatMap((layout) => layout.relationships),
      ...ir.slides.flatMap((slide) => slide.relationships),
    ].map((relationship) => [relationship.id, relationship]));
    assert(pds.layouts.every((layout) => knownLayoutIds.has(layout.id)), 'PresentationDesignSystem layout reference');
    assert(pds.layouts.every((layout) => layout.relationshipIds.every((id) => knownRelationships.has(id))), 'PresentationDesignSystem layout relationship reference');
    assert(pds.assets.every((asset) => {
      const sourceAsset = knownAssetIds.get(asset.id);
      return sourceAsset !== undefined && sourceAsset.part === asset.part
        && asset.relationshipIds.every((id) => {
          const relationship = knownRelationships.get(id);
          return relationship !== undefined && sourceAsset.relationshipIds.includes(id)
            && relationship.mode === 'internal' && relationship.targetPart === asset.part;
        });
    }), 'PresentationDesignSystem asset relationship reference');
    assert([...elementIds].every((id) => knownElementIds.has(id)), 'PresentationDesignSystem element reference');
  }
  assert(/^[a-f0-9]{64}$/.test(pds.hash), 'PresentationDesignSystem hash format');
  assert(sha256Json(presentationDesignSystemHashPayload(pds)) === pds.hash, 'PresentationDesignSystem content hash');
  return pds;
}
