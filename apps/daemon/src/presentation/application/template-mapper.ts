import type { InspectionEnvelope } from '../adapters/python-inspector.js';
import {
  sha256Json,
  templateIRHashPayload,
  presentationDesignSystemHashPayload,
  validatePresentationDesignSystem,
  validateTemplateIR,
} from '../domain/template-ir.js';
import type {
  JsonValue,
  DirectElementStyles,
  PartialTemplateTheme,
  TemplateBackground,
  TemplateBackgroundFill,
  TemplateColorMapping,
  PresentationDesignSystem,
  TemplateAsset,
  TemplateElement,
  TemplateGeometry,
  TemplateIR,
  TemplateLayout,
  TemplateMaster,
  TemplateRelationship,
  TemplateSlide,
  TemplateSource,
  TemplateWarning,
  UnsupportedObservation,
} from '../domain/template-ir.js';

// Keep the validator/type exports next to the mapper for the compiling service
// while their pure implementations stay in the domain module.
export type {
  PresentationDesignSystem,
  TemplateIR,
  TemplateSource,
} from '../domain/template-ir.js';

export { validatePresentationDesignSystem, validateTemplateIR } from '../domain/template-ir.js';

type RecordLike = Record<string, unknown>;
type InspectionLike = RecordLike & {
  slideSize?: unknown;
  slides?: unknown;
  masters?: unknown;
  layouts?: unknown;
  theme?: unknown;
  unsupportedParts?: unknown;
  unsupportedDetails?: unknown;
  parserWarnings?: unknown;
  notesParts?: unknown;
};

const HASH_PREFIX_LENGTH = 16;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function hashMaterial(value: string): string {
  // Hash the path/order/native id tuple instead of placing user-controlled PPTX
  // names or relationship ids directly into persisted ids.
  return sha256Json(value as unknown as JsonValue);
}

function stableId(kind: string, sourceHash: string, material: string): string {
  return `${kind}_${sourceHash.slice(0, HASH_PREFIX_LENGTH)}_${hashMaterial(material).slice(0, 16)}`;
}

function validPart(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) return null;
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return value;
}

function mapGeometry(value: unknown): TemplateGeometry | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height, rotation = 0, unit = 'EMU' } = value;
  if (![x, y, width, height].every(Number.isSafeInteger) || typeof rotation !== 'number' || !Number.isFinite(rotation) || unit !== 'EMU') return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number, rotation, unit: 'EMU' };
}

function warning(code: string, message: string, sourcePart: string | null, elementId: string | null, _evidence?: unknown): TemplateWarning {
  return { code, message, sourcePart, elementId };
}

function mapWarnings(input: unknown, sourcePart: string | null, elementId: string | null): TemplateWarning[] {
  return array(input).map((entry) => {
    if (typeof entry === 'string') return warning('PARSER_WARNING', entry, sourcePart, elementId, entry);
    const record = isRecord(entry) ? entry : {};
    const message = stringOr(record.message ?? record.reason, 'Inspector warning did not include a message.');
    return {
      code: nullableString(record.code ?? record.kind),
      message,
      sourcePart: validPart(record.sourcePart ?? record.part) ?? sourcePart,
      elementId: nullableString(record.elementId) ?? elementId,
    };
  });
}

function directStyles(input: unknown): DirectElementStyles {
  const style = isRecord(input) ? input : {};
  const fonts = Array.isArray(style.fonts) ? style.fonts.filter((item): item is string => typeof item === 'string') : null;
  const sizes = Array.isArray(style.font_sizes_pt)
    ? style.font_sizes_pt.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : Array.isArray(style.fontSizesPt)
      ? style.fontSizesPt.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      : null;
  return {
    fonts,
    fontSizesPt: sizes,
    bold: typeof style.bold === 'boolean' ? style.bold : null,
    italic: typeof style.italic === 'boolean' ? style.italic : null,
    fillColor: nullableString(style.fill_color ?? style.fillColor),
    lineColor: nullableString(style.line_color ?? style.lineColor),
  };
}

function mapRelationship(
  input: unknown,
  sourcePart: string,
  sourceHash: string,
  occurrence: number,
): TemplateRelationship | null {
  if (!isRecord(input)) return null;
  const nativeId = nullableString(input.id ?? input.nativeId);
  const type = nullableString(input.type);
  const target = nullableString(input.target);
  const mode = input.mode === 'external' ? 'external' : input.mode === 'internal' ? 'internal' : null;
  if (!nativeId || type === null || target === null || mode === null) return null;
  const targetPart = mode === 'internal' ? validPart(input.targetPart ?? input.resolvedTargetPart ?? input.resolved_part) : null;
  const id = stableId('rel', sourceHash, `${sourcePart}\0${nativeId}\0${occurrence}`);
  return { id, nativeId, sourcePart, type, target, targetPart, mode };
}

