import { z } from 'zod';
import { VoiceEngineTierSchema } from './voice';

// ============================================================================
// 1. 桌宠渲染与音频锁契约 (源自 dsh-pet 复评结论，预留 Live2D 扩展)
// ============================================================================

export const PetRendererTypeSchema = z.enum(['webm-alpha', 'live2d', 'sprite-sheet', 'pose-skin']);

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
export type AudioPlaybackLease = z.infer<typeof AudioPlaybackLeaseSchema>;

export const AudioPlaybackReceiptSchema = z.object({
  leaseId: z.string().uuid(),
  // CANCELLED：显式取消/应用关闭的主动停止（区别于 P0 抢占 INTERRUPTED_BY_P0）
  status: z.enum(['COMPLETED', 'INTERRUPTED_BY_P0', 'TTL_EXPIRED', 'AUDIO_DEVICE_ERROR', 'CANCELLED']),
  actualPlayedMs: z.number().nonnegative(),
  timestamp: z.number(),
});
export type AudioPlaybackReceipt = z.infer<typeof AudioPlaybackReceiptSchema>;

/** 口型（viseme）枚举：桌宠口型驱动（SPEC §3.4 口型包络） */
export const VisemeSchema = z.enum(['closed', 'wide', 'round', 'open', 'teeth']);
export type Viseme = z.infer<typeof VisemeSchema>;

/**
 * 口型包络：按时间锚点给出一串口型，桌宠据此同步嘴型。
 * startMs 为相对音频起点的偏移；durationMs 为该口型保持时长。
 */
export const LipEnvelopeSchema = z.object({
  visemes: z.array(
    z.object({
      viseme: VisemeSchema,
      startMs: z.number().min(0),
      durationMs: z.number().min(0),
      /** 该区间的相对响度（0~1），供口型幅度调制 */
      amplitude: z.number().min(0).max(1).default(0.6),
    }),
  ),
  totalDurationMs: z.number().min(0),
});
export type LipEnvelope = z.infer<typeof LipEnvelopeSchema>;

/**
 * 情绪参考音频（SPEC §3.4：大肥鱼预置 5 组 5 秒情绪参考音频）。
 * emotionTag 与 AudioPlaybackLease.emotionTag 同一枚举。
 */
export const EmotionVoiceProfileSchema = z.object({
  emotionTag: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']),
  /** 参考音频路径（GPT-SoVITS 推理输入） */
  refAudioPath: z.string().min(1),
  /** 参考音频对应文本（推理提示） */
  refText: z.string().min(1),
  /** 参考音频时长（毫秒），默认 5 秒 */
  refDurationMs: z.number().int().min(500).max(60_000).default(5_000),
  /** 该情绪对应的桌宠动作（驱动 .webm 切换） */
  actionState: PetActionStateSchema,
});
export type EmotionVoiceProfile = z.infer<typeof EmotionVoiceProfileSchema>;

/** 音色包（voice pack）：5 组情绪参考音频的集合 */
export const TtsVoicePackSchema = z.object({
  voicePackId: z.string().min(1),
  /** 默认情绪（未指定情绪前缀时使用） */
  defaultEmotionTag: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']),
  profiles: z.array(EmotionVoiceProfileSchema).min(1),
  /** 素材许可（dsh-pet 素材红线：非商用素材需标记） */
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']).default('DEV_ONLY_NON_COMMERCIAL'),
});
export type TtsVoicePack = z.infer<typeof TtsVoicePackSchema>;

/** TTS 合成回执（Python 侧 → 宿主）：音频流 + 口型包络 + 实际路由后端 */
export const TtsSynthesisResultSchema = z.object({
  synthId: z.string().uuid(),
  emotionTag: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']),
  /** 命中的参考音频路径（门禁断言：情绪 → 正确参考音频） */
  refAudioPath: z.string().min(1),
  /** 实际使用的推理后端：真实模型名（如 cosyvoice2）或占位标识（stub-*） */
  backend: z.string().min(1),
  /** 是否发生了降级（本地失败 → 云端） */
  degraded: z.boolean().default(false),
  /**
   * 该音频是否为占位波形（stub）而非真实 TTS 人声。
   * 历史坑：stub 后端曾自称 `local-gpt-sovits`，调用方无从分辨，等于把正弦波当真 TTS 播放展示。
   */
  placeholder: z.boolean().default(false),
  /** 占位原因（给 UI 与日志用；placeholder=false 时省略） */
  placeholderReason: z.string().optional(),
  format: z.enum(['wav', 'mp3', 'ogg']),
  durationMs: z.number().min(0),
  audioBase64: z.string().min(1),
  lipEnvelope: LipEnvelopeSchema,
});
export type TtsSynthesisResult = z.infer<typeof TtsSynthesisResultSchema>;

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
  isFullUrl: z.boolean().default(false), // 开启后不自动拼接 /chat/completions 或 /messages
  /** 该端点的协议（OpenAI 兼容 /chat/completions 或 Anthropic 兼容 /messages） */
  protocol: z.enum(['openai', 'anthropic']).default('openai'),
});
export type ProviderEndpointVariant = z.infer<typeof ProviderEndpointVariantSchema>;

