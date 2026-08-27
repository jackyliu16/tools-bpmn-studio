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
set -euo pipefail

# ── 颜色 ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()   { err "$@"; exit 1; }
step()  { echo -e "\n${MAGENTA}━━━ $* ━━━${NC}"; }

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
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# 检查 git
command -v git >/dev/null 2>&1 || die "需要 git"

# 检查 node（优先使用包含 npm 的完整安装）
NODE_BIN=""
NODE_NPM_DIR=""
for candidate_dir in \
  /nix/store/glcp73hgagq2b24i80jlgbvj28vdb6kk-nodejs-24.19.0 \
  /nix/store/zvj0hl7rhh0ccr5vkcg3ijs3xm3sgyac-nodejs-24.16.0 \
  /nix/store/hwjfj8m2kcsl7kz2xa5yf84jbfh9jssf-nodejs-24.18.1 \
  /nix/store/x98gls54ki3fmm2pv2cmi6z8mcda6glk-nodejs-24.18.0; do
  if [[ -x "$candidate_dir/bin/node" ]]; then
    NODE_BIN="$candidate_dir/bin/node"
    NODE_NPM_DIR="$candidate_dir/bin"
    break
  fi
done
# fallback: 系统 PATH 中的 node
if [[ -z "$NODE_BIN" ]]; then
  candidate="$(command -v node 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    NODE_NPM_DIR="$(dirname "$candidate")"
  fi
fi
[[ -z "$NODE_BIN" ]] && die "找不到 node 可执行文件"

# 将 node + npm 目录加入 PATH
export PATH="$NODE_NPM_DIR:$PATH"
info "Node: $($NODE_BIN --version)"
info "npm: $(npm --version 2>/dev/null || echo 'not found')"

# 检查 tag 是否存在
git rev-parse "$TAG" >/dev/null 2>&1 || die "Tag '$TAG' 在仓库中不存在"

# 确认 node_modules 存在
[[ -d "$REPO_ROOT/node_modules" ]] || die "请先在项目根目录执行 npm install"

# electron 相关检查
if [[ "$ELECTRON" == "true" ]]; then
  [[ -f "$REPO_ROOT/node_modules/.bin/electron-builder" ]] || die "需要 electron-builder: npm i -D electron-builder"
  [[ -f "$REPO_ROOT/node_modules/.bin/electron" ]] || die "需要 electron: npm i -D electron"
  EB_VERSION="$(node node_modules/.bin/electron-builder --version 2>/dev/null || echo '?')"
  info "electron-builder: $EB_VERSION"

  # NixOS 补丁：electron-builder 下载的二进制是动态链接的，在 NixOS 上无法运行
  # 用系统原生工具替换已知缓存路径中的二进制
  NATIVE_7ZA=""
  for candidate in \
    /nix/store/07xxxc5wa0bp4yridjgajrm3a444vm5m-p7zip-17.06/bin/7za \
    "$(command -v 7za 2>/dev/null || true)" \
    "$(command -v 7z 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      NATIVE_7ZA="$candidate"; break
    fi
  done

  NATIVE_MKSQUASHFS=""
  for candidate in \
    /nix/store/yla8sbkdzd4i648synaywsb8q3r34vy4-squashfs-4.7.5/bin/mksquashfs \
    /nix/store/bcbhfrwrmb8rsmnsrgiivjr7qnyzdjn7-squashfs-4.7.4/bin/mksquashfs \
    "$(command -v mksquashfs 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      NATIVE_MKSQUASHFS="$candidate"; break
    fi
  done

  EB_CACHE="$REPO_ROOT/.electron-builder-cache"

  # 7za: 替换 .electron-builder-cache/7zip@1.0.0/7zip-linux-x64-*/bin/7zz
  if [[ -n "$NATIVE_7ZA" ]]; then
    _target="$(find "$EB_CACHE/7zip@1.0.0" -path "*/bin/7zz" -type f 2>/dev/null | head -1 || true)"
    if [[ -n "$_target" ]]; then
      cp -f "$NATIVE_7ZA" "$_target" 2>/dev/null && \
        info "已用原生 7za 替换 7zz: $(dirname "$_target" | xargs basename)" || true
    fi
  fi

  # mksquashfs: 替换 .electron-builder-cache/appimage-*/appimage-*/linux-x64/mksquashfs
  if [[ -n "$NATIVE_MKSQUASHFS" ]]; then
    _target="$(find "$EB_CACHE/appimage-"* -path "*/linux-x64/mksquashfs" -type f 2>/dev/null | head -1 || true)"
    if [[ -n "$_target" ]]; then
      cp -f "$NATIVE_MKSQUASHFS" "$_target" 2>/dev/null && \
        info "已用原生 mksquashfs 替换: $(dirname "$_target" | xargs basename)" || true
    fi
  fi

  # fpm: deb 打包依赖 fpm (Ruby)，它通过 7za 解压。确保 fpm 缓存目录干净
  # 如果 fpm 解压目录存在但 fpm 二进制不存在，清理 state 让 electron-builder 重新解压
  _fpm_bin="$(find "$EB_CACHE" -maxdepth 3 -name "fpm" -not -name "*.state" -type f 2>/dev/null | head -1 || true)"
  if [[ -z "$_fpm_bin" ]]; then
    find "$EB_CACHE" -maxdepth 2 -name "*.state" -path "*/fpm@*" -delete 2>/dev/null || true
  fi

  [[ -z "$NATIVE_7ZA" && -z "$NATIVE_MKSQUASHFS" ]] && \
    warn "未找到原生 p7zip/squashfs，AppImage/tar.gz 打包可能失败"
