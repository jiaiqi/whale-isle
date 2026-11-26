/**
 * autodrive 宿主接线（T-M5-02 宿主层）：主进程持有 AutodriveRunner，
 * 事件单源多播到 director + pet-stage 两窗（webContents.send，preload 桥中继）。
 * 启停由 Shell 显式触发（用户不在游戏时不自动跑）。
 */
import { app, ipcMain, type WebContents } from 'electron';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutodriveRunner,
  gameAdapters,
  LlmPlanner,
  PausedBrainPlanner,
  RulePlanner,
  type AutodriveEvent,
  type BrainMode,
  type DayPlanSnapshot,
  type GameAdapter,
  type GameId,
  type StrategyInsight,
} from '@workbench/game-bridge-mcp';
import { ModelGateway } from '@workbench/model-gateway';
import {
  BrainRuntimeConfigSchema,
  DiningProfilePresetSchema,
  type BrainRuntimeConfig,
  type DiningProfilePreset,
  type WorkbenchRoleSlot,
} from '@workbench/shared-protocol';
import { stripThink } from '@workbench/persona-brain';
import { readVaultKey } from './provider-vault';
import { pushBwfPlayerInControl } from './bwf-settings'; // T-M6-73 临时接管同步到游戏侧
import { currentPersonaPrompt, currentPersonaReflex } from './character-persona'; // T-M6-21 多角色口吻与 persona-brain 雷区钩子
import { createTokenMeter } from './token-meter';
import { dayKeyOf, type MemoryHost } from './memory-host';
import {
  buildDirectiveSystemPrompt,
  buildDirectiveUserPrompt,
  classifyChatInput,
  isCancelDirective,
  parseDirectiveResponse,
  resolveKeywordDirective,
  STARDEW_DIRECTIVE_PROFILE,
  type ChatOrder,
  type DirectiveProfile,
} from './chat-directive';
import type { VoiceHost, VoiceScene } from './voice-host';
import type { CharacterRegistry } from './character-registry';
import type { ChatMessageContent, PetCharacter, PetAvatarManifest } from '@workbench/shared-protocol';

export interface AutodriveHost {
  readonly runner: AutodriveRunner;
  /** 广播目标（两窗 webContents；窗口重建后由 main 更新） */
  setTargets(targets: WebContents[]): void;
  /** 与 Shell 聊天同款回话（WebUI /api/command 复用；人设雷区 0-token 反射） */
  say(text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }>;
  /** 外部订阅总线事件（WebUI WS 推送）；订阅即回放最近 100 条，返回退订函数 */
  subscribe(listener: (event: AutodriveEvent & { seq: number }) => void): () => void;
  /** 当前大脑模式（WebUI 快照用） */
  getBrainMode(): { mode: BrainMode; llmReady: boolean };
  /** 当前接管的游戏（M7 多游戏；默认 stardew） */
  getGameId(): GameId;
  /** T-M6-39：联机 Agent 复用同一 Gateway/key/饭碗，但各自独立 LlmPlanner 实例 */
  createPlanner(slot: WorkbenchRoleSlot, options?: {
    fallbackPlanner?: ConstructorParameters<typeof LlmPlanner>[0]['fallbackPlanner'];
    toolWhitelist?: readonly string[];
    systemPrompt?: string;
    personaPrompt?: string;
    contextProvider?: () => string;
  }): LlmPlanner | null;
  /** token-meter 当前可用余量（供协商预算护栏使用） */
  tokenBalance(): number;
  /** 饭碗当前状态快照（供桌宠右键菜单读取） */
  riceStatus(): { balance: number; budget: number; consumedToday: number; level: string };
  /** 投喂加饭（供桌宠右键菜单直接复用） */
  feedRice(grains: number): { balance: number; budget: number; consumedToday: number; level: string };
  /** 一键启停当前游戏自驾（供桌宠右键菜单直接复用） */
  toggleDrive(): Promise<{ ok: boolean; running: boolean; error?: string }>;
  /** 动态更新星露谷主端点（修改 BWF 端口后热重建 runner，无需重启工作台） */
  setEndpoint(nextEndpoint: string): Promise<void>;
  /** T-M6-39：联机协商/指令解析复用当前 Gateway 与饭碗计量；未配置 Key 返回 null */
  completeForCoop(
    slot: WorkbenchRoleSlot,
    system: string,
    user: string,
    maxTokens?: number,
  ): Promise<{ content: string; tokensUsed: number } | null>;
  /** V2-P3-04E：多模态聊天通道（Digital Life 内容理解复用同一 Gateway/Key/饭碗计量）；网关未就绪返回 null */
  chatViaGateway(
    slot: WorkbenchRoleSlot,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: ChatMessageContent }>,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<{ content: string; modelId: string } | null>;
}

/** 游戏 → 规划器角色槽位（M7：槽位名按游戏分组，不改星露谷原名） */
const PLANNER_SLOTS: Record<GameId, WorkbenchRoleSlot> = {
  stardew: 'STARDEW_GAME_PLANNER',
  terraria: 'TERRARIA_GAME_PLANNER',
  dst: 'DST_GAME_PLANNER',
};

const DEFAULT_GUIDE_TOPICS = [
  '钓鱼', '采矿', '节日', '结婚', '沙漠', '姜岛', '农场类型',
  '开局前几周', '四季作物收益', '社区中心收集包', '赚钱路线', '工具升级',
];

function loadGuidesFromDirectory(dir: string, extraTopics: readonly string[]): Record<string, string> {
  const topics = new Set<string>(extraTopics);
  try {
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.md') && file.toLowerCase() !== 'readme.md') topics.add(file.slice(0, -3));
    }
  } catch { /* 目录不存在时按声明专题尝试读取，全部缺失则返回空 */ }
  const guides: Record<string, string> = {};
  for (const topic of topics) {
    try { guides[topic] = readFileSync(join(dir, `${topic}.md`), 'utf8'); } catch { /* 缺失专题跳过 */ }
  }
  return guides;
}

export function resolveGuideDirectory(
  isPackaged: boolean,
  resourcesPath: string,
  mainUrl: string = import.meta.url,
): string {
  return isPackaged
    ? join(resourcesPath, 'guide-forager')
    : join(dirname(fileURLToPath(mainUrl)), '../../../../guide-forager');
}

