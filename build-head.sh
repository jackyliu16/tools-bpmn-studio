#!/usr/bin/env bash
#
# build-head.sh — 就地构建当前工作区（含未提交改动）
#
# 直接编译当前目录中的文件，不做任何 git checkout。
# 工作流: 改代码 → 测试 → 跑 build-head.sh → 得到产物
#
# 用法:
#   ./build-head.sh                              # 仅 Web 产物 (dist/)
#   ./build-head.sh --electron                   # Web + 当前平台 Electron 安装包
#   ./build-head.sh --electron --platform linux  # 指定平台
#   ./build-head.sh --electron --targets AppImage,deb  # 指定目标格式
#   ./build-head.sh --clean                      # 编译后删除 dist/ 中间产物
#   ./build-head.sh --fresh                      # 构建前仅清理旧 HEAD 构建（保留 tag 构建）
#   ./build-head.sh --fresh-all                  # 构建前清空输出根目录中的所有旧产物（含 tag 构建）
#   ./build-head.sh --output /tmp                # 自定义输出根目录
#
# 注意: 本脚本打包的是当前 HEAD（含未提交改动），Electron 产物文件名不含版本号。
#
# 平台支持:
#   linux  → AppImage, deb, tar.gz
#   win    → nsis (exe), zip
#   mac    → dmg, zip
#
# 前提条件:
#   - 项目根目录下已安装 node_modules
#   - 打包 Electron 需要 node_modules/electron 和 node_modules/electron-builder
#
# 共享核心见 scripts/build-lib.sh（与 build-tag.sh 共用）。
#
set -euo pipefail

# ── 共享核心: 输出辅助 / 环境检测 / 平台目标 / NixOS 工具链 / 构建步骤 ──
source "$(cd "$(dirname "$0")" && pwd)/scripts/build-lib.sh"

# ── 参数解析 ────────────────────────────────────────────────────────
CLEAN=false
FRESH_MODE=""    # head | all | (空 = 不清旧产物)
OUTPUT_DIR=""
ELECTRON=false
PLATFORM=""      # linux | win | mac | (空 = 当前平台)
TARGETS=""       # 逗号分隔的目标格式，空 = 平台默认

show_help() {
  cat <<'EOF'
用法: ./build-head.sh [选项]

就地构建当前工作区中的文件，包含未提交的改动。
不做任何 git checkout，改完代码直接跑即可。

选项:
  --electron              同时打包 Electron 安装包 (AppImage/deb/exe/dmg 等)
  --platform <os>         目标平台: linux, win, mac (默认: 当前平台)
  --targets <list>        指定打包格式，逗号分隔 (覆盖平台默认值)
                          linux: AppImage,deb,tar.gz
                          win:   nsis,zip
                          mac:   dmg,zip
  --clean                 编译后删除 dist/ 中间产物
  --fresh                 构建前仅删除本脚本之前生成的旧版本目录
                          (时间戳标签，如 master-dirty-*)，保留 tag 构建
                          (v0.x 等) 与其他目录
  --fresh-all             构建前清空输出根目录中的全部旧产物
                          (含 tag 构建与遗留的 *-unpacked 目录)
  --output <dir>          输出根目录 (默认: 项目根/release/)
  -h, --help              显示此帮助

示例:
  ./build-head.sh
  ./build-head.sh --electron
  ./build-head.sh --electron --platform linux --targets AppImage
  ./build-head.sh --clean
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)      CLEAN=true; shift ;;
    --fresh)      FRESH_MODE="head"; shift ;;
    --fresh-all)  FRESH_MODE="all"; shift ;;
    --output)     OUTPUT_DIR="$2"; shift 2 ;;
    --electron)   ELECTRON=true; shift ;;
    --platform)   PLATFORM="$2"; shift 2 ;;
    --targets)    TARGETS="$2"; shift 2 ;;
    -h|--help)    show_help ;;
    -*)           die "未知选项: $1 (用 -h 查看帮助)" ;;
    *)            die "未知参数: $1 (用 -h 查看帮助)" ;;
  esac
done

# ── 前置检查 ────────────────────────────────────────────────────────
ensure_git_and_node
ensure_node_modules

# ── 获取工作区信息 ──────────────────────────────────────────────────
HEAD_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
HEAD_BRANCH="$(git branch --show-current 2>/dev/null || echo "detached")"

# 检查是否有未提交的改动
HAS_CHANGES=false
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  HAS_CHANGES=true
fi

# 生成版本标签: 分支名 + 时间戳，有未提交改动时标记 dirty
BUILD_TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
if [[ "$HEAD_BRANCH" == "detached" ]]; then
  VERSION_LABEL="build-${HEAD_SHORT}-${BUILD_TIMESTAMP}"
elif [[ "$HAS_CHANGES" == "true" ]]; then
  VERSION_LABEL="${HEAD_BRANCH}-dirty-${BUILD_TIMESTAMP}"
else
  VERSION_LABEL="${HEAD_BRANCH}-${BUILD_TIMESTAMP}"
fi

info "分支:   $HEAD_BRANCH"
info "提交:   $HEAD_SHORT"
if [[ "$HAS_CHANGES" == "true" ]]; then
  warn "工作区有未提交的改动，已包含在构建中"
fi
info "版本:   $VERSION_LABEL"

# ── electron 相关检查 ───────────────────────────────────────────────
if [[ "$ELECTRON" == "true" ]]; then
  check_electron_env
fi

# ── 平台 / 目标 默认值 ─────────────────────────────────────────────
resolve_platform_targets

