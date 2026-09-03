/**
 * bpmn-studio — renderer entry.
 *
 * A nearly full-featured standalone BPMN 2.0 modeler built on:
 *   - bpmn-js (modeler core, palette, context pad, search, keyboard, ...)
 *   - bpmn-js-properties-panel (+ Camunda Platform 7 / Zeebe execution providers)
 *   - diagram-js-minimap, bpmn-js-color-picker
 *   - bpmn-js-bpmnlint (model validation)
 *   - bpmn-js-token-simulation (run the diagram)
 *
 * Execution-platform handling
 * ----------------------------
 * `camunda-bpmn-moddle` and `zeebe-bpmn-moddle` cannot be registered on the
 * same modeler (moddle forbids overriding `TemplateSupported#modelerTemplate`
 * across namespaces without redefines, and the two packages collide on various
 * BPMN types). Like Camunda Modeler, we therefore detect the diagram's
 * execution platform on open and (re)create the modeler with exactly the
 * matching moddle extension + properties provider.
 *
 * Works identically in a plain browser and inside the Electron shell
 * (window.bpmnStudio is injected by the preload script when available).
 */

// --- styles ---------------------------------------------------------------
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';
import '@bpmn-io/properties-panel/assets/properties-panel.css';
import 'bpmn-js-color-picker/colors/color-picker.css';
import 'bpmn-js-bpmnlint/dist/assets/css/bpmn-js-bpmnlint.css';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import 'diagram-js-minimap/assets/diagram-js-minimap.css';

import './style.css';
import './dark-theme.css';

// --- libraries ------------------------------------------------------------
import BpmnModeler from 'bpmn-js/lib/Modeler';
import { debounce } from 'min-dash';

import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
  CamundaPlatformPropertiesProviderModule,
  ZeebePropertiesProviderModule
} from 'bpmn-js-properties-panel';

import camundaModdle from 'camunda-bpmn-moddle/resources/camunda.json';
import zeebeModdle from 'zeebe-bpmn-moddle/resources/zeebe.json';

import MinimapModule from 'diagram-js-minimap';
import BpmnColorPickerModule from 'bpmn-js-color-picker';
import BpmnLintModule from 'bpmn-js-bpmnlint';
import TokenSimulationModule from 'bpmn-js-token-simulation';

// package versions (reported by the diagnostics clipboard payload)
import bpmnJsPkg from 'bpmn-js/package.json';
import bpmnJsBpmnlintPkg from 'bpmn-js-bpmnlint/package.json';
import bpmnlintPkg from 'bpmnlint/package.json';

// ---------------------------------------------------------------------------
// Pre-modeler patch: suppress DI-label false-positives from bpmn-js-bpmnlint
// ---------------------------------------------------------------------------
// bpmn-js registers label wrappers (e.g. "StartEvent_1_label") in the
// element registry with the same $type as the parent shape but without
// any semantic incoming / outgoing.  The bpmn-lint rules therefore produce
// false-positive reports on these visual-only wrappers.
//
// We must patch the Linting *prototype* before any BpmnModeler is created,
// because the constructor fires diagram.init → linting.configChanged →
// update() synchronously during new BpmnModeler().  A post-construction
// instance-level patch arrives too late to prevent the first overlay pass.
{
  const LintingClass = BpmnLintModule.linting[1];

  if (LintingClass && LintingClass.prototype) {

    // Patch _formatIssues: strip DI-label entries from the result so that
    // this._issues (button badge count) never includes false positives.
    const origFormatIssues = LintingClass.prototype._formatIssues;
    if (typeof origFormatIssues === 'function') {
      LintingClass.prototype._formatIssues = function patchedFormatIssues(issues) {
        const result = origFormatIssues.call(this, issues);
        const filtered = {};
        for (const id in result) {
          if (typeof id !== 'string' || !id.endsWith('_label')) {
            filtered[id] = result[id];
          }
        }
        return filtered;
      };
    }

    // Patch _createIssues: belt-and-suspenders guard so overlay creation
    // never sees DI-label element IDs even if _formatIssues was somehow
    // bypassed.
    const origCreateIssues = LintingClass.prototype._createIssues;
    if (typeof origCreateIssues === 'function') {
      LintingClass.prototype._createIssues = function patchedCreateIssues(issues) {
        const filtered = {};
        for (const id in issues) {
          if (typeof id !== 'string' || !id.endsWith('_label')) {
            filtered[id] = issues[id];
          }
        }
        return origCreateIssues.call(this, filtered);
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Post-parse fix: rebuild FlowNode.incoming/outgoing back-references
// ---------------------------------------------------------------------------
// BPMN exporters encode sequence-flow endpoints only via sourceRef/targetRef
// and omit the derived FlowNode.incoming/outgoing elements.  The current
// moddle stack (bpmn-moddle 10 / moddle-xml 12) does not re-derive them while
// parsing, so they stay `undefined` after importXML — which makes every
// connectivity rule in bpmnlint (no-disconnected, no-implicit-start,
// no-implicit-end) report a false positive on every flow node of every
// diagram.
//
// We rebuild them from sourceRef/targetRef after XML parsing
// (import.parse.complete) and after structural model changes
// (elements.changed), so the lint rules see the same connectivity as the
// diagram itself.  Rebuilding is idempotent: it resets the arrays and
// repopulates them from the flow references.  Verified: with the
// back-references populated the false positives vanish while genuinely
// disconnected elements are still detected (scripts/check-backref-fix.mjs).
function rebuildFlowNodeBackrefs(definitions) {
  if (!definitions) return;

  const rebuildContainer = (container) => {
    const flowElements = container.flowElements || [];

    // reset the back-references of this container's direct flow nodes
    for (const fe of flowElements) {
      if (fe.$instanceOf && fe.$instanceOf('bpmn:FlowNode')) {
        fe.incoming = [];
        fe.outgoing = [];
      }
    }

    // repopulate them from the flow reference attributes
    for (const fe of flowElements) {
      if (fe.$type !== 'bpmn:SequenceFlow' && fe.$type !== 'bpmn:MessageFlow') continue;
      const source = fe.sourceRef;
      const target = fe.targetRef;
      if (source && Array.isArray(source.outgoing)) source.outgoing.push(fe);
      if (target && Array.isArray(target.incoming)) target.incoming.push(fe);
    }

    // recurse into nested containers (sub-processes)
    for (const fe of flowElements) {
      if (fe.flowElements) rebuildContainer(fe);
    }
  };

  for (const re of definitions.rootElements || []) {
    if (re.processRef) {
      // Participant (and other reference-based root elements)
      rebuildContainer(re.processRef);
    } else if (re.$type === 'bpmn:Process') {
      rebuildContainer(re);
    }
  }
}

// packed by `npm run lint:pack` (bpmnlint-pack-config)
import lintConfig from './lint-config.js';

// lint 规则 / 元素的中文文案（纯逻辑模块）
import { ruleInfo, elementTypeLabel, lintCategoryLabel, categorySortWeight } from './lint-l10n.js';
// 错误细节提取与文件系统错误分类（纯逻辑模块）
import { extractParseLocation, excerptLines, describeFsError } from './error-detail.js';

import initialDiagramXML from '../resources/newDiagram.bpmn?raw';

// --- DMN editor -----------------------------------------------------------
import { createDmnModeler, EMPTY_DMN_XML } from './dmn-editor.js';

// --- DOM ------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

const els = {
  diagramName: $('#diagram-name'),
  dirty: $('#dirty'),
  zoomLevel: $('#zoom-level'),
  statusLeft: $('#status-left'),
  statusRight: $('#status-right'),
  lintPanel: $('#lint-panel'),
  lintList: $('#lint-list'),
  lintSummary: $('#lint-summary'),
  fileInput: $('#file-input'),
  canvas: $('#js-canvas'),
  propertiesPanel: $('#js-properties-panel'),
  noticeBar: $('#notice-bar'),
  noticeText: $('#notice-text'),
  errorOverlay: $('#error-overlay'),
  errorTitle: $('#error-title'),
  errorMessage: $('#error-message'),
  errorStack: $('#error-stack'),
  errorWarnings: $('#error-warnings'),
  errorSuggestion: $('#error-suggestion'),
  errorExcerpt: $('#error-excerpt'),
  errorViewXmlBtn: $('#btn-error-view-xml'),
  infoModal: $('#info-modal'),
  infoContent: $('#info-content'),
  xmlPanel: $('#xml-panel'),
  xmlStatus: $('#xml-status'),
  xmlCode: $('#xml-code'),
  xmlViewer: $('#xml-viewer'),
  xmlAutoscroll: $('#xml-autoscroll'),
  dmnCanvas: $('#js-dmn-canvas'),
  dmnViewTabs: $('#dmn-view-tabs'),
  btnDmnDrd: $('#btn-dmn-drd'),
  btnDmnDecisionTable: $('#btn-dmn-decision-table'),
  btnDmnLiteralExpression: $('#btn-dmn-literal-expression'),
  panelRegion: $('#panel-region'),
  panelCollapseBtn: $('#panel-collapse-btn')
};

// --- per-platform configuration ----------------------------------------------
const PLATFORMS = {
  'camunda-7': {
    moddleExtensions: { camunda: camundaModdle },
    providers: [CamundaPlatformPropertiesProviderModule],
    label: 'Camunda Platform 7'
  },
  'camunda-8': {
    moddleExtensions: { zeebe: zeebeModdle },
    providers: [ZeebePropertiesProviderModule],
    label: 'Camunda 8 (Zeebe)'
  },
  bpmn: {
    moddleExtensions: {},
    providers: [],
    label: 'BPMN 2.0'
  }
};

function detectPlatform(xml) {
  if (xml && xml.includes('http://camunda.org/schema/zeebe/')) return 'camunda-8';
  if (xml && xml.includes('http://camunda.org/schema/bpmn')) return 'camunda-7';
  return 'bpmn';
}

// --- state -----------------------------------------------------------------
let bpmnModeler = null;
let currentPlatform = null;
let currentFileName = 'untitled.bpmn';
let currentFilePath = null;
let lastSavedXML = null;
let lastSavedAt = null;
let isDirty = false;
let lintVisible = true;
let simulateMode = false;
let xmlVisible = false;
let xmlEditing = false;
let xmlDetached = false; // XML 视图处于「脱离模型」只读态（展示导入失败的原始内容）
let currentXml = '';

// --- DMN state -----------------------------------------------------------
let editorMode = 'bpmn';  // 'bpmn' | 'dmn'
let dmnModeler = null;
let currentDmnView = 'drd'; // 'drd' | 'decisionTable' | 'literalExpression'

// --- theme state ---------------------------------------------------------
const THEME_KEY = 'bpmn-studio-theme';
const $html = document.documentElement;

const studio = window.bpmnStudio || null;

// --- theme helpers -------------------------------------------------------
function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function storeTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    $html.setAttribute('data-theme', theme);
  } else {
    // auto: follow system preference
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    $html.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }
  updateThemeButton();
}

function currentTheme() {
  return $html.getAttribute('data-theme') || 'light';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  $html.setAttribute('data-theme', next);
  storeTheme(next);
  updateThemeButton();
  setStatus(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
}

function updateThemeButton() {
  const btn = $('#btn-theme');
  if (!btn) return;
  const dark = currentTheme() === 'dark';
  btn.textContent = dark ? '☀️' : '🌙';
  btn.title = dark ? '切换到浅色主题 (Ctrl+Shift+D)' : '切换到深色主题 (Ctrl+Shift+D)';
  btn.classList.toggle('active', dark);
}

// Apply stored or system theme on startup
applyTheme(getStoredTheme() || 'auto');

// Listen for system theme changes when in auto mode
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!getStoredTheme()) applyTheme('auto');
  });
}