fi

# ── 平台 / 目标 默认值 ─────────────────────────────────────────────
# 检测当前系统平台
detect_platform() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "mac" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win" ;;
    *)       echo "linux" ;;
  esac
}

CURRENT_PLATFORM="$(detect_platform)"

# 检测 NixOS（electron-builder 的 fpm/deb 依赖的动态链接二进制无法在 NixOS 上运行）
IS_NIXOS=false
[[ -f /etc/NIXOS ]] || [[ -d /nix/store ]] && IS_NIXOS=true

# 如果未指定 --platform，使用当前平台
if [[ -z "$PLATFORM" ]]; then
  PLATFORM="$CURRENT_PLATFORM"
fi

# 如果未指定 --targets，使用平台默认值
if [[ -z "$TARGETS" ]]; then
  case "$PLATFORM" in
    linux)
      if [[ "$IS_NIXOS" == "true" ]]; then
        # NixOS: deb 需要 fpm (Ruby)，其依赖的 7za 是动态链接二进制无法运行
        # AppImage 和 tar.gz 只需要 mksquashfs（已用原生二进制替换）
        TARGETS="AppImage,tar.gz"
        warn "NixOS 检测到：跳过 deb 打包（fpm 的 7za 依赖不兼容 NixOS）"
      else
        TARGETS="AppImage,deb,tar.gz"
      fi
      ;;
    win)   TARGETS="nsis,zip" ;;
    mac)   TARGETS="dmg,zip" ;;
    *)     die "不支持的平台: $PLATFORM" ;;
  esac
fi

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

# ── Step 1: lint:pack ───────────────────────────────────────────────
step "Step 1/3: bpmnlint-pack-config"
node node_modules/.bin/bpmnlint-pack-config \
  -c .bpmnlintrc \
  -o src/lint-config.js \
  -t es 2>&1 | while IFS= read -r line; do echo "  $line"; done
ok "lint:pack 完成"

# ── Step 2: vite build ──────────────────────────────────────────────
step "Step 2/3: vite build"
node node_modules/.bin/vite build 2>&1 | while IFS= read -r line; do echo "  $line"; done

# 验证 dist 存在
[[ -d dist ]] || die "构建失败：dist/ 目录不存在"
[[ -f dist/index.html ]] || die "构建失败：dist/index.html 不存在"

