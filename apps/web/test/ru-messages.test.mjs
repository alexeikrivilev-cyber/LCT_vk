import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { contentSourceStatusLabel } from '../src/content-source-status.ts';
import { auditFindingMessage, formatUiDateTime, friendlyErrorMessage, generationStatusLabel, planningStatusLabel, ru, slidePackStatusLabel, templateStatusLabel, variantStatusLabel } from '../src/i18n/ru.ts';

test('all persisted template, planning, generation, pack, and variant states have Russian labels', () => {
  const labels = [
    ru.template.analyzing,
    ...['uncompiled', 'ready', 'stale', 'failed', 'unknown'].map(templateStatusLabel),
    ...['ready', 'stale', 'failed', 'planning', 'generating', 'unconfigured', 'ready_for_planning', 'unknown', null].map(planningStatusLabel),
    ...['preparing', 'generating', 'completed', 'failed', 'cancelled', 'stale', 'unknown'].map(generationStatusLabel),
    ...['pending', 'rendering', 'ready', 'failed'].map((status) => slidePackStatusLabel(status)),
    slidePackStatusLabel('failed', 'VARIANTS_NOT_DISTINCT'),
    ...['pending', 'ready', 'failed'].map(variantStatusLabel),
    ru.status.locked,
    ...(['parsed', 'asset-only', 'unsupported', 'not-parsed']).map(contentSourceStatusLabel),
  ];
  assert.ok(labels.every((label) => /[А-Яа-яЁё]/u.test(label)));
  assert.equal(slidePackStatusLabel('failed', 'VARIANTS_NOT_DISTINCT'), 'Варианты не созданы');
});

test('all major failures have safe Russian copy and retryable outcomes stay actionable', () => {
  const cases = [
    ['LIMIT_FILE_SIZE', 413, 'upload'],
    ['UNSUPPORTED_FORMAT', 422, 'upload'],
    ['TEMPLATE_COMPILE_FAILED', 500, 'template'],
    ['DEADLINE_EXCEEDED', 504, 'planning'],
    ['PLANNING_INVALID', 422, 'planning'],
    ['VARIANTS_NOT_DISTINCT', 422, 'generation'],
    ['RENDER_FAILED', 500, 'generation'],
    ['EXPORT_FAILED', 500, 'export'],
    ['NOT_FOUND', 404, 'generic'],
    ['VERSION_CONFLICT', 409, 'generic'],
    ['INTERNAL_ERROR', 500, 'generic'],
  ];
  for (const [code, status, operation] of cases) {
    assert.match(friendlyErrorMessage(code, status, operation), /[А-Яа-яЁё]/u, `${code} must have Russian copy`);
  }
  assert.ok(ru.errors.template.includes('повтор'), 'template failure offers a safe retry');
  assert.ok(ru.errors.semantic.includes('повтор'), 'semantic failure offers a safe retry');
  assert.ok(ru.errors.export.includes('повтор'), 'export failure offers a safe retry');
});

test('customer-facing messages are centralized and known English labels do not leak into app chrome', () => {
  const uiSources = [
    '../src/App.tsx',
    '../src/content-source-status.ts',
    '../app/layout.tsx',
    '../app/[[...slug]]/client-app.tsx',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

  assert.doesNotMatch(uiSources, /[А-Яа-яЁё]/u, 'Russian copy belongs in the typed catalog');
  assert.doesNotMatch(uiSources, /Loading presentation workspace|LCT Presentation Core|Presentation workspace for template understanding|Analyze as template|Generate slide packs|Review\s*\/\s*export|Add sources/u);
  assert.doesNotMatch(uiSources, />\s*(?:Projects|Template|Generate plan|Audit|Repair|Download)\s*</u);
  assert.doesNotMatch(uiSources, /firstValue\(finding, \['message'\]\)/u, 'raw audit prose must not be shown to customers');
  assert.doesNotMatch(uiSources, /firstValue\(item, \['reason'\]\)/u, 'raw model review prose must not be shown to customers');
  assert.doesNotMatch(uiSources, /readableValue\(warning\)|uniqueStrings\(warnings\)/u, 'raw parser warning prose must not be shown to customers');
  assert.match(ru.planning.findingSummary('deck'), /[А-Яа-яЁё]/u);
  assert.match(ru.planning.findingSummary('slide'), /[А-Яа-яЁё]/u);
  assert.match(ru.planning.sourceWarningSummary, /[А-Яа-яЁё]/u);
  assert.match(ru.template.warningSummary(2), /[А-Яа-яЁё]/u);
  assert.match(ru.template.unsupportedSummary(2), /[А-Яа-яЁё]/u);
});

test('preview metrics, inherited template warnings, and blocking layout issues are presented separately', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /ru\.generation\.approximateLayoutNotes\(summary\.approximate\)/u);
  assert.match(appSource, /ru\.generation\.layoutWarnings\(summary\.warnings\)/u);
  assert.match(appSource, /ru\.generation\.blockingLayoutNotes\(summary\.blocking\)/u);
  assert.match(appSource, /unclassifiedLayoutNotes\(item\.layoutIssueCount\)/u, 'legacy rows are not mislabeled as clean or approximate');
  assert.equal(ru.generation.approximateLayoutNotes(1), 'Предупреждения предпросмотра: 1');
  assert.match(ru.generation.approximateLayoutDetail, /сами по себе не подтверждают переполнение PPTX/u);
  assert.match(ru.generation.templateBleedDetail, /унаследован/u);
  assert.match(ru.generation.blockingLayoutDetail, /Проверьте этот слайд/u);
  assert.doesNotMatch(ru.generation.approximateLayoutNotes(1), /Проблем макета/u);
  assert.equal(ru.generation.auditSummary(0, 0), 'Проверка пройдена', 'deterministic safety audit remains separate');
});

