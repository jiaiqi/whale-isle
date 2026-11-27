/**
 * 星露谷启动器、从 0 建档/建角色（单机 + 联机房主）、存储隔离、语言映射与 LAN 就绪契约（V2-P3-07A）。
 *
 * 工程边界：
 *   - 仅依赖 zod，不引入运行期实现；
 *   - `StardewLaunchOptionsSchema` 保持与 V2-P3-05 / V2-P2-09A 100% 向后兼容；
 *   - 为满足 gen-contracts.ts（`toJSONSchema({ unrepresentable: 'throw' })`）跨语言生成，
 *     可序列化基础对象（`*CoreSchema`）与带 `.superRefine` 的校验壳分开声明。
 */
import { z } from 'zod';

/** 星露谷 BWF Mod 默认 MCP 端口（避开 Amazon Quick 等工具写死的 18080，也不撞泰拉瑞亚 18090 / 饥荒 18100） */
export const DEFAULT_BWF_MCP_PORT = 18088;

/** 农夫/农场/喜好合法名称：不允许包含跨平台文件/路径非法字符 */
export const SAFE_STARDEW_NAME_RE = /^[^<>:"/\\|?*\u0000-\u001f]+$/u;

/** 绝对路径判定（POSIX `/…` 或 Windows `C:\…` / `C:/…`） */
export const ABSOLUTE_PATH_RE = /^(\/|[A-Za-z]:[\\/])/u;

/**
 * 启动状态机：只按真实探测结果推进，`ready` 必须由 MCP `get_state` 真实应答（及房主模式 LAN 监听）触发。
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

/** 细粒度启动阶段（UI 进度提示与错误定位用，不破坏既有 6 态 `state`） */
export const StardewLaunchPhaseSchema = z.enum([
  'idle',
  'probing',
  'spawning',
  'waiting_bwf',
  'waiting_title',
  'syncing_avatar',
  'creating_save',
  'loading_save',
  'waiting_world',
  'waiting_lan_server',
  'ready',
  'failed',
]);
export type StardewLaunchPhase = z.infer<typeof StardewLaunchPhaseSchema>;

/** 启动与建档确定性错误码 */
export const StardewLaunchErrorCodeSchema = z.enum([
  'NONE',
  'INVALID_OPTIONS',
  'GAME_NOT_INSTALLED',
  'SMAPI_NOT_INSTALLED',
  'BWF_NOT_INSTALLED',
  'ISOLATION_REJECTED',
  'SPAWN_FAILED',
  'MCP_UNREACHABLE',
  'BWF_PATCH_MISSING',
  'LANGUAGE_LOADING',
  'TITLE_NOT_READY',
  'TOO_MANY_FARMS',
  'SAVE_NOT_FOUND',
  'CREATE_SAVE_FAILED',
  'LOAD_SAVE_FAILED',
  'COOP_SERVER_NOT_READY',
  'TIMEOUT',
  'CANCELLED',
]);
export type StardewLaunchErrorCode = z.infer<typeof StardewLaunchErrorCodeSchema>;

/** 启动方式：smapi=直接 spawn SMAPI 可执行文件；steam=open steam://rungameid/413150 */
export const StardewLaunchStrategySchema = z.enum(['smapi', 'steam']);
export type StardewLaunchStrategy = z.infer<typeof StardewLaunchStrategySchema>;

/** 存档存储模式：isolated=鲸屿专属隔离目录（默认，保护 owner 存档）；standard=常规 ~/.config/StardewValley */
export const StardewStorageModeSchema = z.enum(['isolated', 'standard']);
export type StardewStorageMode = z.infer<typeof StardewStorageModeSchema>;

/** 星露谷 1.6 LocalizedContentManager.LanguageCode 枚举值 */
export const StardewLanguageCodeSchema = z.enum([
  'zh',
  'en',
  'ja',
  'ko',
  'ru',
  'pt',
  'es',
  'de',
  'th',
  'fr',
  'it',
  'tr',
  'hu',
]);
export type StardewLanguageCode = z.infer<typeof StardewLanguageCodeSchema>;

const LOCALE_LANGUAGE_PREFIXES: ReadonlyArray<readonly [string, StardewLanguageCode]> = [
  ['zh', 'zh'],
  ['en', 'en'],
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['ru', 'ru'],
  ['pt', 'pt'],
  ['es', 'es'],
  ['de', 'de'],
  ['th', 'th'],
  ['fr', 'fr'],
  ['it', 'it'],
  ['tr', 'tr'],
  ['hu', 'hu'],
];

/** 中控台/系统 locale → 星露谷语言码映射（默认跟随当前中控台中文 `zh`） */
export function mapLocaleToStardewLanguage(locale?: string | null): StardewLanguageCode {
  if (typeof locale !== 'string') return 'zh';
  const normalized = locale.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === '') return 'zh';
  for (const [prefix, code] of LOCALE_LANGUAGE_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      return code;
    }
  }
  return 'zh';
}

