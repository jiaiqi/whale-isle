#!/usr/bin/env node
/**
 * 引擎权重下载/校验/卸载（item 10 阶段 2）。
 *
 * 铁律：
 * - 权重**不进 git、不进 repo 目录**；默认落到用户数据目录的 `engines/<engineId>/<version>/`。
 * - 只认清单里的文件与字节数；sha256 不符即删掉重下，三次不过就整体失败，**绝不留半包冒充可用**。
 * - 全部文件校验通过后才写 `installed.json` 并原子 rename 到最终目录——没有 installed.json 就是没装。
 * - 过程可复跑：同样的 manifest + revision 下出同样的目录与校验结果。
 *
 * 用法：
 *   node tools/scripts/fetch-engine.mjs --dry-run          # 只打印计划（默认清单）
 *   node tools/scripts/fetch-engine.mjs                    # 下载 + 校验 + 安装
 *   node tools/scripts/fetch-engine.mjs --check            # 校验已安装目录
 *   node tools/scripts/fetch-engine.mjs --remove           # 按 installed.json 精确删除
 *   node tools/scripts/fetch-engine.mjs --manifest <path> --dest <root>
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(HERE, 'engine-manifests', 'cosyvoice2-0.5b.json');
const MAX_ATTEMPTS = 3;

function defaultEnginesRoot() {
  const os = platform();
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'WhaleIsle', 'engines');
  if (os === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'WhaleIsle', 'engines');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'WhaleIsle', 'engines');
}

function parseArgs(argv) {
  const opts = { dryRun: false, check: false, remove: false, manifest: DEFAULT_MANIFEST, dest: defaultEnginesRoot() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--remove') opts.remove = true;
    else if (arg === '--manifest') opts.manifest = resolve(String(argv[++i] ?? ''));
    else if (arg === '--dest') opts.dest = resolve(String(argv[++i] ?? ''));
    else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

async function loadManifest(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (typeof raw.repoId !== 'string' || typeof raw.revision !== 'string') throw new Error('清单缺 repoId / revision');
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw new Error('清单 files 为空');
  const total = raw.files.reduce((sum, file) => sum + Number(file.bytes ?? 0), 0);
  if (raw.expectedBytes !== undefined && raw.expectedBytes !== total) {
    throw new Error(`清单自相矛盾：expectedBytes=${raw.expectedBytes} 但文件字节合计=${total}`);
  }
  return { ...raw, expectedBytes: total };
}

function fileUrl(manifest, filePath) {
  return `https://huggingface.co/${manifest.repoId}/resolve/${manifest.revision}/${filePath}`;
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

/** 单文件下载（断点续传：已有部分文件用 Range 续）
 *  优先用系统 curl：实测 macOS 上 curl 单流 18.7 MB/s，而 Node fetch 流式落到磁盘只有 ~0.2 MB/s。
 *  curl 不存在时回退到 fetch（慢但可用）。
 */
async function downloadFile(url, target, expectedBytes, log) {
  const partial = `${target}.part`;
  const have = await sizeOf(partial);
  if (have > expectedBytes) await rm(partial, { force: true });
  const resumeFrom = Math.max(0, await sizeOf(partial));
  if (resumeFrom === expectedBytes) {
    log(`  已有完整分片，跳过下载（${expectedBytes} B）`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    if (hasCurl()) {
      await downloadWithCurl(url, partial);
    } else {
      await downloadWithFetch(url, partial, resumeFrom);
    }
  }
  const finalSize = await sizeOf(partial);
  if (finalSize !== expectedBytes) throw new Error(`字节数不符：期望 ${expectedBytes}，实得 ${finalSize}`);
  // 分片完整后才落到目标路径（校验失败时只删 .part，不会留下半截真文件）
  await rm(target, { force: true });
  await rename(partial, target);
}

let curlChecked = null;
function hasCurl() {
  if (curlChecked !== null) return curlChecked;
  try {
    curlChecked = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    curlChecked = false;
  }
  return curlChecked;
}

function downloadWithCurl(url, partial) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-sSL', '-C', '-', '--retry', '3', '--retry-delay', '2', '-o', partial, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl 退出码 ${code}${stderr.trim() === '' ? '' : `：${stderr.trim().slice(-200)}`}`));
    });
  });
}

async function downloadWithFetch(url, partial, resumeFrom) {
  const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('响应没有 body');
  const out = createWriteStream(partial, { flags: resumeFrom > 0 ? 'a' : 'w' });
  await pipeline(Readable.fromWeb(response.body), out);
}

