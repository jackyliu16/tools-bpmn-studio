/**
 * scripts/lib/testkit.mjs — 测试脚本共享工具。
 *
 * smoke.mjs / ui-harness.mjs / check-error-details.mjs 共用的部分：
 *   - PASS/FAIL 断言 runner（收集 + 汇总 + 退出码）
 *   - jsdom 缺失 CSS.escape 的补丁（css.escape shim）
 * 各脚本专属的 jsdom 环境启动 / polyfill 留在各自脚本内。
 */
import cssEscape from 'css.escape';

/** jsdom 缺 CSS.escape：补一个 shim（已存在则跳过） */
export function installCssEscape() {
  if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
    globalThis.CSS = globalThis.CSS || {};
    globalThis.CSS.escape = cssEscape;
  }
}

/**
 * 创建断言 runner。
 * @returns {{ check: (name: string, ok: boolean, detail?: string) => void,
 *             finish: (label?: string) => number }}
 *   check 记录并打印一行 PASS/FAIL；
 *   finish 打印 `N/M <label> passed` 并返回进程退出码（有失败则 1）。
 */
export function createTester() {
  const results = [];

  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };

  const finish = (label = 'checks') => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} ${label} passed`);
    return failed ? 1 : 0;
  };

  return { check, finish };
}