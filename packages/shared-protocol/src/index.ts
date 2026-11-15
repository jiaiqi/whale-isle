import { z } from 'zod';

// ============================================================================
// 1. 桌宠渲染与音频锁契约 (源自 dsh-pet 复评结论，预留 Live2D 扩展)
// ============================================================================

export const PetRendererTypeSchema = z.enum(['webm-alpha', 'live2d', 'sprite-sheet']);

export const PetActionStateSchema = z.enum([
  'idle',              // 常态呼吸待机
  'walk',              // 左右漫游走动
  'eat_rice',          // 干饭/消耗 Token 扒白米饭
  'happy_maid',        // 收到"下饭菜"（优质上下文/礼物）女仆提裙礼
  'thinking_tail_wag', // <think> 内心戏推理中（歪头+慢速摇尾巴）
  'rage_spray',        // 被叫"大肥鱼"触发雷区（喷水抗议+高频拍尾）
  'clumsy_panic',      // 游戏操作翻车/返回 uncertain 时的心虚冒汗
  'game_focus',        // 认真打游戏操作中
  'sing_stage',        // 拿着麦克风唱歌表演
  'hungry_lazy',       // 赛博饭碗 Token 见底，瘫倒摸鱼
  'sleep_mute',        // 睡眠完全静音模式（拒绝一切打扰，源自 dsh-pet）
]);
export type PetActionState = z.infer<typeof PetActionStateSchema>;

/** 单端语音播放租约与回执（防止吞字、叠音与口型错位，源自 dsh-pet） */
export const AudioPlaybackLeaseSchema = z.object({
  leaseId: z.string().uuid(),
  sourceModule: z.enum(['persona-talk', 'svc-singing', 'reflex-interrupt', 'system-alert']),
  priority: z.enum(['P0_INTERRUPT', 'P1_CADENCE', 'P2_IDLE']),
  ttlMs: z.number().int().min(500).max(300_000), // 唱歌最大支持 5 分钟 TTL
  emotionTag: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']),
  textSubtitle: z.string(),
  innerThoughtText: z.string().optional(),       // 对应 <think> 云朵气泡内容
  audioUrlOrBase64: z.string(),
  actionState: PetActionStateSchema,
});

export const AudioPlaybackReceiptSchema = z.object({
  leaseId: z.string().uuid(),
  status: z.enum(['COMPLETED', 'INTERRUPTED_BY_P0', 'TTL_EXPIRED', 'AUDIO_DEVICE_ERROR']),
  actualPlayedMs: z.number().nonnegative(),
  timestamp: z.number(),
});

// ============================================================================
// 2. "大肥鱼（蓝鲸女仆）"三层人格与赛博饭碗契约 (Persona & Rice Bowl)
// ============================================================================

/** 0.1 秒条件反射拦截器（如"大肥鱼/胖"雷区） */
export const ReflexRuleSchema = z.object({
  id: z.string(),
  triggerRegex: z.string(), // 例如: "(大肥鱼|胖鱼|肥鲸|多少斤|水桶腰|卡门)"
  cooldownMs: z.number().int().default(8000),
  priority: z.literal('P0_INTERRUPT'),
  actionState: PetActionStateSchema,
  emotionTag: z.enum(['rage_spray', 'tsundere_refuse']),
  ledgerGrudgeTag: z.string(), // 记入常客小本本的标签，如 "叫我大肥鱼的坏蛋"
  presetResponses: z.array(z.string()).min(1),
});

/** 《星露谷》决策效用权重（区分"日常摸鱼态"与"护主认真态"） */
export const StardewUtilityWeightsSchema = z.object({
  farmingProfit: z.number().min(0).max(1),       // 种地赚钱权重
  npcGossipAndTrashCan: z.number().min(0).max(1),// 找村民聊天与翻垃圾桶权重
  miningCombat: z.number().min(0).max(1),        // 下矿战斗权重
  slackingAndScenery: z.number().min(0).max(1),  // 看海摸鱼坐长椅权重
  minStaminaThreshold: z.number().min(0.05).max(0.9), // 低于该体力比例立刻喊累想睡觉
});

/** 赛博饭碗（Token 预算经济系统：吃白饭=耗Token，下饭菜=加Buff） */
export const RiceBowlEconomySchema = z.object({
  dailyRiceGrainBudget: z.number().int().positive().default(500_000), // 1 粒米 = 1 Token
  consumedRiceGrainsToday: z.number().int().nonnegative().default(0),
  lowRiceWarningRatio: z.number().min(0.05).max(0.5).default(0.15),
  activeSideDishes: z.array(
    z.object({
      id: z.string(),
      dishName: z.string(), // 如 "攻略红烧肉(RAG)" 或 "榜一大哥投喂的帝王蟹"
      workEthicMultiplier: z.number().min(1).max(5),
      unlockDeepReasoning: z.boolean(),
      expiresAt: z.number(),
    })
  ),
});

