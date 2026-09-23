import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const {
  createTemplateIR,
  derivePresentationDesignSystem,
  validatePresentationDesignSystem,
  validateTemplateIR,
} = await import('../src/presentation/application/template-mapper.ts');
const {
  presentationDesignSystemHashPayload,
  sha256Json,
  templateIRHashPayload,
} = await import('../src/presentation/domain/template-ir.ts');

const SOURCE_SHA = '0123456789abcdef'.repeat(4);
const PPT_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PARTS = {
  master: 'ppt/slideMasters/slideMaster1.xml',
  layout: 'ppt/slideLayouts/slideLayout1.xml',
  slide: 'ppt/slides/slide1.xml',
  media: 'ppt/media/image1.png',
};

function source(overrides = {}) {
  return {
    filePath: 'slides/презентация deck.pptx',
    originalName: 'презентация deck.pptx',
    sha256: SOURCE_SHA,
    compiledAt: '2026-09-23T12:00:00.000Z',
    compilerVersion: 'lct-template-compiler/1',
    ...overrides,
  };
}

function makeObservation() {
  const layoutRelation = {
    id: 'rIdLayout', type: `${PPT_NS}/slideLayout`, target: '../slideLayouts/slideLayout1.xml',
    targetPart: PARTS.layout, mode: 'internal',
  };
  const masterRelation = {
    id: 'rIdMaster', type: `${PPT_NS}/slideMaster`, target: '../slideMasters/slideMaster1.xml',
    targetPart: PARTS.master, mode: 'internal',
  };
  const imageRelation = {
    id: 'rIdImage', type: `${PPT_NS}/image`, target: '../media/image1.png',
    targetPart: PARTS.media, mode: 'internal',
  };
  const titleShape = {
    type: 'shape', name: 'Title 1', elementId: '2', sourceOrder: 0, parentId: null,
    text: '  Quarterly revenue grew 18%  ', placeholderRole: 'title',
    placeholderIdentity: { idx: '1', type: 'title', slideIndex: 1 },
    rawGeometry: { x: 10, y: 20, width: 300, height: 40, rotation: 0, unit: 'EMU' },
    resolvedGeometry: { x: 12, y: 22, width: 300, height: 40, rotation: 0, unit: 'EMU' },
    geometryProvenance: 'direct-shape-transform',
    style: { fonts: ['Aptos'], font_sizes_pt: [32], bold: true, fill_color: '112233' },
    relationship: null, sourcePart: PARTS.slide, warnings: [],
  };
  const picture = {
    type: 'picture', name: 'Chart image', elementId: '7', sourceOrder: 1, parentId: null,
    text: '', placeholderRole: null, placeholderIdentity: null, rawGeometry: null,
    resolvedGeometry: null, geometryProvenance: 'unknown', style: { line_color: '445566' },
    relationship: imageRelation, sourcePart: PARTS.slide, warnings: ['alt text absent'],
  };
  return {
    protocolVersion: 1,
    schemaStatus: 'REPLACEABLE/PROVISIONAL',
    inspectionMs: 3.4,
    inspection: {
      schemaStatus: 'REPLACEABLE/PROVISIONAL',
      slideSize: { width: 12192000, height: 6858000, unit: 'EMU' },
      slides: [{
        index: 1, part: PARTS.slide, layoutPart: PARTS.layout, masterPart: PARTS.master,
        elements: [titleShape, picture], designElements: [], warnings: [],
        relationships: [masterRelation, layoutRelation, imageRelation],
        background: {
          kind: 'explicit', element: 'solidFill',
          fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'schemeClr', attributes: { val: 'accent1' }, position: null }], relationship: null },
        },
      }],
      masters: [{
        part: PARTS.master, layoutParts: [PARTS.layout], declaredName: 'Master 1', elements: [], designElements: [],
        relationships: [{ id: 'rIdTheme', type: `${PPT_NS}/theme`, target: '../theme/theme1.xml', targetPart: 'ppt/theme/theme1.xml', mode: 'internal' }],
        background: {
          kind: 'explicit', element: 'solidFill',
          fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'srgbClr', attributes: { val: 'FFFFFF' }, position: null }], relationship: null },
        },
        colorMapping: { master_mapping: { accent1: 'accent2' }, layout_override: [] },
        warnings: [],
      }],
      layouts: [{
        part: PARTS.layout, masterPart: PARTS.master, declaredName: 'Title and Content', declaredType: 'obj',
        matchingName: 'Title and Content', preserve: true,
        elements: [titleShape], designElements: [titleShape], relationships: [masterRelation],
        background: { kind: 'bgRef', idx: '1001', scheme_color: 'bg1', scheme_color_type: 'schemeClr', fill: null },
        colorMapping: { master_mapping: null, layout_override: [{ element: 'overrideClrMapping', attributes: { accent1: 'accent2' } }] },
        warnings: [],
      }],
      theme: { part: 'ppt/theme/theme1.xml', colors: { accent1: '0066CC', dk1: '000000' }, fonts: { major: 'Aptos Display', minor: 'Aptos' } },
      notesParts: ['ppt/notesSlides/notesSlide1.xml', 'ppt/notesMasters/notesMaster1.xml'],
      mediaParts: [PARTS.media],
      unsupportedParts: [],
      unsupportedDetails: [{ kind: 'custom-xml', part: 'ppt/customXml/item1.xml', reason: 'Not parsed', slide: 1, element: 4, relationship_id: 'rId9', target: '../customXml/item1.xml' }],
      parserWarnings: ['master transform was not interpreted'],
    },
  };
}

