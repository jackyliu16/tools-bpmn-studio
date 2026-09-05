# bpmn-studio v0.1.9 — Security & Quality Audit Report

> **Date:** 2026-09-05 · **Version audited:** `0.1.9` (commit `HEAD`) · **Method:** Static source review + cross-validation (5 independent reports, all findings verified against source)
>
> **Status (2026-09-05):** Sprint 1（H1–H5）已於 v0.1.10 修復完毕（见 AUDIT-BACKLOG.md「验证状态」节）；
> 其余发现连同修复要领已转移至 **`AUDIT-BACKLOG.md`** 持续追踪。
> 复核对源码后的修正：H3 严重度应降为 low（实际代码无未定义变量 bug，仅 businessObject 未守门）；
> M4 的 `precheckDmnXml` 已存在，修复仅需 1 行模式分派；M1 根因为 dmn-js 全库无 `saveSVG` 实现。

---

## Executive Summary

| Dimension | Count | Assessment |
|-----------|-------|------------|
| **High (data loss / crash)** | 5 | Silent data loss is the dominant risk |
| **Medium (broken feature / UX)** | 14 | DMN export completely broken; async races |
| **Low (design smell / edge case)** | 20 | Security hardening gaps, missing shortcuts |
| **False positives dismissed** | 2 | Verified unreachable or working-as-designed |

**Total confirmed findings: 39** (after deduplication from ~45 raw observations).

### Risk Profile

The most critical cluster is **silent data loss** (H1–H5, FIO-001): a user who opens a file, edits it, and closes the window loses all work with **zero warning**. The dirty-tracking mechanism exists but is disabled after file open (`lastSavedXML = null`), and no `beforeunload` or Electron `close` interception catches the quit path.

---

## Remediation Plan — Sprint 1 (Data Loss Prevention) — ✅ 已完成于 v0.1.10

> 落地差异：关闭拦截用 IPC 握手（window:dirty-state / save-then-close / close-ok）而非 executeJavaScript；
> H5 用原生 confirm；导入收尾必须走 `setDirty(false)` 而非裸赋值（验证脚本拓出星号残留，commit 00b3780）。
> 回归防线：`scripts/verify/verify-dirty-guard.mjs`（17 项）。

These five fixes eliminate all silent-data-loss vectors and together represent **≈ 3 hours** of work.

### Fix 1 — Seed `lastSavedXML` on file open

**ID:** H2 · **Effort:** 5 min · **File:** `src/main.js:967`

```diff
  currentFileName = name || 'untitled.bpmn';
  currentFilePath = filePath || null;
- lastSavedXML = null;
+ lastSavedXML = xml;           // ← seed with the content that was just loaded
  lastSavedAt = null;
  isDirty = false;
```

**Why:** `onBpmnStackChanged` (L1211) returns early when `lastSavedXML === null`, so edits after opening a file never set the dirty flag. Seeding the baseline re-enables proper `★` tracking.

> ⚠️ This alone doesn't fix the "import rebuilds command stack → `savedStackIdx = null`" path. Confirm that the `savedStackIdx === null` branch (L1213: "any change = dirty") still works correctly with a non-null `lastSavedXML`. It should — that branch doesn't read `lastSavedXML`.

### Fix 2 — Add close/quit guard

**ID:** H1 · **Effort:** 30 min (renderer + main) · **Files:** `src/main.js`, `electron/main.cjs`

**Renderer** (`src/main.js`, after existing event listeners):
```js
window.addEventListener('beforeunload', (e) => {
  if (isDirty) { e.preventDefault(); e.returnValue = ''; }
});
```

**Electron main** (`electron/main.cjs`, in `win.on('close')`):
```js
win.on('close', async (e) => {
  const dirty = await win.webContents.executeJavaScript('window.__bpmnIsDirty === true');
  if (dirty) {
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Discard'],
      message: '有未保存的变更', detail: '关闭将丢失未保存的编辑。'
    });
    if (response === 1) {
      await win.webContents.executeJavaScript('window.__bpmnIsDirty = false');
      win.close();
    }
  }
  saveWindowState();
});
```

