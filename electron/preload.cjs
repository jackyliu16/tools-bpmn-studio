/**
 * bpmn-studio — Electron preload.
 *
 * Exposes a small, explicit bridge to the renderer. Everything else stays in
 * the sandboxed renderer (no nodeIntegration).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bpmnStudio', {
  platform: process.platform,

  /** @returns {Promise<{path: string, content: string} | null>} */
  openDiagram: () => ipcRenderer.invoke('dialog:open-diagram'),

  /** @returns {Promise<{path: string} | null>} */
  saveDiagram: (payload) => ipcRenderer.invoke('dialog:save-diagram', payload),

  /** 直写已确认路径（保存时已有 currentFilePath，不再弹另存框）
   * @returns {Promise<{path: string} | {error: object}>} */
  saveDiagramDirect: (payload) => ipcRenderer.invoke('dialog:save-diagram-direct', payload),

  /** @returns {Promise<{path: string} | null>} */
  exportFile: (payload) => ipcRenderer.invoke('dialog:export-file', payload),

  /** @returns {Promise<{size: number, mtimeMs: number} | null>} */
  statFile: (filePath) => ipcRenderer.invoke('file:stat', filePath),

  /** read a persisted preference (survives restarts; undefined if unset) */
  getPreference: (key) => ipcRenderer.invoke('prefs:get', key),

  /** persist a preference across restarts */
  setPreference: (key, value) => ipcRenderer.invoke('prefs:set', key, value),

  /** subscribe to native menu actions */
  onMenu: (callback) => {
    ipcRenderer.on('menu:action', (_event, action) => callback(action));
  },

  /** push dirty state to main for the unsaved-changes close guard (v0.1.10) */
  setDirtyState: (dirty) => ipcRenderer.send('window:dirty-state', !!dirty),

  /** push real view-panel visibility so the native menu checkboxes stay truthful (L3) */
  setViewChecks: (checks) => ipcRenderer.send('view:set-checks', checks),

  /** main intercepted a close while dirty and asks the renderer to save first */
  onSaveBeforeClose: (callback) => {
    ipcRenderer.on('window:save-then-close', () => callback());
  },

  /** renderer finished saving; main may proceed with the close */
  allowWindowClose: () => ipcRenderer.send('window:close-ok'),

  /** @returns {Promise<{app, electron, chrome, node, platform} | null>} */
  getVersions: () => ipcRenderer.invoke('app:versions'),

  /** update the native window title */
  setTitle: (title) => ipcRenderer.send('window:title', title)
});