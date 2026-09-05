# Audit Backlog — bpmn-studio

> **当前追踪：v0.1.11 多维审计（2026-09-05 重跑，报告见 `AUDIT-REPORT-v0.1.11.md`）**。
> 修复落地目标 **v0.1.12**（Sprint 3 / 3b / 4，共 20 项）。完成一项勾选一项并同步报告。
>
> **历史（已归档，勿再追踪）**：v0.1.9 审计（原 `AUDIT-REPORT.md`，报告文件已随全部发现消纳而删除）——
> Sprint 1（H1–H5，v0.1.10）+ Sprint 2（M1–M15、L1–L10、L12–L16、L18–L20，v0.1.11）全部落地，
> 代码级发现消纳 36/39；其余 L11/L17（当时去重阶段细节不可考）已由本轮 v0.1.11 重跑审计覆盖，**该遗留项关闭**。
> 全部修复过程与验证结论见 git history（`chore(release): 0.1.10` / `0.1.11` 系列提交）。

---

## Sprint 3 — 并发锁缺口与状态正确性（Fix 1–6）

- [x] Fix 1 · `switchDmnView` / `applyXmlEdits` 纳入 `guarded()`（🟠 锁契约违例，3 agent 独立命中）
- [x] Fix 2 · `saveFile` 读模型前检查 `_modelBusy`（🟢）
- [x] Fix 3 · 模型销毁时退出 XML 面板编辑态，防止旧图 XML 被 Apply 进新图（🟠）
- [x] Fix 4 · 文件写入改原子写（tmp+rename）：`dialog:save-diagram`、`dialog:export-file`、window-state、prefs（🟠 崩溃/磁盘满损毁原文件）
- [x] Fix 5 · XML Apply 后 ★ 假阳性：基线播种改为序列化规范形态（canonical），游标恢复（🟠）
- [x] Fix 6 · 已有路径的「保存」直写文件，不再弹另存对话框（🟠 破坏关窗守卫 UX）

## Sprint 3b — 失败路径状态腐化（Fix 7–9）

- [x] Fix 7 · 跨模式打开失败：回滚编辑器模式 + 恢复原模型与身份（🟠，实为高影响——BPMN 图会被销毁后只剩 DMN 空骨架）
- [x] Fix 8 · 导入失败回滚用快照自身平台的 modeler（🟠 平台切换后回滚丢 camunda/zeebe 扩展属性）
- [x] Fix 9 · DMN 视图 tab 由 `getViews()` 动态生成（含 boxedExpression；**顺带关闭 v0.2.0 遗留「多决策表/多字面表达式视图不可达」**）（🟠）

## Sprint 4 — 低优先加固（Fix 10–20）

- [x] Fix 10 · destroyModeler 清小地图按钮 active（🟢）
- [x] Fix 11 · destroy 时清状态栏右侧选中信息（🟢）
- [x] Fix 12 · DMN 视图切换/下钻后同步缩放标签（🟢）
- [x] Fix 13 · `copyTextToClipboard` execCommand 兜底返回真实结果（🟢）
- [x] Fix 14 · 主进程关窗对话框重入守卫（🟢）
- [x] Fix 15 · DMN 画布支持拖放打开（🟢）
- [x] Fix 16 · DMN `import.done` 检查 `event.error`（🟢）
- [x] Fix 17 · 保存对话框过滤器按当前模式排序（🟢）
- [x] Fix 18 · `prefs:set` 键白名单 + XML 面板粘贴纯净化（🟢 纵深防御）
- [x] Fix 19 · `saveActiveXml` 空结果守门（🟢）
- [x] Fix 20 · 导入完成后强制收敛 tab 高亮/缩放标签（🟢 以确定性收敛替代事件去抖）

---

## 架构备注（根因级，v0.2.0）