export function dayKeyExtractorFor(gameId: GameId): (gameClock: string) => string {
  if (gameId === 'stardew') return dayKeyOf;
  if (gameId === 'terraria') {
    return (gameClock) => `terraria-${/第\s*(\d+)\s*天/.exec(gameClock)?.[1] ?? gameClock.slice(0, 12)}`;
  }
  return (gameClock) => `dst-${/第\s*(\d+)\s*轮/.exec(gameClock)?.[1] ?? gameClock.slice(0, 12)}`;
}

function directiveProfileFor(gameId: GameId, adapter: GameAdapter): DirectiveProfile {
  if (gameId === 'stardew') return STARDEW_DIRECTIVE_PROFILE;
  const isTerraria = gameId === 'terraria';
  return {
    gameName: isTerraria ? '泰拉瑞亚' : '饥荒联机版（DST）',
    keywords: [],
    toolDoc: isTerraria
      ? '先读 get_state；挖掘 mine {"target":"tree|copper"}，移动 move_to {"x":坐标,"y":坐标}，战斗 attack {"target":目标}，搭建 build_shelter，插火把 torch，喝药 drink_potion，撤退 flee，等待 wait {"seconds":秒数}。'
      : '先读 get_state；采集 gather {"item":物品}，移动 move_to {"x":坐标,"z":坐标}，进食 eat {"item":物品}，战斗 attack {"target":目标}，建火堆 place_campfire，添柴 add_fuel，制作 craft {"recipe":配方}，等待 wait {"seconds":秒数}。',
    whitelist: new Set(adapter.toolWhitelist ?? []),
  };
}

/** 角色短名：去掉括号后缀，供语音 speakerName 与提示词使用。 */
export function characterShortName(character: PetCharacter | undefined): string {
  return character?.displayName.split('（')[0] ?? '小鲸';
}

/** 9 角色平权 seam：当前注册表角色 → 其真实 manifest（IPC 与测试共用）。 */
export function selectedCharacterManifest(registry: CharacterRegistry | undefined): { ok: true; manifest: PetAvatarManifest; character: PetCharacter } | { ok: false; error: string } {
  if (registry === undefined) return { ok: false, error: '角色注册表未接线' };
  const selected = registry.selected();
  const found = registry.manifestOf(selected);
  return found.ok ? { ok: true, manifest: found.manifest, character: selected } : { ok: false, error: found.error };
}

/** speak() 的角色声线透传：characterId / speakerName / voiceId / 语速音高一处构造。 */
export function voiceSceneForCharacter(scene: { text: string; scene?: 'normal' | 'inner' | 'p0' }, character: PetCharacter | undefined): VoiceScene {
  return {
    ...scene,
    ...(character === undefined ? {} : {
      characterId: character.id,
      speakerName: characterShortName(character),
      voiceId: character.voiceId,
      ratePercent: character.voiceRatePercent,
      pitchMul: character.voicePitchMul,
    }),
  };
}

