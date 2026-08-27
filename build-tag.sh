#!/usr/bin/env bash
#
# build-tag.sh — 根据 git tag 编译指定版本，输出到 release/<tag>/
#
# 用法:
#   ./build-tag.sh v0.1.5
#   ./build-tag.sh v0.1.5 --clean        # 编译后删除中间产物
#   ./build-tag.sh v0.1.5 --output /tmp   # 自定义输出根目录
#
# 前提条件:
#   - 项目根目录下已安装 node_modules
#   - git 仓库中存在对应的 tag
#
set -euo pipefail

# ── 颜色 ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()   { err "$@"; exit 1; }

# ── 参数解析 ────────────────────────────────────────────────────────
TAG=""
CLEAN=false
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)    CLEAN=true; shift ;;
    --output)   OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "用法: $0 <tag> [--clean] [--output <dir>]"
      echo ""
      echo "参数:"
      echo "  <tag>           git tag 名称，如 v0.1.5"
      echo "  --clean         编译后删除 release/<tag>/dist 中间产物"
      echo "  --output <dir>  输出根目录（默认: 项目根下的 release/）"
      exit 0
      ;;
    -*)         die "未知选项: $1" ;;
    *)          TAG="$1"; shift ;;
  esac
done

[[ -z "$TAG" ]] && die "请提供 git tag，例如: $0 v0.1.5"

# ── 前置检查 ────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# 检查 git
command -v git >/dev/null 2>&1 || die "需要 git"

# 检查 node
NODE_BIN=""
for candidate in \
  /nix/store/bfqsxlviikq7vlp36kasy5hhamlxlkd2-nodejs-slim-24.19.0/bin/node \
  /nix/store/20ln2kffndjf1pmsvr1md2j2yf74c4w4-nodejs-slim-22.23.2/bin/node \
  "$(command -v node 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done
[[ -z "$NODE_BIN" ]] && die "找不到 node 可执行文件"
NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"
info "Node: $($NODE_BIN --version)"

# 检查 tag 是否存在
git rev-parse "$TAG" >/dev/null 2>&1 || die "Tag '$TAG' 在仓库中不存在"

# 确认 node_modules 存在
[[ -d "$REPO_ROOT/node_modules" ]] || die "请先在项目根目录执行 npm install / pnpm install"

# ── 保存当前状态 ────────────────────────────────────────────────────
ORIG_BRANCH="$(git branch --show-current 2>/dev/null || echo "")"
ORIG_HEAD="$(git rev-parse HEAD)"
STASHED=false

info "当前分支: ${ORIG_BRANCH:-detached} (${ORIG_HEAD:0:8})"

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
info "Checkout $TAG (${TAG_COMMIT:0:8})..."
git checkout --quiet "$TAG"

# ── 输出目录 ────────────────────────────────────────────────────────
if [[ -n "$OUTPUT_DIR" ]]; then
  RELEASE_DIR="$OUTPUT_DIR/$TAG"
else
  RELEASE_DIR="$REPO_ROOT/release/$TAG"
fi
mkdir -p "$RELEASE_DIR"

# ── lint:pack ───────────────────────────────────────────────────────
info "运行 bpmnlint-pack-config..."
node node_modules/.bin/bpmnlint-pack-config \
  -c .bpmnlintrc \
  -o src/lint-config.js \
  -t es 2>&1 | while IFS= read -r line; do echo "  $line"; done
ok "lint:pack 完成"

# ── vite build ──────────────────────────────────────────────────────
info "运行 vite build..."
node node_modules/.bin/vite build 2>&1 | while IFS= read -r line; do echo "  $line"; done

# 验证 dist 存在
[[ -d dist ]] || die "构建失败：dist/ 目录不存在"
[[ -f dist/index.html ]] || die "构建失败：dist/index.html 不存在"

# ── 拷贝产物到 release/<tag>/ ──────────────────────────────────────
info "拷贝 dist/ → $RELEASE_DIR/"
cp -r dist/* "$RELEASE_DIR/"

# 同时拷贝 package.json（供版本信息参考）
cp package.json "$RELEASE_DIR/"

# ── 清理选项 ────────────────────────────────────────────────────────
if [[ "$CLEAN" == "true" ]]; then
  info "清理 dist/..."
  rm -rf dist
fi

# ── 产物清单 ────────────────────────────────────────────────────────
echo ""
ok "构建完成！"
echo ""
echo -e "${BOLD}产物目录:${NC} $RELEASE_DIR/"
echo -e "${BOLD}文件列表:${NC}"
ls -lh "$RELEASE_DIR/" | tail -n +2 | while IFS= read -r line; do
  echo "  $line"
done

# 计算总大小
TOTAL_SIZE=$(du -sh "$RELEASE_DIR" | cut -f1)
echo -e "${BOLD}总大小:${NC}   $TOTAL_SIZE"
echo ""
