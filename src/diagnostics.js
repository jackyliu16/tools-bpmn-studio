/**
 * diagnostics — 「复制诊断信息」剪贴板载荷的收集与格式化。
 *
 * 从 `src/main.js` 抽出的 M4 模块（渐进抽取，行为等价）。原实现是两个巨型函数
 * （`copyDiagnosticInfo` 约 240 行、`copyDmnDiagnosticInfo` 约 44 行），现按
 * 「基本信息 / 版本 / 导入警告 / lint / 元素表 / 模型完整性 / definitions」
 * 分段，并把三段纯逻辑单独导出以便 `scripts/verify/unit-render-units.mjs` 直接断言：
 *   - `formatLintIssues`        —— lint 结果 → 文本行（含 DI-label 误报分离）
 *   - `modelIntegrityProblems`  —— 模型完整性检查（悬空引用/反向引用/缺 DI）
 *   - `elementLine`             —— 元素表行（定宽对齐）
 *
 * ⚠️ 输出文本是用户可见的剪贴板内容，格式（含空行顺序）必须逐字保持。
 *
 * 版本号刻意不由本模块 import package.json： 单元测试以裸 node 导入本模块，
 * 而 Node 对 JSON 导入要求 `with { type: 'json' }`（vite 下则不需要）——
 * 由 main.js（经 vite 打包）把版本字符串作为 `versions` 注入，两侧都能跑。
 */

/** lint issue 的严重级别（历史上有 category / severity 两种字段） */
export function severityOf(issue) {
  return issue.category || issue.severity || '?';
}

/** 元素表行的最大 id 宽度（下限 6，保证短 id 也有稳定缩进） */
export function maxIdLength(els) {
  return Math.max(6, ...els.map((e) => e.id.length));
}

/** 元素表单行（定宽对齐，便于人眼比对 in/out） */
export function elementLine(el, maxId) {
  const type = (el.businessObject?.$type || '?').replace('bpmn:', '');
  const inStr = (el.incoming || []).map((e) => e.id).join(', ');
  const outStr = (el.outgoing || []).map((e) => e.id).join(', ');
  const conn = el.waypoints ? 'conn' : 'shape';
  return `  ${el.id.padEnd(maxId + 2)} ${type.padEnd(20)} in=[${inStr}] out=[${outStr}] (${conn})`;
}

/** 最终载荷：行数组 → 文本 */
export function formatDiagnostics(lines) {
  return lines.join('\n');
}

/**
 * lint 结果 → 文本行（纯函数）。
 *
 * 分离真实元素与 DI-label 误报（bpmn-js 的 label wrapper 与父形状同 $type 但无
 * 语义 in/out，会让连通性规则误报）。返回 `{ lines, totalIssues, realCount, filteredIds }`
 * —— 计数供调用方拼状态栏文案。
 *
 * @param {Record<string, Array<{category?: string, severity?: string, rule?: string, message?: string}>>} lintIssues
 * @param {(id: string) => boolean} isDiLabelElement
 */
export function formatLintIssues(lintIssues, isDiLabelElement) {
  const lines = [];
  const filteredIds = [];
  const realIds = [];
  for (const id of Object.keys(lintIssues || {})) {
    (isDiLabelElement(id) ? filteredIds : realIds).push(id);
  }

  let totalIssues = 0;
  if (realIds.length) {
    for (const id of realIds) totalIssues += (lintIssues[id] || []).length;
    lines.push(`  ${totalIssues} issue(s) on ${realIds.length} element(s):`);
    for (const id of realIds) {
      for (const issue of (lintIssues[id] || [])) {
        lines.push(`  [${severityOf(issue)}] ${id} — ${issue.rule || '?'}: ${issue.message || ''}`);
      }
    }
  }

  if (filteredIds.length) {
    lines.push(`  (suppressed ${filteredIds.length} DI label false-positives: ${filteredIds.join(', ')})`);
  }

  return { lines, totalIssues, realCount: realIds.length, filteredIds };
}

/**
 * 模型完整性检查（纯函数，`getById` 由调用方注入 registry 查询）。
 *
 * 三类问题：
 *   1. SequenceFlow 的 sourceRef/targetRef 无法解析
 *   2. 已连线但 businessObject 反向引用缺失（连通性规则会在此误报）
 *   3. 元素没有 DI 条目（渲染不上画布）
 *
 * @param {Array<any>} all elementRegistry.getAll()
 * @param {(id: string) => any} getById
 * @param {(id: string) => boolean} isDiLabelElement
 * @returns {string[]} 问题描述（空数组表示全部通过）
 */
