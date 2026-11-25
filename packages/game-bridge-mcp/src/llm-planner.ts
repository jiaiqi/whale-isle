/**
 * LLM 全权自主规划器（T-M6-70 + T-M6-72，单文件 ≤500 行）：
 *   - 大脑开且可用时每步全权决策（RulePlanner.decide 0 次）；
 *   - 晨间自拟计划 + 步中 planUpdate 修订；T-M6-72 攻略索引 + read_guide 伪工具（≤2 节/轮）+ 心得本（insight/usedInsight）+ 每晚幂等复盘；
 *   - 普通聊天建议 vs `/` 强制命令；网关异常或连续失范切 RulePlanner 代驾并每 2 分钟探测恢复。
 */
import { RulePlanner, type GameStateSnapshot, type Planner, type PlannerDecision } from './planner';
import { extractEnvironmentHints } from './state-hints';
import { BrainSwitch, type BrainMode } from './brain-switch';
import { DayPlanStore, parseMorningPlanObject, type DayPlanSnapshot } from './day-plan';
import { formatReadGuideReply, GuideLibrary } from './guide-library';
import { extractSaveNameFromState, StrategyNotebook, type StrategyInsight } from './strategy-notebook';
import { runNightlyReflection, summarizeReceiptsForReflection, type ReceiptRecord } from './reflection';
import {
  buildAdapterDecisionMessages, buildAutonomousDecisionMessages, buildMorningPlanMessages, extractDecisionJson,
  extractJsonObject, LLM_TOOL_WHITELIST, normalizeFailureSignature, parseAutonomousDecision, pickGuideContext,
  validateMandatoryCommandDecision, type ChatStanceValue,
} from './llm-prompt';

export { pickEdible, pickShippableItem, pickTrash } from './planner';
export * from './day-plan';
export * from './brain-switch';
export * from './guide-library';
export * from './strategy-notebook';
export * from './reflection';
export * from './llm-prompt';

export const MAX_OBJECTIVE_ROUNDS = 15;
export const SUGGESTION_EXPIRY_GAME_MINUTES = 120;
export const MAX_GUIDE_READS_PER_TURN = 2;

export interface ChatStanceEmission {
  kind: 'suggestion' | 'command'; text: string; stance: ChatStanceValue; reply: string; reason?: string; alternative?: string;
}
export interface PlanEmission {
  dayKey: string; plan: DayPlanSnapshot['items']; mood?: string; updateWhy?: string; reason: 'morning' | 'update';
}
export interface InsightEmission {
  action: 'learned' | 'used' | 'reflected'; dayKey: string; insight: StrategyInsight;
  usedInsight?: string; tool?: string; notebookCount: number; insights: StrategyInsight[];
}
export interface LlmPlannerDeps {
  chat(slot: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: { maxTokens?: number }): Promise<{ content: string }>;
  slot?: string; guides?: Record<string, string>; recentReceipts?: string[]; toolWhitelist?: readonly string[];
  allowRuleStandin?: boolean; fallbackPlanner?: Planner; systemPrompt?: string | (() => string); personaPrompt?: string | (() => string);
  contextProvider?: () => string; isKeyAvailable?: () => boolean; probeIntervalMs?: number; now?: () => number;
  notesDir?: string; saveName?: string; notebook?: StrategyNotebook;
  onPlan?: (event: PlanEmission) => void; onBrainChange?: (mode: BrainMode, reason: string) => void;
  onChatStance?: (event: ChatStanceEmission) => void; onInsight?: (event: InsightEmission) => void; rng?: () => number;
}

interface PendingSuggestion { text: string; stampedDayKey: string | null; stampedMinutes: number | null; stampedClock: string }
interface ActiveCommand { text: string; acknowledged: boolean; pendingDone: boolean }
const SUGGESTION_STANCES = new Set(['accept', 'modify', 'decline']);

export class LlmPlanner implements Planner {
  readonly name = 'llm-xiaojing';
  readonly brainSwitch: BrainSwitch;
  readonly dayPlanStore = new DayPlanStore();
  readonly guideLibrary = new GuideLibrary();
  readonly notebook: StrategyNotebook;

