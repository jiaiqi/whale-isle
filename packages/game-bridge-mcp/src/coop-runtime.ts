/**
 * Whale Isle V2 — 人机/多 AI 星露谷联机协作运行时（CoopRuntime v1 / REQ-GAME-04）
 *
 * 核心约束（Blueprint 07 §§7–8）：
 *   1. 每个成员拥有独立 `GameCharacterControlLease`，人类玩家接管自己角色不破坏 AI 控制各自角色，
 *      P0 急停一键锁死所有 AI 成员；
 *   2. Task Board 严格以游戏真实回执（COMPLETED | FAILED | UNCERTAIN）驱动结束与锁释放，
 *      UNCERTAIN 转 blocked 而非伪造完成；
 *   3. 重要资源预留（keep / sell_forbidden / reserve / harvest）：禁止 AI 卖掉人类计划保留的作物或争抢已被占用区域；
 *   4. 多人 Mod 兼容性预检：检测 BWF 就绪度、`WhaleIsle.AvatarSync` 外观可见性差异、版本与启停冲突；
 *   5. 断线宽限期保活与超时防死锁恢复：断线暂停 AI 保留锁，超时转 offline 自动释放全部资源锁并阻断在途任务。
 */
import { randomUUID } from 'node:crypto';
import {
  CoopModCompatibilityReportSchema,
  CoopModSummarySchema,
  CoopParticipantSchema,
  CoopResourceReservationSchema,
  CoopRuntimeSnapshotSchema,
  CoopTaskItemSchema,
  StardewScreenBindingSchema,
  CoopInFlightActionSchema,
  CoopTakeoverAbortReceiptSchema,
  type CoopModCompatibilityReport,
  type CoopModMismatch,
  type CoopModSummary,
  type CoopParticipant,
  type CoopResourceIntent,
  type CoopResourceReservation,
  type CoopRoomStatus,
  type CoopRuntimeSnapshot,
  type CoopTaskItem,
  type CoopBodyLeaseView,
  type CoopInFlightAction,
  type CoopTakeoverAbortReceipt,
  type StardewScreenBinding,
} from '@workbench/shared-protocol';
import { GameCharacterControlLease } from './control-lease';
import { TeamBlackboard } from './team-blackboard';

const LOCAL_ONLY_MOD_IDS = new Set(['SMAPI.ConsoleCommands', 'SMAPI.SaveBackup']);
const BWF_RE = /blind.?whale|bwf/i;
const AVATAR_SYNC_ID = 'WhaleIsle.AvatarSync';

