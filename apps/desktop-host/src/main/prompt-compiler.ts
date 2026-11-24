/**
 * 桌宠创作中心提示词编译器（T-M6-53，纯函数）。
 *
 * 输出结构化生图提示词（通用格式 + 角色锁定 + 姿态清单 + 负面约束），
 * 与 design/pet-stage.html 的创作中心文案对齐；不含任何 emoji。
 */

export type PoseTier = 'A' | 'B' | 'C' | 'MEME';

export interface PoseSpec {
  id: string;
  hint: string;
}

export const POSE_TIERS: Array<{ id: PoseTier; label: string; count: number; poses: PoseSpec[] }> = [
  {
    id: 'A',
    label: 'A 档核心 11 态',
    count: 11,
    poses: [
      { id: 'idle', hint: '待机呼吸，身体朝前，脚底落在地面基准线' },
      { id: 'idle-blink', hint: '与 idle 完全同构图，仅闭眼改眼，其余像素保持一致' },
      { id: 'listening', hint: '侧头倾听，耳朵/发饰微微转向' },
      { id: 'thinking', hint: '低头思考，手托下巴，头顶思考符号不出现文字' },
      { id: 'reading', hint: '双手捧书阅读，视线落在书页' },
      { id: 'writing', hint: '伏案书写或敲键盘，专注神情' },
      { id: 'running', hint: '向前奔跑，尾巴/裙摆有动势' },
      { id: 'delegating', hint: '指挥迷你小帮手，手势指向一侧' },
      { id: 'happy', hint: '开心笑眼，双手举起庆祝' },
      { id: 'pat', hint: '被摸头时害羞享受，头顶留出被触碰空间' },
      { id: 'surprised', hint: '惊讶后仰，眼睛放大，嘴微张' },
    ],
  },
  {
    id: 'B',
    label: 'B 档常用 5 态',
    count: 5,
    poses: [
      { id: 'searching', hint: '抬手张望寻找，视线看向侧前方' },
      { id: 'proud', hint: '叉腰得意，下巴微抬' },
      { id: 'compact', hint: '抱膝缩成一团，表示上下文被压缩' },
      { id: 'asking', hint: '举手询问，等待批准' },
      { id: 'tired', hint: '疲惫垂肩，眼皮半垂' },
    ],
  },
  {
    id: 'C',
    label: 'C 档休闲 5 态',
    count: 5,
    poses: [
      { id: 'hum', hint: '哼歌摇摆，音符符号悬浮' },
      { id: 'stretch', hint: '伸懒腰，身体拉长' },
      { id: 'yawn', hint: '打哈欠捂嘴' },
      { id: 'drawing', hint: '拿画笔作画，画布朝向自己' },
      { id: 'swim', hint: '游动姿态，尾巴摆动' },
    ],
  },
  {
    id: 'MEME',
    label: '社区梗',
    count: 6,
    poses: [
      { id: 'proud', hint: '完成大活后戴小皇冠，得意的胜利姿态' },
      { id: 'compact', hint: '把自己塞进行李箱，只露出头和尾巴' },
      { id: 'delegating', hint: '召唤迷你小帮手替自己干活' },
      { id: 'asking', hint: '举牌等待审批，表情期待' },
      { id: 'update', hint: '举着进度牌汇报，不出现任何可读文字' },
      { id: 'bye', hint: '挥手告别，准备退场' },
    ],
  },
];

export interface BuiltinLock {
  id: string;
  label: string;
  /** 随包参考图（相对 assets/pet-packs） */
  reference: string;
  traits: string;
}

export const BUILTIN_LOCKS: BuiltinLock[] = [
  { id: 'deepseek', label: 'DeepSeek · 蓝鲸女仆', reference: 'crosspet/characters/deepseek/portrait-card.webp', traits: '深蓝长发、鲸鱼尾鳍、蓝白女仆裙、深海配色' },
  { id: 'claude', label: 'Claude · 橘发书卷娘', reference: 'crosspet/characters/claude/portrait-card.webp', traits: '橘棕长发、橙色花朵发饰、书卷与学院裙' },
  { id: 'gpt', label: 'GPT · 御姐白龙', reference: 'crosspet/characters/gpt/portrait-card.webp', traits: '白色龙角、御姐体型、绿白配色礼服' },
  { id: 'gemini', label: 'Gemini · 星空异瞳猫娘', reference: 'crosspet/characters/gemini/portrait-card.webp', traits: '猫耳、异色瞳、四芒星发饰、紫蓝星空配色' },
  { id: 'glm', label: 'GLM · 黑狐女仆', reference: 'crosspet/characters/glm/portrait-card.webp', traits: '黑狐耳与狐尾、黑金女仆装、眼罩配饰' },
];

export interface CharacterPromptInput {
  /** 内置锁定 id 或 'custom' */
  lock: string;
  customName?: string;
  customTraits?: string;
  tiers: PoseTier[];
  extra?: string;
}