export function modelIntegrityProblems(all, getById, isDiLabelElement) {
  const problems = [];

  for (const el of all) {
    const bo = el.businessObject;
    if (!bo || bo.$type !== 'bpmn:SequenceFlow') continue;
    const refId = (ref) => ref && (typeof ref === 'object' ? ref.id : ref);
    const src = refId(bo.sourceRef);
    const tgt = refId(bo.targetRef);
    if (!src || !getById(src)) {
      problems.push(`${el.id}: sourceRef ${src ? `unresolved (${src})` : 'missing'}`);
    }
    if (!tgt || !getById(tgt)) {
      problems.push(`${el.id}: targetRef ${tgt ? `unresolved (${tgt})` : 'missing'}`);
    }
  }

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
    problems.push(
      `back-references missing on ${boBackrefMissing.length} connected flow node(s): ` +
      `${boBackrefMissing.join(', ')} — connectivity lint rules report false positives here`
    );
  }

  const noDi = all
    .filter((el) => !el.di && !isDiLabelElement(el.id))
    .map((el) => el.id);
  if (noDi.length) {
    problems.push(`no DI entry for: ${noDi.join(', ')}`);
  }

  return problems;
}

/**
 * @param {object} deps
 * @param {object} deps.els 需含 noticeBar
 * @param {() => string} deps.getMode
 * @param {() => any} deps.getBridge window.bpmnStudio（浏览器下为 null）
 * @param {() => any} deps.getBpmnModeler
 * @param {() => any} deps.getDmnModeler
 * @param {(service: string) => any} deps.getDmnService
 * @param {() => string} deps.getFileName
 * @param {() => string|null} deps.getPlatform
 * @param {() => boolean} deps.isDirty
 * @param {(text: string) => void} deps.setStatus
 * @param {(text: string) => Promise<void>} deps.copyTextToClipboard
 * @param {(id: string) => boolean} deps.isDiLabelElement
 * @param {() => number} deps.getLintRuleCount 已配置的 bpmnlint 规则数
 * @param {() => string} deps.getCurrentDmnView
 * @param {{bpmnJs: string, bpmnJsBpmnlint: string, bpmnlint: string}} deps.versions
 */
