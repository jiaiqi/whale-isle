#!/usr/bin/env node
/**
 * aboutme-pets 9 角色包 CLI（T-M6-41）。
 * 用法：node tools/scripts/import-aboutme-pets.mjs --all
 *       node tools/scripts/import-aboutme-pets.mjs --pack dsh --pack kimi
 * 素材只写入 userData/pet-characters，不进仓库。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { importAboutmePets, ABOUTME_PACKS } from '../../packages/pet-renderer/dist/aboutme-pets.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const packs = args.flatMap((arg, index) => arg === '--pack' ? [args[index + 1]].filter(Boolean) : []);
const appData = process.env.WHALE_ISLE_USER_DATA ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Whale Isle')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? homedir(), 'Whale Isle')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Whale Isle'));
if (!all && packs.length === 0) {
  console.error(`请选择 --all 或 --pack <${ABOUTME_PACKS.map((p) => p.slug).join('|')}>`);
  process.exit(1);
}
const result = await importAboutmePets({
  userDataDir: appData,
  all,
  packSlugs: packs,
  onProgress: (p) => console.log(`[${p.phase}] ${p.packId} ${p.completed}/${p.total} ${p.message}`),
});
console.log(JSON.stringify(result, null, 2));
if (result.failed.length > 0) process.exitCode = 1;
