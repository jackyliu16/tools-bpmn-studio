#!/usr/bin/env bash
#
# build-tag.sh — 根据 git tag 编译指定版本
#
# 用法:
#   ./build-tag.sh v0.1.5                          # 仅 Web 产物 (dist/)
#   ./build-tag.sh v0.1.5 --electron                # Web + 当前平台 Electron 安装包
#   ./build-tag.sh v0.1.5 --electron --platform linux   # 指定平台
#   ./build-tag.sh v0.1.5 --electron --targets AppImage,deb  # 指定目标格式
#   ./build-tag.sh v0.1.5 --clean                   # 编译后删除 dist/ 中间产物
#   ./build-tag.sh v0.1.5 --output /tmp             # 自定义输出根目录
#
# 平台支持:
#   linux  → AppImage, deb, tar.gz
#   win    → nsis (exe), zip
#   mac    → dmg, zip
#
# 前提条件:
#   - 项目根目录下已安装 node_modules
#   - git 仓库中存在对应的 tag
#   - 打包 Electron 需要 node_modules/electron 和 node_modules/electron-builder
#
# 共享核心见 scripts/build-lib.sh（与 build-head.sh 共用）。
#
set -euo pipefail

# ── 共享核心: 输出辅助 / 环境检测 / 平台目标 / NixOS 工具链 / 构建步骤 ──
source "$(cd "$(dirname "$0")" && pwd)/scripts/build-lib.sh"

# ── 参数解析 ────────────────────────────────────────────────────────
TAG=""
CLEAN=false
OUTPUT_DIR=""
ELECTRON=false
PLATFORM=""      # linux | win | mac | (空 = 当前平台)
TARGETS=""       # 逗号分隔的目标格式，空 = 平台默认

show_help() {
  cat <<'EOF'
用法: ./build-tag.sh <tag> [选项]

选项:
  --electron              同时打包 Electron 安装包 (AppImage/deb/exe/dmg 等)
  --platform <os>         目标平台: linux, win, mac (默认: 当前平台)
  --targets <list>        指定打包格式，逗号分隔 (覆盖平台默认值)
                          linux: AppImage,deb,tar.gz
                          win:   nsis,zip
                          mac:   dmg,zip
  --clean                 编译后删除 dist/ 中间产物
  --output <dir>          输出根目录 (默认: 项目根/release/)
  -h, --help              显示此帮助

示例:
  ./build-tag.sh v0.1.5
  ./build-tag.sh v0.1.5 --electron
  ./build-tag.sh v0.1.5 --electron --platform linux --targets AppImage
  ./build-tag.sh v0.1.5 --electron --platform win
  ./build-tag.sh v0.1.5 --clean
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)      CLEAN=true; shift ;;
    --output)     OUTPUT_DIR="$2"; shift 2 ;;
    --electron)   ELECTRON=true; shift ;;
    --platform)   PLATFORM="$2"; shift 2 ;;
    --targets)    TARGETS="$2"; shift 2 ;;
    -h|--help)    show_help ;;
    -*)           die "未知选项: $1 (用 -h 查看帮助)" ;;
    *)            TAG="$1"; shift ;;
  esac
done

[[ -z "$TAG" ]] && die "请提供 git tag，例如: $0 v0.1.5"

# ── 前置检查 ────────────────────────────────────────────────────────
ensure_git_and_node

# 检查 tag 是否存在
git rev-parse "$TAG" >/dev/null 2>&1 || die "Tag '$TAG' 在仓库中不存在"

ensure_node_modules

# ── electron 相关检查 ───────────────────────────────────────────────
if [[ "$ELECTRON" == "true" ]]; then
  check_electron_env
fi

# ── 平台 / 目标 默认值 ─────────────────────────────────────────────
resolve_platform_targets

# ── 保存当前状态 ────────────────────────────────────────────────────
ORIG_BRANCH="$(git branch --show-current 2>/dev/null || echo "")"
ORIG_HEAD="$(git rev-parse HEAD)"
STASHED=false

info "当前分支: ${ORIG_BRANCH:-detached} (${ORIG_HEAD:0:8})"
info "目标:     $TAG → platform=$PLATFORM targets=$TARGETS"

# 如果工作区有改动，先 stash
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  warn "工作区有未提交的改动，正在 stash..."
  git stash push -m "build-tag.sh: auto stash before building $TAG" --quiet
  STASHED=true
fi

# ── 定义清理函数（无论成功失败都恢复） ─────────────────────────────
cleanup() {
  local exit_code=$?
  info "恢复工作区..."
  git checkout --quiet "$ORIG_HEAD" 2>/dev/null || true
  if [[ -n "$ORIG_BRANCH" ]]; then
    git checkout --quiet "$ORIG_BRANCH" 2>/dev/null || true
  fi
  if [[ "$STASHED" == "true" ]]; then
    git stash pop --quiet 2>/dev/null || warn "stash pop 失败，请手动 git stash pop"
  fi
  if [[ $exit_code -ne 0 ]]; then
    err "构建失败 (exit code: $exit_code)"
  fi
}
trap cleanup EXIT

# ── Checkout 到 tag ─────────────────────────────────────────────────
TAG_COMMIT="$(git rev-parse "$TAG")"
step "Checkout $TAG (${TAG_COMMIT:0:8})"
git checkout --quiet "$TAG"

# ── 输出目录 ────────────────────────────────────────────────────────
if [[ -n "$OUTPUT_DIR" ]]; then
  RELEASE_DIR="$OUTPUT_DIR/$TAG"
else
  RELEASE_DIR="$REPO_ROOT/release/$TAG"
fi
mkdir -p "$RELEASE_DIR"

# ── Step 1-3: lint:pack → vite build → 收集 Web 产物 ────────────────
build_web_assets

# ── Step 3b: Electron 打包 (可选) ───────────────────────────────────
if [[ "$ELECTRON" == "true" ]]; then
  step "Electron 打包: $PLATFORM ($TARGETS)"

  # electron-builder 输出到临时目录，之后再移动到 release/<tag>/
  EB_OUTPUT="$REPO_ROOT/.electron-build-tmp"
  rm -rf "$EB_OUTPUT"
  mkdir -p "$EB_OUTPUT"

  # 构造 electron-builder 参数: --<platform> <targets...> 输出目录
  # 格式: electron-builder --linux AppImage deb tar.gz -c.directories.output=...
  build_electron_base_args

  # 禁止自动发布到 GitHub（本地构建不需要）
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
ok "构建完成！$TAG"

print_manifest
echo ""