/** 评估主机与联机对端 Mod 目录兼容性 */
export function evaluateCoopModsCompatibility(input: {
  hostMods: readonly CoopModSummary[];
  peerMods: readonly CoopModSummary[];
  hostModsDir?: string;
  peerModsDir?: string;
}): CoopModCompatibilityReport {
  const hostMods = input.hostMods.map((m) => CoopModSummarySchema.parse(m));
  const peerMods = input.peerMods.map((m) => CoopModSummarySchema.parse(m));

  const peerBwf = peerMods.find((m) => BWF_RE.test(`${m.uniqueId} ${m.name}`));
  const hostAvatar = hostMods.find((m) => m.uniqueId === AVATAR_SYNC_ID);
  const peerAvatar = peerMods.find((m) => m.uniqueId === AVATAR_SYNC_ID);

  const bwfReady = Boolean(peerBwf?.enabled);
  const avatarSyncReady = Boolean(hostAvatar?.enabled && peerAvatar?.enabled);

  const mismatches: CoopModMismatch[] = [];
  const warnings: string[] = [];

  if (!bwfReady) {
    mismatches.push({
      uniqueId: peerBwf?.uniqueId ?? 'WhaleIsle.BlindWhaleFarmer',
      name: peerBwf?.name ?? 'BlindWhaleFarmer',
      kind: peerBwf ? 'disabled_mismatch' : 'missing_on_peer',
      ...(peerBwf ? { peerVersion: peerBwf.version } : {}),
      blocking: true,
      detail: peerBwf ? 'AI 端 BlindWhaleFarmer Mod 已禁用，无法执行控制动作' : 'AI 端缺少 BlindWhaleFarmer MCP Mod',
    });
  }

  if (!avatarSyncReady) {
    warnings.push('主机与 AI 端未同时启用 WhaleIsle.AvatarSync：未安装同款外观 Mod 的客户端将看不到自定义像素形象');
  }

  const hostMap = new Map(hostMods.map((m) => [m.uniqueId, m]));
  const peerMap = new Map(peerMods.map((m) => [m.uniqueId, m]));

  for (const [id, hostMod] of hostMap) {
    if (LOCAL_ONLY_MOD_IDS.has(id) || BWF_RE.test(`${id} ${hostMod.name}`) || id === AVATAR_SYNC_ID) continue;
    const peerMod = peerMap.get(id);
    if (!peerMod) {
      mismatches.push({
        uniqueId: id,
        name: hostMod.name,
        kind: 'missing_on_peer',
        hostVersion: hostMod.version,
        blocking: hostMod.enabled,
        detail: `AI 端缺少主机 Mod：${hostMod.name} (${hostMod.version})`,
      });
      continue;
    }
    if (hostMod.version !== peerMod.version) {
      mismatches.push({
        uniqueId: id,
        name: hostMod.name,
        kind: 'version_mismatch',
        hostVersion: hostMod.version,
        peerVersion: peerMod.version,
        blocking: hostMod.enabled || peerMod.enabled,
        detail: `${hostMod.name} 版本不一致（主机 ${hostMod.version} vs AI 端 ${peerMod.version}）`,
      });
    } else if (hostMod.enabled !== peerMod.enabled) {
      mismatches.push({
        uniqueId: id,
        name: hostMod.name,
        kind: 'disabled_mismatch',
        hostVersion: hostMod.version,
        peerVersion: peerMod.version,
        blocking: true,
        detail: `${hostMod.name} 启停状态不一致（主机=${hostMod.enabled}, AI=${peerMod.enabled}）`,
      });
    }
  }

  for (const [id, peerMod] of peerMap) {
    if (LOCAL_ONLY_MOD_IDS.has(id) || BWF_RE.test(`${id} ${peerMod.name}`) || id === AVATAR_SYNC_ID) continue;
    if (!hostMap.has(id)) {
      mismatches.push({
        uniqueId: id,
        name: peerMod.name,
        kind: 'missing_on_host',
        peerVersion: peerMod.version,
        blocking: peerMod.enabled,
        detail: `主机缺少 AI 端 Mod：${peerMod.name} (${peerMod.version})`,
      });
    }
  }

  const hasBlocking = mismatches.some((m) => m.blocking);
  return CoopModCompatibilityReportSchema.parse({
    compatible: mismatches.length === 0,
    canStartCoop: bwfReady && !hasBlocking,
    ...(input.hostModsDir ? { hostModsDir: input.hostModsDir } : {}),
    ...(input.peerModsDir ? { peerModsDir: input.peerModsDir } : {}),
    hostModCount: hostMods.length,
    peerModCount: peerMods.length,
    bwfReady,
    avatarSyncReady,
    mismatches,
    warnings,
  });
}

export interface CoopRuntimeV1Options {
  now?: () => number;
  heartbeatTimeoutMs?: number;
  gracePeriodMs?: number;
  blackboard?: TeamBlackboard;
}

export class CoopRuntimeV1 {
  private readonly now: () => number;
  private readonly heartbeatTimeoutMs: number;
  private readonly gracePeriodMs: number;
  readonly blackboard: TeamBlackboard;

  private roomId = 'coop-room-default';
  private gameId: CoopRuntimeSnapshot['gameId'] = 'stardew';
  private status: CoopRoomStatus = 'idle';
  private epoch = 1;
  private sharedGoal = '未设置联机共同目标';
  private updatedAt: number;
  private lastCompatReport: CoopModCompatibilityReport | null = null;

  private readonly participants = new Map<string, CoopParticipant>();
  private readonly leases = new Map<string, GameCharacterControlLease>();
  private readonly tasks = new Map<string, CoopTaskItem>();
  private readonly reservations = new Map<string, CoopResourceReservation>();
  /** 各身体上正在执行的动作（`V2-P2-09E`），按 actionId 索引 */
  private readonly inFlightActions = new Map<string, CoopInFlightAction>();

  constructor(options: CoopRuntimeV1Options = {}) {
    this.now = options.now ?? Date.now;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
    this.gracePeriodMs = options.gracePeriodMs ?? 60_000;
    this.blackboard = options.blackboard ?? new TeamBlackboard({ now: this.now });
    this.updatedAt = this.now();
  }

  private purgeExpiredReservations(): void {
    const ts = this.now();
    for (const [key, res] of this.reservations) {
      if (ts >= res.expiresAt) {
        this.reservations.delete(key);
      }
    }
  }

  private syncRoomActiveIfReady(): void {
    const list = [...this.participants.values()];
    const hasHuman = list.some((p) => p.kind === 'human' && p.connectionState === 'connected');
    const hasAi = list.some((p) => p.kind === 'ai' && p.connectionState === 'connected');
    if (this.status === 'preparing' && hasHuman && hasAi) {
      this.status = 'active';
    }
  }

