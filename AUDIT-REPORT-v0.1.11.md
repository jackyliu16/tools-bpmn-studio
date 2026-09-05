# bpmn-studio v0.1.11 — Code Quality & Resilience Audit Report

> **Date:** 2026-09-05 · **Version audited:** `0.1.11` (commit `HEAD`) · **Method:** 6 independent audit agents (lifecycle/race, dirty-state, security/IPC, concurrent model ops, I/O integrity, UI state drift) + cross-validation  
>
> **Supersedes:** Findings from prior audit (`AUDIT-REPORT.md` v0.1.9) are tracked in `AUDIT-BACKLOG.md`. All findings in this report are **new** (absent from backlog known items).

---

## Executive Summary

| Dimension | Count | Assessment |
|-----------|-------|------------|
| **Medium (correctness / data confusion)** | 12 | Concurrent model operations and state-drift are the dominant cluster |
| **Low (edge case / hardening / UX)** | 14 | Defense-in-depth, minor UI inconsistencies |
| **Informational** | 1 | No action needed |
| **Rejected (false positive)** | 2 | Verified as working-as-designed or bounded |

**Total findings audited:** 34 → **28 confirmed** (4 with severity adjustment), 2 rejected, 4 overlaps consolidated.

### Risk Profile

The most impactful cluster is **model lifecycle race conditions**: operations that mutate or read model state bypass the `_modelBusy` lock introduced in M3 (v0.1.11). This creates windows where UI state, file identity, and the active modeler diverge — leading to user confusion and potential data corruption in edge sequences. A secondary cluster involves **non-atomic file writes**, risking diagram loss on crash/disk-full.

---

## Remediation Plan — Sprint 3 (Concurrency & State Integrity)

> Target: **v0.1.12** · Estimated effort: **≈ 6 hours**

These fixes close the `_modelBusy` lock gaps and prevent the most common paths to state confusion.

---

### Fix 1 — Wrap `switchDmnView` and `applyXmlEdits` in `guarded()`

**IDs:** Agent1-D2 + Agent4-F1 (consolidated) · **Severity:** 🟠 Medium · **Effort:** 30 min · **File:** `src/main.js`

**Problem:** The code comment at ~L1133 explicitly requires all model-mutating operations to go through `guarded()`. Two operations violate this contract:

| Operation | Line | Mutates |
|-----------|------|---------|
| `switchDmnView()` | ~L700 | Awaits `dmnModeler.open(view)` which reattaches viewer, destroys/recreates internal state |
| `applyXmlEdits()` | ~L1826 | Calls `importXML` or `ensureModeler` → may destroy+create modeler |

**Impact:** Rapid tab switching or XML-apply during an in-flight import interleaves operations, producing a model in an undefined state.

**Fix:**

```diff
- async function switchDmnView(view) { … }
+ const switchDmnView = guarded(async function switchDmnView(view) { … });

- async function applyXmlEdits() { … }
+ const applyXmlEdits = guarded(async function applyXmlEdits() { … });
```

Ensure `guarded()` handles the `this`-free pattern (these are already standalone `async function` declarations, not methods).

**Validation:** Rapid Ctrl+1/2/3 + XML Apply in sequence → no console errors, no interleaved `import.done` events.

---

### Fix 2 — Guard model reads in `saveFile` and `onSaveBeforeClose`

**ID:** Agent4-F3 · **Severity:** 🟢 Low (narrow window) · **Effort:** 10 min · **File:** `src/main.js`

**Problem:** `saveFile()` calls `saveActiveXml()` which reads the active modeler. If a concurrent `guarded()` operation (e.g. `createNewDiagram`) destroys the modeler between the dirty-check and the `saveXML()` call, the save fails with an opaque error.

**Fix:**

```diff
  async function saveFile(forceAs = false) {
+   if (_modelBusy) {
+     setStatus('处理中，请稍后保存');
+     return false;
+   }
    const xml = await saveActiveXml();
    …
```

Same check in `onSaveBeforeClose()` (which delegates to `saveFile`, so inherits protection).

---

### Fix 3 — Reset XML panel editing state on model switch

**ID:** Agent6-UI-DRIFT-03 · **Severity:** 🟠 Medium · **Effort:** 15 min · **File:** `src/main.js`

**Problem:** `destroyModeler()` and `destroyDmnEditor()` do not reset `xmlEditing` / `xmlVisible`. When user switches from diagram A to diagram B while the XML panel is in edit mode:
1. `refreshXmlView()` early-returns (sees `xmlEditing === true`)
2. Panel still shows diagram A's XML
3. User clicks Apply → old XML is imported into the new model context