export const ModelProviderConfigSchema = z.object({
  id: z.string(), // e.g., "deepseek-official", "siliconflow", "local-gpt-sovits"
  name: z.string(),
  category: z.enum(['OFFICIAL_LLM', 'AGGREGATOR_LLM', 'LOCAL_LLM', 'AUDIO_TTS', 'AUDIO_SVC']),
  activeRegion: z.enum(['CN', 'GLOBAL', 'LOCAL']).default('CN'),
  activePlanType: z.enum(['PAY_AS_YOU_GO', 'CODING_PLAN', 'FREE_TIER', 'LOCAL_GPU']).default('PAY_AS_YOU_GO'),
  variants: z.array(ProviderEndpointVariantSchema),
  apiKeyMaskedOrRef: z.string(), // 存储于本地安全凭据库，前端仅展示掩码
  activeModelId: z.string().default(''), // Magpie 交互：该供应商当前选中的模型（discoverModels 后选择）
  /** 供应商默认协议（变体未覆盖时使用） */
  protocol: z.enum(['openai', 'anthropic']).default('openai'),
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
export type ModelProviderConfig = z.infer<typeof ModelProviderConfigSchema>;

/** Magpie 风格：单屏 6 大核心工作槽位 (Every Role's Model, One Screen) */
export const WorkbenchRoleSlotSchema = z.enum([
  'MAIN_PERSONA_BRAIN',   // 主脑与 <think> 内心戏 (如 deepseek-reasoner)
  'STARDEW_GAME_PLANNER', // 星露谷战术与 MCP 动作规划 (如 deepseek-chat / claude-sonnet)
  'TERRARIA_GAME_PLANNER', // 泰拉瑞亚战术与桥接动作规划 (M7 多游戏扩展)
  'DST_GAME_PLANNER',      // 饥荒联机版 DST 战术与桥接动作规划 (M7 多游戏扩展)
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
export type StickyRoutingGroup = z.infer<typeof StickyRoutingGroupSchema>;

/** "干饭套餐"全局 Profile 一键切换 */
export const DiningProfilePresetSchema = z.object({
  profileId: z.enum(['BUDGET_SLACKING', 'DELUXE_LIVESTREAM', 'OFFLINE_SURVIVAL']),
  displayName: z.string(), // "🍚 省饭摸鱼档" | "🍱 豪华直播档" | "🛡️ 断网求生档"
  // Zod 4 的 z.record(enumKey, …) 运行期强制全部枚举键齐全；partialRecord 保持 Zod 3 的「子集合法」语义
  roleBindings: z.partialRecord(WorkbenchRoleSlotSchema, z.string()), // value 为 "providerId/modelId" 或 "group/groupId"
  secretMaskingEnabled: z.boolean().default(true),
});
export type DiningProfilePreset = z.infer<typeof DiningProfilePresetSchema>;

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

// ───────────────────────── 多游戏桥接契约（M7：泰拉瑞亚 / 饥荒 DST，2026-11-22 立项） ─────────────────────────
// 统一桥接协议：每游戏一个「模组内 HTTP 服务端」——泰拉瑞亚为 tModLoader 模组（18090）、
// 饥荒 DST 由 Lua 模组 + Node sidecar 代理（18100，官方 653007 localhost QueryServer 通道）；
// 接口面：GET /state · POST /act · GET /action_status · POST /cancel · GET /health。
// 星露谷 BWF 保持外部 HTTP MCP(18080) 原样不动，包装为 StardewAdapter（18760 中心 WS 网关设计稿搁置）。

/** 桥接动作回执四态（铁律同 StardewMcpActionReceipt：以模组真实执行结果为准，严禁 LLM 台词替代） */
export const GameBridgeReceiptStatusSchema = z.enum([
  'COMPLETED',
  'FAILED',
  'UNCERTAIN',
  'ABORTED_BY_HUMAN_TAKEOVER',
]);
export type GameBridgeReceiptStatus = z.infer<typeof GameBridgeReceiptStatusSchema>;

/** 桥接动作请求（工作台 → 游戏桥） */
export const GameBridgeActionRequestSchema = z.object({
  actionId: z.string().uuid(),
  /** T-M6-40：同一 sidecar 下多个逻辑玩家的路由键；单玩家省略保持兼容 */
  agentId: z.string().min(1).optional(),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type GameBridgeActionRequest = z.infer<typeof GameBridgeActionRequestSchema>;

/** POST /act 受理回执（accepted=false 即互斥拒绝等原因，附 reason） */
export const GameBridgeActionAcceptedSchema = z.object({
  accepted: z.boolean(),
  actionId: z.string().uuid().optional(),
  reason: z.string().optional(), // 如 "ACTION_IN_FLIGHT"
});
export type GameBridgeActionAccepted = z.infer<typeof GameBridgeActionAcceptedSchema>;

/** 桥接动作回执通用形状（泰拉瑞亚/DST 子类型以 gameId 字面量区分并附各自快照） */
export const GameBridgeReceiptSchema = z.object({
  actionId: z.string().uuid(),
  tool: z.string().min(1),
  status: GameBridgeReceiptStatusSchema,
  reason: z.string().optional(), // 如 "LAVA_ESCAPE_TRIGGERED", "PATH_BLOCKED_PERSISTENT"
  startedAt: z.number(),
  completedAt: z.number(),
});
export type GameBridgeReceipt = z.infer<typeof GameBridgeReceiptSchema>;

/** GET /action_status 轮询响应（长动作：running=true 期间严禁重发） */
export const GameBridgeActionStatusSchema = z.object({
  actionId: z.string().uuid(),
  running: z.boolean(),
  receipt: GameBridgeReceiptSchema.optional(),
});
export type GameBridgeActionStatus = z.infer<typeof GameBridgeActionStatusSchema>;

/** GET /health 探活（工作台 start() 前先 ping，不通即如实报错） */
export const GameBridgeHealthSchema = z.object({
  ok: z.boolean(),
  gameId: z.string().min(1),
  bridgeVersion: z.string().default(''),
  gameVersion: z.string().default(''),
  control: GameControlAuthoritySchema,
});
export type GameBridgeHealth = z.infer<typeof GameBridgeHealthSchema>;

/** 泰拉瑞亚结构化状态快照（模组 StateExporter 出站必须过本契约） */
export const TerrariaStateSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.number(),
  clock: z.object({
    dayCount: z.number().int().min(0),
    isDay: z.boolean(),
    dayPhase: z.enum(['dawn', 'day', 'dusk', 'night']),
    timeText: z.string(), // 如 "07:30 AM"
    hardMode: z.boolean().default(false),
  }),
  player: z.object({
    hp: z.number().int().min(0),
    hpMax: z.number().int().min(1),
    mana: z.number().int().min(0),
    manaMax: z.number().int().min(1),
    position: z.object({ x: z.number(), y: z.number() }), // 瓦片坐标
    facing: z.enum(['left', 'right']),
    buffs: z.array(z.object({ name: z.string(), timeSeconds: z.number().int().min(0) })).default([]),
    inventory: z
      .array(z.object({ slot: z.number().int().min(0), itemName: z.string(), stack: z.number().int().min(0) }))
      .default([]),
    selectedSlot: z.number().int().min(0).default(0),
  }),
  world: z.object({
    biome: z.string(), // 如 "Forest", "Underground"
    events: z.array(z.string()).default([]), // 如 "BloodMoon", "Rain"
    downedBosses: z.array(z.string()).default([]), // NPC.downedBossX 旗标摘要
  }),
  nearby: z.object({
    /** 以玩家为中心的瓦片网格（ASCII 行 + 图例），LLM 感知与寻路共用（TerraBlind /terrain 思想） */
    tiles: z.object({
      originX: z.number().int(),
      originY: z.number().int(),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      legend: z.record(z.string(), z.string()), // 单字符 → 语义，如 "#": "solid"
      rows: z.array(z.string()),
    }),
    npcs: z
      .array(
        z.object({
          name: z.string(),
          hp: z.number(),
          hpMax: z.number(),
          position: z.object({ x: z.number(), y: z.number() }),
          isHostile: z.boolean(),
          isBoss: z.boolean().default(false),
        }),
      )
      .default([]),
    items: z
      .array(
        z.object({
          name: z.string(),
          stack: z.number().int().min(1),
          position: z.object({ x: z.number(), y: z.number() }),
        }),
      )
      .default([]),
  }),
  danger: z.object({
    lavaNearby: z.boolean().default(false),
    fallingDanger: z.boolean().default(false),
    threatLevel: z.enum(['safe', 'caution', 'critical']).default('safe'),
  }),
  control: z.object({
    authority: GameControlAuthoritySchema,
    isPlayerMovingPhysically: z.boolean(), // 真实键鼠检测（F8 接管语义，静默 reacquire 后回托管）
  }),
});
export type TerrariaStateSnapshot = z.infer<typeof TerrariaStateSnapshotSchema>;

export const TerrariaActionReceiptSchema = GameBridgeReceiptSchema.extend({
  gameId: z.literal('terraria'),
  snapshot: TerrariaStateSnapshotSchema.optional(),
});
export type TerrariaActionReceipt = z.infer<typeof TerrariaActionReceiptSchema>;

/** 泰拉瑞亚桥接配置（userData 持久化；端点默认 tModLoader 模组 18090） */
export const TerrariaBridgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().url().default('http://127.0.0.1:18090'),
  /** AI 思考期冻结世界（单人可行，对齐 BWF「思考时冻结游戏时钟」） */
  freezeWhileThinking: z.boolean().default(true),
  /** F8 接管后静默多少毫秒回托管 */
  takeoverReacquireMs: z.number().int().min(1000).default(8000),
});
export type TerrariaBridgeConfig = z.infer<typeof TerrariaBridgeConfigSchema>;

/** 饥荒 DST 结构化状态快照（服务器侧 Lua 模组导出，经 sidecar 转发） */
export const DstStateSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.number(),
  clock: z.object({
    cycle: z.number().int().min(0), // 第几个昼夜循环
    phase: z.enum(['day', 'dusk', 'night']),
    phaseProgress: z.number().min(0).max(1).default(0),
    season: z.enum(['spring', 'summer', 'autumn', 'winter']),
    isRaining: z.boolean().default(false),
  }),
  player: z.object({
    character: z.string(), // 如 "wilson"
    health: z.object({ current: z.number(), max: z.number() }),
    hunger: z.object({ current: z.number(), max: z.number() }),
    sanity: z.object({ current: z.number(), max: z.number() }),
    temperature: z.number(),
    moisture: z.number().min(0).max(100).default(0),
    position: z.object({ x: z.number(), z: z.number() }),
    inventory: z
      .array(
        z.object({
          itemName: z.string(),
          count: z.number().int().min(0),
          equipped: z.boolean().default(false),
        }),
      )
      .default([]),
  }),
  nearby: z.object({
    entities: z
      .array(
        z.object({
          prefab: z.string(),
          displayName: z.string().default(''),
          position: z.object({ x: z.number(), z: z.number() }),
          distance: z.number().min(0),
          isHostile: z.boolean().default(false),
          isResource: z.boolean().default(false), // 树/石/浆果丛等可采集
        }),
      )
      .default([]),
    campfires: z
      .array(
        z.object({
          position: z.object({ x: z.number(), z: z.number() }),
          fuelPercent: z.number().min(0).max(1),
        }),
      )
      .default([]),
  }),
  threats: z
    .array(
      z.object({
        kind: z.string(), // 如 "hound", "spider"
        count: z.number().int().min(1).default(1),
        directionText: z.string().default(''),
      }),
    )
    .default([]),
  control: z.object({
    authority: GameControlAuthoritySchema,
    isPlayerMovingPhysically: z.boolean(),
  }),
});
export type DstStateSnapshot = z.infer<typeof DstStateSnapshotSchema>;

export const DstActionReceiptSchema = GameBridgeReceiptSchema.extend({
  gameId: z.literal('dst'),
  snapshot: DstStateSnapshotSchema.optional(),
});
export type DstActionReceipt = z.infer<typeof DstActionReceiptSchema>;

/** 饥荒 DST 桥接配置（sidecar 宿主面 18100 + 本地集群托管） */
export const DstBridgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().url().default('http://127.0.0.1:18100'),
  /** 本地集群目录（cluster_token.txt 所在；sidecar 自起专用服） */
  clusterDir: z.string().default(''),
  /** mod → sidecar /v1/tick 鉴权 token（fruitstarzero 配对模式） */
  pairToken: z.string().default(''),
});
export type DstBridgeConfig = z.infer<typeof DstBridgeConfigSchema>;

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

// ============================================================================
// 6.5 声音工坊契约（T-M5-17）：TTS 情感调参 / SVC 唱歌调参 / 音色创建请求
// ============================================================================