// --- big error / notice overlay -------------------------------------------------
let lastError = null;
let lastFailedXml = null;
let lastFailedLocation = null;

/**
 * 将 importXML 返回的警告统一为结构化形态
 * `{ message, line, column, elementId, elementType, elementName }`。
 *
 * 兼容三种来源：
 *  - moddle-xml 解析警告 `{ message, error }`（行/列内嵌在 message 字符串中）
 *  - bpmn-js 导入阶段警告 `{ message, context: { element: { id, $type, name } } }`
 *  - 已规范化的对象（幂等）
 */
function normalizeWarning(w) {
  if (!w || typeof w !== 'object') {
    return { message: String(w == null ? '' : w) };
  }
  const out = { message: typeof w.message === 'string' ? w.message : String(w) };

  // 已是规范化形态（幂等返回）
  if (w.elementId || w.elementType || w.line || w.column) {
    if (w.elementId) out.elementId = w.elementId;
    if (w.elementType) out.elementType = w.elementType;
    if (w.elementName) out.elementName = w.elementName;
    if (w.line) out.line = w.line;
    if (w.column) out.column = w.column;
    return out;
  }

  const loc = extractParseLocation(w);
  if (loc) {
    out.line = loc.line;
    out.column = loc.column;
  }

  const context = w.context;
  const elem = context && context.element;
  if (elem && elem.$type) {
    out.elementId = elem.id;
    out.elementType = elementTypeLabel(elem.$type);
    if (elem.name) out.elementName = elem.name;
  } else if (context && typeof context.data === 'string') {
    // moddle-xml 上下文线索，如 "<bpmn:Task>"
    const tag = context.data.replace(/[<>]/g, '').trim();
    if (tag) out.elementHint = tag;
  }

  return out;
}

/** 渲染解析失败位置 + 附近源码片段（无位置时隐藏并清空） */
function renderErrorExcerpt(parseLocation) {
  if (!parseLocation || typeof parseLocation.line !== 'number') {
    els.errorExcerpt.classList.add('hidden');
    els.errorExcerpt.innerHTML = '';
    return;
  }
  els.errorExcerpt.classList.remove('hidden');
  els.errorExcerpt.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'excerpt-heading';
  heading.textContent = `解析失败位置：第 ${parseLocation.line} 行, 第 ${parseLocation.column} 列`;
  els.errorExcerpt.appendChild(heading);

  const excerpt = excerptLines(lastFailedXml || '', parseLocation.line);
  if (!excerpt) return;
  const firstNo = parseLocation.line - excerpt.errIndex;
  const pre = document.createElement('pre');
  pre.className = 'excerpt';
  excerpt.lines.forEach((lineText, i) => {
    const row = document.createElement('div');
    row.className = 'excerpt-row' + (i === excerpt.errIndex ? ' err' : '');
    const no = document.createElement('span');
    no.className = 'excerpt-no';
    no.textContent = String(firstNo + i);
    const code = document.createElement('span');
    code.className = 'excerpt-code';
    code.textContent = lineText || ' ';
    row.append(no, code);
    pre.appendChild(row);
  });
  els.errorExcerpt.appendChild(pre);
}

/** Electron 文件系统错误 → 中文错误卡（描述 + 建议） */
function showFsError(result) {
  const err = (result && result.error) || {};
  const d = describeFsError(err.code, err.message);
  showError({
    title: d.title,
    message: d.message,
    suggestion: d.suggestion,
    error: new Error(`${d.message} (${err.code || 'UNKNOWN'})`)
  });
}

function showError({
  title = '出错了',
  message = '发生未知错误',
  error,
  warningObjects = [],
  parseLocation,
  failedXml,
  suggestion
} = {}) {
  const detailLines = [];
  if (error) {
    if (error.message) detailLines.push(error.message);
    if (error.stack) detailLines.push('', error.stack);
    lastError = {
      title,
      message: message || error.message || '发生未知错误',
      details: detailLines.join('\n'),
      warnings: warningObjects
    };
    if (!parseLocation) parseLocation = extractParseLocation(error);
  } else {
    lastError = { title, message, details: '', warnings: warningObjects };
  }
  lastFailedXml = failedXml || null;
  lastFailedLocation = parseLocation || null;

  els.errorTitle.textContent = lastError.title;
  els.errorMessage.textContent = lastError.message;

  // 修复建议（如文件系统错误的下一步指引）
  els.errorSuggestion.textContent = suggestion || '';
  els.errorSuggestion.classList.toggle('hidden', !suggestion);

  els.errorStack.textContent = lastError.details || '（无额外信息）';

  // 规范化并渲染警告列表（上限 50 条防 DOM 爆炸）
  const warnings = (warningObjects || []).map(normalizeWarning);
  const MAX_WARNINGS = 50;
  els.errorWarnings.classList.toggle('hidden', !warnings.length);
  els.errorWarnings.innerHTML = '';
  for (const w of warnings.slice(0, MAX_WARNINGS)) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'warn-text';
    text.textContent = w.message || '（无消息）';
    li.appendChild(text);
    if (w.elementType || w.elementId || w.elementHint) {
      const chip = document.createElement('span');
      chip.className = 'elem-chip';
      chip.textContent = [w.elementType, w.elementName, w.elementId, w.elementHint].filter(Boolean).join(' · ');
      li.appendChild(chip);
    }
    if (w.line && w.column) {
      const pos = document.createElement('code');
      pos.className = 'warn-pos';
      pos.textContent = `第 ${w.line} 行, 第 ${w.column} 列`;
      li.appendChild(pos);
    }
    els.errorWarnings.appendChild(li);
  }
  if (warnings.length > MAX_WARNINGS) {
    const li = document.createElement('li');
    li.className = 'warn-more';
    li.textContent = `…另有 ${warnings.length - MAX_WARNINGS} 条警告未显示`;
    els.errorWarnings.appendChild(li);
  }

  renderErrorExcerpt(parseLocation);
  els.errorViewXmlBtn.classList.toggle('hidden', !failedXml);

  els.errorOverlay.classList.remove('hidden');
  console.error('[bpmn-studio]', lastError.title, lastError.message, error || '');
}

function hideError() {
  els.errorOverlay.classList.add('hidden');
  lastError = null;
  lastFailedXml = null;
  lastFailedLocation = null;
}

async function copyError() {
  if (!lastError) return;
  const text = [
    lastError.title,
    lastError.message,
    lastError.details
  ].filter(Boolean).join('\n\n');
  await copyTextToClipboard(text);
  setStatus('错误信息已复制到剪贴板');
}

function showNotice(text, warnings = []) {
  els.noticeText.textContent = text;
  els.noticeBar.classList.remove('hidden');
  els.noticeBar._warnings = warnings;
}

function hideNotice() {
  els.noticeBar.classList.add('hidden');
  els.noticeBar._warnings = [];
}

// --- modeler lifecycle --------------------------------------------------------
function createModeler(platform) {
  const cfg = PLATFORMS[platform];

  const modeler = new BpmnModeler({
    container: '#js-canvas',
    propertiesPanel: {
      parent: '#js-properties-panel'
    },
    additionalModules: [
      BpmnPropertiesPanelModule,
      BpmnPropertiesProviderModule,
      ...cfg.providers,
      MinimapModule,
      BpmnColorPickerModule,
      BpmnLintModule,
      TokenSimulationModule
    ],
    moddleExtensions: cfg.moddleExtensions,
    linting: {
      bpmnlint: lintConfig
    }
  });

  currentPlatform = platform;
  bindModelerEvents(modeler);
  window.__bpmnModeler = modeler;

  setStatus(`就绪（${cfg.label}）- 从左侧工具栏拖拽元素开始建模`);
  return modeler;
}

function destroyModeler() {
  if (bpmnModeler) {
    try {
      bpmnModeler.destroy();
    } catch (err) {
      console.warn('destroy failed', err);
    }
    bpmnModeler = null;
  }
  els.canvas.innerHTML = '';
  els.propertiesPanel.innerHTML = '';
  simulateMode = false;
  $('#btn-simulate').textContent = '▶ 模拟';
  $('#btn-simulate').classList.remove('active');
  editorMode = 'bpmn';
}

// --- DMN modeler lifecycle --------------------------------------------------
function createDmnEditor() {
  const modeler = createDmnModeler('#js-dmn-canvas');

  bindDmnModelerEvents(modeler);
  window.__dmnModeler = modeler;

  els.dmnViewTabs.classList.remove('hidden');
  setStatus('就绪（DMN 决策建模）— 从 DRD 视图开始建模');
  return modeler;
}

function destroyDmnEditor() {
  if (dmnModeler) {
    try {
      dmnModeler.destroy();
    } catch (err) {
      console.warn('destroy DMN modeler failed', err);
    }
    dmnModeler = null;
  }
  els.dmnCanvas.innerHTML = '';
  els.dmnViewTabs.classList.add('hidden');
  currentDmnView = 'drd';
}

function switchToDmnMode() {
  if (editorMode === 'dmn') return;
  destroyModeler();
  editorMode = 'dmn';
  els.canvas.classList.add('hidden');
  els.dmnCanvas.classList.remove('hidden');
  dmnModeler = createDmnEditor();
}

function switchToBpmnMode() {
  if (editorMode === 'bpmn') return;
  destroyDmnEditor();
  editorMode = 'bpmn';
  els.dmnCanvas.classList.add('hidden');
  els.canvas.classList.remove('hidden');
  els.dmnViewTabs.classList.add('hidden');
}

function bindDmnModelerEvents(modeler) {
  modeler.on('import.done', () => {
    if (dmnModeler !== modeler) return;
    setStatus('DMN 导入完成');
    updateDmnViewTabs();
  });

  modeler.on('view.switch', (event) => {
    if (dmnModeler !== modeler) return;
    const { activeView } = event;
    if (activeView && activeView.type) {
      currentDmnView = activeView.type;
      updateDmnViewTabs();
    }
  });

  modeler.on('selection.changed', (event) => {
    if (dmnModeler !== modeler) return;
    const element = event.newSelection && event.newSelection[0];
    if (element) {
      const type = (element.businessObject && element.businessObject.$type) || '';
      els.statusRight.textContent = element.id ? `${element.id} (${type.replace('dmn:', '')})` : type.replace('dmn:', '');
    } else {
      els.statusRight.textContent = '';
    }
  });

  // DMN 每个视图（drd/决策表/文字表达式/boxedExpression）是独立 diagram-js 实例，
  // 各有独立命令栈；viewer.created 于每类视图首次打开时触发一次（viewer 惰性创建并复用）。
  modeler.on('viewer.created', ({ viewer }) => {
    viewer.on('commandStack.changed', () => {
      // 近似脏跟踪：任一视图有命令变更即置脏，保存时清零。
      // DMN 无跨视图统一命令栈，撤销回保存点不会自动清除星号（BPMN 侧是精确的）。
      if (lastSavedXML !== null) setDirty(true);
      if (xmlVisible) debouncedXmlRefresh();
    });
  });
}

