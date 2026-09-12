# 贡献指南 (Contributing)

## 环境要求

- **Node.js** `^20.19.0 || >=22.12.0`（见 `package.json` 的 `engines`；CI 使用 Node 22）
- 运行端到端回归还需要：
  - **`Xvfb`**（脚本自建虚拟显示；Debian/Ubuntu：`sudo apt-get install -y xvfb`）
  - 一个已构建的 **AppImage**（见下）

## 本地开发

```sh
npm install
npm run dev            # http://localhost:5173
npm run build          # 产物 dist/（纯静态，可直接托管或双击打开）
npm run electron:dev   # 构建后以 Electron 启动桌面版
```

## 提交规范

本仓库使用 **Conventional Commits**，`type(scope): subject`，正文写 Why/What：

```
fix(ui): 顶部栏分级压缩，超小屏不再溢出

Why: ≤1240px 时文件组与视图组同时换行导致溢出
What: src/style.css 按实测内容宽度加 media query 断点，≤×××px 隐藏次要按钮
```

- `type` 取值：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`
- `scope` 由变更路径推导（如 `ui` / `verify` / `electron` / `release`）
- 一次提交只解决一个关注点；跨多个关注点请拆分（GitHub Release 的更新说明直接取自提交记录，拆分质量决定发布说明质量）

## 提交前门禁

按顺序执行，全绿再提交：

```sh
npm run lint:js          # ESLint 9 flat config，0 error（no-console 为 warn，允许存在）
npm run build            # lint:pack → lint:js → vite build → 内置规则文档
npm run test:smoke       # 45 项，jsdom 渲染冒烟，秒级
npm run test:verify      # 5 个纯逻辑套件 / 121 项断言，秒级
```

涉及运行时行为的改动，还必须跑全量端到端回归：

```sh
./build-head.sh --electron --targets AppImage   # 产出 release/**/*.AppImage
npm run test:verify:all                         # 12 个套件 / 247 项断言（含 7 个 CDP E2E）
```

`scripts/verify/run-all.mjs` 会自动递归定位 AppImage、逐套件分配唯一 `VERIFY_DISPLAY`、顺序执行并做超时
保护，把每套件原始输出写入 `verify-logs/`（已 gitignore）。常用参数：

```sh
node scripts/verify/run-all.mjs --pure                        # 只跑不需要 AppImage 的套件
node scripts/verify/run-all.mjs --only verify-zoom-dmn        # 只跑一项
node scripts/verify/run-all.mjs --appimage /path/to.AppImage  # 指定产物
node scripts/verify/run-all.mjs --fail-fast --timeout 300
```

CI（`.github/workflows/ci.yml`）在 master push 与 PR 上执行同一组门禁，因此**本地跑不过的一定过不了 CI**。

> 这些套件在真实打包产物中经 CDP 驱动 UI（`--appimage-extract-and-run --no-sandbox --ozone-platform=x11`）。
> Electron ≥33 在 Xvfb 下必须显式指定 `--ozone-platform=x11`，否则渲染进程起不来、拿不到 CDP page target。

## 新增回归断言

- 断言写进 `scripts/verify/`，使用 `scripts/lib/testkit.mjs` 的 `createTester()`。
- **必须**以 `process.exit(finish(...))` 结束 —— 裸 `finish()` 会丢弃返回码，断言全挂时进程仍退出 0
  （历史上真实踩过这个坑，见 `AUDIT-BACKLOG.md`）。
- 不需要显示器/DOM 的纯函数断言请加到 `scripts/verify/unit-render-units.mjs`，并在
  `scripts/lib/` 无依赖的前提下直接 import 被测模块。
- `scripts/diagnostics/` 存放**非门禁**的一次性复现脚本（无断言或已失效），不要往那里加测试。

## 发布流程

```sh
# 1. 提升版本（tag 必须等于 v + package.json 的 version，否则流水线第一步直接失败）
npm version 0.1.14 --no-git-tag-version
npm run build && npm run test:smoke && npm run test:verify

# 2. 提交并打 tag
git add package.json && git commit -m "chore(release): 版本升至 0.1.14"
git tag v0.1.14
git push origin master --tags
```

推送 tag 触发 `.github/workflows/release.yml`：Linux 与 Windows 并行原生构建 → Linux 侧跑全量回归与规则文档
校验 → 汇总为 GitHub Release（Web 静态包 + 全部安装包，说明取自 tag 间提交记录）。

前置要求：仓库 **Settings → Actions → General → Workflow permissions** 需为 *Read and write permissions*
（`GITHUB_TOKEN` 需要写权限创建 Release）。

## 规则文档的上游 ref

`scripts/fetch-rule-docs.mjs` 在构建时从上游固定 commit SHA 拉取规则文档写入 `dist/docs/`。
升级上游时用 `node scripts/fetch-rule-docs.mjs --update-refs` 打印当前 HEAD SHA，再更新脚本中的常量。