1. **DMN 未从 BPMN 中心代码泛化**：引入 `ActiveEditorContext` 抽象（`editorContext.current` 统一暴露 modeler/命令栈/导出能力），让「忘记 DMN 分支」在结构上不可能。
2. **模型切换无生命周期状态机**：`_busy` 互斥（guarded）是务实止血，状态机是长期解。
3. **`savedStackIdx` 依赖 diagram-js 内部 `_stackIdx`**：升级 diagram-js 必复核（main.js 已有注释锚点）。

---

## v0.1.12 落地记录（2026-09-05，未提交）

全部 20 项已实现，运行时验证：**`scripts/verify/verify-sprint3.mjs` 13 项新增检查全过**（display `:79`/port 9335），叠加既有 `verify-zoom-dmn.mjs` 17 项 + `verify-dirty-guard.mjs` 21 项均绿。

与报告原补丁的实现差异（均为报告补丁本身不可直接套用处的修正）：
- **Fix 4**：实际代码是 `fs.promises.writeFile`（非补丁里的 `writeFileSync`）；新增 async/sync 两枚 `writeFileAtomic*` 帮助函数，覆盖 save/export/window-state/prefs 四处。
- **Fix 5**：报告补丁会让「apply 后未保存即清脏」丢数据。改为**基线播种规范化**（导入/保存均存序列化输出）+ apply 后同构比较；序列化失败退回保守置脏。另：`setBpmnDiagram` 后命令栈游标播种为真实栈位（非 null），撤到底自动回干净态（与 markSaved 同语义，比原「一律置脏」更精确）。
- **Fix 6**：新增 `dialog:save-diagram-direct` IPC，主进程按 `statAllowedPaths`（与 file:stat 的 M11 白名单同语义）拒写未经对话框确认的路径。
- **Fix 9**：动态 tab 保留每类型首个的固定 id（`btn-dmn-*`，CDP 锚点）；同类型第 N 个用 `-N` 后缀 id；模型缺失的类型仍渲染禁用占位（保留 v0.1.11「死点不静默」语义）。
- **Fix 3**：除 destroy 路径外，`setBpmnDiagram/setDmnDiagram` 成功尾部也退出编辑态（同模式 open/新建不走 destroy，仅靠销毁路径兜不住）。
- **Fix 7+8**：合并为 `setDiagram` 层跨模式快照 + `rollbackAfterFailedModeSwitch`；回滚模型器按快照自身平台 `ensureModeler(previousXml)` 创建。
- **Fix 19**：`saveActiveXml` 空结果归一为 `null`（与全库 null 契约一致，比补丁的守门语义更保守）。

## 人工验证清单（原生 UI 无法 CDP 自动化，发版前应过一遍）

1. 三按钮关窗对话框点击流（取消/保存并关闭/放弃变更）——注意 v0.1.12 起「保存并关闭」对已命名文件为**静默直写**，不再弹另存框
2. 未命名文件的「保存并关闭」→ 弹框后点取消 → 窗口须保持打开
3. 纯浏览器构建刷新/关页触发 beforeunload 提示
4. 切换属性面板/校验面板/小地图后，视图菜单勾选标记须跟随真实状态
5. 新建图首次点「✔ 校验」按钮 → 面板应立即展开
6. （v0.1.12 新增）磁盘满/中途 kill 进程时保存 → 原文件完好（可 `ulimit -f` 模拟）
7. （v0.1.12 新增）XML 面板编辑模式 → 直接打开另一文件 → 面板应退出编辑态且内容随新模型刷新
8. （v0.1.12 新增）DRD 里建第二个决策 → tab 栏应出现第二个决策表 tab 且可切换

## 发布动作（非代码问题，待人工触发）

- `git push && git tag v0.1.12 && git push --tags`（tag 必须等于 v+package.json 版本；v0.1.10/v0.1.11 从未发过 tag，内容已线性叠加在 master，可直接发 v0.1.12）
- 发版前先升 `package.json` 版本并提交。
