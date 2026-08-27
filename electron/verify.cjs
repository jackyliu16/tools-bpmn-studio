/**
 * bpmn-studio — headless verification harness (not shipped).
 *
 * Usage:  npx electron electron/verify.cjs   (optionally under xvfb-run)
 *
 * Loads the built app like the real main process, collects console errors,
 * checks that the modeler actually rendered (canvas, palette, properties
 * panel, lint panel), saves a screenshot to /tmp/bpmn-studio-shot.png and
 * exits 0 on success / 1 on failure.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// headless / container-friendly flags
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('in-process-gpu');

app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(`[console:${level}] ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors.push(`did-fail-load: ${code} ${desc}`);
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // give the renderer time to boot the modeler and import the starter diagram
  await new Promise((r) => setTimeout(r, 6000));

  const checks = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelectorAll(s).length;
      const m = window.__bpmnModeler;
      return {
        canvas: q('.djs-container'),
        palette: q('.djs-palette'),
        contextPad: q('.djs-context-pad'),
        propertiesPanel: q('.bio-properties-panel'),
        minimap: q('.djs-minimap'),
        lintPanel: document.getElementById('lint-panel') && !document.getElementById('lint-panel').classList.contains('hidden'),
        topbarButtons: q('#topbar .tool'),
        diagramName: document.getElementById('diagram-name')?.textContent,
        dirty: document.getElementById('dirty')?.classList.contains('hidden'),
        zoom: m ? Math.round(m.get('canvas').zoom() * 100) + '%' : 'no-modeler',
        modelerReady: !!m,
        elementCount: m ? Object.keys(m.get('elementRegistry')._elements).length : 0
      };
    })()
  `);

  const image = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/bpmn-studio-shot.png', image.toPNG());

  console.log('=== CHECKS ===');
  console.log(JSON.stringify(checks, null, 2));
  console.log('=== CONSOLE ERRORS (' + errors.length + ') ===');
  errors.slice(0, 20).forEach((e) => console.log(e));

  const ok =
    checks.modelerReady &&
    checks.canvas > 0 &&
    checks.palette > 0 &&
    checks.propertiesPanel > 0 &&
    checks.minimap > 0 &&
    checks.elementCount > 0 &&
    errors.length === 0;

  console.log('=== RESULT: ' + (ok ? 'PASS' : 'FAIL') + ' ===');
  app.exit(ok ? 0 : 1);
});