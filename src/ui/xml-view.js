/**
 * xml-view — XML 面板：全量 XML 渲染与语法高亮、选中元素定位、编辑态、脱离模式。
 *
 * 从 `src/main.js` 抽出的 M2 模块（渐进抽取，行为等价）。抽出的动机：这块逻辑
 * （约 360 行）与模型器生命周期无关，却长期堆在入口文件里；抽出后纯函数
 * （`escapeHtml` / `highlightXml` / `findElementSpans`）可被
 * `scripts/verify/unit-render-units.mjs` 直接断言，不必靠 CDP 黑盒回归。
 *
 * 职责边界（刻意为止）：
 *   - 本模块拥有 XML **视图**：渲染、高亮、编辑缓冲、脱离模式、面板开关。
 *   - 「应用修改」（`applyXmlEditsInner`）仍留在 main.js —— 那是**改模型**的命令，
 *     需要 modeler/平台/precheck/脏标记等一堆编辑器机械，不属于视图层。
 *     它只通过 `getEditedXml()` 取编辑缓冲。
 *
 * 状态语义：本模块自持 `xml/visible/editing/detached`，不再读 main.js 的模块级变量，
 * 依赖全部由 `createXmlView(deps)` 显式注入。
 */
import { debounce } from 'min-dash';

/**
 * @param {object} deps
 * @param {object} deps.els 缓存的 DOM 引用（需含 xmlPanel/xmlCode/xmlViewer/xmlStatus/xmlAutoscroll）
 * @param {(sel: string) => Element|null} deps.$
 * @param {(module: string) => any} deps.activeService 当前编辑器的服务查询（用于取 selection）
 * @param {() => any} deps.getActiveModeler
 * @param {() => Promise<string|null>} deps.saveActiveXml 当前模型序列化（null 表示无模型）
 * @param {(text: string) => Promise<void>} deps.copyTextToClipboard
 * @param {() => { xml: string|null, location: { line?: number, column?: number }|null }} deps.getLastFailed
 *        最近一次导入失败时的原始 XML 与解析位置（仍由 main.js 的 showError 维护）
 * @param {() => void} deps.hideError
 */