  /** 创建或重置联机协作房间 */
  createRoom(input: {
    roomId?: string;
    gameId?: CoopRuntimeSnapshot['gameId'];
    sharedGoal: string;
  }): CoopRuntimeSnapshot {
    this.roomId = input.roomId?.trim() || `coop-${randomUUID().slice(0, 8)}`;
    this.gameId = input.gameId ?? 'stardew';
    this.sharedGoal = input.sharedGoal.trim() || '共同经营农场';
    this.status = 'preparing';
    this.epoch += 1;
    this.participants.clear();
    this.leases.clear();
    this.tasks.clear();
    this.reservations.clear();
    this.inFlightActions.clear();
    this.updatedAt = this.now();    this.blackboard.setGoal({
      id: this.roomId,
      title: this.sharedGoal,
      gameId: this.gameId,
      metrics: [],
      deadline: '',
      status: 'active',
    });
    return this.snapshot();
  }

  /** 成员加入联机房间并分配独立角色控制租约 */
  joinParticipant(input: {
    participantId: string;
    kind: 'human' | 'ai';
    characterId: string;
    displayName: string;
    endpointId?: string;
    mcpPort?: number;
    /**
     * 该成员对应的游戏内身体绑定（`V2-P2-09C`）。
     *
     * 省略时 `bodyBinding` 为 `null`：**未绑定身体的成员不得接收任何控制动作**。
     * 绑定冲突（同屏或同一 `uniqueMultiplayerID` 被两个成员占用）会直接抛错，
     * 宁可拒绝加入也不允许出现「两个 AI 抢一个身体」的状态。
     */
    bodyBinding?: StardewScreenBinding;
  }): CoopParticipant {
    if (this.status === 'idle') {
      this.status = 'preparing';
    }
    const ts = this.now();
    let bodyBinding: StardewScreenBinding | null = null;
    if (input.bodyBinding !== undefined) {
      bodyBinding = this.assertBodyBindingAvailable(input.participantId, input.bodyBinding);
    }
    const lease = new GameCharacterControlLease({
      characterId: input.characterId,
      gameId: this.gameId,
      sessionId: `${this.roomId}:${input.participantId}:e${this.epoch}`,
      generation: 1,
      now: this.now,
    });
    if (input.kind === 'human') {
      lease.takeOverByHuman('人类玩家独立操作角色');
    }
    this.leases.set(input.participantId, lease);

    const participant = CoopParticipantSchema.parse({
      participantId: input.participantId,
      kind: input.kind,
      characterId: input.characterId,
      displayName: input.displayName,
      endpointId: input.endpointId ?? input.participantId,
      ...(input.mcpPort !== undefined ? { mcpPort: input.mcpPort } : {}),
      controlOwner: lease.owner,
      connectionState: 'connected',
      lastHeartbeatAt: ts,
      reconnectDeadlineAt: null,
      reconnectAttempts: 0,
      bodyBinding,
    });
    this.participants.set(participant.participantId, participant);
    this.blackboard.upsertAssignment({
      agentId: participant.participantId,
      displayName: participant.displayName,
      role: participant.kind,
      task: participant.kind === 'human' ? '人类玩家自由协同' : '等待任务板分工',
      zone: '',
      status: 'idle',
      progressNote: '已加入联机房间',
      updatedAt: ts,
    });
    this.syncRoomActiveIfReady();
    this.updatedAt = ts;
    return participant;
  }

  /**
   * 校验身体绑定是否可用（不修改状态）。
   *
   * 冲突一律抛错而不是静默改写：
   * - 同一 `uniqueMultiplayerID` 已被别的成员绑定 → 拒绝（防两个 AI 抢一个身体）；
   * - 同一 `screenId` 已被别的成员绑定 → 拒绝（防同屏两个 AI）。
   */
  private assertBodyBindingAvailable(
    participantId: string,
    binding: StardewScreenBinding,
  ): StardewScreenBinding {
    const parsed = StardewScreenBindingSchema.parse(binding);
    const conflictByBody = [...this.participants.values()].find((p) =>
      p.participantId !== participantId
      && p.bodyBinding?.uniqueMultiplayerID === parsed.uniqueMultiplayerID);
    if (conflictByBody !== undefined) {
      throw new Error(
        `身体 ${parsed.uniqueMultiplayerID} 已被成员 ${conflictByBody.participantId} 绑定，不能重复绑定`,
      );
    }
    const conflictByScreen = [...this.participants.values()].find((p) =>
      p.participantId !== participantId
      && p.bodyBinding?.screenId === parsed.screenId);
    if (conflictByScreen !== undefined) {
      throw new Error(
        `屏幕 ${parsed.screenId} 已被成员 ${conflictByScreen.participantId} 绑定，不能重复绑定`,
      );
    }
    return parsed;
  }

