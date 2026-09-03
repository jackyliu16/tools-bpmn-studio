#!/usr/bin/env bash
#
# scripts/build-lib.sh — build-head.sh / build-tag.sh 共享核心
#
# 被两个构建脚本 source（目标: 消除约一半重复代码）。
# 抽取原则: 只函数化逐字等价的段落，行为与重构前保持一致；
# 各脚本独有逻辑（参数解析、版本标签、checkout/stash、清理策略、产物命名）留在各自脚本。
#
# 约定（被本库函数依赖的全局变量，由调用脚本负责赋值）:
#   REPO_ROOT RELEASE_DIR PLATFORM TARGETS CURRENT_PLATFORM IS_NIXOS ELECTRON
#   NATIVE_7ZA NATIVE_MKSQUASHFS EB_CACHE EB_OUTPUT EB_ARGS CLEAN
#

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

# ── 前置检查: 仓库根、git、node ──────────────────────────────────────
# 设置 REPO_ROOT 并 cd，检测 node（NixOS 优先固定 store 路径），导出 PATH。
# 不检查 node_modules —— 调用脚本可把 tag 存在性等检查插在中间。
ensure_git_and_node() {
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
}

ensure_node_modules() {
  [[ -d "$REPO_ROOT/node_modules" ]] || die "请先在项目根目录执行 npm install"
}

# ── electron 前置检查 + NixOS 原生二进制探测 ─────────────────────────
# 检查 electron/electron-builder 存在，探测并替换缓存中动态链接的
# 7zz/mksquashfs/fpm（NixOS 上无法运行）。设置 NATIVE_7ZA/NATIVE_MKSQUASHFS/EB_CACHE。
check_electron_env() {
  [[ -f "$REPO_ROOT/node_modules/.bin/electron-builder" ]] || die "需要 electron-builder: npm i -D electron-builder"
  [[ -f "$REPO_ROOT/node_modules/.bin/electron" ]] || die "需要 electron: npm i -D electron"
  EB_VERSION="$(node node_modules/.bin/electron-builder --version 2>/dev/null || echo '?')"
  info "electron-builder: $EB_VERSION"

  # NixOS 补丁：electron-builder 下载的二进制是动态链接的，在 NixOS 上无法运行
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

  # fpm: 清理不完整的 fpm 缓存（deb 打包依赖 fpm，通过 7za 解压）
  _fpm_bin="$(find "$EB_CACHE" -maxdepth 3 -name "fpm" -not -name "*.state" -type f 2>/dev/null | head -1 || true)"
  if [[ -z "$_fpm_bin" ]]; then
    find "$EB_CACHE" -maxdepth 2 -name "*.state" -path "*/fpm@*" -delete 2>/dev/null || true
  fi

  if [[ -z "$NATIVE_7ZA" && -z "$NATIVE_MKSQUASHFS" ]]; then
    warn "未找到原生 p7zip/squashfs，AppImage/tar.gz 打包可能失败"
  fi
  return 0
}

# ── 平台检测与目标默认值 ─────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "mac" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win" ;;
    *)       echo "linux" ;;
  esac
}

# 计算 CURRENT_PLATFORM/IS_NIXOS，并按平台补默认 TARGETS（NixOS 跳过 deb）
resolve_platform_targets() {
  CURRENT_PLATFORM="$(detect_platform)"

  IS_NIXOS=false
  [[ -f /etc/NIXOS ]] || [[ -d /nix/store ]] && IS_NIXOS=true

  if [[ -z "$PLATFORM" ]]; then
    PLATFORM="$CURRENT_PLATFORM"
  fi

  if [[ -z "$TARGETS" ]]; then
    case "$PLATFORM" in
      linux)
        if [[ "$IS_NIXOS" == "true" ]]; then
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
}

# ── NixOS 工具链预下载/预解压（写 state 防 electron-builder 重新下载） ──
# 依赖已设置的 EB_CACHE/NATIVE_7ZA/NATIVE_MKSQUASHFS。
prepare_nixos_toolchain() {
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

    # 用原生 7za 替换（无论是否刚下载）
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
}