test('every deterministic audit rule uses a Russian customer-facing message', () => {
  const auditSource = readFileSync(new URL('../../daemon/src/presentation/application/deterministic-audit.ts', import.meta.url), 'utf8');
  const ruleIds = [...auditSource.matchAll(/ruleId:\s*'([^']+)'/gu)].map((match) => match[1]);
  assert.ok(ruleIds.length > 0);
  for (const ruleId of ruleIds) assert.match(auditFindingMessage(ruleId), /[А-Яа-яЁё]/u, `${ruleId} needs Russian copy`);
  assert.equal(auditFindingMessage('future.unknown-rule'), ru.generation.findingUnknown);
});

test('deterministic and contextual audit sources are visibly distinct and repairs stay user-triggered', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.equal(ru.generation.deterministicAudit, 'Детерминированная проверка');
  assert.equal(ru.workflow.contextualAudit, 'Контекстуальная проверка');
  assert.match(appSource, /data-audit-source="deterministic"/u);
  assert.match(appSource, /data-audit-source="contextual"/u);
  const contextualStart = appSource.indexOf('data-audit-source="contextual"');
  const contextualEnd = appSource.indexOf('</section>', contextualStart);
  const contextualMarkup = appSource.slice(contextualStart, contextualEnd);
  assert.doesNotMatch(contextualMarkup, /\brepair\(/u, 'contextual findings must never invoke deterministic repair');
  assert.match(appSource, /safeFix \? <button[^\n]*onClick=\{\(\) => repair\(/u, 'deterministic repair remains an explicit user action');
  for (const message of Object.values(ru.workflow.actionMessages)) assert.match(message, /[А-Яа-яЁё]/u);
});

test('normal user flow requires only a template and task; optional fields stay collapsed', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /fetch\(`\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/workflow\/generate`/u);
  assert.match(appSource, /<button className="primary" onClick=\{\(\) => void generatePresentation\(\)\} disabled=\{!templateFile \|\| !templatePreparationReady \|\| !briefPurpose\.trim\(\) \|\| busy \|\| templatePreparationPending \|\| productWorkflowRunning\}>/u, 'one-click generation waits for a complete prepared profile');
  assert.match(appSource, /templatePreparationReady = matchingScan && templateScan\?\.status === 'ready' && templateProfileStatus === 'ready'/u,
    'generation remains disabled until the persisted semantic profile validates');
  assert.match(appSource, /<button className=\{templateFile \? 'quiet' : 'primary'\} onClick=\{\(\) => uploadRef\.current\?\.click\(\)\}/u);
  assert.match(appSource, /<label className="planning-required-field">[\s\S]*<textarea id="presentation-purpose" required/u);
  const optionalStart = appSource.indexOf('<details className="advanced-tools optional-settings">');
  const optionalEnd = appSource.indexOf('</details>', optionalStart);
  const optionalMarkup = appSource.slice(optionalStart, optionalEnd);
  assert.ok(optionalStart >= 0 && optionalEnd > optionalStart, 'optional inputs have a native collapsed disclosure');
  for (const optionalMessage of ['ru.planning.audience', 'ru.planning.outcome', 'ru.planning.context', 'ru.planning.preferences', 'ru.planning.slideCount', 'ru.planning.addSources']) {
    assert.ok(optionalMarkup.includes(optionalMessage), `${optionalMessage} must be optional`);
  }
  assert.match(appSource, /<details className="advanced-tools planning-advanced">[\s\S]*?onClick=\{\(\) => void analyzeTemplate\(\)\}[\s\S]*?onClick=\{\(\) => void generatePlan\(\)\}/u);
  assert.match(appSource, /<details className="advanced-tools generation-advanced">[\s\S]*?onClick=\{\(\) => void start\(\)\}/u);
  assert.match(appSource, /<details className="advanced-tools developer-tools">[\s\S]*?<div className="workspace-grid">/u);
  assert.match(appSource, /<details className="advanced-tools template-report-disclosure">/u);
  assert.equal(ru.template.upload, 'Загрузить PPTX');
  assert.equal(ru.planning.optionalSettings, 'Дополнительные настройки');
  assert.equal(ru.workspace.advancedMode, 'Расширенный режим');
});

test('ready results, clean audit, and export controls have a clear customer hierarchy', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.equal(ru.generation.auditSummary(0, 0), 'Проверка пройдена');
  assert.match(ru.generation.auditSummary(1, 2), /Найдено проблем: 3/u);
  assert.match(appSource, /canExport \? ru\.generation\.resultReady/u);
  assert.match(appSource, /canExport \? ru\.generation\.resultSummary/u);
  assert.match(appSource, /className="primary" disabled=\{!canExport \|\| Boolean\(busy\)\} onClick=\{\(\) => exportDeck\('selected', 'pptx'\)\}/u);
  assert.match(appSource, /<details className="advanced-tools variant-exports">[\s\S]*?\['A', 'B', 'C'\][\s\S]*?exportDeck\(mode, format\)/u);
  assert.match(appSource, /ru\.generation\.editablePowerPoint/u);
  assert.match(appSource, /ru\.generation\.downloadPdf/u);
  assert.match(appSource, /ru\.generation\.downloadHtml/u);
  assert.equal(ru.generation.resultSummary(5), '5 слайдов · три варианта для проверки');
  assert.match(appSource, /className="generation-empty-hint"/u);
  assert.doesNotMatch(appSource, /ru\.generation\.incompletePlan/u, 'the default empty state must not show a warning before the user starts');
});