**Fix:**

```diff
  function destroyModeler() {
    …
+   xmlEditing = false;
+   xmlVisible = false;
    els.xmlPanel?.classList.remove('visible');
  }

  function destroyDmnEditor() {
    …
+   xmlEditing = false;
+   xmlVisible = false;
  }
```

**Validation:** Open A → show XML panel → edit mode → open B → panel should be hidden/closed.

---

### Fix 4 — Atomic file writes

**ID:** Agent5-IO1 · **Severity:** 🟠 Medium · **Effort:** 20 min · **File:** `electron/main.cjs`

**Problem:** `dialog:save-diagram` and `dialog:export-file` handlers use `fs.writeFileSync(path, data)` (O_TRUNC). If the process crashes or disk fills between truncate and write-complete, the original file is destroyed.

**Fix:**

```diff
- fs.writeFileSync(resolvedPath, data);
+ const tmp = resolvedPath + '.tmp';
+ fs.writeFileSync(tmp, data);
+ fs.renameSync(tmp, resolvedPath);  // atomic on same filesystem
```

Apply to both `dialog:save-diagram` and `dialog:export-file` handlers. For `window-state.json` / `preferences.json` (Agent5-IO4), same pattern is recommended but lower priority (recovery is graceful).

**Validation:** Simulate disk-full (`ulimit -f`) during save → original file intact, error shown.

---

### Fix 5 — Fix `applyXmlEdits` false-positive dirty flag

**ID:** Agent2-D2 · **Severity:** 🟠 Medium · **Effort:** 15 min · **File:** `src/main.js`

**Problem:** After applying edits from the XML panel:
- `lastSavedXML` stores the **raw file bytes** from the original import (L1054)
- The comparison uses `saveXML({format: true})` output (pretty-printed, normalized attribute order)
- These always differ → `dirty` is set unconditionally after Apply, even when the user's edit was whitespace-only or a no-op

Additionally, `savedStackIdx = null` after apply breaks the ★-clearing invariant (undo back to save-point no longer clears the indicator).

**Fix:** After a successful `applyXmlEdits`, re-capture the baseline from the same serializer used for comparison:

```diff
  // After successful import in applyXmlEdits:
- // (nothing) — lastSavedXML retains the original file content
+ const { xml: canonicalXml } = await saveActiveXml({ format: false });
+ lastSavedXML = canonicalXml;
+ savedStackIdx = currentStackIdx();
+ setDirty(false);
```

**Validation:** Apply XML with no semantic changes → ★ does NOT appear.

---

### Fix 6 — Direct save for named files (skip dialog when path exists)

**ID:** Agent2-D6 · **Severity:** 🟠 Medium · **Effort:** 15 min · **File:** `src/main.js`, `electron/main.cjs`

**Problem:** "Save" (`Ctrl+S`) always opens the native "Save As" dialog even when `currentFilePath` is already set. This breaks the "Save and Close" close-guard UX (user expects silent save, gets a dialog; cancel aborts close unexpectedly).

**Fix:** In `saveFile()`, when `!forceAs && currentFilePath`, write directly:

```diff
  async function saveFile(forceAs = false) {
    const xml = await saveActiveXml();
    if (!xml) return false;

+   if (!forceAs && currentFilePath) {
+     const result = await window.electronAPI.saveDiagramDirect({
+       path: currentFilePath, xml, name: currentFileName
+     });
+     if (!result.ok) { showError(result.error); return false; }
+     markSaved(xml);
+     return true;
+   }
    // … existing dialog path for "Save As" or no-path case
```

Add corresponding IPC handler `dialog:save-diagram-direct` in main process.

---

## Remediation Plan — Sprint 3b (State Corruption Pathways)

> Target: **v0.1.12** · Estimated effort: **≈ 3 hours**

---

### Fix 7 — Preserve modeler identity on cross-mode open failure

**ID:** Agent2-D1 · **Severity:** 🟠 Medium · **Effort:** 45 min · **File:** `src/main.js`

**Problem:** `setDiagram()` calls `ensureEditorMode()` before attempting the import. If switching to DMN mode succeeds (old BPMN modeler destroyed) but the DMN import then fails, state is inconsistent:
- Title/path still reference the old `.bpmn` file
- Active editor is a blank `DmnModeler`
- `saveXML()` rejects ("no definitions loaded") → error dialog on Ctrl+S

**Impact:** User confusion; potential wrong-extension save if they edit the blank canvas.