  /**
   * 绑定/改绑游戏内身体（`V2-P2-09C`）。
   *
   * 冲突一律抛错而不是静默改写（见 `assertBodyBindingAvailable`）。
   */
  claimBodyBinding(participantId: string, binding: StardewScreenBinding): StardewScreenBinding {
    const participant = this.participants.get(participantId);
    if (participant === undefined) {
      throw new Error(`成员未加入联机房间：${participantId}`);
    }
    const parsed = this.assertBodyBindingAvailable(participantId, binding);
    participant.bodyBinding = parsed;
    this.updatedAt = this.now();
    return parsed;
  }

  /** 按身体列出所有已绑定成员的租约视图（host/farmhand 双租约互不抢占的证据面） */
  bodyLeaseViews(): CoopBodyLeaseView[] {
    const views: CoopBodyLeaseView[] = [];
    for (const participant of this.participants.values()) {
      const binding = participant.bodyBinding;
      if (binding === null) continue;
      views.push({
        uniqueMultiplayerID: binding.uniqueMultiplayerID,
        screenId: binding.screenId,
        role: binding.role,
        participantId: participant.participantId,
        controlOwner: participant.controlOwner,
      });
    }
    return views.sort((a, b) => a.screenId - b.screenId);
  }

  /**
   * 查找某个游戏内身体对应的参与者（`V2-P2-09C`）。
   *
   * 动作路由与接管判定**必须**先经这里解析身体 → 参与者，
   * 否则分屏下会把动作打到另一个 `Game1` 实例的身体上。
   */
  participantOfBody(uniqueMultiplayerID: string): CoopParticipant | null {
    for (const participant of this.participants.values()) {
      if (participant.bodyBinding?.uniqueMultiplayerID === uniqueMultiplayerID) {
        return participant;
      }
    }
    return null;
  }

  /**
   * 「玩家一动即接管」判定（`V2-P2-09C` 契约面 + `V2-P2-09E` 在飞动作中止）。
   *
   * 输入是**观测到真人输入的那个身体**（不是笼统的「有人动了」）。
   * 只有当该身体属于某个 AI 参与者时，才把该 AI 的租约交给人类；
   * 人类自己的身体不产生接管事件，也不影响其他 AI 成员。
   * 判定为接管时，同步中止**该身体上**的全部在飞动作并返回
   * `ABORTED_BY_HUMAN_TAKEOVER` 回执（`V2-P2-09E`），其他身体上的动作不受影响。
   *
   * 铁律：拿不到身体标识时**不判定接管**——宁可漏接管也不误抢 AI 的控制权。
   */
  detectHumanTakeover(input: {
    /** 观测到真人输入的身体 ID；缺失则不判定 */
    uniqueMultiplayerID?: string;
    reason?: string;
  }): {
    takenOver: boolean;
    participantId?: string;
    reason: string;
    /** `V2-P2-09E`：本次接管中止的在飞动作回执（未接管或该身体无在飞动作时为空） */
    abortedReceipts: CoopTakeoverAbortReceipt[];
  } {
    const bodyId = input.uniqueMultiplayerID;
    if (bodyId === undefined || bodyId === '') {
      return {
        takenOver: false,
        reason: '未提供身体标识，无法判定接管（不误抢 AI 控制权）',
        abortedReceipts: [],
      };
    }
    const participant = this.participantOfBody(bodyId);
    if (participant === null) {
      return { takenOver: false, reason: `未找到身体 ${bodyId} 的绑定成员，不判定接管`, abortedReceipts: [] };
    }
    if (participant.kind !== 'ai') {
      return {
        takenOver: false,
        reason: `身体 ${bodyId} 属于人类成员 ${participant.participantId}，无需接管`,
        abortedReceipts: [],
      };
    }
    const lease = this.leases.get(participant.participantId);
    /* v8 ignore next 3 -- 防御层：成员在册 ⇒ 租约在册（joinParticipant 同时建档、仅 createRoom 一起清空），此分支构造不出 */
    if (lease === undefined) {
      return {
        takenOver: false,
        reason: `成员 ${participant.participantId} 无控制租约，无法接管`,
        abortedReceipts: [],
      };
    }
    lease.takeOverByHuman(input.reason ?? `人类在身体 ${bodyId} 上操作，已接管该 AI 角色`);
    participant.controlOwner = lease.owner;
    // V2-P2-09E：接管立即中止该身体上的全部在飞动作，并产出按身体的
    // ABORTED_BY_HUMAN_TAKEOVER 回执（与 BWF 侧同名同义，这里按身体记录证据面）。
    // 铁律不变：以真实接管事件为准，绝不把「同屏不打架」当成接管判定。
    const abortReason = input.reason ?? `人类在身体 ${bodyId} 上操作，已接管该 AI 角色`;
    const abortedReceipts: CoopTakeoverAbortReceipt[] = [];
    for (const [actionId, action] of this.inFlightActions) {
      if (action.uniqueMultiplayerID !== bodyId) continue;
      abortedReceipts.push(CoopTakeoverAbortReceiptSchema.parse({
        ...action,
        status: 'ABORTED_BY_HUMAN_TAKEOVER',
        reason: abortReason,
        abortedAt: this.now(),
      }));
      this.inFlightActions.delete(actionId);
    }
    this.updatedAt = this.now();
    return {
      takenOver: true,
      participantId: participant.participantId,
      reason: lease.snapshot().reason,
      abortedReceipts,
    };
  }

