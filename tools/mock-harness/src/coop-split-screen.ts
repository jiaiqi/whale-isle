/**
 * [SIMULATION] 分屏 farmhand 沙盒剧本骨架（`V2-P2-09F`）。
 *
 * 它模拟的不是游戏本身，而是「未来 BWF 分屏感知补丁（`V2-P2-09D`）会提供的接口」：
 * 同机分屏下按屏上报的两类事件——
 *   ① 身体快照（`screenId` + `uniqueMultiplayerID` + 当前控制者）；
 *   ② 真人输入（某块屏上检测到物理手柄/键鼠）。
 *
 * 剧本用确定性事件流驱动宿主的「按身体接管 / 动作路由 / 在飞动作中止」判定，
 * 验证 host/farmhand 双租约互不抢占与 `ABORTED_BY_HUMAN_TAKEOVER` 回执的证据面。
 *
 * 【BLOCKED 声明】真实屏幕标识（`Context.ScreenId` → `uniqueMultiplayerID`）只能由
 * 打过补丁的 BWF 上报；本骨架的事件流是**手工编排的确定性数据**，不等于真机结论。
 * 在 `V2-P2-09D` 放行前，本骨架的任何通过都不得记为 `[REAL-DEVICE]`。
 */

/** 一个分屏实例（对应同进程里的一个 `Game1` 实例） */
export interface SplitScreenInstance {
  screenId: number;
  uniqueMultiplayerID: string;
  role: 'host' | 'farmhand';
}

/** 剧本事件：确定性编排，驱动宿主判定 */
export type SplitScreenEvent =
  | { kind: 'body_snapshot'; instance: SplitScreenInstance }
  | {
      kind: 'human_input';
      /**
       * 检测到物理输入的屏号。
       * `undefined` 模拟「BWF 还没上报身体标识」——此时判定必须**不接管**（诚实红线）。
       */
      screenId?: number;
      reason?: string;
    }
  | { kind: 'ai_action_begin'; screenId: number; actionId: string; tool: string }
  | { kind: 'ai_action_end'; actionId: string; status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' };

/** 剧本定义：两个实例 + 一串确定性事件 */
export interface SplitScreenScenario {
  scenarioId: string;
  title: string;
  instances: [SplitScreenInstance, SplitScreenInstance];
  events: SplitScreenEvent[];
}

/** 宿主侧的接线口：由调用方（spec / 后续 Gate 4 接线）把事件翻译成 CoopRuntimeV1 调用 */
export interface SplitScreenHarnessHandlers {
  bindBody(input: { instance: SplitScreenInstance; participantId: string }): void;
  beginAction(input: {
    participantId: string;
    uniqueMultiplayerID: string;
    tool: string;
    actionId: string;
  }): { ok: boolean; error?: string };
  finishAction(input: { actionId: string; status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' }): { ok: boolean; error?: string };
  humanInput(input: { uniqueMultiplayerID?: string; reason?: string }): unknown;
}

/** 按屏把事件流翻译成宿主调用；返回每个事件的处理结果，供断言 */
export function runSplitScreenScenario(
  scenario: SplitScreenScenario,
  participants: { host: string; farmhandAi: string },
  handlers: SplitScreenHarnessHandlers,
): unknown[] {
  const byScreen = new Map<number, SplitScreenInstance>(scenario.instances.map((i) => [i.screenId, i]));
  const results: unknown[] = [];
  for (const event of scenario.events) {
    if (event.kind === 'body_snapshot') {
      const participantId = event.instance.role === 'host' ? participants.host : participants.farmhandAi;
      handlers.bindBody({ instance: event.instance, participantId });
      results.push({ kind: 'bind', screenId: event.instance.screenId, participantId });
      continue;
    }
    if (event.kind === 'human_input') {
      const instance = event.screenId === undefined ? undefined : byScreen.get(event.screenId);
      results.push(handlers.humanInput({
        ...(instance !== undefined ? { uniqueMultiplayerID: instance.uniqueMultiplayerID } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      }));
      continue;
    }
    if (event.kind === 'ai_action_begin') {
      const instance = byScreen.get(event.screenId);
      if (instance === undefined) {
        results.push({ ok: false, error: `未知屏号 ${event.screenId}` });
        continue;
      }
      results.push(handlers.beginAction({
        participantId: participants.farmhandAi,
        uniqueMultiplayerID: instance.uniqueMultiplayerID,
        tool: event.tool,
        actionId: event.actionId,
      }));
      continue;
    }
    results.push(handlers.finishAction({ actionId: event.actionId, status: event.status }));
  }
  return results;
}

/** 骨架剧本集：先跑通判定分支；真实屏幕标识来源（`V2-P2-09D`）放行前不得当真机证据 */
export const SPLIT_SCREEN_SCENARIOS: readonly SplitScreenScenario[] = [
  {
    scenarioId: 'split-host-input-no-takeover',
    title: '人类在 host 屏操作：不夺走 farmhand 屏的 AI 租约',
    instances: [
      { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' },
      { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' },
    ],
    events: [
      { kind: 'body_snapshot', instance: { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' } },
      { kind: 'body_snapshot', instance: { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' } },
      { kind: 'ai_action_begin', screenId: 1, actionId: 'act-scn1', tool: 'water_crops_batch' },
      { kind: 'human_input', screenId: 0, reason: '主人动了键盘（host 屏）' },
      { kind: 'ai_action_end', actionId: 'act-scn1', status: 'COMPLETED' },
    ],
  },
  {
    scenarioId: 'split-farmhand-input-takeover-abort',
    title: '人类在 farmhand 屏一动：接管该屏 AI 并中止其在飞动作',
    instances: [
      { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' },
      { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' },
    ],
    events: [
      { kind: 'body_snapshot', instance: { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' } },
      { kind: 'body_snapshot', instance: { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' } },
      { kind: 'ai_action_begin', screenId: 1, actionId: 'act-scn2', tool: 'move_to_tile' },
      { kind: 'human_input', screenId: 1, reason: '主人按了手柄（farmhand 屏）' },
      { kind: 'ai_action_end', actionId: 'act-scn2', status: 'COMPLETED' },
    ],
  },
  {
    scenarioId: 'split-input-without-body-identity',
    title: '输入事件缺身体标识：不判定接管（诚实红线，宁可漏接管也不误抢）',
    instances: [
      { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' },
      { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' },
    ],
    events: [
      { kind: 'body_snapshot', instance: { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' } },
      { kind: 'body_snapshot', instance: { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' } },
      { kind: 'ai_action_begin', screenId: 1, actionId: 'act-scn3', tool: 'water_crops_batch' },
      { kind: 'human_input', reason: '检测到输入但 BWF 尚未上报屏号' },
      { kind: 'ai_action_end', actionId: 'act-scn3', status: 'COMPLETED' },
    ],
  },
] as const;
