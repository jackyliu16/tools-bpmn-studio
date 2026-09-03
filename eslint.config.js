import js from '@eslint/js';
import globals from 'globals';

/**
 * bpmn-studio ESLint flat config（ESLint 9）。
 *
 * 分段 globals：
 *   - src 下所有 .js（任意子目录）→ 浏览器全局 + ESM（渲染进程）
 *   - electron/*.cjs            → Node 全局 + CommonJS（主进程 / preload）
 *   - scripts 下所有 .mjs       → Node 全局 + ESM（构建/测试脚本）
 *   - vite.config.js / eslint.config.js → Node 全局 + ESM
 *
 * src/lint-config.js 由 `npm run lint:pack` 自动生成，忽略。
 * 阻塞式接入：`npm run build` 第一步先跑 `npm run lint:js`。
 */
export default [
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      '.electron-builder-cache/**',
      '.electron-build-tmp/**',
      '.wineprefix/**',
      '.pi/**',
      'src/lint-config.js'
    ]
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'warn' // 应用有意使用 console（诊断/错误路径）
    }
  },
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'warn'
    }
  },
  {
    files: ['scripts/**/*.mjs', 'vite.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off' // CLI 工具脚本：stdout 输出就是接口
    }
  },
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      ...js.configs.recommended.rules
    }
  }
];