export function createXmlView({
  els,
  $,
  activeService,
  getActiveModeler,
  saveActiveXml,
  copyTextToClipboard,
  getLastFailed,
  hideError
}) {
  /** 当前展示的 XML 文本（活模型的镜像，或脱离模式下失败导入的原文） */
  let xml = '';
  let visible = false;
  let editing = false;
  /** 脱离模型只读态（展示导入失败的原始内容） */
  let detached = false;

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

  function setStatus(text) {
    els.xmlStatus.textContent = text;
  }

  function render(spans) {
    const text = xml;
    let html = '';
    let last = 0;
    let markIndex = 0;
    const ordered = spans.slice().sort((a, b) => a.start - b.start);
    for (const s of ordered) {
      if (s.start < last) continue;
      html += highlightXml(text.slice(last, s.start));
      const cls = `xml-match${s.kind === 'di' ? ' di' : ''}${markIndex === 0 ? ' current' : ''}`;
      html += `<mark class="${cls}" data-kind="${s.kind}">${highlightXml(text.slice(s.start, s.end))}</mark>`;
      last = s.end;
      markIndex++;
    }
    html += highlightXml(text.slice(last));
    els.xmlCode.innerHTML = html;
  }

  function getCurrentSelection() {
    try {
      const selection = activeService('selection');
      return selection ? (selection.get() || []) : [];
    } catch {
      return [];
    }
  }

  function applySelection(selection) {
    if (detached || !visible || !xml || editing) return;
    const ids = (selection || [])
      .map((el) => el && el.businessObject && el.businessObject.id)
      .filter(Boolean);
    if (!ids.length) {
      render([]);
      setStatus('未选中元素 — 在画布中选择一个节点/连线以定位其 XML 段落');
      return;
    }
    const spans = [];
    for (const id of new Set(ids)) {
      spans.push(...findElementSpans(xml, id));
    }
    render(spans);

    const labels = [];
    if (spans.some((s) => s.kind === 'semantic')) labels.push('模型定义');
    if (spans.some((s) => s.kind === 'di')) labels.push('图形定义 (DI)');
    setStatus(`已选中 ${ids.join(', ')} → 高亮 ${spans.length} 段（${labels.join(' + ') || '未找到'}）`);

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
  function renderAtLine(line) {
    const linesContent = String(xml || '').split('\n');
    const errIdx = Math.min(Math.max(0, (line || 1) - 1), Math.max(0, linesContent.length - 1));
    els.xmlCode.innerHTML = linesContent
      .map((l, i) =>
        i === errIdx ? `<mark class="xml-err-line">${highlightXml(l)}</mark>` : highlightXml(l)
      )
      .join('\n');
  }

  /** 在 XML 视图中以脱离模式展示导入失败的原始内容并高亮出错行 */
  function showFailedXml() {
    const { xml: failedXml, location } = getLastFailed();
    if (!failedXml) return;
    xml = failedXml;
    detached = true;
    visible = true;
    els.xmlPanel.classList.remove('hidden');
    $('#btn-xml').classList.add('active');
    hideError();
    if (location && location.line) {
      renderAtLine(location.line);
      setStatus(`已显示导入失败的原始 XML — 第 ${location.line} 行（第 ${location.column} 列）出错（非当前模型内容）`);
    } else {
      render([]);
      setStatus('已显示导入失败的原始 XML（非当前模型内容）');
    }
    if (els.xmlViewer) els.xmlViewer.scrollTop = 0;
  }

  async function refresh() {
    // 任何一次模型同步刷新都退出「脱离模式」，恢复 XML 视图镜像活模型语义
    detached = false;
    if (!visible || editing) return;
    if (!getActiveModeler()) return;
    try {
      const next = await saveActiveXml();
      if (next === null) return;
      xml = next;
      applySelection(getCurrentSelection());
    } catch (err) {
      console.warn('refreshXmlView failed', err);
      setStatus('XML 生成失败：' + (err.message || err));
    }
  }

  /** XML 面板开启时的模型同步刷新（节流沉淀高频命令事件，BPMN/DMN 共用） */
  const debouncedRefresh = debounce(() => {
    if (visible) refresh();
  }, 500);

  async function toggle() {
    visible = !visible;
    els.xmlPanel.classList.toggle('hidden', !visible);
    $('#btn-xml').classList.toggle('active', visible);
    if (visible) {
      await refresh();
    }
  }

  async function copy() {
    if (!xml) return;
    await copyTextToClipboard(xml);
    setStatus('完整 XML 已复制到剪贴板');
  }

  function setEditMode(next) {
    if (next === editing) return;
    editing = next;

    els.xmlCode.contentEditable = editing ? 'true' : 'false';
    els.xmlCode.classList.toggle('xml-editable', editing);
    $('#btn-xml-edit').classList.toggle('active', editing);
    $('#btn-xml-apply').classList.toggle('hidden', !editing);
    $('#btn-xml-revert').classList.toggle('hidden', !editing);
    $('#btn-xml-copy').classList.toggle('hidden', editing);

    if (editing) {
      setStatus('编辑模式 — 直接修改高亮区域中的文本，Ctrl+Enter 或「应用修改」重新导入，Esc 放弃');
      els.xmlCode.focus();
    } else {
      applySelection(getCurrentSelection());
      setStatus('已退出编辑模式');
    }
  }

  function getEditedXml() {
    return els.xmlCode.textContent;
  }

  /** 模型销毁 / 内容整体替换时调用：退出编辑态并清除脱离模式残留 */
  function resetState() {
    if (editing) setEditMode(false);
    detached = false;
  }

  return {
    // 状态查询（main.js 的模式切换与销毁路径需要）
    isVisible: () => visible,
    isEditing: () => editing,
    isDetached: () => detached,
    // 命令
    toggle,
    refresh,
    debouncedRefresh,
    setEditMode,
    applySelection,
    showFailedXml,
    copy,
    getEditedXml,
    resetState,
    /** 面板状态栏文案（applyXmlEditsInner 在应用成功后回写） */
    setStatus,
    // 纯函数（scripts/verify/unit-render-units.mjs 直接断言，勿删）
    escapeHtml,
    highlightXml,
    findElementSpans
  };
}