export const PetPersonaConfigSchema = z.object({
  id: z.string(), // "blue-whale-maid"
  name: z.string(),
  title: z.string(),
  ownerTitles: z.array(z.string()).default(['鱼片', '主人']),
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']),
  avatarManifestPath: z.string(),
  tailMoodIndicatorEnabled: z.boolean().default(true),
  systemPromptTemplate: z.string(),
  innerVoiceConfig: z.object({
    enabled: z.boolean().default(true),
    thinkTagName: z.string().default('think'),
    derailmentProbability: z.number().min(0).max(1).default(0.35),
    derailmentPrompts: z.array(z.string()),
  }),
  reflexRules: z.array(ReflexRuleSchema),
  riceBowl: RiceBowlEconomySchema,
  stardewWeights: z.object({
    lazyDefault: StardewUtilityWeightsSchema,
    seriousForOwner: StardewUtilityWeightsSchema,
  }),
  voiceProfile: z.object({
    ttsVoicePackId: z.string(),
    rvcModelPath: z.string(),
    rvcIndexRate: z.number().min(0).max(1).default(0.75),
    pitchShiftSemitones: z.number().int().min(-12).max(12).default(0),
  }),
});
export type PetPersonaConfig = z.infer<typeof PetPersonaConfigSchema>;

// ============================================================================
// 3. 模型与供应商网关契约 (融合 CC Switch 预设卡片 + Magpie 角色路由与套餐)
// ============================================================================

/** CC Switch 风格：支持同厂商多区域(Region)与多套餐(Plan)胶囊切换 */
export const ProviderEndpointVariantSchema = z.object({
  region: z.enum(['CN', 'GLOBAL', 'LOCAL']),
  planType: z.enum(['PAY_AS_YOU_GO', 'CODING_PLAN', 'FREE_TIER', 'LOCAL_GPU']),
  baseUrl: z.string().url(),
  isFullUrl: z.boolean().default(false), // 开启后不自动拼接 /v1/chat/completions
});

export const ModelProviderConfigSchema = z.object({
  id: z.string(), // e.g., "deepseek-official", "siliconflow", "local-gpt-sovits"
  name: z.string(),
  category: z.enum(['OFFICIAL_LLM', 'AGGREGATOR_LLM', 'LOCAL_LLM', 'AUDIO_TTS', 'AUDIO_SVC']),
  activeRegion: z.enum(['CN', 'GLOBAL', 'LOCAL']).default('CN'),
  activePlanType: z.enum(['PAY_AS_YOU_GO', 'CODING_PLAN', 'FREE_TIER', 'LOCAL_GPU']).default('PAY_AS_YOU_GO'),
  variants: z.array(ProviderEndpointVariantSchema),
  apiKeyMaskedOrRef: z.string(), // 存储于本地安全凭据库，前端仅展示掩码
  customParams: z.record(z.string(), z.unknown()).optional(), // 支持自定义 temperature, top_p, reasoning_effort
  discoveredModels: z.array(
    z.object({
      id: z.string(),
      supportsReasoningThink: z.boolean().default(false),
      supportsVision: z.boolean().default(false),
      supportsToolCalling: z.boolean().default(true),
      inputCostPer1M: z.number().nonnegative().default(0),
      outputCostPer1M: z.number().nonnegative().default(0),
    })
  ),
});

/** Magpie 风格：单屏 6 大核心工作槽位 (Every Role's Model, One Screen) */
export const WorkbenchRoleSlotSchema = z.enum([
  'MAIN_PERSONA_BRAIN',   // 主脑与 <think> 内心戏 (如 deepseek-reasoner)
  'STARDEW_GAME_PLANNER', // 星露谷战术与 MCP 动作规划 (如 deepseek-chat / claude-sonnet)
  'DANMAKU_FAST_ROUTER',  // 弹幕清洗、敏感词拦截与价值打分 (如 Qwen-Turbo / 本地小模型)
  'VISION_STORYBOARD',    // 翻车复盘与高光切片理解 (如 Qwen-VL / Gemini Flash)
  'VOICE_TTS_SPEECH',     // 日常傲娇语音合成 (本地 GPT-SoVITS MPS/CUDA 或 SiliconFlow)
  'VOICE_SVC_SINGING',    // 点歌台伴奏分离与 RVC 变声 (本地 Demucs + RVC v2)
]);
export type WorkbenchRoleSlot = z.infer<typeof WorkbenchRoleSlotSchema>;