const FORMAT_RULES = [
  'transparent_background: true',
  'canvas: 1024x1024 or larger, full body, chibi 2.5 heads',
  'character occupies 90% of canvas height, centered, feet on a consistent baseline',
  'continuous dark outline, clean edges, no semi-transparent halo',
  'NO floating text, NO watermark, NO emoji, NO background scenery',
];

function poseLines(tiers: PoseTier[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const tier of POSE_TIERS) {
    if (!tiers.includes(tier.id)) continue;
    for (const pose of tier.poses) {
      if (seen.has(pose.id)) continue;
      seen.add(pose.id);
      lines.push(`- ${pose.id}: ${pose.hint}`);
    }
  }
  return lines;
}

/** 完整角色/皮肤生图提示词。 */
export function compileCharacterPrompt(input: CharacterPromptInput): string {
  const lock = BUILTIN_LOCKS.find((item) => item.id === input.lock);
  const tiers = input.tiers.length > 0 ? input.tiers : (['A'] as PoseTier[]);
  const subject = lock === undefined
    ? `[CHARACTER: CUSTOM] name="${(input.customName ?? '').trim() || '未命名角色'}" traits="${(input.customTraits ?? '').trim() || '请补充发色、瞳色、服装与标志性道具'}"`
    : `[CHARACTER LOCK: ${lock.id.toUpperCase()}] keep exact hair, eyes, outfit and signature prop from reference image; ${lock.traits}`;
  const references = lock === undefined
    ? ['reference: user-provided character sheet (optional)']
    : [`reference: ${lock.reference}`];
  return [
    '[FORMAT RULES]',
    ...FORMAT_RULES.map((line) => `- ${line}`),
    '',
    subject,
    ...references.map((line) => `- ${line}`),
    '',
    `[POSES (${tiers.join('+')})]`,
    ...poseLines(tiers),
    '',
    '[CONSISTENCY]',
    '- all poses share identical design, colors, proportions and outline weight',
    '- idle-blink must match idle framing pixel-for-pixel except the eye region',
    ...(input.extra !== undefined && input.extra.trim() !== '' ? ['', '[EXTRA]', `- ${input.extra.trim()}`] : []),
  ].join('\n');
}

export type EggMode = 'cosplay' | 'prank';

export const EGG_POSES: PoseSpec[] = [
  { id: 'pop', hint: '从纸箱里探出头，惊讶表情' },
  { id: 'pretend', hint: '假装自己就是宿主角色，穿对方的服装与配饰' },
  { id: 'caught', hint: '被当场抓包，双人同框，心虚冒汗' },
  { id: 'bye', hint: '挥手逃跑前告别' },
  { id: 'escape', hint: '转身逃跑，只留背影与尾鳍/尾巴' },
];

export interface EggPromptInput {
  mode: EggMode;
  /** 主角（串门者）锁定 id 或自定义名称 */
  guest: string;
  /** 宿主角色锁定 id 或自定义名称 */
  host: string;
  guestReference?: string;
  hostReference?: string;
}

/** 双参考图彩蛋提示词（5 态）。 */
export function compileEggPrompt(input: EggPromptInput): string {
  const guestRef = input.guestReference ?? (BUILTIN_LOCKS.find((item) => item.id === input.guest)?.reference ?? 'user-provided guest sheet');
  const hostRef = input.hostReference ?? (BUILTIN_LOCKS.find((item) => item.id === input.host)?.reference ?? 'user-provided host sheet');
  const modeLine = input.mode === 'cosplay'
    ? `COSPLAY: guest "${input.guest}" wears the host "${input.host}" outfit and hair accessory while keeping own hair color, tail and eye color.`
    : `PRANK: guest "${input.guest}" sneaks into host "${input.host}" room, rummages belongings; caught pose must show both characters in frame.`;
  return [
    '[FORMAT RULES]',
    ...FORMAT_RULES.map((line) => `- ${line}`),
    '',
    `[EGG MODE: ${input.mode.toUpperCase()}]`,
    modeLine,
    `- guest reference: ${guestRef}`,
    `- host reference: ${hostRef}`,
    '',
    '[POSES (5)]',
    ...EGG_POSES.map((pose) => `- ${pose.id}: ${pose.hint}`),
    '',
    '[CONSISTENCY]',
    '- both characters keep their own palette and signature props',
    '- transparent background, same 90% height rule for the guest',
  ].join('\n');
}