interface ElementBuildResult {
  elements: TemplateElement[];
  designElementIds: string[];
  relationships: TemplateRelationship[];
  warnings: TemplateWarning[];
}

function elementKey(input: unknown, index: number): string {
  const item = isRecord(input) ? input : {};
  const order = Number.isSafeInteger(item.sourceOrder) ? String(item.sourceOrder) : String(index);
  return `${order}\0${String(item.elementId ?? '')}\0${String(item.type ?? '')}\0${String(item.name ?? '')}`;
}

function makeElements(
  sourcePart: string,
  sourceHash: string,
  primary: unknown,
  design: unknown,
): ElementBuildResult {
  const warnings: TemplateWarning[] = [];
  const relationships: TemplateRelationship[] = [];
  const relationshipKeys = new Set<string>();
  const records = new Map<string, { raw: unknown; design: boolean; inputIndex: number }>();
  for (const [isDesign, items] of [[false, array(primary)], [true, array(design)]] as const) {
    items.forEach((raw, inputIndex) => {
      const key = elementKey(raw, inputIndex);
      const existing = records.get(key);
      records.set(key, { raw, design: isDesign || Boolean(existing?.design), inputIndex: existing?.inputIndex ?? inputIndex });
    });
  }

  const nativeIdToId = new Map<string, string>();
  const built: Array<{ element: TemplateElement; isDesign: boolean }> = [];
  let relationOccurrence = 0;
  let ordinal = 0;
  for (const { raw, design: isDesign, inputIndex } of records.values()) {
    const item = isRecord(raw) ? raw : {};
    const nativeId = nullableString(item.elementId ?? item.nativeId);
    const order = Number.isSafeInteger(item.sourceOrder) && (item.sourceOrder as number) >= 0
      ? item.sourceOrder as number
      : inputIndex;
    const id = stableId('el', sourceHash, `${sourcePart}\0${order}\0${nativeId ?? ''}\0${ordinal}`);
    ordinal += 1;
    if (nativeId && !nativeIdToId.has(nativeId)) nativeIdToId.set(nativeId, id);
    const rawGeometry = item.rawGeometry ?? item.geometry;
    const resolvedGeometry = item.resolvedGeometry ?? item.effectiveGeometry;
    const direct = mapGeometry(rawGeometry);
    const resolved = mapGeometry(resolvedGeometry);
    const geometryProvenance = nullableString(item.geometryProvenance);
    const placeholderIdentity = isRecord(item.placeholderIdentity) ? item.placeholderIdentity : null;
    const placeholderRole = nullableString(item.placeholderRole);
    const placeholder = placeholderIdentity || placeholderRole !== null
      ? {
        index: nullableString(placeholderIdentity?.idx),
        type: nullableString(placeholderIdentity?.type),
        role: placeholderRole,
      }
      : null;
    const elementWarnings = mapWarnings(item.warnings, sourcePart, id);
    const relationIds: string[] = [];
    if (item.relationship !== null && item.relationship !== undefined) {
      const mapped = mapRelationship(item.relationship, sourcePart, sourceHash, relationOccurrence++);
      if (mapped) {
        relationships.push(mapped);
        relationshipKeys.add(mapped.id);
        relationIds.push(mapped.id);
      } else {
        const itemWarning = warning('RELATIONSHIP_UNKNOWN', 'Element relationship could not be represented as a complete observation.', sourcePart, id);
        warnings.push(itemWarning);
        elementWarnings.push(itemWarning);
      }
    }
    if (typeof item.text !== 'string') {
      elementWarnings.push(warning('TEXT_UNKNOWN', 'Inspector did not report exact text for this element.', sourcePart, id, item.text ?? null));
    }
    if (typeof item.type !== 'string' || !item.type) {
      elementWarnings.push(warning('ELEMENT_KIND_UNKNOWN', 'Inspector did not report the native element kind.', sourcePart, id, item.type ?? null));
    }
    if (typeof item.name !== 'string') {
      elementWarnings.push(warning('ELEMENT_NAME_UNKNOWN', 'Inspector did not report the native element name.', sourcePart, id));
    }
    if (!Number.isSafeInteger(item.sourceOrder)) {
      elementWarnings.push(warning('SOURCE_ORDER_FALLBACK', 'Inspector omitted source order; sibling index was retained as a provisional order.', sourcePart, id, inputIndex));
    }
    if (!direct && !resolved) {
      elementWarnings.push(warning('GEOMETRY_UNKNOWN', 'Neither direct nor resolved geometry was reported.', sourcePart, id, { rawGeometry, resolvedGeometry }));
    } else if (resolvedGeometry === undefined) {
      elementWarnings.push(warning('RESOLVED_GEOMETRY_UNKNOWN', 'Resolved geometry was not reported; direct geometry is preserved separately.', sourcePart, id, rawGeometry ?? null));
    }
    if (rawGeometry !== undefined && rawGeometry !== null && direct === null) {
      elementWarnings.push(warning('DIRECT_GEOMETRY_INVALID', 'Reported direct geometry could not be represented in canonical EMU coordinates.', sourcePart, id));
    }
    if (resolvedGeometry !== undefined && resolvedGeometry !== null && resolved === null) {
      elementWarnings.push(warning('RESOLVED_GEOMETRY_INVALID', 'Reported resolved geometry could not be represented in canonical EMU coordinates.', sourcePart, id));
    }
    if (placeholderRole !== null && !placeholderIdentity) {
      elementWarnings.push(warning('PLACEHOLDER_IDENTITY_UNKNOWN', 'Placeholder role was reported without its native index/type identity.', sourcePart, id, placeholderRole));
    }
    const stylesInput = item.style ?? item.directStyles;
    if (!isRecord(stylesInput)) {
      elementWarnings.push(warning('DIRECT_STYLES_UNKNOWN', 'Inspector did not report a direct-style object.', sourcePart, id));
    } else {
      const knownStyleKeys = new Set(['fonts', 'font_sizes_pt', 'fontSizesPt', 'bold', 'italic', 'fill_color', 'fillColor', 'line_color', 'lineColor']);
      const unknownStyleKeys = Object.keys(stylesInput).filter((key) => !knownStyleKeys.has(key)).sort();
      if (unknownStyleKeys.length) {
        elementWarnings.push(warning('DIRECT_STYLE_FIELDS_UNKNOWN', `Unrecognized direct-style fields: ${unknownStyleKeys.join(', ')}.`, sourcePart, id));
      }
      const malformedStyleKeys = Object.entries(stylesInput).filter(([key, value]) => {
        if (key === 'fonts') return !Array.isArray(value) || value.some((font) => typeof font !== 'string');
        if (key === 'font_sizes_pt' || key === 'fontSizesPt') return !Array.isArray(value) || value.some((size) => typeof size !== 'number' || !Number.isFinite(size));
        if (key === 'bold' || key === 'italic') return typeof value !== 'boolean';
        if (key === 'fill_color' || key === 'fillColor' || key === 'line_color' || key === 'lineColor') return typeof value !== 'string';
        return false;
      }).map(([key]) => key).sort();
      if (malformedStyleKeys.length) {
        elementWarnings.push(warning('DIRECT_STYLE_VALUE_UNKNOWN', `Direct-style values were omitted for: ${malformedStyleKeys.join(', ')}.`, sourcePart, id));
      }
    }
    const element: TemplateElement = {
      id,
      kind: stringOr(item.type, 'unknown'),
      nativeId,
      name: nullableString(item.name),
      order,
      parentId: null,
      nativeParentId: nullableString(item.parentId ?? item.parentNativeId),
      text: nullableString(item.text),
      placeholder,
      geometry: { direct, resolved, provenance: geometryProvenance },
      directStyles: directStyles(stylesInput),
      relationshipIds: relationIds,
      warnings: elementWarnings,
    };
    built.push({ element, isDesign });
  }
  for (const { element } of built) {
    if (element.nativeParentId) element.parentId = nativeIdToId.get(element.nativeParentId) ?? null;
    if (element.nativeParentId && element.parentId === null) {
      element.warnings.push(warning('PARENT_REFERENCE_UNKNOWN', 'Native parent id was reported but no sibling observation matched it.', sourcePart, element.id, element.nativeParentId));
    }
  }
  const uniqueRelationships = [...new Map(relationships.map((relation) => [relation.id, relation])).values()];
  return {
    elements: built.map((item) => item.element),
    designElementIds: built.filter((item) => item.isDesign).map((item) => item.element.id),
    relationships: uniqueRelationships.filter((relationship) => relationshipKeys.has(relationship.id)),
    warnings,
  };
}