# ── 输出目录 ────────────────────────────────────────────────────────
if [[ -n "$OUTPUT_DIR" ]]; then
  RELEASE_ROOT="$OUTPUT_DIR"
else
  RELEASE_ROOT="$REPO_ROOT/release"
fi
RELEASE_DIR="$RELEASE_ROOT/$VERSION_LABEL"

# --fresh / --fresh-all: 构建前清理输出根目录中的旧产物
#   head = 仅删除本脚本生成的版本目录（时间戳标签），tag 构建保留
#   all  = 清空输出根目录中的所有内容（含 tag 构建）
head_build_name() {
  # build-head.sh 的版本标签均以 -YYYYMMDD-HHMMSS 结尾:
  #   <branch>-dirty-<ts> / <branch>-<ts> / build-<short>-<ts>
  [[ "$1" =~ -[0-9]{8}-[0-9]{6}$ ]]
}

if [[ -n "$FRESH_MODE" ]]; then
  if [[ -z "$RELEASE_ROOT" || "$RELEASE_ROOT" == "/" || "${RELEASE_ROOT%/}" == "$REPO_ROOT" ]]; then
    die "拒绝清空危险路径: $RELEASE_ROOT"
  fi
  if [[ -e "$RELEASE_ROOT" ]]; then
    if [[ "$FRESH_MODE" == "all" ]]; then
      OLD_SIZE="$(du -sh "$RELEASE_ROOT" 2>/dev/null | awk '{print $1}')"
      warn "清空输出根目录中的全部旧产物 (${OLD_SIZE:-?}): $RELEASE_ROOT"
      rm -rf "$RELEASE_ROOT"
      ok "旧产物已全部删除"
    else
      # 只删 head 构建目录；目录名恰好与某 tag 相同的一律保留（ex: tag 名 0.1.5）
      TAGS="$(git tag 2>/dev/null || true)"
      REMOVED=0
      for entry in "$RELEASE_ROOT"/*; do
        [[ -e "$entry" ]] || continue
        name="$(basename "$entry")"
        if [[ -d "$entry" && "$name" =~ -[0-9]{8}-[0-9]{6}$ ]] \
           && ! grep -qxF "$name" <<<"$TAGS"; then
          info "删除旧 HEAD 构建: $name"
          rm -rf "$entry"
          REMOVED=$((REMOVED + 1))
        fi
      done
      if [[ $REMOVED -eq 0 ]]; then
        info "没有可删除的旧 HEAD 构建（tag 构建与其余目录已保留）"
      fi
      ok "旧 HEAD 构建清理完成"
    fi
  else
    info "输出根目录不存在，无需清理"
  fi
fi

mkdir -p "$RELEASE_DIR"

# 记录构建元信息
cat > "$RELEASE_DIR/build-info.json" <<META
{
  "version": "$VERSION_LABEL",
  "branch": "$HEAD_BRANCH",
  "commit": "$(git rev-parse HEAD 2>/dev/null || echo 'unknown')",
  "hasUncommittedChanges": $HAS_CHANGES,
  "platform": "$PLATFORM",
  "targets": "$TARGETS",
  "electron": $ELECTRON,
  "buildTime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nodeVersion": "$($NODE_BIN --version)"
}
META
info "构建元信息已写入 $RELEASE_DIR/build-info.json"

# ── Step 1-3: lint:pack → vite build → 收集 Web 产物 ────────────────
build_web_assets

# ── Step 3b: Electron 打包 (可选) ───────────────────────────────────
if [[ "$ELECTRON" == "true" ]]; then
  step "Electron 打包: $PLATFORM ($TARGETS)"

  EB_OUTPUT="$REPO_ROOT/.electron-build-tmp"
  rm -rf "$EB_OUTPUT"
  mkdir -p "$EB_OUTPUT"

  # 构造 electron-builder 参数: --<platform> <targets...> 输出目录
  build_electron_base_args

  # 溯源构建产物命名：打包的是 HEAD，文件名不掺入 package.json 版本号。
  # 保留各格式既有规范，仅去掉 ${version} 段：
  #   AppImage → "BPMN Studio.AppImage"   tar.gz → "bpmn-studio.tar.gz"
  #   deb      → "bpmn-studio_amd64.deb"  exe    → "BPMN Studio Setup.exe"
  #   win zip  → "bpmn-studio-win.zip"    mac    → "bpmn-studio-mac.dmg/.zip"
  EB_ARGS+=(
    "-c.appImage.artifactName=\${productName}.\${ext}"
    "-c.deb.artifactName=\${name}_\${arch}.\${ext}"
    "-c.linux.artifactName=\${name}.\${ext}"
    "-c.nsis.artifactName=\${productName} Setup.\${ext}"
    "-c.win.artifactName=\${name}-\${os}.\${ext}"
    "-c.mac.artifactName=\${name}-\${os}.\${ext}"
  )

  EB_ARGS+=(--publish never)

  # NixOS: 强制使用项目级缓存，预下载并预解压工具链
  if [[ "$IS_NIXOS" == "true" ]]; then
    prepare_nixos_toolchain
  fi

  # 交叉编译提示
  cross_compile_hint

  run_electron_builder
  collect_electron_artifacts
  ok "Electron 打包完成"
fi

# ── 清理选项 ────────────────────────────────────────────────────────
maybe_clean_dist

# ── 产物清单 ────────────────────────────────────────────────────────
echo ""
ok "构建完成！$VERSION_LABEL"

print_manifest

echo ""
echo -e "${BOLD}构建信息:${NC} $RELEASE_DIR/build-info.json"
echo ""