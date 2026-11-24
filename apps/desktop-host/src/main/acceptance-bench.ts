/**
 * 姿态与场景验收台（T-M6-53）。
 *
 * 12 个免联网场景直接驱动真实桌宠窗口；回退检查与脱敏报告都是纯函数，便于单测。
 * 报告严禁包含：对话正文、绝对路径、密钥/token。
 */
import { resolvePose, type PoseResolution } from './pose-resolver';

export type BenchStepKind = 'pose' | 'action' | 'say' | 'sleep' | 'wake' | 'crown' | 'egg';

export interface BenchStep {
  kind: BenchStepKind;
  /** pose 名 / PetActionState / 台词 / crown 开关 */
  value: string;
  delayMs?: number;
}

export interface BenchScenario {
  id: string;
  label: string;
  description: string;
  steps: BenchStep[];
}

export const BENCH_SCENARIOS: BenchScenario[] = [
  {
    id: 'work-cycle',
    label: '一轮完整工作',
    description: 'listening → writing → happy 的完整工作循环',
    steps: [{ kind: 'pose', value: 'listening' }, { kind: 'pose', value: 'writing', delayMs: 900 }, { kind: 'pose', value: 'happy', delayMs: 900 }, { kind: 'pose', value: 'idle', delayMs: 900 }],
  },
  {
    id: 'crown',
    label: '大活戴皇冠 (>=8 工具)',
    description: '累计 8 次工具调用后戴上小皇冠',
    steps: [{ kind: 'pose', value: 'proud' }, { kind: 'crown', value: 'on', delayMs: 600 }, { kind: 'pose', value: 'proud', delayMs: 600 }],
  },
  {
    id: 'corrected',
    label: '出错 3 分钟被纠正',
    description: '播放 correctedPose（缺图回退 sorry/idle）',
    steps: [{ kind: 'pose', value: 'corrected' }, { kind: 'pose', value: 'pout', delayMs: 900 }],
  },
  {
    id: 'compact',
    label: '压缩上下文 compact',
    description: 'compact 姿态（缺图回退 writing）',
    steps: [{ kind: 'pose', value: 'compact' }],
  },
  {
    id: 'delegating',
    label: '派子任务 delegating',
    description: '召唤迷你小帮手姿态',
    steps: [{ kind: 'pose', value: 'delegating' }],
  },
  {
    id: 'asking',
    label: '等待审批 asking',
    description: 'asking 姿态（缺图回退 listening）',
    steps: [{ kind: 'pose', value: 'asking' }],
  },
  {
    id: 'low-balance',
    label: '额度紧张 → 充值大吃',
    description: 'tired → eat/feast 的余额链路',
    steps: [{ kind: 'pose', value: 'tired' }, { kind: 'action', value: 'hungry_lazy', delayMs: 700 }, { kind: 'action', value: 'eat_rice', delayMs: 900 }],
  },
  {
    id: 'egg',
    label: '随机串门彩蛋',
    description: '由主进程随机召唤 egg-*，随后模拟点中逃跑关窗',
    steps: [{ kind: 'pose', value: 'surprised' }, { kind: 'egg', value: 'random', delayMs: 1_200 }],
  },
  {
    id: 'touch',
    label: '摸头 / 戳 / 甩晕红温',
    description: 'pat → rage_spray → dizzy 的互动链',
    steps: [{ kind: 'pose', value: 'pat' }, { kind: 'action', value: 'rage_spray', delayMs: 700 }, { kind: 'pose', value: 'dizzy', delayMs: 700 }],
  },
  {
    id: 'sleep',
    label: '安静睡眠 / 叫醒',
    description: '入睡姿态 → 叫醒回 idle',
    steps: [{ kind: 'sleep', value: 'on' }, { kind: 'pose', value: 'sleeping', delayMs: 600 }, { kind: 'wake', value: 'off', delayMs: 900 }, { kind: 'pose', value: 'idle', delayMs: 300 }],
  },
  {
    id: 'greet-fest',
    label: '时段与节日首见',
    description: 'greet_night 与 fest_midautumn 首见台词/姿态',
    steps: [{ kind: 'pose', value: 'greet_night' }, { kind: 'pose', value: 'fest_midautumn', delayMs: 900 }],
  },
  {
    id: 'blink',
    label: '眨眼与多图轮换',
    description: 'idle 与 idle-blink 交替，检查构图无跳动',
    steps: [{ kind: 'pose', value: 'idle' }, { kind: 'pose', value: 'idle-blink', delayMs: 700 }, { kind: 'pose', value: 'idle', delayMs: 700 }, { kind: 'pose', value: 'idle-blink', delayMs: 700 }],
  },
];

/** 验收台固定检查的姿态集合（含 CrossPet 场景键）。 */
export const AUDIT_POSES = [
  'idle', 'idle-blink', 'thinking', 'reading', 'writing', 'running', 'searching', 'delegating',
  'happy', 'pat', 'surprised', 'compact', 'asking', 'proud', 'bye', 'greet_night', 'fest_midautumn',
] as const;

export interface FallbackEntry extends PoseResolution {
  /** ok = 命中原图；fallback = 已回退；missing = 连回退目标都没有 */
  status: 'ok' | 'fallback' | 'missing';
}

export function buildFallbackReport(available: Iterable<string>, requested: readonly string[] = AUDIT_POSES): FallbackEntry[] {
  const set = new Set(available);
  return requested.map((pose) => {
    const resolution = resolvePose(pose, set);
    const status: FallbackEntry['status'] = !resolution.fallback ? 'ok' : set.size === 0 ? 'missing' : 'fallback';
    return { ...resolution, status };
  });
}

export interface BenchResult {
  scenarioId: string;
  label: string;
  status: 'completed' | 'failed';
  steps: number;
  note: string;
}

const PATH_PATTERN = /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\\Users\\)[^\s"'`]+/g;
const SECRET_PATTERN = /\b(?:(?:sk|ghp|AKIA|xoxb)-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})\b/g;

/** 脱敏：路径 → <path>，密钥/token → <redacted>。 */
export function scrubReportText(text: string): string {
  return text.replace(PATH_PATTERN, '<path>').replace(SECRET_PATTERN, '<redacted>');
}

/** 生成验收 Markdown：只含角色名/姿态/场景/状态，不含台词正文。 */
export function buildAcceptanceReport(input: {
  characterName: string;
  characterId: string;
  results: BenchResult[];
  fallbacks: FallbackEntry[];
  generatedAt?: number;
}): string {
  const at = new Date(input.generatedAt ?? Date.now()).toISOString();
  const lines = [
    '# 姿态与场景验收报告',
    '',
    `- 角色：${input.characterName}（${input.characterId}）`,
    `- 生成时间：${at}`,
    `- 场景：${input.results.filter((item) => item.status === 'completed').length}/${input.results.length} 通过`,
    '',
    '## 12 场景演练',
    ...input.results.map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.label}（${item.steps} 步）${item.note === '' ? '' : ` — ${item.note}`}`),
    '',
    '## 缺失姿态回退检查',
    ...input.fallbacks.map((item) => `- ${item.requested} → ${item.pose}（${item.status}，${item.reason}）`),
    '',
    '## 脱敏声明',
    '- 不含对话正文、绝对路径、密钥或 token。',
  ];
  return scrubReportText(lines.join('\n'));
}
