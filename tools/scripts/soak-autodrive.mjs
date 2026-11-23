#!/usr/bin/env node
/**
 * [SIMULATION] soak-autodrive —— 星露谷 MCP 仿真器长时浸泡（autodrive 节奏）。
 *
 * 用途：在 tools/mock-harness 的 stardew-simulator 上连续运行 N 分钟（默认 1），
 * 以 autodrive 的「get_state → 决策 → act → 回执」节奏压测，统计：
 *   · 事件数（轮询 / 决策 / 回执 / 看门狗）
 *   · 回执状态分布（COMPLETED / FAILED / UNCERTAIN / ABORTED_BY_HUMAN_TAKEOVER / ERROR）
 *   · get_state 失败率
 *   · 进程与内存增长趋势（RSS / heapUsed 线性斜率、峰值、CPU）
 *
 * 退出码：0 = 未超阈值；1 = 异常回执率或 get_state 失败率超阈值；2 = 参数/构建错误。
 *
 * 铁律（AGENTS.md §2.4）：本脚本只连接本地确定性仿真器，输出一律带 [SIMULATION]，
 * 不能替代 [REAL-DEVICE] 真机验收（真实星露谷 / 真实 SMAPI Mod / 真实直播间均未参与）。
 *
 * 用法：
 *   node tools/scripts/soak-autodrive.mjs [分钟] [选项]
 *   pnpm soak:autodrive 1
 *
 * 选项：
 *   --scenario=normal_farming|path_blocked|stamina_exhausted|player_takeover|mine_low_hp
 *   --step-ms=20            每轮动作后的间步延迟（默认 20ms；真机 autodrive 为 3s）
 *   --max-error-rate=0.02   异常回执率与 get_state 失败率的阈值（默认 2%）
 *   --json                  只输出一行 JSON（供 CI/日志采集；仍带 tag: "[SIMULATION]"）
 *   --quiet                 不打印进度行
 *   --help
 *
 * 说明：本脚本刻意不 import packages/game-bridge-mcp 的 AutodriveRunner——该包的 dist
 * 产物使用无扩展名相对导入，纯 Node ESM 无法直接加载；且 AutodriveRunner 走 BWF HTTP MCP，
 * 而仿真器是 WebSocket JSON-RPC。这里复用仿真器官方 createSimulatorClient（回执出站前过
 * Schema），按 autodrive 的循环语义驱动，确保脚本零新增依赖、node 直接可跑。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIM_DIST = join(ROOT, 'tools', 'mock-harness', 'dist', 'stardew-simulator.js');
const SIM_SRC = join(ROOT, 'tools', 'mock-harness', 'src');

const POLL_TIMEOUT_MS = 5_000;
const ACT_TIMEOUT_MS = 10_000;

const SCENARIOS = new Set([
  'normal_farming',
  'path_blocked',
  'stamina_exhausted',
  'player_takeover',
  'mine_low_hp',
]);

/** 各剧本「预期内」的非 COMPLETED 原因；其余非 COMPLETED 一律计为异常回执。 */
const EXPECTED_REASONS = {
  normal_farming: new Set(),
  path_blocked: new Set(['PATH_BLOCKED_BY_STONE', 'PATH_BLOCKED_PERSISTENT']),
  stamina_exhausted: new Set(['STAMINA_EXHAUSTED']),
  player_takeover: new Set(['PLAYER_PHYSICAL_INPUT_DETECTED']),
  mine_low_hp: new Set(['HEALTH_CRITICAL_WITHDRAW']),
};

const NORMAL_ROTATION = [
  { tool: 'move_to_tile', args: { x: 60, y: 19 } },
  { tool: 'water_crops_batch', args: {} },
  { tool: 'use_tool_on_tile', args: { x: 60, y: 19, tool: 'hoe' } },
  { tool: 'check_trash_can', args: {} },
  { tool: 'interact_with_npc', args: { npc: 'Abigail' } },
];

