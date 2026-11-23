/**
 * 自治质量指标（T-M6-35，审计建议 Phase 2）：
 * 从既有 autodrive 事件流派生可量化指标，用于长期观察与回归对比，而不是靠翻日志。
 *
 * 纯函数、零依赖：不引入新状态、不改变编排行为；调用方传最近 N 条事件即可。
 * 指标口径（全部来自真实回执，不估算）：
 *   - 回执成功率 = COMPLETED / 全部回执（TIMEOUT 单列，不计成功也不计失败——超时≠失败）
 *   - 失败率 = (FAILED + ERROR) / 全部回执
 *   - 重复动作率 = 连续相同工具决策次数 / 决策总数（卡死/反复横跳的代理指标）
 *   - 工具覆盖面 = 出现过的不同工具数（判断是否只会一个动作）
 */
export interface QualityEventLike {
  type: string;
  tool?: string;
  status?: string;
}

export interface AutodriveQuality {
  /** 决策次数（不含内心戏 think） */
  decisions: number;
  /** 回执总数（不含编排器自身的 autodrive 汇总回执） */
  receipts: number;
  completed: number;
  failed: number;
  uncertain: number;
  timeout: number;
  error: number;
  /** COMPLETED / receipts；无回执时为 null（不伪造 100%） */
  successRate: number | null;
  /** (FAILED+ERROR) / receipts；无回执时为 null */
  failureRate: number | null;
  /** 连续相同工具决策占比；无决策时为 null */
  repeatRate: number | null;
  /** 出现过的不同工具数 */
  distinctTools: number;
  /** 最长连续同工具决策次数（卡死代理指标） */
  longestToolStreak: number;
  /** 看门狗事件数（卡死/心跳） */
  watchdogs: number;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** 从一个会话的事件序列汇总质量指标（顺序敏感：重复动作按时间顺序统计） */
export function summarizeAutodriveQuality(events: readonly QualityEventLike[]): AutodriveQuality {
  let decisions = 0;
  let receipts = 0;
  let completed = 0;
  let failed = 0;
  let uncertain = 0;
  let timeout = 0;
  let error = 0;
  let watchdogs = 0;
  let repeats = 0;
  let streak = 0;
  let longestToolStreak = 0;
  let previousTool: string | null = null;
  const tools = new Set<string>();

  for (const event of events) {
    if (event.type === 'watchdog') {
      watchdogs += 1;
      continue;
    }
    if (event.type === 'decision') {
      const tool = typeof event.tool === 'string' ? event.tool : '';
      // 内心戏（think）不是动作决策，不参与重复率
      if (tool === '' || tool === 'think') continue;
      decisions += 1;
      tools.add(tool);
      if (tool === previousTool) {
        repeats += 1;
        streak += 1;
      } else {
        streak = 1;
        previousTool = tool;
      }
      longestToolStreak = Math.max(longestToolStreak, streak);
      continue;
    }
    if (event.type !== 'receipt') continue;
    if (event.tool === 'autodrive') continue; // 编排器汇总回执不计入
    receipts += 1;
    switch (event.status) {
      case 'COMPLETED':
        completed += 1;
        break;
      case 'FAILED':
        failed += 1;
        break;
      case 'UNCERTAIN':
        uncertain += 1;
        break;
      case 'TIMEOUT':
        timeout += 1;
        break;
      case 'ERROR':
        error += 1;
        break;
      default:
        break;
    }
  }

  return {
    decisions,
    receipts,
    completed,
    failed,
    uncertain,
    timeout,
    error,
    successRate: ratio(completed, receipts),
    failureRate: ratio(failed + error, receipts),
    repeatRate: ratio(repeats, decisions),
    distinctTools: tools.size,
    longestToolStreak,
    watchdogs,
  };
}

/** 百分比文案（null → '—'，不伪造 0%） */
export function formatRate(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}
