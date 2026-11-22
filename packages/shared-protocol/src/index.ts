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
export type AudioPlaybackLease = z.infer<typeof AudioPlaybackLeaseSchema>;

export const AudioPlaybackReceiptSchema = z.object({
  leaseId: z.string().uuid(),
  status: z.enum(['COMPLETED', 'INTERRUPTED_BY_P0', 'TTL_EXPIRED', 'AUDIO_DEVICE_ERROR']),
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
  /** 实际使用的推理后端：local-gpt-sovits / cloud-* */
  backend: z.string().min(1),
  /** 是否发生了降级（本地失败 → 云端） */
  degraded: z.boolean().default(false),
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
  roleBindings: z.record(WorkbenchRoleSlotSchema, z.string()), // value 为 "providerId/modelId" 或 "group/groupId"
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

/** TTS 情感锚点独立可调参数（每个锚点一条；refText 必填防内部 ASR 卡顿） */
export const TtsEmotionTuningParamsSchema = z.object({
  emotionTag: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'clumsy_panic']),
  refAudioPath: z.string().default(''),
  /** 参考干声对应文本——必填（空值会触发内部 ASR 导致约 40s 卡顿） */
  refText: z.string().min(1),
  speed: z.number().min(0.7).max(1.4).default(1.0),
  temperature: z.number().min(0.1).max(1.0).default(1.0),
  topP: z.number().min(0.1).max(1.0).default(1.0),
  topK: z.number().int().min(1).max(50).default(15),
  pauseConfig: PauseConfigSchema.default({}),
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
export const PetAvatarClipSchema = z.object({
  clipId: z.string(),
  webmPath: z.string().min(1),
  loop: z.boolean().default(true),
  playbackRate: z.number().min(0.1).max(4).default(1),
  /** 帧率（供口型包络/时序对齐，见 SPEC §3.4 情绪 TTS） */
  fps: z.number().int().min(1).max(120).default(30),
  /** 同一动作多片段的随机加权（dsh-pet：按权重首尾相接） */
  weight: z.number().min(0).max(1).default(1),
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
        category: z.string().default('小动作'),
        weight: z.number().min(0).max(100).default(10),
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

/** Mod 目录配置（userData/stardew-mods.json） */
export const StardewModsConfigSchema = z.object({
  modsDir: z.string().default(''),
  /** BWF 游戏内左上角 MCP 提示 HUD（T-M6-16 用户指令）：默认关闭不显示；经 /settings 远程下发运行时生效 */
  bwfShowHud: z.boolean().default(false),
});
export type StardewModsConfig = z.infer<typeof StardewModsConfigSchema>;

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
