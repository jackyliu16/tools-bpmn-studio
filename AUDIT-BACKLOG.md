# Audit Backlog — bpmn-studio

> 來源：v0.1.9 多維度代碼庫審計（2026-09-05，完整報告見 `AUDIT-REPORT.md`）。
> Sprint 1（H1–H5 靜默資料丟失群）已於 **v0.1.10** 修復完畢。
> 本檔案承載**其餘全部發現**，供後續迭代續作；完成任一項後請對應條目標記 `[x]` 並同步 AUDIT-REPORT.md。

## 驗證狀態（v0.1.10 已落地項，供上下文快速恢復）

- H1 關窗守門：preload `setDirtyState` / `onSaveBeforeClose` / `allowWindowClose` 三橋接；main.cjs `close` 攔截彈 取消/保存并关闭/放弃变更 三選框；渲染端 `saveFile()` 回傳 bool 並經 `window:close-ok` 放行關閉；純瀏覽器走 `beforeunload`
- H2 基線播種：`lastSavedXML` 語義 = 基線內容（匯入時=檔案內容）；`onBpmnStackChanged`/DMN `viewer.created` 的 null 守門降為啟動期安全網；導入收尾必須走 `setDirty(false)`（裸赋值會殘留 ★ — 00b3780）
- H3：BPMN `selection.changed` 已守門 `element?.businessObject?.$type`
- H4：`setDmnDiagram` 快照+`restorePreviousModel`+`rebaseDirtyAfterRestore`
- H5：`confirmDiscardUnsaved()` 掛在 `createNewDiagram`/`createNewDmnDiagram`/`openDiagramContent`
- 回歸防线：`scripts/verify/verify-dirty-guard.mjs`（17 項）+ `verify-zoom-dmn.mjs`（14 項）
- **手動遺留**（原生對話框無法自動化）：三按鈕點擊流、「保存并关闭」時另存對話框取消 → 視窗須保持打開、瀏覽器 beforeunload 提示

---

## Sprint 2（目標 v0.1.11）— 功能正確性 + 快速安全項

### M1 · DMN 模式匯出 SVG/PNG 必然 TypeError【高影響】
- `src/main.js` `saveActiveSvg()`（約 L740）：`modeler.saveSVG(...)` —— **dmn-js 全套（Modeler/Viewer/lib）無任何 `saveSVG` 實作**（node_modules 全文檢索 0 命中，非報告所稱 EditingManager 問題）。
- 修法二選一：(a) 從活躍 viewer 的 SVG 圖層序列化（DRD 視圖可用 `getGraphics()`/svg 節點克隆，注意 dmn-font 樣式內嵌）；(b) DMN 模式下禁用/隱藏 SVG、PNG 匯出入口並給提示。(a) 佳、成本高。
- 驗證：DMN 模式匯出 SVG 得合法檔案；PNG 同樣走通。

### M2 · DMN 模式工具欄撤銷/重做無效
- `src/main.js` L~2210：`btn-undo`/`btn-redo` 硬編碼 `bpmnModeler.get('undo')`。
- 修法：改用既有 `activeService('undo')?.undo()` / `activeService('redo')?.redo()`（`activeService` 已存在且 DMN 走 active viewer）。快捷鍵路徑已是正確寫法，可對齊。

### M3 · 非同步操作並發競態
- `createNewDiagram`/`createNewDmnDiagram`/`openDiagramContent`/`switchToDmnMode`/`switchToBpmnMode` 無互斥，連續觸發（快捷鍵連打/拖放+選單）會交錯 import。
- 修法：模組級 `_busy` 互斥 + `guarded(fn)` 包裝（報告 Fix 8 有範例）；忙碌時 `setStatus('处理中…')`。
- 長期解：模型切換生命週期狀態機（見架構備註）。

### M4 · XML 編輯器「套用」在 DMN 模式誤用 BPMN 預檢
- `applyXmlEdits`（L~1826）無條件 `precheckBpmnXml(editedXml)`，DMN 圖會報「缺少 \<BPMNDiagram\>」。
- **`precheckDmnXml` 已存在**（約 L905，DMN 匯入路徑在用）→ 修法僅 1 行：`editorMode === 'dmn' ? precheckDmnXml(...) : precheckBpmnXml(...)`。
- 連帶檢查 `applyXmlEdits` 全鏈路是否 mode-aware（其 import 走 `ensureModeler`/bpmn modeler——可能整個流程只適用 BPMN，若是則 DMN 模式應禁用 XML 編輯或完整適配，需先做小範圍勘定）。

### M5 · `markSaved`/髒游標 DMN 缺口
- `currentStackIdx()` 僅讀 `bpmnModeler`；DMN 保存後游標基準不適用（既有近似髒語義保存時清零，可接受）。
- 修法：在註釋中明確記錄該限制，或 DMN 分支返回 null 並在 `onBpmnStackChanged` 側文檔化。低優先。

### M6/M7 · 檔案讀取錯誤無上下文
- `els.fileInput` change（L~2540）與 drop（L~2560）內 `await file.text()` 無 try/catch；`openFile()` 的 IPC 調用同。
- 修法：try/catch → `showError({ title: '读取文件失败', ... })`（報告 Fix 10）。

### M8 · PNG 匯出 Object URL 洩漏
- `exportPNG`：`URL.revokeObjectURL(url)` 不在 `finally`，`img.onerror` 路徑洩漏。5 分鐘。

