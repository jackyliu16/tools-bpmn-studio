# Audit Backlog — bpmn-studio

> 來源：v0.1.9 多維度代碼庫審計（2026-09-05，完整報告見 `AUDIT-REPORT.md`）。
> Sprint 1（H1–H5 靜默資料丟失群）已於 **v0.1.10** 修復完畢。
> 本檔案承載**其餘全部發現**，供後續迭代續作；完成任一項後請對應條目標記 `[x]` 並同步 AUDIT-REPORT.md。
>
> **當前 repo 狀態（2026-09-05 Sprint 2 收尾更新）**：`master` HEAD 已含 Sprint 2 全部修復 + v0.1.11 版號，領先 `origin/master`（含未推的 v0.1.10 系列）。發版動作 = `git push && git tag v0.1.11 && git push --tags`（tag 必須等於 v+package.json 版本號，推 tag 即觸發 CI 發布）。

## 驗證狀態（v0.1.10 已落地項，供上下文快速恢復）

- H1 關窗守門：preload `setDirtyState` / `onSaveBeforeClose` / `allowWindowClose` 三橋接；main.cjs `close` 攔截彈 取消/保存并关闭/放弃变更 三選框；渲染端 `saveFile()` 回傳 bool 並經 `window:close-ok` 放行關閉；純瀏覽器走 `beforeunload`
- H2 基線播種：`lastSavedXML` 語義 = 基線內容（匯入時=檔案內容）；`onBpmnStackChanged`/DMN `viewer.created` 的 null 守門降為啟動期安全網；導入收尾必須走 `setDirty(false)`（裸赋值會殘留 ★ — 00b3780）
- H3：BPMN `selection.changed` 已守門 `element?.businessObject?.$type`
- H4：`setDmnDiagram` 快照+`restorePreviousModel`+`rebaseDirtyAfterRestore`
- H5：`confirmDiscardUnsaved()` 掛在 `createNewDiagram`/`createNewDmnDiagram`/`openDiagramContent`
- 回歸防线：`scripts/verify/verify-dirty-guard.mjs`（**21 項**，Sprint 2 新增 M1 DMN SVG 匯出 ×2 + M2 撤銷路徑 ×2）+ `verify-zoom-dmn.mjs`（14 項）——2026-09-05 對 Sprint 2 AppImage 實跑 **21/21 + 14/14 全過**（smoke 45/45）
- **Sprint 2 額外收獲（驗證抓出的既有隱藏 bug）**：bpmn-js 根本沒有 `undo` DI 服務，舊 `get('undo')` 永遠抛 "No provider" 被靜默吞掉 —— 撤銷/重做按鈕、Ctrl+Z/Y、選單項全部無效。已統一改走 `undoStack()`（diagram-js CommandStack.undo/redo，模式感知）。教訓：**断言要打在可觀察效果上（重命名回退），而不是依賴另一條未驗證的語義鏈（★ 清零）**。
- **手動遺留**（原生對話框無法自動化）：三按鈕點擊流、「保存并关闭」時另存對話框取消 → 視窗須保持打開、瀏覽器 beforeunload 提示

---

## Sprint 2（目標 v0.1.11）— 功能正確性 + 快速安全項

### M1 · DMN 模式匯出 SVG/PNG 必然 TypeError【高影響】✅ 已修（v0.1.11）
- `src/main.js` `saveActiveSvg()`（約 L740）：`modeler.saveSVG(...)` —— **dmn-js 全套（Modeler/Viewer/lib）無任何 `saveSVG` 實作**（node_modules 全文檢索 0 命中，非報告所稱 EditingManager 問題）。
- 修法二選一：(a) 從活躍 viewer 的 SVG 圖層序列化（DRD 視圖可用 `getGraphics()`/svg 節點克隆，注意 dmn-font 樣式內嵌）；(b) DMN 模式下禁用/隱藏 SVG、PNG 匯出入口並給提示。(a) 佳、成本高。
- 驗證：DMN 模式匯出 SVG 得合法檔案；PNG 同樣走通。