  /**
   * 动作路由：判断某成员能否对某身体下发控制动作（`V2-P2-09C`）。
   *
   * 规则：
   * - 成员必须**已绑定**身体，未绑定一律拒绝（避免误控他人角色）；
   * - 动作目标身体必须是该成员自己绑定的身体（防跨身体写入）；
   * - AI 成员还必须持有有效租约（人类接管/急停后立即拒绝）。
   */
  routeActionToBody(input: {
    participantId: string;
    targetUniqueMultiplayerID: string;
  }): { allowed: boolean; reason: string } {
    const participant = this.participants.get(input.participantId);
    if (participant === undefined) {
      return { allowed: false, reason: `成员不存在：${input.participantId}` };
    }
    const binding = participant.bodyBinding;
    if (binding === null) {
      return { allowed: false, reason: `成员 ${input.participantId} 未绑定游戏内身体，拒绝下发控制动作` };
    }
    if (binding.uniqueMultiplayerID !== input.targetUniqueMultiplayerID) {
      return {
        allowed: false,
        reason: `动作目标身体 ${input.targetUniqueMultiplayerID} 与成员 ${input.participantId} 绑定的身体 ${binding.uniqueMultiplayerID} 不一致，拒绝跨身体写入`,
      };
    }
    if (participant.kind === 'ai') {
      const lease = this.leases.get(input.participantId);
      /* v8 ignore next 3 -- 防御层：同上，成员在册 ⇒ 租约在册，此分支构造不出 */
      if (lease === undefined) {
        return { allowed: false, reason: `成员 ${input.participantId} 无控制租约` };
      }
      if (!lease.canAiAct()) {
        return {
          allowed: false,
          reason: `AI 成员 ${input.participantId} 的控制租约未就绪（owner=${lease.owner}）：${lease.snapshot().reason}`,
        };
      }
    }
    return { allowed: true, reason: '动作已路由到该成员绑定的游戏内身体' };
  }

  /**
   * 登记一个即将在指定身体上执行的动作（`V2-P2-09E`）。
   *
   * 先过 `routeActionToBody` 的全部拦截（未绑定/跨身体/租约失效一律拒绝），
   * 然后按身体加**动作互斥锁**：同一身体同时只允许一个动作在飞
   * （与 BWF 的 `ACTION_IN_FLIGHT` 拒绝语义一致），杜绝同一身体并发下发。
   */
  beginBodyAction(input: {
    participantId: string;
    uniqueMultiplayerID: string;
    tool: string;
    actionId?: string;
  }): { ok: boolean; error?: string; action?: CoopInFlightAction } {
    const routed = this.routeActionToBody({
      participantId: input.participantId,
      targetUniqueMultiplayerID: input.uniqueMultiplayerID,
    });
    if (!routed.allowed) return { ok: false, error: routed.reason };
    const participant = this.participants.get(input.participantId);
    const binding = participant?.bodyBinding ?? null;
    /* v8 ignore next 3 -- 防御层：routeActionToBody 通过即存在绑定，此分支构造不出 */
    if (participant === null || participant === undefined || binding === null) {
      return { ok: false, error: `成员 ${input.participantId} 未绑定游戏内身体` };
    }
    const busy = [...this.inFlightActions.values()].some(
      (action) => action.uniqueMultiplayerID === binding.uniqueMultiplayerID,
    );
    if (busy) {
      return {
        ok: false,
        error: `身体 ${binding.uniqueMultiplayerID} 已有在飞动作，拒绝并发下发（动作互斥锁）`,
      };
    }
    const action = CoopInFlightActionSchema.parse({
      actionId: input.actionId ?? `act-${randomUUID().slice(0, 8)}`,
      participantId: input.participantId,
      uniqueMultiplayerID: binding.uniqueMultiplayerID,
      screenId: binding.screenId,
      tool: input.tool,
      startedAt: this.now(),
    });
    this.inFlightActions.set(action.actionId, action);
    this.updatedAt = this.now();
    return { ok: true, action };
  }

