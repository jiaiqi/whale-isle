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
  {
    id: 'deepseek',
    label: 'DeepSeek · 蓝鲸女仆',
    reference: 'crosspet/characters/deepseek/idle.webp',
    traits: '深蓝渐变浅蓝蓬松长卷发、头顶呆毛、两侧蓝白鲸鳍耳、左侧浅蓝蝴蝶结、白色蕾丝女仆发箍、蓝色大眼；深蓝白领女仆裙、白色蕾丝小围裙（带小鲸鱼刺绣）、深蓝鲸鱼尾鳍、深蓝小皮鞋',
  },
  {
    id: 'claude',
    label: 'Claude · 橘发书卷娘',
    reference: 'crosspet/characters/claude/idle.webp',
    traits: '蓬松橘棕色微卷长发、琥珀橙色大眼、右侧向日葵发饰配黑色蝴蝶结与米白流苏（无兽耳、无尾巴、无呆毛）；奶白色蕾丝荷叶边洋装长裙、黑色缎带腰带、橙红色布片点缀、胸前向日葵徽章、深棕色小皮鞋',
  },
  {
    id: 'gpt',
    label: 'GPT · 银发白龙',
    reference: 'crosspet/characters/gpt/idle.webp',
    traits: '银白色长卷发、头顶呆毛、尖精灵耳、一对白色弯曲龙角、淡紫色大眼、左侧白色中国结流苏发饰；纯白修身长裙配银灰菱格纹与中国结流苏、背后淡紫白小龙翼与白色鳞片龙尾、白色小皮鞋',
  },
  {
    id: 'gemini',
    label: 'Gemini · 星空异瞳猫娘',
    reference: 'crosspet/characters/gemini/idle.webp',
    traits: '紫蓝渐变蓬松长卷发、头顶单根呆毛、两侧低丸子头、双侧紫毛白绒猫耳、左红粉右琥珀金异色大瞳、猫嘴、右侧大号彩虹四芒星发饰；深蓝紫星空露肩短裙配白色灯笼袖与白色荷叶裙边、白色堆堆袜、深蓝紫厚底鞋、右腿星形腿环、紫蓝渐变毛绒猫尾（禁止女仆发箍或围裙）',
  },
  {
    id: 'glm',
    label: 'GLM · 黑狐女仆',
    reference: 'crosspet/characters/glm/idle.webp',
    traits: '黑发渐变深蓝发尾、一对黑灰白绒毛大狐耳、白色蕾丝发箍配黑色闭眼图案睡眠眼罩、左侧 Z 字蝴蝶结与双银铃铛、深灰紫大眼；黑白女仆连衣裙配蓝色菱形挂饰、黑底白尖蓬松大狐尾、白色系带短靴',
  },
  {
    id: 'grok',
    label: 'Grok · 金发哥特少女',
    reference: 'crosspet/characters/grok/idle.webp',
    traits: '金色波浪长双马尾、头顶大呆毛、尖耳、蓝色大眼、小虎牙、头顶黑金小王冠、黑色蝴蝶结配小蝙蝠翼发饰；黑红金哥特洛丽塔连衣裙（黑底金纹、红色内衬）、黑色长袜、黑金小皮鞋（无女仆发箍或围裙）',
  },
  {
    id: 'kimi',
    label: 'Kimi · 银发月光女仆',
    reference: 'crosspet/characters/kimi/idle.webp',
    traits: '银白渐变冰蓝发尾长卷发、紫罗兰大眼、白色蕾丝女仆发箍配银色弯月与音符及深蓝 K 字蝴蝶结；深蓝白领女仆连衣裙、白色音符刺绣蕾丝围裙、深蓝带蝴蝶结小皮鞋',
  },
  {
    id: 'qwen',
    label: 'Qwen · 蓝紫国风少女',
    reference: 'crosspet/characters/qwen/idle.webp',
    traits: '蓝紫色波浪长发配左侧麻花辫、紫蓝大眼、头顶深蓝白边贝雷帽配蓝白徽章与流苏；蓝白金国风立领连衣裙（深蓝金纹广袖、白色盘扣裙身、蓝色流苏挂饰）、深蓝小皮鞋（无兽耳、无尾巴、无女仆装）',
  },
];

/** 角色 id → BUILTIN_LOCKS id 映射（用于自动锁定当前桌宠外观，避免生成跑偏）。 */
export function resolveBuiltinLockForCharacter(characterId?: string): BuiltinLock | undefined {
  if (characterId === undefined || characterId === '') return undefined;
  const normalized = characterId.toLowerCase();
  if (normalized === 'blue-whale-maid' || normalized === 'aboutme-dsh' || normalized === 'aboutme-dsh1') {
    return BUILTIN_LOCKS.find((item) => item.id === 'deepseek');
  }
  const stripped = normalized.replace(/^(?:aboutme|crosspet)-/, '').split('-')[0] ?? '';
  return BUILTIN_LOCKS.find((item) => item.id === stripped);
}

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
 * 星露谷精灵表提示词（融合 CrossPet 角色锁定 + aboutme-pets 10% 安全缓冲红线，支持 1x / 2x / 4x 清晰度档位）。
 * 输出约定与 pixel-sprite-pipeline 的切格规则一一对应（行=下/右/上/左；
 * 列=待机/左脚在前/右脚在前/过渡/动作/表情）。
 */
