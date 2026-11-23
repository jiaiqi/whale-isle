/**
 * autodrive 宿主接线（T-M5-02 宿主层）：主进程持有 AutodriveRunner，
 * 事件单源多播到 director + pet-stage 两窗（webContents.send，preload 桥中继）。
 * 启停由 Shell 显式触发（用户不在游戏时不自动跑）。
 */
import { app, ipcMain, safeStorage, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutodriveRunner,
  gameAdapters,
  LlmPlanner,
  RulePlanner,
  type AutodriveEvent,
  type GameAdapter,
  type GameId,
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
import { currentPersonaPrompt, currentPersonaReflex } from './character-persona'; // T-M6-21 多角色口吻与 persona-brain 雷区钩子
import { createTokenMeter } from './token-meter';
import { dayKeyOf, type MemoryHost } from './memory-host';
import {
  buildDirectiveSystemPrompt,
  buildDirectiveUserPrompt,
  parseDirectiveResponse,
  resolveKeywordDirective,
  STARDEW_DIRECTIVE_PROFILE,
  type ChatDirective,
  type DirectiveProfile,
} from './chat-directive';
import type { VoiceHost } from './voice-host';

export interface AutodriveHost {
  readonly runner: AutodriveRunner;
  /** 广播目标（两窗 webContents；窗口重建后由 main 更新） */
  setTargets(targets: WebContents[]): void;
  /** 与 Shell 聊天同款回话（WebUI /api/command 复用；人设雷区 0-token 反射） */
  say(text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }>;
  /** 外部订阅总线事件（WebUI WS 推送）；订阅即回放最近 100 条，返回退订函数 */
  subscribe(listener: (event: AutodriveEvent & { seq: number }) => void): () => void;
  /** 当前大脑模式（WebUI 快照用） */
  getBrainMode(): { mode: 'rule' | 'llm'; llmReady: boolean };
  /** 当前接管的游戏（M7 多游戏；默认 stardew） */
  getGameId(): GameId;
}

/** 游戏 → 规划器角色槽位（M7：槽位名按游戏分组，不改星露谷原名） */
const PLANNER_SLOTS: Record<GameId, WorkbenchRoleSlot> = {
  stardew: 'STARDEW_GAME_PLANNER',
  terraria: 'TERRARIA_GAME_PLANNER',
  dst: 'DST_GAME_PLANNER',
};

const DEFAULT_GUIDE_TOPICS = ['钓鱼', '采矿', '节日', '结婚', '沙漠', '姜岛', '农场类型'];

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

export function createAutodriveHost(
  endpoint: string | undefined = undefined,
  vaultPath?: string,
  voiceHost?: VoiceHost,
  memoryHost?: MemoryHost,
  gameId: GameId = 'stardew',
  initialDirectiveProfile?: DirectiveProfile,
): AutodriveHost {
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
    mode: 'rule' | 'llm';
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
    if (Object.keys(keys).length === 0 || !safeStorage.isEncryptionAvailable()) {
      gateway = null;
      llmPlanner = null;
      brainMode = 'rule';
      return { ok: false, mode: 'rule', llmReady: false, providers: [], missingKeys, error: '没有可用的供应商 Key（先在供应商页保存 Key）' };
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
    llmPlanner = new LlmPlanner({
      chat: (slot, messages, opts) =>
        gateway!.chat(slot as never, messages, { maxTokens: opts?.maxTokens }).catch((error: unknown) => {
          console.error('[llm-planner] gateway.chat 失败:', error instanceof Error ? error.message : String(error));
          throw error;
        }),
      recentReceipts,
      slot: PLANNER_SLOTS[gameId],
      fallbackPlanner: adapter.createRulePlanner?.() ?? new RulePlanner(),
      ...(adapter.toolWhitelist !== undefined ? { toolWhitelist: adapter.toolWhitelist } : {}),
      ...(gameId === 'stardew' ? {} : {
        systemPrompt: [
          `你是小鲸，正在替主人游玩《${directiveProfile.gameName}》。`,
          directiveProfile.toolDoc,
          `只可调用当前游戏白名单工具：${(adapter.toolWhitelist ?? []).join(', ')}。`,
          '一次只执行一个动作。只输出一行 JSON：{"tool":"工具名","args":{参数},"intent":"一句话说明"}。',
        ].join('\n'),
      }),
    });
    brainMode = 'llm';
    return { ok: true, mode: brainMode, llmReady: true, providers: brainProviders, missingKeys };
  };
  ipcMain.handle('planner:switch', (_e, mode: string) => {
    if (mode === 'llm' && !llmPlanner) {
      return { ok: false, error: 'LLM 大脑未就绪（供应商 key 未配置或未重启工作台）' };
    }
    brainMode = mode === 'llm' ? 'llm' : 'rule';
    runner.setPlanner(brainMode === 'llm' && llmPlanner ? llmPlanner : adapter.createRulePlanner?.() ?? new RulePlanner());
    return { ok: true, mode: brainMode };
  });
  ipcMain.handle('planner:status', () => ({ mode: brainMode, llmReady: llmPlanner !== null, providers: brainProviders, missingKeys: brainMissingKeys }));

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
    if (!gateway) return { ok: false, error: '主脑未接通（供应商 key 未配置）' };
    // ── T-M6-17：指令先行（串行）——先解析接不接单，再让回话「说到做到」──
    // 旧实现 void tryChatDirective 并行互不知情：回话可能否认自己要做的动作；自驾没开时更是只回复不动手
    let order: ChatDirective | null = null;
    let gameOffline = false;
    try {
      const keywordHit = resolveKeywordDirective(text, directiveProfile);
      if (keywordHit !== null) {
        order = keywordHit;
      } else {
        // LLM 状态感知解析：拉一份当前游戏状态给它填参（游戏没开 → 如实标记，绝不假装接单）
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
            { role: 'system', content: buildDirectiveSystemPrompt(directiveProfile) },
            { role: 'user', content: buildDirectiveUserPrompt(text, { raw: stateRaw }) },
          ], { maxTokens: 200 });
          const parsed = parseDirectiveResponse(r.content, directiveProfile);
          if (parsed !== null) order = { ...parsed, intent: `主人指令：${parsed.intent}` };
        }
      }
      if (order !== null) console.log('[chat-directive] 接单 →', order.tool, JSON.stringify(order.args), `(${order.source})`);
    } catch {
      /* 指令解析失败 → 纯聊天（不阻塞回话） */
    }
    try {
      // T-M5-04：记忆增强——「你昨天做了什么」类问句检索图谱注入 system
      const memoryContext = memoryHost?.contextFor(text) ?? '';
      // T-M6-17 回话 ack：她嘴里说的必须和她马上要做的一致（接单/游戏没开两种情形都如实）
      const ackHint = order !== null
        ? `\n\n【你刚刚接下单子并马上要在游戏里执行：${order.tool}（${order.intent.replace('主人指令：', '')}）。回话要自然承认这件事、傲娇地领任务，绝不能只嘴上说说或否认。】`
        : gameOffline
          ? '\n\n【游戏现在没有开：如果主人的话是想让你在游戏里做事，如实撒娇说等开游戏再办，别假装去做。】'
          : '';
      const base = memoryContext === '' ? personaSystemPrompt() : `${personaSystemPrompt()}

${memoryContext}
（以上是你的长期记忆；回答时自然地使用，不要编造记忆里没有的事）`;
      const system = ackHint === '' ? base : `${base}
${ackHint}`;
      const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ], { maxTokens: 260 });
      // LLM 回话里的 <think> 是内心戏：气泡只显示可见文本，语音也只念可见部分（别把标签读出来）
      const replyVisible = stripVisible(receipt.content);
      broadcastCurrent({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: replyVisible } as AutodriveEvent);
      if (replyVisible !== '') speak({ text: replyVisible, scene: 'normal' });
      // ── T-M6-17 接单下发：自驾没开就自动拉起，绝不「只回复不动手」──
      if (order !== null) {
        broadcastCurrent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: `${order.tool}｜${order.intent}` } as AutodriveEvent);
        if (!runner.isRunning()) {
          try {
            await runner.start();
            broadcastCurrent({ type: 'receipt', tool: 'autodrive', status: 'COMPLETED', summary: '主人下单，自动驾驶已自动启动' } as AutodriveEvent);
          } catch (error) {
            broadcastCurrent({ type: 'watchdog', kind: 'heartbeat', detail: `接了单但自驾起不来：${error instanceof Error ? error.message : String(error)}` } as AutodriveEvent);
            return { ok: true, reply: replyVisible };
          }
        }
        runner.submitDirective(order.tool, order.args, order.intent);
      }
      return { ok: true, reply: replyVisible };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ipcMain.handle('chat:say', (_e, text: string) => say(text));
  ipcMain.handle('guides:load', () => {
    if (!llmPlanner) return { ok: false, error: 'LLM 大脑未就绪' };
    try {
      const dir = resolveGuideDirectory(app.isPackaged, process.resourcesPath, import.meta.url);
      const guides: Record<string, string> = {};
      const missing: string[] = [];
      for (const topic of adapter.guideTopics ?? DEFAULT_GUIDE_TOPICS) {
        try { guides[topic] = readFileSync(join(dir, topic + '.md'), 'utf8').slice(0, 4000); } catch { missing.push(topic); }
      }
      llmPlanner.setGuides(guides);
      console.log('[guides:load] dir =', dir, '| loaded:', Object.keys(guides).length, '| missing:', missing.join(','));
      return { ok: true, topics: Object.keys(guides) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // ---- T-M5-16（D16）pets 动作库：manifest 读取 + 预览转发 ----
  ipcMain.handle('pets:manifest', () => {
    try {
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
  const speak = (v: { text: string; scene?: 'normal' | 'inner' | 'p0' }): void => { void voiceHost?.speak(v); };
  /** 单会话事件处理：T-M6-27 起每个 runner 绑定自己的 sessionId/gameId/generation，
   *  旧会话的迟到事件在此丢弃（语音/记忆/前端都不再受影响）。 */
  const makeRunnerEventHandler = (getMeta: () => { sessionId: string; gameId: GameId; generation: number }) =>
    (event: AutodriveEvent): void => {
      const meta = getMeta();
      if (meta.generation !== generation) return; // 旧会话销毁后的迟到事件：直接丢弃
      if (event.type === 'receipt' && event.tool !== 'autodrive' && voiceHost?.config.enabled) {
        // 回执短评（D11 节流 8s 防刷）：翻车心虚 / 收获欢呼
        if (event.status === 'UNCERTAIN') speak({ text: '都、都怪这块石头突然长出来的！', scene: 'normal' });
        else if (event.status === 'COMPLETED' && /fish|钓/.test(String(event.tool)) && /成功|完美/.test(String(event.summary))) {
          speak({ text: '钓到啦！本鱼的手感是天赋！', scene: 'normal' });
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
    };
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
      endpoint === undefined ? {} : { endpoint },
      adapter,
    );
    created = next;
    activeSessionId = next.sessionId;
    next.setPlanner(brainMode === 'llm' && llmPlanner ? llmPlanner : adapter.createRulePlanner?.() ?? new RulePlanner());
    return next;
  };
  runner = createRunner();

  ipcMain.handle('autodrive:start', async (_e, requestedGameId?: GameId) => {
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
  ipcMain.handle('autodrive:stop', () => {
    runner.stop();
    return { ok: true };
  });
  ipcMain.handle('autodrive:directive', (_e, tool: string, args: Record<string, unknown>, intent: string, expectedSessionId?: string) => {
    // T-M6-27：渲染层带上它认为的会话；不匹配说明 UI 已切走（旧面板/迟到点击）→ 拒绝，绝不误发到新游戏
    if (typeof expectedSessionId === 'string' && expectedSessionId !== '' && expectedSessionId !== activeSessionId) {
      return { ok: false, error: `会话已切换（期望 ${expectedSessionId.slice(0, 8)}，当前 ${activeSessionId.slice(0, 8)}），指令未执行` };
    }
    runner.submitDirective(tool, args ?? {}, typeof intent === 'string' ? intent : '远程指令');
    return { ok: true };
  });
  ipcMain.handle('autodrive:status', () => ({
    running: runner.isRunning(),
    gameId,
    sessionId: activeSessionId,
    generation,
    events: [...eventHistory],
  }));

  // 初始/热切换后统一应用 planner（runner 已就绪）
  const applyPlanner = (): void => {
    runner.setPlanner(brainMode === 'llm' && llmPlanner ? llmPlanner : adapter.createRulePlanner?.() ?? new RulePlanner());
  };
  applyPlanner();
  // 渲染层同步真实套餐/槽位（Dexie → 主进程）；key 只在主进程 vault 解密
  ipcMain.handle('brain:apply-config', (_e, payload: unknown) => {
    const parsed = BrainRuntimeConfigSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: '配置不合法（Schema 校验失败）', mode: brainMode, llmReady: llmPlanner !== null, providers: brainProviders, missingKeys: brainMissingKeys };
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
      return { mode: brainMode, llmReady: llmPlanner !== null };
    },
    getGameId() {
      return gameId;
    },
  };
}