/** 气口停顿配置（dsh-gpt-sovits 思想：句号/逗号/省略号三档独立 ms） */
export const PauseConfigSchema = z.object({
  periodMs: z.number().int().min(50).max(2000).default(340),
  commaMs: z.number().int().min(20).max(2000).default(150),
  ellipsisMs: z.number().int().min(50).max(3000).default(460),
});
export type PauseConfig = z.infer<typeof PauseConfigSchema>;

/**
 * TTS 参考音频素材性质（诚实口径）。
 * - `real_voice`：真人/真实录音干声，可用于真实音色克隆；
 * - `stub_sine`：占位正弦波（工程生成的确定性 stub），**不是人声**，只能用于占位试听；
 * - `missing`：磁盘上不存在该素材。
 */
export const TtsRefAssetKindSchema = z.enum(['real_voice', 'stub_sine', 'missing']);
export type TtsRefAssetKind = z.infer<typeof TtsRefAssetKindSchema>;

/** TTS 情感锚点独立可调参数（每个锚点一条；refText 必填防内部 ASR 卡顿） */
export const TtsEmotionTuningParamsSchema = z.object({
  // 与 TtsVoicePackSchema / AudioPlaybackLeaseSchema 的情绪枚举保持同一集合（happy_rice = 干饭兴奋）。
  // 注：`clumsy_panic` 是**桌宠动作状态**（PetActionState），不是 TTS 情绪锚点，两者不可混用。
  emotionTag: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']),
  refAudioPath: z.string().default(''),
  /** 参考干声对应文本——必填（空值会触发内部 ASR 导致约 40s 卡顿） */
  refText: z.string().min(1),
  /** 参考素材性质；缺省视为 `real_voice`（老包兼容），但真实路由应显式标注 */
  refAssetKind: TtsRefAssetKindSchema.default('real_voice'),
  speed: z.number().min(0.7).max(1.4).default(1.0),
  temperature: z.number().min(0.1).max(1.0).default(1.0),
  topP: z.number().min(0.1).max(1.0).default(1.0),
  topK: z.number().int().min(1).max(50).default(15),
  // Zod 4 的 .default() 要求默认值等于 output 类型；prefault 保留 Zod 3「先填默认值再解析」语义（{} 再落三档默认）
  pauseConfig: PauseConfigSchema.prefault({}),
  /** 前置微音效（如"咕噜"气泡声）路径 */
  prependSfxPath: z.string().default(''),
  sfxVolume: z.number().min(0).max(1).default(0),
});
export type TtsEmotionTuningParams = z.infer<typeof TtsEmotionTuningParamsSchema>;

/** SVC/RVC 唱歌调参（dsh-voice-studio 思想：气声保护 + 混音电平比） */
export const SvcSingingTuningParamsSchema = z.object({
  rvcModelPath: z.string().default(''),
  indexPath: z.string().default(''),
  /** 升降调半音：-12~+12；快捷预设「女声微调 +2」「男转女 +12」 */
  pitchShiftSemitones: z.number().int().min(-12).max(12).default(0),
  /** 音色还原度（0=纯源声 1=完全模型化） */
  indexRate: z.number().min(0).max(1).default(0.75),
  /** 气声保护（保护齿音/气声不破音；0=不保护 0.5=最强保护） */
  protectVoiceless: z.number().min(0).max(0.5).default(0.33),
  vocalGainDb: z.number().min(-12).max(12).default(0),
  accompanimentGainDb: z.number().min(-24).max(6).default(-3),
});
export type SvcSingingTuningParams = z.infer<typeof SvcSingingTuningParamsSchema>;

/**
 * 音色包落盘结构（`voice_matrix.json`）契约。
 * 之前该文件是「谁写谁负责」的手工 JSON，save-pack 落盘与 shared-protocol 枚举会各写各的
 * （实测踩坑：voice_matrix 第 5 组写 `clumsy_panic`，而契约枚举是 `happy_rice`，校验必然挂）。
 * 现在落盘产物本身也有 schema，save-pack 写出前先过本契约，漂移在写入那一刻就被拦下。
 */
export const TtsVoicePackMatrixSchema = z.object({
  schemaVersion: z.string().min(1),
  petId: z.string().min(1),
  voicePackId: z.string().min(1),
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']),
  tts: z.object({
    voicePackId: z.string().min(1),
    defaultEmotionTag: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']),
    profiles: z.array(TtsEmotionTuningParamsSchema),
  }),
  svc: SvcSingingTuningParamsSchema.optional(),
});
export type TtsVoicePackMatrix = z.infer<typeof TtsVoicePackMatrixSchema>;
export type TtsVoicePackMatrixInput = z.input<typeof TtsVoicePackMatrixSchema>;

/** 声音工坊音色创建请求（三种路径） */
export const VoiceDesignRequestSchema = z.object({
  mode: z.enum(['cloud_voice_design', 'local_audio_slice', 'local_weight_import']),
  petId: z.string().default('blue-whale-maid'),
  /** cloud_voice_design：音色自然语言描述（工坊内置傲娇蓝鲸女仆等模板） */
  prompt: z.string().default(''),
  previewText: z.string().default('哼，本鱼才没有偷懒呢！主人快夸夸我嘛～'),
  emotionTag: z.string().default('sweet_normal'),
  /** local_weight_import：本地权重路径（.pth/.ckpt/.index） */
  weightPath: z.string().default(''),
  /** 导入权重强制标记许可证范围 */
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']).default('DEV_ONLY_NON_COMMERCIAL'),
});
export type VoiceDesignRequest = z.infer<typeof VoiceDesignRequestSchema>;

// ============================================================================
// 6. 桌宠资产清单契约 (T-M1-01；素材许可红线见 docs/THIRD_PARTY_NOTICES.md)
// ============================================================================

/** 单段动作视频片段（VP9-Alpha .webm） */
export const PetSpriteMetaSchema = z.object({
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  frameCount: z.number().int().positive(),
  sampleFps: z.number().positive().max(120).default(12),
});
export type PetSpriteMeta = z.infer<typeof PetSpriteMetaSchema>;

export const PetAvatarClipSchema = z.object({
  clipId: z.string(),
  webmPath: z.string().min(1),
  /** sprite-sheet：透明 WebP 整图；与 webmPath 二选一使用（导入器两者都会填同一路径） */
  spriteSheetPath: z.string().optional(),
  /** sprite-sheet 帧元数据 JSON（aboutme-pets 导入器落盘生成） */
  spriteMetaPath: z.string().optional(),
  /** 内嵌帧元数据（meta JSON 不可读时回退，保证离线可用） */
  sprite: PetSpriteMetaSchema.optional(),
  /** 动作原声音轨（m4a/webp 对应音频）；有 TTS 发言时由渲染器 duck */
  audioPath: z.string().optional(),
  loop: z.boolean().default(true),
  playbackRate: z.number().min(0.1).max(4).default(1),
  /** 帧率（供口型包络/时序对齐，见 SPEC §3.4 情绪 TTS） */
  fps: z.number().int().min(1).max(120).default(30),
  /** 同一动作多片段的随机加权（dsh-pet：按权重首尾相接） */
  weight: z.number().min(0).max(1).default(1),
  /** 素材朝向（T-M6-63：桌面自主巡逻据此镜像精灵；气泡文字绝不翻转） */
  facing: z.enum(['left', 'right']).optional(),
  /** 可位移帧区间 `[start, end, speed]`（帧号含端点，speed=像素/帧；T-M6-64 巡逻用） */
  moving: z.array(z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().positive(),
  ])).optional(),
  /** 素材语义分类（拖拽/余额/吃什么/时节…，T-M6-63 场景化过滤用） */
  category: z.string().optional(),
});
export type PetAvatarClip = z.infer<typeof PetAvatarClipSchema>;

/** 桌宠资产清单 manifest.json（renderer=webm-alpha 的第一方实现见 packages/pet-renderer） */
export const PetAvatarManifestSchema = z.object({
  petId: z.string(),
  renderer: PetRendererTypeSchema,
  /** dsh-pet 素材红线：大肥鱼形象/动画为 CC BY-NC-SA 4.0 → 必须标 DEV_ONLY_NON_COMMERCIAL */
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']),
  /** 二创署名（dsh-pet 二创约定：公开渠道须附原作者仓库/出处） */
  attribution: z.string().default(''),
  width: z.number().int().min(16).max(4096).default(640),
  height: z.number().int().min(16).max(4096).default(360),
  /** 脚底基准线在帧高内的比例（0=头顶，1=脚底；渲染器据此做脚底对齐） */
  footlineRatio: z.number().min(0).max(1).default(0.92),
  defaultAction: PetActionStateSchema.default('idle'),
  actions: z
    .array(
      z.object({
        actionState: PetActionStateSchema,
        clips: z.array(PetAvatarClipSchema).min(1),
      }),
    )
    .min(1),
  /** 随机氛围动作池（T-M5-01，dsh-pet categories 简化版）：未绑定语义槽位的全部动作，
   *  空闲随机链按 category/weight 抽取播放（dsh-pet animationWeights 思想） */
  ambientPool: z
    .array(
      z.object({
        clipId: z.string(),
        webmPath: z.string().min(1),
        spriteSheetPath: z.string().optional(),
        spriteMetaPath: z.string().optional(),
        sprite: PetSpriteMetaSchema.optional(),
        audioPath: z.string().optional(),
        category: z.string().default('小动作'),
        weight: z.number().min(0).max(100).default(10),
        /** T-M6-63：氛围动作同样保留朝向与可位移帧区间（巡逻/镜像消费） */
        facing: z.enum(['left', 'right']).optional(),
        moving: z.array(z.tuple([
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
          z.number().positive(),
        ])).optional(),
      }),
    )
    .default([]),
});
export type PetAvatarManifest = z.infer<typeof PetAvatarManifestSchema>;

