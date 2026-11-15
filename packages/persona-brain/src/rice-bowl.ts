/**
 * 赛博饭碗经济（T-M1-04）：1 粒米 = 1 Token 扣费；余量低于 lowRiceWarningRatio →
 * 建议切换 hungry_lazy（瘫倒摸鱼）；"下饭菜"Buff：工作热情 ×N / 解锁深度推理，带过期时间。
 */
import type { PetPersonaConfig, PetActionState } from '@workbench/shared-protocol';

export interface SideDishInput {
  id: string;
  dishName: string;
  workEthicMultiplier: number;
  unlockDeepReasoning: boolean;
  /** 持续秒数（写入 expiresAt） */
  durationSec: number;
}

export interface ConsumeResult {
  consumedAfter: number;
  ratioRemaining: number;
  /** 余量低于阈值 → 建议切换 hungry_lazy（瘫倒摸鱼） */
  hungry: boolean;
  suggestedActionState: PetActionState;
}

export type Now = () => number;

export class RiceBowl {
  constructor(
    private readonly config: PetPersonaConfig['riceBowl'],
    private readonly now: Now = Date.now,
  ) {}

  /** 扣费：consumedRiceGrainsToday 累加（1 粒米 = 1 Token，由网关 usage 喂入） */
  consume(tokens: number): ConsumeResult {
    const clamped = Math.max(tokens, 0);
    this.config.consumedRiceGrainsToday += clamped;
    const ratioRemaining = this.ratioRemaining();
    const hungry = ratioRemaining < this.config.lowRiceWarningRatio;
    return {
      consumedAfter: this.config.consumedRiceGrainsToday,
      ratioRemaining,
      hungry,
      suggestedActionState: hungry ? 'hungry_lazy' : 'idle',
    };
  }

  remainingGrains(): number {
    return Math.max(0, this.config.dailyRiceGrainBudget - this.config.consumedRiceGrainsToday);
  }

  ratioRemaining(): number {
    // 契约保证 dailyRiceGrainBudget 为 positive()——此处不设 0 分支（不可达死代码）
    return this.remainingGrains() / this.config.dailyRiceGrainBudget;
  }

  isHungry(): boolean {
    return this.ratioRemaining() < this.config.lowRiceWarningRatio;
  }

  /** 投喂下饭菜（"攻略红烧肉" RAG / 礼物帝王蟹），到期自动失效 */
  applySideDish(input: SideDishInput): void {
    this.config.activeSideDishes.push({
      id: input.id,
      dishName: input.dishName,
      workEthicMultiplier: Math.min(Math.max(input.workEthicMultiplier, 1), 5),
      unlockDeepReasoning: input.unlockDeepReasoning,
      expiresAt: this.now() + input.durationSec * 1000,
    });
  }

  activeBuffs(): PetPersonaConfig['riceBowl']['activeSideDishes'] {
    const timestamp = this.now();
    return this.config.activeSideDishes.filter((dish) => dish.expiresAt > timestamp);
  }

  /** 工作热情倍率：取生效 Buff 的最大乘数（基础 1） */
  workEthicMultiplier(): number {
    let multiplier = 1;
    for (const dish of this.activeBuffs()) {
      if (dish.workEthicMultiplier > multiplier) multiplier = dish.workEthicMultiplier;
    }
    return multiplier;
  }

  hasDeepReasoning(): boolean {
    return this.activeBuffs().some((dish) => dish.unlockDeepReasoning);
  }
}