test('workflow failures offer a safe retry and technical codes stay in details', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /product-workflow-error" onRetry=\{\(\) => void generatePresentation\(\)\}/u);
  assert.match(appSource, /<button className="quiet compact ui-error-retry" onClick=\{onRetry\}>\{ru\.errors\.retry\}/u);
  assert.match(appSource, /<details className="ui-error-details">[\s\S]*?ru\.errors\.code\(value\.code\)/u);
  assert.doesNotMatch(appSource, /failure\.code\s*\|\|\s*failure\.message/u);
});

test('visible dates use Russian locale formatting', () => {
  assert.match(formatUiDateTime(new Date('2026-09-26T09:05:00.000Z')), /\d{2}\.\d{2}\.\d{4}/u);
});

test('known design-system names use Russian display labels while preserving their identifiers', () => {
  assert.equal(ru.workspace.designSystemLabel('Corporate'), 'Корпоративный стиль');
  assert.equal(ru.workspace.designSystemLabel('Neutral Modern'), 'Современный нейтральный стиль');
  assert.equal(ru.workspace.designSystemLabel('custom-id'), 'custom-id');
});

test('API failures map to safe user messages without echoing raw server details', () => {
  assert.match(friendlyErrorMessage('TEMPLATE_COMPILE_FAILED', 500, 'template'), /шаблон/i);
  assert.equal(friendlyErrorMessage('TEMPLATE_PROFILE_NOT_READY', 409, 'generation'), ru.template.prepareBeforeGenerate);
  assert.equal(friendlyErrorMessage('PROVIDER_ERROR', 502, 'template'), ru.errors.semantic,
    'semantic profiling failures during template analysis must not be described as damaged PPTX');
  assert.match(friendlyErrorMessage('LIMIT_FILE_SIZE', 413, 'upload'), /файл превышает/i);
  assert.match(friendlyErrorMessage('PLANNING_CONTEXT_TOO_LARGE', 413, 'planning'), /план/i);
  assert.match(friendlyErrorMessage('DEADLINE_EXCEEDED', 504, 'planning'), /сервис анализа/i);
  assert.match(friendlyErrorMessage('VARIANTS_NOT_DISTINCT', 422, 'generation'), /вариант не создан/i);
  assert.match(friendlyErrorMessage('EXPORT_FAILED', 500, 'export'), /презентацию/i);
  assert.match(friendlyErrorMessage('INTERNAL_ERROR', 500), /не удалось выполнить/i);
});