/** 粘性路由组：优先锁死同一节点吃满 Prompt Cache，故障时 100ms 静默转移 */
export const StickyRoutingGroupSchema = z.object({
  groupId: z.string(),
  strategy: z.enum(['PROMPT_CACHE_STICKY', 'ROUND_ROBIN', 'LOWEST_LATENCY']),
  candidates: z.array(
    z.object({
      providerId: z.string(),
      modelId: z.string(),
      weight: z.number().int().min(1).max(100).default(100),
    })
  ),
});

/** "干饭套餐"全局 Profile 一键切换 */
export const DiningProfilePresetSchema = z.object({
  profileId: z.enum(['BUDGET_SLACKING', 'DELUXE_LIVESTREAM', 'OFFLINE_SURVIVAL']),
  displayName: z.string(), // "🍚 省饭摸鱼档" | "🍱 豪华直播档" | "🛡️ 断网求生档"
  roleBindings: z.record(WorkbenchRoleSlotSchema, z.string()), // value 为 "providerId/modelId" 或 "group/groupId"
  secretMaskingEnabled: z.boolean().default(true),
});

// ============================================================================
// 4. 《星露谷物语》MCP 真实执行回执与键鼠接管契约 (源自 BlindWhaleFarmer)
// ============================================================================

export const GameControlAuthoritySchema = z.enum([
  'AI_AUTOPILOT',         // 大肥鱼自动驾驶中
  'HUMAN_TAKEOVER_ACTIVE',// 主人(鱼片)动了键鼠，AI 立即挂起动作锁并转为场边啦啦队
  'PAUSED_BY_PROGRAM',    // 正在中场点歌或杂谈，游戏处于安全暂停态
]);

export const StardewMcpActionReceiptSchema = z.object({
  actionId: z.string().uuid(),
  toolName: z.enum([
    'move_to_tile',
    'use_tool_on_tile',
    'water_crops_batch',
    'interact_with_npc',
    'check_trash_can',
    'eat_food_for_stamina',
    'go_to_sleep',
  ]),
  /** 铁律：严禁用 LLM 台词代替结果，必须以 SMAPI 真实返回的 status 为准 */
  status: z.enum(['COMPLETED', 'FAILED', 'UNCERTAIN', 'ABORTED_BY_HUMAN_TAKEOVER']),
  failureOrUncertainReason: z.string().optional(), // 如 "PATH_BLOCKED_BY_STONE", "STAMINA_EXHAUSTED"
  gameStateSnapshot: z.object({
    dayOfMonth: z.number().int(),
    season: z.enum(['spring', 'summer', 'fall', 'winter']),
    timeOfDay: z.number().int(), // 如 1430 代表 14:30
    staminaCurrent: z.number(),
    staminaMax: z.number(),
    healthCurrent: z.number(),
    gold: z.number().int(),
    locationName: z.string(),
    isPlayerMovingPhysically: z.boolean(), // 实时硬件输入检测标志
  }),
});

// ============================================================================
// 5. 直播事件总线、注意力队列与节目状态机 (源自 dsh-livestream & dsh-live-studio)
// ============================================================================

export const LiveProgramStateSchema = z.enum([
  'GAMING_MAIN',       // 主线玩星露谷 + 边玩边回弹幕
  'SINGING_CONCERT',   // 中场点歌演唱会（游戏安全挂起）
  'CHATTING_INTERACT', // 过夜结算/卡关时的纯杂谈互动模式
  'SLEEP_OFF_DUTY',    // 下播/桌面安静陪玩模式
]);

export const NormalizedLiveEventSchema = z.object({
  eventId: z.string().uuid(),
  platform: z.enum(['douyin', 'bilibili', 'local-host-input']),
  eventType: z.enum(['DANMAKU', 'GIFT', 'LIKE', 'ENTER_ROOM', 'SONG_REQUEST', 'VOTE_CHOICE']),
  sender: z.object({
    uid: z.string(),
    nickname: z.string(),
    intimacyScore: z.number().default(0),
    grudgeTags: z.array(z.string()).default([]), // 从 SQLite 常客账本读取的黑历史标签
  }),
  payload: z.object({
    rawText: z.string().optional(),
    sanitizedText: z.string().optional(), // 经过输入防封护栏清洗后的文本
    mergedCount: z.number().int().default(1), // 同观众短时刷屏或礼物连击合并计数
    giftName: z.string().optional(),
    giftDiamondValue: z.number().nonnegative().optional(),
    songTitle: z.string().optional(),
  }),
  assignedPriority: z.enum(['P0_INTERRUPT', 'P1_CADENCE', 'P2_IDLE']),
  timestamp: z.number(),
});
export type NormalizedLiveEvent = z.infer<typeof NormalizedLiveEventSchema>;