Expose from renderer preload or `executeJavaScript`: `window.__bpmnIsDirty = isDirty` (update in `setDirty`).

### Fix 3 — Null-safe `selection.changed` handler

**ID:** H3 · **Effort:** 1 min · **File:** `src/main.js:1912`

```diff
- const el = event.newSelection && event.newSelection[0];
- if (element) {
-   els.statusRight.textContent = `${element.id} (${element.businessObject.$type.replace('bpmn:', '')})`;
+ const element = event.newSelection?.[0];
+ if (element?.businessObject?.$type) {
+   els.statusRight.textContent = `${element.id} (${element.businessObject.$type.replace('bpmn:', '')})`;
```

**Why:** Transient or incomplete elements (drag ghost, external label placeholder) can have `businessObject === undefined`. The DMN path (L684) already guards correctly.

### Fix 4 — DMN import failure: restore model

**ID:** H4 · **Effort:** 10 min · **File:** `src/main.js:810-813`

```diff
  try {
    ({ warnings } = await dmnModeler.importXML(xml));
  } catch (err) {
+   await restorePreviousModel(dmnModeler, previousXml);
    err.warnings = err.warnings || [];
    err.parseLocation = extractParseLocation(err);
    err.failedXml = xml;
    throw err;
  }
```

Add `snapshotCurrentXml()` before the `try` block (copy the pattern from `setBpmnDiagram` L942-948).

### Fix 5 — Dirty check before New / Open

**ID:** H5 · **Effort:** 15 min · **File:** `src/main.js`

Add at the top of `createNewDiagram()`, `createNewDmnDiagram()`, and `openFile()`:

```js
if (isDirty) {
  const ok = confirm('当前有未保存的变更，确定要继续吗？');
  if (!ok) return;
}
```

---

## Remediation Plan — Sprint 2 (Feature Correctness)

### Fix 6 — Toolbar undo/redo in DMN mode

**ID:** M2 · **Effort:** 2 min · **File:** `src/main.js:2194-2195`

```diff
-$('#btn-undo').addEventListener('click', () => bpmnModeler && bpmnModeler.get('undo').undo());
-$('#btn-redo').addEventListener('click', () => bpmnModeler && bpmnModeler.get('undo').redo());
+$('#btn-undo').addEventListener('click', () => activeService('undo')?.undo());
+$('#btn-redo').addEventListener('click', () => activeService('redo')?.redo());
```

### Fix 7 — DMN SVG/PNG export

**ID:** M1 · **Effort:** 20 min · **File:** `src/main.js`

`getActiveModeler()` returns the DMN `EditingManager` which has no `saveSVG`. Route through the active viewer instance instead:

```js
function saveActiveSvg() {
  const modeler = getActiveModeler();
  if (editorMode === 'dmn') {
    // DMN EditingManager exposes saveXML only; use the canvas SVG serializer
    const svg = dmnModeler.get('canvas').getGraphics(); // or use svg-export
    // ... serialize to SVG string
  }
  return modeler.saveSVG ? modeler.saveSVG() : null;
}
```

### Fix 8 — Concurrency guard for async operations

**ID:** M3 · **Effort:** 30 min · **File:** `src/main.js`

```js
let _busy = false;
async function guarded(fn) {
  if (_busy) { setStatus('处理中…'); return; }
  _busy = true;
  try { await fn(); } finally { _busy = false; }
}
```

Wrap `createNewDiagram`, `createNewDmnDiagram`, `openDiagramContent`, `switchToDmnMode`, `switchToBpmnMode`.

### Fix 9 — `applyXmlEdits` mode-awareness

**ID:** M4 · **Effort:** 15 min · **File:** `src/main.js:1818`

```diff
- const preErr = precheckBpmnXml(editedXml);
+ const preErr = editorMode === 'dmn' ? precheckDmnXml(editedXml) : precheckBpmnXml(editedXml);
```