// ───────────────────────── 星露谷 Mod 管理（T-M6-06） ─────────────────────────
// SMAPI 目录约定：每个 mod 一个文件夹，内含 manifest.json；禁用 = manifest.json 改名为
// manifest.json.disabled（SMAPI 会跳过无 manifest 的文件夹并如实提示）。
/** 单个星露谷 Mod（SMAPI manifest 摘要 + 启用状态） */
export const StardewModInfoSchema = z.object({
  folderName: z.string().min(1),
  uniqueId: z.string().default(''),
  name: z.string().min(1),
  author: z.string().default(''),
  version: z.string().default(''),
  description: z.string().default(''),
  /** manifest 是否存在且未被禁用；false = 已禁用或 manifest 损坏 */
  enabled: z.boolean(),
  /** SMAPI ContentPack / 空（普通 C# mod） */
  contentType: z.string().default(''),
  /** manifest 声明的 lowest SMAPI 版本 */
  minimumApiVersion: z.string().default(''),
  /** manifest 解析失败的原因（enabled=false 且此处非空 = 损坏） */
  parseError: z.string().default(''),
});
export type StardewModInfo = z.infer<typeof StardewModInfoSchema>;

/** Mod 目录扫描快照 */
export const StardewModsSnapshotSchema = z.object({
  modsDir: z.string().min(1),
  /** 目录是否存在（未配置或游戏未安装时为 false） */
  exists: z.boolean(),
  mods: z.array(StardewModInfoSchema).default([]),
  /** SMAPI 本体版本（找到 SMAPI 的 manifest.version 时） */
  smapiVersion: z.string().default(''),
  scannedAt: z.number(),
});
export type StardewModsSnapshot = z.infer<typeof StardewModsSnapshotSchema>;

/** 启用/禁用 Mod */
export const StardewModToggleRequestSchema = z.object({
  folderName: z.string().min(1),
  enabled: z.boolean(),
});
export type StardewModToggleRequest = z.infer<typeof StardewModToggleRequestSchema>;

/** Mod 操作回执（toggle/install/scan 统一形状） */
export const StardewModsOpResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  snapshot: StardewModsSnapshotSchema.optional(),
});
export type StardewModsOpResult = z.infer<typeof StardewModsOpResultSchema>;

/** 星露谷 BWF Mod 默认 MCP 端口（避开 Amazon Quick 等工具写死的 18080，也不撞泰拉瑞亚 18090 / 饥荒 18100） */
export const DEFAULT_BWF_MCP_PORT = 18088;

/** Mod 目录配置（userData/stardew-mods.json） */
export const StardewModsConfigSchema = z.object({
  modsDir: z.string().default(''),
  /** BWF 游戏内左上角 MCP 提示 HUD（T-M6-16 用户指令）：默认关闭不显示；经 /settings 远程下发运行时生效 */
  bwfShowHud: z.boolean().default(false),
  /** 星露谷 BWF Mod MCP 监听端口（单点事实源：同步写入 Mods/BlindWhaleFarmer/config.json 的 McpPort） */
  bwfMcpPort: z.number().int().min(1024).max(65535).default(DEFAULT_BWF_MCP_PORT),
});
export type StardewModsConfig = z.infer<typeof StardewModsConfigSchema>;

// ───────────────────── 星露谷一键启动器（V2-P3-05） ─────────────────────
/**
 * 启动状态机：只按真实探测结果推进，`ready` 必须由 MCP `get_state` 真实应答触发。
 * - not_installed：没找到游戏目录
 * - launching：已 spawn，尚未开始轮询 MCP
 * - waiting_mcp：进程/端口在，但 MCP 尚未就绪（常见于标题画面）
 * - ready：MCP `get_state` 正常应答
 * - timeout：超过等待上限仍未就绪
 * - failed：spawn 失败或游戏在但 SMAPI/Mod 缺失
 */
export const StardewLaunchStateSchema = z.enum([
  'not_installed',
  'launching',
  'waiting_mcp',
  'ready',
  'timeout',
  'failed',
]);
export type StardewLaunchState = z.infer<typeof StardewLaunchStateSchema>;

/** 启动方式：smapi=直接 spawn SMAPI 可执行文件；steam=open steam://rungameid/413150 */
export const StardewLaunchStrategySchema = z.enum(['smapi', 'steam']);
export type StardewLaunchStrategy = z.infer<typeof StardewLaunchStrategySchema>;

export const StardewInstallInfoSchema = z.object({
  /** 游戏目录存在（即使 SMAPI 缺失） */
  gameInstalled: z.boolean(),
  /** SMAPI 可执行文件存在（缺失时无法保证 Mod 被加载） */
  smapiInstalled: z.boolean(),
  /** BWF Mod 的 manifest 存在 */
  bwfInstalled: z.boolean(),
  /** Steam appmanifest_413150.acf 存在 */
  steamAppPresent: z.boolean().default(false),
  /** 游戏根目录（macOS 为 `.../Stardew Valley`，Windows/Linux 为安装目录） */
  gameDir: z.string().default(''),
  /** 可执行文件目录（macOS 为 `.../Stardew Valley/Contents/MacOS`） */
  executableDir: z.string().default(''),
  smapiBinary: z.string().default(''),
  modsDir: z.string().default(''),
});
export type StardewInstallInfo = z.infer<typeof StardewInstallInfoSchema>;

export const StardewLaunchStatusSchema = z.object({
  state: StardewLaunchStateSchema,
  install: StardewInstallInfoSchema,
  /** 本次实际使用的启动方式（已在运行时为 null） */
  strategy: StardewLaunchStrategySchema.nullable().default(null),
  /** 主方式失败后回退到的方式（未回退为 null） */
  fallbackStrategy: StardewLaunchStrategySchema.nullable().default(null),
  /** MCP 端点（始终 127.0.0.1，见 T-M6-74） */
  endpoint: z.string().default(''),
  mcpPort: z.number().int().default(DEFAULT_BWF_MCP_PORT),
  /** 探测时游戏进程是否已在运行（避免重复启动） */
  gameRunning: z.boolean().default(false),
  /** 是否已向 BWF 发送 load_save */
  saveLoadRequested: z.boolean().default(false),
  autoLoadSave: z.boolean().default(true),
  /** MCP 轮询次数（真实探测） */
  attempts: z.number().int().default(0),
  startedAt: z.number().nullable().default(null),
  elapsedMs: z.number().int().default(0),
  timeoutMs: z.number().int().default(120_000),
  /** 人类可读的一行状态 */
  message: z.string().default(''),
  /** 失败/超时时的下一步提示（标题画面、Mod 缺失等） */
  hint: z.string().default(''),
});
export type StardewLaunchStatus = z.infer<typeof StardewLaunchStatusSchema>;

export const StardewLaunchOptionsSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  /** 等待 MCP 就绪的上限（毫秒），默认 120s */
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
  /** 是否在 MCP 可达但未就绪时调用 BWF `load_save`，默认 true */
  autoLoadSave: z.boolean().optional(),
  /** auto=smapi 失败后回退 steam；smapi=只直接 spawn；steam=只走 Steam */
  strategy: z.enum(['auto', 'smapi', 'steam']).optional(),
  /**
   * 联机隔离实例的数据目录（**必须是绝对路径**）。
   *
   * 给出时宿主给游戏子进程注入 `XDG_CONFIG_HOME=<dir>/xdg-config` 与
   * `XDG_DATA_HOME=<dir>/xdg-data`：游戏的 `Saves`、`startup_preferences`、`default_options`
   * 与 SMAPI 的 `mod-data` 全部落在隔离目录，**不触碰 owner 的 `~/.config/StardewValley`**。
   *
   * 为什么是绝对路径：macOS 的 .NET 运行时只在 `XDG_CONFIG_HOME` 以 `/` 开头时采纳，
   * 否则静默回退 `$HOME/.config`（隔离会失效却不报错）。
   *
   * 为什么不能配 `strategy='steam'`：`open steam://…` 无法携带环境变量，
   * 用 Steam 启动等于共用 owner 存档，宿主必须如实拒绝而不是静默放行。
   */
  isolateDataDir: z.string().min(1).regex(/^(\/|[A-Za-z]:[\\/])/u, 'isolateDataDir 必须是绝对路径').optional(),
});
export type StardewLaunchOptions = z.infer<typeof StardewLaunchOptionsSchema>;