/** Get a service from the DMN modeler's active viewer */
function dmnGet(service) {
  if (!dmnModeler) return null;
  const viewer = dmnModeler.getActiveViewer();
  return viewer ? viewer.get(service) : null;
}

function updateDmnViewTabs() {
  const views = {
    'drd': els.btnDmnDrd,
    'decisionTable': els.btnDmnDecisionTable,
    'literalExpression': els.btnDmnLiteralExpression
  };
  for (const [key, btn] of Object.entries(views)) {
    btn.classList.toggle('active', key === currentDmnView);
  }
}

async function switchDmnView(viewType) {
  if (!dmnModeler) return;
  try {
    const views = dmnModeler.getViews();
    const targetView = views.find(v => v.type === viewType);
    if (targetView) {
      await dmnModeler.open(targetView);
    }
  } catch (err) {
    console.error('switch DMN view failed', err);
    showError({
      title: '切换视图失败',
      message: err.message || String(err),
      error: err
    });
  }
}

/** detect file type from extension */
function detectFileType(name) {
  if (/\.dmn$/i.test(name)) return 'dmn';
  return 'bpmn';
}

/** ensure the modeler matches the diagram's execution platform */
function ensureModeler(xml) {
  const platform = detectPlatform(xml);
  if (platform !== currentPlatform || !bpmnModeler) {
    destroyModeler();
    bpmnModeler = createModeler(platform);
  }
  return bpmnModeler;
}

/** ensure the correct editor mode is active for the given file type */
function ensureEditorMode(fileType) {
  if (fileType === 'dmn') {
    switchToDmnMode();
  } else {
    switchToBpmnMode();
  }
}

// --- diagram lifecycle -------------------------------------------------------
async function setDiagram(xml, name, filePath) {
  const fileType = detectFileType(name || filePath || '');
  ensureEditorMode(fileType);

  if (fileType === 'dmn') {
    await setDmnDiagram(xml, name, filePath);
  } else {
    await setBpmnDiagram(xml, name, filePath);
  }
}

async function setDmnDiagram(xml, name, filePath) {
  // 预检先于一切触碰画布的动作：格式错误 → 直接友好错误卡，画布/上一模型保持原样
  const preErr = precheckDmnXml(xml);
  if (preErr) {
    preErr.warnings = [];
    preErr.parseLocation = null;
    preErr.failedXml = xml;
    throw preErr;
  }
  let warnings;
  try {
    ({ warnings } = await dmnModeler.importXML(xml));
  } catch (err) {
    err.warnings = err.warnings || [];
    err.parseLocation = extractParseLocation(err);
    err.failedXml = xml;
    throw err;
  }

  if (warnings && warnings.length) {
    console.warn('DMN import warnings', warnings);
    showNotice(`DMN 导入完成，但有 ${warnings.length} 条警告`, warnings);
  } else {
    hideNotice();
  }

  currentFileName = name || 'untitled.dmn';
  currentFilePath = filePath || null;
  lastSavedXML = null;
  lastSavedAt = null;
  isDirty = false;

  updateTitle();

  try {
    const canvas = dmnGet('canvas');
    if (canvas) canvas.zoom('fit-viewport', 'auto');
  } catch { /* canvas may not be available in all views */ }

  if (xmlVisible) refreshXmlView();
}

/** 当前 BPMN/DMN 模型的 XML 快照（失败恢复用）；无模型时返回 null */
async function snapshotCurrentXml() {
  try {
    if (editorMode === 'dmn' && dmnModeler) {
      const { xml } = await dmnModeler.saveXML({ format: true });
      return xml;
    }
    if (bpmnModeler) {
      const { xml } = await bpmnModeler.saveXML({ format: true });
      return xml;
    }
  } catch { /* 快照失败则无恢复能力 */ }
  return null;
}

/**
 * 导入失败时恢复上一个可用模型。
 *
 * bpmn-js/DMN-js 在图形导入前会 clear() 画布并替换 definitions，失败后旧图已丢失：
 * 画布空白、属性面板可能因根对象不完整而崩溃。这里用导入前的快照重建，
 * 让用户关闭错误卡后看到的是自己之前的图，而不是空白画布。
 */
async function restorePreviousModel(modeler, previousXml) {
  if (!previousXml || !modeler) return;
  try {
    await modeler.importXML(previousXml);
  } catch (err) {
    console.warn('restore previous model failed', err);
  }
}

/**
 * BPMN XML 导入前预检（在触碰画布/modeler 之前）：
 *  - 格式良好性（DOMParser）
 *  - 包含 BPMNDI 图（<…:BPMNDiagram>，任意前缀）——缺失时 bpmn-js 会 'no diagram to
 *    display' 失败，且失败时画布已被清空、根对象残缺，属性面板会崩溃；预检把这种
 *    「残缺」提前变成友好错误卡，画布保持原样。
 *
 * @param {string} xml
 * @returns {Error|null} 返回 Error 时 message 即用户可读的失败原因
 */
function precheckBpmnXml(xml) {
  try {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const perr = parsed.getElementsByTagName('parsererror')[0];
    if (perr) return new Error('XML 格式错误：' + perr.textContent.trim());
  } catch (err) {
    return new Error('XML 格式错误：' + (err.message || String(err)));
  }
  if (!/<[\w.-]+:BPMNDiagram\b/.test(xml)) {
    return new Error('文件中没有 BPMNDI 图形定义（缺少 <BPMNDiagram>），无法绘制图表');
  }
  return null;
}

/**
 * DMN XML 导入前预检（触碰画布之前）：仅检查格式良好性。
 * dmn-js 对缺 DMNDI 有视图回退逻辑（_getInitialView），故不做 DI 强制（与 BPMN 不同）。
 *
 * @param {string} xml
 * @returns {Error|null} 返回 Error 时 message 即用户可读的失败原因
 */
function precheckDmnXml(xml) {
  try {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const perr = parsed.getElementsByTagName('parsererror')[0];
    if (perr) return new Error('XML 格式错误：' + perr.textContent.trim());
  } catch (err) {
    return new Error('XML 格式错误：' + (err.message || String(err)));
  }
  return null;
}

/** 导入成功后校验画布根元素可用。
 *
 * moddle 以 lax 模式解析时，根元素可能被降级为普通对象而不是 ModdleElement
 * （例如无命名空间的 <definitions>），若放任其进入画布，属性面板在渲染根属性时
 * 会因 businessObject.get 不存在而崩溃，用户只会看到空画布。
 * 这里改为抛出带 failedXml 的明确错误 → 走统一错误卡 + 「查看原文」流程。
 */
function assertRenderableBpmnRoot(modeler, warnings, xml) {
  try {
    const rootBo = modeler.get('canvas').getRootElement().businessObject;
    if (rootBo && typeof rootBo.get === 'function') return;
  } catch { /* 画布未就绪 → 按不可用处理 */ }
  const err = new Error('导入的 XML 未生成可显示的模型（根元素无法解析，或缺少 BPMNDI 图）');
  err.warnings = warnings || [];
  err.failedXml = xml;
  err.parseLocation = null;
  throw err;
}

async function setBpmnDiagram(xml, name, filePath) {
  // 预检先于一切触碰画布的动作：格式错误/缺 BPMNDI → 直接友好错误卡，画布保持原样
  const preErr = precheckBpmnXml(xml);
  if (preErr) {
    preErr.warnings = [];
    preErr.parseLocation = null;
    preErr.failedXml = xml;
    throw preErr;
  }
  // 快照必须先于 ensureModeler：平台切换会销毁旧 modeler
  const previousXml = await snapshotCurrentXml();
  const modeler = ensureModeler(xml);

  let warnings;
  try {
    ({ warnings } = await modeler.importXML(xml));
  } catch (err) {
    err.warnings = err.warnings || [];
    err.parseLocation = extractParseLocation(err);
    err.failedXml = xml;
    // 恢复上一个可用模型：失败导入已清空画布，不恢复则用户只看得到空白编辑区
    await restorePreviousModel(modeler, previousXml);
    await rebaseDirtyAfterRestore();
    throw err;
  }

  // lax 解析可能“成功”但根元素不可渲染 → 转成明确错误，而非空画布+面板崩溃
  assertRenderableBpmnRoot(modeler, warnings, xml);

  // 导入成功 = 命令栈已清空重建，旧的存档游标作废（后续编辑一律置脏）
  savedStackIdx = null;

  if (warnings && warnings.length) {
    console.warn('import warnings', warnings);
    showNotice(`导入完成，但有 ${warnings.length} 条警告（部分内容可能无法解析）`, warnings);
  } else {
    hideNotice();
  }

  currentFileName = name || 'untitled.bpmn';
  currentFilePath = filePath || null;
  lastSavedXML = null;
  lastSavedAt = null;
  isDirty = false;

  updateTitle();

  modeler.get('canvas').zoom('fit-viewport', 'auto');
  if (modeler.get('minimap')) modeler.get('minimap').open();
  $('#btn-minimap').classList.toggle('active', !!(modeler.get('minimap') && modeler.get('minimap').isOpen()));

  if (xmlVisible) refreshXmlView();
}

async function createNewDiagram() {
  stopSimulationIfNeeded();
  try {
    await setDiagram(initialDiagramXML, 'untitled.bpmn', null);
    setStatus('新建设图完成');
  } catch (err) {
    console.error(err);
    showError({
      title: '无法创建新图',
      message: err.message || String(err),
      error: err,
      warningObjects: err.warnings || [],
      parseLocation: err.parseLocation,
      failedXml: err.failedXml
    });
  }
}

async function createNewDmnDiagram() {
  stopSimulationIfNeeded();
  try {
    switchToDmnMode();
    await setDmnDiagram(EMPTY_DMN_XML, 'untitled.dmn', null);
    setStatus('新建设策图完成');
  } catch (err) {
    console.error(err);
    showError({
      title: '无法创建新决策图',
      message: err.message || String(err),
      error: err,
      warningObjects: err.warnings || [],
      parseLocation: err.parseLocation,
      failedXml: err.failedXml
    });
  }
}

async function openDiagramContent(xml, name, filePath) {
  stopSimulationIfNeeded();
  try {
    await setDiagram(xml, name, filePath);
    setStatus('已打开: ' + currentFileName);
  } catch (err) {
    console.error(err);
    showError({
      title: `无法打开图表：${name || '文件'}`,
      message: err.message || String(err),
      error: err,
      warningObjects: err.warnings || [],
      parseLocation: err.parseLocation,
      failedXml: err.failedXml
    });
  }
}

// --- file open / save ---------------------------------------------------------
async function openFile() {
  if (studio) {
    const result = await studio.openDiagram();
    if (!result) return;
    if (result.error) {
      showFsError(result);
      return;
    }
    await openDiagramContent(result.content, basename(result.path), result.path);
  } else {
    els.fileInput.value = '';
    els.fileInput.click();
  }
}

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

