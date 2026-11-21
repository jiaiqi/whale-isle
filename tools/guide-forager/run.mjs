#!/usr/bin/env node
/**
 * guide-forager CLI（T-M5-15/D15）：
 *   pnpm forage:guides            # 抓全量 7 专题 → guide-forager/（仓库内）
 *   pnpm forage:guides --export   # 同时导出到 BWF Mod guide/（get_guide 直读，真机立即生效）
 */
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { forageAll, TOPIC_PAGES } from './src/forage.js';
import { cpSync, mkdirSync } from 'node:fs';

const execFileAsync = promisify(execFile);
/** wiki 拦 Node fetch（403）但放行 curl——CLI 抓取走 curl 子进程（单测仍注入 fetch） */
const curlFetch = async (url) => {
  const { stdout } = await execFileAsync('curl', ['-sS', '-m', '30', '-A', 'Mozilla/5.0 (Macintosh) guide-forager/0.1 (local personal use)', url], { maxBuffer: 20 * 1024 * 1024 });
  return { ok: true, status: 200, json: async () => JSON.parse(stdout) };
};

const HOME = process.env.HOME ?? '';
const BWF_GUIDE_DIR = `${HOME}/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS/Mods/BlindWhaleFarmer/guide`;

const repoOut = join(process.cwd(), 'guide-forager');
const report = await forageAll({ outDir: repoOut, courtesyDelayMs: 1200, fetchImpl: curlFetch });
for (const f of report.fetched) {
  console.log(`${f.changed ? '✓ 抓取/更新' : f.error ? '⚠ ' + f.error : '· 无变化'}  ${f.topic}`);
}

if (process.argv.includes('--export')) {
  mkdirSync(BWF_GUIDE_DIR, { recursive: true });
  for (const topic of Object.keys(TOPIC_PAGES)) {
    try {
      cpSync(join(repoOut, `${topic}.md`), join(BWF_GUIDE_DIR, `${topic}.md`));
      console.log(`✓ 导出到 BWF get_guide 专题：${topic}`);
    } catch {
      console.log(`· 跳过未抓到的专题：${topic}`);
    }
  }
  console.log('完成：游戏内 get_guide <topic> 即可读取最新攻略');
}