// 分屏/联机实例与游戏内身体的绑定（`V2-P2-09A`）单一事实源在 `./coop`
// （与 `CoopParticipantSchema` 同处），已由文件末尾的 `export * from './coop'` 统一对外暴露。

// ───────────────────────── 记忆图谱视图（T-M6-07 UI v4 记忆页） ─────────────────────────
/** 记忆节点视图（渲染层/Dexie 只读镜像；正文已消毒） */
export const MemoryNodeViewSchema = z.object({
  id: z.string(),
  nodeType: z.enum(['event', 'entity', 'concept', 'summary']),
  text: z.string(),
  importance: z.number().min(0).max(1),
  pinned: z.boolean(),
  createdAt: z.number(),
  /** 游戏日键（event 来自 meta.day；summary 同） */
  day: z.string().default(''),
  instanceCount: z.number().int().min(1).default(1),
});
export type MemoryNodeView = z.infer<typeof MemoryNodeViewSchema>;

export const MemoryEdgeViewSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['temporal', 'causal', 'semantic', 'entity', 'instance']),
  weight: z.number().min(0).max(1),
});
export type MemoryEdgeView = z.infer<typeof MemoryEdgeViewSchema>;

/** 图谱快照（节点上限 200，按重要度+新近排序；days = 日记可选日键） */
export const MemoryGraphViewSchema = z.object({
  nodes: z.array(MemoryNodeViewSchema),
  edges: z.array(MemoryEdgeViewSchema),
  days: z.array(z.string()),
  stats: z.object({
    nodes: z.number().int().min(0),
    edges: z.number().int().min(0),
    lastDay: z.string().nullable(),
  }),
});
export type MemoryGraphView = z.infer<typeof MemoryGraphViewSchema>;

// ───────────────────────── 运行时大脑配置与饭碗状态（T-M6-08 P0 收尾） ─────────────────────────
/**
 * 渲染层 → 主进程的大脑配置（不含任何密钥；key 仍只在主进程 vault 解密）。
 * providerModels 用于「供应商卡选中的激活模型」覆盖槽位里的空模型（通常槽位已是 provider/model 全串）。
 */
export const BrainRuntimeConfigSchema = z.object({
  profile: DiningProfilePresetSchema,
  providerModels: z.record(z.string(), z.string()).default({}),
  /** 渲染层合并后的服务商清单（内置覆盖 + 自定义；不含密钥，key 只在主进程 vault） */
  providers: z.array(ModelProviderConfigSchema).default([]),
});
export type BrainRuntimeConfig = z.infer<typeof BrainRuntimeConfigSchema>;

/** 饭碗实时状态（1 粒米 = 1 Token；budget 默认 500,000/日） */
export const RiceBowlStatusSchema = z.object({
  balance: z.number().int().min(0),
  budget: z.number().int().positive(),
  consumedToday: z.number().int().min(0),
  /** 剩余比例档位（供桌宠动作/气泡使用） */
  level: z.enum(['starving', 'hungry', 'ok', 'full', 'fed_buff']),
});
export type RiceBowlStatus = z.infer<typeof RiceBowlStatusSchema>;

// ───────────────────────── 桌宠桌面偏好（T-M6-19 用户指令：放哪停哪 + 缩放 + 多角色/联机底座） ─────────────────────────
/**
 * 桌宠桌面偏好单点事实源：位置/缩放/拖拽手感/角色/联机端点。
 * 落 userData/pet-desktop-prefs.json（主进程文件 KV，坏文件回落默认值）；渲染层经 preload 读写，
 * 后续缩放 UI、角色切换、多 MCP 端点都复用这一份契约（跨语言生成 TS/JSON Schema/Pydantic）。
 */
export const PetDesktopPrefsSchema = z.object({
  /** 窗口左上角 DIP 坐标；displayId 为空表示主屏/未知 */
  position: z.object({
    x: z.number(),
    y: z.number(),
    displayId: z.string().default(''),
  }).default({ x: 80, y: 80, displayId: '' }),
  /** 桌宠缩放倍率（相对角色基准尺寸），T-M6-20 接入滚轮/滑块/右键菜单 */
  scale: z.number().min(0.6).max(2).default(1),
  /** 松手行为：stick=放哪停哪（默认）；glide=无重力轻惯性；gravity=旧重力甩抛 */
  dragBehavior: z.enum(['stick', 'glide', 'gravity']).default('stick'),
  /** 当前角色包 id（T-M6-21 多角色） */
  characterId: z.string().default('blue-whale-maid'),
  /** 当前联机端点 id（T-M6-22 多桌宠联机；default=单机 18080） */
  mcpEndpointId: z.string().default('default'),
  /** 闲置 30s 进入省电（停氛围/特效帧） */
  powerSaverEnabled: z.boolean().default(true),
  /** 全局快捷键 Ctrl+Option+P 暂藏/唤回 */
  shortcutHideEnabled: z.boolean().default(true),
  /** 全屏应用自动隐藏 */
  autoHideFullscreen: z.boolean().default(true),
  /** 精灵图动作原声音效开关/音量（T-M6-44） */
  sfxEnabled: z.boolean().default(true),
  sfxVolume: z.number().min(0).max(1).default(0.7),
  /** 前台应用自动切角（T-M6-55）：命中角色 character.json.apps 时切 default 主桌宠 */
  followFrontApp: z.boolean().default(false),
  /** 窗口显示层级（T-M6-63）：always=始终置顶；follow-ai=仅 AI 干活时置顶；normal=普通层级 */
  windowLayer: z.enum(['always', 'follow-ai', 'normal']).default('always'),
  /** 气泡字号独立缩放（T-M6-63）：null=跟随人物 scale，非 null 时单独生效 */
  bubbleFontScale: z.number().min(0.7).max(1.6).nullable().default(null),
  /** 允许桌宠空闲自主巡逻（T-M6-64：25–45s 低概率短距离散步） */
  patrolEnabled: z.boolean().default(true),
  /** 小本子手写体（T-M6-65）：auto=按角色自动匹配，其余为具体字体 id */
  notebookFontId: z.string().default('auto'),
  /** 是否允许随机触发双宠彩蛋小剧场（T-M6-65） */
  randomEggEnabled: z.boolean().default(true),
  /** DeepSeek/GLM 峰谷自动换装开关（T-M6-65） */
  peakOutfitEnabled: z.boolean().default(false),
  /** 高峰时段皮肤（默认 DeepSeek 常态） */
  peakOutfitDay: z.string().default('crosspet-deepseek'),
  /** 优惠空闲时段皮肤（默认 DeepSeek 睡衣） */
  peakOutfitOffPeak: z.string().default('crosspet-deepseek-pajamas'),
  /**
   * 语音引擎档位（item 10）：默认商业 API；`offline_preferred` = 用户主动选择的离线档。
   * 语义是「用户选择」，不是「本地引擎装没装」——装了也不自动优先。
   */
  voiceEngineTier: VoiceEngineTierSchema.default('commercial_default'),
});
export type PetDesktopPrefs = z.infer<typeof PetDesktopPrefsSchema>;

// ───────────────────────── 多桌宠窗口（T-M6-38：同屏多开，每 Agent 独立窗口状态） ─────────────────────────
/** 单只桌宠的窗口偏好；与 PetDesktopPrefs（应用级拖拽手感/当前角色）分文件持久化。 */
export const PetWindowPreferencesSchema = z.object({
  agentId: z.string().min(1),
  characterId: z.string().min(1).default('blue-whale-maid'),
  position: z.object({
    x: z.number(),
    y: z.number(),
    displayId: z.string().default(''),
  }),
  scale: z.number().min(0.6).max(2).default(1),
  /** 锁定后桌宠窗不可拖拽/缩放（仍可正常接收动作与语音） */
  locked: z.boolean().default(false),
  /** 上次是否处于显示状态；关闭窗口时保留坐标，下次 open 原位恢复 */
  visible: z.boolean().default(true),
});
export type PetWindowPreferences = z.infer<typeof PetWindowPreferencesSchema>;

export const PetWindowPreferencesFileSchema = z.object({
  version: z.literal(1).default(1),
  windows: z.record(z.string(), PetWindowPreferencesSchema).default({}),
});
export type PetWindowPreferencesFile = z.infer<typeof PetWindowPreferencesFileSchema>;

/** 主进程 → 中控台的运行中桌宠窗口视图（不含 Electron 对象） */
export const PetWindowViewSchema = z.object({
  agentId: z.string().min(1),
  characterId: z.string().min(1),
  visible: z.boolean(),
  locked: z.boolean(),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
});
export type PetWindowView = z.infer<typeof PetWindowViewSchema>;

/** 全局串行抢麦状态：同一时刻最多一只桌宠 speaking，其余 idle/倾听。 */
export const CoopSpeakerEventSchema = z.object({
  activeAgentId: z.string().nullable(),
  speakerName: z.string(),
  state: z.enum(['speaking', 'idle']),
  voiceId: z.string().optional(),
});
export type CoopSpeakerEvent = z.infer<typeof CoopSpeakerEventSchema>;