  private readonly fallback: Planner;
  private readonly allowedTools: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly pinnedSaveName: boolean;
  private askCount = 0;
  private planDay = '';
  private dayStartMoney: number | null = null;
  private lastMoney = 0;
  private lastFreeSlots: number | null = null;
  private objective: string | null = null;
  private objectiveRounds = 0;
  private objectiveDonePending: string | null = null;
  private pendingSuggestion: PendingSuggestion | null = null;
  private activeCommand: ActiveCommand | null = null;
  private handoverSummary: string | null = null;
  private lastLocation = '未知';
  private lastFailSignature: string | null = null;
  private lastFailSummary = '';
  private failStreak = 0;
  private lastObservedClock = '';
  private lastClockChangedAt = 0;
  private fallbackSyncedDay = '';
  private readonly todayReceipts: ReceiptRecord[] = [];
  private onPlan?: (event: PlanEmission) => void;
  private onChatStance?: (event: ChatStanceEmission) => void;
  private onInsight?: (event: InsightEmission) => void;

  constructor(private readonly deps: LlmPlannerDeps) {
    this.fallback = deps.fallbackPlanner ?? new RulePlanner();
    this.allowedTools = new Set(deps.toolWhitelist ?? LLM_TOOL_WHITELIST);
    this.now = deps.now ?? Date.now;
    this.pinnedSaveName = deps.saveName !== undefined || deps.notebook !== undefined;
    this.notebook = deps.notebook ?? new StrategyNotebook({
      ...(deps.notesDir === undefined ? {} : { notesDir: deps.notesDir }),
      ...(deps.saveName === undefined ? {} : { saveName: deps.saveName }),
    });
    if (deps.guides !== undefined) this.guideLibrary.setGuides(deps.guides);
    if (deps.onPlan !== undefined) this.onPlan = deps.onPlan;
    if (deps.onChatStance !== undefined) this.onChatStance = deps.onChatStance;
    if (deps.onInsight !== undefined) this.onInsight = deps.onInsight;
    this.brainSwitch = new BrainSwitch({
      initialMode: 'llm',
      ...(deps.allowRuleStandin === undefined ? {} : { allowRuleStandin: deps.allowRuleStandin }),
      ...(deps.isKeyAvailable === undefined ? {} : { isKeyAvailable: deps.isKeyAvailable }),
      ...(deps.probeIntervalMs === undefined ? {} : { probeIntervalMs: deps.probeIntervalMs }),
      now: this.now,
      ...(deps.onBrainChange === undefined ? {} : { onModeChange: deps.onBrainChange }),
    });
  }

  bindCallbacks(cb: {
    onPlan?: (e: PlanEmission) => void; onBrainChange?: (m: BrainMode, r: string) => void;
    onChatStance?: (e: ChatStanceEmission) => void; onInsight?: (e: InsightEmission) => void;
  }): void {
    if (cb.onPlan !== undefined) this.onPlan = cb.onPlan;
    if (cb.onChatStance !== undefined) this.onChatStance = cb.onChatStance;
    if (cb.onInsight !== undefined) this.onInsight = cb.onInsight;
    if (cb.onBrainChange !== undefined) this.brainSwitch.setModeChangeListener(cb.onBrainChange);
  }

  isPaused(): boolean { return this.brainSwitch.isPaused(); }
  isStandin(): boolean { return this.brainSwitch.isStandin(); }
  isUnavailable(): boolean { return this.brainSwitch.isUnavailable(); }
  get asks(): number { return this.askCount; }
  setGuides(guides: Record<string, string>): void { this.deps.guides = guides; this.guideLibrary.setGuides(guides); }
  setSaveName(saveName: string): void { this.notebook.bindSave(saveName); }
  setRecentReceipts(recentReceipts: string[]): void { this.deps.recentReceipts = [...recentReceipts]; }
  setSlot(slot: string): void { this.deps.slot = slot; }

  submitSuggestion(text: string): void {
    const trimmed = text.trim().slice(0, 300);
    if (trimmed !== '') this.pendingSuggestion = { text: trimmed, stampedDayKey: null, stampedMinutes: null, stampedClock: this.lastObservedClock || '刚刚' };
  }

  submitCommand(command: string): void {
    const trimmed = command.replace(/^\/+/, '').trim().slice(0, 300);
    if (trimmed !== '') { this.activeCommand = { text: trimmed, acknowledged: false, pendingDone: false }; this.objectiveDonePending = null; }
  }