Implement `precheckDmnXml` (check for `<definitions` root) or skip precheck in DMN mode.

### Fix 10 — Error context for file operations

**ID:** M6, M7 · **Effort:** 10 min · **File:** `src/main.js:2522, 2540`

```diff
  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files[0];
    if (!file) return;
-   const content = await file.text();
+   let content;
+   try { content = await file.text(); }
+   catch (err) { showError({ title: '读取文件失败', message: err.message }); return; }
    await openDiagramContent(content, file.name, null);
  });
```

Same pattern for `drop` handler and `openFile()` IPC call.

---

## Remediation Plan — Sprint 3 (Security Hardening)

### Fix 11 — Electron navigation guards

**ID:** M10 · **Effort:** 10 min · **File:** `electron/main.cjs`

```js
win.webContents.on('will-navigate', (e) => e.preventDefault());
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

### Fix 12 — IPC path validation

**ID:** M11 · **Effort:** 15 min · **File:** `electron/main.cjs`

Validate `file:stat` path against an allowlist (recently-opened directories) or require the path to originate from a `dialog.showOpenDialog` result.

### Fix 13 — Remove `ws:` from CSP

**ID:** L16 · **Effort:** 1 min · **File:** `index.html:8`

```diff
- <meta http-equiv="Content-Security-Policy" content="...; connect-src 'self' ws:;">
+ <meta http-equiv="Content-Security-Policy" content="...; connect-src 'self';">
```

### Fix 14 — Enable global Electron sandbox

**ID:** L18 · **Effort:** 5 min · **File:** `electron/main.cjs`

```js
app.enableSandbox();  // before app.whenReady()
```

---

## Remediation Plan — Sprint 4 (Polish & Hygiene)

| Fix | ID | Effort | Description |
|-----|----|--------|-------------|
| PNG Object URL leak | M8 | 5 min | Move `revokeObjectURL` into `finally` block |
| Restore failure silent | M9 | 5 min | Show error toast when `restorePreviousModel` itself fails |
| Stale lint panel | M14 | 5 min | Clear `els.lintList.innerHTML = ''` in `destroyModeler()` |
| `Ctrl+Shift+S` conflict | M12 | 10 min | Remove `Ctrl+Shift+S` from browser export keydown; keep in Electron menu |
| Missing browser shortcuts | M13 | 15 min | Add zoom/simulation shortcuts to browser keydown; guard `k==='f'` with `!shiftKey` |
| `markSaved` DMN gap | M5 | 10 min | Add DMN branch to `currentStackIdx()` |
| `lastSavedAt` inconsistency | L1 | 2 min | Remove `lastSavedAt = null` from `applyXmlEdits` |
| MatchMedia async race | L4 | 5 min | Add try/catch inside the `matchMedia` listener callback |
| `accept=".txt"` too broad | L13 | 1 min | Remove `.txt` from file input accept attribute |
| macOS tooltips say "Ctrl" | L14 | 20 min | Read `studio.platform`, substitute "⌘" on Mac in tooltips |
| Export dialog mixed filter | L10 | 5 min | Split PNG and SVG into separate `filters[]` entries |
| `.xml` double extension | L12 | 2 min | Add `.xml` to the regex: `/\.(bpmn|dmn|xml)$/i` |
| Menu checkbox never syncs | L3 | 30 min | IPC round-trip for state; or remove checkboxes (low value) |
| Zoom-reset unreachable in browser | L15 | 5 min | Add `Ctrl+0` shortcut and/or toolbar button |
| `describeFsError` missing codes | L8 | 5 min | Add `EEXIST`, `EMFILE`, `ENFILE`, `ENAMETOOLONG` |
| `unhandledrejection` no try/catch | L9 | 2 min | Wrap `showError()` in try/catch inside the handler |
| Boot IIFE not awaited | L7 | 1 min | Add `await` (it's in an async IIFE already) |
| CI: Electron cache order | M15 | 10 min | Move cache step **before** `npm ci`; add `restore-keys` |
| CI: `build-win` no version guard | L19 | 5 min | Copy version-check step from `build-linux` |
| CI: `.web-asset` not gitignored | L20 | 1 min | Add to `.gitignore` |

---

## Architecture Notes

### Root Cause: BPMN-centric code paths not generalized for DMN

**8 of 39 findings** (M1, M2, M4, M5, H4, L5, L6, plus the dead dirty-tracking) stem from the same architectural debt: the DMN editor was added as a secondary path with several BPMN-specific assumptions leaking through.

**Recommendation:** Introduce an `ActiveEditorContext` abstraction:

```js
const editorContext = {
  get current() { return editorMode === 'dmn' ? dmnContext : bpmnContext; },
};
```

This would make it structurally impossible to forget a DMN branch, rather than relying on developer memory.

### Root Cause: No lifecycle state machine for model switching

The async race (M3) and the `restorePreviousModel` silent failure (M9) both point to the lack of an explicit state machine governing model creation/destruction transitions. A `_busy` mutex (Sprint 2) is the pragmatic fix; a state machine is the long-term answer.

---

## Risk Matrix (Impact × Effort)

```
        Low Effort          Medium Effort         High Effort