### M9 · `restorePreviousModel` 自身失敗靜默
- 還原再失敗僅 `console.warn`；使用者以為已還原。修法：上拋標記 → 狀態列/通知提示「恢復失敗，畫布可能為空」。

### M12 · 瀏覽器端 `Ctrl+Shift+S` 與選單語義衝突
- 瀏覽器 keydown 將 `Ctrl+Shift+S` 綁到匯出 SVG（L~2624 `e.shiftKey ? exportSVG()`），與 Electron 選單「另存為」衝突；`Ctrl+Shift+P` 亦被瀏覽器占用。修法：瀏覽器端移除該組合或改綁，保留選單語義。

### M13 · 瀏覽器端缺縮放/模擬快捷鍵
- 瀏覽器 keydown 表無 zoom+/−/0、令牌模擬（`CmdOrCtrl+Space`）等；`k==='f'` 未排 shift → `Ctrl+Shift+F`（選單=適應畫布）會先命中搜尋。修法：補快捷鍵 + `!shiftKey` 守門。

### M14 · 切換圖表後舊 lint 面板殘留
- `destroyModeler()` 未清 `els.lintList.innerHTML`。5 分鐘。

### M15 · CI Electron 快取順序錯誤
- `.github/workflows/release.yml` build-linux：快取步驟在 `npm ci` **之後** → 快取永不命中。修法：快取前移 + `restore-keys`。

### L16 · CSP 放行 `ws:`
- `index.html` L8：`connect-src 'self' ws:` → 移除 `ws:`（應用不需要 ws 連接；若 vite dev 依賴，僅 dev 注入放寬）。

### L1 · `applyXmlEdits` 清 `lastSavedAt` 語義不一致
- 套用 XML 後 `lastSavedAt = null` 但髒狀態由內容比較決定；對齊語義（要嘛都表徵「偏離存檔」）。2 分鐘。

### L4 · matchMedia 監聽回調無 try/catch
- 主題 auto 監聽內讀 prefs 可能拋。5 分鐘。

### L13 · `<input accept>` 含 `.txt`
- 移除 `.txt`。1 分鐘。

---

## Sprint 3（目標 v0.2.0）— 安全加固

### M10 · Electron 導航守衛
```js
win.webContents.on('will-navigate', (e) => e.preventDefault());
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

### M11 · `file:stat` IPC 未驗證路徑
- 任意路徑可 stat。修法：僅允許最近一次 `dialog:open-diagram` 返回過的路徑（主進程記 allowlist），或校驗路徑屬於會話中打開過的目錄。

### L18 · 全域 Electron sandbox
- `app.enableSandbox()`（`app.whenReady()` 前）。注意驗證既有 IPC 不受影響。

### L3 / L10 / L12 / L14 / L15 / L5 / L6 / L7 / L8 / L9 / L11 / L17（小項清單）
- [ ] L3 視圖選單 checkbox 狀態永不回同步（需 IPC 回環或移除 checkbox 型態）
- [ ] L10 匯出對話框 PNG/SVG 混在同一 `filters[]` 條目 → 拆分
- [ ] L12 另存 `.xml` 副檔名未納入正則 `/\.(bpmn|dmn)$/i` → 加 `|xml`
- [ ] L14 macOS 提示文案硬編碼 "Ctrl" → 讀 `studio.platform` 換 ⌘
- [ ] L15 瀏覽器端縮放重置無入口 → 補 `Ctrl+0` / 工具欄
- [ ] L5/L6 DMN 視圖切換/標簽邊界（隨 ActiveEditorContext 重構一併收編）
- [ ] L7 啟動 IIFE 內 `createNewDiagram()` 未 await（異步 IIFE 內補 await）
- [ ] L8 `describeFsError` 缺 `EEXIST/EMFILE/ENFILE/ENAMETOOLONG` 映射
- [ ] L9 `unhandledrejection` 回調內 `showError` 無 try/catch（自身拋錯會靜默吞掉）
- [ ] L11 （報告 L 表其余小項，見 AUDIT-REPORT.md Sprint 4 表）
- [ ] L17 （同上）

## Sprint 4（v0.2.0）— CI/衛生

- [ ] L19 CI `build-win` 無版本預檢步驟 → 複製 build-linux 的 version-check
- [ ] L20 `.web-asset` 未入 `.gitignore`

---

## 架構備註（根因級）

1. **DMN 未從 BPMN 中心程式碼一般化**：39 項中 8 項（M1/M2/M4/M5/H4/L5/L6 等）同一根因。建議引入 `ActiveEditorContext` 抽象（`editorContext.current` 統一暴露 modeler/命令棧/匯出能力），讓「忘記 DMN 分支」在結構上不可能。
2. **模型切換無生命週期狀態機**：M3 競態與 M9 靜默失敗同指此。`_busy` 互斥是務實止血，狀態機是長期解。
3. **`savedStackIdx` 依賴 diagram-js 內部 `_stackIdx`**：升級 diagram-js 必複核（main.js 已有註釋錨點）。

## 發布節奏建議

| 版本 | 範圍 | 狀態 |
|---|---|---|
| v0.1.10 | Sprint 1（H1–H5）+ setDirty 可見性修復 + 回歸腳本 | ✅ 已完成（未推 tag 發版） |
| v0.1.11 | M1–M7、M12–M15、L16、L1、L4、L13 | 待做（~2–3 天） |
| v0.2.0 | M10/M11、L18、ActiveEditorContext、CI 衛生 | 待重構就緒 |

> 提醒（release 管線規則）：發版前先將 `package.json` 升版並提交，tag 必須等於 `v` + 版本號再推送。
