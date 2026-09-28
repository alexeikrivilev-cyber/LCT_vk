export interface ProcessLayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessNodeLayout {
  axis: 'x' | 'y';
  nodes: ProcessLayoutBox[];
}

export interface ProcessTextMargins {
  left: number | null;
  right: number | null;
  top: number | null;
  bottom: number | null;
}

const EMU_PER_POINT = 12_700;
const NODE_TEXT_MARGIN_EMU = 45_720;

function estimatedLineCount(line: string, charactersPerLine: number): number | null {
  const words = line.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const wordLength = Array.from(word).length;
    // Do not count an over-wide word as if PowerPoint can split it at an
    // arbitrary character boundary. This path is deliberately fail-closed;
    // the caller can keep the text and downgrade the visual instead.
    if (wordLength > charactersPerLine) return null;
    if (used && used + 1 + wordLength > charactersPerLine) {
      lines += 1;
      used = wordLength;
    } else used += (used ? 1 : 0) + wordLength;
  }
  return lines;
}

function requiredTextHeight(text: string, width: number, fontPt: number, margins: ProcessTextMargins | null = null): number | null {
  const left = margins?.left ?? NODE_TEXT_MARGIN_EMU;
  const right = margins?.right ?? NODE_TEXT_MARGIN_EMU;
  const top = margins?.top ?? NODE_TEXT_MARGIN_EMU;
  const bottom = margins?.bottom ?? NODE_TEXT_MARGIN_EMU;
  const innerWidth = width - left - right;
  if (innerWidth <= 0 || fontPt <= 0) return null;
  const widthPt = innerWidth / EMU_PER_POINT;
  const charactersPerLine = widthPt / (fontPt * 0.58);
  if (charactersPerLine < 1) return null;
  let lines = 0;
  for (const line of text.split(/\r?\n/u)) {
    const wrapped = estimatedLineCount(line, charactersPerLine);
    if (wrapped === null) return null;
    lines += wrapped;
  }
  return Math.ceil(lines * fontPt * 1.2 * EMU_PER_POINT) + top + bottom;
}

/** Conservative word-aware fit for an existing native text region. */
export function fitsProcessLabel(box: ProcessLayoutBox, label: string, fontPt: number, margins: ProcessTextMargins | null = null): boolean {
  if (!label.trim() || box.width <= 0 || box.height <= 0 || !Number.isFinite(fontPt) || fontPt <= 0) return false;
  const required = requiredTextHeight(label, box.width, fontPt, margins);
  return required !== null && required <= box.height;
}

function horizontalLayout(box: ProcessLayoutBox, labels: readonly string[], fontPt: number): ProcessNodeLayout | null {
  const gap = Math.max(1, Math.round(box.width * 0.025));
  const width = Math.floor((box.width - gap * (labels.length - 1)) / labels.length);
  const heights = labels.map((label) => requiredTextHeight(label, width, fontPt));
  if (width <= 0 || heights.some((height) => height === null)) return null;
  const height = Math.max(...heights as number[]);
  if (height > box.height || width < height * 0.9) return null;
  const y = box.y + Math.floor((box.height - height) / 2);
  return {
    axis: 'x',
    nodes: labels.map((_label, index) => ({ x: box.x + index * (width + gap), y, width, height })),
  };
}

function verticalLayout(box: ProcessLayoutBox, labels: readonly string[], fontPt: number): ProcessNodeLayout | null {
  const width = Math.floor(box.width * 0.86);
  const gap = Math.max(1, Math.round(box.height * 0.025));
  const heights = labels.map((label) => requiredTextHeight(label, width, fontPt));
  if (width <= 0 || heights.some((height) => height === null)) return null;
  const height = Math.max(...heights as number[]);
  const totalHeight = labels.length * height + (labels.length - 1) * gap;
  if (height <= 0 || totalHeight > box.height || width < height * 1.1) return null;
  const x = box.x + Math.floor((box.width - width) / 2);
  const y = box.y + Math.floor((box.height - totalHeight) / 2);
  return {
    axis: 'y',
    nodes: labels.map((_label, index) => ({ x, y: y + index * (height + gap), width, height })),
  };
}

/** Fit editable process nodes inside measured template geometry without reducing template font size. */
export function fitProcessNodeLayout(
  box: ProcessLayoutBox,
  labels: readonly string[],
  fontPt: number,
): ProcessNodeLayout | null {
  if (labels.length < 2 || labels.length > 8 || labels.some((label) => !label.trim())
      || box.width <= 0 || box.height <= 0 || !Number.isFinite(fontPt) || fontPt <= 0) return null;
  const candidates = box.width / box.height >= 1.35
    ? [horizontalLayout(box, labels, fontPt), verticalLayout(box, labels, fontPt)]
    : [verticalLayout(box, labels, fontPt), horizontalLayout(box, labels, fontPt)];
  return candidates.find((candidate): candidate is ProcessNodeLayout => candidate !== null) ?? null;
}