async function saveFile(forceAs = false) {
  let xml;
  try {
    if (editorMode === 'dmn' && dmnModeler) {
      ({ xml } = await dmnModeler.saveXML({ format: true }));
    } else if (bpmnModeler) {
      ({ xml } = await bpmnModeler.saveXML({ format: true }));
    } else {
      return;
    }
  } catch (err) {
    console.error(err);
    showError({ title: '导出 XML 失败', message: err.message || String(err), error: err });
    return;
  }

  const mime = editorMode === 'dmn' ? 'application/dmn+xml' : 'application/bpmn20-xml';

  try {
    if (studio) {
      const result = await studio.saveDiagram({
        content: xml,
        defaultPath: forceAs ? currentFileName : (currentFilePath || currentFileName),
        forceAs
      });
      if (!result) return;
      if (result.error) {
        showFsError(result);
        return;
      }
      currentFilePath = result.path;
      currentFileName = basename(result.path);
      markSaved(xml);
      setStatus('已保存: ' + currentFilePath);
    } else {
      downloadText(xml, currentFileName, mime);
      markSaved(xml);
    }
  } catch (err) {
    console.error(err);
    showError({ title: '保存文件失败', message: err.message || String(err), error: err });
  }
}

async function exportSVG() {
  try {
    let svg;
    if (editorMode === 'dmn' && dmnModeler) {
      ({ svg } = await dmnModeler.saveSVG({ format: true }));
    } else if (bpmnModeler) {
      ({ svg } = await bpmnModeler.saveSVG({ format: true }));
    } else {
      return;
    }
    const baseName = currentFileName.replace(/\.(bpmn|dmn)$/i, '');
    if (studio) {
      const res = await studio.exportFile({ name: baseName + '.svg', content: svg });
      if (res && res.error) {
        showFsError(res);
        return;
      }
    } else {
      downloadText(svg, baseName + '.svg', 'image/svg+xml');
    }
    setStatus('已导出 SVG');
  } catch (err) {
    console.error(err);
    showError({ title: '导出 SVG 失败', message: err.message || String(err), error: err });
  }
}

async function exportPNG() {
  try {
    let svg;
    if (editorMode === 'dmn' && dmnModeler) {
      ({ svg } = await dmnModeler.saveSVG({ format: true }));
    } else if (bpmnModeler) {
      ({ svg } = await bpmnModeler.saveSVG({ format: true }));
    } else {
      return;
    }

    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);

    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

    const baseName = currentFileName.replace(/\.(bpmn|dmn)$/i, '');
    if (studio) {
      const buffer = await pngBlob.arrayBuffer();
      const res = await studio.exportFile({
        name: baseName + '.png',
        buffer
      });
      if (res && res.error) {
        showFsError(res);
        return;
      }
    } else {
      downloadBlob(pngBlob, baseName + '.png');
    }
    setStatus('已导出 PNG');
  } catch (err) {
    console.error(err);
    showError({ title: '导出 PNG 失败', message: err.message || String(err), error: err });
  }
}

function downloadText(content, name, mime) {
  downloadBlob(new Blob([content], { type: mime }), name);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 复制文本到剪贴板（navigator.clipboard → textarea + execCommand 兜底） */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  }
}

// --- dirty tracking -------------------------------------------------------------
// 相对「最近一次保存」是否被修改：用命令栈游标精确判定，零序列化开销。
// diagram-js 每次命令执行/撤销/重做都会推进 _stackIdx（导入会清栈并重置为 -1），
// 故「当前游标 ≠ 存档游标」即表示有未保存改动；撤销回保存点自动恢复干净。
// 注意: _stackIdx 是 diagram-js 内部字段，升级后需复核此假设（见下方注释处）。
let savedStackIdx = null;

function currentStackIdx() {
  if (!bpmnModeler) return null;
  try {
    return bpmnModeler.get('commandStack')._stackIdx;
  } catch { /* commandStack 服务不可用 */ }
  return null;
}

function onBpmnStackChanged() {
  // 从未保存过：无「脏」语义（新建文件编辑不显示星号，与既有行为一致）
  if (lastSavedXML === null) return;
  // 存档基准已失效（刚导入重建过命令栈）→ 只要有任何改动就算脏
  if (savedStackIdx === null) { setDirty(true); return; }
  setDirty(currentStackIdx() !== savedStackIdx);
}

function markSaved(xml) {
  lastSavedXML = xml;
  lastSavedAt = new Date();
  savedStackIdx = currentStackIdx();
  setDirty(false);
}

/**
 * 导入失败 → 恢复上一个可用模型后，精确重算脏标记。
 *
 * 失败导入会把命令栈 clear（触发 commandStack.changed），恢复导入同样清栈，
 * 两者都会让索引方案误判为脏；这里在恢复完成后做一次性的序列化比较（仅失败路径，
 * 开销可忽略），然后作废存档游标（此后编辑一律置脏，直至下次保存）。
 */
async function rebaseDirtyAfterRestore() {
  if (lastSavedXML === null) return;
  savedStackIdx = null;
  try {
    let xml;
    if (editorMode === 'dmn' && dmnModeler) {
      ({ xml } = await dmnModeler.saveXML({ format: true }));
    } else if (bpmnModeler) {
      ({ xml } = await bpmnModeler.saveXML({ format: true }));
    } else {
      return;
    }
    setDirty(xml !== lastSavedXML);
  } catch {
    setDirty(true);
  }
}

function setDirty(dirty) {
  isDirty = dirty;
  els.dirty.classList.toggle('hidden', !dirty);
  updateTitle();
}

// --- ui helpers -------------------------------------------------------------------
function updateTitle() {
  const title = currentFileName + (isDirty ? ' *' : '') + ' — BPMN Studio';
  document.title = title;
  if (studio) studio.setTitle(title);
}

function setStatus(text) {
  els.statusLeft.textContent = text;
}

function setZoomStatus() {
  if (!bpmnModeler) return;
  const canvas = bpmnModeler.get('canvas');
  const zoom = canvas.zoom();
  els.zoomLevel.textContent = Math.round(zoom * 100) + '%';
}

// --- metadata dialog --------------------------------------------------------------
function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function xmlBytes(xml) {
  try {
    return new TextEncoder().encode(xml || '').length;
  } catch {
    return (xml || '').length;
  }
}

function metaRow(label, value, mono = false) {
  const row = document.createElement('div');
  row.className = 'meta-grid';
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = (value == null || value === '') ? '—' : String(value);
  if (mono) dd.classList.add('mono');
  row.append(dt, dd);
  return row;
}

function metaSection(title) {
  const section = document.createElement('section');
  section.className = 'info-section';
  const h = document.createElement('h3');
  h.textContent = title;
  section.appendChild(h);
  return section;
}

function metaStat(num, label) {
  const stat = document.createElement('div');
  stat.className = 'stat';
  const n = document.createElement('div');
  n.className = 'num';
  n.textContent = String(num);
  const l = document.createElement('div');
  l.className = 'lbl';
  l.textContent = label;
  stat.append(n, l);
  return stat;
}

async function collectMetadata() {
  const file = {};
  const doc = {};
  const stats = {};

  // --- file level ---
  file.name = currentFileName;
  file.path = currentFilePath || '（未保存 / 浏览器环境）';
  file.dirty = isDirty ? '是（有未保存的修改）' : '否';
  file.savedAt = lastSavedAt ? lastSavedAt.toLocaleString() : '从未保存';

  if (studio && currentFilePath) {
    try {
      const st = await studio.statFile(currentFilePath);
      if (st) {
        file.size = formatBytes(st.size);
        file.modifiedAt = new Date(st.mtimeMs).toLocaleString();
      }
    } catch (err) {
      console.warn('statFile failed', err);
    }
  }
  if (!file.size && lastSavedXML) {
    file.size = formatBytes(xmlBytes(lastSavedXML));
    file.modifiedAt = '—';
  }

  // --- document level (bpmn:Definitions) ---
  const defs = bpmnModeler.getDefinitions();
  const attrs = defs.$attrs || {};
  const getAttr = (name) => {
    try {
      const v = defs.get(name);
      if (v != null && v !== '') return v;
    } catch { /* fall through */ }
    return attrs[name] || '—';
  };
  doc.definitionsId = defs.id || '—';
  doc.namespace = getAttr('targetNamespace');
  doc.exporter = getAttr('exporter');
  doc.exporterVersion = getAttr('exporterVersion');
  doc.platform = (PLATFORMS[currentPlatform] && PLATFORMS[currentPlatform].label) || '—';
  const execPlatform = attrs['modeler:executionPlatform'];
  const execVersion = attrs['modeler:executionPlatformVersion'];
  doc.executionPlatform = execPlatform ? `${execPlatform}${execVersion ? ' ' + execVersion : ''}` : '—';
  doc.definitionsCount = defs.rootElements ? defs.rootElements.length : 0;

  const rootBo = bpmnModeler.get('canvas').getRootElement().businessObject;
  const processes = (defs.rootElements || []).filter((re) => /Process$/.test(re.$type));
  const rootProcess = (rootBo && /Process$/.test(rootBo.$type)) ? rootBo : (processes[0] || null);
  doc.processName = (rootProcess && rootProcess.name) || '—';
  doc.processId = (rootProcess && rootProcess.id) || '—';
  doc.isExecutable = rootProcess ? String(rootProcess.isExecutable) : '—';
  const collaboration = (defs.rootElements || []).find((re) => re.$type === 'bpmn:Collaboration');
  doc.collaboration = collaboration ? `有（Participant: ${collaboration.participants.length}）` : '（单一流程，无泳道）';

  // --- stats ---
  const registry = bpmnModeler.get('elementRegistry');
  const all = registry.getAll();
  let shapes = 0;
  let connections = 0;
  const byType = {};
  for (const el of all) {
    const type = ((el.businessObject && el.businessObject.$type) || '').replace('bpmn:', '');
    if (!type) continue;
    byType[type] = (byType[type] || 0) + 1;
    if (el.waypoints) connections++;
    else shapes++;
  }
  stats.total = all.length;
  stats.shapes = shapes;
  stats.connections = connections;
  stats.byType = Object.entries(byType).sort((a, b) => b[1] - a[1]);

  return { file, doc, stats };
}

async function openMetadataDialog() {
  if (editorMode === 'dmn') {
    await openDmnMetadataDialog();
    return;
  }
  if (!bpmnModeler) return;
  const { file, doc, stats } = await collectMetadata();

  const content = els.infoContent;
  content.innerHTML = '';

  const fileSection = metaSection('文件信息');
  fileSection.append(
    metaRow('文件名', file.name, true),
    metaRow('文件路径', file.path, true),
    metaRow('是否已修改', file.dirty),
    metaRow('保存时间', file.savedAt),
    metaRow('文件大小', file.size, true),
    metaRow('磁盘修改时间', file.modifiedAt)
  );
  content.appendChild(fileSection);

  const docSection = metaSection('文档信息（bpmn:Definitions / bpmn:Process）');
  docSection.append(
    metaRow('Definitions ID', doc.definitionsId, true),
    metaRow('目标命名空间', doc.namespace, true),
    metaRow('导出工具', `${doc.exporter} ${doc.exporterVersion}`.trim(), true),
    metaRow('执行平台（本应用识别）', doc.platform),
    metaRow('执行平台（文件声明）', doc.executionPlatform, true),
    metaRow('顶级元素数', doc.definitionsCount),
    metaRow('流程名称', doc.processName),
    metaRow('流程 ID', doc.processId, true),
    metaRow('是否可执行', doc.isExecutable),
    metaRow('协作 / 泳道', doc.collaboration)
  );
  content.appendChild(docSection);

  const statSection = metaSection(`图表统计（共 ${stats.total} 个元素）`);
  const wrap = document.createElement('div');
  wrap.className = 'meta-stats';
  wrap.append(
    metaStat(stats.shapes, '节点'),
    metaStat(stats.connections, '连线'),
    metaStat(stats.byType.length, '元素类型')
  );
  statSection.appendChild(wrap);
  content.appendChild(statSection);

  if (stats.byType.length) {
    const typeSection = metaSection('元素类型明细');
    for (const [type, count] of stats.byType) {
      typeSection.append(metaRow(type, count, true));
    }
    content.appendChild(typeSection);
  }

  els.infoModal.classList.remove('hidden');
}

