/**
 * desktop-host 构建编排（T-M1-02）：
 *   main    → dist/main/index.js        (ESM, external electron)
 *   preload → dist/preload/index.cjs    (CJS, sandbox:false)
 *   stage   → dist/renderer/pet-stage/  (IIFE browser bundle + html + manifest)
 * 类型检查由根 tsc -b 负责（本脚本只做打包与拷贝）。
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const stageDir = join(appRoot, 'dist/renderer/pet-stage');
mkdirSync(stageDir, { recursive: true });
copyFileSync(join(appRoot, 'src/renderer/pet-stage/index.html'), join(stageDir, 'index.html'));
copyFileSync(
  join(repoRoot, 'packages/pet-renderer/fixtures/blue-whale-maid.manifest.json'),
  join(stageDir, 'blue-whale-maid.manifest.json'),
);
console.log('desktop-host build ✓（main / preload / pet-stage）');
