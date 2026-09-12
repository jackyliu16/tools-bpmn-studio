/**
 * metadata-dialog — 「文件与图表元数据」弹窗（文件信息 / 文档信息 / 图表统计）。
 *
 * 从 `src/main.js` 抽出的 M3 模块（渐进抽取，行为等价）。BPMN 与 DMN 两个分支
 * 各自收集再渲染，共用 `metaRow`/`metaSection`/`metaStat` 构件与 `fileInfoRows`。
 *
 * 依赖方向：本模块**不读** main.js 的模块级可变状态，全部经 getter 注入，
 * 因此 main.js 的变量改名不会静默影响本模块。
 */

/**
 * @param {object} deps
 * @param {object} deps.els 需含 infoModal / infoContent
 * @param {() => string} deps.getMode 'bpmn' | 'dmn'
 * @param {() => any} deps.getBridge preload 注入的 window.bpmnStudio（浏览器下为 null）
 * @param {() => any} deps.getBpmnModeler
 * @param {() => any} deps.getDmnModeler
 * @param {(service: string) => any} deps.getDmnService 当前 DMN 视图的 diagram-js 服务查询
 * @param {() => string} deps.getFileName
 * @param {() => string|null} deps.getFilePath
 * @param {() => boolean} deps.isDirty
 * @param {() => Date|null} deps.getLastSavedAt
 * @param {() => string|null} deps.getLastSavedXml
 * @param {() => string} deps.getPlatformLabel 执行平台标签（无平台时为 '—'）
 * @param {() => string} deps.getCurrentDmnView
 */
export function createMetadataDialog({
  els,
  getMode,
  getBridge,
  getBpmnModeler,
  getDmnModeler,
  getDmnService,
  getFileName,
  getFilePath,
  isDirty,
  getLastSavedAt,
  getLastSavedXml,
  getPlatformLabel,
  getCurrentDmnView
}) {
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

  /** 文件信息区公共行（BPMN/DMN 元数据弹窗共用） */
  function fileInfoRows(extra = []) {
    const savedAt = getLastSavedAt();
    return [
      metaRow('文件名', getFileName(), true),
      metaRow('文件路径', getFilePath() || '（未保存 / 浏览器环境）', true),
      metaRow('是否已修改', isDirty() ? '是（有未保存的修改）' : '否'),
      metaRow('保存时间', savedAt ? savedAt.toLocaleString() : '从未保存')
    ].concat(extra);
  }

  async function collectMetadata() {
    const file = {};
    const doc = {};
    const stats = {};

    // --- file level ---
    const bridge = getBridge();
    const filePath = getFilePath();
    if (bridge && filePath) {
      try {
        const st = await bridge.statFile(filePath);
        if (st) {
          file.size = formatBytes(st.size);
          file.modifiedAt = new Date(st.mtimeMs).toLocaleString();
        }
      } catch (err) {
        console.warn('statFile failed', err);
      }
    }
    const lastSavedXml = getLastSavedXml();
    if (!file.size && lastSavedXml) {
      file.size = formatBytes(xmlBytes(lastSavedXml));
      file.modifiedAt = '—';
    }

    // --- document level (bpmn:Definitions) ---
    const modeler = getBpmnModeler();
    const defs = modeler.getDefinitions();
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
    doc.platform = getPlatformLabel();
    const execPlatform = attrs['modeler:executionPlatform'];
    const execVersion = attrs['modeler:executionPlatformVersion'];
    doc.executionPlatform = execPlatform ? `${execPlatform}${execVersion ? ' ' + execVersion : ''}` : '—';
    doc.definitionsCount = defs.rootElements ? defs.rootElements.length : 0;

    const rootBo = modeler.get('canvas').getRootElement().businessObject;
    const processes = (defs.rootElements || []).filter((re) => /Process$/.test(re.$type));
    const rootProcess = (rootBo && /Process$/.test(rootBo.$type)) ? rootBo : (processes[0] || null);
    doc.processName = (rootProcess && rootProcess.name) || '—';
    doc.processId = (rootProcess && rootProcess.id) || '—';
    doc.isExecutable = rootProcess ? String(rootProcess.isExecutable) : '—';
    const collaboration = (defs.rootElements || []).find((re) => re.$type === 'bpmn:Collaboration');
    doc.collaboration = collaboration ? `有（Participant: ${collaboration.participants.length}）` : '（单一流程，无泳道）';

    // --- stats ---
    const registry = modeler.get('elementRegistry');
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

  async function openDmnMetadataDialog() {
    if (!getDmnModeler()) return;

    const content = els.infoContent;
    content.innerHTML = '';

    // --- file level ---
    const fileSection = metaSection('文件信息');
    fileSection.append(
      ...fileInfoRows([metaRow('文件类型', 'DMN 决策模型')])
    );
    content.appendChild(fileSection);

    // --- document level ---
    try {
      await getDmnModeler().saveXML({ format: true });
      const defs = getDmnModeler().getDefinitions();
      if (defs) {
        const docSection = metaSection('文档信息（dmn:Definitions）');
        docSection.append(
          metaRow('Definitions ID', defs.id || '—', true),
          metaRow('命名空间', (defs.$attrs && defs.$attrs.targetNamespace) || '—', true),
          metaRow('当前视图', getCurrentDmnView())
        );
        content.appendChild(docSection);
      }

      // --- elements ---
      const registry = getDmnService('elementRegistry');
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

  async function open() {
    if (getMode() === 'dmn') {
      await openDmnMetadataDialog();
      return;
    }
    if (!getBpmnModeler()) return;
    const { file, doc, stats } = await collectMetadata();

    const content = els.infoContent;
    content.innerHTML = '';

    const fileSection = metaSection('文件信息');
    fileSection.append(
      ...fileInfoRows([
        metaRow('文件大小', file.size, true),
        metaRow('磁盘修改时间', file.modifiedAt)
      ])
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

  function hide() {
    els.infoModal.classList.add('hidden');
  }

  return { open, hide, collectMetadata };
}