High  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
Impact│ H3  (1 min) │     │ H1  (30m)   │     │             │
      │ M2  (2 min) │     │ H4  (10m)   │     │             │
      │ M8  (5 min) │     │ H5  (15m)   │     │             │
      │ L12 (2 min) │     │ M1  (20m)   │     │             │
      ├─────────────┤     ├─────────────┤     ├─────────────┤
Med   │ L8  (5 min) │     │ M3  (30m)   │     │ M10 (60m+)  │
Impact│ L13 (1 min) │     │ M4  (15m)   │     │             │
      │ L16 (1 min) │     │ M6+M7 (10m) │     │             │
      │ L19 (5 min) │     │ M12 (10m)   │     │             │
      │ L20 (1 min) │     │ M13 (15m)   │     │             │
      │ L9  (2 min) │     │ M14 (5m)    │     │             │
      ├─────────────┤     ├─────────────┤     ├─────────────┤
Low   │ H2  (5 min) │     │ M5  (10m)   │     │ L14 (20m)   │
Impact│ M9  (5 min) │     │ M11 (15m)   │     │ L3  (30m)   │
      │ L7  (1 min) │     │ M15 (10m)   │     │             │
      │             │     │             │     │             │
      └─────────────┘     └─────────────┘     └─────────────┘
  (H2 = low impact alone, but essential enabler for H1)
```

---

## Suggested Release Plan

| Release | Scope | Target |
|---------|-------|--------|
| **v0.1.10** (patch) | Sprint 1: all data-loss fixes (H1–H5) + H3 crash guard | Immediately after Sprint 1 merge |
| **v0.1.11** (patch) | Sprint 2: feature correctness (M1–M7) + security quick wins (L16) | +1 week |
| **v0.2.0** (minor) | Sprint 3+4: security hardening, architecture cleanup, CI hygiene | When `ActiveEditorContext` refactor lands |

---

## Verification Checklist

After applying fixes, verify:

- [ ] Open `.bpmn` file → edit → title shows ★
- [ ] Close window → "unsaved changes" dialog appears
- [ ] Select element on canvas → no console error when `businessObject` is undefined
- [ ] Switch to DMN → import invalid DMN XML → canvas shows previous diagram, not blank
- [ ] Switch to DMN → toolbar undo/redo buttons work
- [ ] Switch to DMN → export SVG produces valid SVG file
- [ ] Edit XML in DMN mode → "Apply" gives appropriate error (not "缺少 \<BPMNDiagram\>")
- [ ] `Ctrl+Shift+F` in browser → opens search (not zoom-fit), `Ctrl+Shift+S` → no export trigger
- [ ] CI `build-linux` job: Electron download uses cache (check `electron` binary timestamp)

---

*Report generated by cross-validated static analysis. All findings verified against `src/main.js`, `electron/main.cjs`, `index.html`, and `.github/workflows/` at v0.1.9 HEAD.*
