#!/usr/bin/env node
// Node 24 原生 type stripping：直接运行 TypeScript 源码，无需构建步骤。

// node:sqlite 在 Node 24 仍标记为实验性，过滤这条噪音警告（入口层处理，避免污染每次输出）。
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? String(warning);
  if (text.includes('SQLite is an experimental')) return;
  return originalEmitWarning(warning, ...rest);
};

import('../src/cli.ts');