function map(observation = makeObservation(), metadata = source()) {
  return createTemplateIR(observation, metadata);
}

test('maps deterministic TemplateIR and separate PDS without persisting private inspector DTOs', () => {
  const observation = makeObservation();
  const ir = map(observation);
  const pds = derivePresentationDesignSystem(ir);

  assert.equal(ir.schemaVersion, 1);
  assert.equal(ir.id, `tir_${SOURCE_SHA.slice(0, 16)}`);
  assert.equal(ir.slides[0].layoutId, ir.layouts[0].id);
  assert.equal(ir.slides[0].masterId, ir.masters[0].id);
  assert.equal(ir.masters[0].layoutIds[0], ir.layouts[0].id);
  assert.equal(ir.layouts[0].masterId, ir.masters[0].id);
  assert.equal(ir.layouts[0].designElementIds.length, 1, 'design element references the canonical element instead of duplicating it');
  assert.equal(ir.slides[0].elements[0].text, '  Quarterly revenue grew 18%  ', 'source text whitespace is preserved');
  assert.deepEqual(ir.slides[0].elements[0].placeholder, { index: '1', type: 'title', role: 'title' });
  assert.deepEqual(ir.slides[0].elements[0].geometry, {
    direct: { x: 10, y: 20, width: 300, height: 40, rotation: 0, unit: 'EMU' },
    resolved: { x: 12, y: 22, width: 300, height: 40, rotation: 0, unit: 'EMU' },
    provenance: 'direct-shape-transform',
  });
  assert.equal(ir.slides[0].relationships.find((relation) => relation.nativeId === 'rIdImage').target, '../media/image1.png');
  assert.equal(ir.slides[0].relationships.find((relation) => relation.nativeId === 'rIdImage').targetPart, PARTS.media);
  assert.deepEqual(ir.assets[0].relationshipIds, [ir.slides[0].relationships.find((relation) => relation.nativeId === 'rIdImage').id]);
  assert.equal(ir.unsupported[0].reason, 'Not parsed');
  assert.equal(ir.unsupported[0].relationshipId, 'rId9');
  assert.deepEqual(ir.theme.fonts, { major: 'Aptos Display', minor: 'Aptos' });
  assert.deepEqual(ir.notesParts, ['ppt/notesMasters/notesMaster1.xml', 'ppt/notesSlides/notesSlide1.xml']);
  assert.deepEqual(ir.masters[0].background, {
    kind: 'explicit', element: 'solidFill',
    fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'srgbClr', attributes: { val: 'FFFFFF' }, position: null }], relationshipNativeId: null },
  });
  assert.deepEqual(ir.masters[0].colorMapping, { masterMapping: { accent1: 'accent2' }, layoutOverrides: [] });
  assert.deepEqual(ir.layouts[0].background, { kind: 'scheme_reference', index: '1001', schemeColor: 'bg1', schemeColorType: 'schemeClr' });
  assert.deepEqual(ir.slides[0].background, {
    kind: 'explicit', element: 'solidFill',
    fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'schemeClr', attributes: { val: 'accent1' }, position: null }], relationshipNativeId: null },
  });
  assert.deepEqual(ir.layouts[0].colorMapping, {
    masterMapping: null,
    layoutOverrides: [{ element: 'overrideClrMapping', attributes: { accent1: 'accent2' } }],
  });
  assert.deepEqual(ir.slides[0].designElementIds, [], 'per-slide copies of master/layout design elements are not reassigned to slides');
  assert.equal(pds.templateIRId, ir.id);
  assert.equal(pds.templateIRHash, ir.hash);
  assert.deepEqual(pds.typography.observedFonts, ['Aptos']);
  assert.deepEqual(pds.typography.observedSizesPt, [32]);
  assert.deepEqual(pds.colors.direct, [
    { role: 'fill', value: '112233', uses: 2, elementIds: [ir.layouts[0].elements[0].id, ir.slides[0].elements[0].id] },
    { role: 'line', value: '445566', uses: 1, elementIds: [ir.slides[0].elements[1].id] },
  ]);
  assert.equal(pds.layouts[0].usageCount, 1);
  assert.equal(pds.layouts[0].elementCounts.total, 1);
  assert.deepEqual(pds.layouts[0].placeholderRoles, ['title']);

  validateTemplateIR(ir);
  validatePresentationDesignSystem(pds, ir);
  const persisted = { ir, pds };
  const serialized = JSON.stringify(persisted);
  const persistedKeys = new Set();
  const visitKeys = (value) => {
    if (Array.isArray(value)) return value.forEach(visitKeys);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        persistedKeys.add(key);
        visitKeys(child);
      }
    }
  };
  visitKeys(persisted);
  for (const forbidden of [
    'protocolVersion', 'schemaStatus', 'inspectionMs', 'inspection', 'sourceOrder', 'placeholderIdentity',
    'effectiveGeometry', 'rawGeometry', 'resolvedGeometry', 'geometryProvenance', 'relationship', 'mediaParts',
    'unsupportedDetails', 'parserWarnings', 'style', 'raw',
  ]) {
    assert.equal(persistedKeys.has(forbidden), false, `private DTO field ${forbidden} must not be persisted`);
    assert.equal(serialized.includes(`"${forbidden}"`), false, `private DTO field ${forbidden} must not be serialized`);
  }
});

