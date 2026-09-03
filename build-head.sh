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

# 确认 node_modules 存在
[[ -d "$REPO_ROOT/node_modules" ]] || die "请先在项目根目录执行 npm install"

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

  # fpm: 清理不完整的 fpm 缓存
  _fpm_bin="$(find "$EB_CACHE" -maxdepth 3 -name "fpm" -not -name "*.state" -type f 2>/dev/null | head -1 || true)"
  if [[ -z "$_fpm_bin" ]]; then
    find "$EB_CACHE" -maxdepth 2 -name "*.state" -path "*/fpm@*" -delete 2>/dev/null || true
  fi

  [[ -z "$NATIVE_7ZA" && -z "$NATIVE_MKSQUASHFS" ]] && \
    warn "未找到原生 p7zip/squashfs，AppImage/tar.gz 打包可能失败"
fi

# ── 平台 / 目标 默认值 ─────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "mac" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win" ;;
    *)       echo "linux" ;;
  esac
}

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

  EB_OUTPUT="$REPO_ROOT/.electron-build-tmp"
  rm -rf "$EB_OUTPUT"
  mkdir -p "$EB_OUTPUT"

  EB_ARGS=(
    "--$PLATFORM"
  )

  IFS=',' read -ra TARGET_ARRAY <<< "$TARGETS"
  for t in "${TARGET_ARRAY[@]}"; do
    t="$(echo "$t" | xargs)"
    EB_ARGS+=("$t")
  done

  EB_ARGS+=("-c.directories.output=$EB_OUTPUT")

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
    EB_CACHE="$REPO_ROOT/.electron-builder-cache"
    export ELECTRON_BUILDER_CACHE="$EB_CACHE"
    info "NixOS: ELECTRON_BUILDER_CACHE=$EB_CACHE"

    EB_DL="$EB_CACHE/downloads"
    EB_BINARIES_BASE="https://github.com/electron-userland/electron-builder-binaries/releases/download"

    # ── 预处理7zip ──
    if [[ -n "$NATIVE_7ZA" ]]; then
      _7z_dir="$EB_CACHE/7zip@1.0.0/7zip-linux-x64-16wjr"
      _7z_state="$EB_CACHE/7zip@1.0.0/7zip-linux-x64-16wjr.state"

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

    if [[ -n "$NATIVE_MKSQUASHFS" ]]; then
      while IFS= read -r _target; do
        cp -f "$NATIVE_MKSQUASHFS" "$_target" && info "已替换 mksquashfs" || true
      done < <(find "$EB_CACHE" -name "mksquashfs" -type f 2>/dev/null)
    fi

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

  # 移动 Electron 产物
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
ok "构建完成！$VERSION_LABEL"
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
echo -e "${BOLD}构建信息:${NC} $RELEASE_DIR/build-info.json"
echo ""
