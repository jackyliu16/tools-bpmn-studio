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

  /** @returns {Promise<{path: string} | null>} */
  exportFile: (payload) => ipcRenderer.invoke('dialog:export-file', payload),

  /** @returns {Promise<{size: number, mtimeMs: number} | null>} */
  statFile: (filePath) => ipcRenderer.invoke('file:stat', filePath),

  /** subscribe to native menu actions */
  onMenu: (callback) => {
    ipcRenderer.on('menu:action', (_event, action) => callback(action));
  },

  /** update the native window title */
  setTitle: (title) => ipcRenderer.send('window:title', title)
});