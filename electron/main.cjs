/**
 * bpmn-studio — Electron main process.
 *
 * Provides the native shell: window, application menu, and file open/save
 * dialogs. The heavy lifting (bpmn-js modeler UI) lives entirely in the
 * bundled renderer (dist/index.html).
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;

const DEFAULT_WINDOW = { width: 1480, height: 920 };
const MIN_WINDOW = { width: 940, height: 560 };

// --- window state persistence ------------------------------------------------
// 记忆窗口大小/位置/最大化状态，重启后恢复（首次启动保持「最大化」的既有行为）。
// 单独存 window-state.json，避免与渲染进程用的 prefs:get/set 键值混在一起。
function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), 'utf-8'));
    if (!state || !state.bounds || typeof state.bounds.width !== 'number') return null;
    return state;
  } catch {
    return null;
  }
}

/** 原子写（Fix 4）：同目录临时文件 + rename —— rename 在同目录内是原子操作，
 * 崩溃/磁盘满发生在写入中途时原文件保持旧内容，不会被截断为空文件/半截内容。
 * fs.promises 无原子接口，这是标准最小实现。 */
async function writeFileAtomic(filePath, data, encoding) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  try {
    await fs.promises.writeFile(tmp, data, encoding);
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => { /* 清理尽力而为 */ });
    throw err;
  }
}

function writeFileAtomicSync(filePath, data, encoding) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, data, encoding);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理尽力而为 */ }
    throw err;
  }
}

function saveWindowState(win) {
  try {
    const bounds = win.getNormalBounds();
    const state = {
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: Math.max(MIN_WINDOW.width, Math.round(bounds.width)),
        height: Math.max(MIN_WINDOW.height, Math.round(bounds.height))
      },
      maximized: win.isMaximized()
    };
    fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true });
    writeFileAtomicSync(windowStateFile(), JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('saveWindowState failed', err);
  }
}

/** 保存的窗口区域是否至少与某个显示器的工作区相交（防拔屏后窗口开到屏外） */
function boundsVisible(bounds) {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const wa = d.workArea;
    return bounds.x < wa.x + wa.width && bounds.x + bounds.width > wa.x &&
           bounds.y < wa.y + wa.height && bounds.y + bounds.height > wa.y;
  });
}

function createWindow() {
  const saved = loadWindowState();
  const restoreBounds = saved && saved.bounds && boundsVisible(saved.bounds);
  const winBounds = restoreBounds ? saved.bounds : DEFAULT_WINDOW;

  const win = new BrowserWindow({
    width: winBounds.width,
    height: winBounds.height,
    x: restoreBounds ? saved.bounds.x : undefined,
    y: restoreBounds ? saved.bounds.y : undefined,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    backgroundColor: '#f6f7f9',
    title: 'BPMN Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 无存档状态时启动最大化（既有行为）；有存档则按存档恢复（含最大化）
  if (!restoreBounds || saved.maximized !== false) {
    win.maximize();
  }

  // 导航守卫（M10）：应用内容完全本地，任何偏离本页的导航/开窗都是非预期行为
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 未保存变更关窗守护（v0.1.10）：渲染进程通过 window:dirty-state 推送脏标记；
  // 脏且未放行时拦截关闭，弹三选框（取消/保存并关闭/放弃变更）。
  win.on('close', (e) => {
    saveWindowState(win);
    if (!win.__studioDirty || win.__studioAllowClose) return;
    e.preventDefault();
    // Fix 14：连续关闭（Ctrl+W 双击 / WM 与菜单叠加）不得叠加多个模态框
    if (win.__studioClosePrompt) return;
    win.__studioClosePrompt = true;
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '保存并关闭', '放弃变更'],
      defaultId: 0,
      cancelId: 0,
      message: '有未保存的变更',
      detail: `关闭「${win.getTitle().replace(/ \*? — BPMN Studio$/, '')}」将丢失未保存的编辑。`
    }).then(({ response }) => {
      if (response === 1) {
        // 保存并关闭：渲染进程执行 saveFile，成功后回 window:close-ok 再关
        win.webContents.send('window:save-then-close');
      } else if (response === 2) {
        win.__studioAllowClose = true;
        win.close();
      }
      // response === 0（取消）：什么都不做，窗口保持打开
    }).finally(() => {
      win.__studioClosePrompt = false;
    });
  });

  // BPMN_STUDIO_DEBUG=1 → 附加 ?debug 启用渲染端 debugGlobals（CDP 验证脚本取 __bpmnModeler）
  const loadOptions = process.env.BPMN_STUDIO_DEBUG === '1' ? { query: { debug: '1' } } : undefined;
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), loadOptions);
  return win;
}

function sendToFocused(action) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('menu:action', action);
}