async function openDmnMetadataDialog() {
  if (!dmnModeler) return;

  const content = els.infoContent;
  content.innerHTML = '';

  // --- file level ---
  const fileSection = metaSection('文件信息');
  fileSection.append(
    metaRow('文件名', currentFileName, true),
    metaRow('文件路径', currentFilePath || '（未保存 / 浏览器环境）', true),
    metaRow('是否已修改', isDirty ? '是（有未保存的修改）' : '否'),
    metaRow('保存时间', lastSavedAt ? lastSavedAt.toLocaleString() : '从未保存'),
    metaRow('文件类型', 'DMN 决策模型')
  );
  content.appendChild(fileSection);

  // --- document level ---
  try {
    await dmnModeler.saveXML({ format: true });
    const defs = dmnModeler.getDefinitions();
    if (defs) {
      const docSection = metaSection('文档信息（dmn:Definitions）');
      docSection.append(
        metaRow('Definitions ID', defs.id || '—', true),
        metaRow('命名空间', (defs.$attrs && defs.$attrs.targetNamespace) || '—', true),
        metaRow('当前视图', currentDmnView)
      );
      content.appendChild(docSection);
    }

    // --- elements ---
    const registry = dmnGet('elementRegistry');
    if (registry) {
      const all = registry.getAll();
      const statSection = metaSection(`图表统计（共 ${all.length} 个元素）`);
      const byType = {};
      for (const el of all) {
        const type = ((el.businessObject && el.businessObject.$type) || '').replace('dmn:', '');
        if (type) byType[type] = (byType[type] || 0) + 1;
      }
      const wrap = document.createElement('div');
      wrap.className = 'meta-stats';
      wrap.append(metaStat(all.length, '总元素'));
      statSection.appendChild(wrap);

      for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
        statSection.append(metaRow(type, count, true));
      }
      content.appendChild(statSection);
    }
  } catch (err) {
    const errSection = metaSection('错误');
    errSection.append(metaRow('无法读取元数据', err.message || String(err)));
    content.appendChild(errSection);
  }

  els.infoModal.classList.remove('hidden');
}

function hideInfoModal() {
  els.infoModal.classList.add('hidden');
}

// --- XML view (full diagram XML + selection highlight) ----------------------------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** syntax-highlight one escaped XML tag string */
function highlightTag(tag) {
  let out = '';
  const name = tag.match(/^<\/?[^\s/>]+/);
  if (name) {
    out += `<span class="xml-tag">${name[0]}</span>`;
  }
  const rest = tag.slice(name ? name[0].length : 0);
  let last = 0;
  const attrRe = /([\w:.-]+)=("[^"]*"|'[^']*')/g;
  let m;
  while ((m = attrRe.exec(rest))) {
    out += `<span class="xml-punc">${rest.slice(last, m.index)}</span>`;
    out += `<span class="xml-attr">${m[1]}</span>`;
    out += `<span class="xml-punc">=</span>`;
    out += `<span class="xml-str">${m[2]}</span>`;
    last = attrRe.lastIndex;
  }
  out += `<span class="xml-tag">${rest.slice(last)}</span>`;
  return out;
}

/** syntax-highlight a snippet of raw XML; returns HTML */
function highlightXml(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      out += escapeHtml(text.slice(i));
      break;
    }
    out += escapeHtml(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      const stop = end === -1 ? n : end + 3;
      out += `<span class="xml-comment">${escapeHtml(text.slice(lt, stop))}</span>`;
      i = stop;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      const stop = end === -1 ? n : end + 2;
      out += `<span class="xml-pi">${escapeHtml(text.slice(lt, stop))}</span>`;
      i = stop;
    } else {
      // scan to the end of the tag, quotes-aware
      let end = lt + 1;
      let quote = null;
      while (end < n) {
        const c = text[end];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        end++;
      }
      const stop = Math.min(end + 1, n);
      out += highlightTag(escapeHtml(text.slice(lt, stop)));
      i = stop;
    }
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** locate the span [start,end) of the tag that opens with id=… / bpmnElement=… */
function findElementSpans(xml, id) {
  const spans = [];
  const re = new RegExp(
    `(<[^!?][^>]*?\\b(?:id|bpmnElement)\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*>)`,
    'g'
  );
  let m;
  while ((m = re.exec(xml))) {
    const openStart = m.index;
    const openEnd = openStart + m[1].length;
    const selfClosing = /\/\s*>$/.test(m[1]);
    const end = selfClosing ? openEnd : findTagEnd(xml, openEnd, m[1].match(/^<([^\s/>]+)/)[1]);
    spans.push({
      start: openStart,
      end,
      kind: /bpmnElement/.test(m[1]) ? 'di' : 'semantic'
    });
  }
  return spans;
}

/** find the end offset of `name` element starting right after its opening tag */
function findTagEnd(xml, fromIndex, name) {
  const re = new RegExp(`<(/?)\\s*${escapeRegExp(name)}\\b([^>]*)>`, 'g');
  re.lastIndex = fromIndex;
  let depth = 1;
  let m;
  while ((m = re.exec(xml))) {
    const closing = m[1] === '/';
    const selfClose = /\/\s*$/.test(m[2]);
    if (closing) {
      depth--;
      if (depth === 0) return re.lastIndex;
    } else if (!selfClose) {
      depth++;
    }
  }
  return xml.length;
}

function setXmlStatus(text) {
  els.xmlStatus.textContent = text;
}

function renderXmlView(spans) {
  const xml = currentXml;
  let html = '';
  let last = 0;
  let markIndex = 0;
  const ordered = spans.slice().sort((a, b) => a.start - b.start);
  for (const s of ordered) {
    if (s.start < last) continue;
    html += highlightXml(xml.slice(last, s.start));
    const cls = `xml-match${s.kind === 'di' ? ' di' : ''}${markIndex === 0 ? ' current' : ''}`;
    html += `<mark class="${cls}" data-kind="${s.kind}">${highlightXml(xml.slice(s.start, s.end))}</mark>`;
    last = s.end;
    markIndex++;
  }
  html += highlightXml(xml.slice(last));
  els.xmlCode.innerHTML = html;
}

function getCurrentSelection() {
  try {
    if (editorMode === 'dmn' && dmnModeler) {
      const selection = dmnGet('selection');
      return selection ? (selection.get() || []) : [];
    }
    if (bpmnModeler) {
      return bpmnModeler.get('selection').get() || [];
    }
  } catch {
    return [];
  }
  return [];
}

function applyXmlSelection(selection) {
  if (xmlDetached || !xmlVisible || !currentXml || xmlEditing) return;
  const ids = (selection || [])
    .map((el) => el && el.businessObject && el.businessObject.id)
    .filter(Boolean);
  if (!ids.length) {
    renderXmlView([]);
    setXmlStatus('未选中元素 — 在画布中选择一个节点/连线以定位其 XML 段落');
    return;
  }
  const spans = [];
  for (const id of new Set(ids)) {
    spans.push(...findElementSpans(currentXml, id));
  }
  renderXmlView(spans);

  const labels = [];
  if (spans.some((s) => s.kind === 'semantic')) labels.push('模型定义');
  if (spans.some((s) => s.kind === 'di')) labels.push('图形定义 (DI)');
  setXmlStatus(`已选中 ${ids.join(', ')} → 高亮 ${spans.length} 段（${labels.join(' + ') || '未找到'}）`);

  if (els.xmlAutoscroll.checked) {
    const mark = els.xmlCode.querySelector('mark.xml-match');
    if (mark && els.xmlViewer) {
      const mr = mark.getBoundingClientRect();
      const vr = els.xmlViewer.getBoundingClientRect();
      els.xmlViewer.scrollTop += mr.top - vr.top - els.xmlViewer.clientHeight / 2;
    }
  }
}

/** 行级高亮渲染（用于「查看导入失败的原始 XML」的脱离模式） */
function renderXmlViewAtLine(line) {
  const linesContent = String(currentXml || '').split('\n');
  const errIdx = Math.min(Math.max(0, (line || 1) - 1), Math.max(0, linesContent.length - 1));
  els.xmlCode.innerHTML = linesContent
    .map((l, i) =>
      i === errIdx ? `<mark class="xml-err-line">${highlightXml(l)}</mark>` : highlightXml(l)
    )
    .join('\n');
}

/** 在 XML 视图中以脱离模式展示导入失败的原始内容并高亮出错行 */
function viewFailedXmlInXmlView() {
  if (!lastFailedXml) return;
  currentXml = lastFailedXml;
  xmlDetached = true;
  xmlVisible = true;
  els.xmlPanel.classList.remove('hidden');
  $('#btn-xml').classList.add('active');
  hideError();
  if (lastFailedLocation && lastFailedLocation.line) {
    renderXmlViewAtLine(lastFailedLocation.line);
    setXmlStatus(`已显示导入失败的原始 XML — 第 ${lastFailedLocation.line} 行（第 ${lastFailedLocation.column} 列）出错（非当前模型内容）`);
  } else {
    renderXmlView([]);
    setXmlStatus('已显示导入失败的原始 XML（非当前模型内容）');
  }
  if (els.xmlViewer) els.xmlViewer.scrollTop = 0;
}

async function refreshXmlView() {
  // 任何一次模型同步刷新都退出「脱离模式」，恢复 XML 视图镜像活模型语义
  xmlDetached = false;
  if (!xmlVisible || xmlEditing) return;
  if (editorMode === 'dmn' && !dmnModeler) return;
  if (editorMode === 'bpmn' && !bpmnModeler) return;
  try {
    let xml;
    if (editorMode === 'dmn' && dmnModeler) {
      ({ xml } = await dmnModeler.saveXML({ format: true }));
    } else {
      ({ xml } = await bpmnModeler.saveXML({ format: true }));
    }
    currentXml = xml;
    applyXmlSelection(getCurrentSelection());
  } catch (err) {
    console.warn('refreshXmlView failed', err);
    setXmlStatus('XML 生成失败：' + (err.message || err));
  }
}

/** XML 面板开启时的模型同步刷新（节流沉淀高频命令事件，BPMN/DMN 共用） */
const debouncedXmlRefresh = debounce(() => {
  if (xmlVisible) refreshXmlView();
}, 500);

