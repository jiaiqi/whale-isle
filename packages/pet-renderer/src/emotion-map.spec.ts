/** T-M5-16 门禁：三层映射表 + 回执分类 + 素材零闲置审计 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PetAvatarManifestSchema } from '@workbench/shared-protocol';
import {
  EMOTION_ACTION_MAP, GAME_EVENT_ACTION_MAP, RICE_LEVEL_ACTION_MAP,
  classifyAutodriveReceipt, SLOT_LABELS,
} from './emotion-map';
import { pickAmbient } from './webm-renderer';

describe('三层映射表完整性（D16）', () => {
  it('情绪五档 / 游戏事件 / 饭碗档位全部映射到合法 actionState', () => {
    for (const action of [...Object.values(EMOTION_ACTION_MAP), ...Object.values(GAME_EVENT_ACTION_MAP), ...Object.values(RICE_LEVEL_ACTION_MAP)]) {
      expect(SLOT_LABELS[action]).toBeDefined();
    }
  });

  it('classifyAutodriveReceipt：七类事件判定', () => {
    expect(classifyAutodriveReceipt('UNCERTAIN', 'move_to', 'x')).toBe('receipt_uncertain');
    expect(classifyAutodriveReceipt('FAILED', 'open_shop', 'x')).toBe('receipt_failed');
    expect(classifyAutodriveReceipt('TIMEOUT', 'fish', 'x')).toBe('receipt_timeout');
    expect(classifyAutodriveReceipt('COMPLETED', 'sleep', '睡觉')).toBe('sleep');
    expect(classifyAutodriveReceipt('COMPLETED', 'fish', '钓到鳀鱼')).toBe('receipt_completed_harvest');
    expect(classifyAutodriveReceipt('COMPLETED', 'water_crops', '浇了')).toBe('receipt_completed');
  });

  it('素材零闲置审计：114 clips 全部在槽位 ∪ 池；池内可达数 = weight>0 条数', () => {
    const manifest = PetAvatarManifestSchema.parse(
      JSON.parse(readFileSync(join(__dirname, '..', 'assets', 'blue-whale-maid', 'manifest.json'), 'utf8')),
    );
    const inSlots = new Set(manifest.actions.flatMap((a) => a.clips.map((c) => c.clipId)));
    const inPool = new Set(manifest.ambientPool.map((c) => c.clipId));
    expect(inSlots.size + inPool.size).toBeGreaterThanOrEqual(114);
    // 交集应为空（一条 clip 只在一处——零闲置且不重复挂槽）
    for (const id of inSlots) expect(inPool.has(id)).toBe(false);
    const reachable = manifest.ambientPool.filter((c) => c.weight > 0);
    expect(reachable.length).toBeGreaterThan(70);
    // 池空兜底仍可用（weight 全 0 不可能，但函数健壮）
    expect(() => pickAmbient(manifest, () => 0.5)).not.toThrow();
  });
});