export const StardewGameModeSchema = z.enum(['singleplayer', 'coop_host']);
export type StardewGameMode = z.infer<typeof StardewGameModeSchema>;

/** 星露谷 1.6 全部 8 种官方农场类型 */
export const StardewFarmTypeSchema = z.enum([
  'standard',
  'riverland',
  'forest',
  'hilltop',
  'wilderness',
  'four_corners',
  'beach',
  'meadowlands',
]);
export type StardewFarmType = z.infer<typeof StardewFarmTypeSchema>;

export const StardewCabinLayoutSchema = z.enum(['nearby', 'separate']);
export type StardewCabinLayout = z.infer<typeof StardewCabinLayoutSchema>;

/** 标题画面进档策略：load_only=仅续玩已有档；continue_or_create=无档时自动新建；always_new=始终新建；manual=等待人工操作 */
export const StardewSavePolicySchema = z.enum([
  'load_only',
  'continue_or_create',
  'always_new',
  'manual',
]);
export type StardewSavePolicy = z.infer<typeof StardewSavePolicySchema>;

export const StardewPetPreferenceSchema = z.object({
  type: z.enum(['Cat', 'Dog']).default('Cat'),
  breed: z.string().trim().min(1).max(32).default('0'),
});
export type StardewPetPreference = z.infer<typeof StardewPetPreferenceSchema>;

export const StardewCharacterAppearanceSchema = z.object({
  characterId: z.string().trim().min(1).max(64).optional(),
  syncPixelAvatar: z.boolean().default(true),
  gender: z.enum(['male', 'female']).default('female'),
  skin: z.number().int().min(0).max(23).optional(),
  hair: z.number().int().min(0).max(120).optional(),
  hairColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u, '发色需为 #RRGGBB').optional(),
  shirt: z.number().int().min(0).optional(),
  pantsColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u, '裤色需为 #RRGGBB').optional(),
  eyeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u, '瞳色需为 #RRGGBB').optional(),
  hatId: z.number().int().min(-1).optional(),
});
export type StardewCharacterAppearance = z.infer<typeof StardewCharacterAppearanceSchema>;

/** 从 0 建档/建角色参数主体（供 JSON Schema / Pydantic 跨语言生成） */
export const StardewNewSaveConfigBaseSchema = z.object({
  farmerName: z.string().trim().min(1).max(24).regex(SAFE_STARDEW_NAME_RE, '角色名不能包含路径非法字符'),
  farmName: z.string().trim().min(1).max(24).regex(SAFE_STARDEW_NAME_RE, '农场名不能包含路径非法字符'),
  favoriteThing: z.string().trim().min(1).max(24).regex(SAFE_STARDEW_NAME_RE, '喜好不能包含路径非法字符'),
  farmType: StardewFarmTypeSchema.default('standard'),
  modFarmId: z.string().trim().min(1).max(128).optional(),
  mode: StardewGameModeSchema.default('singleplayer'),
  startingCabins: z.number().int().min(0).max(7).default(0),
  cabinLayout: StardewCabinLayoutSchema.default('nearby'),
  skipIntro: z.boolean().default(true),
  separateWallets: z.boolean().default(false),
  profitMargin: z.enum(['normal', '75', '50', '25']).default('normal'),
  pet: StardewPetPreferenceSchema.optional(),
  appearance: StardewCharacterAppearanceSchema.optional(),
});

export const StardewNewSaveConfigSchema = StardewNewSaveConfigBaseSchema.superRefine((val, ctx) => {
  if (val.mode === 'coop_host' && val.startingCabins < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startingCabins'],
      message: '联机房主模式（coop_host）至少需要 1 间初始小屋（startingCabins >= 1）',
    });
  }
});
export type StardewNewSaveConfig = z.infer<typeof StardewNewSaveConfigSchema>;

/** Host 上报的 LAN 联机服务器状态（同时为同机双实例 + LAN 全自动预留边界） */
export const StardewLanHostStatusSchema = z.object({
  isHost: z.boolean().default(false),
  multiplayerMode: z.number().int().min(0).max(2).default(0),
  serverRunning: z.boolean().default(false),
  lanListening: z.boolean().default(false),
  lanPort: z.number().int().min(1).max(65535).default(24642),
  acceptIpConnections: z.boolean().default(false),
  inviteCode: z.string().nullable().default(null),
  startingCabins: z.number().int().nonnegative().default(0),
  availableFarmhandSlots: z.number().int().nonnegative().default(0),
  worldReady: z.boolean().default(false),
  saveFolderName: z.string().nullable().default(null),
  languageCode: z.string().nullable().default(null),
});
export type StardewLanHostStatus = z.infer<typeof StardewLanHostStatusSchema>;

