#!/usr/bin/env node
/**
 * 全量桌宠素材直入仓库（T-M6-45 批次 1.1）。
 *
 * 目标：`assets/pet-packs/` 一次性落地全部离线素材，打包时经 electron-builder
 * `extraResources` 原样进入 `Resources/pet-packs/`（不进 asar，不进 dist）。
 *
 *   aboutme-pets/  hunmer/aboutme-pets：pets.json + preview.json + pets/<id>/ 全量
 *                  （9 套角色、1,040 动作精灵图、480 条 .m4a 原声）
 *   crosspet/      lokicorvus/crosspet：characters/（8 基础角色 + 7 套皮肤 + egg-* 彩蛋）
 *                  + app/web/fonts/notebook/*.woff2（8 套手写字体）
 *   fonts/         PC2005-cloud/dsh-pet：上首软糖体.ttf（气泡字体）
 *
 * 幂等：目标文件已存在且字节数与 GitHub tree 一致则跳过；断点续传按文件粒度。
 * 用法：
 *   pnpm sync:pet-packs                     # 全量同步
 *   pnpm sync:pet-packs --only aboutme      # 只同步某一来源（aboutme|crosspet|fonts）
 *   pnpm sync:pet-packs --dry-run           # 只打印计划，不下载
 *   GITHUB_TOKEN=... pnpm sync:pet-packs    # 提高 GitHub API 限流额度
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = join(ROOT, 'assets', 'pet-packs');
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

const argv = process.argv.slice(2);
const onlyArgs = argv.flatMap((arg, index) => (arg === '--only' ? [argv[index + 1]].filter(Boolean) : []));
const DRY_RUN = argv.includes('--dry-run');
const CONCURRENCY = Math.max(1, Math.min(16, Number(argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 8)));

/** 每个来源只取需要的子树，绝不整仓搬运（README/源码/__pycache__ 一律不拉）。 */
const SOURCES = [
  {
    id: 'aboutme',
    repo: 'hunmer/aboutme-pets',
    branch: 'main',
    dir: 'aboutme-pets',
    include: (path) => path === 'pets.json' || path === 'preview.json' || path.startsWith('pets/'),
  },
  {
    id: 'crosspet',
    repo: 'lokicorvus/crosspet',
    branch: 'main',
    dir: 'crosspet',
    include: (path) => path.startsWith('characters/') || (path.startsWith('app/web/fonts/notebook/') && path.endsWith('.woff2')),
  },
  {
    id: 'fonts',
    repo: 'PC2005-cloud/dsh-pet',
    branch: 'main',
    dir: 'fonts',
    include: (path) => path === 'dsh-pet/assets/fonts/上首软糖体.ttf',
    /** 把上游深层路径压平到 assets/pet-packs/fonts/ */
    rename: (path) => path.slice('dsh-pet/assets/fonts/'.length),
  },
];

const selected = onlyArgs.length > 0 ? SOURCES.filter((s) => onlyArgs.includes(s.id)) : SOURCES;
if (selected.length === 0) {
  console.error(`未匹配来源：${onlyArgs.join(',') || '(空)'}；可选 ${SOURCES.map((s) => s.id).join('|')}`);
  process.exit(1);
}

function authHeaders(extra = {}) {
  return TOKEN ? { ...extra, authorization: `Bearer ${TOKEN}` } : extra;
}

async function fetchWithRetry(url, init = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status === 404) return response;
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} ${url}`);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function listTree(source) {
  const url = `https://api.github.com/repos/${source.repo}/git/trees/${source.branch}?recursive=1`;
  const response = await fetchWithRetry(url, { headers: authHeaders({ accept: 'application/vnd.github+json', 'user-agent': 'whale-isle-sync-pet-packs' }) });
  if (!response.ok) throw new Error(`GitHub tree ${source.repo} HTTP ${response.status}（限流请设置 GITHUB_TOKEN）`);
  const body = await response.json();
  if (body.truncated === true) throw new Error(`${source.repo} tree 被截断，无法保证全量`);
  return (body.tree ?? []).filter((entry) => entry.type === 'blob' && source.include(entry.path));
}

function rawUrl(source, path) {
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `https://raw.githubusercontent.com/${source.repo}/${source.branch}/${encoded}`;
}

function localPath(source, path) {
  const rel = source.rename ? source.rename(path) : path;
  const abs = resolve(OUT_ROOT, source.dir, rel);
  const guard = resolve(OUT_ROOT, source.dir);
  if (!abs.startsWith(guard + sep)) throw new Error(`越界路径：${path}`);
  return abs;
}

function alreadyComplete(abs, size) {
  if (!existsSync(abs)) return false;
  try {
    return statSync(abs).size === size;
  } catch {
    return false;
  }
}

async function downloadOne(source, blob, progress) {
  const dest = localPath(source, blob.path);
  if (alreadyComplete(dest, blob.size)) {
    progress.skipped += 1;
    return;
  }
  if (DRY_RUN) {
    progress.wouldDownload += 1;
    return;
  }
  const response = await fetchWithRetry(rawUrl(source, blob.path), { headers: authHeaders({ 'user-agent': 'whale-isle-sync-pet-packs' }) });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${blob.path}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== blob.size) throw new Error(`字节数不符（${buffer.length}/${blob.size}）：${blob.path}`);
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.part`;
  await writeFile(temp, buffer);
  await rename(temp, dest);
  progress.downloaded += 1;
  if (progress.downloaded % 50 === 0) {
    console.log(`  … ${source.id}: 已下载 ${progress.downloaded}（跳过 ${progress.skipped}）`);
  }
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const summary = { syncedAt: new Date().toISOString(), dryRun: DRY_RUN, sources: [] };
console.log(`sync-pet-packs → ${relative(ROOT, OUT_ROOT)}${DRY_RUN ? '（dry-run）' : ''}，并发 ${CONCURRENCY}`);

for (const source of selected) {
  const started = Date.now();
  const blobs = await listTree(source);
  if (blobs.length === 0) throw new Error(`${source.repo} 未匹配到任何文件（include 规则失效？）`);
  const totalBytes = blobs.reduce((sum, blob) => sum + (blob.size ?? 0), 0);
  console.log(`[${source.id}] ${source.repo}：${blobs.length} 个文件 / ${(totalBytes / 1048576).toFixed(1)} MiB`);
  const progress = { downloaded: 0, skipped: 0, wouldDownload: 0 };
  await runPool(blobs, CONCURRENCY, (blob) => downloadOne(source, blob, progress));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[${source.id}] 完成：下载 ${progress.downloaded}，跳过 ${progress.skipped}${DRY_RUN ? `，计划下载 ${progress.wouldDownload}` : ''}，${seconds}s`);
  summary.sources.push({
    id: source.id,
    repo: source.repo,
    branch: source.branch,
    files: blobs.length,
    bytes: totalBytes,
    downloaded: progress.downloaded,
    skipped: progress.skipped,
  });
}

if (!DRY_RUN) {
  await mkdir(OUT_ROOT, { recursive: true });
  await writeFile(join(OUT_ROOT, 'SYNC-MANIFEST.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`已写入 ${relative(ROOT, join(OUT_ROOT, 'SYNC-MANIFEST.json'))}`);
}
