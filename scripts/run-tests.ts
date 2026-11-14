import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];

if (mode !== 'fast' && mode !== 'integration') {
  console.error('用法: node scripts/run-tests.ts <fast|integration>');
  process.exit(2);
}

const patterns =
  mode === 'fast'
    ? ['packages/*/src/**/*.test.ts', 'tests/contract/**/*.test.ts']
    : ['tests/integration/**/*.test.ts'];

const files = patterns.flatMap((pattern) => globSync(pattern, { cwd: ROOT_DIR })).sort();

if (files.length === 0) {
  console.error(`未找到 ${mode} 测试文件（匹配模式: ${patterns.join(', ')}）`);
  process.exit(1);
}

const nodeArgs =
  mode === 'fast' ? ['--conditions=development', '--test', ...files] : ['--test', ...files];

const result = spawnSync(process.execPath, nodeArgs, {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
