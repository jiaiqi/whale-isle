/**
 * 卡死回归剧本（T-M6-68，RUNBOOK-M8-STARDEW §2.3）：Zod schema + 目录加载器。
 *
 * 一份剧本 = 一次真机卡死现场的最小可复现版本：
 *   - initialState：判定瞬间的 get_state 原文（时钟行是唯一会被回放服务改写的部分）
 *   - rules：工具 → BWF 回执（text / isError）+ 该动作推进的游戏分钟数
 *   - freezeUntilMutation：模拟 BWF「120 秒没有动作 → 自暂停」——时钟冻结到收到变更类工具为止
 *   - llmScript：LLM 相关卡死用「录制的决策输出」驱动假 chat()，吐完返回不可解析内容
 *   - expect：断言（轮数上限 / 同一失败签名次数 / 必须出现的动作 / 时钟是否推进）
 *
 * 与手册的差异（已在 ROADMAP T-M6-68 决策声明登记）：
 *   - 可选 `planner: 'rule' | 'llm' | 'idle'`：显式指定驱动规划器；省略时按是否有 `llmScript`
 *     推断（有 → llm，无 → rule）。S04（BWF 自暂停）需要「规划器一直 wait、只有 keepalive 能
 *     变更游戏」的现场，因此新增 `idle`。
 *   - `expect.mustCallWithArgs`：断言至少一次「某工具携带指定参数」被真实调用（如选择题必须带
 *     choice=0、牺牲预留鱼必须带 force），补足单看工具名抓不到的参数级回归。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const StuckScenarioReceiptSchema = z.object({
  text: z.string(),
  /** 省略视为 false（BWF 成功回执） */
  isError: z.boolean().default(false),
});

export const StuckScenarioRuleSchema = z.object({
  /** 精确工具名，或 `"*"` 兜底 */
  tool: z.string().min(1),
  receipt: StuckScenarioReceiptSchema,
  /** 该动作推进的游戏分钟数（默认 0；只影响时钟行，不影响背包/位置） */
  advanceMinutes: z.number().int().min(0).max(24 * 60).optional(),
});

export const StuckScenarioCallArgsSchema = z.object({
  tool: z.string().min(1),
  /** 子集匹配：调用参数必须包含这里列出的键值 */
  args: z.record(z.string(), z.unknown()),
});

export const StuckScenarioExpectSchema = z.object({
  /** AutodriveRunner 最大循环数 */
  maxCycles: z.number().int().min(1).max(1000),
  /** 任一工具（失败签名）最多可出现的失败次数 */
  maxSameFailure: z.number().int().min(0).max(1000),
  /** 至少出现其中一个动作（工具调用或规划器的 wait/stop 决策） */
  mustCallOneOf: z.array(z.string().min(1)).min(1).optional(),
  /** 结束时游戏时钟必须比开始时更晚 */
  clockMustAdvance: z.boolean().optional(),
  /** 至少一次「工具 + 参数子集」匹配的真实调用 */
  mustCallWithArgs: z.array(StuckScenarioCallArgsSchema).min(1).optional(),
});

export const StuckScenarioPlannerSchema = z.enum(['rule', 'llm', 'idle']);

export const StuckScenarioSchema = z
  .object({
    /** 形如 `S02-no-rod-fish-loop` */
    id: z.string().regex(/^S\d{2}-[a-z0-9-]+$/, 'id 必须形如 S02-no-rod-fish-loop'),
    /** 归一化失败签名（与 tools/soak-real 的 failureSignature 同格式：工具|原因模板|地点） */
    signature: z.string().min(1),
    /** 出处：真机日期 / VERIFY 条目 / 现场包路径 */
    source: z.string().min(1),
    initialState: z.string().min(1),
    rules: z.array(StuckScenarioRuleSchema).min(1),
    freezeUntilMutation: z.boolean().optional(),
    allowRuleStandin: z.boolean().optional(),
    llmScript: z.array(z.string()).min(1).optional(),
    planner: StuckScenarioPlannerSchema.optional(),
    expect: StuckScenarioExpectSchema,
  })
  .superRefine((value, ctx) => {
    if (value.planner === 'llm' && value.llmScript === undefined) {
      ctx.addIssue({ code: 'custom', path: ['llmScript'], message: "planner=llm 时必须提供 llmScript（录制的大脑输出）" });
    }
    if (value.planner === 'idle' && value.llmScript !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['llmScript'], message: 'planner=idle 时不应提供 llmScript' });
    }
  });

export type StuckScenario = z.infer<typeof StuckScenarioSchema>;
export type StuckScenarioRule = z.infer<typeof StuckScenarioRuleSchema>;
export type StuckScenarioExpect = z.infer<typeof StuckScenarioExpectSchema>;

/** 实际驱动规划器：显式字段优先，其次有 llmScript 视为 LLM 剧本 */
export function plannerModeOf(scenario: StuckScenario): 'rule' | 'llm' | 'idle' {
  return scenario.planner ?? (scenario.llmScript === undefined ? 'rule' : 'llm');
}

function issuesText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('；');
}

/**
 * 读取目录下全部 `*.json` 剧本，按 id 排序；任何一份不合法直接抛错（绝不静默跳过——
 * 少跑一个剧本等于少一道回归门禁）。
 */
export function loadScenarios(dir: string): StuckScenario[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`剧本目录为空：${dir}（至少要有 1 个 *.json）`);
  const seen = new Set<string>();
  const scenarios = files.map((file) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      throw new Error(`剧本 ${file} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = StuckScenarioSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`剧本 ${file} 不符合 schema：${issuesText(parsed.error)}`);
    if (seen.has(parsed.data.id)) throw new Error(`剧本 id 重复：${parsed.data.id}（${file}）`);
    seen.add(parsed.data.id);
    return parsed.data;
  });
  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}
