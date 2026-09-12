# scripts/diagnostics — 非门禁的一次性复现脚本

这里的脚本**不是测试**，不参与 CI，也不在 `scripts/verify/run-all.mjs` 的门禁清单里。
它们是 v0.1.9 审计期间为定位具体缺陷写的一次性复现/观察脚本，保留下来仅作历史证据。

| 脚本 | 性质 | 状态 |
| --- | --- | --- |
| `plain-node-check.mjs` | 用 bpmn-moddle + 打包后的 lint 配置观察 `incoming`/`outgoing` 反向引用缺失导致的 7 条误报。只 `console.log`，无断言、无退出码。 | 已被 `rebuildFlowNodeBackrefs` 修复取代 |
| `check-backref-fix.mjs` | 手工补 `incoming`/`outgoing` 后重跑 lint，确认误报消失 → 根因定位。只打印，无断言。 | 同上 |
| `repro-diagnostic.mjs` | 复现诊断信息收集序列（saveXML → importXML → linting.completed → canvas.resized）。 | **已不可运行**：依赖 `diagram-js/lib/util/EscapeUtil` 的旧路径，升级后模块解析失败 |
| `test-lint-patch.mjs` | 验证对 `bpmn-js-bpmnlint` 内部 `_formatIssues` / `_createIssues` 打原型补丁的老方案。 | **已失效**：8/9 断言失败（`_createIssues` 内部结构已变），该方案已被根因修复取代 |

## 为什么归档而不是删除

审计报告（`AUDIT-REPORT-v0.1.11.md`）与 `AUDIT-BACKLOG.md` 会引用这些脚本的结论。保留可执行的历史证据
比只留文字描述更可复查；同时把它们移出门禁目录，避免「跑起来不报错」被误读为「测试通过」。

## 为什么不能当门禁

`plain-node-check.mjs` / `check-backref-fix.mjs` / `repro-diagnostic.mjs` 无论发现多少问题都退出 0，
放进 CI 只会制造虚假的绿色。回归断言请写进 `scripts/verify/`，并使用 `scripts/lib/testkit.mjs`
的 `createTester()` + `process.exit(finish())` 保证失败传播到退出码。