function groupRelationships(
  sourcePart: string,
  sourceHash: string,
  relationshipInputs: unknown,
): TemplateRelationship[] {
  const out: TemplateRelationship[] = [];
  const counts = new Map<string, number>();
  for (const item of array(relationshipInputs)) {
    const nativeId = isRecord(item) ? String(item.id ?? item.nativeId ?? '') : '';
    const occurrence = counts.get(nativeId) ?? 0;
    counts.set(nativeId, occurrence + 1);
    const relationship = mapRelationship(item, sourcePart, sourceHash, occurrence);
    if (relationship) out.push(relationship);
  }
  return out;
}

function mergeRelationships(...collections: TemplateRelationship[][]): TemplateRelationship[] {
  const merged = new Map<string, TemplateRelationship>();
  for (const relationship of collections.flat()) {
    if (!merged.has(relationship.id)) merged.set(relationship.id, relationship);
  }
  return [...merged.values()];
}

function groupWarnings(input: unknown, sourcePart: string): TemplateWarning[] {
  return mapWarnings(input, sourcePart, null);
}

function mapTheme(value: unknown, warnings: TemplateWarning[]): PartialTemplateTheme | null {
  if (value === null || value === undefined) {
    warnings.push(warning('THEME_UNKNOWN', 'No theme color/font observations were reported.', null, null, null));
    return null;
  }
  if (!isRecord(value)) {
    warnings.push(warning('THEME_UNKNOWN', 'Theme observation had an unsupported structure.', null, null, value));
    return null;
  }
  const colorsInput = isRecord(value.colors) ? value.colors : {};
  const colors: Record<string, string> = {};
  for (const [key, color] of Object.entries(colorsInput)) if (typeof color === 'string') colors[key] = color;
  const fontsInput = isRecord(value.fonts) ? value.fonts : {};
  if (!isRecord(value.colors) || !isRecord(value.fonts)) {
    warnings.push(warning('THEME_PARTIAL', 'Theme palette or font observations are missing; available values are retained.', validPart(value.part), null, value));
  }
  return {
    sourcePart: validPart(value.part ?? value.sourcePart),
    colors,
    fonts: { major: nullableString(fontsInput.major), minor: nullableString(fontsInput.minor) },
  };
}

