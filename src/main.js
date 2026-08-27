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

// packed by `npm run lint:pack` (bpmnlint-pack-config)
import lintConfig from './lint-config.js';

import initialDiagramXML from '../resources/newDiagram.bpmn?raw';

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
  infoModal: $('#info-modal'),
  infoContent: $('#info-content'),
  xmlPanel: $('#xml-panel'),
  xmlStatus: $('#xml-status'),
  xmlCode: $('#xml-code'),
  xmlViewer: $('#xml-viewer'),
  xmlAutoscroll: $('#xml-autoscroll')
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
let currentXml = '';

const studio = window.bpmnStudio || null;

// --- big error / notice overlay -------------------------------------------------
let lastError = null;

function showError({ title = '出错了', message = '发生未知错误', error, warningObjects = [] } = {}) {
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
  } else {
    lastError = { title, message, details: '', warnings: warningObjects };
  }

  els.errorTitle.textContent = lastError.title;
  els.errorMessage.textContent = lastError.message;
  els.errorStack.textContent = lastError.details || '（无额外信息）';

  els.errorWarnings.classList.toggle('hidden', !lastError.warnings.length);
  els.errorWarnings.innerHTML = '';
  for (const w of lastError.warnings) {
    const li = document.createElement('li');
    const text = w && (w.message || String(w));
    const el = document.createElement('span');
    el.textContent = text;
    li.appendChild(el);
    if (w && (w.line || w.column)) {
      const pos = document.createElement('code');
      pos.textContent = ` （第 ${w.line} 行, 第 ${w.column} 列）`;
      li.appendChild(pos);
    }
    els.errorWarnings.appendChild(li);
  }

  els.errorOverlay.classList.remove('hidden');
  console.error('[bpmn-studio]', lastError.title, lastError.message, error || '');
}

function hideError() {
  els.errorOverlay.classList.add('hidden');
  lastError = null;
}

async function copyError() {
  if (!lastError) return;
  const text = [
    lastError.title,
    lastError.message,
    lastError.details
  ].filter(Boolean).join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    setStatus('错误信息已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    setStatus('错误信息已复制到剪贴板');
  }
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

// --- diagram lifecycle -------------------------------------------------------
async function setDiagram(xml, name, filePath) {
  const modeler = ensureModeler(xml);

  let warnings;
  try {
    ({ warnings } = await modeler.importXML(xml));
  } catch (err) {
    err.warnings = err.warnings || [];
    throw err;
  }

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
      warningObjects: err.warnings || []
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
      warningObjects: err.warnings || []
    });
  }
}

// --- file open / save ---------------------------------------------------------
async function openFile() {
  if (studio) {
    const result = await studio.openDiagram();
    if (!result) return;
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
    ({ xml } = await bpmnModeler.saveXML({ format: true }));
  } catch (err) {
    console.error(err);
    showError({ title: '导出 XML 失败', message: err.message || String(err), error: err });
    return;
  }

  try {
    if (studio) {
      const result = await studio.saveDiagram({
        content: xml,
        defaultPath: forceAs ? currentFileName : (currentFilePath || currentFileName),
        forceAs
      });
      if (!result) return;
      currentFilePath = result.path;
      currentFileName = basename(result.path);
      markSaved(xml);
      setStatus('已保存: ' + currentFilePath);
    } else {
      downloadText(xml, currentFileName, 'application/bpmn20-xml');
      markSaved(xml);
    }
  } catch (err) {
    console.error(err);
    showError({ title: '保存文件失败', message: err.message || String(err), error: err });
  }
}

async function exportSVG() {
  try {
    const { svg } = await bpmnModeler.saveSVG({ format: true });
    if (studio) {
      await studio.exportFile({ name: currentFileName.replace(/\.bpmn$/i, '') + '.svg', content: svg });
    } else {
      downloadText(svg, currentFileName.replace(/\.bpmn$/i, '') + '.svg', 'image/svg+xml');
    }
    setStatus('已导出 SVG');
  } catch (err) {
    console.error(err);
    showError({ title: '导出 SVG 失败', message: err.message || String(err), error: err });
  }
}