# ── 构建步骤 ─────────────────────────────────────────────────────────
# Step 1-3: lint:pack → vite build → 拷贝 Web 产物到 $RELEASE_DIR/web/
build_web_assets() {
  step "Step 1/3: bpmnlint-pack-config"
  node node_modules/.bin/bpmnlint-pack-config \
    -c .bpmnlintrc \
    -o src/lint-config.js \
    -t es 2>&1 | while IFS= read -r line; do echo "  $line"; done
  ok "lint:pack 完成"

  # ── Step 2: vite build ──
  step "Step 2/3: vite build"
  node node_modules/.bin/vite build 2>&1 | while IFS= read -r line; do echo "  $line"; done

  # 验证 dist 存在
  [[ -d dist ]] || die "构建失败：dist/ 目录不存在"
  [[ -f dist/index.html ]] || die "构建失败：dist/index.html 不存在"

  # ── Step 3: 拷贝 Web 产物 ──
  step "Step 3/3: 收集产物"
  info "拷贝 dist/ → $RELEASE_DIR/web/"
  mkdir -p "$RELEASE_DIR/web"
  cp -r dist/* "$RELEASE_DIR/web/"
  cp package.json "$RELEASE_DIR/web/"
}

# 构造 electron-builder 基础参数: --<platform> <targets...> -c.directories.output=…
# 注意: 不含 --publish never 与 artifactName —— head 脚本在其后追加去版本号命名，
# 顺序与重构前一致（基础参数 → artifactName → --publish never）。
build_electron_base_args() {
  EB_ARGS=(
    "--$PLATFORM"
  )

  IFS=',' read -ra TARGET_ARRAY <<< "$TARGETS"
  for t in "${TARGET_ARRAY[@]}"; do
    t="$(echo "$t" | xargs)"  # trim 空格
    EB_ARGS+=("$t")
  done

  EB_ARGS+=("-c.directories.output=$EB_OUTPUT")
}

# 交叉编译提示（当前系统 ≠ 目标平台时给出 wine 等提示）
cross_compile_hint() {
  if [[ "$PLATFORM" != "$CURRENT_PLATFORM" ]]; then
    warn "交叉编译: 当前系统=$CURRENT_PLATFORM 目标=$PLATFORM"
    if [[ "$PLATFORM" == "win" && "$CURRENT_PLATFORM" == "linux" ]]; then
      info "需要 wine 来构建 Windows 安装包"
      command -v wine >/dev/null 2>&1 || warn "wine 未安装，Windows 打包可能失败"
    fi
  fi
}

# 运行 electron-builder（EB_ARGS 已由调用脚本拼好）
run_electron_builder() {
  info "运行 electron-builder ${EB_ARGS[*]}..."
  node node_modules/.bin/electron-builder "${EB_ARGS[@]}" 2>&1 | while IFS= read -r line; do echo "  $line"; done
}

# 移动 Electron 产物到 $RELEASE_DIR/electron/（含 *-unpacked 目录），并清理临时目录
collect_electron_artifacts() {
  mkdir -p "$RELEASE_DIR/electron"
  if [[ -d "$EB_OUTPUT" ]]; then
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

    for unpacked in "$EB_OUTPUT"/*-unpacked; do
      if [[ -d "$unpacked" ]]; then
        dir_name="$(basename "$unpacked")"
        cp -r "$unpacked" "$RELEASE_DIR/electron/$dir_name"
      fi
    done
  fi

  # 清理临时目录
  rm -rf "$EB_OUTPUT"
}

# ── 收尾 ─────────────────────────────────────────────────────────────
maybe_clean_dist() {
  if [[ "$CLEAN" == "true" ]]; then
    info "清理 dist/..."
    rm -rf dist
  fi
}

# 产物清单: web + electron + 总大小
print_manifest() {
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
}