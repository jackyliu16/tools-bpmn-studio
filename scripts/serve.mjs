#!/usr/bin/env node
/**
 * serve.mjs — 零依赖静态文件服务器（只需要 Node；不需要 npm install，也不需要联网）。
 *
 * 为什么要它：bpmn-studio 的 Web 产物是 **ES module** 构建
 * （`<script type="module" crossorigin>`），主流浏览器在 `file://` 下会按 CORS
 * 拒绝加载 module script（`file://` 源为 opaque origin）——所以产物必须经 HTTP 提供，
 * 双击 `index.html` 在现代浏览器里不可用。
 *
 * 这是「只有 Node、且完全离线」机器上的最小启动方式：
 *
 *   node serve.mjs                     # 服务当前目录 → http://127.0.0.1:8000/
 *   node serve.mjs ./web               # 指定目录
 *   node serve.mjs ./web 9000          # 指定端口
 *   node serve.mjs ./web 9000 0.0.0.0  # 局域网内其他机器可访问
 *   node serve.mjs --help
 *
 * 仅依赖 node: 内置模块（http/fs/path），无第三方依赖。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const DEFAULT_PORT = 8000;
const DEFAULT_HOST = '127.0.0.1';

/** 产物实际用到的类型（字体/CSS/JS 由 vite 与 bpmn-js / dmn-js 引入） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.eot': 'application/vnd.ms-fontobject',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
};

const HELP = `零依赖静态服务器 —— 把 bpmn-studio 的 Web 产物用 HTTP 跑起来

用法:
  node serve.mjs [目录] [端口] [主机]

参数:
  目录   要服务的目录（默认: 当前目录；发布包内通常是 ./web 或解压出的目录）
  端口   监听端口（默认: ${DEFAULT_PORT}）
  主机   监听地址（默认: ${DEFAULT_HOST}；填 0.0.0.0 可让局域网其他机器访问）

示例:
  node serve.mjs
  node serve.mjs ./web 9000
  node serve.mjs ./web 9000 0.0.0.0

说明:
  产物是 ES module 构建，无法用 file:// 直接双击打开（浏览器 CORS 限制），必须经 HTTP 提供。
  本脚本仅依赖 Node 内置模块，离线可用。
`;

function printHelp() {
  console.log(HELP);
}

// --- 参数解析（位置参数：目录 端口 主机；支持 -h/--help）--------------------
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  printHelp();
  process.exit(0);
}

const positional = args.filter((a) => !a.startsWith('-'));
const unknownFlags = args.filter((a) => a.startsWith('-'));
if (unknownFlags.length) {
  console.error(`未知参数: ${unknownFlags.join(' ')}（用 --help 查看用法）`);
  process.exit(2);
}

const root = resolve(positional[0] || '.');
const port = Number(positional[1] || DEFAULT_PORT);
const host = positional[2] || DEFAULT_HOST;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`端口无效: ${positional[1]}（应为 0-65535 的整数）`);
  process.exit(2);
}

/** 目录不存在时直接给出可读错误，而不是每个请求都 404 */
try {
  const st = await stat(root);
  if (!st.isDirectory()) throw new Error('不是目录');
} catch (err) {
  console.error(`目录不可用: ${root}（${err.message}）`);
  process.exit(2);
}

// --- 请求处理 ---------------------------------------------------------------
/** URL pathname → 磁盘绝对路径；越界（../）返回 null */
function toFilePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // 非法百分号编码
  }
  // '.' + '/a/b' → './a/b'；resolve 会规范化 ../，再由前缀校验兜住越界
  const filePath = resolve(root, `.${decoded}`);
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, '405 Method Not Allowed');
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, '400 Bad Request');
  }

  let filePath = toFilePath(pathname);
  if (!filePath) {
    return send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, '403 Forbidden');
  }

  try {
    let st = await stat(filePath);

    // 目录：补 index.html；未带尾斜杠则重定向（保证相对路径解析正确）
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) {
        return send(res, 301, { location: pathname + '/' + (new URL(req.url, 'http://localhost').search || '') }, '');
      }
      filePath = join(filePath, 'index.html');
      st = await stat(filePath);
    }

    if (!st.isFile()) throw new Error('not a file');

    const ext = extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      // 入口不缓存（发新版立即生效）；带内容哈希的静态资源可短缓存
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600'
    };
    if (req.method === 'HEAD') return send(res, 200, headers, '');

    const body = await readFile(filePath);
    return send(res, 200, headers, body);
  } catch {
    return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '404 Not Found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用 —— 换一个端口，例如: node serve.mjs ${positional[0] || '.'} ${port + 1}`);
    process.exit(1);
  }
  console.error('服务器错误:', err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`正在服务: ${root}`);
  console.log(`访问地址: http://${shown}:${port}/`);
  if (host === '0.0.0.0' || host === '::') {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`局域网地址: http://${a.address}:${port}/`);
      }
    }
  }
  console.log('按 Ctrl+C 停止');
});

// 优雅退出（Ctrl+C / kill）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
