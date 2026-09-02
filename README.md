# BPMN Studio

A nearly full-featured, standalone **BPMN 2.0 / DMN editor** built on the [bpmn.io](https://bpmn.io) toolkit.
It runs in two ways:

1. **Web** — any machine with `npm` (or any static file server): `npm install && npm run build`
2. **Desktop** — packaged Linux/Windows app via **Electron + electron-builder** (`npm run dist`)

---

## 1. 仓库评估 (Repo Evaluation)

This project was designed after evaluating the four bpmn-related repositories checked out in this workspace.

| Repo | Version (checked out) | 是什么 | 在本项目中的角色 |
| --- | --- | --- | --- |
| [`bpmn-js`](https://github.com/bpmn-io/bpmn-js) | 18.25.1 | BPMN 2.0 toolkit（渲染 + 建模引擎） | **核心引擎**。开箱即用提供调色板 palette、context pad、对齐/分布、复制粘贴、空格工具、网格吸附、子流程钻取、键盘快捷键、撤销/重做、**搜索**等完整建模能力（见 `lib/features` 与 `lib/Modeler.js` 的模块清单）。 |
| [`bpmn-moddle`](https://github.com/bpmn-io/bpmn-moddle) | 10.2.0 | BPMN 2.0 XML ↔ JS 对象模型（读写 XML） | bpmn-js 的依赖，负责 `importXML` / `saveXML` 的所有 XML 解析与序列化。 |
| [`bpmn-js-examples`](https://github.com/bpmn-io/bpmn-js-examples) | (main) | 27 个教学示例应用（每个都是独立 webpack 小程序） | **功能清单参考**。本项目综合了其中最相关的示例：`properties-panel`（属性面板）、`modeler`（基础建模器）、`minimap`、`i18n`、`theming`、`colors`、`overlays`、`custom-modeling-rules`、`deep-linking` 等。注意：这些示例只是"零件"，不是产品——必须自行组合。 |
| [`dmn-js`](https://github.com/bpmn-io/dmn-js) | 17.10.2 | DMN 1.3/1.4 决策建模工具包（DRD / 决策表 / 文字表达式） | **已集成**。作为第二个编辑器模块，支持 `.dmn` 文件自动识别与切换，提供 DRD / Decision Table / Literal Expression 三种视图。 |

### 评估结论

- **bpmn-js 18 自带约 90% 的"建模"能力**（对齐、分布、空格工具、搜索、网格、复制粘贴、撤销重做、子流程等全部内置），
  需要自行组装的主要是**外围工程**：属性面板、校验、模拟、小地图、颜色、文件 IO 与桌面壳。
- `bpmn-js-examples/properties-panel` 是最贴近目标形态的参考（modeler + properties panel + 文件拖放/下载），
  但它只覆盖了 bpmn-js-properties-panel 的**基础 BPMN provider**（不包含 Camunda 执行属性），且打包方式为 webpack 的 *teaching* 配置。
- 因此本项目采用 **Vite**（对 bpmn-js ESM 生态最顺）重新组装一个"接近全功能"的产品：
  - 完整建模（bpmn-js 内置）
  - 属性面板：BPMN + **Camunda Platform 7**（`camunda-bpmn-moddle`）+ **Camunda 8 / Zeebe**（`zeebe-bpmn-moddle`）执行属性
  - **bpmnlint** 模型校验（`bpmnlint:recommended` + `bpmnlint-plugin-camunda/recommended`，用 `bpmnlint-pack-config` 打包进浏览器）
  - **令牌模拟**（`bpmn-js-token-simulation`）
  - **小地图**（`diagram-js-minimap`）、**着色**（`bpmn-js-color-picker`，BPMN in Color 序列化）
  - 文件：新建 / 打开 / 拖放 / 保存 / 导出 BPMN、SVG、PNG；脏标记与防抖保存
  - 桌面：原生菜单、原生打开/保存对话框、窗口标题脏标记
  - **DMN 决策建模**（`dmn-js`）：`.dmn` 文件自动识别，DRD / Decision Table / Literal Expression 视图切换

---

## 2. 特性清单 (Features)

**建模**
- 完整 BPMN 2.0 图形（事件、活动、网关、泳道、人工/服务/脚本/子流程等）、调色板、上下文菜单、替换元素
- 对齐 / 分布 / 空格工具 / 网格吸附 / 复制粘贴 / 撤销重做 / 自适应缩放 / 搜索元素（工具栏 🔍 或 Ctrl+F）
- 颜色（BPMN in Color，序列化到 XML）

**属性**
- 通用 BPMN 属性（通用、文档、流程、参与者、事件定义、任务类型、条件等）
- Camunda Platform 7 执行属性（`camunda:*`）
- Camunda 8 / Zeebe 执行属性（`zeebe:*`）

**质量与运行**
- bpmnlint 模型校验（问题面板，点击查看规则统计）
- 令牌模拟：播放工作流，观察令牌流经路径

**DMN 决策建模**
- DRD（决策需求图）：拖拽决策、知识模型、输入数据、业务知识模型
- Decision Table（决策表）：输入/输出列、规则行、命中策略
- Literal Expression（文字表达式）：FEEL 表达式编辑
- 视图切换：顶部工具栏 DRD / 决策表 / 文字表达式 一键切换
- 自动识别：打开 `.dmn` 文件自动切换到 DMN 编辑器
- 新建：菜单「新建 DMN 图」(`Ctrl+Shift+N`) 或打开 `.dmn` 文件自动进入

**文件**
- 新建 / 打开（原生对话框 or 浏览器文件选择）/ 拖放导入
- 保存 `.bpmn` / `.dmn`（原生另存为 or 下载）
- 导出 SVG / PNG
- 脏标记（`*` 提示），未保存提示

**界面**
- 工具栏、状态栏（缩放、选中元素类型）、右侧属性面板、底部校验面板、小地图
- **可收缩的右侧属性面板**：点击面板左边框的细条、菜单「视图 → 属性面板」或 `Ctrl+Shift+B` 可收起/展开，收起的状态会记住（重新打开程序后保持）；收起后画布自动占满剩余空间
- **XML 视图**（工具栏 `XML` 按钮）：查看当前图表**完整的格式化 XML**，
  - **选中节点/连线时自动高亮对应的 XML 段落**——黄色标记该元素的模型定义（`<bpmn:*>`），蓝色标记对应的图形定义（`<bpmndi:BPMNShape/BPMNEdge>`，含 `<dc:Bounds>`），可一键自动滚动定位
  - XML 语法着色、可复制完整 XML、随编辑实时刷新（防抖）
- **文件与图表元数据**（工具栏 `ⓘ 元数据` / 菜单「文件 → 文件与图表元数据…」，`Ctrl+Alt+I`）：
  - 文件信息：文件名、路径（桌面端）、是否已修改、保存时间、文件大小、磁盘修改时间（桌面端 stat）
  - 文档信息：`Definitions ID`、目标命名空间、导出工具/版本、执行平台（应用识别值 + 文件声明的 `modeler:executionPlatform`）、流程名称/ID/是否可执行、泳道情况
  - 图表统计：节点数、连线数、元素类型数 + 按类型的完整明细（`StartEvent`、`Task`、`Gateway`…）
- **大号错误提示**：错误不再用 `alert()`，统一显示全屏半透明遮罩层的大卡片——大图标 + 大标题 + 大字号错误信息，
  可展开「详细错误信息」（堆栈 + 定位行/列），支持「复制错误信息」；打开/导入/保存/导出失败都会触发
- 非致命导入警告显示为顶部黄色提示条，「详情…」可查看完整警告列表（含行/列）
- 键盘快捷键：`Ctrl+N`（BPMN）、`Ctrl+Shift+N`（DMN）、`Ctrl+O/S`、`Ctrl+Shift+S`（SVG）、`Ctrl+Shift+P`（PNG）、`Ctrl+Shift+B`（收起/展开属性面板）、`Ctrl+F`（搜索）、`Ctrl+Alt+I`（元数据）、`Esc`（关闭弹层）

---
### 3.1 重要架构决策：按执行平台加载 moddle 扩展

`camunda-bpmn-moddle` 与 `zeebe-bpmn-moddle` **不能同时注册到同一个 modeler**：
- 两者都在各自的命名空间定义了 `TemplateSupported`（`modelerTemplate` / `modelerTemplateVersion` 属性名冲突），
  moddle 会报 `property <modelerTemplate> already defined; override ... not allowed without redefines`，
  导致**所有** BPMN 文件（包括纯 BPMN）都无法导入。
- 这与 Camunda Modeler 的处理一致：根据图表的执行平台，只加载匹配的 moddle 扩展与属性 provider。

本项目在打开/新建图表时按 XML 命名空间自动选择平台（`src/main.js` 的 `detectPlatform`）：

| 检测到的命名空间 | 平台 | moddle 扩展 | 属性 provider |
| --- | --- | --- | --- |
| `http://camunda.org/schema/zeebe/1.0` | Camunda 8 | `zeebe-bpmn-moddle` | `ZeebePropertiesProviderModule` |
| `http://camunda.org/schema/1.0/bpmn` | Camunda 7 | `camunda-bpmn-moddle` | `CamundaPlatformPropertiesProviderModule` |
| （无） | 纯 BPMN | — | 只有基础 BPMN provider |

> 注意：`camunda-bpmn-moddle@8` 使用的新版命名空间是 `http://camunda.org/schema/1.0/bpmn`（Camunda Modeler 现代导出格式）。
> 旧版 `http://camunda.org/schema/bpmn` 文件仍可无损打开（属性会以 `$attrs` 保留并原样回写）。

---

## 3. 快速开始 (Quick Start)

要求：**Node.js ≥ 20.19** 与 npm（任意有 npm 的机器）。

```sh
# 安装依赖（首次）
npm install

# 开发模式：http://localhost:5173
npm run dev

# 生产构建：产物在 dist/（纯静态，可直接部署或双击打开）
npm run build
npm run preview          # 本地预览 dist
npm run serve            # 局域网可访问的静态服务

# 渲染进程冒烟测试（Node + jsdom，无需浏览器/显示器）
npm run test:smoke       # 验证 纯BPMN / Camunda 7 / Camunda 8 / DMN 四种场景（44 项）
```

`dist/` 是自包含静态站点：任何静态服务器（nginx、`npx serve`、GitHub Pages…）都能托管，
`vite.config.js` 使用相对路径，因此也可以直接用浏览器打开 `dist/index.html`。

---

## 4. 桌面应用 (Desktop)

```sh
npm run dist:linux      # Linux: AppImage + deb + tar.gz → release/
npm run dist:win        # Windows: NSIS 安装包 + zip
npm run dist            # Linux 三件套
```

产物位于 `release/`：

**Linux**
```
release/BPMN Studio-0.1.2.AppImage     # 免安装，chmod +x 后直接运行
release/bpmn-studio_0.1.2_amd64.deb    # Debian/Ubuntu 安装包
release/bpmn-studio-0.1.2-linux-x64.tar.gz
```

**Windows (x64)**
```
release/BPMN Studio Setup 0.1.2.exe    # NSIS 安装程序（双击安装）
release/BPMN Studio-0.1.2-win.zip      # 便携版：解压后运行 BPMN Studio.exe
release/win-unpacked/                  # 免安装目录（可直接双击运行）
```

> 本机（Linux + wine）已成功构建 Windows 包（wine 仅用于 rcedit 改写 exe 资源/签名步骤；
> NSIS 使用 Linux 原生 makensis）。跨平台打包保持可用：
> `ELECTRON_CACHE`/`ELECTRON_BUILDER_CACHE` 已复用本地缓存的 electron-29 与 nsis 工具链。

---

## 5. 验证记录 (Verification)

本项目在本机（NixOS 容器环境）完成了以下验证：

- **渲染进程冒烟测试（44/44 通过）** — `npm run test:smoke`
  - 纯 BPMN：导入零告警、渲染元素、8 个扩展服务（属性面板/小地图/校验/模拟/搜索/着色）全部可用、XML 往返
  - Camunda 7：`camunda:modelerTemplate` 属性读取与回写、`camundaPlatformPropertiesProvider` 注册
  - Camunda 8：`zeebe:taskDefinition` 读取与回写、`zeebePropertiesProvider` 注册
  - DMN DRD：导入、DRD 视图渲染、Decision Table 视图切换、视图切换往返
  - DMN 编辑器模块：`createDmnModeler` 导出、`EMPTY_DMN_XML` 模板、definitions 加载
  - bpmnlint 打包配置（`{ config, resolver }`）由 `bpmn-js-bpmnlint` 正确消费
  - 冒烟测试用 jsdom 在 Node 中运行真实模块（`vite-node`），不需要浏览器/显示器
- **Web 构建与托管** — `vite build` 产出自包含 `dist/`（相对路径），`vite preview` + 静态服务器均 200
- **桌面打包** — electron-builder 产出 `release/`：AppImage（约 108 MB）、deb、tar.gz；`app.asar` 内含
  `dist/` + Electron 主进程/预加载脚本

> ⚠️ 本开发容器无法运行 Chromium（内核级 seccomp 在浏览器进程初始化处投递 `SIGTRAP`，与项目本身无关），
> 因此 `Electron` 窗口的 GUI 运行请在**普通 Linux 桌面 / Windows / macOS** 上验证：
> `npm run electron:dev`（开发）或直接运行 `release/` 中打包好的应用。
> 仓库还附带 `electron/verify.cjs`（`npx electron electron/verify.cjs`），会在真实 Electron 中加载应用、
> 检查画布/调色板/属性面板/小地图并截图到 `/tmp/bpmn-studio-shot.png` 后退出。

---

## 6. 项目结构 (Layout)

```
bpmn-studio/
├── index.html               # 应用外壳（工具栏 / 画布 / DMN 视图切换 / 属性面板 / 校验面板 / 状态栏）
├── vite.config.js           # base:'./' 以同时支持静态托管与 Electron file://
├── .bpmnlintrc              # bpmnlint 规则配置（recommended + camunda recommended）
├── resources/
│   ├── newDiagram.bpmn      # 新图默认内容
│   └── icon.png             # 应用图标（scripts/make-icon.mjs 生成）
├── src/
│   ├── main.js              # 渲染进程入口：BPMN/DMN 模式切换、modeler 组装、工具栏、文件 IO、快捷键
│   ├── dmn-editor.js        # DMN 编辑器模块（dmn-js Modeler 封装、样式导入、模板）
│   ├── style.css            # 应用外壳样式
│   └── lint-config.js       # 由 `npm run lint:pack` 生成的打包校验配置
├── electron/
│   ├── main.cjs             # Electron 主进程：窗口、原生菜单、文件对话框 IPC（支持 .bpmn + .dmn）
│   └── preload.cjs          # contextBridge 暴露 window.bpmnStudio
└── scripts/
    ├── smoke.mjs            # 冒烟测试（BPMN × 3 平台 + DMN × 3 场景，44 项）
    └── make-icon.mjs        # 纯 Node 生成 PNG 图标
```

### 渲染进程模块组装（src/main.js）

```js
import BpmnModeler from 'bpmn-js/lib/Modeler';

new BpmnModeler({
  container: '#js-canvas',
  propertiesPanel: { parent: '#js-properties-panel' },
  additionalModules: [
    BpmnPropertiesPanelModule,          // bpmn-js-properties-panel
    BpmnPropertiesProviderModule,       // 通用 BPMN 属性
    CamundaPlatformPropertiesProviderModule, // Camunda 7 执行属性
    ZeebePropertiesProviderModule,      // Camunda 8 / Zeebe 执行属性
    MinimapModule,                      // diagram-js-minimap
    BpmnColorPickerModule,              // bpmn-js-color-picker
    BpmnLintModule,                     // bpmn-js-bpmnlint
    TokenSimulationModule               // bpmn-js-token-simulation
  ],
  moddleExtensions: {
    camunda: camundaModdle,             // camunda-bpmn-moddle
    zeebe: zeebeModdle                  // zeebe-bpmn-moddle
  },
  linting: { bpmnlint: lintConfig }     // src/lint-config.js (bpmnlint-pack-config)
});
```

Electron 集成方式：预加载脚本注入 `window.bpmnStudio`，渲染进程据此选择
"原生对话框 + 菜单" 或 "浏览器文件选择 + 下载" 两套文件路径（同一份代码，双端运行）。

### 关键依赖 (Key Dependencies)

| 包 | 版本 | 作用 |
| --- | --- | --- |
| bpmn-js | 18.25.1 | BPMN 模型器核心 |
| dmn-js | 17.10.2 | DMN 决策建模器（DRD / Decision Table / Literal Expression） |
| bpmn-js-properties-panel / @bpmn-io/properties-panel | 5.65 / 3.52 | 属性面板 + provider |
| camunda-bpmn-moddle / zeebe-bpmn-moddle | 8.0 / 1.18 | 执行属性 XML 扩展 |
| diagram-js-minimap | 5.4 | 小地图 |
| bpmn-js-color-picker | 0.7 | BPMN in Color |
| bpmn-js-bpmnlint / bpmnlint / bpmnlint-plugin-camunda | 0.24 / 11 / 0.6 | 模型校验 |
| bpmn-js-token-simulation | 0.40 | 令牌模拟 |
| vite | 8 | 构建（dev / build / preview） |
| electron / electron-builder | 29.4.6 / 26 | 桌面壳与打包 |

---

## 7. 后续扩展 (Roadmap)

- [x] 集成 **dmn-js** 作为决策建模模块（v0.1.4）
- [ ] **元素模板**（`bpmn-js-element-templates`）+ Camunda 模板 JSON schema
- [ ] i18n（`bpmn-js-i18n`，界面中文化）
- [ ] 主题切换（浅色/深色，参考 `bpmn-js-examples/theming`）
- [ ] 本地历史记录 / 自动恢复（localStorage 草稿）
- [ ] macOS 签名与公证、Windows 代码签名
- [ ] 多选属性的批量编辑、注释区（modeling feedback）增强

---

## 8. License

MIT — 与 bpmn.io 生态一致。`bpmn-js`、`bpmn-moddle`、`dmn-js`、`bpmn-js-examples` 均为 MIT。