async function toggleXmlView() {
  xmlVisible = !xmlVisible;
  els.xmlPanel.classList.toggle('hidden', !xmlVisible);
  $('#btn-xml').classList.toggle('active', xmlVisible);
  if (xmlVisible) {
    await refreshXmlView();
  }
}

async function copyXml() {
  if (!currentXml) return;
  await copyTextToClipboard(currentXml);
  setXmlStatus('完整 XML 已复制到剪贴板');
}

// --- XML editing (contenteditable on #xml-code) -----------------------------
function setXmlEditMode(editing) {
  if (editing === xmlEditing) return;
  xmlEditing = editing;

  els.xmlCode.contentEditable = editing ? 'true' : 'false';
  els.xmlCode.classList.toggle('xml-editable', editing);
  $('#btn-xml-edit').classList.toggle('active', editing);
  $('#btn-xml-apply').classList.toggle('hidden', !editing);
  $('#btn-xml-revert').classList.toggle('hidden', !editing);
  $('#btn-xml-copy').classList.toggle('hidden', editing);

  if (editing) {
    setXmlStatus('编辑模式 — 直接修改高亮区域中的文本，Ctrl+Enter 或「应用修改」重新导入，Esc 放弃');
    els.xmlCode.focus();
  } else {
    applyXmlSelection(getCurrentSelection());
    setXmlStatus('已退出编辑模式');
  }
}

function getEditedXml() {
  return els.xmlCode.textContent;
}

async function applyXmlEdits() {
  const editedXml = getEditedXml();
  if (!editedXml.trim()) {
    showError({ title: 'XML 内容为空', message: '内容为空，无法应用。' });
    return;
  }

  // 预检（格式良好性 + BPMNDI 存在）——在触碰画布之前直接给出友好错误
  const preErr = precheckBpmnXml(editedXml);
  if (preErr) {
    showError({
      title: 'XML 预检失败',
      message: preErr.message + '\n请检查后重试。',
      error: preErr,
      warningObjects: [],
      parseLocation: null,
      failedXml: editedXml
    });
    return;
  }

  stopSimulationIfNeeded();
  try {
    // 快照先于 ensureModeler：平台切换会销毁旧 modeler
    const previousXml = await snapshotCurrentXml();
    const modeler = ensureModeler(editedXml);
    let warnings = [];
    try {
      ({ warnings } = await modeler.importXML(editedXml));
    } catch (err) {
      err.warnings = err.warnings || [];
      err.parseLocation = extractParseLocation(err);
      err.failedXml = editedXml;
      // 恢复上一个可用模型：失败导入已清空画布/替换 definitions
      await restorePreviousModel(modeler, previousXml);
      await rebaseDirtyAfterRestore();
      throw err;
    }

    // 与 setBpmnDiagram 相同的根元素可渲染校验
    assertRenderableBpmnRoot(modeler, warnings, editedXml);

    // 导入成功 = 命令栈已重建，旧存档游标作废（non-dirty 判定完全交由 onBpmnStackChanged）
    savedStackIdx = null;

    if (warnings && warnings.length) {
      console.warn('apply warnings', warnings);
      showNotice(`XML 已应用，但有 ${warnings.length} 条警告（部分内容可能无法解析）`, warnings);
    } else {
      hideNotice();
    }

    // keep file identity; edits are unsaved relative to last saved content
    lastSavedAt = null;
    setDirty(lastSavedXML !== null && editedXml !== lastSavedXML);

    setStatus('已应用 XML 修改（' + (PLATFORMS[currentPlatform] && PLATFORMS[currentPlatform].label) + '）');
    updateTitle();

    setXmlEditMode(false);
    await refreshXmlView();
    modeler.get('canvas').zoom('fit-viewport', 'auto');
    setXmlStatus('修改已应用并重新导入模型');
  } catch (err) {
    console.error(err);
    showError({
      title: '应用 XML 修改失败',
      message: err.message || String(err),
      error: err,
      warningObjects: err.warnings || [],
      parseLocation: err.parseLocation,
      failedXml: err.failedXml
    });
  }
}

// --- modeler event wiring -----------------------------------------------------------
function bindModelerEvents(modeler) {
  modeler.on('import.parse.complete', (event) => {
    // Rebuild back-references right after parsing — before the first lint
    // pass (linting listens to import.done, which fires later).
    rebuildFlowNodeBackrefs(event.definitions);
  });

  modeler.on('elements.changed', debounce(() => {
    // Keep back-references in sync with structural user edits
    // (connections created / removed / reconnected).
    // elements.changed 覆盖拖拽帧级元素更新，而重建是整树递归 + 数组重分配，
    // 因此节流合并；lint 为异步调度，重建先于其触达（scripts/verify/check-backref-fix.mjs 守门）。
    rebuildFlowNodeBackrefs(modeler.getDefinitions());
  }, 80));

  modeler.on('linting.completed', (event) => {
    renderLint(event.issues);
  });

  modeler.on('selection.changed', (event) => {
    const element = event.newSelection && event.newSelection[0];
    if (element) {
      els.statusRight.textContent = `${element.id} (${element.businessObject.$type.replace('bpmn:', '')})`;
    } else {
      els.statusRight.textContent = '';
    }
    if (xmlVisible) applyXmlSelection(event.newSelection || []);
  });

  modeler.on('canvas.viewbox.changed', debounce(setZoomStatus, 100));
  modeler.on('import.done', () => {
    if (bpmnModeler !== modeler) return;
    setZoomStatus();
    setStatus('导入完成');
  });

  modeler.on('commandStack.changed', onBpmnStackChanged);
  modeler.on('commandStack.changed', debouncedXmlRefresh);
}

// --- lint ---------------------------------------------------------------------------
/**
 * Determine whether an element ID belongs to a bpmn-js DI label shape
 * (e.g. "StartEvent_1_label", "EndEvent_1_label").
 *
 * bpmn-js registers these visual label wrappers inside the element
 * registry with the **same** $type as the parent shape (bpmn:StartEvent,
 * bpmn:EndEvent, …) but they have no incoming / outgoing sequence flows
 * at the semantic level.  Lint rules that inspect incoming / outgoing
 * therefore produce false positives ("Element is not connected",
 * "Element is an implicit end", …).
 *
 * Filtering them out of the lint results keeps the panel clean without
 * suppressing any real modelling issues.
 */
function isDiLabelElement(id) {
  return typeof id === 'string' && id.endsWith('_label');
}

/**
 * 依据 lint 问题在画布上定位元素（点击列表项触发）。
 *
 * 目标 id 优先取 issue.actualElementId（问题汇报在子流程/参与者内部时的真实目标）。
 * 若目标不在当前 plane（位于折叠子流程内），先沿语义树找到包含它的折叠子流程并展开，
 * 再选中；仍找不到时回退选中可见容器并给出状态提示。
 */
function locateLintIssue(visibleId, issue) {
  if (!bpmnModeler) return;
  const targetId = issue.actualElementId || visibleId;
  const registry = bpmnModeler.get('elementRegistry');

  let el = registry.get(targetId);
  if (!el) {
    const container = findSemanticParent(targetId);
    if (container && container.collapsed) {
      try {
        const modeling = bpmnModeler.get('modeling');
        if (typeof modeling.toggleCollapse === 'function') modeling.toggleCollapse(container);
      } catch { /* 展开失败不阻塞定位 */ }
      el = registry.get(targetId);
    }
    if (!el && container) el = container; // 兜底：至少选中所在子流程
  }

  if (el) {
    selectAndScroll(el);
    return;
  }

  const fallback = registry.get(visibleId) || bpmnModeler.get('canvas').getRootElement();
  if (fallback) selectAndScroll(fallback);
  setStatus(`无法定位问题元素 ${targetId}，已选中最近的容器`);
}

function selectAndScroll(el) {
  try {
    bpmnModeler.get('canvas').scrollToElement(el);
  } catch { /* canvas 未就绪时忽略 */ }
  try {
    bpmnModeler.get('selection').select(el);
  } catch { /* 无 selection 服务时忽略 */ }
}

/** 在语义树（flowElements，含递归）中查找包含 targetId 的可见容器 shape */
function findSemanticParent(targetId) {
  if (!bpmnModeler) return null;
  for (const shape of bpmnModeler.get('elementRegistry').getAll()) {
    if (shape.waypoints) continue;
    const bo = shape.businessObject;
    if (bo && bo.flowElements && containsTargetId(bo, targetId)) return shape;
  }
  return null;
}

function containsTargetId(container, id) {
  const flowElements = container.flowElements || [];
  for (const fe of flowElements) {
    if (fe.id === id) return true;
    if (fe.flowElements && containsTargetId(fe, id)) return true;
  }
  return false;
}

/** lint 问题行的元素 chip 文案（类型中文名 · 名称 (id)） */
function lintElementChipText(visibleId, issue) {
  const targetId = issue.actualElementId || visibleId;
  const registry = bpmnModeler && bpmnModeler.get('elementRegistry');
  const el = registry && registry.get(visibleId);
  const bo = el && el.businessObject;
  const parts = [];
  if (bo) {
    const type = elementTypeLabel(bo.$type);
    if (type) parts.push(type);
    if (bo.name) parts.push(bo.name);
  }
  parts.push(
    issue.actualElementId && issue.actualElementId !== visibleId
      ? `${issue.actualElementId}（子流程内）`
      : targetId
  );
  return parts.join(' · ');
}

function renderLint(issues) {
  const rows = [];
  const rules = new Set();
  let errors = 0;
  let warns = 0;
  let infos = 0;

  for (const id of Object.keys(issues || {})) {
    // Skip bpmn-js DI label shapes — 视觉包装元素，无语义入/出线，
    // 所有连通性规则都会在其上产生误报。
    if (isDiLabelElement(id)) continue;

    for (const issue of issues[id] || []) {
      const category = issue.category || 'warn';
      if (category === 'error') errors++;
      else if (category === 'warn') warns++;
      else infos++;
      if (issue.rule) rules.add(issue.rule);
      rows.push({ id, issue });
    }
  }

  rows.sort((a, b) =>
    categorySortWeight(a.issue.category) - categorySortWeight(b.issue.category) ||
    String(a.id).localeCompare(String(b.id))
  );

  const total = rows.length;
  els.lintSummary.textContent = total
    ? `${total} 个问题（${errors} 错误 / ${warns} 警告 / ${infos} 提示），${rules.size} 类规则`
    : '未发现问题 ✓';

  els.lintList.innerHTML = '';
  for (const { id, issue } of rows) {
    const rule = issue.rule || 'unknown';
    const info = ruleInfo(rule);

    const li = document.createElement('li');
    li.className = 'lint-issue';
    li.dataset.rule = rule;
    li.dataset.id = id;
    li.title = `${info.name} — ${info.suggestion}`;

    const badge = document.createElement('span');
    badge.className = `lint-badge ${issue.category || 'warn'}`;
    badge.textContent = lintCategoryLabel(issue.category);

    const msg = document.createElement('span');
    msg.className = 'lint-message';
    msg.textContent = issue.message || '';

    const chip = document.createElement('span');
    chip.className = 'elem-chip';
    chip.textContent = lintElementChipText(id, issue);

    const ruleName = document.createElement('span');
    ruleName.className = 'lint-rule';
    ruleName.textContent = info.name;
    const docLink = document.createElement('a');
    docLink.className = 'doc-link';
    docLink.href = info.docUrl;
    docLink.target = '_blank';
    docLink.rel = 'noopener noreferrer';
    docLink.textContent = '规则文档';

    li.append(badge, msg, chip, ruleName, docLink);
    li.addEventListener('click', () => locateLintIssue(id, issue));
    els.lintList.appendChild(li);
  }
}