  /**
   * 以 BWF 的真实回执结束一个在飞动作（`V2-P2-09E`）。
   *
   * `status` 只接受 `COMPLETED | FAILED | UNCERTAIN`——被接管中止的动作
   * 不经过这里，它在 `detectHumanTakeover` 里直接产出 `ABORTED_BY_HUMAN_TAKEOVER`
   * 回执并从登记表移除；因此动作被中止后再来 finish 会得到「在飞动作不存在」的诚实报错。
   */
  finishBodyAction(
    actionId: string,
    status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN',
  ): { ok: boolean; error?: string; action?: CoopInFlightAction; status?: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' } {
    const action = this.inFlightActions.get(actionId);
    if (action === undefined) {
      return {
        ok: false,
        error: `在飞动作不存在：${actionId}（可能已被接管中止，或从未登记）`,
      };
    }
    this.inFlightActions.delete(actionId);
    this.updatedAt = this.now();
    return { ok: true, action, status };
  }

  /** 当前全部在飞动作（证据面与沙盒剧本断言用） */
  inFlightActionViews(): CoopInFlightAction[] {
    return [...this.inFlightActions.values()];
  }

  controlLeaseOf(participantId: string): GameCharacterControlLease | null {
    return this.leases.get(participantId) ?? null;
  }

  /** P0 紧急停止全部 AI 成员控制写入（人类角色不受影响） */
  emergencyHaltAll(reason = '联机全局急停'): void {
    const ts = this.now();
    for (const [id, p] of this.participants) {
      if (p.kind === 'ai') {
        const lease = this.leases.get(id)!;
        lease.emergencyStop(reason);
        p.controlOwner = lease.owner;
      }
    }
    this.status = 'paused';
    this.updatedAt = ts;
  }

  /** 提议联机任务到 Task Board */
  proposeTask(input: {
    taskId?: string;
    title: string;
    goal: string;
    ownerId: string;
    preconditions?: string[];
    resourceLocks?: string[];
    priority?: number;
  }): CoopTaskItem {
    if (!this.participants.has(input.ownerId)) {
      throw new Error(`任务负责人未加入联机房间：${input.ownerId}`);
    }
    const ts = this.now();
    const task = CoopTaskItemSchema.parse({
      taskId: input.taskId ?? `task-${randomUUID().slice(0, 8)}`,
      roomId: this.roomId,
      title: input.title,
      goal: input.goal,
      ownerId: input.ownerId,
      preconditions: input.preconditions ?? [],
      resourceLocks: input.resourceLocks ?? [],
      status: 'proposed',
      priority: input.priority ?? 3,
      updatedAt: ts,
    });
    this.tasks.set(task.taskId, task);
    this.updatedAt = ts;
    return task;
  }

