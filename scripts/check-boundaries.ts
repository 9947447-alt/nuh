import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_UI_PACKAGES = new Set([
  'ink',
  'blessed',
  'react',
  'react-dom',
  'vite',
  'electron',
  'tauri',
]);

const FORBIDDEN_APP_INTERNAL_PACKAGES = new Set([
  '@nuh/core',
  '@nuh/backends',
  '@nuh/dsh-shims',
  '@nuh/mcp-bridge',
]);

const FORBIDDEN_PROTOCOL_DEPS = new Set([
  '@nuh/core',
  '@nuh/backends',
  '@nuh/dsh-shims',
  '@nuh/mcp-bridge',
  '@nuh/cli-repl',
]);

const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IMPORT_SPECIFIER_PATTERN =
  /(?:import\s+(?:type\s+)?[\s\S]*?\s+from\s+|import\s*\(|export\s+[\s\S]*?\s+from\s+|require\s*\()\s*['"]([^'"]+)['"]/g;

function readManifest(manifestPath: string): PackageManifest {
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as PackageManifest;
}

function collectAllDeps(manifest: PackageManifest): Array<[string, string, string]> {
  const sections: Array<
    [
      'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies',
      Record<string, string> | undefined,
    ]
  > = [
    ['dependencies', manifest.dependencies],
    ['devDependencies', manifest.devDependencies],
    ['peerDependencies', manifest.peerDependencies],
    ['optionalDependencies', manifest.optionalDependencies],
  ];
  const entries: Array<[string, string, string]> = [];
  for (const [section, record] of sections) {
    if (!record) {
      continue;
    }
    for (const [depName, version] of Object.entries(record)) {
      entries.push([section, depName, version]);
    }
  }
  return entries;
}

function isUiFramework(pkgName: string): boolean {
  return FORBIDDEN_UI_PACKAGES.has(pkgName) || pkgName.startsWith('@tauri-apps/');
}

function checkManifests(violations: string[]): void {
  const manifestPaths = [
    path.join(ROOT_DIR, 'package.json'),
    ...globSync('packages/*/package.json', { cwd: ROOT_DIR }).map((p) => path.join(ROOT_DIR, p)),
    ...globSync('apps/*/package.json', { cwd: ROOT_DIR }).map((p) => path.join(ROOT_DIR, p)),
  ];

  for (const manifestPath of manifestPaths) {
    const relPath = path.relative(ROOT_DIR, manifestPath);
    const manifest = readManifest(manifestPath);
    const deps = collectAllDeps(manifest);

    for (const [section, depName, version] of deps) {
      if (depName.startsWith('@deepseek-ai/') && !EXACT_SEMVER_PATTERN.test(version)) {
        violations.push(
          `${relPath} (${section}): @deepseek-ai/* 依赖 ${depName}="${version}" 必须锁定精确版本号（禁止 ^/~/*）`,
        );
      }

      if (isUiFramework(depName)) {
        violations.push(
          `${relPath} (${section}): Phase 3 验收前冻结前端开发，禁止引入 UI 框架 ${depName}`,
        );
      }

      if (relPath.startsWith(`apps${path.sep}`)) {
        if (FORBIDDEN_APP_INTERNAL_PACKAGES.has(depName) || depName.startsWith('@deepseek-ai/')) {
          violations.push(
            `${relPath} (${section}): apps/* 禁止直接依赖底层包 ${depName}，仅允许依赖 @nuh/protocol`,
          );
        }
      }

      if (relPath === path.join('packages', 'protocol', 'package.json')) {
        if (FORBIDDEN_PROTOCOL_DEPS.has(depName) || depName.startsWith('@deepseek-ai/')) {
          violations.push(
            `${relPath} (${section}): @nuh/protocol 是最底层契约包，禁止依赖 ${depName}`,
          );
        }
      }
    }
  }
}

function getPackageRootForFile(relFilePath: string): string | null {
  const parts = relFilePath.split(path.sep);
  if ((parts[0] === 'packages' || parts[0] === 'apps') && parts[1]) {
    return path.join(ROOT_DIR, parts[0], parts[1]);
  }
  return null;
}

function checkSourceImports(violations: string[]): void {
  const sourceFiles = [
    ...globSync('apps/**/*.{ts,mts,js,mjs}', { cwd: ROOT_DIR }),
    ...globSync('packages/**/*.{ts,mts,js,mjs}', { cwd: ROOT_DIR }),
  ].filter(
    (relPath) =>
      !relPath.includes(`${path.sep}dist${path.sep}`) &&
      !relPath.includes(`${path.sep}node_modules${path.sep}`),
  );

  for (const relPath of sourceFiles) {
    const absPath = path.join(ROOT_DIR, relPath);
    const pkgRoot = getPackageRootForFile(relPath);
    const content = readFileSync(absPath, 'utf8');

    for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }

      if (specifier.startsWith('.')) {
        if (pkgRoot) {
          const resolvedTarget = path.resolve(path.dirname(absPath), specifier);
          const relToPkg = path.relative(pkgRoot, resolvedTarget);
          if (relToPkg.startsWith('..') || path.isAbsolute(relToPkg)) {
            violations.push(`${relPath}: 禁止通过相对路径 "${specifier}" 越界跳出当前包根目录`);
          }
        }
        continue;
      }

      const pkgName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];

      if (!pkgName) {
        continue;
      }

      if (isUiFramework(pkgName)) {
        violations.push(`${relPath}: Phase 3 验收前禁止导入前端/TUI 框架 "${specifier}"`);
      }

      if (relPath.startsWith(`apps${path.sep}`)) {
        if (FORBIDDEN_APP_INTERNAL_PACKAGES.has(pkgName) || pkgName.startsWith('@deepseek-ai/')) {
          violations.push(
            `${relPath}: apps/* 禁止越界导入 "${specifier}"，必须通过 @nuh/protocol JSON-RPC 通信`,
          );
        }
      }

      if (relPath.startsWith(path.join('packages', 'protocol') + path.sep)) {
        if (FORBIDDEN_PROTOCOL_DEPS.has(pkgName) || pkgName.startsWith('@deepseek-ai/')) {
          violations.push(`${relPath}: @nuh/protocol 禁止反向导入 "${specifier}"`);
        }
      }
    }
  }
}

function checkTestLayers(violations: string[]): void {
  const requiredDirs = ['contract', 'integration', 'e2e', 'evals', 'fixtures'];
  for (const dir of requiredDirs) {
    const abs = path.join(ROOT_DIR, 'tests', dir);
    if (!existsSync(abs)) {
      violations.push(`缺少测试分层目录: tests/${dir}`);
    }
  }
}

const violations: string[] = [];
checkManifests(violations);
checkSourceImports(violations);
checkTestLayers(violations);

if (violations.length > 0) {
  console.error('模块边界与架构红线检查失败:');
  for (const item of violations) {
    console.error(`  - ${item}`);
  }
  process.exit(1);
}

console.log('边界检查通过: 包依赖、跨层导入、@deepseek-ai/* 版本锁定与测试分层均合规。');