**Fix:** Defer mode switch until *after* import succeeds. Snapshot the mode, attempt import into a temporary modeler, and only commit the mode switch on success:

```js
async function setDiagram(xml, name, filePath) {
  const targetMode = detectMode(xml);
  const prevMode = editorMode;

  try {
    // Import into current or new modeler without destroying the existing one yet
    await importIntoTarget(xml, targetMode);
  } catch (err) {
    // Rollback: mode unchanged, old modeler intact
    showError({ title: '导入失败', body: err.message });
    return;
  }
  // Success: commit mode switch, update title/path
  await ensureEditorMode(targetMode);
  …
}
```

This is a structural change; the simplest interim fix is to **restore the snapshot** (which already exists via `restorePreviousModel`) AND reset `currentFilePath`/`currentFileName` to match the restored model.

---

### Fix 8 — Use correct platform modeler for `restorePreviousModel`

**ID:** Agent2-D4 · **Severity:** 🟠 Medium · **Effort:** 20 min · **File:** `src/main.js`

**Problem:** `restorePreviousModel()` calls `ensureModeler(platform)` where `platform` is the *current* platform, but the snapshot XML was produced by the *old* platform modeler. When the user switches platform (Camunda ↔ Activiti) and then an import fails, the restore uses strict moddle from the wrong platform → rejects unknown attributes.

**Fix:** Store the platform alongside the snapshot; use it during restore:

```diff
- modelSnapshot = { xml, name, filePath };
+ modelSnapshot = { xml, name, filePath, platform: currentPlatform };

  // In restorePreviousModel():
- ensureModeler();
+ ensureModeler(modelSnapshot.platform);
```

---

### Fix 9 — Register all DMN view types in tab bar

**ID:** Agent1-D1 · **Severity:** 🟠 Medium · **Effort:** 10 min · **File:** `src/main.js`, `index.html`

**Problem:** `dmn-js` Modeler registers 4 view providers: `drd`, `decisionTable`, `literalExpression`, `boxedExpression`. The app hard-codes only 3 tabs. `boxedExpression` (a common DMN13 feature) has no visible navigation path; `views.changed` fires but the UI has no corresponding tab.

**Fix:** Add a 4th tab, or dynamically generate tabs from `dmnModeler.get('canvas').getViews()`:

```diff
- <!-- Hard-coded: DRD | Decision Table | Literal Expression -->
+ <!-- Generate from views: container.appendChild(tab for each view in getViews()) -->
```

---

## Remediation Plan — Sprint 4 (Low-Priority Hardening & Polish)

> Target: **v0.1.13** · Estimated effort: **≈ 3 hours** (optional / opportunistic)

---

### Fix 10 — Clear minimap button `.active` on modeler destruction

**ID:** Agent6-UI-DRIFT-01 · **Severity:** 🟢 Low · **Effort:** 2 min

```diff
  function destroyModeler() {
    …
    btnMinimap?.classList.remove('active');  // ADD THIS LINE
  }
```

---

### Fix 11 — Clear status-bar selection info on model destruction

**ID:** Agent6-UI-DRIFT-04 · **Severity:** 🟢 Low · **Effort:** 2 min

```diff
  function destroyModeler() {
    …
    els.statusRight.textContent = '';
  }
```

---

### Fix 12 — Update zoom label on DMN drill-down navigation

**ID:** Agent6-UI-DRIFT-02 · **Severity:** 🟢 Low · **Effort:** 10 min

**Fix:** Listen to `canvas.viewbox.changed` on the active viewer, or call `setZoomStatus()` from the `views.changed` handler.

---

### Fix 13 — `copyTextToClipboard` fallback should return actual result

**ID:** Agent4-F4 · **Severity:** 🟢 Low · **Effort:** 3 min

```diff
  function copyTextToClipboardFallback(text) {
    const ta = document.createElement('textarea');
    …
-   document.execCommand('copy');
-   return true;
+   return document.execCommand('copy');
  }
```

---

### Fix 14 — Add re-entry guard to close dialog

**ID:** Agent3-E03 · **Severity:** 🟢 Low · **Effort:** 5 min

```diff
  win.on('close', (e) => {
+   if (_closeDialogActive) { e.preventDefault(); return; }
    …
+   _closeDialogActive = true;
    dialog.showMessageBox(…).finally(() => { _closeDialogActive = false; });
  });
```

---

### Fix 15 — Drag-and-drop for DMN canvas

**ID:** Agent1-D4 · **Severity:** 🟢 Low · **Effort:** 10 min

