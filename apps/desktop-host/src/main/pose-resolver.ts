/**
 * 姿态解析与回退（T-M6-53）。
 *
 * CrossPet / 自定义角色并不保证每个姿态都有对应图片；缺图时必须按规则回退，
 * 且在验收台如实显示「请求姿态 → 实际命中/回退目标」，绝不假装命中。
 */

/** 缺失姿态的确定性回退表（其余统一回退 idle）。 */
export const POSE_FALLBACKS: Record<string, string> = {
  compact: 'writing',
  asking: 'listening',
  corrected: 'sorry',
};

export interface PoseResolution {
  requested: string;
  /** 实际播放的姿态 */
  pose: string;
  /** true = 发生了回退 */
  fallback: boolean;
  /** 回退原因（验收台展示） */
  reason: string;
}

export function resolvePose(requested: string, available: Iterable<string>): PoseResolution {
  const set = new Set(available);
  if (set.size === 0) return { requested, pose: requested, fallback: true, reason: '角色没有任何姿态素材' };
  if (set.has(requested)) return { requested, pose: requested, fallback: false, reason: '命中原始姿态' };
  const mapped = POSE_FALLBACKS[requested];
  if (mapped !== undefined && set.has(mapped)) return { requested, pose: mapped, fallback: true, reason: `${requested} 缺图 → 回退 ${mapped}` };
  if (set.has('idle')) return { requested, pose: 'idle', fallback: true, reason: `${requested} 缺图 → 回退 idle` };
  const first = set.values().next().value as string;
  return { requested, pose: first, fallback: true, reason: `${requested} 缺图且无 idle → 回退 ${first}` };
}

/** 工作跟随工具/信号事件 → 姿态（决定代理角色演什么）。 */
export function poseForWorkEvent(input: { kind: 'start' | 'tool' | 'stop' | 'asking' | 'compact' | 'error'; toolName?: string }): string {
  if (input.kind === 'start') return 'listening';
  if (input.kind === 'stop') return 'bye';
  // T-M6-64：结构化的 asking/compact/error 信号优先于工具名推断
  if (input.kind === 'asking') return 'asking';
  if (input.kind === 'compact') return 'compact';
  if (input.kind === 'error') return 'oops';
  const tool = (input.toolName ?? '').toLowerCase();
  if (/compact|summar/.test(tool)) return 'compact';
  if (/delegate|subagent|task|agent/.test(tool)) return 'delegating';
  // \b 避免把 "Task" 里的 ask 误判成 asking
  if (/\bask|approve|permission|confirm/.test(tool)) return 'asking';
  return 'writing';
}