### M2 · DMN 模式工具欄撤銷/重做無效 ✅ 已修（v0.1.11，並順手根治 `undo` 服務不存在的既有 bug）
- `src/main.js` L~2210：`btn-undo`/`btn-redo` 硬編碼 `bpmnModeler.get('undo')`。
- 修法：改用既有 `activeService('undo')?.undo()` / `activeService('redo')?.redo()`（`activeService` 已存在且 DMN 走 active viewer）。快捷鍵路徑已是正確寫法，可對齊。

### M3 · 非同步操作並發競態 ✅ 已修（v0.1.11，guarded() 互斥）
- `createNewDiagram`/`createNewDmnDiagram`/`openDiagramContent`/`switchToDmnMode`/`switchToBpmnMode` 無互斥，連續觸發（快捷鍵連打/拖放+選單）會交錯 import。
- 修法：模組級 `_busy` 互斥 + `guarded(fn)` 包裝（報告 Fix 8 有範例）；忙碌時 `setStatus('处理中…')`。
- 長期解：模型切換生命週期狀態機（見架構備註）。

### M4 · XML 編輯器「套用」在 DMN 模式誤用 BPMN 預檢 ✅ 已修（v0.1.11，全鏈路 mode-aware）
- `applyXmlEdits`（L~1826）無條件 `precheckBpmnXml(editedXml)`，DMN 圖會報「缺少 \<BPMNDiagram\>」。
- **`precheckDmnXml` 已存在**（約 L905，DMN 匯入路徑在用）→ 修法僅 1 行：`editorMode === 'dmn' ? precheckDmnXml(...) : precheckBpmnXml(...)`。
- 連帶檢查 `applyXmlEdits` 全鏈路是否 mode-aware（其 import 走 `ensureModeler`/bpmn modeler——可能整個流程只適用 BPMN，若是則 DMN 模式應禁用 XML 編輯或完整適配，需先做小範圍勘定）。

### M5 · `markSaved`/髒游標 DMN 缺口 ✅ 已修（v0.1.11，註釋文檔化限制）
- `currentStackIdx()` 僅讀 `bpmnModeler`；DMN 保存後游標基準不適用（既有近似髒語義保存時清零，可接受）。
- 修法：在註釋中明確記錄該限制，或 DMN 分支返回 null 並在 `onBpmnStackChanged` 側文檔化。低優先。

### M6/M7 · 檔案讀取錯誤無上下文 ✅ 已修（v0.1.11）
- `els.fileInput` change（L~2540）與 drop（L~2560）內 `await file.text()` 無 try/catch；`openFile()` 的 IPC 調用同。
- 修法：try/catch → `showError({ title: '读取文件失败', ... })`（報告 Fix 10）。

### M8 · PNG 匯出 Object URL 洩漏 ✅ 已修（v0.1.11，revoke 進 finally）
- `exportPNG`：`URL.revokeObjectURL(url)` 不在 `finally`，`img.onerror` 路徑洩漏。5 分鐘。

### M9 · `restorePreviousModel` 自身失敗靜默 ✅ 已修（v0.1.11，狀態欄提示）
- 還原再失敗僅 `console.warn`；使用者以為已還原。修法：上拋標記 → 狀態列/通知提示「恢復失敗，畫布可能為空」。

### M12 · 瀏覽器端 `Ctrl+Shift+S` 與選單語義衝突 ✅ 已修（v0.1.11，對齊選單語義）
- 瀏覽器 keydown 將 `Ctrl+Shift+S` 綁到匯出 SVG（L~2624 `e.shiftKey ? exportSVG()`），與 Electron 選單「另存為」衝突；`Ctrl+Shift+P` 亦被瀏覽器占用。修法：瀏覽器端移除該組合或改綁，保留選單語義。

### M13 · 瀏覽器端缺縮放/模擬快捷鍵 ✅ 已修（v0.1.11，含 L15 的 Ctrl+0 入口）
- 瀏覽器 keydown 表無 zoom+/−/0、令牌模擬（`CmdOrCtrl+Space`）等；`k==='f'` 未排 shift → `Ctrl+Shift+F`（選單=適應畫布）會先命中搜尋。修法：補快捷鍵 + `!shiftKey` 守門。