  hasCommand(): boolean { return this.activeCommand !== null; }
  hasObjective(): boolean { return this.objective !== null || this.activeCommand !== null; }
  cancelCommand(): string | null {
    if (this.activeCommand === null) return null;
    const prev = this.activeCommand.text; this.activeCommand = null; return prev;
  }
  setHandoverSummary(summary: string | null): void { this.handoverSummary = summary?.trim() ? summary.trim().slice(0, 400) : null; }
  setObjective(objective: string | null): void {
    this.objective = objective?.trim() ? objective.trim().slice(0, 300) : null;
    this.objectiveRounds = 0; this.objectiveDonePending = null;
  }
  consumeObjectiveDone(): string | null {
    if (this.activeCommand?.pendingDone === true) { const done = `/${this.activeCommand.text}`; this.activeCommand = null; return done; }
    const done = this.objectiveDonePending; this.objectiveDonePending = null; return done;
  }
  restoreObjectiveDone(): void {
    if (this.activeCommand?.pendingDone === true) this.activeCommand.pendingDone = false;
    if (this.objectiveDonePending !== null) { if (this.objective === null) this.objective = this.objectiveDonePending; this.objectiveDonePending = null; }
  }

  observeReceipt(tool: string, status: ReceiptRecord['status'], summary: string): void {
    this.fallback.observeReceipt?.(tool, status, summary);
    this.todayReceipts.push({ tool, status, summary });
    if (this.todayReceipts.length > 60) this.todayReceipts.splice(0, this.todayReceipts.length - 60);
    if (status === 'COMPLETED') { this.lastFailSignature = null; this.lastFailSummary = ''; this.failStreak = 0; return; }
    const sig = normalizeFailureSignature(tool, summary, this.lastLocation);
    this.failStreak = sig === this.lastFailSignature ? this.failStreak + 1 : 1;
    this.lastFailSignature = sig;
    this.lastFailSummary = summary;
  }