export function createDiagnostics({
  els,
  getMode,
  getBridge,
  getBpmnModeler,
  getDmnModeler,
  getDmnService,
  getFileName,
  getPlatform,
  isDirty,
  setStatus,
  copyTextToClipboard,
  isDiLabelElement,
  getLintRuleCount,
  getCurrentDmnView,
  versions
}) {
  // --- 分段：版本 ---
  async function versionLines() {
    const lines = [`  bpmn-js: ${versions.bpmnJs}`];
    lines.push(`  bpmn-js-bpmnlint: ${versions.bpmnJsBpmnlint} (bundled rules: bpmnlint ${versions.bpmnlint})`);
    const bridge = getBridge();
    if (bridge && bridge.getVersions) {
      try {
        const v = await bridge.getVersions();
        if (v) {
          lines.push(`  BPMN Studio: ${v.app} (Electron ${v.electron} / Chromium ${v.chrome} / Node ${v.node}, ${v.platform})`);
        }
      } catch { /* ignore */ }
    } else {
      lines.push(`  Runtime: browser (${navigator.userAgent})`);
    }
    return lines;
  }

  // --- 分段：lint（活模型，非破坏性，不重新导入）---
  async function lintSectionLines(modeler) {
    const lines = [];
    // NOTE: BpmnModeler only proxies `on`/`off` to the eventBus — there is no
    // `modeler.once()`.  Subscribe via `eventBus.once()` instead.
    const lintModule = modeler.get('linting');
    let lintIssues = (lintModule && lintModule._issues) || {};
    let lintSource = 'last known state (completion event timed out — values may be stale)';

    // trigger one fresh, non-destructive lint pass and wait for its result
    const eventBus = modeler.get('eventBus');
    const result = await new Promise((resolve) => {
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
      const overlays = modeler.get('overlays');
      const marked = [];
      for (const el of modeler.get('elementRegistry').getAll()) {
        const ovs = overlays.get(el.id);
        if (ovs && ovs.length) marked.push(`${el.id}×${ovs.length}`);
      }
      lines.push(`  canvas markers: ${marked.length ? marked.join(', ') : 'none'}`);
    } catch { /* no overlay service */ }

    lines.push(`  rules configured: ${getLintRuleCount()}`);

    if (lintIssues && Object.keys(lintIssues).length) {
      lines.push(...formatLintIssues(lintIssues, isDiLabelElement).lines);
    } else {
      lines.push('  none ✓');
    }
    return lines;
  }

  // 分段：元素表
  function registryLines(modeler) {
    const all = modeler.get('elementRegistry').getAll();
    const lines = [`--- Element Registry (${all.length}) ---`];
    const maxId = maxIdLength(all);
    for (const el of all) lines.push(elementLine(el, maxId));
    return { lines, count: all.length };
  }

  // 分段：模型完整性
  function integrityLines(modeler) {
    const registry = modeler.get('elementRegistry');
    const all = registry.getAll();
    const problems = modelIntegrityProblems(all, (id) => registry.get(id), isDiLabelElement);
    if (!problems.length) return ['  all checks passed ✓'];
    return problems.map((p) => `  ✗ ${p}`);
  }

  // 分段：definitions
  function definitionsLines(modeler) {
    const defs = modeler.getDefinitions();
    return [
      '--- Definitions ---',
      `  id: ${defs.id}`,
      `  targetNamespace: ${defs.get('targetNamespace')}`,
      `  exporter: ${defs.get('exporter') || '(none)'}`,
      `  rootElements: ${(defs.rootElements || []).map((re) => re.$type).join(', ')}`
    ];
  }

  async function copyDmn() {
    const modeler = getDmnModeler();
    if (!modeler) return;

    setStatus('正在收集 DMN 诊断信息…');
    const lines = [];

    lines.push('=== DMN Studio Diagnostics ===');
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push(`Mode: DMN`);
    lines.push(`File: ${getFileName()}`);
    lines.push(`Current View: ${getCurrentDmnView()}`);
    lines.push('');

    try {
      const { xml } = await modeler.saveXML({ format: true });
      lines.push('--- XML Length ---');
      lines.push(`  ${xml.length} characters`);
      lines.push('');
    } catch (err) {
      lines.push(`--- XML Error --- ${err.message}`);
      lines.push('');
    }

    try {
      const registry = getDmnService('elementRegistry');
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

    await copyTextToClipboard(formatDiagnostics(lines));
    setStatus('DMN 诊断信息已复制到剪贴板');
  }

  async function copyBpmn() {
    const modeler = getBpmnModeler();
    if (!modeler) return;

    setStatus('正在收集诊断信息…');
    const lines = [];

    // ── basic info ──
    lines.push('=== BPMN Studio Diagnostics ===');
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push(`Platform: ${getPlatform() || 'unknown'}`);
    lines.push(`File: ${getFileName()}${isDirty() ? ' (unsaved changes)' : ''}`);

    // ── versions ──
    lines.push('');
    lines.push('--- Versions ---');
    lines.push(...(await versionLines()));
    lines.push('');

    // ── import warnings from the ORIGINAL file load (kept in the notice bar) ──
    const loadWarnings = els.noticeBar._warnings || [];
    if (loadWarnings.length) {
      lines.push(`--- Import Warnings (original load: ${loadWarnings.length}) ---`);
      loadWarnings.forEach((w) => lines.push(`  ${w.message || String(w)}`));
      lines.push('');
    }

    // ── lint state (LIVE model — non-invasive, no re-import) ──
    lines.push('--- Lint Issues ---');
    try {
      lines.push(...(await lintSectionLines(modeler)));
      lines.push('');
    } catch (err) {
      lines.push(`  collection FAILED: ${err.message}`);
      lines.push('');
    }

    // ── element registry ──
    let elementCount = 0;
    try {
      const reg = registryLines(modeler);
      elementCount = reg.count;
      lines.push(...reg.lines);
      lines.push('');
    } catch (err) {
      lines.push(`--- Element Registry Error: ${err.message} ---`);
      lines.push('');
    }

    // ── model integrity ──
    lines.push('--- Model Integrity ---');
    try {
      lines.push(...integrityLines(modeler));
    } catch (err) {
      lines.push(`  check failed: ${err.message}`);
    }
    lines.push('');

    // ── definitions ──
    try {
      lines.push(...definitionsLines(modeler));
    } catch (err) {
      lines.push(`--- Definitions Error: ${err.message} ---`);
    }

    await copyTextToClipboard(formatDiagnostics(lines));
    setStatus(`诊断信息已复制到剪贴板（${elementCount} 个元素）`);
  }

  async function copy() {
    if (getMode() === 'dmn') {
      await copyDmn();
      return;
    }
    await copyBpmn();
  }

  return {
    copy,
    copyBpmn,
    copyDmn
  };
}