/** 交给主脑 LLM 的 5 态台词生成提示（system + user 合一，便于直接送网关）。 */
export function compileEggLinesPrompt(input: { name: string; mode: EggMode; host: string; persona?: string }): string {
  return [
    `你在为桌宠彩蛋角色「${input.name}」写 5 组中文短台词。`,
    `彩蛋模式：${input.mode === 'cosplay' ? `Cosplay 冒充「${input.host}」` : `去「${input.host}」那里串门捣乱`}。`,
    input.persona === undefined || input.persona === '' ? '' : `角色口吻：${input.persona}`,
    '只输出一行 JSON，键固定为 pop/pretend/caught/bye/escape，每个键是 1-2 条台词数组。',
    '每条不超过 24 个汉字，不解释自己是 AI，不使用 emoji。',
  ].filter((line) => line !== '').join('\n');
}

/** 校验 LLM 输出并裁剪为 5 态（纯函数，便于单测）。 */
export function parseEggLines(content: string): Record<'pop' | 'pretend' | 'caught' | 'bye' | 'escape', string[]> | null {
  const match = /\{[\s\S]*\}/.exec(content);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const keys = ['pop', 'pretend', 'caught', 'bye', 'escape'] as const;
  const out = {} as Record<(typeof keys)[number], string[]>;
  for (const key of keys) {
    const value = (parsed as Record<string, unknown>)[key];
    if (!Array.isArray(value)) return null;
    const lines = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().slice(0, 48));
    if (lines.length === 0) return null;
    out[key] = lines.slice(0, 2);
  }
  return out;
}

/**
 * 星露谷像素表提示词（T-M6-62）：16×32 四方向 6×4 网格，锁定当前角色参考图。
 * 输出约定与 pixel-sprite-pipeline 的切格规则一一对应（行=下/右/上/左；
 * 列=待机/左脚在前/右脚在前/过渡/动作/表情）。
 */
export function compileStardewSpritePrompt(input: { name: string; traits?: string }): string {
  return [
    `为角色「${input.name}」生成一张星露谷（Stardew Valley）风格的像素精灵表（sprite sheet）。`,
    input.traits !== undefined && input.traits.trim() !== '' ? `角色外观锁定：${input.traits.trim()}。` : '',
    '硬性规格：',
    '- 整张图是 6 列 × 4 行的网格，每格是一个 16×32 像素的角色帧，网格之间不留间距、不画格线；',
    '- 行序固定：第 1 行朝下（正面）、第 2 行朝右、第 3 行朝上（背面）、第 4 行朝左；',
    '- 列序固定：第 1 列站立待机（双脚并拢）；第 2 列左脚向前迈出、右臂前摆；第 3 列右脚向前迈出、左臂前摆；',
    '  第 4 列是双脚交错的过渡帧（两脚靠近、身体略过中线）；第 5 列是动作帧（双臂向前伸出作握持/挥动状，手臂明显变化）；',
    '  第 6 列是表情帧（开心/惊讶，头部与手臂张开）；',
    '- **所有帧都必须是空手**：待机/行走/动作/表情都禁止画鱼竿、斧头、锄头、镐子、法杖、木棍、提灯、武器或任何手持道具；',
    '  工具与手持物由游戏引擎单独绘制，动作帧只画空手伸出的手臂（这是硬性要求，画了道具会导致游戏里出现两根竿/两把工具）；',
    '- 若提供了参考图：只沿用其外观特征（五官/发型/发色/服装配色/标志性配饰），必须重新绘制四个朝向与行走/动作/表情姿态；',
    '  严禁逐格复制参考图的站立姿势，行走列必须画出明显的腿脚前后差；',
    '- 第 2/3/4 列必须能看出明显的腿脚前后差（约 2-4 像素），但三帧头顶高度一致、脚底基线一致，严禁一帧高瘦一帧矮胖；',
    '- 每格角色脚底贴合格子底边、水平居中，头身比例与星露谷原版农夫一致（约 2-2.5 头身）；',
    '- 角色必须是瘦高比例：在每格内高约 28-32 像素、宽约 10-14 像素（接近 1:2），左右各留 1-2 像素透明边；',
    '- 轮廓必须收窄可读：长发要贴住头形并束在身后，侧面时头发总宽不超过躯干宽的 1.5 倍，严禁披散成一大团盖住身体；',
    '- 腿和手臂要能从躯干轮廓中分辨出来，禁止把角色画成没有四肢分界的色块；',
    '- 透明背景（不要白底、不要阴影、不要地面），角色轮廓清晰；',
    '- 像素风：硬边像素、有限色板（约 8-12 色）、无抗锯齿、无渐变模糊、无抖动噪点、无文字无水印；',
    '- 画风必须像星露谷原版农夫：干净清晰的 1 像素深色描边、简洁的 2-3 阶明暗、五官只占 2-3 像素，',
    '  头发最多 3 个同色系层次，不要大面积高光或渐变；不要写实、不要厚涂、不要高细节插画感、不要超过原版的信息密度；',
    '- 角色在每格内保持同一比例与脚底基线，四行是同一角色的四个朝向（服装/发色完全一致）；',
    '- 四个方向必须是同一个角色的同一套服装配色，只是朝向与步伐不同。',
  ].filter((line) => line !== '').join('\n');
}