test('IDs and canonical hashes are deterministic and compiledAt does not affect content hashes', () => {
  const first = map();
  const second = map();
  const later = map(makeObservation(), source({ compiledAt: '2026-09-24T00:00:00.000Z' }));
  assert.equal(first.hash, second.hash);
  assert.equal(first.slides[0].id, second.slides[0].id);
  assert.deepEqual(first.slides[0].elements.map((element) => element.id), second.slides[0].elements.map((element) => element.id));
  assert.equal(first.hash, later.hash);
  assert.equal(first.source.compiledAt, '2026-09-23T12:00:00.000Z');
  assert.equal(later.source.compiledAt, '2026-09-24T00:00:00.000Z');
  assert.equal(sha256Json(templateIRHashPayload(first)), first.hash);
  const pds = derivePresentationDesignSystem(first);
  assert.equal(sha256Json(presentationDesignSystemHashPayload(pds)), pds.hash);
  assert.equal(pds.id, `pds_${first.hash.slice(0, 16)}`);
});

test('slide inventory cannot be overwritten by copied layout/master design observations', () => {
  const observation = makeObservation();
  observation.inspection.slides[0].designElements = [{
    ...observation.inspection.layouts[0].designElements[0],
    text: 'copied layout text must not replace slide text',
    sourcePart: PARTS.layout,
  }];
  const ir = map(observation);
  assert.equal(ir.slides[0].elements.length, 2);
  assert.equal(ir.slides[0].elements[0].text, '  Quarterly revenue grew 18%  ');
  assert.equal(ir.layouts[0].elements[0].text, '  Quarterly revenue grew 18%  ');
  assert.equal(ir.layouts[0].elements[0].id, ir.layouts[0].designElementIds[0]);
});

test('unknown parser observations remain unknown with structured warnings', () => {
  const observation = makeObservation();
  observation.inspection.theme = null;
  observation.inspection.mediaParts = [];
  observation.inspection.slides[0].elements = [{
    type: 'shape', name: 'Text', elementId: null, sourceOrder: 0, parentId: null,
    placeholderRole: 'body', text: undefined, geometry: null, relationship: { id: 'rIdIncomplete' },
  }];
  observation.inspection.slides[0].relationships = [];
  const ir = map(observation);
  const element = ir.slides[0].elements[0];
  assert.equal(element.text, null);
  assert.equal(element.placeholder.index, null);
  assert.equal(element.placeholder.type, null);
  assert.equal(element.geometry.direct, null);
  assert.equal(element.geometry.resolved, null);
  assert.ok(element.warnings.some((item) => item.code === 'TEXT_UNKNOWN'));
  assert.ok(element.warnings.some((item) => item.code === 'GEOMETRY_UNKNOWN'));
  assert.ok(element.warnings.some((item) => item.code === 'PLACEHOLDER_IDENTITY_UNKNOWN'));
  assert.ok(element.warnings.some((item) => item.code === 'RELATIONSHIP_UNKNOWN'));
  assert.ok(ir.warnings.some((item) => item.code === 'THEME_UNKNOWN'));
  assert.ok(ir.warnings.some((item) => item.code === 'MEDIA_RELATIONSHIP_UNKNOWN') === false);
});

test('runtime validators reject broken internal references and unsupported schema fields', () => {
  const ir = map();
  const badReference = structuredClone(ir);
  badReference.slides[0].layoutId = 'layout_missing';
  badReference.hash = sha256Json(templateIRHashPayload(badReference));
  assert.throws(() => validateTemplateIR(badReference), /slide layout reference/);

  const badBackgroundReference = structuredClone(ir);
  badBackgroundReference.slides[0].background.fill.relationshipNativeId = 'rIdMissing';
  badBackgroundReference.hash = sha256Json(templateIRHashPayload(badBackgroundReference));
  assert.throws(() => validateTemplateIR(badBackgroundReference), /background relationship reference/);

  const badEnvelope = structuredClone(ir);
  badEnvelope.privatePythonDto = { protocolVersion: 1 };
  assert.throws(() => validateTemplateIR(badEnvelope), /TemplateIR fields/);

  const badPds = structuredClone(derivePresentationDesignSystem(ir));
  badPds.assets[0].relationshipIds = ['relation_missing'];
  badPds.hash = sha256Json(presentationDesignSystemHashPayload(badPds));
  assert.throws(() => validatePresentationDesignSystem(badPds, ir), /asset relationship reference/);
});
