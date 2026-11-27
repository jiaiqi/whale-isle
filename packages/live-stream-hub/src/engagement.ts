/** V2-P3-02A：确定性互动状态。只消费已归一、已过护栏的事件；不接平台，不使用概率。 */
import {
  LiveEngagementConfigSchema,
  type LiveEngagementConfig,
  type LiveEngagementSnapshot,
  type LiveEngagementRule,
  type LiveEngagementAction,
  type NormalizedLiveEvent,
} from '@workbench/shared-protocol';

type Donor = { uid: string; nickname: string; count: number; value: number };
const CAPACITY = 10_000;

export class LiveEngagement {
  private config = LiveEngagementConfigSchema.parse({});
  private likes = 0;
  private reached = false;
  private cycleStartedAt = 0;
  private firedGoals = new Set<string>();
  private donors = new Map<string, Donor>();
  private cooldowns = new Map<string, number>();
  private seen = new Set<string>();
  private nextActionAt = 0;
  private latestAction: LiveEngagementAction | null = null;
  private limited = false;

  configure(raw: unknown): void {
    // 保存设置不会重置进度、冷却或已触发阈值；关闭后重新开启不能绕过一次性限制。
    this.config = LiveEngagementConfigSchema.parse(raw);
  }

  reset(now: number): void {
    this.likes = 0;
    this.reached = false;
    this.cycleStartedAt = now;
    this.firedGoals.clear();
    this.donors.clear();
    this.cooldowns.clear();
    this.seen.clear();
    this.nextActionAt = 0;
    this.latestAction = null;
    this.limited = false;
  }

  private advanceCycle(now: number): void {
    const period = this.config.resetAfterMs;
    if (period > 0 && now - this.cycleStartedAt >= period) {
      this.cycleStartedAt += Math.floor((now - this.cycleStartedAt) / period) * period;
      this.likes = 0;
      this.reached = false;
      this.firedGoals.clear();
      this.latestAction = null;
    }
  }

  ingest(event: NormalizedLiveEvent, now: number): LiveEngagementAction[] {
    if (!this.config.enabled || this.seen.has(event.eventId)) return [];
    this.advanceCycle(now);
    // 与 hub 双层有界去重：规则/统计在注意力合并前只记一次。
    this.seen.add(event.eventId);
    if (this.seen.size > CAPACITY) this.seen.delete(this.seen.values().next().value!);
    const count = Math.max(1, event.payload.mergedCount);
    if (event.eventType === 'LIKE') {
      this.likes = Math.min(Number.MAX_SAFE_INTEGER, this.likes + (event.payload.likeCount ?? count));
      if (this.likes >= this.config.likeGoal) this.reached = true;
    }
    if (event.eventType === 'GIFT') {
      const uid = JSON.stringify([event.platform, event.sender.uid]);
      const previous = this.donors.get(uid);
      if (previous || this.donors.size < CAPACITY) {
        this.donors.set(uid, {
          uid, nickname: event.sender.nickname.slice(0, 80),
          count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + (event.payload.giftCount ?? count)),
          value: Math.min(Number.MAX_SAFE_INTEGER, (previous?.value ?? 0) + (event.payload.giftDiamondValue ?? 0)),
        });
      } else this.limited = true;
    }
    const actions: LiveEngagementAction[] = [];
    for (const rule of this.config.rules) {
      if (!rule.enabled || !this.matches(rule, event)) continue;
      const key = JSON.stringify([event.platform, event.sender.uid, rule.id]);
      if ((this.cooldowns.get(key) ?? 0) > now || this.nextActionAt > now) continue;
      // 冷却只在实际产出请求时占用；阈值期间受节流的彩蛋可由后续点赞补发。
      if (!this.cooldowns.has(key) && this.cooldowns.size >= CAPACITY) {
        for (const [id, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(id);
        if (this.cooldowns.size >= CAPACITY) continue; // 容量耗尽时拒绝新动作，不能驱逐仍有效的冷却。
      }
      this.cooldowns.set(key, now + rule.cooldownMs);
      this.nextActionAt = now + this.config.globalCooldownMs;
      if (rule.trigger === 'like_goal') this.firedGoals.add(rule.id);
      const action = { eventId: event.eventId, ruleId: rule.id, at: now, action: rule.action };
      this.latestAction = action;
      actions.push(action);
    }
    return actions;
  }

  private matches(rule: LiveEngagementRule, event: NormalizedLiveEvent): boolean {
    if (rule.trigger === 'follow') return event.eventType === 'FOLLOW';
    if (rule.trigger === 'gift') return event.eventType === 'GIFT' && (event.payload.giftDiamondValue ?? 0) >= rule.minGiftValue;
    return event.eventType === 'LIKE' && this.reached && !this.firedGoals.has(rule.id);
  }

  /** 同分同名次；同分的展示次序按稳定 uid，不因最后到达时间跳动。 */
  leaderboard(): LiveEngagementSnapshot['leaderboard'] {
    const metric = this.config.leaderboardMetric;
    const sorted = [...this.donors.values()].sort((a, b) => b[metric] - a[metric] || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    let rank = 1;
    return sorted.slice(0, this.config.topN).map((donor, index) => {
      if (index > 0 && donor[metric] !== sorted[index - 1]![metric]) rank = index + 1;
      return { ...donor, rank };
    });
  }

  /** 合并感谢按同一榜单口径排序，礼物先于关注；不会把点赞归入感谢。 */
  thanksScore(platform: string, uid: string): number {
    const donor = this.donors.get(JSON.stringify([platform, uid]));
    return donor?.[this.config.leaderboardMetric] ?? 0;
  }

  snapshot(now: number): LiveEngagementSnapshot {
    this.advanceCycle(now);
    const config: LiveEngagementConfig = structuredClone(this.config);
    return {
      config,
      ruleCards: config.rules.filter((rule) => rule.enabled).map((rule) => {
        const trigger = rule.trigger === 'follow' ? '关注' : rule.trigger === 'gift'
          ? rule.minGiftValue > 0 ? `单次礼物合计 ≥ ${rule.minGiftValue} 币` : '任意礼物'
          : `本周期点赞达到 ${config.likeGoal.toLocaleString('zh-CN')}`;
        const action = rule.action.type === 'bubble' ? '感谢气泡' : `提交点歌「${rule.action.title}」（须授权）`;
        return { id: rule.id, text: `${trigger} → ${action} · 同人冷却 ${rule.cooldownMs / 1000} 秒` };
      }),
      likes: this.likes, goalReached: this.reached, cycleStartedAt: this.cycleStartedAt,
      leaderboard: this.leaderboard(), latestAction: this.latestAction ? structuredClone(this.latestAction) : null,
      leaderboardLimited: this.limited,
    };
  }
}