// 视图复选框真实状态（L3）：渲染进程是唯一真相源（工具栏/快捷键/收纳轨道都能改），
// 菜单项初始 checked 只是占位；启动后由渲染进程 pushViewChecks 推平并经重建菜单回同步。
const viewChecks = { minimap: true, lint: false, properties: true };

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建 BPMN 图', accelerator: 'CmdOrCtrl+N', click: () => sendToFocused('new') },
        { label: '新建 DMN 图', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendToFocused('new-dmn') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => sendToFocused('open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendToFocused('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendToFocused('save-as') },
        { type: 'separator' },
        { label: '文件与图表元数据…', accelerator: 'CmdOrCtrl+Alt+I', click: () => sendToFocused('file-info') },
        { type: 'separator' },
        { label: '导出 SVG…', click: () => sendToFocused('export-svg') },
        { label: '导出 PNG…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendToFocused('export-png') },
        { type: 'separator' },
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', role: 'close' },
        isDev ? { role: 'reload' } : null,
        { role: 'quit', label: '退出' }
      ].filter(Boolean)
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => sendToFocused('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', click: () => sendToFocused('redo') },
        { type: 'separator' },
        { label: '搜索元素…', accelerator: 'CmdOrCtrl+F', click: () => sendToFocused('search') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => sendToFocused('zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => sendToFocused('zoom-out') },
        { label: '重置缩放 (100%)', click: () => sendToFocused('zoom-reset') },
        { label: '适应画布', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendToFocused('zoom-fit') },
        { type: 'separator' },
        {
          label: '小地图',
          type: 'checkbox',
          checked: viewChecks.minimap,
          click: () => sendToFocused('toggle-minimap')
        },
        {
          label: '模型校验面板',
          type: 'checkbox',
          checked: viewChecks.lint,
          click: () => sendToFocused('toggle-lint')
        },
        {
          label: '属性面板（右侧）',
          type: 'checkbox',
          checked: viewChecks.properties,
          click: () => sendToFocused('toggle-properties')
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '模拟',
      submenu: [
        { label: '开始 / 停止令牌模拟', accelerator: 'CmdOrCtrl+Space', click: () => sendToFocused('toggle-simulate') }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 BPMN Studio',
          click: () => {
            dialog.showMessageBox(BrowserWindow.getAllWindows()[0], {
              type: 'info',
              title: '关于',
              message: `BPMN Studio v${app.getVersion()}`,
              detail:
                '基于 bpmn-js 18 的全功能 BPMN 2.0 建模器。\n\n' +
                '核心能力: 完整建模工具、属性面板 (BPMN/Camunda Platform/Zeebe)、' +
                '模型校验 (bpmnlint)、令牌模拟、小地图、颜色、文件元数据、大号错误提示。\n' +
                `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC: file dialogs ------------------------------------------------------
// file:stat 只允许查询本会话中通过对话框打开/保存过的路径（M11）：
// 任意路径 stat 会泄露存在性/大小/修改时间。对话框结果由系统产生，作为唯一信任源。
const statAllowedPaths = new Set();

ipcMain.handle('dialog:open-diagram', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: '打开图表',
    filters: [
      { name: 'BPMN 文件', extensions: ['bpmn'] },
      { name: 'DMN 文件', extensions: ['dmn'] },
      { name: 'XML 文件', extensions: ['xml'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  statAllowedPaths.add(filePath);
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { path: filePath, content };
  } catch (err) {
    // 结构化返回，避免 IPC 拒绝丢失错误码（renderer 据此给出中文可读提示）
    return { error: { code: err.code || 'UNKNOWN', syscall: err.syscall, message: err.message } };
  }
});

ipcMain.handle('dialog:save-diagram', async (event, payload) => {
  const { content, defaultPath, forceAs, mode } = payload || {};
  const win = BrowserWindow.fromWebContents(event.sender);

  // Fix 17：默认过滤器跟随当前编辑模式——DMN 模式的保存框不再把 .bpmn 顶在首位
  const bpmnFilter = { name: 'BPMN 文件', extensions: ['bpmn'] };
  const dmnFilter = { name: 'DMN 文件', extensions: ['dmn'] };
  const xmlFilter = { name: 'XML 文件', extensions: ['xml'] };

  const result = await dialog.showSaveDialog(win, {
    title: forceAs ? '另存为' : '保存图表',
    defaultPath: defaultPath || 'diagram.bpmn',
    filters: mode === 'dmn' ? [dmnFilter, bpmnFilter, xmlFilter] : [bpmnFilter, dmnFilter, xmlFilter]
  });

  if (result.canceled || !result.filePath) return null;

  try {
    await writeFileAtomic(result.filePath, content, 'utf-8');
    statAllowedPaths.add(result.filePath);
    return { path: result.filePath };
  } catch (err) {
    return { error: { code: err.code || 'UNKNOWN', syscall: err.syscall, message: err.message } };
  }
});

// 已知路径直写保存（Fix 6）：渲染进程只能提交当前文件路径（均来自对话框往返），
// 主进程按对话框信任集（与 file:stat 的 M11 白名单同一语义）校验后原子写。
// 不允许任意路径直写，避免渲染进程被利用为任意文件写入原语。
ipcMain.handle('dialog:save-diagram-direct', async (event, payload) => {
  const { path: targetPath, content } = payload || {};
  if (typeof content !== 'string') {
    return { error: { code: 'EINVAL', message: '缺少文件内容' } };
  }
  if (typeof targetPath !== 'string' || !statAllowedPaths.has(targetPath)) {
    return { error: { code: 'EACCES', message: '目标路径未经用户对话框确认，已拒绝直写' } };
  }
  try {
    await writeFileAtomic(targetPath, content, 'utf-8');
    return { path: targetPath };
  } catch (err) {
    return { error: { code: err.code || 'UNKNOWN', syscall: err.syscall, message: err.message } };
  }
});

ipcMain.handle('dialog:export-file', async (event, payload) => {
  const { name, buffer, content } = payload || {};
  const win = BrowserWindow.fromWebContents(event.sender);

  // 按实际导出类型分列过滤器（L10）：混列 png+svg 会让用户选中不匹配的扩展名
  const isPng = /\.png$/i.test(name || '');
  const filters = isPng
    ? [{ name: 'PNG 图像', extensions: ['png'] }]
    : [{ name: 'SVG 图像', extensions: ['svg'] }];

  const result = await dialog.showSaveDialog(win, {
    title: '导出文件',
    defaultPath: name || 'export.png',
    filters
  });

  if (result.canceled || !result.filePath) return null;

  try {
    if (buffer) {
      await writeFileAtomic(result.filePath, Buffer.from(buffer));
    } else {
      await writeFileAtomic(result.filePath, content || '');
    }
    statAllowedPaths.add(result.filePath);
    return { path: result.filePath };
  } catch (err) {
    return { error: { code: err.code || 'UNKNOWN', syscall: err.syscall, message: err.message } };
  }
});

// --- IPC: app / runtime versions (for diagnostics) ------------------------------
ipcMain.handle('app:versions', () => {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  };
});

// --- IPC: file metadata (stat) --------------------------------------------------
ipcMain.on('view:set-checks', (_event, checks) => {
  // 渲染进程推送视图面板真实勾选态 → 仅变化时重建菜单（L3），避免无谓的菜单闪烁
  if (!checks || typeof checks !== 'object') return;
  let changed = false;
  for (const key of ['minimap', 'lint', 'properties']) {
    if (typeof checks[key] === 'boolean' && checks[key] !== viewChecks[key]) {
      viewChecks[key] = checks[key];
      changed = true;
    }
  }
  if (changed) buildMenu();
});

ipcMain.handle('file:stat', async (_event, filePath) => {
  // 不在对话框信任集内的路径一律拒答（M11），行为与文件不存在一致
  if (typeof filePath !== 'string' || !statAllowedPaths.has(filePath)) return null;
  try {
    const st = await fs.promises.stat(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
});

// --- IPC: window title ------------------------------------------------------
ipcMain.on('window:title', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setTitle(title || 'BPMN Studio');
});

// --- IPC: unsaved-changes close guard (v0.1.10) -------------------------------
ipcMain.on('window:dirty-state', (event, dirty) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.__studioDirty = !!dirty;
});

ipcMain.on('window:close-ok', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.__studioAllowClose = true;
    win.__studioDirty = false;
    win.close();
  }
});

// --- IPC: lightweight preference store (userData/preferences.json) -----------
// localStorage under a sandboxed file:// page is session-only (never flushed to
// disk), so UI state that must survive restarts lives in this tiny JSON store.
let prefsCache = null;

function prefsFile() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function loadPrefs() {
  if (prefsCache) return prefsCache;
  try {
    prefsCache = JSON.parse(fs.readFileSync(prefsFile(), 'utf-8'));
  } catch {
    prefsCache = {};
  }
  return prefsCache;
}

function persistPrefs() {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    writeFileAtomicSync(prefsFile(), JSON.stringify(prefsCache, null, 2), 'utf-8');
  } catch { /* disk errors are non-fatal for a preference store */ }
}

// prefs 键白名单（Fix 18，纵深防御）：存储虽在 userData，但未经校验的键可污染
// 同一文件里未来的命名空间；新增可持久化设置时必须在这里登记
const PREF_KEYS = new Set(['ui.theme', 'panel.collapsed']);

ipcMain.handle('prefs:get', (_event, key) => {
  const prefs = loadPrefs();
  return key ? prefs[key] : prefs;
});

ipcMain.handle('prefs:set', (_event, key, value) => {
  if (typeof key !== 'string' || !PREF_KEYS.has(key)) return undefined;
  const prefs = loadPrefs();
  if (value === undefined || value === null) delete prefs[key];
  else prefs[key] = value;
  persistPrefs();
  return prefs[key];
});

// --- app lifecycle ----------------------------------------------------------
app.enableSandbox(); // 全局沙箱兜底（L18）：窗口级 sandbox:true 之外的纵深防御

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});