function toggleLintPanel() {
  lintVisible = !lintVisible;
  els.lintPanel.classList.toggle('hidden', !lintVisible);
  $('#btn-lint').classList.toggle('active', lintVisible);
}

// --- token simulation ---------------------------------------------------------------
function stopSimulationIfNeeded() {
  if (simulateMode && bpmnModeler) toggleSimulation();
}

function toggleSimulation() {
  if (!bpmnModeler) return;
  simulateMode = !simulateMode;
  const toggleMode = bpmnModeler.get('toggleMode');
  const simulator = bpmnModeler.get('simulator');
  if (simulateMode) {
    simulator.reset();
    toggleMode.toggleMode(true);
    $('#btn-simulate').classList.add('active');
    $('#btn-simulate').textContent = '■ 停止';
    setStatus('令牌模拟运行中 — 点击元素查看令牌流动');
  } else {
    toggleMode.toggleMode(false);
    simulator.reset();
    $('#btn-simulate').classList.remove('active');
    $('#btn-simulate').textContent = '▶ 模拟';
    setStatus('模拟已停止');
  }
}

// --- minimap ---------------------------------------------------------------------------
function toggleMinimap() {
  if (!bpmnModeler) return;
  const minimap = bpmnModeler.get('minimap');
  minimap.toggle();
  $('#btn-minimap').classList.toggle('active', minimap.isOpen());
}

// --- properties panel collapse (right pane) ----------------------------------------------
const PANEL_STATE_KEY = 'bpmn-studio.panel-collapsed';
const PANEL_STATE_PREF = 'panel.collapsed';

function setPropertiesPanelCollapsed(collapsed) {
  els.panelRegion.classList.toggle('collapsed', collapsed);
  els.panelCollapseBtn.textContent = collapsed ? '«' : '»';
  els.panelCollapseBtn.title = collapsed ? '展开属性面板' : '收起属性面板';
  els.panelCollapseBtn.setAttribute('aria-label', els.panelCollapseBtn.title);
}

// Persist through the Electron main-process store when available: localStorage
// under a sandboxed file:// page is session-only (never flushed to disk). Plain
// browsers fall back to localStorage, where it does persist.
async function readPanelCollapsedState() {
  if (studio && typeof studio.getPreference === 'function') {
    try {
      const value = await studio.getPreference(PANEL_STATE_PREF);
      if (typeof value === 'boolean') return value;
    } catch { /* bridge unavailable */ }
  }
  try { return localStorage.getItem(PANEL_STATE_KEY) === '1'; } catch { return false; }
}

function writePanelCollapsedState(collapsed) {
  if (studio && typeof studio.setPreference === 'function') {
    studio.setPreference(PANEL_STATE_PREF, collapsed).catch(() => {});
  }
  try {
    localStorage.setItem(PANEL_STATE_KEY, collapsed ? '1' : '0');
  } catch { /* storage unavailable */ }
}

function togglePropertiesPanel() {
  const collapsed = !els.panelRegion.classList.contains('collapsed');
  setPropertiesPanelCollapsed(collapsed);
  writePanelCollapsedState(collapsed);
}

// --- search -----------------------------------------------------------------------------
function openSearch() {
  if (!bpmnModeler) return;
  bpmnModeler.get('searchPad').open();
}

// --- toolbar wiring ------------------------------------------------------------------------
$('#panel-collapse-btn').addEventListener('click', togglePropertiesPanel);
$('#btn-new').addEventListener('click', createNewDiagram);
$('#btn-open').addEventListener('click', openFile);
$('#btn-save').addEventListener('click', () => saveFile(false));
$('#btn-export-svg').addEventListener('click', exportSVG);
$('#btn-export-png').addEventListener('click', exportPNG);
$('#btn-undo').addEventListener('click', () => bpmnModeler && bpmnModeler.get('undo').undo());
$('#btn-redo').addEventListener('click', () => bpmnModeler && bpmnModeler.get('undo').redo());
$('#btn-zoom-in').addEventListener('click', () => { if (bpmnModeler) { bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 1.25); setZoomStatus(); }});
$('#btn-zoom-out').addEventListener('click', () => { if (bpmnModeler) { bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 0.8); setZoomStatus(); }});
$('#btn-zoom-fit').addEventListener('click', () => bpmnModeler && bpmnModeler.get('canvas').zoom('fit-viewport', 'auto'));
$('#btn-search').addEventListener('click', openSearch);
$('#btn-minimap').addEventListener('click', toggleMinimap);
$('#btn-simulate').addEventListener('click', toggleSimulation);
$('#btn-lint').addEventListener('click', toggleLintPanel);
$('#btn-lint-close').addEventListener('click', toggleLintPanel);
$('#btn-info').addEventListener('click', openMetadataDialog);
$('#btn-xml').addEventListener('click', toggleXmlView);
$('#btn-xml-copy').addEventListener('click', copyXml);
$('#btn-xml-close').addEventListener('click', toggleXmlView);
$('#btn-xml-edit').addEventListener('click', () => setXmlEditMode(!xmlEditing));
$('#btn-xml-apply').addEventListener('click', applyXmlEdits);
$('#btn-xml-revert').addEventListener('click', () => setXmlEditMode(false));
els.xmlCode.addEventListener('keydown', (e) => {
  // Prevent Enter from inserting <br> / <div> inside the code element
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    applyXmlEdits();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    setXmlEditMode(false);
  } else if (e.key === 'Enter' && xmlEditing) {
    e.preventDefault();
    // Insert a newline character at the cursor position
    document.execCommand('insertText', false, '\n');
  }
});

// error overlay / notice bar
$('#btn-error-close').addEventListener('click', hideError);
$('#btn-error-copy').addEventListener('click', copyError);
$('#btn-error-view-xml').addEventListener('click', viewFailedXmlInXmlView);
$('#btn-notice-close').addEventListener('click', hideNotice);
$('#btn-notice-details').addEventListener('click', () => {
  const warnings = els.noticeBar._warnings || [];
  showError({
    title: '导入完成，但有解析警告',
    message: `图表已加载，但解析器报告 ${warnings.length} 条警告，部分内容可能丢失。`,
    warningObjects: warnings
  });
});

// metadata modal
$('#btn-info-close').addEventListener('click', hideInfoModal);
$('#btn-info-done').addEventListener('click', hideInfoModal);
$('#btn-info-refresh').addEventListener('click', openMetadataDialog);

// close overlays with Escape
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!els.errorOverlay.classList.contains('hidden')) hideError();
  else if (!els.infoModal.classList.contains('hidden')) hideInfoModal();
  else if (!els.noticeBar.classList.contains('hidden')) hideNotice();
});

// --- diagnostics (copy-to-clipboard) -------------------------------------------
async function copyDmnDiagnosticInfo() {
  if (!dmnModeler) return;

  setStatus('正在收集 DMN 诊断信息…');
  const lines = [];

  lines.push('=== DMN Studio Diagnostics ===');
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`Mode: DMN`);
  lines.push(`File: ${currentFileName}`);
  lines.push(`Current View: ${currentDmnView}`);
  lines.push('');

  try {
    const { xml } = await dmnModeler.saveXML({ format: true });
    lines.push('--- XML Length ---');
    lines.push(`  ${xml.length} characters`);
    lines.push('');
  } catch (err) {
    lines.push(`--- XML Error --- ${err.message}`);
    lines.push('');
  }

  try {
    const registry = dmnGet('elementRegistry');
    const all = registry ? registry.getAll() : [];
    lines.push(`--- Element Registry (${all.length}) ---`);
    for (const el of all) {
      const type = (el.businessObject?.$type || '?').replace('dmn:', '');
      lines.push(`  ${el.id || '(no id)'} — ${type}`);
    }
    lines.push('');
  } catch (err) {
    lines.push(`--- Element Registry Error: ${err.message} ---`);
    lines.push('');
  }

  const text = lines.join('\n');
  await copyTextToClipboard(text);

  setStatus('DMN 诊断信息已复制到剪贴板');
}

