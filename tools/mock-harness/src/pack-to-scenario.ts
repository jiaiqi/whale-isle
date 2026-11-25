#!/usr/bin/env -S tsx
/**
 * 现场包 → 回归剧本草稿（T-M6-68，RUNBOOK-M8-STARDEW §2.6 步骤 5）。
 *
 * 用法：
 *   pnpm tsx tools/mock-harness/src/pack-to-scenario.ts artifacts/soak/<run>/stuck/<id> [--out <file>]
 *
 * 读 T-M6-67 的现场包三件（verdict.json / last50.jsonl / state.txt），产出可直接被
 * `loadScenarios()` 读取的剧本草稿：
 *   - signature 复用 tools/soak-real 的 `failureSignature`（工具｜原因模板｜地点），与台账/报告同口径；
 *   - rules 由 last50.jsonl 里真实出现过的回执去重生成，外加 `"*"` 兜底；
 *   - expect 只是保守占位（maxCycles / maxSameFailure），**必须由人按现场补全**后再入库。
 *
 * 铁律：转换器不猜现场。缺 verdict/state 时如实报错或用占位说明，绝不编造回执。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { failureSignature } from '@workbench/soak-real/stuck-detector';
import { StuckScenarioSchema, type StuckScenario, type StuckScenarioRule } from './stuck-scenario';

export interface PackScenarioInput {
  /** 现场包目录（含 verdict.json / last50.jsonl / state.txt） */
  packDir: string;
  /** 覆盖剧本 id 的后缀（默认从 verdict.kind + 失败工具推导） */
  idHint?: string;
}

interface PackVerdict {
  kind?: string;
  signature?: string;
  detail?: string;
  location?: string;
  clock?: string | null;
  dayKey?: string | null;
  atIso?: string;
}

interface PackEvent {
  type?: string;
  tool?: string;
  status?: string;
  summary?: string;
}

const FAILED_STATUSES = new Set(['FAILED', 'ERROR', 'TIMEOUT', 'UNCERTAIN']);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** last50.jsonl 每行一个事件；坏行跳过（现场包可能被截断） */
export function readPackEvents(file: string): PackEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        // 只收对象事件（数组/标量是坏行，跳过）
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? [parsed as PackEvent] : [];
      } catch {
        return [];
      }
    });
}

/** 事件里的回执 → 去重后的剧本规则（同一工具只留第一条真实回执） */
export function rulesFromEvents(events: readonly PackEvent[]): StuckScenarioRule[] {
  const rules: StuckScenarioRule[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'receipt') continue;
    const tool = event.tool ?? '';
    const status = event.status ?? '';
    if (tool === '' || tool === 'autodrive' || status === '') continue;
    if (seen.has(tool)) continue;
    seen.add(tool);
    const isError = FAILED_STATUSES.has(status);
    rules.push({
      tool,
      receipt: { text: event.summary ?? `${status} ${tool}`, isError },
      advanceMinutes: isError ? 0 : 10,
    });
  }
  // 兜底规则放最后：未录到的工具按成功推进，避免草稿一跑就因缺规则爆红
  rules.push({ tool: '*', receipt: { text: '完成（现场包未录到该工具的回执，草稿兜底）', isError: false }, advanceMinutes: 10 });
  return rules;
}

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'stuck' : cleaned.slice(0, 40);
}

/**
 * 现场包 → 剧本草稿。expect 为占位值，调用方（人）必须补全。
 * 返回的对象已通过 StuckScenarioSchema 校验，可直接落盘给 `loadScenarios()`。
 */
export function packToScenario(input: PackScenarioInput): StuckScenario {
  const packDir = resolve(input.packDir);
  const verdictFile = join(packDir, 'verdict.json');
  if (!existsSync(verdictFile)) throw new Error(`现场包缺少 verdict.json：${packDir}`);
  const verdict = readJson<PackVerdict>(verdictFile);
  const stateFile = join(packDir, 'state.txt');
  const stateText = existsSync(stateFile)
    ? readFileSync(stateFile, 'utf8').trimEnd()
    : '(现场包缺少 state.txt：请从同目录截图/存档补一份 get_state 原文)';
  const events = readPackEvents(join(packDir, 'last50.jsonl'));
  const rules = rulesFromEvents(events);

  const failureEvent = events.find((event) => event.type === 'receipt' && FAILED_STATUSES.has(event.status ?? ''));
  const signature = verdict.signature
    ?? failureSignature(failureEvent?.tool ?? 'unknown', failureEvent?.summary ?? verdict.detail ?? '', verdict.location ?? '未知');
  const kind = verdict.kind ?? 'unknown';
  const toolSlug = slug(failureEvent?.tool ?? signature.split('|')[0] ?? 'unknown');
  const id = `S99-draft-${slug(kind)}-${toolSlug}${input.idHint === undefined ? '' : `-${slug(input.idHint)}`}`;

  const sourceParts = [`现场包 ${packDir}`];
  if (verdict.atIso !== undefined) sourceParts.push(`判定于 ${verdict.atIso}`);
  if (verdict.dayKey !== undefined && verdict.dayKey !== null) sourceParts.push(`游戏日 ${verdict.dayKey}`);
  if (verdict.detail !== undefined) sourceParts.push(verdict.detail);

  const draft = {
    id,
    signature,
    source: sourceParts.join('；'),
    initialState: stateText === '' ? '(空状态快照)' : stateText,
    rules,
    expect: {
      maxCycles: 40,
      maxSameFailure: 2,
      // 人工补全提示：按现场实际脱困动作填 mustCallOneOf / clockMustAdvance / mustCallWithArgs
    },
  };
  return StuckScenarioSchema.parse(draft);
}

const USAGE = `用法：pnpm tsx tools/mock-harness/src/pack-to-scenario.ts <现场包目录> [--out <文件>]

读 T-M6-67 现场包（verdict.json / last50.jsonl / state.txt），输出回归剧本草稿到 stdout
（或 --out 指定的文件）。expect 是占位值，必须人工补全后再放进 scenarios/stuck/。`;

/** CLI 入口（导出供单测直接驱动；真实运行见文件尾的 isDirectRun 守卫） */
export function main(argv: readonly string[]): number {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (positional.length === 0 || argv.includes('--help')) {
    console.log(USAGE);
    return positional.length === 0 && !argv.includes('--help') ? 2 : 0;
  }
  try {
    const scenario = packToScenario({ packDir: positional[0] ?? '' });
    const json = `${JSON.stringify(scenario, null, 2)}\n`;
    if (out !== undefined) {
      writeFileSync(out, json, 'utf8');
      console.log(`剧本草稿已写入 ${out}（expect 需人工补全）`);
    } else {
      console.log(json);
    }
    return 0;
  } catch (error) {
    console.error(`转换失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('pack-to-scenario.ts');
if (isDirectRun) process.exitCode = main(process.argv.slice(2));
