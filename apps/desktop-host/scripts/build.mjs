/**
 * desktop-host 构建编排（T-M1-02）：
 *   main    → dist/main/index.js        (ESM, external electron)
 *   preload → dist/preload/index.cjs    (CJS, sandbox:false)
 *   stage   → dist/renderer/pet-stage/  (IIFE browser bundle + html + manifest)
 * 类型检查由根 tsc -b 负责（本脚本只做打包与拷贝）。
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');

const common = { bundle: true, sourcemap: false, logLevel: 'silent' };

await build({
  ...common,
  entryPoints: [join(appRoot, 'src/main/index.ts')],
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  outfile: join(appRoot, 'dist/main/index.js'),
});

await build({
  ...common,
  entryPoints: [join(appRoot, 'src/preload/index.ts')],
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: join(appRoot, 'dist/preload/index.cjs'),
});

await build({
  ...common,
  entryPoints: [join(appRoot, 'src/renderer/pet-stage/main.ts')],
  platform: 'browser',
  format: 'iife',
  outfile: join(appRoot, 'dist/renderer/pet-stage/main.js'),
});

// director：React 19（esbuild jsx automatic）+ Tailwind v4 CLI
await build({
  ...common,
  entryPoints: [join(appRoot, 'src/renderer/director/main.tsx')],
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  outfile: join(appRoot, 'dist/renderer/director/main.js'),
});

const { createRequire } = await import('node:module');
const requireFromApp = createRequire(join(appRoot, 'package.json'));
const tailwindCliPkgPath = requireFromApp.resolve('@tailwindcss/cli/package.json');
const tailwindCli = join(dirname(tailwindCliPkgPath), JSON.parse(readFileSync(tailwindCliPkgPath, 'utf8')).bin.tailwindcss);
execFileSync(
  process.execPath,
  [
    tailwindCli,
    '-i', join(appRoot, 'src/renderer/director/styles.css'),
    '-o', join(appRoot, 'dist/renderer/director/director.css'),
    '--cwd', appRoot,
  ],
  { stdio: 'inherit' },
);

const stageDir = join(appRoot, 'dist/renderer/pet-stage');
mkdirSync(stageDir, { recursive: true });
copyFileSync(join(appRoot, 'src/renderer/pet-stage/index.html'), join(stageDir, 'index.html'));
copyFileSync(
  join(repoRoot, 'packages/pet-renderer/fixtures/blue-whale-maid.manifest.json'),
  join(stageDir, 'blue-whale-maid.manifest.json'),
);
const directorDir = join(appRoot, 'dist/renderer/director');
mkdirSync(directorDir, { recursive: true });
copyFileSync(join(appRoot, 'src/renderer/director/index.html'), join(directorDir, 'index.html'));
console.log('desktop-host build ✓（main / preload / pet-stage / director）');