async function exportPNG() {
  try {
    const { svg } = await bpmnModeler.saveSVG({ format: true });

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

    if (studio) {
      const buffer = await pngBlob.arrayBuffer();
      await studio.exportFile({
        name: currentFileName.replace(/\.bpmn$/i, '') + '.png',
        buffer
      });
    } else {
      downloadBlob(pngBlob, currentFileName.replace(/\.bpmn$/i, '') + '.png');
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

// --- dirty tracking -------------------------------------------------------------
const refreshDirty = debounce(async () => {
  try {
    const { xml } = await bpmnModeler.saveXML({ format: true });
    const dirty = lastSavedXML !== null && xml !== lastSavedXML;
    setDirty(dirty);
  } catch (err) {
    console.warn('saveXML for dirty check failed', err);
  }
}, 300);

function markSaved(xml) {
  lastSavedXML = xml;
  lastSavedAt = new Date();
  setDirty(false);
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
  if (!bpmnModeler) return [];
  try {
    return bpmnModeler.get('selection').get() || [];
  } catch {
    return [];
  }
}

function applyXmlSelection(selection) {
  if (!xmlVisible || !currentXml || xmlEditing) return;
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

async function refreshXmlView() {
  if (!bpmnModeler || !xmlVisible || xmlEditing) return;
  try {
    const { xml } = await bpmnModeler.saveXML({ format: true });
    currentXml = xml;
    applyXmlSelection(getCurrentSelection());
  } catch (err) {
    console.warn('refreshXmlView failed', err);
    setXmlStatus('XML 生成失败：' + (err.message || err));
  }
}

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
  try {
    await navigator.clipboard.writeText(currentXml);
    setXmlStatus('完整 XML 已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = currentXml;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    setXmlStatus('完整 XML 已复制到剪贴板');
  }
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

  // well-formedness pre-check (fast, browser-side)
  let parserError = '';
  try {
    const parsed = new DOMParser().parseFromString(editedXml, 'application/xml');
    const perr = parsed.getElementsByTagName('parsererror')[0];
    if (perr) parserError = perr.textContent.trim();
  } catch (err) {
    parserError = err.message;
  }
  if (parserError) {
    showError({
      title: 'XML 解析失败',
      message: '编辑后的内容不是格式良好的 XML，请检查后重试。',
      error: new Error(parserError),
      warningObjects: []
    });
    return;
  }

  stopSimulationIfNeeded();
  try {
    const modeler = ensureModeler(editedXml);
    let warnings = [];
    try {
      ({ warnings } = await modeler.importXML(editedXml));
    } catch (err) {
      err.warnings = err.warnings || [];
      throw err;
    }

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
      warningObjects: err.warnings || []
    });
  }
}

// --- modeler event wiring -----------------------------------------------------------
function bindModelerEvents(modeler) {
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

  modeler.on('commandStack.changed', refreshDirty);
  modeler.on('commandStack.changed', debounce(() => {
    if (xmlVisible) refreshXmlView();
  }, 500));
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

function renderLint(issues) {
  const counted = {};
  for (const id of Object.keys(issues || {})) {
    // Skip bpmn-js DI label shapes — they are visual-only wrappers and
    // have no semantic incoming / outgoing, so every connectivity rule
    // would produce a false positive on them.
    if (isDiLabelElement(id)) continue;

    for (const issue of issues[id] || []) {
      const key = issue.rule || 'unknown';
      counted[key] = (counted[key] || 0) + 1;
    }
  }

  const entries = Object.entries(counted).sort((a, b) => b[1] - a[1]);
  els.lintSummary.textContent = entries.length
    ? `${entries.reduce((n, [, c]) => n + c, 0)} 个问题，${entries.length} 类规则`
    : '未发现问题 ✓';

  els.lintList.innerHTML = '';
  for (const [rule, count] of entries) {
    const li = document.createElement('li');
    li.textContent = `${rule} — ${count}`;
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

// --- search -----------------------------------------------------------------------------
function openSearch() {
  if (!bpmnModeler) return;
  bpmnModeler.get('searchPad').open();
}

// --- toolbar wiring ------------------------------------------------------------------------
$('#btn-new').addEventListener('click', createNewDiagram);
$('#btn-open').addEventListener('click', openFile);
$('#btn-save').addEventListener('click', () => saveFile(false));
$('#btn-export-svg').addEventListener('click', exportSVG);
$('#btn-export-png').addEventListener('click', exportPNG);
$('#btn-undo').addEventListener('click', () => bpmnModeler && bpmnModeler.get('undo').undo());
$('#btn-redo').addEventListener('click', () => bpmnModeler && bpmnModeler.get('undo').redo());
$('#btn-zoom-in').addEventListener('click', () => bpmnModeler && bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 1.25));
$('#btn-zoom-out').addEventListener('click', () => bpmnModeler && bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 0.8));
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
async function copyDiagnosticInfo() {
  if (!bpmnModeler) return;

  setStatus('正在收集诊断信息…');
  const lines = [];

  // ── basic info ──
  lines.push('=== BPMN Studio Diagnostics ===');
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`Platform: ${currentPlatform || 'unknown'}`);
  lines.push(`File: ${currentFileName}`);
  lines.push('');

  // ── import warnings ──
  try {
    const { xml } = await bpmnModeler.saveXML({ format: true });
    const { warnings: importWarnings } = await bpmnModeler.importXML(xml);
    if (importWarnings.length) {
      lines.push('--- Import Warnings ---');
      importWarnings.forEach(w => lines.push(`  ${w.message || String(w)}`));
      lines.push('');
    }
  } catch (err) {
    lines.push(`--- Import Error --- ${err.message}`);
    lines.push('');
  }

  // wait for linting to finish after re-import
  let rawIssues = null;
  try {
    rawIssues = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(null), 2000);
      bpmnModeler.once('linting.completed', (ev) => {
        clearTimeout(timeout);
        resolve(ev.issues);
      });
      bpmnModeler.get('canvas').resized();
    });
  } catch { /* ignore */ }

  // ── lint issues ──
  if (rawIssues && Object.keys(rawIssues).length) {
    const filteredIds = [];
    const realIds = [];
    for (const id of Object.keys(rawIssues)) {
      (isDiLabelElement(id) ? filteredIds : realIds).push(id);
    }

    if (realIds.length) {
      lines.push('--- Lint Issues ---');
      for (const id of realIds) {
        for (const issue of (rawIssues[id] || [])) {
          lines.push(`  [${issue.severity || '?'}] ${id} — ${issue.rule || issue.id || '?'}: ${issue.message || issue.description || ''}`);
        }
      }
      lines.push('');
    }

    if (filteredIds.length) {
      lines.push(`(Suppressed ${filteredIds.length} DI label false-positives: ${filteredIds.join(', ')})`);
      lines.push('');
    }
  } else {
    lines.push('--- Lint Issues: none ✓ ---');
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
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  setStatus(`诊断信息已复制到剪贴板（${elementCount} 个元素）`);
}

