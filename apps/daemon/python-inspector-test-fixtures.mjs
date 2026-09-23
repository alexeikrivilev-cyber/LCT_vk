import JSZip from 'jszip';

const NS = {
  packageRel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  officeRel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const STRICT = {
  presentation: 'http://purl.oclc.org/ooxml/presentationml/main',
  drawing: 'http://purl.oclc.org/ooxml/drawingml/main',
  chart: 'http://purl.oclc.org/ooxml/drawingml/chart',
  officeRel: 'http://purl.oclc.org/ooxml/officeDocument/relationships',
};
const fixedDate = new Date('1980-01-01T00:00:00.000Z');

function crc32(value) {
  const bytes = Buffer.from(value);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function understateMemberSize(buffer, filename, declaredSize, declaredCrc) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error('Synthetic ZIP has no end-of-central-directory record');
  let entryOffset = buffer.readUInt32LE(endOffset + 16);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const wantedName = Buffer.from(filename, 'utf8');
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(entryOffset) !== 0x02014b50) throw new Error('Synthetic ZIP central directory is malformed');
    const nameLength = buffer.readUInt16LE(entryOffset + 28);
    const extraLength = buffer.readUInt16LE(entryOffset + 30);
    const commentLength = buffer.readUInt16LE(entryOffset + 32);
    const name = buffer.subarray(entryOffset + 46, entryOffset + 46 + nameLength);
    if (name.equals(wantedName)) {
      const localOffset = buffer.readUInt32LE(entryOffset + 42);
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Synthetic ZIP local header is malformed');
      buffer.writeUInt32LE(declaredCrc, entryOffset + 16);
      buffer.writeUInt32LE(declaredSize, entryOffset + 24);
      buffer.writeUInt32LE(declaredCrc, localOffset + 14);
      buffer.writeUInt32LE(declaredSize, localOffset + 22);
      return buffer;
    }
    entryOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Synthetic ZIP has no ${filename} member`);
}

function shape({ id, name, text, x, y, width, height }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

function slideXml(index, p, a, r) {
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shape({ id: index + 1, name: `Takeaway ${index}`, text: `Synthetic takeaway ${index}`, x: 914400, y: index * 914400, width: 5486400, height: 914400 })}</p:spTree></p:cSld></p:sld>`;
}

function layoutXml(p, a, layoutIndex) {
  return `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout xmlns:p="${p}" xmlns:a="${a}" type="title"><p:cSld name="Synthetic layout ${layoutIndex}"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shape({ id: 2, name: `Layout title ${layoutIndex}`, text: '', x: 457200, y: 228600, width: 6400800, height: 685800 })}</p:spTree></p:cSld></p:sldLayout>`;
}

function masterXml(p, a) {
  return `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld></p:sldMaster>`;
}

export async function makeSyntheticPptx({ strict = false, slideCount = 1, layoutCount = 2, brokenLayout = false, unsafeRelationship = false, unsupported = false, unsupportedCompressionMethod, forgedDeflateExpansionBytes = 0 } = {}) {
  const zip = new JSZip();
  const p = strict ? STRICT.presentation : NS.presentation;
  const a = strict ? STRICT.drawing : NS.drawing;
  const r = strict ? STRICT.officeRel : NS.officeRel;
  const masterRelNs = NS.packageRel;
  const slideIds = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join('');
  const presentationRels = [
    `<Relationship Id="rIdMaster" Type="${r}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    ...Array.from({ length: slideCount }, (_, i) => `<Relationship Id="rIdSlide${i + 1}" Type="${r}/slide" Target="slides/slide${i + 1}.xml"/>`),
  ].join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`, { date: fixedDate });
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="11704320" cy="6583680"/></p:presentation>`, { date: fixedDate });
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${masterRelNs}">${presentationRels}</Relationships>`, { date: fixedDate });
  zip.file('ppt/slideMasters/slideMaster1.xml', masterXml(p, a), { date: fixedDate });
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${masterRelNs}">${Array.from({ length: layoutCount }, (_, i) => `<Relationship Id="rIdLayout${i + 1}" Type="${r}/slideLayout" Target="../slideLayouts/slideLayout${i + 1}.xml"/>`).join('')}</Relationships>`, { date: fixedDate });
  for (let i = 1; i <= layoutCount; i += 1) {
    zip.file(`ppt/slideLayouts/slideLayout${i}.xml`, layoutXml(p, a, i), { date: fixedDate });
    zip.file(`ppt/slideLayouts/_rels/slideLayout${i}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="${masterRelNs}"><Relationship Id="rIdMaster" Type="${r}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`, { date: fixedDate });
  }
  for (let i = 1; i <= slideCount; i += 1) {
    const target = unsafeRelationship ? '../../../outside.xml' : brokenLayout ? '../slideLayouts/missing-layout.xml' : '../slideLayouts/slideLayout1.xml';
    const xml = slideXml(i, p, a, r);
    const contents = i === 1 ? `${xml}${' '.repeat(forgedDeflateExpansionBytes)}` : xml;
    zip.file(`ppt/slides/slide${i}.xml`, contents, { date: fixedDate });
    zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="${masterRelNs}"><Relationship Id="rIdLayout" Type="${r}/slideLayout" Target="${target}"/></Relationships>`, { date: fixedDate });
  }
  if (unsupported) zip.file('ppt/customXml/item1.xml', '<custom/>', { date: fixedDate });
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (unsupportedCompressionMethod !== undefined) {
    // Change ZIP method fields only. Inspection must reject these archives
    // before any member is opened or decompressed.
    const endOffset = output.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (endOffset < 0) throw new Error('Synthetic ZIP has no end-of-central-directory record');
    let entryOffset = output.readUInt32LE(endOffset + 16);
    const entryCount = output.readUInt16LE(endOffset + 10);
    for (let index = 0; index < entryCount; index += 1) {
      if (output.readUInt32LE(entryOffset) !== 0x02014b50) throw new Error('Synthetic ZIP central directory is malformed');
      const localOffset = output.readUInt32LE(entryOffset + 42);
      output.writeUInt16LE(unsupportedCompressionMethod, entryOffset + 10);
      if (output.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Synthetic ZIP local header is malformed');
      output.writeUInt16LE(unsupportedCompressionMethod, localOffset + 8);
      entryOffset += 46 + output.readUInt16LE(entryOffset + 28) + output.readUInt16LE(entryOffset + 30) + output.readUInt16LE(entryOffset + 32);
    }
  }
  if (forgedDeflateExpansionBytes > 0) {
    const prefix = Buffer.from(slideXml(1, p, a, r));
    understateMemberSize(output, 'ppt/slides/slide1.xml', prefix.length, crc32(prefix));
  }
  return output;
}