  acceptTask(taskId: string, participantId?: string): { ok: boolean; error?: string; task?: CoopTaskItem } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `任务不存在：${taskId}` };
    const nextOwner = participantId ?? task.ownerId;
    if (!this.participants.has(nextOwner)) return { ok: false, error: `成员不存在：${nextOwner}` };
    task.ownerId = nextOwner;
    task.status = 'accepted';
    task.updatedAt = this.now();
    this.updatedAt = task.updatedAt;
    return { ok: true, task: { ...task } };
  }

  /** 原子启动任务：检查成员在线、租约合法且成功锁定全部资源锁 */
  startTask(taskId: string): { ok: boolean; error?: string; task?: CoopTaskItem } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `任务不存在：${taskId}` };
    const owner = this.participants.get(task.ownerId);
    if (!owner || owner.connectionState !== 'connected') {
      return { ok: false, error: `成员 ${task.ownerId} 当前不在线，无法启动任务` };
    }
    if (owner.kind === 'ai') {
      const lease = this.leases.get(owner.participantId)!;
      if (!lease.canAiAct()) {
        return { ok: false, error: `AI 成员 ${owner.displayName} 控制租约未就绪（owner=${lease.owner}）` };
      }
    }

    const acquiredKeys: string[] = [];
    for (const key of task.resourceLocks) {
      const res = this.reserveResource({
        resourceKey: key,
        ownerId: task.ownerId,
        intent: 'reserve',
        reason: `任务 ${task.title}`,
      });
      if (!res.ok) {
        for (const rollbackKey of acquiredKeys) {
          this.releaseResource(task.ownerId, rollbackKey);
        }
        return { ok: false, error: `资源冲突无法启动任务：${res.reason}` };
      }
      acquiredKeys.push(key);
    }

    task.status = 'running';
    task.updatedAt = this.now();
    this.blackboard.upsertAssignment({
      agentId: owner.participantId,
      displayName: owner.displayName,
      role: owner.kind,
      task: task.title,
      zone: task.resourceLocks[0] ?? '',
      status: 'working',
      progressNote: `执行中：${task.goal}`,
      updatedAt: task.updatedAt,
    });
    this.updatedAt = task.updatedAt;
    return { ok: true, task: { ...task } };
  }

  /** 任务交接：释放旧负责人锁并移交新成员 */
  handoffTask(taskId: string, toParticipantId: string, note?: string): { ok: boolean; error?: string; task?: CoopTaskItem } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `任务不存在：${taskId}` };
    const nextOwner = this.participants.get(toParticipantId);
    if (!nextOwner || nextOwner.connectionState === 'offline') {
      return { ok: false, error: `接手成员不可用：${toParticipantId}` };
    }
    for (const key of task.resourceLocks) {
      this.releaseResource(task.ownerId, key);
    }
    task.ownerId = toParticipantId;
    task.status = 'accepted';
    task.handoffNote = note ?? `交接给 ${nextOwner.displayName}`;
    task.updatedAt = this.now();
    this.updatedAt = task.updatedAt;
    return { ok: true, task: { ...task } };
  }

  /** 依据真实执行回执更新任务状态（UNCERTAIN 绝不伪造为 completed） */
  reportTaskOutcome(
    taskId: string,
    receipt: 'COMPLETED' | 'FAILED' | 'UNCERTAIN',
    resultSummary: string,
  ): { ok: boolean; error?: string; task?: CoopTaskItem } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `任务不存在：${taskId}` };
    for (const key of task.resourceLocks) {
      this.releaseResource(task.ownerId, key);
    }
    task.status = receipt === 'COMPLETED' ? 'completed' : receipt === 'FAILED' ? 'failed' : 'blocked';
    task.result = resultSummary;
    task.updatedAt = this.now();
    this.blackboard.setAssignmentStatus(
      task.ownerId,
      receipt === 'UNCERTAIN' ? 'need_help' : 'idle',
      resultSummary,
    );
    this.updatedAt = task.updatedAt;
    return { ok: true, task: { ...task } };
  }

  /** 重要资源预留（防止 AI 误卖用户作物或争抢容器/农田区域） */
  reserveResource(input: {
    resourceKey: string;
    ownerId: string;
    intent: CoopResourceIntent;
    ttlMs?: number;
    reason?: string;
  }): { ok: boolean; reason?: string; reservation?: CoopResourceReservation } {
    this.purgeExpiredReservations();
    const existing = this.reservations.get(input.resourceKey);
    if (existing && existing.ownerId !== input.ownerId) {
      return {
        ok: false,
        reason: `资源 ${input.resourceKey} 已被 ${existing.ownerId} 预留（${existing.intent}）`,
        reservation: existing,
      };
    }
    const ts = this.now();
    const reservation = CoopResourceReservationSchema.parse({
      resourceKey: input.resourceKey,
      ownerId: input.ownerId,
      intent: input.intent,
      reason: input.reason ?? '',
      expiresAt: ts + Math.max(1_000, input.ttlMs ?? 120_000),
    });
    this.reservations.set(reservation.resourceKey, reservation);
    this.updatedAt = ts;
    return { ok: true, reservation };
  }

  releaseResource(ownerId: string, resourceKey: string): boolean {
    const existing = this.reservations.get(resourceKey);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.reservations.delete(resourceKey);
    this.updatedAt = this.now();
    return true;
  }

  /** 动作前资源安全门禁：严防 AI 出售人类标为 keep / sell_forbidden 的作物或物品 */
  checkResourceAccess(
    participantId: string,
    resourceKey: string,
    action: 'use' | 'sell' | 'harvest',
  ): { allowed: boolean; reason: string } {
    this.purgeExpiredReservations();
    const existing = this.reservations.get(resourceKey);
    if (!existing) {
      return { allowed: true, reason: '资源未锁定，可安全操作' };
    }
    if ((existing.intent === 'sell_forbidden' || existing.intent === 'keep') && action === 'sell') {
      return {
        allowed: false,
        reason: `已阻断出售：${resourceKey} 已被 ${existing.ownerId} 标记为保留/禁售（${existing.reason || existing.intent}）`,
      };
    }
    if (existing.ownerId !== participantId) {
      return {
        allowed: false,
        reason: `资源冲突：${resourceKey} 正由 ${existing.ownerId} 占用（${existing.intent}）`,
      };
    }
    return { allowed: true, reason: '当前成员持有资源授权' };
  }

  recordHeartbeat(participantId: string): boolean {
    const p = this.participants.get(participantId);
    if (!p) return false;
    p.lastHeartbeatAt = this.now();
    this.updatedAt = p.lastHeartbeatAt;
    return true;
  }

  /** 标记掉线进入宽限期：暂停 AI 写入并暂留资源/任务等待重连 */
  markDisconnected(participantId: string, reason = '联机心跳中断'): CoopParticipant | null {
    const p = this.participants.get(participantId);
    if (!p) return null;
    const ts = this.now();
    p.connectionState = 'reconnecting';
    p.reconnectDeadlineAt = ts + this.gracePeriodMs;
    if (p.kind === 'ai') {
      const lease = this.leases.get(participantId)!;
      lease.pauseAi(reason);
      p.controlOwner = lease.owner;
    }
    this.status = 'reconnecting';
    this.updatedAt = ts;
    return { ...p };
  }

  /** 周期巡检：超时触发掉线宽限，宽限期到期释放锁并置 offline 防死锁 */
  tickRecovery(): { timedOutIds: string[]; disconnectedIds: string[] } {
    const ts = this.now();
    const disconnectedIds: string[] = [];
    const timedOutIds: string[] = [];

    for (const p of this.participants.values()) {
      if (p.connectionState === 'connected' && ts - p.lastHeartbeatAt >= this.heartbeatTimeoutMs) {
        this.markDisconnected(p.participantId, '心跳超时');
        disconnectedIds.push(p.participantId);
      } else if (p.connectionState === 'reconnecting' && p.reconnectDeadlineAt !== null && ts >= p.reconnectDeadlineAt) {
        p.connectionState = 'offline';
        p.reconnectDeadlineAt = null;
        timedOutIds.push(p.participantId);
        // 超时自动释放所有锁定资源，防止队友死锁
        for (const [resKey, res] of this.reservations) {
          if (res.ownerId === p.participantId) {
            this.reservations.delete(resKey);
          }
        }
        for (const task of this.tasks.values()) {
          if (task.ownerId === p.participantId && task.status === 'running') {
            task.status = 'blocked';
            task.updatedAt = ts;
          }
        }
        this.blackboard.setAssignmentStatus(p.participantId, 'offline', '重连超时已离线，锁已释放');
      }
    }

    if (timedOutIds.length > 0 && this.status === 'reconnecting') {
      const anyOnline = [...this.participants.values()].some((p) => p.connectionState === 'connected');
      const anyReconnecting = [...this.participants.values()].some((p) => p.connectionState === 'reconnecting');
      if (!anyReconnecting) {
        this.status = anyOnline ? 'active' : 'paused';
      }
    }
    this.updatedAt = ts;
    return { timedOutIds, disconnectedIds };
  }

  /** 断线成员重连恢复：推进世代淘汰旧指令并恢复 AI 控制租约 */
  reconnectParticipant(participantId: string): { ok: boolean; error?: string; participant?: CoopParticipant } {
    const p = this.participants.get(participantId);
    if (!p) return { ok: false, error: `成员不存在：${participantId}` };
    const ts = this.now();
    p.connectionState = 'connected';
    p.lastHeartbeatAt = ts;
    p.reconnectDeadlineAt = null;
    p.reconnectAttempts += 1;
    this.epoch += 1;

    const lease = this.leases.get(participantId)!;
    lease.bumpSession(`${this.roomId}:${participantId}:e${this.epoch}`, lease.snapshot().generation + 1);
    if (p.kind === 'ai') {
      lease.resumeAi('联机断线重连恢复');
      p.controlOwner = lease.owner;
    }

    const anyReconnecting = [...this.participants.values()].some((item) => item.connectionState === 'reconnecting');
    if (!anyReconnecting && this.status === 'reconnecting') {
      this.status = 'active';
    }
    this.blackboard.setAssignmentStatus(participantId, 'idle', `第 ${p.reconnectAttempts} 次重连恢复成功`);
    this.updatedAt = ts;
    return { ok: true, participant: { ...p } };
  }

  recordCompatReport(report: CoopModCompatibilityReport): void {
    this.lastCompatReport = CoopModCompatibilityReportSchema.parse(report);
    this.updatedAt = this.now();
  }

  snapshot(): CoopRuntimeSnapshot {
    this.purgeExpiredReservations();
    return CoopRuntimeSnapshotSchema.parse({
      roomId: this.roomId,
      gameId: this.gameId,
      status: this.status,
      epoch: this.epoch,
      sharedGoal: this.sharedGoal,
      participants: [...this.participants.values()],
      tasks: [...this.tasks.values()],
      reservations: [...this.reservations.values()],
      lastCompatReport: this.lastCompatReport,
      bodyLeases: this.bodyLeaseViews(),
      inFlightActions: this.inFlightActionViews(),
      updatedAt: this.updatedAt,
    });
  }
}
