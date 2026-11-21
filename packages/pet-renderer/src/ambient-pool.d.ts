/**
 * 随机氛围动作池抽取（T-M5-01，dsh-pet animationWeights 思想）：
 * 按 weight 加权随机抽一条 ambientPool 条目；weight=0 的条目（如睡眠接力首尾段）不可达。
 * 纯函数 + 注入 rng（确定性测试）。
 */
import type { PetAvatarManifest } from '@workbench/shared-protocol';
export declare function pickAmbient(manifest: PetAvatarManifest, rng?: () => number): {
    clipId: string;
    webmPath: string;
    category: string;
};
//# sourceMappingURL=ambient-pool.d.ts.map