**Fix:** Attach `dragover`/`dragleave`/`drop` listeners to `els.dmnCanvas` (or a shared parent overlay), or listen on `document` and gate on target.

---

### Fix 16 — `import.done` handler should check `event.error`

**ID:** Agent1-D3 · **Severity:** 🟢 Low · **Effort:** 3 min

```diff
  dmnModeler.on('import.done', (event) => {
+   if (event.error) {
+     setStatus(`导入警告: ${event.error.message}`);
+     return;
+   }
    setStatus('导入成功');
  });
```

---

### Fix 17 — Match save dialog filters to active editor mode

**ID:** Agent5-IO2 · **Severity:** 🟢 Low · **Effort:** 5 min

In `saveFile()`, pass the detected extension to the IPC call and use it as the default/first filter.

---

### Fix 18 — Defense-in-depth: validate `prefs:set` keys, sanitize pasted HTML

**IDs:** Agent3-E01, Agent3-E02 · **Severity:** 🟢 Low · **Effort:** 15 min

| Location | Fix |
|----------|-----|
| `electron/main.cjs` `prefs:set` handler | Reject keys not in an allowlist; reject `__proto__`, `constructor`, `prototype` |
| `els.xmlCode` paste handler | Intercept `paste` event, extract `.text/plain` only via `e.clipboardData.getData('text/plain')`, call `e.preventDefault()` |

These are **not currently exploitable** (CSP `script-src 'self'` blocks injection). Recommended as hardening for future-proofing if CSP is ever relaxed.

---

### Fix 19 — Guard `saveActiveXml` against empty return

**ID:** Agent5-IO3 · **Severity:** 🟢 Low · **Effort:** 3 min

```diff
  async function saveActiveXml(opts) {
    const result = await modeler.saveXML(opts);
+   if (!result?.xml) throw new Error('模型为空，无法保存');
    return result.xml;
  }
```

---

### Fix 20 — Fix transient tab highlight during import

**ID:** Agent1-D5 · **Severity:** 🟢 Low · **Effort:** 5 min

Debounce `views.changed` handler or suppress tab updates while `importing === true`.

---

## Rejected Findings (No Action Required)

| ID | Original Claim | Reason |
|----|---------------|--------|
| Agent3-E05 | `view:set-checks` triggers unthrottled DoS-suitable menu rebuild | "Only on change" guard exists (main.cjs:330–333); state space = 3 booleans → max 6 transitions |
| Agent3-E06 | Lint panel `target="_blank"` links silently denied | **By design.** This is the M10 security fix (`setWindowOpenHandler → deny`). Intentional hardening. |

---

## Severity-Adjusted Findings (Summary)

| ID | Claimed → Final | Key Reason |
|----|-----------------|------------|
| Agent2-D1 | High → **Medium** | `saveXML()` rejects on blank DMN → visible error dialog; overwrite requires active user edit |
| Agent4-F2 | High → **Low** | Original import error IS shown via `showError`; `rebaseDirtyAfterRestore` sets dirty on exception |
| Agent3-E01 | Medium → **Low** | Requires XSS to exploit; CSP blocks injection |
| Agent3-E02 | Medium → **Low** | Same CSP mitigation |

---

## Verification & Regression Guardrails

After implementing Sprint 3 fixes, extend the existing verification scripts:

| Script | Add Coverage |
|--------|-------------|
| `scripts/verify/verify-dirty-guard.mjs` | `applyXmlEdits` no-op apply → ★ stays clear (Fix 5) |
| `scripts/verify/verify-dirty-guard.mjs` | Rapid `switchDmnView` + `createNewDiagram` → no interleaved import (Fix 1) |
| `scripts/verify/verify-zoom-dmn.mjs` | Zoom label correct after drill-down (Fix 12) |
| **New:** `verify-atomic-write.mjs` | Save interrupted by SIGKILL → original file intact (Fix 4) |

---

## Effort Summary

| Sprint | Fixes | Hours | Impact |
|--------|-------|-------|--------|
| **3** (Concurrency) | Fix 1–6 | ~2h | Eliminates race conditions; atomic saves; correct dirty tracking |
| **3b** (State corruption) | Fix 7–9 | ~2h | Prevents model/mode/identity divergence on failure |
| **4** (Polish) | Fix 10–20 | ~2h | UX consistency; defense-in-depth |
| **Total** | 20 fixes | **≈ 6h** | — |

**Recommended sequencing:** Fix 1 → 5 → 3 → 4 → 6 → 7 → 8 → 9 → remainder as time allows.