// ───────────────────────── 桌宠角色注册表（T-M6-21：多角色底座） ─────────────────────────
export const PetStudioSkinSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  outfit: z.string().default(''),
  accent: z.string().default(''),
  kind: z.enum(['base', 'skin', 'egg']),
  previewUrl: z.string().default(''),
  frameCount: z.number().int().nonnegative().default(0),
});
export type PetStudioSkin = z.infer<typeof PetStudioSkinSchema>;

/** 角色包元数据（不含密钥/大资产；资产由 manifest 的 webmPath 指向） */
export const PetCharacterSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  /** manifest JSON 相对 dist/renderer/pet-stage 的路径（内置角色）或 userData 绝对路径（自定义） */
  manifestPath: z.string().min(1),
  /** 该角色的聊天人设 system（与 persona-brain 的 PetPersonaConfig 分工：这里管口吻，那里管反射规则） */
  personaPrompt: z.string().min(1),
  /** 默认音色（voice-host 的 voiceId） */
  voiceId: z.string().default('qiaopi_mengmei'),
  /** 角色级默认语速/音调微调（T-M6-41；100=基准，1=原音高） */
  voiceRatePercent: z.number().min(50).max(200).default(100),
  voicePitchMul: z.number().min(1).max(1.6).default(1),
  /** 角色包来源 id（aboutme-pets 等；内置为空） */
  packId: z.string().default(''),
  /** 动作与原声音轨数量（角色包商店展示） */
  actionCount: z.number().int().nonnegative().default(0),
  audioClipCount: z.number().int().nonnegative().default(0),
  /** 角色主体水平锚点比例（饭碗居中用；实测由截图/渲染分析得出） */
  anchorRatio: z.number().min(0).max(1).default(0.5),
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']).default('DEV_ONLY_NON_COMMERCIAL'),
  builtin: z.boolean().default(false),
  /** T-M6-48：CrossPet 换装皮肤（含 egg-* 彩蛋）；pose-skin 渲染器按 skinId 热换装 */
  skins: z.array(PetStudioSkinSchema).default([]),
});
export type PetCharacter = z.infer<typeof PetCharacterSchema>;

// ───────────────────────── 联机端点注册表（T-M6-22：多桌宠各控一个游戏实例） ─────────────────────────
/** 一个 MCP 端点 = 一个游戏实例 = 一个桌宠角色（单机多开/多人联机） */
export const McpEndpointSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  gameId: z.enum(['stardew', 'terraria', 'dst']).default('stardew'),
  /** MCP Streamable HTTP 根（默认 127.0.0.1:18080/mcp；多开时各实例不同端口） */
  endpoint: z.string().url(),
  characterId: z.string().default('blue-whale-maid'),
  /** 游戏侧逻辑玩家路由键：DST 必须等于 Mod 上报的 Klei UserID；留空回退端点 id */
  routingId: z.string().max(128).default(''),
  enabled: z.boolean().default(true),
});
export type McpEndpoint = z.infer<typeof McpEndpointSchema>;

// ───────────────────────── 多 AI 联机协作（T-M6-39：目标 / 分工 / 黑板 / 群聊） ─────────────────────────
export const TeamGoalMetricSchema = z.object({
  label: z.string().min(1),
  current: z.number(),
  target: z.number(),
  unit: z.string().default(''),
  /** 真实数据源；manual 由人/商定计划维护，其余由 CoopHost 从游戏状态聚合 */
  source: z.enum(['manual', 'team_money', 'shared_wood']).default('manual'),
});
export type TeamGoalMetric = z.infer<typeof TeamGoalMetricSchema>;

export const TeamGoalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  gameId: z.enum(['stardew', 'terraria', 'dst']),
  metrics: z.array(TeamGoalMetricSchema).default([]),
  /** ISO 时间或游戏内日期文本；空串表示无硬截止 */
  deadline: z.string().default(''),
  status: z.enum(['active', 'completed', 'paused']).default('active'),
});
export type TeamGoal = z.infer<typeof TeamGoalSchema>;

export const TeamAssignmentSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  role: z.enum(['human', 'ai']),
  task: z.string(),
  zone: z.string(),
  status: z.enum(['working', 'idle', 'need_help', 'offline']).default('idle'),
  progressNote: z.string().default(''),
  updatedAt: z.number().int().nonnegative(),
});
export type TeamAssignment = z.infer<typeof TeamAssignmentSchema>;

export const TeamZoneLockSchema = z.object({
  zone: z.string().min(1),
  ownerAgentId: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type TeamZoneLock = z.infer<typeof TeamZoneLockSchema>;

export const TeamHuddleStateSchema = z.object({
  active: z.boolean().default(false),
  round: z.number().int().min(0).max(3).default(0),
  maxRounds: z.number().int().min(2).max(3).default(3),
  /** epoch ms；0 表示从未自动协商，可立即触发 */
  cooldownUntil: z.number().int().nonnegative().default(0),
});
export type TeamHuddleState = z.infer<typeof TeamHuddleStateSchema>;

export const TeamBlackboardSnapshotSchema = z.object({
  goal: TeamGoalSchema,
  assignments: z.array(TeamAssignmentSchema).default([]),
  zoneLocks: z.array(TeamZoneLockSchema).default([]),
  huddleState: TeamHuddleStateSchema,
  version: z.number().int().nonnegative().default(0),
});
export type TeamBlackboardSnapshot = z.infer<typeof TeamBlackboardSnapshotSchema>;

/** 开麦商量最终可执行的分工卡（由 HuddleOrchestrator 产出并写入黑板） */
export const TeamPlanTaskSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1).default(''),
  task: z.string().min(1),
  zone: z.string().default(''),
});
export type TeamPlanTask = z.infer<typeof TeamPlanTaskSchema>;

export const TeamPlanSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(''),
  assignments: z.array(TeamPlanTaskSchema).default([]),
});
export type TeamPlan = z.infer<typeof TeamPlanSchema>;

export const TeamCommsMessageSchema = z.object({
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  fromAgentId: z.string().min(1),
  fromName: z.string().min(1),
  fromRole: z.enum(['human', 'ai', 'system']),
  mentions: z.array(z.string()).default([]),
  kind: z.enum(['chat', 'proposal', 'plan_commit', 'need_help', 'handoff', 'directive']),
  text: z.string(),
  planCard: TeamPlanSchema.optional(),
});
export type TeamCommsMessage = z.infer<typeof TeamCommsMessageSchema>;

// ───────────────────────── 随包桌宠素材与桌宠工坊目录（T-M6-45：离线开箱即用） ─────────────────────────
/**
 * 桌宠工坊「动作预览与素材库」目录（IPC `pet:studio-catalog`）。
 * 主进程只读 `assets/pet-packs/`（打包后 `Resources/pet-packs/`），素材经 `whale-pet://` 只读协议下发。
 */
export const PetStudioPackSchema = z.object({
  slug: z.string().min(1),
  catalogId: z.string().min(1),
  displayName: z.string().min(1),
  installed: z.boolean().default(false),
  actionCount: z.number().int().nonnegative().default(0),
  audioClipCount: z.number().int().nonnegative().default(0),
  /** 上游 manifest.idleAnimationId：该角色/形象自己的待机动作（切角色时自动选中） */
  idleClipId: z.string().default(''),
});
export type PetStudioPack = z.infer<typeof PetStudioPackSchema>;

export const PetStudioActionSchema = z.object({
  slug: z.string().min(1),
  packId: z.string().min(1),
  displayName: z.string().default(''),
  clipId: z.string().min(1),
  category: z.string().default('小动作'),
  frameCount: z.number().int().nonnegative().default(0),
  columns: z.number().int().nonnegative().default(0),
  /** 上游每动作独立帧尺寸与网格（不是全局 640×360） */
  rows: z.number().int().nonnegative().default(0),
  frameWidth: z.number().int().positive().default(640),
  frameHeight: z.number().int().positive().default(360),
  sampleFps: z.number().positive().default(12),
  hasAudio: z.boolean().default(false),
  spriteUrl: z.string().default(''),
  audioUrl: z.string().default(''),
});
export type PetStudioAction = z.infer<typeof PetStudioActionSchema>;

export const PetStudioSlotSchema = z.object({
  packId: z.string().min(1),
  slot: PetActionStateSchema,
  clipIds: z.array(z.string()).default([]),
});
export type PetStudioSlot = z.infer<typeof PetStudioSlotSchema>;

export const PetStudioFontSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  file: z.string().min(1),
  url: z.string().min(1),
});
export type PetStudioFont = z.infer<typeof PetStudioFontSchema>;