function usage() {
  console.log(`[SIMULATION] soak-autodrive —— 星露谷仿真器长时浸泡（不替代真机）

用法：node tools/scripts/soak-autodrive.mjs [分钟] [选项]

  [分钟]                  默认 1；支持小数（如 0.2 = 12 秒）
  --scenario=<id>         默认 normal_farming；可选 ${[...SCENARIOS].join(' / ')}
  --step-ms=<ms>          每轮间步延迟，默认 20（真机 autodrive 为 3000）
  --max-error-rate=<0-1>  异常回执率 / get_state 失败率阈值，默认 0.02
  --json                  只输出一行 JSON（tag 仍为 [SIMULATION]）
  --quiet                 不打印进度行
  --help                  打印本帮助
`);
}

function fail(message, code = 2) {
  console.error(`[SIMULATION] soak-autodrive 错误：${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    minutes: 1,
    scenario: 'normal_farming',
    stepMs: 20,
    maxErrorRate: 0.02,
    json: false,
    quiet: false,
  };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--quiet') {
      opts.quiet = true;
      continue;
    }
    if (arg.startsWith('--scenario=')) {
      opts.scenario = arg.slice('--scenario='.length);
      continue;
    }
    if (arg.startsWith('--step-ms=')) {
      opts.stepMs = Number(arg.slice('--step-ms='.length));
      continue;
    }
    if (arg.startsWith('--max-error-rate=')) {
      opts.maxErrorRate = Number(arg.slice('--max-error-rate='.length));
      continue;
    }
    if (/^(?:\d+\.?\d*|\.\d+)$/.test(arg)) {
      positional.push(arg);
      continue;
    }
    fail(`无法识别的参数 ${arg}（--help 查看用法）`);
  }
  if (positional.length > 1) fail(`最多只接受一个「分钟」位置参数，收到：${positional.join(', ')}`);
  if (positional.length === 1) opts.minutes = Number(positional[0]);
  if (!Number.isFinite(opts.minutes) || opts.minutes <= 0 || opts.minutes > 24 * 60) {
    fail(`分钟数必须是 (0, 1440] 内的数字，收到：${positional[0] ?? opts.minutes}`);
  }
  if (!SCENARIOS.has(opts.scenario)) {
    fail(`未知剧本 ${opts.scenario}；可选：${[...SCENARIOS].join(', ')}`);
  }
  if (!Number.isFinite(opts.stepMs) || opts.stepMs < 0 || opts.stepMs > 60_000) {
    fail(`--step-ms 必须是 [0, 60000] 内的数字，收到：${opts.stepMs}`);
  }
  if (!Number.isFinite(opts.maxErrorRate) || opts.maxErrorRate < 0 || opts.maxErrorRate > 1) {
    fail(`--max-error-rate 必须是 [0, 1] 内的数字，收到：${opts.maxErrorRate}`);
  }
  return opts;
}

function newestMtimeMs(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(abs));
    else newest = Math.max(newest, statSync(abs).mtimeMs);
  }
  return newest;
}

/** dist 缺失或落后于 src 时自动构建 mock-harness（含其 workspace 依赖）。 */
function ensureSimulatorBuilt() {
  const distDir = dirname(SIM_DIST);
  const stale = !existsSync(SIM_DIST)
    || (existsSync(SIM_SRC) && existsSync(distDir) && newestMtimeMs(SIM_SRC) > newestMtimeMs(distDir));
  if (!stale) return;
  console.log('[SIMULATION] dist 缺失或过期，先构建 @workbench/mock-harness…');
  const result = spawnSync(
    'pnpm',
    ['--filter', '@workbench/mock-harness...', 'build'],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.error || result.status !== 0) {
    fail(`构建 mock-harness 失败（${result.error?.message ?? `退出码 ${result.status}`}）；请先 pnpm install`, 2);
  }
  if (!existsSync(SIM_DIST)) fail(`构建后仍未找到 ${SIM_DIST}，请检查 tsconfig`, 2);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sampleMemory(atMs) {
  const usage = process.memoryUsage();
  return { atMs, rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external };
}

function mb(bytes) {
  return bytes / (1024 * 1024);
}

function linearSlopeMbPerMin(samples, key) {
  if (samples.length < 2) return 0;
  const xs = samples.map((sample) => sample.atMs / 60_000);
  const ys = samples.map((sample) => mb(sample[key]));
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index] - meanX;
    numerator += dx * (ys[index] - meanY);
    denominator += dx * dx;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function chooseAction(scenario, simulator, state, tick) {
  const stamina = Number(state.staminaCurrent ?? 0);
  const health = Number(state.healthCurrent ?? 100);

  // ④ 玩家物理接管：周期性拉起/放下，验证 ABORTED_BY_HUMAN_TAKEOVER 通道
  if (scenario === 'player_takeover') {
    if (tick % 12 === 0) {
      simulator.setPhysicalInput(true);
      return { tool: 'water_crops_batch', args: {} };
    }
    simulator.setPhysicalInput(false);
  }

  // ⑤ 矿洞丝血：先撞一次撤退规则（预期 FAILED），随后进食回血
  if (scenario === 'mine_low_hp' && health < 30) {
    if (tick % 6 === 0) return { tool: 'use_tool_on_tile', args: { x: 60, y: 19, tool: 'pickaxe' } };
    return { tool: 'eat_food_for_stamina', args: {} };
  }

  // ③ 体力耗尽：周期性撞 STAMINA_EXHAUSTED，其余轮次进食恢复
  if (scenario === 'stamina_exhausted' && stamina <= 0) {
    if (tick % 6 === 0) return { tool: 'water_crops_batch', args: {} };
    return { tool: 'eat_food_for_stamina', args: {} };
  }

  // ② 寻路卡石头：3 次撞墙（UNCERTAIN ×2 → FAILED）+ 1 次正常动作
  if (scenario === 'path_blocked') {
    if (stamina < 30) return { tool: 'eat_food_for_stamina', args: {} };
    if (tick % 4 === 3) return { tool: 'check_trash_can', args: {} };
    return { tool: 'move_to_tile', args: { x: 64, y: 15 } };
  }

  // ① 正常农活节奏：体力低先吃，定期过夜验证跨日重置
  if (state.timeOfDay >= 2200 || (tick > 0 && tick % 240 === 0)) {
    return { tool: 'go_to_sleep', args: {} };
  }
  if (stamina < 40) return { tool: 'eat_food_for_stamina', args: {} };
  return NORMAL_ROTATION[tick % NORMAL_ROTATION.length];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.json ? () => {} : (...args) => console.log('[SIMULATION]', ...args);
  const durationMs = Math.round(opts.minutes * 60_000);

  ensureSimulatorBuilt();
  const { StardewMcpSimulator, createSimulatorClient } = await import(pathToFileURL(SIM_DIST).href);

  const simulator = new StardewMcpSimulator(opts.scenario, { actionDelayMs: 5 });
  const url = await simulator.start();
  const client = createSimulatorClient(url);

  const stats = {
    cycles: 0,
    statePolls: 0,
    stateFailures: 0,
    decisions: 0,
    actions: 0,
    receipts: 0,
    watchdogEvents: 0,
    transportErrors: 0,
    unexpectedReceipts: 0,
    statusCounts: Object.create(null),
    reasonCounts: Object.create(null),
    lastError: null,
  };
  const samples = [sampleMemory(0)];
  const expectedReasons = EXPECTED_REASONS[opts.scenario];
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  let nextMemorySampleAt = 1_000;
  let nextProgressAt = 5_000;
  let interrupted = false;

  const onSigint = () => {
    interrupted = true;
    log('收到 SIGINT，收尾当前回合后退出…');
  };
  process.on('SIGINT', onSigint);

  log(`场景=${opts.scenario} 计划=${opts.minutes} 分钟 步间=${opts.stepMs}ms 阈值=${pct(opts.maxErrorRate)}`);
  log('只连接本地确定性仿真器；真实游戏/真实直播间/真实密钥均未参与，不能替代 [REAL-DEVICE]。');

  try {
    while (!interrupted && Date.now() < deadline) {
      stats.cycles++;
      const tick = stats.cycles - 1;

      // 1) get_state（状态唯一事实源）
      stats.statePolls++;
      let state = null;
      try {
        const response = await withTimeout(
          client.raw({ method: 'stardew/state' }),
          POLL_TIMEOUT_MS,
          'get_state',
        );
        const result = response?.result;
        if (response?.error) throw new Error(`JSON-RPC error: ${JSON.stringify(response.error)}`);
        if (!result || typeof result !== 'object'
          || typeof result.staminaCurrent !== 'number'
          || typeof result.timeOfDay !== 'number'
          || typeof result.locationName !== 'string') {
          throw new Error('get_state 回包缺少必要字段（契约漂移？）');
        }
        state = result;
      } catch (error) {
        stats.stateFailures++;
        stats.watchdogEvents++;
        stats.lastError = `get_state: ${error instanceof Error ? error.message : String(error)}`;
        await sleep(Math.max(10, opts.stepMs));
        continue;
      }

      // 2) 决策
      const decision = chooseAction(opts.scenario, simulator, state, tick);
      if (!decision) {
        stats.watchdogEvents++;
        await sleep(Math.max(10, opts.stepMs));
        continue;
      }
      stats.decisions++;

      // 3) 执行 + 回执
      stats.actions++;
      try {
        const receipt = await withTimeout(
          client.act(decision.tool, decision.args),
          ACT_TIMEOUT_MS,
          decision.tool,
        );
        stats.receipts++;
        stats.statusCounts[receipt.status] = (stats.statusCounts[receipt.status] ?? 0) + 1;
        if (receipt.status !== 'COMPLETED') {
          const reason = receipt.failureOrUncertainReason ?? '(no reason)';
          stats.reasonCounts[reason] = (stats.reasonCounts[reason] ?? 0) + 1;
          if (!expectedReasons.has(receipt.failureOrUncertainReason)) {
            stats.unexpectedReceipts++;
            stats.lastError = `${decision.tool} → ${receipt.status} ${reason}`;
          }
        }
      } catch (error) {
        stats.receipts++;
        stats.transportErrors++;
        stats.unexpectedReceipts++;
        stats.statusCounts.ERROR = (stats.statusCounts.ERROR ?? 0) + 1;
        stats.lastError = `${decision.tool}: ${error instanceof Error ? error.message : String(error)}`;
      }

      // 4) 间步延迟（模拟 autodrive 的 stepDelay）
      if (opts.stepMs > 0) await sleep(opts.stepMs);

      // 5) 周期采样（内存增长趋势）
      const now = Date.now();
      if (now - startedAt >= nextMemorySampleAt) {
        samples.push(sampleMemory(now - startedAt));
        nextMemorySampleAt = now - startedAt + 1_000;
      }
      if (!opts.quiet && now - startedAt >= nextProgressAt) {
        log(`进度 ${((now - startedAt) / 1000).toFixed(0)}s/${(durationMs / 1000).toFixed(0)}s：`
          + `轮询 ${stats.statePolls}（失败 ${stats.stateFailures}）· 动作 ${stats.actions} · 回执 ${stats.receipts}`);
        nextProgressAt += 5_000;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    client.close();
    simulator.close();
  }

  // 收尾补一次采样（长间隔动作后也能反映最新水位）
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= nextMemorySampleAt - 1_000) samples.push(sampleMemory(elapsedMs));

  const receiptErrorRate = stats.receipts > 0 ? stats.unexpectedReceipts / stats.receipts : 1;
  const getStateErrorRate = stats.statePolls > 0 ? stats.stateFailures / stats.statePolls : 1;
  const pass = stats.receipts > 0
    && receiptErrorRate <= opts.maxErrorRate
    && getStateErrorRate <= opts.maxErrorRate;
  const exitCode = interrupted ? 130 : pass ? 0 : 1;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const peakRss = Math.max(...samples.map((sample) => sample.rss));
  // 斜率剔除前 2s 冷启动（V8 预热/模块初始化会让短跑斜率虚高）；样本不足时退回全量
  const stableSamples = samples.filter((sample) => sample.atMs >= 2_000);
  const trendSamples = stableSamples.length >= 2 ? stableSamples : samples;
  // 少于 3 个稳定采样（约 5s 以内）时斜率没有统计意义，输出 null 而不是报一个虚高值
  const slopeAvailable = trendSamples.length >= 3 && elapsedMs >= 5_000;
  const rssSlope = slopeAvailable ? linearSlopeMbPerMin(trendSamples, 'rss') : null;
  const heapSlope = slopeAvailable ? linearSlopeMbPerMin(trendSamples, 'heapUsed') : null;
  const resource = process.resourceUsage();
  const cpuMs = (resource.userCPUTime + resource.systemCPUTime) / 1_000;
  const statusLines = Object.entries(stats.statusCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([status, count]) => `${status} ${count}（${pct(count / Math.max(1, stats.receipts))}）`);
  const reasonLines = Object.entries(stats.reasonCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => `${reason} ${count}`);

  const summary = {
    tag: '[SIMULATION]',
    mode: 'soak-autodrive',
    note: '本地确定性仿真器，不替代 [REAL-DEVICE] 真机验收',
    scenario: opts.scenario,
    requestedMinutes: opts.minutes,
    elapsedMs,
    cycles: stats.cycles,
    events: {
      total: stats.statePolls + stats.decisions + stats.receipts + stats.watchdogEvents,
      statePolls: stats.statePolls,
      decisions: stats.decisions,
      actions: stats.actions,
      receipts: stats.receipts,
      watchdog: stats.watchdogEvents,
    },
    getState: {
      requests: stats.statePolls,
      failures: stats.stateFailures,
      failureRate: Number(getStateErrorRate.toFixed(4)),
    },
    receipts: {
      total: stats.receipts,
      unexpected: stats.unexpectedReceipts,
      unexpectedRate: Number(receiptErrorRate.toFixed(4)),
      transportErrors: stats.transportErrors,
      statusCounts: stats.statusCounts,
      reasonCounts: stats.reasonCounts,
    },
    memory: {
      samples: samples.length,
      startRssMb: Number(mb(first.rss).toFixed(2)),
      endRssMb: Number(mb(last.rss).toFixed(2)),
      deltaRssMb: Number(mb(last.rss - first.rss).toFixed(2)),
      peakRssMb: Number(mb(peakRss).toFixed(2)),
      rssSlopeMbPerMin: rssSlope === null ? null : Number(rssSlope.toFixed(2)),
      heapUsedSlopeMbPerMin: heapSlope === null ? null : Number(heapSlope.toFixed(2)),
      slopeWindowSamples: trendSamples.length,
      maxRssMb: Number((resource.maxRSS / 1024).toFixed(2)),
    },
    process: {
      pid: process.pid,
      cpuMs: Number(cpuMs.toFixed(0)),
      avgCpuPercent: Number(((cpuMs / Math.max(1, elapsedMs)) * 100).toFixed(2)),
      node: process.version,
    },
    thresholds: { maxErrorRate: opts.maxErrorRate },
    lastError: stats.lastError,
    interrupted,
    pass,
    exitCode,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log('');
    log(`结果：${pass ? 'PASS' : 'FAIL'}（${(elapsedMs / 1000).toFixed(1)}s，${stats.cycles} 轮）`);
    log(`事件 ${summary.events.total} = 轮询 ${stats.statePolls} + 决策 ${stats.decisions}`
      + ` + 回执 ${stats.receipts} + 看门狗 ${stats.watchdogEvents}`);
    log(`get_state 失败率：${pct(getStateErrorRate)}（${stats.stateFailures}/${stats.statePolls}）`);
    log(`回执状态：${statusLines.length > 0 ? statusLines.join(' · ') : '（无）'}`);
    if (reasonLines.length > 0) log(`非 COMPLETED 原因：${reasonLines.join(' · ')}`);
    log(`异常回执率（已排除剧本预期原因）：${pct(receiptErrorRate)}（${stats.unexpectedReceipts}/${stats.receipts}，阈值 ${pct(opts.maxErrorRate)}）`);
    const rssSlopeText = rssSlope === null
      ? '斜率样本不足（<5s）'
      : `斜率 ${rssSlope.toFixed(2)}MB/min，已剔除前 2s 冷启动`;
    log(`RSS：起始 ${mb(first.rss).toFixed(1)}MB → 结束 ${mb(last.rss).toFixed(1)}MB`
      + `（Δ ${mb(last.rss - first.rss).toFixed(1)}MB，峰值 ${mb(peakRss).toFixed(1)}MB，${rssSlopeText}）`);
    log(`HeapUsed 斜率：${heapSlope === null ? '样本不足' : `${heapSlope.toFixed(2)}MB/min`} · `
      + `CPU 平均 ${summary.process.avgCpuPercent}% · 采样 ${samples.length} 次`);
    if (stats.lastError) log(`最后异常：${stats.lastError}`);
    log('提醒：本结果来自 [SIMULATION] 本地仿真器，不能替代真实星露谷/真实直播间的 [REAL-DEVICE] 验收。');
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`[SIMULATION] soak-autodrive 未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(2);
});