function mapBackground(input: unknown, sourcePart: string, warnings: TemplateWarning[]): TemplateBackground | null {
  if (input === null || input === undefined) return null;
  if (!isRecord(input)) {
    warnings.push(warning('BACKGROUND_UNKNOWN', 'Background observation had an unsupported structure.', sourcePart, null));
    return null;
  }
  if (input.kind === 'bgRef') {
    if ((input.idx === null || typeof input.idx === 'string')
        && (input.scheme_color === null || typeof input.scheme_color === 'string')
        && (input.scheme_color_type === null || typeof input.scheme_color_type === 'string')
        && input.fill === null) {
      return {
        kind: 'scheme_reference',
        index: nullableString(input.idx),
        schemeColor: nullableString(input.scheme_color),
        schemeColorType: nullableString(input.scheme_color_type),
      };
    }
  } else if (input.kind === 'explicit' && typeof input.element === 'string'
      && (input.fill === null || input.fill === undefined || isRecord(input.fill))) {
    let fill: TemplateBackgroundFill | null = null;
    if (isRecord(input.fill)) {
      const colors = Array.isArray(input.fill.colors) ? input.fill.colors : null;
      const relationship = input.fill.relationship;
      const validColors = colors?.every((color) => isRecord(color) && typeof color.type === 'string'
        && isRecord(color.attributes) && Object.values(color.attributes).every((attribute) => typeof attribute === 'string')
        && (color.position === null || typeof color.position === 'string')) ?? false;
      const validRelationship = relationship === null || (isRecord(relationship)
        && typeof relationship.id === 'string' && typeof relationship.type === 'string'
        && typeof relationship.target === 'string' && (relationship.targetPart === null || typeof relationship.targetPart === 'string')
        && (relationship.mode === 'internal' || relationship.mode === 'external'));
      if (typeof input.fill.kind !== 'string' || !isRecord(input.fill.attributes)
          || !Object.values(input.fill.attributes).every((attribute) => typeof attribute === 'string')
          || !validColors || !validRelationship) {
        warnings.push(warning('BACKGROUND_FILL_PARTIAL', 'Explicit background fill was malformed and has been omitted.', sourcePart, null));
      } else {
        fill = {
          kind: input.fill.kind,
          attributes: Object.fromEntries(Object.entries(input.fill.attributes).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) as Record<string, string>,
          colors: (colors ?? []).map((color) => ({
            type: color.type as string,
            attributes: Object.fromEntries(Object.entries(color.attributes as Record<string, string>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
            position: nullableString(color.position),
          })),
          relationshipNativeId: isRecord(relationship) ? nullableString(relationship.id) : null,
        };
      }
    }
    return { kind: 'explicit', element: input.element, fill };
  }
  warnings.push(warning('BACKGROUND_UNKNOWN', 'Background observation could not be represented canonically.', sourcePart, null));
  return null;
}

function mapColorMapping(input: unknown, sourcePart: string, warnings: TemplateWarning[]): TemplateColorMapping | null {
  if (input === null || input === undefined) return null;
  if (!isRecord(input)) {
    warnings.push(warning('COLOR_MAPPING_UNKNOWN', 'Color-mapping observation had an unsupported structure.', sourcePart, null));
    return null;
  }
  let masterMapping: Record<string, string> | null = null;
  let layoutOverrides: Array<{ element: string; attributes: Record<string, string> }> | null = null;
  if (input.master_mapping !== undefined) {
    if (isRecord(input.master_mapping)) {
      masterMapping = Object.fromEntries(Object.entries(input.master_mapping).filter((entry): entry is [string, string] => typeof entry[1] === 'string').sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    } else warnings.push(warning('COLOR_MAPPING_PARTIAL', 'Master color mapping was malformed and was omitted.', sourcePart, null));
  }
  if (input.layout_override !== undefined) {
    if (Array.isArray(input.layout_override)) {
      layoutOverrides = input.layout_override.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.element !== 'string' || !isRecord(entry.attributes)) return [];
        const attributes = Object.fromEntries(Object.entries(entry.attributes).filter((item): item is [string, string] => typeof item[1] === 'string').sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
        return [{ element: entry.element, attributes }];
      });
    } else warnings.push(warning('COLOR_MAPPING_PARTIAL', 'Layout color overrides were malformed and were omitted.', sourcePart, null));
  }
  if (masterMapping === null && layoutOverrides === null) {
    warnings.push(warning('COLOR_MAPPING_UNKNOWN', 'Color-mapping observation contained no recognized fields.', sourcePart, null));
    return null;
  }
  return { masterMapping, layoutOverrides };
}

function unsupportedObservations(
  input: unknown,
  oldParts: unknown,
  sourceHash: string,
  warnings: TemplateWarning[],
): UnsupportedObservation[] {
  const detailed = array(input);
  const fallback = detailed.length ? detailed : array(oldParts).map((part) => ({ kind: 'unknown', part, reason: '' }));
  if (!detailed.length && array(oldParts).length) {
    warnings.push(warning('UNSUPPORTED_DETAIL_UNKNOWN', 'Inspector reported unsupported parts without structured reasons.', null, null, oldParts));
  }
  return fallback.filter(isRecord).map((item, index) => {
    const part = validPart(item.part) ?? 'unknown/part';
    return {
      id: stableId('unsupported', sourceHash, `${part}\0${index}\0${String(item.kind ?? '')}`),
      kind: stringOr(item.kind, 'unknown'),
      part,
      reason: stringOr(item.reason, ''),
      slide: typeof item.slide === 'string' || Number.isSafeInteger(item.slide) ? item.slide as string | number : null,
      element: typeof item.element === 'string' || Number.isSafeInteger(item.element) ? item.element as string | number : null,
      relationshipId: nullableString(item.relationship_id ?? item.relationshipId),
      target: nullableString(item.target),
    };
  });
}

function validateSource(source: TemplateSource): TemplateSource {
  if (!source || typeof source.filePath !== 'string' || !source.filePath || typeof source.originalName !== 'string' || !source.originalName
      || !/^[a-f0-9]{64}$/.test(source.sha256) || typeof source.compiledAt !== 'string' || !source.compiledAt
      || typeof source.compilerVersion !== 'string' || !source.compilerVersion) {
    throw new TypeError('Invalid TemplateIR source metadata');
  }
  return { ...source };
}

/**
 * Deterministically maps private parser evidence to TemplateIR v1. Missing
 * source facts stay null/empty and are accompanied by warnings; this function
 * does not infer semantic layout names or resolve style cascades.
 */
export function createTemplateIR(inspection: InspectionEnvelope, inputSource: TemplateSource): TemplateIR {
  const source = validateSource(inputSource);
  const envelope = inspection as unknown as RecordLike;
  const payload = isRecord(envelope.inspection) ? envelope.inspection as InspectionLike : {};
  const warnings: TemplateWarning[] = [];
  if (!isRecord(envelope.inspection)) warnings.push(warning('INSPECTION_UNKNOWN', 'Inspector envelope omitted inspection observations.', null, null, envelope));
  const sourceHashPrefix = source.sha256.slice(0, HASH_PREFIX_LENGTH);

  const masterInputs = array(payload.masters).filter(isRecord);
  const layoutInputs = array(payload.layouts).filter(isRecord);
  const slideInputs = array(payload.slides).filter(isRecord);
  const masterPartByInput = new Map(masterInputs.map((item) => [validPart(item.part) ?? '', item]));
  const layoutPartByInput = new Map(layoutInputs.map((item) => [validPart(item.part) ?? '', item]));

  const masters: TemplateMaster[] = masterInputs.map((item, index) => {
    const sourcePart = validPart(item.part) ?? `unknown/masters/${index}`;
    const built = makeElements(sourcePart, source.sha256, item.elements, item.designElements);
    if (typeof item.declaredName !== 'string') warnings.push(warning('MASTER_NAME_UNKNOWN', 'Master name was not reported.', sourcePart, null));
    if (!Array.isArray(item.layoutParts)) warnings.push(warning('MASTER_LAYOUTS_UNKNOWN', 'Master layout part inventory was not reported.', sourcePart, null));
    const layoutIds = array(item.layoutParts).map((part) => {
      const targetPart = validPart(part);
      if (!targetPart || !layoutPartByInput.has(targetPart)) {
        warnings.push(warning('MASTER_LAYOUT_REFERENCE_UNKNOWN', 'Master referenced a layout part absent from the parser inventory.', sourcePart, null, part));
        return null;
      }
      return stableId('layout', source.sha256, targetPart);
    }).filter((id): id is string => id !== null);
    if (!Array.isArray(item.relationships)) warnings.push(warning('RELATIONSHIPS_UNKNOWN', 'Master relationship observations were not reported.', sourcePart, null, null));
    if (!Array.isArray(item.designElements)) warnings.push(warning('DESIGN_ELEMENTS_UNKNOWN', 'Master design-element observations were not reported.', sourcePart, null, null));
    warnings.push(...built.warnings);
    return {
      id: stableId('master', source.sha256, sourcePart),
      sourcePart,
      declaredName: nullableString(item.declaredName),
      layoutIds,
      relationships: mergeRelationships(groupRelationships(sourcePart, source.sha256, item.relationships), built.relationships),
      background: mapBackground(item.background, sourcePart, warnings),
      colorMapping: mapColorMapping(item.colorMapping, sourcePart, warnings),
      elements: built.elements,
      designElementIds: built.designElementIds,
      warnings: groupWarnings(item.warnings, sourcePart),
    };
  });

  const layouts: TemplateLayout[] = layoutInputs.map((item, index) => {
    const sourcePart = validPart(item.part) ?? `unknown/layouts/${index}`;
    const masterPart = validPart(item.masterPart);
    const masterId = masterPart && masterPartByInput.has(masterPart) ? stableId('master', source.sha256, masterPart) : null;
    if (masterPart && masterId === null) warnings.push(warning('LAYOUT_MASTER_REFERENCE_UNKNOWN', 'Layout referenced a master part absent from the parser inventory.', sourcePart, null, masterPart));
    const built = makeElements(sourcePart, source.sha256, item.elements, item.designElements);
    if (typeof item.declaredName !== 'string') warnings.push(warning('LAYOUT_NAME_UNKNOWN', 'Layout name was not reported.', sourcePart, null));
    if (!Array.isArray(item.relationships)) warnings.push(warning('RELATIONSHIPS_UNKNOWN', 'Layout relationship observations were not reported.', sourcePart, null, null));
    if (!Array.isArray(item.designElements)) warnings.push(warning('DESIGN_ELEMENTS_UNKNOWN', 'Layout design-element observations were not reported.', sourcePart, null, null));
    warnings.push(...built.warnings);
    return {
      id: stableId('layout', source.sha256, sourcePart),
      sourcePart,
      masterId,
      declaredName: nullableString(item.declaredName),
      declaredType: typeof item.declaredType === 'string' ? item.declaredType : Number.isSafeInteger(item.declaredType) ? String(item.declaredType) : null,
      matchingName: nullableString(item.matchingName),
      preserve: typeof item.preserve === 'boolean' ? item.preserve : null,
      relationships: mergeRelationships(groupRelationships(sourcePart, source.sha256, item.relationships), built.relationships),
      background: mapBackground(item.background, sourcePart, warnings),
      colorMapping: mapColorMapping(item.colorMapping, sourcePart, warnings),
      elements: built.elements,
      designElementIds: built.designElementIds,
      warnings: groupWarnings(item.warnings, sourcePart),
    };
  });

  const slides: TemplateSlide[] = slideInputs.map((item, index) => {
    const sourcePart = validPart(item.part) ?? `unknown/slides/${index}`;
    const layoutPart = validPart(item.layoutPart);
    const masterPart = validPart(item.masterPart);
    const layoutId = layoutPart && layoutPartByInput.has(layoutPart) ? stableId('layout', source.sha256, layoutPart) : null;
    const masterId = masterPart && masterPartByInput.has(masterPart) ? stableId('master', source.sha256, masterPart) : null;
    if (layoutPart && layoutId === null) warnings.push(warning('SLIDE_LAYOUT_REFERENCE_UNKNOWN', 'Slide referenced a layout part absent from the parser inventory.', sourcePart, null, layoutPart));
    if (masterPart && masterId === null) warnings.push(warning('SLIDE_MASTER_REFERENCE_UNKNOWN', 'Slide referenced a master part absent from the parser inventory.', sourcePart, null, masterPart));
    // The private inspector repeats layout/master design objects per slide for
    // comparison. Their canonical owners are the separately inventoried parts.
    const built = makeElements(sourcePart, source.sha256, item.elements, []);
    if (item.layoutPart === null || item.layoutPart === undefined) warnings.push(warning('SLIDE_LAYOUT_UNKNOWN', 'Slide layout part was not reported.', sourcePart, null));
    if (!Array.isArray(item.relationships)) warnings.push(warning('RELATIONSHIPS_UNKNOWN', 'Slide relationship observations were not reported.', sourcePart, null, null));
    warnings.push(...built.warnings);
    return {
      id: stableId('slide', source.sha256, sourcePart),
      index: Number.isSafeInteger(item.index) && (item.index as number) > 0 ? item.index as number : index + 1,
      sourcePart,
      layoutId,
      masterId,
      relationships: mergeRelationships(groupRelationships(sourcePart, source.sha256, item.relationships), built.relationships),
      elements: built.elements,
      background: mapBackground(item.background, sourcePart, warnings),
      designElementIds: built.designElementIds,
      warnings: groupWarnings(item.warnings, sourcePart),
    };
  });

  const allRelationships = [
    ...masters.flatMap((master) => master.relationships),
    ...layouts.flatMap((layout) => layout.relationships),
    ...slides.flatMap((slide) => slide.relationships),
  ];
  const mediaParts = array(payload.mediaParts).map(validPart).filter((part): part is string => part !== null);
  if (!Array.isArray(payload.mediaParts)) warnings.push(warning('MEDIA_INVENTORY_UNKNOWN', 'Exact media part inventory was not reported.', null, null, null));
  const assets: TemplateAsset[] = [...new Set(mediaParts)].map((part) => ({
    id: stableId('asset', source.sha256, part),
    part,
      relationshipIds: [...new Set(allRelationships.filter((relationship) => relationship.mode === 'internal' && relationship.targetPart === part)
      .map((relationship) => relationship.id))].sort(),
    contentType: null,
    kind: 'media',
  }));
  for (const part of mediaParts) {
    if (!assets.find((asset) => asset.part === part)?.relationshipIds.length) {
      warnings.push(warning('MEDIA_RELATIONSHIP_UNKNOWN', 'Media part was inventoried without a matching internal relationship observation.', part, null, part));
    }
  }

  const theme = mapTheme(payload.theme, warnings);
  const notesParts = array(payload.notesParts).map(validPart).filter((part): part is string => part !== null).sort();
  if (!Array.isArray(payload.notesParts)) warnings.push(warning('NOTES_INVENTORY_UNKNOWN', 'Exact notes part inventory was not reported.', null, null, null));
  const unsupported = unsupportedObservations(payload.unsupportedDetails, payload.unsupportedParts, source.sha256, warnings);
  if (!Array.isArray(payload.parserWarnings)) warnings.push(warning('PARSER_WARNINGS_UNKNOWN', 'Parser warning observations were not reported.', null, null, null));
  warnings.push(...mapWarnings(payload.parserWarnings, null, null));

  const slideSizeRaw = isRecord(payload.slideSize) ? payload.slideSize : {};
  const slideSize = {
    width: Number.isSafeInteger(slideSizeRaw.width) ? slideSizeRaw.width as number : 0,
    height: Number.isSafeInteger(slideSizeRaw.height) ? slideSizeRaw.height as number : 0,
    unit: 'EMU' as const,
  };
  if (slideSize.width <= 0 || slideSize.height <= 0) warnings.push(warning('SLIDE_SIZE_UNKNOWN', 'Positive EMU slide dimensions were not reported.', null, null, payload.slideSize ?? null));

  const noDuplicateRelationshipIds = new Set<string>();
  const uniqueRelationships = allRelationships.filter((relation) => {
    if (noDuplicateRelationshipIds.has(relation.id)) return false;
    noDuplicateRelationshipIds.add(relation.id);
    return true;
  });
  if (uniqueRelationships.length !== allRelationships.length) warnings.push(warning('DUPLICATE_RELATIONSHIP_OBSERVATION', 'Duplicate relationship observations were de-duplicated by stable source identity.', null, null, null));

  const templateIR: Omit<TemplateIR, 'hash'> & { hash?: string } = {
    id: `tir_${sourceHashPrefix}`,
    schemaVersion: 1,
    source,
    slideSize,
    masters,
    layouts,
    slides,
    theme,
    notesParts: [...new Set(notesParts)],
    assets,
    unsupported,
    warnings,
  };
  templateIR.hash = sha256Json(templateIRHashPayload(templateIR as TemplateIR));
  return validateTemplateIR(templateIR);
}

function allElements(templateIR: TemplateIR): TemplateElement[] {
  return [
    ...templateIR.masters.flatMap((master) => master.elements),
    ...templateIR.layouts.flatMap((layout) => layout.elements),
    ...templateIR.slides.flatMap((slide) => slide.elements),
  ];
}

function styleStringList(style: DirectElementStyles): string[] {
  return style.fonts ?? [];
}

function styleNumberList(style: DirectElementStyles): number[] {
  return style.fontSizesPt ?? [];
}

/** Derives only observed direct/theme facts and structural counts; no semantic labels are inferred. */
export function derivePresentationDesignSystem(templateIR: TemplateIR): PresentationDesignSystem {
  const ir = validateTemplateIR(templateIR);
  const elements = allElements(ir);
  const typographyDirect = elements.flatMap((element) => {
    const fonts = styleStringList(element.directStyles);
    const fontSizesPt = styleNumberList(element.directStyles);
    return fonts.length || fontSizesPt.length ? [{ elementId: element.id, fonts, fontSizesPt }] : [];
  });
  const fontNames = [...new Set(typographyDirect.flatMap((entry) => entry.fonts))].sort();
  const fontSizes = [...new Set(typographyDirect.flatMap((entry) => entry.fontSizesPt))].sort((a, b) => a - b);
  const colorUses = new Map<string, { role: 'fill' | 'line'; value: string; elementIds: string[] }>();
  for (const element of elements) {
    for (const [role, value] of [['fill', element.directStyles.fillColor], ['line', element.directStyles.lineColor]] as const) {
      if (value === null) continue;
      const key = JSON.stringify([role, value]);
      const observation = colorUses.get(key) ?? { role, value, elementIds: [] };
      if (!observation.elementIds.includes(element.id)) observation.elementIds.push(element.id);
      colorUses.set(key, observation);
    }
  }
  const colorsDirect = [...colorUses.values()]
    .map((entry) => ({ ...entry, uses: entry.elementIds.length }))
    .sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : left.value < right.value ? -1 : left.value > right.value ? 1 : 0);
  const layouts = ir.layouts.map((layout) => {
    const byKind: Record<string, number> = {};
    for (const element of layout.elements) byKind[element.kind] = (byKind[element.kind] ?? 0) + 1;
    const placeholderRoles = [...new Set(layout.elements.flatMap((element) => {
      const type = element.placeholder?.type;
      const role = element.placeholder?.role;
      return type ? [type] : role ? [role] : [];
    }))].sort();
    return {
      id: layout.id,
      sourcePart: layout.sourcePart,
      declaredName: layout.declaredName,
      declaredType: layout.declaredType,
      matchingName: layout.matchingName,
      placeholderRoles,
      elementCounts: { total: layout.elements.length, byKind },
      usageCount: ir.slides.filter((slide) => slide.layoutId === layout.id).length,
      relationshipIds: layout.relationships.map((relationship) => relationship.id).sort(),
    };
  });
  const theme = ir.theme;
  const colors = {
    direct: colorsDirect,
    theme: theme ? Object.entries(theme.colors).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, value]) => ({ name, value })) : [],
  };
  const templateIRHash = ir.hash;
  const designSystem: Omit<PresentationDesignSystem, 'hash'> & { hash?: string } = {
    id: `pds_${templateIRHash.slice(0, HASH_PREFIX_LENGTH)}`,
    schemaVersion: 1,
    templateIRId: ir.id,
    templateIRHash,
    canvas: {
      width: ir.slideSize.width,
      height: ir.slideSize.height,
      unit: 'EMU',
      aspectRatio: ir.slideSize.width / ir.slideSize.height,
    },
    typography: {
      direct: typographyDirect,
      observedFonts: fontNames,
      observedSizesPt: fontSizes,
      theme: { major: theme?.fonts.major ?? null, minor: theme?.fonts.minor ?? null },
    },
    colors,
    layouts,
    assets: ir.assets.map((asset) => ({ id: asset.id, part: asset.part, relationshipIds: [...asset.relationshipIds] })),
    warnings: [...ir.warnings],
  };
  designSystem.hash = sha256Json(presentationDesignSystemHashPayload(designSystem as PresentationDesignSystem));
  return validatePresentationDesignSystem(designSystem, ir);
}