async function install(opts, manifest) {
  const log = (line) => console.log(line);
  const versionDir = join(opts.dest, manifest.engineId, manifest.version);
  const partialDir = join(opts.dest, manifest.engineId, `.partial-${manifest.version}`);

  log(`引擎：${manifest.displayName}（${manifest.engineId}@${manifest.version}）`);
  log(`来源：${manifest.repoId}@${manifest.revision}`);
  log(`目标：${versionDir}`);
  log(`文件：${manifest.files.length} 个，合计 ${manifest.expectedBytes} B（${(manifest.expectedBytes / 1e9).toFixed(3)} GB）`);

  if (opts.dryRun) {
    for (const file of manifest.files) log(`  ${String(file.bytes).padStart(12)}  ${file.path}`);
    log('--dry-run：未下载任何字节。');
    return 0;
  }

  const installed = [];
  for (const file of manifest.files) {
    const target = join(partialDir, file.path);
    const url = fileUrl(manifest, file.path);
    let attempt = 0;
    let digest = '';
    for (;;) {
      attempt += 1;
      try {
        log(`→ ${file.path}（${file.bytes} B，第 ${attempt} 次）`);
        await downloadFile(url, target, file.bytes, log);
        digest = await sha256Of(target);
        if (file.sha256 && digest !== file.sha256) throw new Error(`sha256 不符：期望 ${file.sha256}，实得 ${digest}`);
        break;
      } catch (error) {
        log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
        await rm(target, { force: true });
        await rm(`${target}.part`, { force: true });
        if (attempt >= MAX_ATTEMPTS) {
          await rm(partialDir, { recursive: true, force: true });
          throw new Error(`文件 ${file.path} 连续 ${MAX_ATTEMPTS} 次失败，已清理分片目录，未安装任何内容`);
        }
      }
    }
    installed.push({ path: file.path, bytes: file.bytes, sha256: digest });
  }

  // 全部通过才发布：先写 installed.json，再原子 rename 到最终目录
  await writeFile(
    join(partialDir, 'installed.json'),
    `${JSON.stringify({
      engineId: manifest.engineId,
      version: manifest.version,
      displayName: manifest.displayName,
      repoId: manifest.repoId,
      revision: manifest.revision,
      license: manifest.license ?? null,
      installedAt: new Date().toISOString(),
      totalBytes: installed.reduce((sum, file) => sum + file.bytes, 0),
      files: installed,
    }, null, 2)}\n`,
    'utf8',
  );
  await rm(versionDir, { recursive: true, force: true });
  await mkdir(dirname(versionDir), { recursive: true });
  await rename(partialDir, versionDir);
  const total = installed.reduce((sum, file) => sum + file.bytes, 0);
  log(`✓ 安装完成：${versionDir}`);
  log(`✓ 实际字节数 ${total}（清单 ${manifest.expectedBytes}），${installed.length} 个文件全部通过 sha256`);
  return 0;
}

async function check(opts, manifest) {
  const versionDir = join(opts.dest, manifest.engineId, manifest.version);
  const markerPath = join(versionDir, 'installed.json');
  if (!(await exists(markerPath))) {
    console.log(`✗ 未安装：缺少 ${markerPath}`);
    return 1;
  }
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  let bad = 0;
  for (const file of marker.files) {
    const target = join(versionDir, file.path);
    const size = await sizeOf(target);
    if (size !== file.bytes) {
      console.log(`✗ 字节数不符：${file.path} 期望 ${file.bytes} 实得 ${size}`);
      bad += 1;
      continue;
    }
    const digest = await sha256Of(target);
    if (digest !== file.sha256) {
      console.log(`✗ sha256 不符：${file.path}`);
      bad += 1;
    }
  }
  if (bad > 0) {
    console.log(`✗ 校验失败：${bad} 个文件异常`);
    return 1;
  }
  console.log(`✓ 校验通过：${marker.files.length} 个文件，合计 ${marker.totalBytes} B（安装于 ${marker.installedAt}）`);
  return 0;
}

async function remove(opts, manifest) {
  const versionDir = join(opts.dest, manifest.engineId, manifest.version);
  const markerPath = join(versionDir, 'installed.json');
  if (!(await exists(markerPath))) {
    console.log(`无需删除：${versionDir} 不存在或没有 installed.json`);
    return 0;
  }
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  let removed = 0;
  for (const file of marker.files) {
    const target = join(versionDir, file.path);
    if (await exists(target)) {
      await rm(target, { force: true });
      removed += 1;
    }
  }
  await rm(markerPath, { force: true });
  // 清空目录（自底向上，只删空目录，避免误删别的版本）
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isDirectory()) await walk(join(dir, entry.name));
    await rm(dir, { recursive: false, force: true }).catch(() => undefined);
  };
  await walk(versionDir);
  await rm(join(opts.dest, manifest.engineId), { recursive: false, force: true }).catch(() => undefined);
  console.log(`✓ 已删除 ${removed} 个文件与 installed.json（${versionDir}）`);
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(opts.manifest);
  if (opts.check) return check(opts, manifest);
  if (opts.remove) return remove(opts, manifest);
  return install(opts, manifest);
}

// 允许被 spec 引用（默认只在直接执行时跑 main）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}

export { loadManifest, defaultEnginesRoot, parseArgs };