# ── Step 3: 拷贝 Web 产物 ──────────────────────────────────────────
step "Step 3/3: 收集产物"
info "拷贝 dist/ → $RELEASE_DIR/web/"
mkdir -p "$RELEASE_DIR/web"
cp -r dist/* "$RELEASE_DIR/web/"
cp package.json "$RELEASE_DIR/web/"

# ── Step 3b: Electron 打包 (可选) ───────────────────────────────────
if [[ "$ELECTRON" == "true" ]]; then
  step "Electron 打包: $PLATFORM ($TARGETS)"

  # electron-builder 输出到临时目录，之后再移动到 release/<tag>/
  EB_OUTPUT="$REPO_ROOT/.electron-build-tmp"
  rm -rf "$EB_OUTPUT"
  mkdir -p "$EB_OUTPUT"

  # 构造 electron-builder 参数
  # 格式: electron-builder --linux AppImage deb tar.gz -c.directories.output=...
  EB_ARGS=(
    "--$PLATFORM"
  )

  # targets 作为 --linux 后面的值，逗号改为空格
  IFS=',' read -ra TARGET_ARRAY <<< "$TARGETS"
  for t in "${TARGET_ARRAY[@]}"; do
    t="$(echo "$t" | xargs)"  # trim 空格
    EB_ARGS+=("$t")
  done

  # 输出目录 (-c 覆盖 config)
  EB_ARGS+=("-c.directories.output=$EB_OUTPUT")

  # 禁止自动发布到 GitHub（本地构建不需要）
  EB_ARGS+=(--publish never)

  # NixOS: 强制使用项目级缓存，预下载并预解压工具链
  if [[ "$IS_NIXOS" == "true" ]]; then
    EB_CACHE="$REPO_ROOT/.electron-builder-cache"
    export ELECTRON_BUILDER_CACHE="$EB_CACHE"
    info "NixOS: ELECTRON_BUILDER_CACHE=$EB_CACHE"

    EB_DL="$EB_CACHE/downloads"
    EB_BINARIES_BASE="https://github.com/electron-userland/electron-builder-binaries/releases/download"

    # ── 预处理7zip ──
    if [[ -n "$NATIVE_7ZA" ]]; then
      _7z_dir="$EB_CACHE/7zip@1.0.0/7zip-linux-x64-16wjr"
      _7z_state="$EB_CACHE/7zip@1.0.0/7zip-linux-x64-16wjr.state"

      # 下载并解压（如果缺失）
      if [[ ! -f "$_7z_dir/bin/7za" ]] || ! "$_7z_dir/bin/7za" --help >/dev/null 2>&1; then
        info "NixOS: 下载并解压7zip工具链..."
        mkdir -p "$EB_DL/7zip@1.0.0" "$_7z_dir"
        _7z_url="$EB_BINARIES_BASE/7zip@1.0.0/7zip-linux-x64.tar.gz"
        curl -fsSL "$_7z_url" -o "$EB_DL/7zip@1.0.0/7zip-linux-x64.tar.gz" 2>/dev/null || \
          wget -q "$_7z_url" -O "$EB_DL/7zip@1.0.0/7zip-linux-x64.tar.gz" 2>/dev/null || true
        if [[ -f "$EB_DL/7zip@1.0.0/7zip-linux-x64.tar.gz" ]]; then
          tar -xzf "$EB_DL/7zip@1.0.0/7zip-linux-x64.tar.gz" -C "$_7z_dir" --strip-components=0 2>/dev/null || true
        fi
      fi

      # 用原生7za替换（无论是否刚下载）
      if [[ -f "$_7z_dir/bin/7za" ]]; then
        cp -f "$NATIVE_7ZA" "$_7z_dir/bin/7za" && info "NixOS: 7za → native" || true
      else
        mkdir -p "$_7z_dir/bin"
        cat > "$_7z_dir/bin/7za" <<WRAPPER
#!/bin/sh
exec "$NATIVE_7ZA" "\$@"
WRAPPER
        chmod +x "$_7z_dir/bin/7za"
        info "NixOS: 7za wrapper → $NATIVE_7ZA"
      fi

      # 关键：写 state 文件防止 electron-builder 重新下载
      cat > "$_7z_state" <<'STATE'
{"version":1,"state":"complete","timestamp":0,"fileCount":4,"extractedSize":2903181}
STATE
    fi

    # ── 预处理 appimage 工具链 ──
    _appimg_ver="12.0.1"
    _appimg_dir="$EB_CACHE/appimage-$_appimg_ver"
    _appimg_subdir="appimage-$_appimg_ver-qkv17"
    _appimg_extracted="$_appimg_dir/$_appimg_subdir"
    _appimg_state="$_appimg_dir/$_appimg_subdir.state"

    # 下载并解压（如果缺失）
    if [[ ! -d "$_appimg_extracted/linux-x64" ]]; then
      info "NixOS: 下载并解压 appimage 工具链..."
      mkdir -p "$EB_CACHE/downloads" "$_appimg_dir"
      _appimg_url="$EB_BINARIES_BASE/appimage-$_appimg_ver/appimage-$_appimg_ver.7z"
      _dl_hash="$(echo -n "$_appimg_url" | sha256sum | cut -d' ' -f1)"
      _dl_dir="$EB_CACHE/downloads/$_dl_hash"
      mkdir -p "$_dl_dir"
      curl -fsSL "$_appimg_url" -o "$_dl_dir/appimage-$_appimg_ver.7z" 2>/dev/null || \
        wget -q "$_appimg_url" -O "$_dl_dir/appimage-$_appimg_ver.7z" 2>/dev/null || true
      if [[ -f "$_dl_dir/appimage-$_appimg_ver.7z" ]] && [[ -n "$NATIVE_7ZA" ]]; then
        mkdir -p "$_appimg_extracted"
        "$NATIVE_7ZA" x -bd -o"$_appimg_extracted" \
          "$_dl_dir/appimage-$_appimg_ver.7z" -y >/dev/null 2>&1 || true
        info "NixOS: appimage 工具链解压完成"
      fi
    fi

    # 替换 mksquashfs（在解压之后）
    if [[ -n "$NATIVE_MKSQUASHFS" ]]; then
      while IFS= read -r _target; do
        cp -f "$NATIVE_MKSQUASHFS" "$_target" && info "已替换 mksquashfs" || true
      done < <(find "$EB_CACHE" -name "mksquashfs" -type f 2>/dev/null)
    fi

    # 关键：写 state = "complete" 防止 electron-builder 重新下载+解压
    cat > "$_appimg_state" <<'STATE'
{"version":1,"state":"complete","timestamp":0,"fileCount":1,"extractedSize":1}
STATE
  fi

  # 交叉编译提示
  if [[ "$PLATFORM" != "$CURRENT_PLATFORM" ]]; then
    warn "交叉编译: 当前系统=$CURRENT_PLATFORM 目标=$PLATFORM"
    if [[ "$PLATFORM" == "win" && "$CURRENT_PLATFORM" == "linux" ]]; then
      info "需要 wine 来构建 Windows 安装包"
      command -v wine >/dev/null 2>&1 || warn "wine 未安装，Windows 打包可能失败"
    fi
  fi

  info "运行 electron-builder ${EB_ARGS[*]}..."
  node node_modules/.bin/electron-builder "${EB_ARGS[@]}" 2>&1 | while IFS= read -r line; do echo "  $line"; done

  # 移动 Electron 产物到 release/<tag>/electron/
  mkdir -p "$RELEASE_DIR/electron"
  if [[ -d "$EB_OUTPUT" ]]; then
    # electron-builder 输出可能在子目录中
    find "$EB_OUTPUT" -maxdepth 3 -type f \( \
      -name "*.AppImage" -o \
      -name "*.deb" -o \
      -name "*.tar.gz" -o \
      -name "*.exe" -o \
      -name "*.msi" -o \
      -name "*.dmg" -o \
      -name "*.zip" -o \
      -name "*.yml" -o \
      -name "*.yaml" -o \
      -name "*.blockmap" \
    \) -exec cp -v {} "$RELEASE_DIR/electron/" \; 2>/dev/null || true

    # 也拷贝 linux-unpacked / win-unpacked / mac 目录（如果存在）
    for unpacked in "$EB_OUTPUT"/*-unpacked; do
      if [[ -d "$unpacked" ]]; then
        dir_name="$(basename "$unpacked")"
        cp -r "$unpacked" "$RELEASE_DIR/electron/$dir_name"
      fi
    done
  fi

  # 清理临时目录
  rm -rf "$EB_OUTPUT"

  ok "Electron 打包完成"
fi

# ── 清理选项 ────────────────────────────────────────────────────────
if [[ "$CLEAN" == "true" ]]; then
  info "清理 dist/..."
  rm -rf dist
fi

# ── 产物清单 ────────────────────────────────────────────────────────
echo ""
ok "构建完成！$TAG"
echo ""
echo -e "${BOLD}产物目录:${NC} $RELEASE_DIR/"
echo ""

# 列出 web 产物
echo -e "${BOLD}📦 Web 产物 (web/):${NC}"
ls -lh "$RELEASE_DIR/web/" 2>/dev/null | tail -n +2 | while IFS= read -r line; do
  echo "  $line"
done

# 列出 electron 产物
if [[ "$ELECTRON" == "true" && -d "$RELEASE_DIR/electron" ]]; then
  echo ""
  echo -e "${BOLD}🖥️  Electron 产物 (electron/):${NC}"
  ls -lh "$RELEASE_DIR/electron/" 2>/dev/null | while IFS= read -r line; do
    echo "  $line"
  done
fi

# 计算总大小
TOTAL_SIZE=$(du -sh "$RELEASE_DIR" | cut -f1)
echo ""
echo -e "${BOLD}总大小:${NC} $TOTAL_SIZE"
echo ""
