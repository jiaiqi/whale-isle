#!/usr/bin/env node
/**
 * pnpm verify:gate — 「四道自动化准入门禁」编排器（AGENTS.md §2.3 / §3.3）
 *
 * 当前进度（与 docs/ROADMAP.md 同步，随工单推进接线）：
 *   Gate 1 类型与边界    ✅ tsc -b 已接线（dependency-cruiser 架构规则由 T-M0-01 接入）
 *   Gate 2 许可证与密钥  ✅ 基础版：THIRD_PARTY_NOTICES 台账校验 + 源码密钥泄漏/禁源痕迹扫描
 *   Gate 3 确定性单测    ⏳ TODO(T-M0-03 起)：核心包分支覆盖率 ≥90% 后接入
 *   Gate 4 沙盒 E2E      ⏳ TODO(T-M0-04 起)：tools/mock-harness 全链路回归接入
 *
 * 注意：本脚本自身包含检测规则字面量，已被排除在扫描范围之外。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);
const SCAN_DIRS = ['packages', 'apps', 'services', 'tools', 'mods'];
const SKIP_DIR_NAMES = new Set([
  'node_modules', 'dist', 'coverage', '.git', '.venv', '__pycache__',
  'bin', 'obj', '.ruff_cache', '.mypy_cache', 'out',
]);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.cs']);

/** 硬编码密钥特征（命中即 FAIL） */
const SECRET_RULES = [
  { re: /\bsk-[A-Za-z0-9]{16,}\b/, label: '疑似 OpenAI 风格密钥 (sk-...)' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, label: '疑似 GitHub Token (ghp_...)' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: '疑似 AWS Access Key (AKIA...)' },
  { re: /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-.]{12,}['"]/i, label: '疑似明文 apiKey 赋值' },
];

/** UNLICENSED 项目源码痕迹（命中即 FAIL，AGENTS.md §2.2 许可证洁癖） */
const FORBIDDEN_MARKERS = [
  { re: /fore-vip[/\\]dsh-live(?!-studio)/i, label: 'fore-vip/dsh-live（UNLICENSED）源码痕迹' },
  { re: /newbeejmc[/\\]Dsh_douyin/i, label: 'newbeejmc/Dsh_douyin（UNLICENSED）源码痕迹' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // 竞态删除等场景直接跳过
    }
    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      yield* walk(abs);
    } else if (CODE_EXT.has(extname(entry).toLowerCase())) {
      yield abs;
    }
  }
}

function collectFiles() {
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (f === SELF) continue;
      files.push(f);
    }
  }
  return files;
}

function truncate(s, maxLines = 12) {
  const lines = String(s).trim().split('\n').filter(Boolean);
  return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? `\n…（共 ${lines.length} 行）` : '');
}

const gates = [];
function gate(name, status, detail) {
  gates.push({ name, status, detail });
}
const icon = { PASS: '✅ PASS', FAIL: '❌ FAIL', PENDING: '⏳ PENDING' };

console.log('╭──────────────────────────────────────────────────────────╮');
console.log('│ pnpm verify:gate — 四道自动化准入门禁                    │');
console.log('╰──────────────────────────────────────────────────────────╯');

// ---- Gate 1：类型编译（架构边界 dependency-cruiser 由 T-M0-01 接入） ----
const tsc = spawnSync('pnpm', ['typecheck'], { cwd: ROOT, encoding: 'utf8' });
if (tsc.error) {
  gate('Gate 1 类型与边界', 'FAIL', `无法启动 pnpm typecheck：${tsc.error.message}（请先执行 pnpm install）`);
} else if (tsc.status === 0) {
  gate('Gate 1 类型与边界', 'PASS', 'tsc -b 零错误（strict + noUncheckedIndexedAccess）');
} else {
  gate('Gate 1 类型与边界', 'FAIL', truncate(`${tsc.stdout}\n${tsc.stderr}`));
}

// ---- Gate 2：许可证台账 + 密钥/禁源扫描 ----
const noticesPath = join(ROOT, 'docs', 'THIRD_PARTY_NOTICES.md');
const noticesOk = existsSync(noticesPath) && readFileSync(noticesPath, 'utf8').length > 200;

const secretHits = [];
const forbiddenHits = [];
let scanned = 0;
if (existsSync(join(ROOT, 'packages'))) {
  for (const f of collectFiles()) {
    scanned += 1;
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const r of SECRET_RULES) {
        if (r.re.test(lines[i])) secretHits.push(`${relative(ROOT, f)}:${i + 1}  ${r.label}`);
      }
      for (const r of FORBIDDEN_MARKERS) {
        if (r.re.test(lines[i])) forbiddenHits.push(`${relative(ROOT, f)}:${i + 1}  ${r.label}`);
      }
    }
  }
}

if (!noticesOk) {
  gate('Gate 2 许可证与密钥', 'FAIL', 'docs/THIRD_PARTY_NOTICES.md 缺失或为空壳（每引入一个第三方依赖/素材必须登记）');
} else if (secretHits.length > 0 || forbiddenHits.length > 0) {
  const detail = [
    ...secretHits.map((h) => `[密钥泄漏嫌疑] ${h}`),
    ...forbiddenHits.map((h) => `[UNLICENSED 源码痕迹] ${h}`),
  ].join('\n');
  gate('Gate 2 许可证与密钥', 'FAIL', truncate(detail));
} else {
  gate(
    'Gate 2 许可证与密钥',
    'PASS',
    `台账 OK；已扫描 ${scanned} 个源文件：0 处密钥泄漏 / 0 处 UNLICENSED 源码痕迹`
  );
}

// ---- Gate 3 / Gate 4：随 M0 工单接线 ----
gate('Gate 3 确定性单测', 'PENDING', 'TODO(T-M0-03 起)：核心包（persona-brain / model-gateway / game-bridge-mcp / live-stream-hub）分支覆盖率 ≥90% 后接线');
gate('Gate 4 沙盒 E2E', 'PENDING', 'TODO(T-M0-04 起)：tools/mock-harness 全链路回归（骂大肥鱼 → 喷水反驳 → 语音锁 → 账本落盘 ≤15s）接线');

// ---- 汇总 ----
console.log('');
for (const g of gates) {
  console.log(`${icon[g.status]}  ${g.name}`);
  for (const line of g.detail.split('\n')) console.log(`          ${line}`);
}
console.log('');

const failed = gates.filter((g) => g.status === 'FAIL');
const passed = gates.filter((g) => g.status === 'PASS').length;
const pending = gates.filter((g) => g.status === 'PENDING').length;

if (failed.length > 0) {
  console.log(`❌ verify:gate 未通过：${passed} 过 / ${failed.length} 败 / ${pending} 待接线（工单不得标记 DONE）`);
  process.exit(1);
}
console.log(`✅ verify:gate 通过：${passed} 过 / ${pending} 待接线（Gate 3/4 随 ROADMAP 工单逐步接入）`);