### M14 · 切換圖表後舊 lint 面板殘留 ✅ 已修（v0.1.11，destroyModeler 清面板）
- `destroyModeler()` 未清 `els.lintList.innerHTML`。5 分鐘。

### M15 · CI Electron 快取順序錯誤 ✅ 已修（v0.1.11，快取前移 + restore-keys）
- `.github/workflows/release.yml` build-linux：快取步驟在 `npm ci` **之後** → 快取永不命中。修法：快取前移 + `restore-keys`。

### L16 · CSP 放行 `ws:` ✅ 已移除（v0.1.11。若 dev 期 vite HMR 受影响會自動降 polling）
- `index.html` L8：`connect-src 'self' ws:` → 移除 `ws:`（應用不需要 ws 連接；若 vite dev 依賴，僅 dev 注入放寬）。

### L1 · `applyXmlEdits` 清 `lastSavedAt` 語義不一致 ✅ 已修（v0.1.11，保留真實存檔時間）
- 套用 XML 後 `lastSavedAt = null` 但髒狀態由內容比較決定；對齊語義（要嘛都表徵「偏離存檔」）。2 分鐘。

### L4 · matchMedia 監聽回調無 try/catch ✅ 已修（v0.1.11）
- 主題 auto 監聽內讀 prefs 可能拋。5 分鐘。

### L13 · `<input accept>` 含 `.txt` ✅ 已修（v0.1.11）
- 移除 `.txt`。1 分鐘。

---

## Sprint 3（目標 v0.2.0）— 安全加固

