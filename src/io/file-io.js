/**
 * file-io — 文件打开 / 保存 / 导出（SVG、PNG）与拖放入口。
 *
 * 从 `src/main.js` 抽出的 M1 模块（渐进抽取，行为等价）。这是抽取序列里风险最高的
 * 一块：`saveFile` 直接参与脏标记与关窗守护握手（Electron 主进程在 dirty 时拦截
 * close，渲染进程保存成功后回 `window:close-ok`），因此本模块**必须**保持原有的
 * 「先序列化 → 写盘 → markSaved → 状态栏」顺序与返回值语义。
 *
 * 职责边界：
 *   - 本模块拥有「字节如何进出磁盘/浏览器」以及打开对话框的编排。
 *   - 打开成功后的**模型切换**（setDiagram / 平台重建 / 跨模式回滚）留在 main.js，
 *     经 `openDiagramContent` 注入——那是编辑器生命周期，不属于文件层。
 *   - 脏标记与基线（`markSaved` / `setDirty` / `lastSavedXML`）仍由 main.js 持有，
 *     本模块只调用 `markSaved`。
 */

/** 路径末段（Windows 与 POSIX 分隔符都接受） */
export function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

/**
 * @param {object} deps
 * @param {object} deps.els 需含 fileInput
 * @param {() => any} deps.getBridge window.bpmnStudio（浏览器下为 null）
 * @param {() => boolean} deps.isModelBusy 模型导入/重建互斥标志
 * @param {() => string} deps.getMode 'bpmn' | 'dmn'
 * @param {() => string} deps.getFileName
 * @param {(name: string) => void} deps.setFileName
 * @param {() => string|null} deps.getFilePath
 * @param {(path: string) => void} deps.setFilePath
 * @param {() => Promise<string|null>} deps.saveActiveXml
 * @param {() => Promise<string|null>} deps.saveActiveSvg
 * @param {(xml: string) => void} deps.markSaved 播种保存基线并清脏
 * @param {(text: string) => void} deps.setStatus
 * @param {(payload: object) => void} deps.showError
 * @param {(result: object) => void} deps.showFsError
 * @param {(xml: string, name: string, path: string|null) => Promise<void>} deps.openDiagramContent
 */
export function createFileIO({
  els,
  getBridge,
  isModelBusy,
  getMode,
  getFileName,
  setFileName,
  getFilePath,
  setFilePath,
  saveActiveXml,
  saveActiveSvg,
  markSaved,
  setStatus,
  showError,
  showFsError,
  openDiagramContent
}) {
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

  function downloadText(content, name, mime) {
    downloadBlob(new Blob([content], { type: mime }), name);
  }

  async function openFile() {
    const bridge = getBridge();
    if (bridge) {
      // 对话框/读文件异常也给带上下文的错误卡（M7），不留给全局兜底
      let result;
      try {
        result = await bridge.openDiagram();
      } catch (err) {
        console.error(err);
        showError({ title: '读取文件失败', message: err.message || String(err), error: err });
        return;
      }
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

  /**
   * 保存当前图表。返回值表示是否真正完成保存（v0.1.10 关窗守护需要据此决定是否放行关闭）：
   * true = 已写入并 markSaved；false = 取消对话框/失败。
   */
  async function saveFile(forceAs = false) {
    // Fix 2：保存要序列化当前模型；导入/重建进行中读到半新半旧的内容会写出脏文件
    if (isModelBusy()) {
      setStatus('上一个操作仍在处理中，请稍候…');
      return false;
    }
    let xml;
    try {
      xml = await saveActiveXml();
      if (xml === null) return false;
    } catch (err) {
      console.error(err);
      showError({ title: '导出 XML 失败', message: err.message || String(err), error: err });
      return false;
    }

    const bridge = getBridge();
    const mode = getMode();
    const mime = mode === 'dmn' ? 'application/dmn+xml' : 'application/bpmn20-xml';

    try {
      if (bridge) {
        // Fix 6：已有已知路径且非「另存为」→ 直写文件，不再每次弹另存对话框
        //（与常规编辑器语义一致；也让关窗守护的「保存并关闭」不再二次弹框）
        if (!forceAs && getFilePath()) {
          const res = await bridge.saveDiagramDirect({
            path: getFilePath(),
            content: xml,
            mode
          });
          if (!res) return false;
          if (res.error) {
            showFsError(res);
            return false;
          }
          setFilePath(res.path);
          setFileName(basename(res.path));
          markSaved(xml);
          setStatus('已保存: ' + res.path);
        } else {
          // Fix 17：把当前模式告知主进程，过滤器默认项跟随模式（DMN 优先 .dmn）
          const result = await bridge.saveDiagram({
            content: xml,
            defaultPath: forceAs ? getFileName() : (getFilePath() || getFileName()),
            forceAs,
            mode
          });
          if (!result) return false;
          if (result.error) {
            showFsError(result);
            return false;
          }
          setFilePath(result.path);
          setFileName(basename(result.path));
          markSaved(xml);
          setStatus('已保存: ' + result.path);
        }
      } else {
        downloadText(xml, getFileName(), mime);
        markSaved(xml);
      }
    } catch (err) {
      console.error(err);
      showError({ title: '保存文件失败', message: err.message || String(err), error: err });
      return false;
    }
    return true;
  }

  async function exportSVG() {
    try {
      const svg = await saveActiveSvg();
      if (svg === null) return;
      const baseName = getFileName().replace(/\.(bpmn|dmn|xml)$/i, ''); // .xml 也算已知后缀（L12）
      const bridge = getBridge();
      if (bridge) {
        const res = await bridge.exportFile({ name: baseName + '.svg', content: svg });
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
      const svg = await saveActiveSvg();
      if (svg === null) return;

      const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);

      // 解码/绘制的任一路径（含 img.onerror）都必须释放 Object URL（M8）
      let pngBlob;
      try {
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
        pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      } finally {
        URL.revokeObjectURL(url);
      }

      const baseName = getFileName().replace(/\.(bpmn|dmn|xml)$/i, ''); // 同 L12
      const bridge = getBridge();
      if (bridge) {
        const buffer = await pngBlob.arrayBuffer();
        const res = await bridge.exportFile({
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

  /** 浏览器环境的文件选择兜底（Electron 下走原生对话框，不触发） */
  function bindFileInput() {
    els.fileInput.addEventListener('change', async () => {
      const file = els.fileInput.files[0];
      if (!file) return;
      let content;
      try {
        content = await file.text();
      } catch (err) {
        console.error(err);
        showError({ title: `读取文件失败：${file.name}`, message: err.message || String(err), error: err });
        return;
      }
      await openDiagramContent(content, file.name, null);
    });
  }

  /** 拖放打开；可传多个宿主（BPMN 与 DMN 画布都要绑） */
  function bindDropTargets(hosts) {
    for (const host of hosts) {
      host.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        host.dataset.dragging = 'true';
      });
      host.addEventListener('dragleave', () => {
        delete host.dataset.dragging;
      });
      host.addEventListener('drop', async (e) => {
        e.preventDefault();
        delete host.dataset.dragging;
        const files = e.dataTransfer.files;
        if (!files.length) return;
        const file = files[0];
        let content;
        try {
          content = await file.text();
        } catch (err) {
          console.error(err);
          showError({ title: `读取文件失败：${file.name}`, message: err.message || String(err), error: err });
          return;
        }
        await openDiagramContent(content, file.name, null);
      });
    }
  }

  return { openFile, saveFile, exportSVG, exportPNG, bindFileInput, bindDropTargets, basename };
}