export const PetStudioCatalogSchema = z.object({
  generatedAt: z.string().default(''),
  packs: z.array(PetStudioPackSchema).default([]),
  actions: z.array(PetStudioActionSchema).default([]),
  slots: z.array(PetStudioSlotSchema).default([]),
  skins: z.array(PetStudioSkinSchema).default([]),
  fonts: z.array(PetStudioFontSchema).default([]),
  /** 素材包读取失败原因（缺包/坏 JSON）；只做展示，不阻断页面 */
  errors: z.array(z.string()).default([]),
});
export type PetStudioCatalog = z.infer<typeof PetStudioCatalogSchema>;

// ───────────────────────── 自定义角色深度协议（T-M6-53：兼容 CrossPet character.json） ─────────────────────────
export const PetCustomGlyphSchema = z.object({
  fill: z.string().default(''),
  /** 描边色（T-M6-55：CrossPet glyph 双色；留空只填充） */
  stroke: z.string().default(''),
  text: z.string().default(''),
});
export type PetCustomGlyph = z.infer<typeof PetCustomGlyphSchema>;

export const PetLongThinkSchema = z.object({
  after: z.number().int().min(1).max(600).default(20),
  pose: z.string().min(1).default('deepthink'),
});
export type PetLongThink = z.infer<typeof PetLongThinkSchema>;

export const PetMilestoneSchema = z.object({
  id: z.string().min(1),
  /** 工具调用次数 / 连续天数等阈值；0 表示手动触发 */
  at: z.number().nonnegative().default(0),
  text: z.string().default(''),
  pose: z.string().default(''),
});
export type PetMilestone = z.infer<typeof PetMilestoneSchema>;

export const PetNotebookConfigSchema = z.object({
  title: z.string().default(''),
  font: z.string().default(''),
  entries: z.array(z.string()).default([]),
  /** CrossPet 兼容：notes 与 entries 合并展示（T-M6-55） */
  notes: z.array(z.string()).default([]),
  /** 小本子落款（支持 {h} 占位当前小时） */
  sign: z.string().default(''),
});
export type PetNotebookConfig = z.infer<typeof PetNotebookConfigSchema>;

/**
 * 自定义角色深度字段（`userData/pet-characters/<id>/character.json`）。
 * lines 以「姿态/场景键 → 台词池」保存，CrossPet 的 greet_*（6 时段）与 fest_*（8 节日）
 * 就是 lines 的键；额外补齐 reactTo / milestones / notebook 等 Workbench 扩展。
 */
export const PetCustomCharacterSchema = z.object({
  schemaVersion: z.number().int().default(1),
  name: z.string().min(1),
  accent: z.string().default('#0a84ff'),
  /** 该角色会跟随的桌面 AI 应用（bundle id / 名称，仅供展示与匹配提示） */
  apps: z.array(z.string()).default([]),
  /** 代演哪些 AI：`"*"` 或来源/modelName 列表 */
  reactTo: z.union([z.literal('*'), z.array(z.string())]).default('*'),
  greeting: z.string().default(''),
  /** 姿态/场景 → 台词池（含 greet_* / fest_*） */
  lines: z.record(z.string(), z.array(z.string())).default({}),
  glyph: PetCustomGlyphSchema.default({ fill: '', stroke: '', text: '' }),
  idleActions: z.array(z.string()).default([]),
  pokePose: z.string().default('pout'),
  /** 出错/被打断后 3 分钟内再次对话时触发的姿态 */
  correctedPose: z.string().default('sorry'),
  longThink: PetLongThinkSchema.default({ after: 20, pose: 'deepthink' }),
  /** 具名 SVG 特效映射：bubbles/steam/celebrate/victory/priceDown/priceUp 等 */
  fx: z.record(z.string(), z.string()).default({}),
  milestones: z.array(PetMilestoneSchema).default([]),
  notebook: PetNotebookConfigSchema.default({ title: '', font: '', entries: [], notes: [], sign: '' }),
  // ── CrossPet 现存字段（保持兼容，缺省安全回退） ──
  outfit: z.string().default(''),
  aura: z.string().default(''),
  caption: z.string().default(''),
  lowBalance: z.number().default(5),
  host: z.string().default(''),
  hostSkin: z.string().default(''),
  skinName: z.string().default(''),
  skinOf: z.string().default(''),
  egg: z.boolean().default(false),
});
export type PetCustomCharacter = z.infer<typeof PetCustomCharacterSchema>;

// ───────────────────────── 创作中心直连生图（T-M6-56） ─────────────────────────
/** 生图协议：OpenAI 兼容 Images API / Gemini Native generateContent(IMAGE)。 */
export const ImageGenProtocolSchema = z.enum(['openai', 'gemini', 'codex-cli']);
export type ImageGenProtocol = z.infer<typeof ImageGenProtocolSchema>;

/**
 * 渲染层只上送「非敏感」供应商描述（id/名称/端点/模型候选）；
 * API Key 永远只由主进程 provider-vault 解密，绝不经 IPC 往返。
 */
export const ImageGenProviderDescriptorSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().max(160).default(''),
  baseUrl: z.string().url(),
  protocol: ImageGenProtocolSchema.default('openai'),
  candidateModels: z.array(z.string().min(1).max(200)).max(40).default([]),
});
export type ImageGenProviderDescriptor = z.infer<typeof ImageGenProviderDescriptorSchema>;

const POSE_ID_PATTERN = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5_-]{0,59}$/;
const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{3,59}$/;

export const ImageGenBatchRequestSchema = z.object({
  provider: ImageGenProviderDescriptorSchema,
  modelId: z.string().min(1).max(200),
  prompt: z.string().min(1).max(6000),
  /** 选中的姿态列表或彩蛋 4 态（文件名即姿态名，已做安全字符限制） */
  poses: z.array(z.string().regex(POSE_ID_PATTERN)).min(1).max(24),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).default('1024x1024'),
  referenceImagePath: z.string().max(4096).optional(),
  jobId: z.string().regex(JOB_ID_PATTERN).optional(),
});
export type ImageGenBatchRequest = z.infer<typeof ImageGenBatchRequestSchema>;

export const ImageGenOneRequestSchema = z.object({
  jobId: z.string().regex(JOB_ID_PATTERN),
  provider: ImageGenProviderDescriptorSchema,
  modelId: z.string().min(1).max(200),
  prompt: z.string().min(1).max(6000),
  pose: z.string().regex(POSE_ID_PATTERN),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).default('1024x1024'),
  referenceImagePath: z.string().max(4096).optional(),
});
export type ImageGenOneRequest = z.infer<typeof ImageGenOneRequestSchema>;

export const ImageGenProgressSchema = z.object({
  jobId: z.string().min(1),
  pose: z.string().min(1),
  status: z.enum(['queued', 'generating', 'done', 'failed']),
  index: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
  /** 预览 data URL（≤ 8MB 原图；主进程不落盘 base64） */
  dataUrl: z.string().max(12_000_000).optional(),
  file: z.string().max(1024).optional(),
  error: z.string().max(2000).optional(),
});
export type ImageGenProgress = z.infer<typeof ImageGenProgressSchema>;

export const ImageGenDraftCommitSchema = z.object({
  jobId: z.string().regex(JOB_ID_PATTERN),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  displayName: z.string().max(40).optional(),
  characterPatch: z.record(z.string(), z.unknown()).optional(),
});
export type ImageGenDraftCommit = z.infer<typeof ImageGenDraftCommitSchema>;

// ───────────────────────── 中文化工具/状态词表（T-M6-59：OBS 挂件与 Shell 共用） ─────────────────────────
/** 简短中文工具名（不带英文括号，适合 OBS 直播画面）；未知工具原样返回。 */
export const WORKBENCH_TOOL_LABELS_ZH: Readonly<Record<string, string>> = {
  travel_to: '前往',
  fish: '钓鱼',
  water_crops: '浇水',
  harvest_crops: '收获',
  till_area: '耕地',
  plant_seeds: '播种',
  clear_area: '清理',
  forage: '采集',
  tidy_backpack: '整理背包',
  ship_items: '出货',
  store_items: '存入箱子',
  take_items: '取回物品',
  trash_item: '扔掉',
  eat: '吃东西',
  read_mail: '读信',
  quest_board: '任务板',
  donate_bundles: '捐赠收集包',
  bundle_info: '查看收集包',
  sleep: '睡觉',
  craft: '制作',
  place_item: '摆放物品',
  open_shop: '打开商店',
  buy: '购买',
  sell: '出售',
  interact: '交互',
  use_tool: '使用工具',
  explore_mine: '探索矿洞',
  fight: '战斗',
  dialogue: '对话',
  close_menu: '关闭界面',
  skip_event: '跳过剧情',
  set_name: '起名',
  festival: '节日',
  update_notes: '记笔记',
  reserve_items: '预留物品',
  gift_info: '查看礼物',
  give_gift: '送礼物',
  cook: '烹饪',
  care_animals: '照顾动物',
  chat_reply: '回话',
  chat_order: '接单',
  reflex_spray: '雷区反射',
  autodrive: '自动驾驶',
};
export const WORKBENCH_STATUS_LABELS_ZH: Readonly<Record<string, string>> = {
  COMPLETED: '已完成',
  FAILED: '失败',
  UNCERTAIN: '不确定',
  TIMEOUT: '超时',
  ERROR: '错误',
};