export function compileStardewSpritePrompt(input: {
  name: string;
  characterId?: string;
  traits?: string;
  tier?: '1x' | '2x' | '4x';
}): string {
  const tier = input.tier ?? '2x';
  const lock = resolveBuiltinLockForCharacter(input.characterId);
  const resolvedTraits = (input.traits ?? '').trim() !== ''
    ? input.traits!.trim()
    : (lock?.traits ?? '');
  const styleBlock = tier === '4x'
    ? [
      '- 画幅精度（4× 高清 Q 版）：每格目标是 128×128 宽幅高清 Q 版 2D 角色精灵，清晰细腻的二次元手绘深色外描边与干净平涂两阶阴影；',
      '- 完整忠实保留该角色的标志性发型、瞳色、发饰、服装与尾巴细节，不要刻意马赛克化或压缩色板；',
      '- 角色约 2.3-2.5 头身，角色本体必须充实挺拔、占据每格约 86%-90% 高度（对齐星露谷原版农夫身高，绝不画成过矮小的迷你矮人），水平居中并留足 8%-12% 透明安全边容纳长发、尾巴与摆臂；',
    ]
    : tier === '2x'
      ? [
        '- 画幅精度（2× 精致像素，推荐）：每格目标是 64×64 宽幅高精度 2× 像素风（HD Pixel Art），像素边缘利落干净、1 像素深色轮廓描边；',
        '- 比星露谷原版 16×32 精细一倍：该角色的瞳色、发饰、耳朵/尾巴与服装层次必须清晰可辨，色板 16-24 色，层次干净、无噪点模糊；',
        '- 角色约 2.3-2.5 头身，角色本体占据每格约 86%-90% 高度（对齐原版农夫身高），水平居中且左右各留 8%-12% 透明安全边；',
      ]
      : [
        '- 画幅精度（1× 原版像素）：每格目标是 32×32 宽幅复古像素，硬边像素、有限色板（约 8-12 色）、无抗锯齿、无渐变模糊、无抖动噪点；',
        '- 画风像星露谷原版农夫：干净清晰的 1 像素深色描边、简洁的 2-3 阶明暗、五官只占 2-3 像素，头发最多 3 个同色系层次；',
        '- 角色在每格内占据 85%-90% 高度、水平居中且左右留出透明安全边避免发型/尾巴裁切；',
      ];
  return [
    `为角色「${input.name}」生成一张星露谷（Stardew Valley）${tier === '4x' ? '高清 Q 版' : tier === '2x' ? '2× 精致像素风' : '原版像素风'}角色精灵表（sprite sheet）。`,
    '',
    '[CHARACTER LOCK · 角色外观唯一基准（强制）]',
    resolvedTraits !== ''
      ? `- 本角色固定外观：${resolvedTraits}。`
      : '- 严格以附带参考图中的角色外观为唯一权威基准，完整还原其发型、发色、瞳色、头饰、服装款式与配色。',
    '- 若提供了参考图：必须 100% 锁定参考图的同一角色（发型/发色/瞳色/耳朵或发饰/服装配色/鞋袜/尾巴完全一致），严禁擅自更换服装风格或添加参考图里没有的女仆发箍、围裙、帽子等元素；',
    '- 必须重新绘制四个朝向与行走/动作/表情姿态，严禁把参考图的正面站姿原样复制 24 次。',
    '',
    '[GRID & SAFE MARGIN · 网格与防裁切安全缓冲（强制）]',
    '- 整张图是 6 列 × 4 行的均匀网格（正方格），网格之间不画格线、不写编号文字、不加水印；',
    '- **防裁切安全红线**：每个格子的上下左右四周留出 6%-10% 的纯透明缓冲边；角色的蓬松长发、耳朵、发饰、尾巴、裙摆以及动作/表情帧张开的手臂都**不能触碰格子边界**，同时保证主体人物尽量高大清晰、不因过分留白显得矮小；',
    '- 行序固定：第 1 行朝下（正面）、第 2 行朝右（右侧面）、第 3 行朝上（背面）、第 4 行朝左（左侧面）；',
    '- 列序固定：第 1 列自然站立待机（双脚平行站直、双手自然垂放身侧）；第 2 列迈出左脚、右臂自然前摆；第 3 列明确改换迈出右脚、左臂自然前摆（正/背面第 2 与第 3 列必须左右脚清晰交替、头部保持水平居中不左右跳，严禁两列都抬同一只脚）；第 4 列自然微收过渡帧（双手轻垂身侧、双脚平行站直微收，严禁画成双手合十或内八交叉腿）；第 5 列空手动作帧（双臂向前伸出作握持/挥动状）；第 6 列表情帧（开心微笑或惊讶，双臂轻抬、神态生动）；',
    '- 四行 24 格的角色头顶高度一致、脚底基线一致、身体比例完全统一；',
    '- **所有 24 格必须空手**：待机/行走/动作/表情都严禁在手中画任何道具（鱼竿、斧头、锄头、书本、折扇、手包、武器等），手持工具由游戏引擎单独绘制。',
    '',
    '[STYLE & RENDER]',
    ...styleBlock,
    '- 纯透明背景（不要白底、不要地面、不要投影、不要边框）。',
  ].join('\n');
}
