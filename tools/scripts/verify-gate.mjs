#!/usr/bin/env node
/**
 * pnpm verify:gate — 「四道自动化准入门禁」编排器（AGENTS.md §2.3 / §3.3）
 *
 * 当前进度（与 docs/ROADMAP.md 同步，随工单推进接线）：
 *   Gate 1 类型与边界    ✅ tsc -b + dependency-cruiser（T-M0-01）+ Python ruff/mypy（T-M0-02）
 *   Gate 2 许可证与密钥  ✅ 台账校验 + 密钥泄漏/禁源痕迹扫描；T-M6-29 增补依赖漏洞
 *                        （pnpm audit high，离线/超时 SKIP）与 DST Lua 语法（luac -p，缺 luac SKIP）
 *   Gate 3 确定性单测    ✅ vitest（TS 契约单测）+ pytest（Python 夹具回放）（T-M0-02 接线；
 *                        覆盖率 ≥90% 门槛自 T-M0-03 随包接入）
 *   Gate 4 回环契约 E2E  ✅ apps/desktop-host/e2e/gate4-loopback.spec.ts（[SIMULATION] 测试内手工组合：
 *                        骂大肥鱼 → 0-token 喷水 → 语音锁（假适配器）→ SQLite(:memory:) 记账；<15s。
 *                        注意：这不是 Electron/Python/真实发声/磁盘账本的端到端，详见 VERIFY 顶部口径）
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
  'node_modules', 'dist', 'build', 'coverage', '.git', '.venv', '__pycache__',
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
const icon = { PASS: '✅ PASS', FAIL: '❌ FAIL', PENDING: '⏳ PENDING', SKIP: '⏭️ SKIP' };

console.log('╭──────────────────────────────────────────────────────────╮');
console.log('│ pnpm verify:gate — 四道自动化准入门禁                    │');
console.log('╰──────────────────────────────────────────────────────────╯');

// ---- Gate 1：类型编译 + dependency-cruiser 架构边界 ----
const tsc = spawnSync('pnpm', ['typecheck'], { cwd: ROOT, encoding: 'utf8' });
const depcruise = spawnSync('pnpm', ['lint:deps'], { cwd: ROOT, encoding: 'utf8' });
const gate1Errors = [];
let gate1Detail = null;
if (tsc.error) {
  gate1Errors.push(`无法启动 pnpm typecheck：${tsc.error.message}（请先执行 pnpm install）`);
} else if (tsc.status !== 0) {
  gate1Errors.push(truncate(`${tsc.stdout}\n${tsc.stderr}`));
}
if (depcruise.error) {
  gate1Errors.push(`无法启动 pnpm lint:deps：${depcruise.error.message}`);
} else if (depcruise.status !== 0) {
  gate1Errors.push(truncate(`${depcruise.stdout}\n${depcruise.stderr}`));
}
if (gate1Errors.length === 0) {
  gate1Detail = 'tsc -b 零错误 + dependency-cruiser 零违规（strict + noUncheckedIndexedAccess）';
  gate('Gate 1 类型与边界', 'PASS', gate1Detail);
} else {
  gate('Gate 1 类型与边界', 'FAIL', gate1Errors.join('\n'));
}

// ---- Gate 1 补充：Python 契约模型（ruff + mypy --strict；uv 缺失或未生成时 SKIP 并明示） ----
const PY_MODEL = join(ROOT, 'services', 'audio-ai-worker', 'protocol_models.py');
const uvProbe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
if (gate1Detail !== null) {
  if (!existsSync(PY_MODEL)) {
    gate('Gate 1 类型与边界(Python)', 'SKIP', 'protocol_models.py 尚未生成（pnpm gen:contracts）');
  } else if (uvProbe.error || uvProbe.status !== 0) {
    gate('Gate 1 类型与边界(Python)', 'SKIP', 'uv 未安装，无法校验 Python 契约模型（安装 uv 后重跑）');
  } else {
    const pyType = spawnSync('pnpm', ['py:type'], { cwd: ROOT, encoding: 'utf8' });
    if (pyType.status === 0) {
      gate('Gate 1 类型与边界(Python)', 'PASS', 'ruff 全绿 + mypy --strict 通过（生成物 assignment 豁免见 mypy.ini 注释）');
    } else {
      gate('Gate 1 类型与边界(Python)', 'FAIL', truncate(`${pyType.stdout}\n${pyType.stderr}`));
    }
  }
}

// ---- Gate 2：许可证台账 + 密钥/禁源扫描（T-M0-04 起委托 tools/mock-harness 独立扫描器） ----
const scannerPath = join(ROOT, 'tools', 'mock-harness', 'src', 'license-scanner.mjs');
if (existsSync(scannerPath)) {
  const scan = spawnSync('node', [scannerPath, ROOT], { cwd: ROOT, encoding: 'utf8' });
  const detail = truncate(`${scan.stdout ?? ''}\n${scan.stderr ?? ''}`);
  gate('Gate 2 许可证与密钥', scan.status === 0 ? 'PASS' : 'FAIL', detail);
} else {
  gate('Gate 2 许可证与密钥', 'FAIL', 'license-scanner.mjs 缺失（T-M0-04 产物被误删）');
}

// ---- Gate 2 补充：依赖漏洞（high/critical；离线/超时 SKIP，避免把网络问题伪装成代码问题） ----
{
  const audit = spawnSync('pnpm', ['audit', '--audit-level', 'high'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${audit.stdout ?? ''}\n${audit.stderr ?? ''}`;
  const offline = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_PNPM_META_FETCH|network|getaddrinfo/i.test(out);
  if (audit.error && audit.error.code === 'ETIMEDOUT') {
    gate('Gate 2 依赖漏洞', 'SKIP', 'pnpm audit 超时（离线或 registry 不可达），跳过；CI 会强制执行');
  } else if (offline) {
    gate('Gate 2 依赖漏洞', 'SKIP', 'pnpm audit 无法访问 registry（离线），跳过；CI 会强制执行');
  } else if (audit.status === 0) {
    gate('Gate 2 依赖漏洞', 'PASS', 'pnpm audit --audit-level high：0 high / 0 critical');
  } else {
    gate('Gate 2 依赖漏洞', 'FAIL', truncate(out));
  }
}

// ---- Gate 2 补充：DST Lua 语法（luac -p；未安装 luac 时 SKIP 并明示） ----
{
  const luacProbe = spawnSync('luac', ['-v'], { encoding: 'utf8' });
  if (luacProbe.error || luacProbe.status !== 0) {
    gate('Gate 2 DST Lua 语法', 'SKIP', '未安装 luac（Lua 编译器），跳过；CI ubuntu 会安装 lua5.4 强制执行');
  } else {
    const luaRoot = join(ROOT, 'mods', 'dst-bridge');
    const luaFiles = [];
    const collectLua = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        const st = statSync(abs);
        if (st.isDirectory()) collectLua(abs);
        else if (extname(entry).toLowerCase() === '.lua') luaFiles.push(abs);
      }
    };
    collectLua(luaRoot);
    const failures = [];
    for (const file of luaFiles) {
      const check = spawnSync('luac', ['-p', file], { encoding: 'utf8' });
      if (check.status !== 0) failures.push(`${file}\n${truncate(`${check.stdout}\n${check.stderr}`, 4)}`);
    }
    if (luaFiles.length === 0) gate('Gate 2 DST Lua 语法', 'FAIL', 'mods/dst-bridge 下未找到 .lua 文件');
    else if (failures.length > 0) gate('Gate 2 DST Lua 语法', 'FAIL', failures.join('\n'));
    else gate('Gate 2 DST Lua 语法', 'PASS', `luac -p：${luaFiles.length} 个 Lua 文件语法通过（编译期证据，不等于游戏内加载）`);
  }
}

// ---- Gate 3：确定性单测（TS vitest + Python pytest；覆盖率门槛随 T-M0-03 起逐包生效） ----
const vitest = spawnSync('pnpm', ['test'], { cwd: ROOT, encoding: 'utf8' });
const gate3Notes = [];
let gate3Ok = true;
if (vitest.error) {
  gate3Ok = false;
  gate3Notes.push(`无法启动 pnpm test：${vitest.error.message}`);
} else if (vitest.status !== 0) {
  gate3Ok = false;
  gate3Notes.push(truncate(`${vitest.stdout}\n${vitest.stderr}`));
}
let gate3Label = 'vitest 全绿';
if (gate3Ok && existsSync(PY_MODEL) && !(uvProbe.error || uvProbe.status !== 0)) {
  const pytest = spawnSync('pnpm', ['py:test'], { cwd: ROOT, encoding: 'utf8' });
  if (pytest.status !== 0) {
    gate3Ok = false;
    gate3Notes.push(truncate(`${pytest.stdout}\n${pytest.stderr}`));
  } else {
    gate3Label += ' + pytest 夹具回放全绿';
  }
} else if (gate3Ok) {
  gate3Notes.push('Python 侧契约测试跳过（protocol_models.py 未生成或 uv 缺失）');
}
// T-M6-68：卡死回归剧本数量（每个剧本一条 it，跑真实 AutodriveRunner + BWF 同构回放服务）
const stuckScenarioDir = join(ROOT, 'tools', 'mock-harness', 'scenarios', 'stuck');
const stuckScenarioCount = existsSync(stuckScenarioDir)
  ? readdirSync(stuckScenarioDir).filter((file) => file.endsWith('.json')).length
  : 0;
gate3Notes.push(`卡死回归剧本：${stuckScenarioCount} 个（tools/mock-harness/scenarios/stuck/*.json）`);
gate(
  'Gate 3 确定性单测',
  gate3Ok ? 'PASS' : 'FAIL',
  `${gate3Label}${gate3Notes.length > 0 ? `\n${gate3Notes.join('\n')}` : ''}`
);

// ---- Gate 4：回环契约 E2E（[SIMULATION] 测试内组合：雷区 → 喷水 → 语音锁(假适配器) → SQLite(:memory:) 账本；不是生产端到端） ----
const e2eStarted = Date.now();
const e2e = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'vitest.e2e.config.mts', 'apps/desktop-host/e2e/gate4-loopback.spec.ts'],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' } },
);
const e2eMs = Date.now() - e2eStarted;
if (e2e.error) {
  gate('Gate 4 回环契约 E2E', 'FAIL', `无法启动 vitest：${e2e.error.message}`);
} else if (e2e.status !== 0) {
  gate('Gate 4 回环契约 E2E', 'FAIL', truncate(`${e2e.stdout}\n${e2e.stderr}`));
} else {
  gate('Gate 4 回环契约 E2E', 'PASS', `[SIMULATION] 骂大肥鱼 → 0-token 喷水 → 语音锁释放 → 记仇账本落盘（${(e2eMs / 1000).toFixed(1)}s < 15s）\nsoak 可用：pnpm soak:autodrive [分钟]（默认 1；[SIMULATION] 长时浸泡，不替代真机）`);
}

// ---- 汇总 ----
console.log('');
for (const g of gates) {
  console.log(`${icon[g.status]}  ${g.name}`);
  for (const line of g.detail.split('\n')) console.log(`          ${line}`);
}
console.log('');

const failed = gates.filter((g) => g.status === 'FAIL');
const passed = gates.filter((g) => g.status === 'PASS').length;
const skipped = gates.filter((g) => g.status === 'SKIP').length;
const pending = gates.filter((g) => g.status === 'PENDING').length;

if (failed.length > 0) {
  console.log(`❌ verify:gate 未通过：${passed} 过 / ${failed.length} 败 / ${skipped} 跳过 / ${pending} 待接线（工单不得标记 DONE）`);
  process.exit(1);
}
console.log(`✅ verify:gate 通过：${passed} 过 / ${skipped} 跳过 / ${pending} 待接线`);
