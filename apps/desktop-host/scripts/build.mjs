/**
 * desktop-host 构建编排（T-M1-02）：
 *   main    → dist/main/index.js        (ESM, external electron)
 *   preload → dist/preload/index.cjs    (CJS, sandbox:false)
 *   stage   → dist/renderer/pet-stage/  (IIFE browser bundle + html + manifest)
 * 类型检查由根 tsc -b 负责（本脚本只做打包与拷贝）。
 */
import { build } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
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
  // electron 框架本体由运行时注入；node:sqlite 为 Electron/Node 内置模块，platform: 'node' 自动 external
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

// tray-popover（T-M6-60）：独立 360×500 快捷浮窗入口；CSS 内联在 index.html，不拖 Tailwind 构建
await build({
  ...common,
  entryPoints: [join(appRoot, 'src/renderer/tray-popover/main.tsx')],
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  outfile: join(appRoot, 'dist/renderer/tray-popover/main.js'),
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
const popoverDir = join(appRoot, 'dist/renderer/tray-popover');
mkdirSync(popoverDir, { recursive: true });
copyFileSync(join(appRoot, 'src/renderer/tray-popover/index.html'), join(popoverDir, 'index.html'));

// 品牌资源（应用图标 / 侧栏 favicon / WebUI logo）：assets/brand → dist/renderer/brand
cpSync(join(appRoot, 'assets/brand'), join(appRoot, 'dist/renderer/brand'), { recursive: true });

// 空状态插画（Codex @illustrations）：assets/illustrations → dist/renderer/illustrations
cpSync(join(appRoot, 'assets/illustrations'), join(appRoot, 'dist/renderer/illustrations'), { recursive: true });

// pet 素材（D14 随包分发）：pet-renderer/assets → dist/renderer/assets
cpSync(
  join(repoRoot, 'packages/pet-renderer/assets'),
  join(appRoot, 'dist/renderer/pet-stage/assets'), // pet-stage html 在子目录，./assets 相对该目录解析
  { recursive: true },
);
// 气泡随包商用开源字体（SIL OFL 1.1）：assets/fonts → dist/renderer/pet-stage/fonts
cpSync(
  join(appRoot, 'assets/fonts'),
  join(stageDir, 'fonts'),
  { recursive: true },
);
console.log('desktop-host build ✓（main / preload / pet-stage / director + pet assets + fonts + illustrations）');