$('#btn-diagnostic').addEventListener('click', copyDiagnosticInfo);

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

// --- menu actions (Electron) ------------------------------------------------------------------
if (studio) {
  studio.onMenu(async (action) => {
    switch (action) {
      case 'new': return createNewDiagram();
      case 'open': return openFile();
      case 'save': return saveFile(false);
      case 'save-as': return saveFile(true);
      case 'export-svg': return exportSVG();
      case 'export-png': return exportPNG();
      case 'undo': return bpmnModeler && bpmnModeler.get('undo').undo();
      case 'redo': return bpmnModeler && bpmnModeler.get('undo').redo();
      case 'zoom-in': return bpmnModeler && bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 1.25);
      case 'zoom-out': return bpmnModeler && bpmnModeler.get('canvas').zoom({ x: 0, y: 0 }, 0.8);
      case 'zoom-reset': return bpmnModeler && bpmnModeler.get('canvas').zoom(1, { x: 0, y: 0 });
      case 'zoom-fit': return bpmnModeler && bpmnModeler.get('canvas').zoom('fit-viewport', 'auto');
      case 'toggle-minimap': return toggleMinimap();
      case 'toggle-lint': return toggleLintPanel();
      case 'toggle-simulate': return toggleSimulation();
      case 'search': return openSearch();
      case 'file-info': return openMetadataDialog();
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
  else if (k === 'f') { e.preventDefault(); openSearch(); }
});

// --- boot ------------------------------------------------------------------------------------
createNewDiagram();