### M10 · Electron 導航守衛 ✅ 已修（v0.1.11 提前收編）
```js
win.webContents.on('will-navigate', (e) => e.preventDefault());
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

### M11 · `file:stat` IPC 未驗證路徑 ✅ 已修（v0.1.11 提前收編，對白名單）
- 任意路徑可 stat。修法：僅允許最近一次 `dialog:open-diagram` 返回過的路徑（主進程記 allowlist），或校驗路徑屬於會話中打開過的目錄。

### L18 · 全域 Electron sandbox ✅ 已修（v0.1.11，`app.enableSandbox()`）
- `app.enableSandbox()`（`app.whenReady()` 前）。注意驗證既有 IPC 不受影響。

### L3 / L10 / L12 / L14 / L15 / L5 / L6 / L7 / L8 / L9（小項清單）
- [x] L3 視圖選單 checkbox 狀態永不回同步 → 已修（v0.1.11 提前收編）：渲染進程為真相源，面板可見性變化時經 `view:set-checks` IPC 推平，主進程僅在布爾值變化時重建菜單；順手修正 lint 面板初始態三重謊言（`lintVisible=true`/按鈕 active/面板實際 hidden → 首击無效），選單初始 lint=false 對齊實際。驗證注意：原生選單渲染不可 CDP 自動化，但橋接存在性與交互零退化已進 21 項檢查；勾選視覺回同步需人工瞥一眼（切換屬性面板/校驗面板後看選單）。
- [x] L10 匯出對話框 PNG/SVG 混在同一 `filters[]` 條目 → 拆分（v0.1.11）
- [x] L12 另存 `.xml` 副檔名未納入正則 → 已加 `|xml`（v0.1.11，匯出 baseName 兩處）
- [x] L14 macOS 提示文案硬編碼 "Ctrl" → 啟動時依 `studio.platform` 換 ⌘（v0.1.11）
- [x] L15 瀏覽器端縮放重置無入口 → 已補 `Ctrl+0`（隨 M13；工具欄按鈕未加，如需再補）
- [ ] L5/L6 DMN 視圖切換/標簽邊界（隨 ActiveEditorContext 重構一併收編）
- [x] L7 啟動 IIFE 內 `createNewDiagram()` 未 await（v0.1.11）
- [x] L8 `describeFsError` 缺 `EEXIST/EMFILE/ENFILE/ENAMETOOLONG` 映射（v0.1.11）
- [x] L9 `unhandledrejection` 回調內 `showError` 無 try/catch（v0.1.11）

> **關於 L11 / L17**：審計去重階段的最後兩項 low 級發現，其描述未被最終 AUDIT-REPORT.md 的修復計畫承接（報告修復表僅列 L1–L20 中的 18 項 L），原始細節在報告固化後已不可考（workflow 明細輸出未持久化，會話日誌亦無殘留）。如需窮盡 low 級掃描，重跑一次 `codebase-audit` 的 maintainability/security 維度即可覆蓋，勿憑推測補寫。

## Sprint 4（v0.2.0）— CI/衛生

- [x] L19 CI `build-win` 無版本預檢步驟 → 已複製 version-check（v0.1.11 提前收編）
- [x] L20 `.web-asset` 未入 `.gitignore`（v0.1.11）

---

## 架構備註（根因級）

1. **DMN 未從 BPMN 中心程式碼一般化**：39 項中 8 項（M1/M2/M4/M5/H4/L5/L6 等）同一根因。建議引入 `ActiveEditorContext` 抽象（`editorContext.current` 統一暴露 modeler/命令棧/匯出能力），讓「忘記 DMN 分支」在結構上不可能。
2. **模型切換無生命週期狀態機**：M3 競態與 M9 靜默失敗同指此。`_busy` 互斥是務實止血，狀態機是長期解。
3. **`savedStackIdx` 依賴 diagram-js 內部 `_stackIdx`**：升級 diagram-js 必複核（main.js 已有註釋錨點）。

## 發布節奏建議

| 版本 | 範圍 | 狀態 |
|---|---|---|
| v0.1.10 | Sprint 1（H1–H5）+ setDirty 可見性修復 + 回歸腳本 | ✅ 已完成（未推 tag 發版） |
| v0.1.11 | Sprint 2 全部（M1–M15、L1/L3/L4/L7–L14/L16/L18–L20）+ undo 服務既有 bug 根治 + lint 面板初始態修正 | ✅ 已完成（未推 tag 發版） |
| v0.2.0 | ActiveEditorContext 重構（收編 L5/L6）+ 模型生命週期狀態機 | 待重構規劃 |

---

## 剩餘未解決問題總覽（2026-09-05 Sprint 2 收尾盤點）

> 代碼級審計發現至此已消納 **34/39**（H1–H5、M1–M15、L1–L4、L7–L14、L16、L18–L20）。

### A. 待重構項（v0.2.0，非缺陷，是結構債）
- **L5/L6** — DMN 視圖切換/標簽邊界 case，依賴 ActiveEditorContext 抽象（根因備註 §1）
- **架構備註 §1–§3** — ActiveEditorContext / 模型生命週期狀態機 / `_stackIdx` 升級複核（已有註釋錨點）

### B. 不可恢復項（需重跑審計覆蓋，勿憑推測補寫）
- **L11 / L17** — 審計去重階段被合併的 2 項 low 級發現，原始細節已不可考 → 重跑 `codebase-audit` maintainability/security 維度即可覆蓋

### C. 人工驗證清單（原生 UI 無法 CDP 自動化，發版前應過一遍）
1. 三按鈕關窗對話框點擊流（取消/保存並關閉/放棄變更）
2. 「保存並關閉」時另存對話框點取消 → 窗口須保持打開
3. 純瀏覽器構建刷新/關頁觸發 beforeunload 提示
4. 切換屬性面板/校驗面板/小地圖後，視圖選單勾選標記須跟隨真實狀態（L3，本次新增）
5. 新建圖首次點「✔ 校驗」按鈕 → 面板應立即展開（初始態修正後，本次新增）

### D. 發布動作（非代碼問題，待人工觸發）
- `git push && git tag v0.1.11 && git push --tags`（tag 必須等於 v+package.json 版本；v0.1.10 從未發過，v0.1.10 與 v0.1.11 內容已在 master 線性疊加，可直接發 v0.1.11）

> 提醒（release 管線規則）：發版前先將 `package.json` 升版並提交，tag 必須等於 `v` + 版本號再推送。