/** 宿主持久化偏好（userData/stardew-launch-prefs.json）：默认隔离目录 + 中文 + 跳过片头 + 同步像素形象 */
export const StardewLaunchPrefsSchema = z.object({
  storageMode: StardewStorageModeSchema.default('isolated'),
  language: StardewLanguageCodeSchema.default('zh'),
  farmName: z.string().trim().min(1).max(24).regex(SAFE_STARDEW_NAME_RE, '农场名不能包含路径非法字符').default('鲸屿'),
  favoriteThing: z.string().trim().min(1).max(24).regex(SAFE_STARDEW_NAME_RE, '喜好不能包含路径非法字符').default('白米饭'),
  farmType: StardewFarmTypeSchema.default('standard'),
  startingCabins: z.number().int().min(1).max(7).default(1),
  cabinLayout: StardewCabinLayoutSchema.default('nearby'),
  skipIntro: z.boolean().default(true),
  syncPixelAvatar: z.boolean().default(true),
});
export type StardewLaunchPrefs = z.infer<typeof StardewLaunchPrefsSchema>;

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
  /** 是否已向 BWF 发送 load_save / create_new_save */
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
  /** V2-P3-07 细粒度启动阶段与结构化回执 */
  phase: StardewLaunchPhaseSchema.default('idle'),
  errorCode: StardewLaunchErrorCodeSchema.default('NONE'),
  savePolicy: StardewSavePolicySchema.default('load_only'),
  gameMode: StardewGameModeSchema.default('singleplayer'),
  storageMode: StardewStorageModeSchema.default('standard'),
  language: StardewLanguageCodeSchema.default('zh'),
  createdSaveSlot: z.string().nullable().default(null),
  lanHost: StardewLanHostStatusSchema.nullable().default(null),
});
export type StardewLaunchStatus = z.infer<typeof StardewLaunchStatusSchema>;

export const StardewLaunchOptionsBaseSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  /** 等待 MCP 就绪的上限（毫秒），默认 120s */
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
  /** 是否在 MCP 可达但未就绪时调用 BWF `load_save`，默认 true（未指定 savePolicy 时兼容使用） */
  autoLoadSave: z.boolean().optional(),
  /** auto=smapi 失败后回退 steam；smapi=只直接 spawn；steam=只走 Steam */
  strategy: z.enum(['auto', 'smapi', 'steam']).optional(),
  /** 联机或默认隔离实例的数据目录（必须是绝对路径，防止 .NET 静默回退 owner 存档） */
  isolateDataDir: z.string().min(1).regex(ABSOLUTE_PATH_RE, 'isolateDataDir 必须是绝对路径').optional(),
  /** 存储模式选择（isolated 启用默认或指定隔离目录；standard 读常规 ~/.config/StardewValley） */
  storageMode: StardewStorageModeSchema.optional(),
  /** 游戏运行语言（默认由宿主按中控台 locale 映射，当前中文为 zh） */
  language: StardewLanguageCodeSchema.optional(),
  /** 进档策略 */
  savePolicy: StardewSavePolicySchema.optional(),
  /** 已有档续玩或新建时的运行模式 */
  gameMode: StardewGameModeSchema.optional(),
  /** load_only / continue_or_create 指定要加载的存档名片段 */
  saveSlotName: z.string().trim().min(1).max(64).optional(),
  /** 从 0 建档/建角色参数 */
  newSave: StardewNewSaveConfigBaseSchema.optional(),
  /** 预留给多实例隔离的绝对 Mods 目录（透传 --mods-path） */
  modsPath: z.string().min(1).regex(ABSOLUTE_PATH_RE, 'modsPath 必须是绝对路径').optional(),
});

export const StardewLaunchOptionsSchema = StardewLaunchOptionsBaseSchema.superRefine((val, ctx) => {
  if ((val.savePolicy === 'always_new' || val.savePolicy === 'continue_or_create') && val.newSave === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['newSave'],
      message: `savePolicy 为 '${val.savePolicy}' 时必须提供 newSave 建档参数`,
    });
  }
  if (val.newSave !== undefined) {
    const check = StardewNewSaveConfigSchema.safeParse(val.newSave);
    if (!check.success) {
      for (const issue of check.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['newSave', ...issue.path],
          message: issue.message,
        });
      }
    }
  }
});
export type StardewLaunchOptions = z.infer<typeof StardewLaunchOptionsSchema>;