export function toolLabelZh(tool: string | undefined | null): string {
  if (tool === undefined || tool === null || tool === '') return '待命';
  const labeled = WORKBENCH_TOOL_LABELS_ZH[tool];
  if (labeled !== undefined) return labeled;
  // 雷区反射的工具名是 reflex_<actionState>（T-A2 2026-11-24）：任何动作状态都标为「雷区反射」
  if (tool.startsWith('reflex_')) return '雷区反射';
  return tool;
}

export function statusLabelZh(status: string | undefined | null): string {
  if (status === undefined || status === null || status === '') return '—';
  return WORKBENCH_STATUS_LABELS_ZH[status] ?? status;
}

// ───────────────────────── 星露谷像素表生成请求（T-M6-62，创作中心 IPC 入参） ─────────────────────────
/** 星露谷精灵表清晰度档位：1x 原版 16×32 · 2x 精致像素 32×64（推荐默认） · 4x 高清 Q 版 64×128 */
export const StardewSpriteTierSchema = z.enum(['1x', '2x', '4x']);
export type StardewSpriteTier = z.infer<typeof StardewSpriteTierSchema>;

export const StardewSpriteGenRequestSchema = z.object({
  characterId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  provider: ImageGenProviderDescriptorSchema,
  modelId: z.string().min(1).max(200),
  /** 清晰度档位：默认 2x（192×256，兼顾星露谷像素感与清晰度） */
  tier: StardewSpriteTierSchema.default('2x'),
  /** 缺省时由主进程用 compileStardewSpritePrompt 编译 */
  prompt: z.string().max(6000).optional(),
  /** 可选参考图（创作中心「参考图」按钮选择；主进程复核存在性/扩展名/大小） */
  referenceImagePath: z.string().min(1).max(1024).optional(),
});
export type StardewSpriteGenRequest = z.infer<typeof StardewSpriteGenRequestSchema>;

/** 从已保留的原图秒切清晰度档位（免重新调用 AI 生图） */
export const StardewSpriteReprocessRequestSchema = z.object({
  characterId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  tier: StardewSpriteTierSchema,
});
export type StardewSpriteReprocessRequest = z.infer<typeof StardewSpriteReprocessRequestSchema>;

// ───────────────────────── 星露谷桌宠像素外观同步（T-M6-62） ─────────────────────────
/** 原版兜底外观预设：非破坏性（只改发色/发型/衣裤/肤色/帽子等外观字段，不动存档数据）。 */
export const StardewAvatarPresetSchema = z.object({
  hair: z.number().int().min(0).max(300).default(0),
  hairColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8a5a2b'),
  shirt: z.number().int().min(0).max(300).default(0),
  pantsColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b5bdb'),
  skin: z.number().int().min(0).max(30).default(0),
  /** -1 = 不戴帽子 */
  hatId: z.number().int().min(-1).max(300).default(-1),
});
export type StardewAvatarPreset = z.infer<typeof StardewAvatarPresetSchema>;

/**
 * `Mods/WhaleIsleAvatar/active-avatar.json` 契约：主进程原子写入，SMAPI Mod 主线程热重载。
 * spriteSheetPath 为相对 Mod 目录的文件名（支持 1× 96×128 / 2× 192×256 / 4× 384×512 PNG，
 * 4 行×6 列，兼容旧版 4 列；行序 下/右/上/左，列序 待机+3 行走+动作+表情）；缺省或坏图时 Mod 回落原版预设。
 */
export const StardewAvatarSyncSchema = z.object({
  version: z.literal(1),
  characterId: z.string().min(1).max(80),
  displayName: z.string().min(1).max(40),
  preset: StardewAvatarPresetSchema,
  spriteSheetPath: z.string().max(260).optional(),
  /** 贴图清晰度档位提示（Mod 也会按实际 PNG 像素宽高自动识别） */
  spriteTier: StardewSpriteTierSchema.optional(),
  /** 程序化灵动动画开关（脚底阴影、待机微呼吸、走路轻弹跳与微倾、动作弹性） */
  liveliness: z.boolean().default(true),
});
export type StardewAvatarSync = z.infer<typeof StardewAvatarSyncSchema>;

// ───────────────────────── 对外本机驱动口（T-M6-49：/api/pet/:agentId/*） ─────────────────────────
export const PetApiSayRequestSchema = z.object({
  text: z.string().min(1).max(500),
  scene: z.enum(['normal', 'inner', 'p0']).default('normal'),
  /** 睡觉态默认拒收；显式 wake=true 才叫醒并说话 */
  wake: z.boolean().default(false),
});
export type PetApiSayRequest = z.infer<typeof PetApiSayRequestSchema>;

export const PetApiActionRequestSchema = z.object({
  actionState: PetActionStateSchema,
  durationMs: z.number().int().min(500).max(60_000).default(6_000),
});
export type PetApiActionRequest = z.infer<typeof PetApiActionRequestSchema>;

export const PetApiStateSchema = z.object({
  agentId: z.string().min(1),
  characterId: z.string().min(1),
  displayName: z.string().default(''),
  skinId: z.string().default(''),
  sleeping: z.boolean().default(false),
  speaking: z.boolean().default(false),
  visible: z.boolean().default(false),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
});
export type PetApiState = z.infer<typeof PetApiStateSchema>;

// ───────────────────────── 跨 AI 工作跟随（T-M6-49 / T-M6-65） ─────────────────────────
/** 事件来源通道（面板诚实标注来源 + Hook/日志去重，T-M6-65） */
export const WorkFollowOriginSchema = z.enum(['hook', 'log-watch', 'acp', 'manual']);
export type WorkFollowOrigin = z.infer<typeof WorkFollowOriginSchema>;

export const WorkFollowEventSchema = z.object({
  /** ACP harness / 本机 CLI 钩子来源 */
  source: z.enum(['acp', 'claude', 'codex', 'deepseek', 'gemini', 'cursor', 'qwen', 'kimi', 'grok']),
  sessionId: z.string().min(1).max(128),
  kind: z.enum(['start', 'tool', 'stop', 'asking', 'compact', 'error']),
  /** 只读工具名/模型名；绝不接收对话正文与凭据 */
  toolName: z.string().max(120).default(''),
  modelName: z.string().max(120).default(''),
  taskTitle: z.string().max(120).default(''),
  ts: z.number().int().nonnegative().default(0),
  /** 事件来自 Hook / 免 Hook 日志监听 / ACP / 手动注入（默认 hook 保持旧行为） */
  origin: WorkFollowOriginSchema.default('hook'),
});
export type WorkFollowEvent = z.infer<typeof WorkFollowEventSchema>;

export const WorkFollowSessionSchema = z.object({
  source: z.string().min(1),
  sessionId: z.string().min(1),
  characterId: z.string().default(''),
  toolCalls: z.number().int().nonnegative().default(0),
  startedAt: z.number().int().nonnegative().default(0),
  lastEventAt: z.number().int().nonnegative().default(0),
  taskTitle: z.string().default(''),
  modelName: z.string().default(''),
  crowned: z.boolean().default(false),
  active: z.boolean().default(false),
});
export type WorkFollowSession = z.infer<typeof WorkFollowSessionSchema>;

/** 桌宠侧悬浮任务卡（T-M6-64：最多 4 张，仅标题与状态，绝无对话正文） */
export const WorkFollowCardSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().max(120).default(''),
  state: z.enum(['running', 'asking', 'done', 'error']),
});
export type WorkFollowCard = z.infer<typeof WorkFollowCardSchema>;

export const WorkFollowStatusSchema = z.object({
  mode: z.enum(['single', 'multi']).default('multi'),
  sessions: z.array(WorkFollowSessionSchema).default([]),
  /** 最近 20 条只读事件（source/kind/tool/model，无正文） */
  recent: z.array(z.object({
    source: z.string(),
    kind: z.string(),
    toolName: z.string().default(''),
    at: z.number().int().nonnegative().default(0),
  })).default([]),
  /** 多宠在场策略（T-M6-64）：闲置退场 / 仅应用退出 / 始终随应用 */
  presencePolicy: z.enum(['idle-leave', 'app-exit', 'always-with-app']).default('idle-leave'),
  /** 免 Hook 只读日志监听开关（T-M6-65，默认开启） */
  logWatchEnabled: z.boolean().default(true),
  /** 活跃会话来源：`source:sessionId` → hook/log-watch/acp/manual（面板来源徽标 + 去重） */
  activeOrigins: z.record(z.string(), WorkFollowOriginSchema).default({}),
});
export type WorkFollowStatus = z.infer<typeof WorkFollowStatusSchema>;

export * from './character';
export * from './voice';
export * from './quota';
export * from './memory';
export * from './knowledge';
export * from './ecosystem';
export * from './media';
export * from './coop';
export * from './live';
export * from './browser-computer';
export * from './model';
export * from './social';
export * from './song-console';