async function copyDiagnosticInfo() {
  if (editorMode === 'dmn') {
    await copyDmnDiagnosticInfo();
    return;
  }
  if (!bpmnModeler) return;

  setStatus('正在收集诊断信息…');
  const lines = [];

  // ── basic info ──
  lines.push('=== BPMN Studio Diagnostics ===');
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`Platform: ${currentPlatform || 'unknown'}`);
  lines.push(`File: ${currentFileName}${isDirty ? ' (unsaved changes)' : ''}`);

  // ── versions ──
  lines.push('');
  lines.push('--- Versions ---');
  lines.push(`  bpmn-js: ${bpmnJsPkg.version}`);
  lines.push(`  bpmn-js-bpmnlint: ${bpmnJsBpmnlintPkg.version} (bundled rules: bpmnlint ${bpmnlintPkg.version})`);
  if (studio && studio.getVersions) {
    try {
      const v = await studio.getVersions();
      if (v) {
        lines.push(`  BPMN Studio: ${v.app} (Electron ${v.electron} / Chromium ${v.chrome} / Node ${v.node}, ${v.platform})`);
      }
    } catch { /* ignore */ }
  } else {
    lines.push(`  Runtime: browser (${navigator.userAgent})`);
  }
  lines.push('');

  // ── import warnings from the ORIGINAL file load (kept in the notice bar) ──
  const loadWarnings = els.noticeBar._warnings || [];
  if (loadWarnings.length) {
    lines.push(`--- Import Warnings (original load: ${loadWarnings.length}) ---`);
    loadWarnings.forEach(w => lines.push(`  ${w.message || String(w)}`));
    lines.push('');
  }

  // ── lint state (LIVE model — non-invasive, no re-import) ──
  // NOTE: BpmnModeler only proxies `on`/`off` to the eventBus — there is no
  // `modeler.once()`.  Subscribe via `eventBus.once()` instead.
  lines.push('--- Lint Issues ---');
  try {
    const lintModule = bpmnModeler.get('linting');
    let lintIssues = (lintModule && lintModule._issues) || {};
    let lintSource = 'last known state (completion event timed out — values may be stale)';

    // trigger one fresh, non-destructive lint pass and wait for its result
    const eventBus = bpmnModeler.get('eventBus');
    const result = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(null), 3000);
      eventBus.once('linting.completed', (ev) => {
        clearTimeout(timeout);
        resolve(ev);
      });
      if (typeof lintModule.update === 'function') {
        try {
          lintModule.update();
        } catch { /* ignore */ }
      }
    });

    if (result && result.issues) {
      lintIssues = result.issues;
      lintSource = 'fresh lint pass';
    }
    lines.push(`  collection: ${lintSource}`);

    try {
      const active = typeof lintModule.isActive === 'function' ? lintModule.isActive() : null;
      if (active !== null) {
        lines.push(`  overlays active: ${active}`);
      }
    } catch { /* ignore */ }

    // markers currently rendered on the canvas (what the user actually sees)
    try {
      const overlays = bpmnModeler.get('overlays');
      const marked = [];
      for (const el of bpmnModeler.get('elementRegistry').getAll()) {
        const ovs = overlays.get(el.id);
        if (ovs && ovs.length) marked.push(`${el.id}×${ovs.length}`);
      }
      lines.push(`  canvas markers: ${marked.length ? marked.join(', ') : 'none'}`);
    } catch { /* no overlay service */ }

    lines.push(`  rules configured: ${Object.keys(lintConfig.config.rules).length}`);

    if (lintIssues && Object.keys(lintIssues).length) {
      const filteredIds = [];
      const realIds = [];
      for (const id of Object.keys(lintIssues)) {
        (isDiLabelElement(id) ? filteredIds : realIds).push(id);
      }

      if (realIds.length) {
        let total = 0;
        for (const id of realIds) total += (lintIssues[id] || []).length;
        lines.push(`  ${total} issue(s) on ${realIds.length} element(s):`);
        for (const id of realIds) {
          for (const issue of (lintIssues[id] || [])) {
            const severity = issue.category || issue.severity || '?';
            lines.push(`  [${severity}] ${id} — ${issue.rule || '?'}: ${issue.message || ''}`);
          }
        }
      }

      if (filteredIds.length) {
        lines.push(`  (suppressed ${filteredIds.length} DI label false-positives: ${filteredIds.join(', ')})`);
      }
    } else {
      lines.push('  none ✓');
    }
    lines.push('');
  } catch (err) {
    lines.push(`  collection FAILED: ${err.message}`);
    lines.push('');
  }

  // ── element registry ──
  let elementCount = 0;
  try {
    const registry = bpmnModeler.get('elementRegistry');
    const all = registry.getAll();
    elementCount = all.length;
    lines.push(`--- Element Registry (${all.length}) ---`);
    const maxId = Math.max(6, ...all.map(e => e.id.length));
    for (const el of all) {
      const type = (el.businessObject?.$type || '?').replace('bpmn:', '');
      const inStr = (el.incoming || []).map(e => e.id).join(', ');
      const outStr = (el.outgoing || []).map(e => e.id).join(', ');
      const conn = el.waypoints ? 'conn' : 'shape';
      lines.push(`  ${el.id.padEnd(maxId + 2)} ${type.padEnd(20)} in=[${inStr}] out=[${outStr}] (${conn})`);
    }
    lines.push('');
  } catch (err) {
    lines.push(`--- Element Registry Error: ${err.message} ---`);
    lines.push('');
  }

  // ── model integrity ──
  lines.push('--- Model Integrity ---');
  try {
    const registry = bpmnModeler.get('elementRegistry');
    const all = registry.getAll();
    const problems = [];

    // (1) sequence flows whose source/target does not resolve
    for (const el of all) {
      const bo = el.businessObject;
      if (!bo || bo.$type !== 'bpmn:SequenceFlow') continue;
      const refId = (ref) => ref && (typeof ref === 'object' ? ref.id : ref);
      const src = refId(bo.sourceRef);
      const tgt = refId(bo.targetRef);
      if (!src || !registry.get(src)) {
        problems.push(`${el.id}: sourceRef ${src ? `unresolved (${src})` : 'missing'}`);
      }
      if (!tgt || !registry.get(tgt)) {
        problems.push(`${el.id}: targetRef ${tgt ? `unresolved (${tgt})` : 'missing'}`);
      }
    }

    // (2) back-reference population — the condition under which the
    //     connectivity rules (no-disconnected, no-implicit-start/end)
    //     report false positives
    const boBackrefMissing = [];
    for (const el of all) {
      const bo = el.businessObject;
      if (!bo || el.waypoints) continue;
      if (typeof bo.$instanceOf !== 'function' || !bo.$instanceOf('bpmn:FlowNode')) continue;
      const connected = (el.incoming || []).length > 0 || (el.outgoing || []).length > 0;
      const boRefs = (bo.incoming || []).length > 0 || (bo.outgoing || []).length > 0;
      if (connected && !boRefs) boBackrefMissing.push(el.id);
    }
    if (boBackrefMissing.length) {
      problems.push(`back-references missing on ${boBackrefMissing.length} connected flow node(s): ${boBackrefMissing.join(', ')} — connectivity lint rules report false positives here`);
    }

    // (3) model elements without a DI entry
    const noDi = all
      .filter(el => !el.di && !isDiLabelElement(el.id))
      .map(el => el.id);
    if (noDi.length) {
      problems.push(`no DI entry for: ${noDi.join(', ')}`);
    }

    if (problems.length) {
      for (const p of problems) lines.push(`  ✗ ${p}`);
    } else {
      lines.push('  all checks passed ✓');
    }
  } catch (err) {
    lines.push(`  check failed: ${err.message}`);
  }
  lines.push('');

  // ── definitions ──
  try {
    const defs = bpmnModeler.getDefinitions();
    lines.push('--- Definitions ---');
    lines.push(`  id: ${defs.id}`);
    lines.push(`  targetNamespace: ${defs.get('targetNamespace')}`);
    lines.push(`  exporter: ${defs.get('exporter') || '(none)'}`);
    lines.push(`  rootElements: ${(defs.rootElements || []).map(re => re.$type).join(', ')}`);
  } catch (err) {
    lines.push(`--- Definitions Error: ${err.message} ---`);
  }

  // ── copy to clipboard ──
  const text = lines.join('\n');
  await copyTextToClipboard(text);

  setStatus(`诊断信息已复制到剪贴板（${elementCount} 个元素）`);
}

$('#btn-diagnostic').addEventListener('click', copyDiagnosticInfo);
$('#btn-theme').addEventListener('click', toggleTheme);

// browser file open fallback
els.fileInput.addEventListener('change', async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  const content = await file.text();
  await openDiagramContent(content, file.name, null);
});

// --- drag & drop (browser & desktop) --------------------------------------------------------
els.canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  els.canvas.dataset.dragging = 'true';
});
els.canvas.addEventListener('dragleave', () => {
  delete els.canvas.dataset.dragging;
});
els.canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  delete els.canvas.dataset.dragging;
  const files = e.dataTransfer.files;
  if (!files.length) return;
  const file = files[0];
  const content = await file.text();
  await openDiagramContent(content, file.name, null);
});

// --- DMN view tab wiring ---------------------------------------------------
els.btnDmnDrd.addEventListener('click', () => switchDmnView('drd'));
els.btnDmnDecisionTable.addEventListener('click', () => switchDmnView('decisionTable'));
els.btnDmnLiteralExpression.addEventListener('click', () => switchDmnView('literalExpression'));

// --- menu actions (Electron) ------------------------------------------------------------------
if (studio) {
  studio.onMenu(async (action) => {
    switch (action) {
      case 'new': return createNewDiagram();
      case 'new-dmn': return createNewDmnDiagram();
      case 'open': return openFile();
      case 'save': return saveFile(false);
      case 'save-as': return saveFile(true);
      case 'export-svg': return exportSVG();
      case 'export-png': return exportPNG();
      case 'undo': {
        if (editorMode === 'dmn' && dmnModeler) {
          try { const u = dmnGet('undo'); if (u) u.undo(); } catch { /* ignore */ }
        } else if (bpmnModeler) {
          bpmnModeler.get('undo').undo();
        }
        return;
      }
      case 'redo': {
        if (editorMode === 'dmn' && dmnModeler) {
          try { const u = dmnGet('undo'); if (u) u.redo(); } catch { /* ignore */ }
        } else if (bpmnModeler) {
          bpmnModeler.get('undo').redo();
        }
        return;
      }
      case 'zoom-in': {
        if (editorMode === 'dmn' && dmnModeler) {
          try { const c = dmnGet('canvas'); if (c) c.zoom({ x: 0, y: 0 }, 1.25); } catch { /* ignore */ }
        } else if (bpmnModeler) {
          bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 1.25);
          setZoomStatus();
        }
        return;
      }
      case 'zoom-out': {
        if (editorMode === 'dmn' && dmnModeler) {
          try { const c = dmnGet('canvas'); if (c) c.zoom({ x: 0, y: 0 }, 0.8); } catch { /* ignore */ }
        } else if (bpmnModeler) {
          bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 0.8);
          setZoomStatus();
        }
        return;
      }
      case 'zoom-reset': {
        if (editorMode === 'dmn' && dmnModeler) {
          try { const c = dmnGet('canvas'); if (c) c.zoom(1, { x: 0, y: 0 }); } catch { /* ignore */ }
        } else if (bpmnModeler) {
          bpmnModeler.get('canvas').zoom(1, { x: 0, y: 0 });
          setZoomStatus();
        }
        return;
      }
      case 'zoom-fit': {
        if (editorMode === 'dmn' && dmnModeler) {
          try { const c = dmnGet('canvas'); if (c) c.zoom('fit-viewport', 'auto'); } catch { /* ignore */ }
        } else if (bpmnModeler) {
          bpmnModeler.get('canvas').zoom('fit-viewport', 'auto');
          setZoomStatus();
        }
        return;
      }
      case 'toggle-minimap': return toggleMinimap();
      case 'toggle-lint': return toggleLintPanel();
      case 'toggle-properties': return togglePropertiesPanel();
      case 'toggle-simulate': return toggleSimulation();
      case 'search': return openSearch();
      case 'file-info': return openMetadataDialog();
      case 'toggle-theme': return toggleTheme();
    }
  });
}

// --- app keyboard shortcuts (only when not typing) -----------------------------------------------
document.addEventListener('keydown', (e) => {
  const target = e.target;
  const typing =
    target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (typing) return;

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); createNewDiagram(); }
  else if (k === 'o') { e.preventDefault(); openFile(); }
  else if (k === 's') {
    e.preventDefault();
    e.shiftKey ? exportSVG() : saveFile(false);
  } else if (k === 'p' && e.shiftKey) { e.preventDefault(); exportPNG(); }
  else if (k === 'b' && e.shiftKey) { e.preventDefault(); togglePropertiesPanel(); }
  else if (k === 'f') { e.preventDefault(); openSearch(); }
  else if (k === 'd' && e.shiftKey) { e.preventDefault(); toggleTheme(); }
  else if (k === 'z') {
    e.preventDefault();
    if (editorMode === 'dmn' && dmnModeler) {
      try { const u = dmnGet('undo'); if (u) { e.shiftKey ? u.redo() : u.undo(); } } catch { /* ignore */ }
    } else if (bpmnModeler) {
      e.shiftKey ? bpmnModeler.get('undo').redo() : bpmnModeler.get('undo').undo();
    }
  }
  else if (k === 'y') {
    e.preventDefault();
    if (editorMode === 'dmn' && dmnModeler) {
      try { const u = dmnGet('undo'); if (u) u.redo(); } catch { /* ignore */ }
    } else if (bpmnModeler) {
      bpmnModeler.get('undo').redo();
    }
  }
});

// --- boot ------------------------------------------------------------------------------------
// restore persisted UI state (collapsed properties panel) before first diagram render
(async () => {
  try {
    if (await readPanelCollapsedState()) setPropertiesPanelCollapsed(true);
  } catch { /* never let boot fail on persistence */ }
  createNewDiagram();
})();