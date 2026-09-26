import { readVerifiedImageAt } from './office-kit-pptx-renderer.js';
import type { ContentIR } from '../domain/content-ir.js';
import type { PresentationDesignSystem, TemplateIR } from '../domain/template-ir.js';
import type { CompiledPresentation, CompiledSlide } from '../application/slide-compilation.js';

const MAX_HTML_BYTES = 64 * 1024 * 1024;

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function cssColor(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/^#/, '');
  return normalized && /^[a-f0-9]{6}$/i.test(normalized) ? `#${normalized.toLowerCase()}` : fallback;
}

function cssFont(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/[^\w .-]/g, '').trim();
  return normalized ? `"${normalized}", Arial, sans-serif` : fallback;
}

function effectiveBackground(slide: CompiledSlide, template: TemplateIR, palette: Array<{ name: string; value: string }>): string {
  const layout = template.layouts.find((candidate) => candidate.id === slide.layoutId);
  const master = template.masters.find((candidate) => candidate.id === layout?.masterId);
  for (const background of [layout?.background, master?.background]) {
    if (!background || background.kind !== 'explicit' || !background.fill) continue;
    for (const color of background.fill.colors) {
      const value = color.type === 'srgbClr' ? color.attributes.val
        : color.type === 'sysClr' ? color.attributes.lastClr
          : color.type === 'schemeClr' ? palette.find((item) => item.name.toLowerCase() === color.attributes.val?.toLowerCase())?.value
            : undefined;
      const normalized = value?.replace(/^#/, '');
      if (normalized && /^[a-f0-9]{6}$/i.test(normalized)) return `#${normalized}`;
    }
  }
  return '#ffffff';
}

function contrastingThemeText(background: string, palette: Array<{ name: string; value: string }>): string {
  const hex = background.replace(/^#/, '');
  const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const luminance = channels.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const key = luminance < 0.42 ? 'lt1' : 'dk1';
  const themeValue = palette.find((item) => item.name.toLowerCase() === key)?.value;
  return cssColor(themeValue, luminance < 0.42 ? '#ffffff' : '#17212b');
}

function cssBox(box: CompiledSlide['placements']['title'], canvas: TemplateIR['slideSize']): string {
  const pct = (value: number, base: number) => `${Number((value / base * 100).toFixed(4))}%`;
  return `left:${pct(box.x, canvas.width)};top:${pct(box.y, canvas.height)};width:${pct(box.width, canvas.width)};height:${pct(box.height, canvas.height)}`;
}

function contentLanguage(contentIR: ContentIR): 'ru' | 'en' {
  const text = contentIR.units.map((unit) => unit.text ?? unit.cellValue ?? '').join(' ').slice(0, 30_000);
  const cyrillic = (text.match(/[\u0400-\u04ff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cyrillic >= latin ? 'ru' : 'en';
}

function visualMarkup(slide: CompiledSlide): string {
  const visual = slide.visualization;
  if (visual.tableData) {
    const [header, ...rows] = visual.tableData;
    const headings = header ?? [];
    return `<table class="data-table"><thead><tr>${headings.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  if (visual.chartData) {
    const chart = visual.chartData;
    const caption = [chart.title, chart.unit].filter(Boolean).join(' · ');
    const maxValue = Math.max(1, ...chart.series.flatMap((series) => series.values.map((value) => Math.abs(value))));
    const bars = `<div class="chart-bars" role="img" aria-label="${escapeHtml(caption || 'Диаграмма')}" >${chart.categories.map((category, categoryIndex) => `<div class="chart-category"><span class="chart-category-label">${escapeHtml(category)}</span><div class="chart-category-bars">${chart.series.map((series, seriesIndex) => {
      const value = series.values[categoryIndex] ?? 0;
      const barColor = `var(--accent-${(seriesIndex % 6) + 1},var(--accent))`;
      const height = Math.max(value === 0 ? 0 : 4, Math.abs(value) / maxValue * 84);
      return `<div class="chart-bar-column" style="--bar-color:${barColor}"><div class="chart-bar" style="height:${height.toFixed(2)}%"><span>${escapeHtml(String(value))}</span></div></div>`;
    }).join('')}</div></div>`).join('')}</div>`;
    return `<figure class="chart-figure"><figcaption>${escapeHtml(caption || 'Диаграмма')}</figcaption>${bars}<table class="chart-table"><thead><tr><th scope="col">Ряд данных</th>${chart.categories.map((category) => `<th scope="col">${escapeHtml(category)}</th>`).join('')}</tr></thead><tbody>${chart.series.map((series) => `<tr><th scope="row"><span class="series-mark"></span>${escapeHtml(series.name)}</th>${series.values.map((value) => `<td>${escapeHtml(String(value))}</td>`).join('')}</tr>`).join('')}</tbody></table></figure>`;
  }
  if (visual.kpi) return `<div class="kpi"><span>${escapeHtml(visual.kpi.label)}</span><strong>${escapeHtml(visual.kpi.value)}</strong></div>`;
  if (visual.processSteps.length) return `<ol class="process">${visual.processSteps.map((step) => `<li>${escapeHtml(step.text)}</li>`).join('')}</ol>`;
  return '';
}

/** Semantic, self-contained HTML deck export; layout and styles are derived from the compiled slide/template IR. */
export class SemanticHtmlExportAdapter {
  async export(input: {
    compiledPresentation: CompiledPresentation;
    contentIR: ContentIR;
    templateIR: TemplateIR;
    designSystem?: PresentationDesignSystem;
    contentRoot: string;
  }): Promise<Buffer> {
    const { compiledPresentation, contentIR, templateIR, designSystem } = input;
    if (!compiledPresentation.slides.length || templateIR.slideSize.width <= 0 || templateIR.slideSize.height <= 0) {
      throw new TypeError('HTML export requires a non-empty compiled presentation and valid template canvas');
    }
    const colors = designSystem?.colors.theme ?? [];
    const color = (names: string[], fallback: string) => cssColor(colors.find((item) => names.includes(item.name.toLowerCase()))?.value, fallback);
    const ink = color(['dk1', 'tx1', 'dark1', 'text1'], '#17212b');
    const accent = color(['accent1', 'accent2'], '#2864dc');
    const soft = color(['lt2', 'accent6'], '#edf2fa');
    const observedSizes = (designSystem?.typography.observedSizesPt ?? []).filter((size) => Number.isFinite(size) && size > 0).sort((a, b) => a - b);
    const titlePt = Math.max(20, Math.min(36, observedSizes.at(-1) ?? 27));
    const bodyPt = Math.max(12, Math.min(20, observedSizes[Math.floor(observedSizes.length / 2)] ?? 16));
    const majorFont = cssFont(designSystem?.typography.theme.major, 'Arial, sans-serif');
    const minorFont = cssFont(designSystem?.typography.theme.minor, 'Arial, sans-serif');
    const imageByHash = new Map<string, { cssVariable: string; cssValue: string }>();
    const imageCss: string[] = [];
    let uniqueImageBytes = 0;
    const sections: string[] = [];
    for (const [index, slide] of compiledPresentation.slides.entries()) {
      const titleBox = cssBox(slide.placements.title, templateIR.slideSize);
      const bodyBox = cssBox(slide.placements.body, templateIR.slideSize);
      const slideBackground = effectiveBackground(slide, templateIR, colors);
      const slideForeground = contrastingThemeText(slideBackground, colors);
      const body = slide.body.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
      let visual = visualMarkup(slide);
      if (!visual && slide.imageRefs.length && slide.placements.visual) {
        const image = slide.imageRefs[0]!;
        let asset = imageByHash.get(image.sha256);
        if (!asset) {
          const bytes = await readVerifiedImageAt(input.contentRoot, image);
          uniqueImageBytes += bytes.byteLength;
          if (uniqueImageBytes > MAX_HTML_BYTES) throw new RangeError('Embedded source images exceed the HTML export limit');
          const cssVariable = `--asset-${image.sha256.slice(0, 16)}`;
          asset = { cssVariable, cssValue: `url("data:${image.mediaType};base64,${Buffer.from(bytes).toString('base64')}")` };
          imageByHash.set(image.sha256, asset);
          imageCss.push(`${cssVariable}:${asset.cssValue}`);
        }
        visual = `<div class="source-image" role="img" aria-label="Иллюстрация из исходных материалов" style="background-image:var(${asset.cssVariable})"></div>`;
      }
      const visualBox = slide.placements.visual && visual ? cssBox(slide.placements.visual, templateIR.slideSize) : null;
      sections.push(`<section class="slide" style="--slide-background:${slideBackground};--slide-foreground:${slideForeground}" aria-label="Слайд ${index + 1}: ${escapeHtml(slide.title)}" data-slide-id="${escapeHtml(slide.sourceDeckPlanSlideId)}">
  <h1 class="slide-title" style="${titleBox}">${escapeHtml(slide.title)}</h1>
  <div class="slide-copy" style="${bodyBox}">${body}</div>
  ${visual && visualBox ? `<div class="slide-visual" style="${visualBox}">${visual}</div>` : ''}
</section>`);
    }
    const html = `<!doctype html>
<html lang="${contentLanguage(contentIR)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(compiledPresentation.slides[0]!.title)}</title>
<style>
:root{--ink:${ink};--accent:${accent};--soft:${soft};--title-font:${majorFont};--body-font:${minorFont};--title-size:${titlePt}pt;--body-size:${bodyPt}pt;--canvas-ratio:${(templateIR.slideSize.width / templateIR.slideSize.height).toFixed(6)}}
:root{--ink:${ink};--accent:${accent};--accent-1:${accent};--accent-2:${color(['accent2'], accent)};--accent-3:${color(['accent3'], accent)};--accent-4:${color(['accent4'], accent)};--accent-5:${color(['accent5'], accent)};--accent-6:${color(['accent6'], accent)};--soft:${soft};--title-font:${majorFont};--body-font:${minorFont};--title-size:${titlePt}pt;--body-size:${bodyPt}pt;--canvas-ratio:${(templateIR.slideSize.width / templateIR.slideSize.height).toFixed(6)};${imageCss.join(';')}}
*{box-sizing:border-box}body{margin:0;padding:2rem;background:#e9edf3;color:var(--ink);font-family:var(--body-font)}main{display:grid;gap:2rem;justify-items:center}.slide{position:relative;overflow:hidden;width:min(96vw,1440px);aspect-ratio:var(--canvas-ratio);background:var(--slide-background,#fff);color:var(--slide-foreground,var(--ink));box-shadow:0 12px 40px #17212b22}.slide-title,.slide-copy,.slide-visual{position:absolute;margin:0;overflow:hidden}.slide-title{font-family:var(--title-font);font-size:clamp(18pt,var(--title-size),42pt);font-weight:700;line-height:1.12}.slide-copy{font-size:clamp(11pt,var(--body-size),22pt);line-height:1.38}.slide-copy p{margin:0 0 .65em}.slide-visual{display:flex;align-items:center;justify-content:center;overflow:auto}.data-table,.chart-table{width:100%;border-collapse:collapse;font-size:clamp(9pt,1.1vw,15pt)}.data-table th,.data-table td,.chart-table th,.chart-table td{padding:.45em .55em;border-bottom:1px solid #d9e0e9;text-align:left}.data-table thead,.chart-table thead{background:var(--soft)}.chart-figure{width:100%;margin:0}.chart-figure>figcaption{font-weight:700;margin-bottom:.35em}.chart-bars{display:flex;gap:.35em;align-items:stretch;min-height:42%;height:64%;padding:.5em .25em;border-bottom:1px solid var(--ink)}.chart-category{display:flex;flex:1;min-width:0;flex-direction:column;justify-content:end;gap:.25em;text-align:center;font-size:.72em}.chart-category-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chart-category-bars{display:flex;align-items:end;justify-content:center;gap:.12em;height:100%}.chart-bar-column{display:flex;align-items:end;height:100%;max-width:24%;flex:1}.chart-bar{display:flex;align-items:start;justify-content:center;width:100%;min-height:0;background:var(--bar-color,var(--accent));border-radius:.2em .2em 0 0;color:#fff;font-size:.65em;overflow:visible}.chart-bar span{transform:translateY(-1.4em);color:var(--ink);white-space:nowrap}.chart-table{margin-top:.5em;font-size:clamp(7pt,.8vw,11pt)}.series-mark{display:inline-block;width:.65em;height:.65em;margin-right:.35em;border-radius:50%;background:var(--accent)}.kpi{display:grid;gap:.15em;padding:.7em 1em;border-left:.3em solid var(--accent);background:var(--soft)}.kpi strong{font-size:clamp(24pt,4vw,54pt);line-height:1.05}.process{display:grid;gap:.4em;padding-left:1.5em}.process li::marker{color:var(--accent);font-weight:700}.source-image{width:100%;height:100%;background-position:center;background-repeat:no-repeat;background-size:contain} @media print{body{padding:0;background:#fff}main{display:block}.slide{width:100vw;height:100vh;aspect-ratio:auto;box-shadow:none;break-after:page}.slide:last-child{break-after:auto}}
</style></head><body><main>${sections.join('\n')}</main></body></html>`;
    const bytes = Buffer.from(html, 'utf8');
    if (bytes.byteLength > MAX_HTML_BYTES) throw new RangeError('HTML deck exceeds the 64 MiB export limit');
    return bytes;
  }
}
