/**
 * error-detail — 错误细节提取与本地化描述的纯逻辑模块。
 *
 * 无 DOM 依赖，可被 plain-node 脚本直接 import 做单元测试。
 *
 * 设计说明：
 *  - moddle-xml 的解析错误把行/列内嵌在 message 字符串中
 *    （形如 "unparsable content ... detected\n\tline: 5\n\tcolumn: 2\n\tnested error: ..."），
 *    而不是对象上的结构化字段；嵌套错误的行/列出现在消息更靠后的位置，
 *    因此取「最后一对 line/column」最为可靠。
 *  - 文件系统错误由 Electron 主进程以 { code, syscall, message } 结构返回，
 *    这里映射为中文「标题 + 说明 + 建议」。
 */

const LINE_RE = /line:\s*(\d+)/g;
const COL_RE = /column:\s*(\d+)/g;

function lastMatchValue(text, re) {
  let m = null;
  let match;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    m = match[1];
  }
  return m === null ? null : Number(m);
}

/**
 * 从错误对象中提取解析位置。
 *
 * @param {Error|Object} err  错误对象（bpmn-js importXML 抛出的错误）
 *
 * @returns {{ line: number, column: number } | null}  无法定位时返回 null
 */
export function extractParseLocation(err) {
  if (!err) return null;

  // 未来某个版本若把位置挂成结构化字段，优先直接使用
  const directLine = typeof err.line === 'number' ? err.line : null;
  const directColumn = typeof err.column === 'number' ? err.column : null;
  if (directLine !== null && directColumn !== null) {
    return { line: directLine, column: directColumn };
  }

  const text = err.message || String(err);
  const line = lastMatchValue(text, LINE_RE);
  const column = lastMatchValue(text, COL_RE);

  // 行、列必须成对出现才算有效
  if (line === null || column === null) return null;

  return { line, column };
}

/**
 * 取 `line` 附近（上下各 `pad` 行）的源码片段。
 *
 * @param {string} xml     原始 XML 文本
 * @param {number} line    出错行（1 起始）
 * @param {number} [pad=2] 上下文行数
 *
 * @returns {{ lines: string[], errIndex: number } | null}
 *   lines: 切片行（1 行内绝不含换行符）；errIndex: 出错行在 lines 中的下标；
 *   参数非法或无内容时返回 null。
 */
export function excerptLines(xml, line, pad = 2) {
  if (typeof xml !== 'string' || typeof line !== 'number' || !Number.isFinite(line)) {
    return null;
  }
  const allLines = xml.split('\n');
  if (allLines.length === 0) return null;
  // 行号 clamp 到 [1, 行数] 范围，保证 errIndex 始终是有效下标
  const safeLine = Math.min(Math.max(1, Math.round(line)), allLines.length);
  const start = Math.max(0, safeLine - 1 - pad);
  const end = Math.min(allLines.length, safeLine - 1 + pad + 1);
  const lines = allLines.slice(start, end);
  return { lines, errIndex: safeLine - 1 - start };
}

// ── 文件系统错误中文分类 ──────────────────────────────────────────────────

const FS_DESCRIPTIONS = {
  ENOENT: {
    title: '文件不存在',
    message: '目标文件或目录不存在，可能已被移动或删除。',
    suggestion: '请检查文件路径是否正确，或重新选择文件。'
  },
  EACCES: {
    title: '没有访问权限',
    message: '当前用户没有读取/写入该文件的权限。',
    suggestion: '请检查文件与所在目录的权限设置（Linux/macOS 可用 chmod 调整）。'
  },
  EPERM: {
    title: '操作被拒绝',
    message: '操作系统拒绝了该文件操作。',
    suggestion: '请确认文件未被其他程序锁定，且不以只读模式挂载。'
  },
  EISDIR: {
    title: '所选路径是目录',
    message: '目标路径是一个目录而不是文件。',
    suggestion: '请重新选择具体的文件名。'
  },
  ENOSPC: {
    title: '磁盘空间不足',
    message: '磁盘剩余空间不足，无法完成写入。',
    suggestion: '请清理磁盘空间后重试。'
  },
  EROFS: {
    title: '文件系统只读',
    message: '目标位置位于只读文件系统上，无法写入。',
    suggestion: '请选择可写的位置保存文件。'
  },
  ENOTDIR: {
    title: '路径中的目录不存在',
    message: '目标路径中的某个目录不存在。',
    suggestion: '请确认保存路径中的目录存在后重试。'
  }
};

const FS_UNKNOWN_TITLE = '文件操作失败';
const FS_UNKNOWN_SUGGESTION = '请检查文件路径、权限与磁盘状态后重试。';

/**
 * 将文件系统错误码映射为中文「标题 + 说明 + 建议」。
 *
 * @param {string|undefined} code  错误码，如 'ENOENT'；未知或不提供时兜底
 * @param {string} [detail]        原始错误消息（附加展示用）
 *
 * @returns {{ title: string, message: string, suggestion: string }}
 */
export function describeFsError(code, detail) {
  const entry = FS_DESCRIPTIONS[code];
  if (entry) {
    return {
      title: entry.title,
      message: detail ? `${entry.message}\n（${detail}）` : entry.message,
      suggestion: entry.suggestion
    };
  }
  return {
    title: FS_UNKNOWN_TITLE,
    message: detail ? `发生文件系统错误：${detail}` : '发生未知的文件系统错误。',
    suggestion: FS_UNKNOWN_SUGGESTION
  };
}