export function createAutodriveHost(
  endpoint: string | undefined = undefined,
  vaultPath?: string,
  voiceHost?: VoiceHost,
  memoryHost?: MemoryHost,
  gameId: GameId = 'stardew',
  initialDirectiveProfile?: DirectiveProfile,
  /** 与联机协作互斥：返回非空字符串表示本端被其他 Runner 占用，拒绝启动 */
  canStart?: () => string | null,
  characterRegistry?: CharacterRegistry,
): AutodriveHost {
  const shortNameOf = characterShortName;
  const shortReplyPool: Record<string, { uncertain: string; fish: string }> = {
    'blue-whale-maid': { uncertain: '都、都怪这块石头突然长出来的！', fish: '钓到啦！本鱼的手感是天赋！' },
    'aboutme-dsh': { uncertain: '不是蓝蓝的错，是这块石头自己滚过来的。', fish: '鱼上钩啦，蓝蓝的手感也很好嘛！' },
    'aboutme-dsh1': { uncertain: '失误！活力装只是需要热个身。', fish: '钓到啦！活力全开！' },
    'aboutme-gpt': { uncertain: '这是环境变量异常，不是判断失误。', fish: '钓鱼成功，结果符合预期。' },
    'aboutme-claude': { uncertain: '先别急着下结论，这块石头的位置确实不合理。', fish: '鱼钓到了，过程很顺利。' },
    'aboutme-gemini': { uncertain: '哎呀，被石头抢先一步了。', fish: '钓到鱼啦，要不要看看它？' },
    'aboutme-qwen': { uncertain: '按计划不该撞上的，下一步我重新规划。', fish: '钓鱼完成，收益已记录。' },
    'aboutme-glm': { uncertain: '狐狸耳朵早听到石头在动了，只是没躲开。', fish: '鱼儿上钩，正事办成。' },
    'aboutme-grok': { uncertain: '石头先动的手，这锅我不接。', fish: '钓到了，别问我为什么这么强。' },
    'aboutme-kimi': { uncertain: '这次记录为环境干扰，不是操作失误。', fish: '钓到鱼了，我把过程记下来了。' },
  };
  /** 未登记角色的中性短评：不借用小鲸口吻，避免角色身份串味。 */
  const GENERIC_SHORT_REPLY = { uncertain: '这次没成功，我换个办法再来。', fish: '成功啦，继续！' };
  const characterNow = (): PetCharacter | undefined => characterRegistry?.selected();
  const shortReply = (kind: 'uncertain' | 'fish'): string => {
    const character = characterNow();
    return (shortReplyPool[character?.id ?? ''] ?? GENERIC_SHORT_REPLY)[kind];
  };

  const windows: WebContents[] = [];
  const initialGameId = gameId;
  let adapter = gameAdapters.create(gameId, endpoint === undefined ? {} : { endpoint });
  let directiveProfile = initialDirectiveProfile ?? directiveProfileFor(gameId, adapter);
  let runner: AutodriveRunner;
  memoryHost?.setDayKeyExtractor(dayKeyExtractorFor(gameId));

  // ---- LLM 大脑（vault key → model-gateway → LlmPlanner） ----
  // 默认套餐仅作为「从未同步过配置」的兜底；渲染层会把 Dexie 里的真实套餐/槽位通过 brain:apply-config 同步进来。
  const FALLBACK_PROFILE: DiningProfilePreset = DiningProfilePresetSchema.parse({
    profileId: 'DELUXE_LIVESTREAM',
    displayName: 'LIVE 档',
    roleBindings: {
      MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-flash',
      STARDEW_GAME_PLANNER: 'deepseek-official/deepseek-flash',
      TERRARIA_GAME_PLANNER: 'deepseek-official/deepseek-flash',
      DST_GAME_PLANNER: 'deepseek-official/deepseek-flash',
      DANMAKU_FAST_ROUTER: 'deepseek-official/deepseek-flash',
      VISION_STORYBOARD: 'deepseek-official/deepseek-flash',
      VOICE_TTS_SPEECH: 'deepseek-official/deepseek-flash',
      VOICE_SVC_SINGING: 'deepseek-official/deepseek-flash',
    },
    secretMaskingEnabled: true,
  });
  let brainMode: 'rule' | 'llm' = 'llm'; // 默认 LLM 大脑（llmPlanner 未就绪时自动回落规则）
  let gateway: InstanceType<typeof ModelGateway> | null = null;
  let llmPlanner: LlmPlanner | null = null;
  let activeProfile: DiningProfilePreset = FALLBACK_PROFILE;
  let brainProviders: string[] = [];
  let brainMissingKeys: string[] = [];
  let recentReceipts: string[] = [];
  /** 主人刚下的单（T-M6-53）：执行失败要把原因回灌到聊天/气泡，避免「只回复不办事」的感知 */
  let pendingChatOrder: { tool: string; intent: string } | null = null;
  /** 当前生效的多步目标：新单步指令/「算了」/切换游戏时清空，防止旧目标继续驱动 */
  let activeObjective: string | null = null;
  let lastGameClock = '';
  let eventSeq = 0;
  // T-M6-27（多游戏/多端点隔离）：会话代次——切换游戏或重建 runner 时递增；
  // 渲染层忽略 generation 低于当前值的事件，避免旧 runner 的迟到事件混入新会话。
  let generation = 0;
  let activeSessionId = '';
  type ScopedEvent = AutodriveEvent & { seq: number; sessionId: string; gameId: GameId; generation: number };
  const eventHistory: ScopedEvent[] = [];
  const busListeners = new Set<(event: ScopedEvent) => void>();

  // 饭碗：真实 token 计量（1 粒米 = 1 Token，日预算 500,000）；流水落 userData/meter/token-ledger.jsonl
  const meter = createTokenMeter({ dir: vaultPath ? join(dirname(vaultPath), 'meter') : join(process.cwd(), '.workbench-meter') });
  let riceStatus = meter.status();
  let riceBalance = riceStatus.balance;
  let riceLevel: string = riceStatus.level;

  interface BrainApplyResult {
    ok: boolean;
    mode: BrainMode;
    llmReady: boolean;
    providers: string[];
    missingKeys: string[];
    error?: string;
  }

  /** 用给定套餐重建 gateway/planner（key 只从主进程 vault 解密，绝不来自渲染层） */
  const buildBrain = (config?: BrainRuntimeConfig): BrainApplyResult => {
    const candidate = config?.profile ?? activeProfile ?? FALLBACK_PROFILE;
    const parsed = DiningProfilePresetSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, mode: 'rule', llmReady: false, providers: [], missingKeys: [], error: '套餐配置不合法（Schema 校验失败）' };
    }
    const profile = parsed.data;
    // 槽位里的 provider/model：模型段为空时用供应商卡里选中的 activeModelId 兜底
    const bindings: Partial<Record<WorkbenchRoleSlot, string>> = {};
    const providerIds = new Set<string>();
    for (const [slot, binding] of Object.entries(profile.roleBindings)) {
      if (typeof binding !== 'string' || binding.trim() === '') continue;
      const [providerId, modelPart] = binding.split('/');
      if (providerId === undefined || providerId === '') continue;
      const model = (modelPart ?? '').trim() === '' ? (config?.providerModels?.[providerId] ?? '') : (modelPart ?? '');
      if (model === '') continue;
      bindings[slot as WorkbenchRoleSlot] = `${providerId}/${model}`;
      providerIds.add(providerId);
    }
    const nextProfile: DiningProfilePreset = { ...profile, roleBindings: bindings };

    const keys: Record<string, string> = {};
    const missingKeys: string[] = [];
    for (const providerId of providerIds) {
      const key = vaultPath ? readVaultKey(vaultPath, providerId) : null;
      if (key === null) missingKeys.push(providerId);
      else keys[providerId] = key;
    }
    activeProfile = nextProfile;
    brainProviders = Object.keys(keys);
    brainMissingKeys = missingKeys;
    // Key 可用性只看实际解析结果：开发态环境变量兜底在 safeStorage 不可用时仍可支撑 LLM；
    // 解密失败会由 provider-vault 启动日志与服务商页状态如实上报，这里不再用 safeStorage 二次拦截。
    if (Object.keys(keys).length === 0) {
      gateway = null;
      llmPlanner = null;
      return { ok: false, mode: 'paused', llmReady: false, providers: [], missingKeys, error: '没有可用的供应商 Key（已安全暂停高级自主决策，未启用规则代驾）' };
    }
    gateway = new ModelGateway({
      profile: nextProfile,
      keys,
      ...(config?.providers !== undefined && config.providers.length > 0 ? { providers: config.providers } : {}),
      onUsage: (usage) => {
        const recorded = meter.recordUsage({
          slot: String(usage.slot),
          providerId: usage.providerId,
          modelId: usage.modelId,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          latencyMs: usage.latencyMs,
        });
        riceStatus = recorded.status;
        riceBalance = riceStatus.balance;
        broadcastRice(riceStatus.level);
      },
    });
    const notesDir = vaultPath ? join(dirname(vaultPath), 'stardew-notes') : undefined;
    let initialGuides: Record<string, string> = {};
    if (gameId === 'stardew') {
      try {
        const dir = resolveGuideDirectory(app.isPackaged, process.resourcesPath, import.meta.url);
        initialGuides = loadGuidesFromDirectory(dir, [...(adapter.guideTopics ?? []), ...DEFAULT_GUIDE_TOPICS]);
      } catch { initialGuides = {}; }
    }
    llmPlanner = new LlmPlanner({
      chat: (slot, messages, opts) =>
        gateway!.chat(slot as never, messages, { maxTokens: opts?.maxTokens }).catch((error: unknown) => {
          console.error('[llm-planner] gateway.chat 失败:', error instanceof Error ? error.message : String(error));
          throw error;
        }),
      recentReceipts,
      guides: initialGuides,
      ...(notesDir === undefined ? {} : { notesDir }),
      slot: PLANNER_SLOTS[gameId],
      fallbackPlanner: adapter.createRulePlanner?.() ?? new RulePlanner(),
      ...(adapter.toolWhitelist !== undefined ? { toolWhitelist: adapter.toolWhitelist } : {}),
      isKeyAvailable: () => brainProviders.length > 0,
      personaPrompt: () => characterNow()?.personaPrompt ?? '',
      onInsight: (ev) => {
        broadcastCurrent({ type: 'insight', ...ev } as unknown as AutodriveEvent);
      },
      ...(gameId === 'stardew' ? {} : {
        // 惰性求值：角色在运行中热切换时，下一次规划立刻使用新角色名（T-M6-51）
        systemPrompt: () => [
          `你是${shortNameOf(characterNow())}，正在替主人游玩《${directiveProfile.gameName}》。`,
          directiveProfile.toolDoc,
          `只可调用当前游戏白名单工具：${(adapter.toolWhitelist ?? []).join(', ')}。`,
          '一次只执行一个动作。只输出一行 JSON：{"tool":"工具名","args":{参数},"intent":"一句话说明"}。',
        ].join('\n'),
      }),
    });
    brainMode = 'llm';
    return { ok: true, mode: brainMode, llmReady: true, providers: brainProviders, missingKeys };
  };
  const effectiveBrainMode = (): BrainMode => {
    if (brainMode === 'rule') return 'rule';
    if (llmPlanner === null || llmPlanner.isPaused()) return 'paused';
    if (llmPlanner.isStandin()) return 'rule-standin';
    return 'llm';
  };
  ipcMain.handle('planner:switch', (_e, mode: string) => {
    if (mode === 'llm' && !llmPlanner) {
      return { ok: false, error: 'LLM 大脑未就绪（供应商 key 未配置或未重启工作台）' };
    }
    brainMode = mode === 'llm' ? 'llm' : 'rule';
    llmPlanner?.brainSwitch.setUserMode(brainMode);
    applyPlanner();
    return { ok: true, mode: effectiveBrainMode() };
  });
  ipcMain.handle('planner:status', (): {
    mode: BrainMode;
    userMode: 'llm' | 'rule';
    llmReady: boolean;
    providers: string[];
    missingKeys: string[];
    dayPlan: DayPlanSnapshot | null;
    insights: StrategyInsight[];
    saveName: string;
  } => ({
    mode: effectiveBrainMode(),
    userMode: brainMode,
    llmReady: llmPlanner !== null,
    providers: brainProviders,
    missingKeys: brainMissingKeys,
    dayPlan: llmPlanner?.dayPlanStore.snapshot() ?? null,
    insights: llmPlanner?.notebook.list() ?? [],
    saveName: llmPlanner?.notebook.getSaveName() ?? 'default',
  }));

  // 聊天回话（D3）：雷区反射先行（不烧主脑）→ 主脑回话 → 广播两窗
  // T-M6-17：对话驱动游戏行为——指令解析（关键词/LLM 状态感知）移入纯模块 ./chat-directive（可单测），
  // say() 改为「指令先行串行」：先解析接不接单 → 回话注入接单 ack（说到做到）→ 接单自动拉起自驾下发。
  // 每次回话都读取当前角色与游戏，不在宿主启动时缓存人设提示词。
  const personaSystemPrompt = (): string => {
    const prompt = currentPersonaPrompt();
    const gameTitle = `《${directiveProfile.gameName}》`;
    return /《[^》]+》/.test(prompt) ? prompt.replace(/《[^》]+》/g, gameTitle) : `${prompt}\n当前游玩的游戏：${gameTitle}`;
  };

  /** 聊天/反射等宿主自产事件：归属当前会话（T-M6-27） */
  const broadcastCurrent = (event: AutodriveEvent): void => {
    broadcast(event, { sessionId: activeSessionId, gameId, generation });
  };
  const say = async (text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }> => {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: '空消息' };
    const reflex = currentPersonaReflex(text);
    if (reflex !== null) {
      broadcastCurrent({ type: 'receipt', tool: `reflex_${reflex.actionState}`, status: 'COMPLETED', summary: reflex.response } as AutodriveEvent);
      speak({ text: reflex.response, scene: 'p0' });
      return { ok: true, reply: reflex.response, reflex: true };
    }

    const classified = classifyChatInput(text);

    // 1) 快捷命令（/goto /fish /sleep /forage /state /stop）：直达工具，不经 LLM
    if (classified.kind === 'shortcut') {
      if (classified.tool === 'cancel_action') {
        await runner.lock.cancel('slash-stop').catch(() => undefined);
        broadcastCurrent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: classified.intent } as AutodriveEvent);
        return { ok: true, reply: classified.intent };
      }
      if (!runner.isRunning()) {
        try {
          await runner.start();
          broadcastCurrent({ type: 'receipt', tool: 'autodrive', status: 'COMPLETED', summary: '快捷指令触发，自动驾驶已启动' } as AutodriveEvent);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          broadcastCurrent({ type: 'watchdog', kind: 'heartbeat', detail: `快捷指令无法启动自驾：${msg}` } as AutodriveEvent);
          return { ok: false, error: msg };
        }
      }
      runner.submitDirective(classified.tool, classified.args, classified.intent);
      broadcastCurrent({ type: 'decision', planner: 'remote', tool: classified.tool, args: classified.args, intent: classified.intent } as AutodriveEvent);
      return { ok: true, reply: classified.intent };
    }

    // 2) /cancel 或有活跃目标/命令时的取消语
    if (classified.kind === 'cancel' || (activeObjective !== null && isCancelDirective(text))) {
      const previous = activeObjective;
      activeObjective = null;
      pendingChatOrder = null;
      const cancelledCmd = runner.cancelCommand();
      const clearedObj = runner.clearObjective();
      const label = cancelledCmd !== null ? `/${cancelledCmd}` : (previous ?? '当前目标');
      if (cancelledCmd !== null || clearedObj) {
        broadcastCurrent({ type: 'objective', objective: null, reason: 'cancel' } as AutodriveEvent);
        broadcastCurrent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: `已取消强制命令/目标：${label}` } as AutodriveEvent);
      }
      const cancelReply = cancelledCmd !== null || clearedObj
        ? `好啦，已经取消「${label}」，我继续按自己的计划来～`
        : '当前没有正在执行的强制命令或目标哦～';
      broadcastCurrent({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: cancelReply } as AutodriveEvent);
      speak({ text: cancelReply, scene: 'normal' });
      return { ok: true, reply: cancelReply };
    }

    const llmOnline = gateway !== null && brainMode === 'llm' && llmPlanner !== null && !llmPlanner.isUnavailable();

    // 3) `/自然语言` 强制命令（T-M6-70 §4.3：LLM 在线时只允许 execute/infeasible；离线时走关键词或如实告知）
    if (classified.kind === 'command') {
      if (!llmOnline) {
        const kw = resolveKeywordDirective(classified.command, directiveProfile);
        if (kw === null) {
          const offlineReply = '大脑离线，现在只能执行快捷命令（/goto /fish /sleep /forage /state /stop）。';
          broadcastCurrent({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: offlineReply } as AutodriveEvent);
          speak({ text: offlineReply, scene: 'normal' });
          return { ok: true, reply: offlineReply };
        }
        if (!runner.isRunning()) {
          try {
            await runner.start();
          } catch (error) {
            const offlineErr = `大脑离线且游戏未连上（${error instanceof Error ? error.message : String(error)}），暂时执行不了。`;
            broadcastCurrent({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: offlineErr } as AutodriveEvent);
            return { ok: true, reply: offlineErr };
          }
        }
        runner.submitDirective(kw.tool, kw.args, kw.intent);
        const ack = `大脑离线，已按关键词执行：${kw.intent.replace('主人指令：', '')}`;
        broadcastCurrent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: `${kw.tool}｜${kw.intent}` } as AutodriveEvent);
        broadcastCurrent({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: ack } as AutodriveEvent);
        speak({ text: ack, scene: 'normal' });
        return { ok: true, reply: ack };
      }

      if (!runner.isRunning()) {
        try {
          await runner.start();
          broadcastCurrent({ type: 'receipt', tool: 'autodrive', status: 'COMPLETED', summary: '收到强制命令，自动驾驶已启动' } as AutodriveEvent);
        } catch (error) {
          const msg = `游戏还没启动或未连上（${error instanceof Error ? error.message : String(error)}），等进存档后再发强制命令吧～`;
          broadcastCurrent({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: msg } as AutodriveEvent);
          speak({ text: msg, scene: 'normal' });
          return { ok: true, reply: msg };
        }
      }
      activeObjective = `/${classified.command}`;
      runner.submitCommand(classified.command);
      broadcastCurrent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: `强制命令：/${classified.command}` } as AutodriveEvent);
      return { ok: true, reply: `已下达强制命令：/${classified.command}` };
    }

    // 4) 普通非 `/` 聊天消息
    if (!gateway) return { ok: false, error: '主脑未接通（供应商 key 未配置）' };

    // 星露谷 + 自驾运行中 + LLM 自主模式在线：消息作为「主人建议」交给规划器下一轮自主表态（accept/modify/decline + reply）
    if (gameId === 'stardew' && runner.isRunning() && llmOnline) {
      runner.submitSuggestion(classified.text);
      return { ok: true, reply: '' };
    }

    // 非星露谷（M7 冻结泳道）保留原有对话指令兼容；星露谷自驾未启动时做纯日常对话，不假装下发游戏动作
    let order: ChatOrder | null = null;
    let gameOffline = false;
    let directiveError: string | null = null;
    if (gameId !== 'stardew') {
      try {
        const keywordHit = resolveKeywordDirective(text, directiveProfile);
        if (keywordHit !== null) {
          order = keywordHit;
        } else {
          let stateRaw: string | null = null;
          try {
            const stateRes = await runner.client.callTool('get_state', {}, { timeoutMs: 15_000 });
            stateRaw = stateRes.kind === 'ok' ? stateRes.text : null;
          } catch {
            stateRaw = null;
          }
          if (stateRaw === null) {
            gameOffline = true;
          } else {
            const r = await gateway.chat(PLANNER_SLOTS[gameId], [
              { role: 'system', content: buildDirectiveSystemPrompt(directiveProfile, shortNameOf(characterNow())) },
              { role: 'user', content: buildDirectiveUserPrompt(text, { raw: stateRaw }) },
            ], { maxTokens: 200 });
            const parsed = parseDirectiveResponse(r.content, directiveProfile);
            if (parsed !== null) order = { ...parsed, intent: `主人指令：${parsed.intent}` };
          }
        }
      } catch (error) {
        directiveError = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      const memoryContext = memoryHost?.contextFor(text) ?? '';
      const ackHint = gameId === 'stardew'
        ? '\n\n【当前星露谷自动驾驶未运行（或处于纯规则模式）：主人的普通消息属于日常聊天沟通，不要声称自己马上在游戏里动手；若主人想强制命令游戏操作，可提醒主人开启自动驾驶或以 / 开头发送命令。】'
        : order === null
          ? (gameOffline
            ? '\n\n【游戏现在没有开：如果主人的话是想让你在游戏里做事，如实撒娇说等开游戏再办，别假装去做。】'
            : directiveError !== null
              ? `\n\n【指令解析没成功（${directiveError}）：如果主人是在给你下单，如实说没听清或没连上，别假装接单；纯闲聊照常回。】`
              : '')
          : order.kind === 'act'
            ? `\n\n【你刚刚接下单子并马上要在游戏里执行：${order.tool}（${order.intent.replace('主人指令：', '')}）。回话要自然承认这件事。】`
            : `\n\n【你刚刚接下主人的多步目标：「${order.objective}」，会持续去做直到完成。】`;
      const base = memoryContext === '' ? personaSystemPrompt() : `${personaSystemPrompt()}\n\n${memoryContext}\n（以上是你的长期记忆；回答时自然地使用，不要编造记忆里没有的事）`;
      const system = ackHint === '' ? base : `${base}\n${ackHint}`;
      const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ], { maxTokens: 260 });
      const replyVisible = stripVisible(receipt.content);
      broadcastCurrent({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: replyVisible } as AutodriveEvent);
      if (replyVisible !== '') speak({ text: replyVisible, scene: 'normal' });
      if (order !== null) {
        const orderLabel = order.kind === 'act' ? order.tool : `多步目标：${order.objective}`;
        broadcastCurrent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: `${orderLabel}｜${order.intent}` } as AutodriveEvent);
        pendingChatOrder = { tool: order.kind === 'act' ? order.tool : (order.firstTool ?? ''), intent: order.intent };
        if (!runner.isRunning()) {
          try {
            await runner.start();
          } catch (error) {
            broadcastCurrent({ type: 'watchdog', kind: 'heartbeat', detail: `接了单但自驾起不来：${error instanceof Error ? error.message : String(error)}` } as AutodriveEvent);
            return { ok: true, reply: replyVisible };
          }
        }
        if (order.kind === 'act') {
          runner.submitDirective(order.tool, order.args, order.intent);
        } else {
          activeObjective = order.objective;
          runner.submitObjective(order.objective, order.intent);
          if (order.firstTool !== undefined) {
            runner.submitDirective(order.firstTool, order.firstArgs ?? {}, order.intent);
          }
        }
      } else if (directiveError !== null) {
        broadcastCurrent({ type: 'watchdog', kind: 'heartbeat', detail: `指令解析失败（未接单）：${directiveError}` } as AutodriveEvent);
      }
      return { ok: true, reply: replyVisible };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ipcMain.handle('chat:say', (_e, text: string) => say(text));
  /** 当前多步目标快照（UI 目标条水合用，不触发任何动作） */
  ipcMain.handle('autodrive:objective-status', () => ({ ok: true, objective: activeObjective }));
  /** 一键取消目标（T-M6-57）：与聊天「算了」同源，走 runner.clearObjective 核实后如实播报。 */
  ipcMain.handle('autodrive:clear-objective', () => {
    const previous = activeObjective;
    if (previous === null) return { ok: true, had: false };
    activeObjective = null;
    pendingChatOrder = null;
    const cleared = runner.clearObjective();
    broadcastCurrent({ type: 'objective', objective: null, reason: 'cancel' } as AutodriveEvent);
    if (cleared) {
      broadcastCurrent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: `已取消多步目标：${previous}` } as AutodriveEvent);
    }
    return { ok: true, had: cleared, objective: previous };
  });
  ipcMain.handle('guides:load', () => {
    if (!llmPlanner) return { ok: false, error: 'LLM 大脑未就绪' };
    try {
      const dir = resolveGuideDirectory(app.isPackaged, process.resourcesPath, import.meta.url);
      const topicSeed = gameId === 'stardew'
        ? [...(adapter.guideTopics ?? []), ...DEFAULT_GUIDE_TOPICS]
        : (adapter.guideTopics ?? DEFAULT_GUIDE_TOPICS);
      const guides = loadGuidesFromDirectory(dir, topicSeed);
      llmPlanner.setGuides(guides);
      console.log('[guides:load] dir =', dir, '| loaded:', Object.keys(guides).length);
      return { ok: true, topics: Object.keys(guides) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // ---- T-M5-16（D16）pets 动作库：manifest 读取 + 预览转发 ----
  ipcMain.handle('pets:manifest', () => {
    try {
      if (characterRegistry !== undefined) {
        return selectedCharacterManifest(characterRegistry);
      }
      const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../renderer/pet-stage/assets/blue-whale-maid/manifest.json');
      return { ok: true, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // preview：actionState（槽位）或 clipId（ambient 单条）——转发给 pet-stage 窗
  ipcMain.handle('pets:preview', (_e, action: string, clipId: string | null) => {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('pet:preview', { action, clipId });
    }
    return { ok: true };
  });
  // ---- D16：饭碗档位联动（真实 token 扣米 → 档位广播 → 桌宠档位动作） ----
  const broadcastRice = (level: string): void => {
    // D16 边沿触发：仅档位变化时广播（同档持续不重复刷桌宠动作）
    if (level === riceLevel) return;
    riceLevel = level;
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('pet:rice', { level, balance: riceBalance });
    }
  };
  const initialBrain = buildBrain();
  void initialBrain;
  ipcMain.handle('rice:feed', (_e, grains: number) => {
    riceStatus = meter.feed(grains);
    riceBalance = riceStatus.balance;
    broadcastRice(riceStatus.level);
    return { ok: true, ...riceStatus };
  });
  ipcMain.handle('rice:status', () => ({ ...riceStatus, balance: riceBalance }));
  /**
   * 广播前统一清洗用户可见文本（2026-11-22）：LLM 有时会在 intent/summary 里原样带出
   * <think>内心戏</think> 标签——气泡是纯文本渲染，不剥就会把标签直接显示给主人。
   * 在单源多播处清洗一次，桌宠云朵泡/中控台事件流/WebUI 订阅全部受益；内心戏不当对话展示。
   */
  const stripVisible = (text: string): string => stripThink(text).visible.trim();
  const cleanEvent = (event: AutodriveEvent): AutodriveEvent => {
    if (event.type === 'decision') {
      return { ...event, intent: stripVisible(event.intent) };
    }
    if (event.type === 'receipt') {
      return { ...event, summary: stripVisible(event.summary) };
    }
    if (event.type === 'watchdog') {
      return { ...event, detail: stripVisible(event.detail) };
    }
    if (event.type === 'chat-stance') {
      return { ...event, reply: stripVisible(event.reply) };
    }
    return event;
  };
  const broadcast = (rawEvent: AutodriveEvent, meta: { sessionId: string; gameId: GameId; generation: number }): void => {
    const event = cleanEvent(rawEvent);
    // 环形缓冲（≤200 条）+ 单调 seq：中控台刷新后水合历史，不丢对话也不重复插卡
    // T-M6-27：每条事件强制携带会话归属，渲染层据此丢弃异会话/迟到事件
    const withSeq: ScopedEvent = { ...event, seq: ++eventSeq, ...meta };
    eventHistory.push(withSeq);
    if (eventHistory.length > 200) eventHistory.splice(0, eventHistory.length - 200);
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('autodrive:event', withSeq);
    }
    // 外部订阅（WebUI WS）：单个订阅者异常不拖垮主广播
    for (const listener of busListeners) {
      try {
        listener(withSeq);
      } catch {
        /* 订阅方自身问题，隔离 */
      }
    }
  };
  const speak = (v: { text: string; scene?: 'normal' | 'inner' | 'p0' }): void => {
    void voiceHost?.speak(voiceSceneForCharacter(v, characterNow()));
  };
  /** 单会话事件处理：T-M6-27 起每个 runner 绑定自己的 sessionId/gameId/generation，
   *  旧会话的迟到事件在此丢弃（语音/记忆/前端都不再受影响）。 */
  const makeRunnerEventHandler = (getMeta: () => { sessionId: string; gameId: GameId; generation: number }) =>
    (event: AutodriveEvent): void => {
      const meta = getMeta();
      if (meta.generation !== generation) return; // 旧会话销毁后的迟到事件：直接丢弃
      // T-M6-57：目标生命周期事件是宿主状态的单点事实源（set/cancel/done 都以它为准）
      if (event.type === 'objective') {
        activeObjective = event.objective;
        if (event.objective === null) pendingChatOrder = null;
      }
      // T-M6-70：当日计划生成或修订时，用人设口吻在气泡/聊天流播报一句
      if (event.type === 'plan') {
        const goals = event.plan.slice(0, 3).map((item) => item.goal).join('、');
        const line = event.reason === 'morning'
          ? `今日计划（${event.dayKey}）：${goals}${event.mood === undefined ? '' : ` —— ${event.mood}`}`
          : `计划调整：${event.updateWhy ?? goals}`;
        broadcast({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: line } as AutodriveEvent, meta);
        if (voiceHost?.config.enabled) speak({ text: line, scene: 'normal' });
      }
      // T-M6-70：LLM 对主人建议/强制命令的表态 → reply 走气泡与语音，stance 保留在事件流统计采纳率
      if (event.type === 'chat-stance') {
        const visible = stripVisible(event.reply);
        if (visible !== '') {
          broadcast({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: visible } as AutodriveEvent, meta);
          if (voiceHost?.config.enabled) speak({ text: visible, scene: 'normal' });
        }
      }
      if (event.type === 'receipt' && event.tool !== 'autodrive' && voiceHost?.config.enabled) {
        // 回执短评（D11 节流 8s 防刷）：翻车心虚 / 收获欢呼
        if (event.status === 'UNCERTAIN') speak({ text: shortReply('uncertain'), scene: 'normal' });
        else if (event.status === 'COMPLETED' && /fish|钓/.test(String(event.tool)) && /成功|完美/.test(String(event.summary))) {
          speak({ text: shortReply('fish'), scene: 'normal' });
        }
      }
      if (event.type === 'state' && typeof event.clock === 'string') lastGameClock = event.clock;
      if (event.type === 'receipt' && event.tool !== 'autodrive') {
        try {
          memoryHost?.onReceipt({
            summary: String(event.summary ?? '').slice(0, 120),
            tool: String(event.tool ?? ''),
            status: String(event.status ?? ''),
            gameClock: lastGameClock,
          });
        } catch {
          /* 记忆失败不影响主链路 */
        }
        const slice = event.tool === 'bundle_info' ? 400 : 80;
        recentReceipts.push(event.status + ' ' + event.tool + ': ' + (event.summary ?? '').slice(0, slice));
        if (recentReceipts.length > 8) recentReceipts = recentReceipts.slice(-8);
        llmPlanner?.setRecentReceipts(recentReceipts);
      }
      broadcast(event, meta);
      // 主人下单的失败回灌（T-M6-53）：失败回执照旧进事件流，再补一条聊天可见的「没办成 + 原因」，
      // 避免主人只看到一句「好嘞」却不知道游戏里为什么没动静。
      if (event.type === 'receipt' && pendingChatOrder !== null && event.tool === pendingChatOrder.tool) {
        const order = pendingChatOrder;
        pendingChatOrder = null;
        if (event.status !== 'COMPLETED') {
          const what = order.intent.replace('主人指令：', '');
          const detail = String(event.summary ?? '').slice(0, 120);
          broadcast({ type: 'receipt', tool: 'chat_order', status: 'FAILED', summary: `「${what}」没办成：${detail}` } as AutodriveEvent, meta);
          if (voiceHost?.config.enabled) speak({ text: `主人，${what}没办成……${detail.slice(0, 60)}`, scene: 'normal' });
        }
      }
    };
  const pausedPlanner = new PausedBrainPlanner('未配置可用供应商 Key，已安全暂停高级自主决策（可在右上角显式切为规则模式）');
  const selectConfiguredPlanner = () =>
    brainMode === 'rule'
      ? (adapter.createRulePlanner?.() ?? new RulePlanner())
      : (llmPlanner ?? pausedPlanner);

  const createRunner = (): AutodriveRunner => {
    // T-M6-27：每次重建 runner 都开启新会话代次；旧 runner 若仍有迟到事件，generation 不匹配会被丢弃
    const runnerGeneration = ++generation;
    const runnerGameId = gameId;
    let created: AutodriveRunner | null = null;
    const next = new AutodriveRunner(
      makeRunnerEventHandler(() => ({
        sessionId: created?.sessionId ?? '',
        gameId: runnerGameId,
        generation: runnerGeneration,
      })),
      {
        ...(endpoint === undefined ? {} : { endpoint }),
        generation: runnerGeneration,
        gameId: runnerGameId,
      },
      adapter,
    );
    created = next;
    activeSessionId = next.sessionId;
    next.setPlanner(selectConfiguredPlanner());
    return next;
  };
  runner = createRunner();

  ipcMain.handle('autodrive:start', async (_e, requestedGameId?: GameId) => {
    const blocked = canStart?.();
    if (blocked !== undefined && blocked !== null) return { ok: false, error: blocked };
    if (requestedGameId !== undefined && !gameAdapters.has(requestedGameId)) {
      return { ok: false, error: `未注册的游戏适配器：${String(requestedGameId)}` };
    }
    if (requestedGameId !== undefined && requestedGameId !== gameId) {
      try {
        await runner.stopAndWait();
        gameId = requestedGameId;
        adapter = gameAdapters.create(gameId, gameId === initialGameId && endpoint !== undefined ? { endpoint } : {});
        directiveProfile = gameId === initialGameId && initialDirectiveProfile
          ? initialDirectiveProfile
          : directiveProfileFor(gameId, adapter);
        memoryHost?.setDayKeyExtractor(dayKeyExtractorFor(gameId));
        recentReceipts = [];
        llmPlanner?.setRecentReceipts(recentReceipts);
        pendingChatOrder = null;
        lastGameClock = '';
        const previousMode = brainMode;
        buildBrain();
        if (previousMode === 'rule' && llmPlanner !== null) brainMode = 'rule';
        runner = createRunner();
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      await runner.start();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('autodrive:stop', async () => {
    const cancelled = await runner.emergencyStop('用户停止自动驾驶');
    return { ok: true, cancelled };
  });
  // T-M6-73 临时接管：进入时取消在飞动作并停掉决策/keepalive，只留 get_state 只读轮询；
  // 退出时把「主人接管期间发生了什么」的摘要交回 UI 与事件流。同时把开关同步到游戏侧
  // （BWF 补丁 playerInControl），让 AI 的动作被游戏真正拒绝，而不只是宿主不发指令。
  ipcMain.handle('autodrive:set-human-control', async (_e, active: unknown) => {
    const want = active === true;
    const summary = await runner.setHumanControl(want);
    // endpoint 形如 http://127.0.0.1:18088/mcp，/settings 在同端口的根路径
    const baseUrl = (endpoint ?? 'http://127.0.0.1:18088/mcp').replace(/\/mcp\/?$/, '');
    const pushed = await pushBwfPlayerInControl(want, baseUrl);
    let warning: string | undefined;
    if (!pushed.reachable) {
      warning = want
        ? 'AI 已停止决策与动作；游戏没连上（BWF 不可达），游戏内接管未下发，重连后可再点一次'
        : 'AI 已恢复决策；游戏没连上，游戏内仍可能处于接管态，回游戏后按 F7 交还';
    } else if (!pushed.supported) {
      warning = want
        ? 'AI 已停止决策与动作；BWF 未打 T-M6-73 补丁（旧 DLL 忽略 playerInControl），游戏内角色可能继续行动，请在游戏里按 F7'
        : 'AI 已恢复决策；旧 DLL 无法远程交还，请在游戏里按 F7';
    } else if (!pushed.applied) {
      warning = want
        ? 'AI 已停止决策与动作；游戏侧接管未确认生效，请在游戏里按 F7 复核'
        : 'AI 已恢复决策；游戏侧交还未确认，请在游戏里按 F7 复核';
    }
    return {
      ok: true,
      humanControl: runner.isHumanControl(),
      summary,
      gameSync: pushed,
      ...(warning === undefined ? {} : { warning }),
    };
  });
  ipcMain.handle('autodrive:directive', (_e, tool: string, args: Record<string, unknown>, intent: string, expectedSessionId?: string, expectedGeneration?: number) => {
    // T-M6-27 / V2-P1-06：校验会话与世代以及控制权租约，拒绝过期点击与接管期写入
    return runner.submitScopedDirective(
      tool,
      args ?? {},
      typeof intent === 'string' ? intent : '远程指令',
      {
        ...(expectedSessionId === undefined ? {} : { sessionId: expectedSessionId }),
        ...(typeof expectedGeneration === 'number' ? { generation: expectedGeneration } : {}),
      },
    );
  });
  ipcMain.handle('autodrive:status', () => ({
    running: runner.isRunning(),
    humanControl: runner.isHumanControl(),
    gameId,
    sessionId: activeSessionId,
    generation,
    events: [...eventHistory],
  }));

  // 初始/热切换后统一应用 planner（runner 已就绪；缺 Key 时挂载 PausedBrainPlanner，绝不静默切 RulePlanner）
  const applyPlanner = (): void => {
    runner.setPlanner(selectConfiguredPlanner());
  };
  applyPlanner();
  // 渲染层同步真实套餐/槽位（Dexie → 主进程）；key 只在主进程 vault 解密
  ipcMain.handle('brain:apply-config', (_e, payload: unknown) => {
    const parsed = BrainRuntimeConfigSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: '配置不合法（Schema 校验失败）', mode: effectiveBrainMode(), llmReady: llmPlanner !== null, providers: brainProviders, missingKeys: brainMissingKeys };
    const result = buildBrain(parsed.data);
    applyPlanner();
    return result;
  });

  return {
    get runner() {
      return runner;
    },
    setTargets(targets) {
      windows.length = 0;
      windows.push(...targets);
    },
    say,
    subscribe(listener) {
      // 订阅即回放环形缓冲尾部（WebUI 晚连也能看到当前对话上下文）
      for (const event of eventHistory.slice(-100)) listener(event);
      busListeners.add(listener);
      return () => {
        busListeners.delete(listener);
      };
    },
    getBrainMode() {
      return { mode: effectiveBrainMode(), llmReady: llmPlanner !== null };
    },
    getGameId() {
      return gameId;
    },
    createPlanner(slot, plannerOptions = {}) {
      if (gateway === null) return null;
      return new LlmPlanner({
        slot,
        chat: (requestedSlot, messages, opts) =>
          gateway!.chat(requestedSlot as never, messages, { maxTokens: opts?.maxTokens }).catch((error: unknown) => {
            console.error('[coop-planner] gateway.chat 失败:', error instanceof Error ? error.message : String(error));
            throw error;
          }),
        ...(plannerOptions.fallbackPlanner === undefined ? {} : { fallbackPlanner: plannerOptions.fallbackPlanner }),
        ...(plannerOptions.toolWhitelist === undefined ? {} : { toolWhitelist: plannerOptions.toolWhitelist }),
        ...(plannerOptions.systemPrompt === undefined ? {} : { systemPrompt: plannerOptions.systemPrompt }),
        ...(plannerOptions.personaPrompt === undefined ? {} : { personaPrompt: plannerOptions.personaPrompt }),
        ...(plannerOptions.contextProvider === undefined ? {} : { contextProvider: plannerOptions.contextProvider }),
      });
    },
    tokenBalance() {
      return meter.status().balance;
    },
    riceStatus() {
      return { ...riceStatus, balance: riceBalance };
    },
    feedRice(grains: number) {
      riceStatus = meter.feed(grains);
      riceBalance = riceStatus.balance;
      broadcastRice(riceStatus.level);
      return { ...riceStatus, balance: riceBalance };
    },
    async toggleDrive() {
      if (runner.isRunning()) {
        runner.stop();
        return { ok: true, running: false };
      }
      const blocked = canStart?.();
      if (blocked !== undefined && blocked !== null) return { ok: false, running: false, error: blocked };
      try {
        await runner.start();
        return { ok: true, running: true };
      } catch (error) {
        return { ok: false, running: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async setEndpoint(nextEndpoint: string) {
      if (nextEndpoint === endpoint) return;
      endpoint = nextEndpoint;
      if (gameId !== initialGameId) return;
      const wasRunning = runner.isRunning();
      if (wasRunning) await runner.stopAndWait();
      adapter = gameAdapters.create(gameId, { endpoint });
      runner = createRunner();
    },
    async completeForCoop(slot, system, user, maxTokens = 400) {
      if (gateway === null) return null;
      const receipt = await gateway.chat(slot, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { maxTokens });
      return {
        content: receipt.content,
        tokensUsed: receipt.usage.inputTokens + receipt.usage.outputTokens,
      };
    },
    async chatViaGateway(slot, messages, opts) {
      if (gateway === null) return null;
      const receipt = await gateway.chat(slot, messages, opts);
      return { content: receipt.content, modelId: receipt.route.modelId };
    },
  };
}