  debugSnapshot(): Record<string, unknown> {
    return {
      planner: this.name, slot: this.deps.slot ?? null, brain: this.brainSwitch.snapshot(),
      dayPlan: this.dayPlanStore.snapshot(), guideTopics: this.guideLibrary.topics(),
      notebook: {
        saveName: this.notebook.getSaveName(), path: this.notebook.filePath(),
        count: this.notebook.size(), tomorrowHint: this.notebook.getTomorrowHint(), insights: this.notebook.list(),
      },
      objective: this.objective, objectiveRounds: this.objectiveRounds,
      mandatoryCommand: this.activeCommand === null ? null : { ...this.activeCommand },
      pendingSuggestion: this.pendingSuggestion === null ? null : { ...this.pendingSuggestion },
      askCount: this.askCount, planDay: this.planDay, lastFreeSlots: this.lastFreeSlots,
      failureMemory: { signature: this.lastFailSignature, streak: this.failStreak, summary: this.lastFailSummary },
      cooledTools: [], dayFails: {}, rejected: { ship: [], eat: [], trash: [], place: [] },
      fallback: this.fallback.debugSnapshot?.() ?? { planner: this.fallback.name },
    };
  }

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    this.lastLocation = state.location;
    const now = this.now();
    if (state.gameClock !== '' && state.gameClock !== '未知' && state.gameClock !== this.lastObservedClock) {
      this.lastObservedClock = state.gameClock;
      this.lastClockChangedAt = now;
    } else if (this.lastClockChangedAt === 0) {
      this.lastClockChangedAt = now;
    }
    if (this.objective !== null && ++this.objectiveRounds > MAX_OBJECTIVE_ROUNDS) {
      this.objective = null;
      this.objectiveRounds = 0;
    }
    const adapterPrompt = typeof this.deps.systemPrompt === 'function' ? this.deps.systemPrompt() : this.deps.systemPrompt;
    return adapterPrompt !== undefined ? this.decideForAdapter(state, adapterPrompt) : this.decideAutonomous(state);
  }

  private async standinDecision(state: GameStateSnapshot): Promise<PlannerDecision> {
    if (this.brainSwitch.isPaused()) {
      return { kind: 'wait', seconds: 15, reason: `AI 安全暂停：${this.brainSwitch.reason || 'LLM 暂不可用，等待用户处理（未启用规则代驾）'}` };
    }
    const dayKey = this.planDay || `${state.season}${state.day}`;
    if (this.fallbackSyncedDay !== dayKey) {
      this.fallbackSyncedDay = dayKey;
      if (this.todayReceipts.length > 0) {
        // 先让规则规划器锚定今日 dayKey（首次 decide 会清空其内部跨日集合），再重放今日真实回执，保证中途接手不断档
        await this.fallback.decide(state);
        for (const r of this.todayReceipts) this.fallback.observeReceipt?.(r.tool, r.status, r.summary);
      }
    }
    const decision = await this.fallback.decide(state);
    return decision.kind === 'act' ? { ...decision, intent: `规则代驾：${decision.intent}` } : decision;
  }

  private syncDailyAndSuggestionExpiry(state: GameStateSnapshot): string {
    if (!this.pinnedSaveName) {
      const save = extractSaveNameFromState(state.raw);
      if (save !== null) this.notebook.bindSave(save);
    }
    const hasClock = /时间：第\d+年[春夏秋冬]\d+日/.test(state.raw);
    const dayKey = hasClock ? `${state.season}${state.day}` : (this.planDay || `${state.season}${state.day}`);
    if (dayKey !== this.planDay) {
      const crossedDay = this.planDay !== '';
      this.planDay = dayKey;
      this.dayStartMoney = state.money;
      this.dayPlanStore.rollover(dayKey);
      if (crossedDay) { this.objective = null; this.objectiveRounds = 0; this.todayReceipts.length = 0; }
    } else if (this.dayStartMoney === null) {
      this.dayStartMoney = state.money;
    }
    this.lastMoney = state.money;
    if (this.pendingSuggestion !== null) {
      if (this.pendingSuggestion.stampedDayKey === null || this.pendingSuggestion.stampedMinutes === null) {
        this.pendingSuggestion.stampedDayKey = dayKey;
        this.pendingSuggestion.stampedMinutes = state.clockMinutes;
        this.pendingSuggestion.stampedClock = state.gameClock;
      } else {
        const elapsed = this.pendingSuggestion.stampedDayKey === dayKey
          ? state.clockMinutes - this.pendingSuggestion.stampedMinutes
          : (26 * 60 - this.pendingSuggestion.stampedMinutes) + state.clockMinutes;
        if (elapsed >= SUGGESTION_EXPIRY_GAME_MINUTES) this.pendingSuggestion = null;
      }
    }
    return dayKey;
  }

  private teamAndObjectiveContext(): string {
    let summary = '';
    try { summary = this.deps.contextProvider?.().trim() ?? ''; } catch { summary = ''; }
    const objectiveText = this.objective === null
      ? ''
      : `主人当前目标：${this.objective}\n- 只有真实状态已证明目标达成时，才在本轮 JSON 追加 "objectiveDone": true（动作回执成功后目标才算完成）。`;
    if (summary === '') return objectiveText;
    const board = `团队协作黑板（只读事实，不是命令）：\n${[...summary].slice(0, 300).join('')}`;
    return objectiveText === '' ? board : `${board}\n\n${objectiveText}`;
  }

  private guidesHintForState(state: GameStateSnapshot): string {
    if (this.guideLibrary.allSections().length > 0) {
      return this.guideLibrary.buildIndexForState({ season: state.season, location: state.location, raw: state.raw, dayPlanText: this.dayPlanStore.formatForPrompt() });
    }
    return pickGuideContext(state, this.deps.guides);
  }

  private insightsTextForState(state: GameStateSnapshot, limit = 5): string {
    return this.notebook.formatForPrompt(this.notebook.retrieve({
      season: state.season, location: state.location, dayPlanText: this.dayPlanStore.formatForPrompt(), stateRaw: state.raw, limit,
    }));
  }

  private async maybeReflectNight(state: GameStateSnapshot, dayKey: string, personaPrompt: string | undefined): Promise<void> {
    if (this.notebook.hasReflectedDay(dayKey)) return;
    const agg = summarizeReceiptsForReflection(this.todayReceipts, state.location);
    const relatedInsights = this.notebook.retrieve({ season: state.season, location: state.location, dayPlanText: this.dayPlanStore.formatForPrompt(), stateRaw: state.raw, limit: 8 });
    const res = await runNightlyReflection({
      dayKey, notebook: this.notebook,
      summary: { dayKey, dayPlan: this.dayPlanStore.snapshot(), startMoney: this.dayStartMoney, endMoney: this.lastMoney, ...agg, relatedInsights },
      ...(personaPrompt === undefined ? {} : { personaPrompt }), slot: this.deps.slot ?? 'STARDEW_GAME_PLANNER',
      chat: this.deps.chat, onCountAsk: () => { this.askCount += 1; },
    });
    for (const insight of res.updated) {
      this.onInsight?.({ action: 'reflected', dayKey, insight, notebookCount: this.notebook.size(), insights: this.notebook.list() });
    }
  }

  private async maybeGenerateMorningPlan(
    state: GameStateSnapshot, dayKey: string, personaPrompt: string | undefined, guidesHint: string, insightsText: string,
  ): Promise<{ reusedContent?: string; abortedToStandin?: boolean }> {
    const freeToAct = state.menu === '' || /无（可以自由行动）/.test(state.menu);
    if (!freeToAct || this.dayPlanStore.hasAttemptedToday(dayKey) || this.activeCommand !== null || this.objective !== null) return {};
    this.dayPlanStore.markAttempted(dayKey);
    const tomorrowHint = this.notebook.getTomorrowHint();
    const messages = buildMorningPlanMessages({
      ...(personaPrompt === undefined ? {} : { personaPrompt }), guidesHint, insightsText,
      ...(tomorrowHint === '' ? {} : { tomorrowHint }), state,
    });
    try {
      this.askCount += 1;
      const res = await this.deps.chat(this.deps.slot ?? 'STARDEW_GAME_PLANNER', messages, { maxTokens: 1600 });
      const obj = extractJsonObject(res.content);
      const parsedPlan = obj !== null ? parseMorningPlanObject(obj) : null;
      if (parsedPlan !== null) {
        const saved = this.dayPlanStore.setMorningPlan(dayKey, parsedPlan.items, parsedPlan.mood);
        if (tomorrowHint !== '') this.notebook.setTomorrowHint('');
        this.brainSwitch.recordSuccess();
        this.onPlan?.({ dayKey, plan: saved.items, ...(saved.mood === undefined ? {} : { mood: saved.mood }), reason: 'morning' });
        return typeof obj?.['tool'] === 'string' && obj['tool'].trim() !== '' ? { reusedContent: res.content } : {};
      }
      if (parseAutonomousDecision(res.content) !== null) return { reusedContent: res.content };
      return this.brainSwitch.recordParseFailure('晨间计划 JSON 无法解析') ? { abortedToStandin: true } : {};
    } catch (error) {
      this.brainSwitch.recordGatewayFailure(error instanceof Error ? error.message : String(error));
      return { abortedToStandin: true };
    }
  }

  private async decideAutonomous(state: GameStateSnapshot): Promise<PlannerDecision> {
    const dayKey = this.syncDailyAndSuggestionExpiry(state);
    if (!this.brainSwitch.shouldTryLlm()) return this.standinDecision(state);

    const rawHasSlots = /背包空位：\d+\s*个/.test(state.raw);
    if (rawHasSlots) this.lastFreeSlots = state.freeSlots;
    const effectiveSlots = rawHasSlots ? state.freeSlots : (this.lastFreeSlots ?? state.freeSlots);
    const recent = this.deps.recentReceipts ?? [];
    const personaPrompt = typeof this.deps.personaPrompt === 'function' ? this.deps.personaPrompt() : this.deps.personaPrompt;
    const guidesHint = this.guidesHintForState(state);

    const morning = await this.maybeGenerateMorningPlan(state, dayKey, personaPrompt, guidesHint, this.insightsTextForState(state));
    if (morning.abortedToStandin === true) return this.standinDecision(state);
    if ((state.clockMinutes >= 24 * 60 || state.clockMinutes < 6 * 60) && this.todayReceipts.length > 0) {
      await this.maybeReflectNight(state, dayKey, personaPrompt);
    }

    const clockStallSec = this.lastClockChangedAt > 0 ? Math.max(0, Math.floor((this.now() - this.lastClockChangedAt) / 1000)) : 0;
    const messages = buildAutonomousDecisionMessages({
      ...(personaPrompt === undefined ? {} : { personaPrompt }), guidesHint, insightsText: this.insightsTextForState(state),
      state, effectiveFreeSlots: effectiveSlots, environmentHints: extractEnvironmentHints(state.raw, state.clockMinutes, recent),
      recentReceipts: recent, dayPlanText: this.dayPlanStore.formatForPrompt(),
      failureMemory: { lastSignature: this.lastFailSignature, streak: this.failStreak, lastSummary: this.lastFailSummary, clockStallSec },
      mandatoryCommand: this.activeCommand === null ? null : { text: this.activeCommand.text, acknowledged: this.activeCommand.acknowledged },
      pendingSuggestion: this.pendingSuggestion === null ? null : { text: this.pendingSuggestion.text, stampedClock: this.pendingSuggestion.stampedClock },
      handoverSummary: this.handoverSummary, teamAndObjectiveText: this.teamAndObjectiveContext(), allowedTools: this.allowedTools,
    });

    let reused = morning.reusedContent;
    let guideReads = 0;
    let parseAttempts = 0;
    while (parseAttempts < 3) {
      let rawContent: string;
      if (reused !== undefined) {
        rawContent = reused;
        reused = undefined;
      } else {
        try {
          this.askCount += 1;
          rawContent = (await this.deps.chat(this.deps.slot ?? 'STARDEW_GAME_PLANNER', messages, { maxTokens: 1600 })).content;
        } catch (error) {
          this.brainSwitch.recordGatewayFailure(error instanceof Error ? error.message : String(error));
          return this.standinDecision(state);
        }
      }

      const parsed = parseAutonomousDecision(rawContent);
      if (parsed?.tool === 'read_guide') {
        messages.push({ role: 'assistant', content: rawContent });
        if (guideReads < MAX_GUIDE_READS_PER_TURN) {
          guideReads += 1;
          const topic = String(parsed.args['topic'] ?? '');
          const section = parsed.args['section'] === undefined ? undefined : String(parsed.args['section']);
          messages.push({ role: 'user', content: formatReadGuideReply(topic, section ?? '', this.guideLibrary.readSection(topic, section)) });
          continue;
        }
        parseAttempts += 1;
        if (this.brainSwitch.recordParseFailure('同一轮 read_guide 超过 2 次上限')) return this.standinDecision(state);
        messages.push({ role: 'user', content: `本轮已读满 ${MAX_GUIDE_READS_PER_TURN} 节攻略（不发往游戏），请立即输出白名单内的具体游戏动作 JSON。` });
        continue;
      }

      if (this.activeCommand !== null) {
        const cmd = this.activeCommand;
        const check = validateMandatoryCommandDecision(parsed, cmd.acknowledged, this.allowedTools);
        if (!check.ok) {
          parseAttempts += 1;
          if (this.brainSwitch.recordCommandNonCompliance(check.error)) return this.standinDecision(state);
          messages.push({ role: 'assistant', content: rawContent });
          messages.push({ role: 'user', content: `${check.error}。这是主人的强制命令，只能输出 stance="execute"（含合法白名单 tool）或 stance="infeasible"（必填具体 reason），请重新输出一行 JSON。` });
          continue;
        }
        if (check.infeasible !== undefined) {
          this.onChatStance?.({
            kind: 'command', text: cmd.text, stance: 'infeasible', reply: check.infeasible.reply, reason: check.infeasible.reason,
            ...(check.infeasible.alternative === undefined ? {} : { alternative: check.infeasible.alternative }),
          });
          this.activeCommand = null;
          this.brainSwitch.recordSuccess();
          this.handoverSummary = null;
          return check.infeasible.decision;
        }
        if (check.acknowledged === true) {
          cmd.acknowledged = true;
          this.onChatStance?.({ kind: 'command', text: cmd.text, stance: 'execute', reply: parsed?.reply ?? parsed?.intent ?? cmd.text });
        }
        if (check.commandDone === true) cmd.pendingDone = true;
      }

      if (parsed === null || parsed.tool === undefined || !this.allowedTools.has(parsed.tool)) {
        parseAttempts += 1;
        const why = parsed === null || parsed.tool === undefined ? '输出中没有解析出包含非空 tool 的一行 JSON' : `"${parsed.tool}" 不在 BWF 工具白名单内`;
        if (this.brainSwitch.recordParseFailure(why)) return this.standinDecision(state);
        messages.push({ role: 'assistant', content: rawContent });
        messages.push({ role: 'user', content: `${why}。只可调用白名单工具：${[...this.allowedTools].join(', ')}。请重新决定下一步，只输出一行 JSON。` });
        continue;
      }

      this.brainSwitch.recordSuccess();
      this.handoverSummary = null;
      this.applyAcceptedMetadata(dayKey, parsed);
      if (parsed.tool === 'sleep') await this.maybeReflectNight(state, dayKey, personaPrompt);
      return { kind: 'act', tool: parsed.tool, args: parsed.args, intent: parsed.intent };
    }
    return this.standinDecision(state);
  }

  private applyAcceptedMetadata(dayKey: string, parsed: NonNullable<ReturnType<typeof parseAutonomousDecision>>): void {
    if (parsed.planUpdate !== undefined) {
      const updated = this.dayPlanStore.applyUpdate(dayKey, parsed.planUpdate);
      if (updated !== null) {
        this.onPlan?.({
          dayKey, plan: updated.items,
          ...(updated.mood === undefined ? {} : { mood: updated.mood }),
          ...(updated.updateWhy === undefined ? {} : { updateWhy: updated.updateWhy }),
          reason: 'update',
        });
      }
    }
    if (parsed.insight !== undefined) {
      const saved = this.notebook.upsert(dayKey, parsed.insight);
      this.onInsight?.({ action: 'learned', dayKey, insight: saved, notebookCount: this.notebook.size(), insights: this.notebook.list() });
    }
    if (parsed.usedInsight !== undefined) {
      const hit = this.notebook.recordHit(parsed.usedInsight, dayKey);
      if (hit !== null) {
        this.onInsight?.({
          action: 'used', dayKey, insight: hit, usedInsight: hit.id,
          ...(parsed.tool === undefined ? {} : { tool: parsed.tool }),
          notebookCount: this.notebook.size(), insights: this.notebook.list(),
        });
      }
    }
    if (this.pendingSuggestion !== null && parsed.stance !== undefined && SUGGESTION_STANCES.has(parsed.stance)) {
      const suggestion = this.pendingSuggestion;
      this.pendingSuggestion = null;
      this.onChatStance?.({ kind: 'suggestion', text: suggestion.text, stance: parsed.stance as 'accept' | 'modify' | 'decline', reply: parsed.reply ?? parsed.intent });
    }
    if (parsed.objectiveDone === true && this.objective !== null) {
      this.objectiveDonePending = this.objective;
      this.objective = null;
      this.objectiveRounds = 0;
    }
  }

  private async decideForAdapter(state: GameStateSnapshot, systemPrompt: string): Promise<PlannerDecision> {
    this.askCount += 1;
    const messages = buildAdapterDecisionMessages({
      systemPrompt, stateRaw: state.raw, recentReceipts: this.deps.recentReceipts ?? [],
      lastFailSignature: this.lastFailSignature, extraContext: this.teamAndObjectiveContext(),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.deps.chat(this.deps.slot ?? 'STARDEW_GAME_PLANNER', messages, { maxTokens: 1200 });
        const decision = extractDecisionJson(res.content);
        if (decision !== null && this.allowedTools.has(decision.tool)) {
          if (decision.objectiveDone === true && this.objective !== null) {
            this.objectiveDonePending = this.objective; this.objective = null; this.objectiveRounds = 0;
          }
          return { kind: 'act', tool: decision.tool, args: decision.args, intent: decision.intent };
        }
        const reason = decision === null ? '上一条输出里没有解析出 {"tool":...} 一行 JSON' : `"${decision.tool}" 不在当前游戏白名单里`;
        messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: `${reason}。只可调用这些工具：${[...this.allowedTools].join(', ')}。重新选择一个动作，只输出一行 JSON。` });
      } catch { /* 网关错误重试一次后按安全策略停机或显式兜底 */ }
    }
    if (this.deps.allowRuleStandin !== true) {
      return { kind: 'wait', seconds: 15, reason: 'AI 适配器规划异常，已安全暂停高级自主决策（未启用规则兜底）' };
    }
    const fallback = await this.fallback.decide(state);
    return fallback.kind === 'act' ? { ...fallback, intent: `规则兜底：${fallback.intent}` } : fallback;
  }
}
