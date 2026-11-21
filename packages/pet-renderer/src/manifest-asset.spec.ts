/**
 * T-M5-01 门禁：入库真素材（114 webm）+ 生成 manifest 过契约 + ambientPool 抽取确定性。
 * D14：素材随包分发（相对路径 assets/blue-whale-maid/），断言无外部路径依赖。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PetAvatarManifestSchema, type PetAvatarManifest } from '@workbench/shared-protocol';
import { pickAmbient } from './webm-renderer';


const ASSET_DIR = join(__dirname, '..', 'assets', 'blue-whale-maid');

function loadRealManifest(): PetAvatarManifest {
  const raw = JSON.parse(readFileSync(join(ASSET_DIR, 'manifest.json'), 'utf8')) as unknown;
  return PetAvatarManifestSchema.parse(raw);
}

describe('T-M5-01 blue-whale-maid 入库素材', () => {
  it('manifest 过契约且 11 个语义槽位全覆盖', () => {
    const manifest = loadRealManifest();
    expect(manifest.petId).toBe('blue-whale-maid');
    expect(manifest.renderer).toBe('webm-alpha');
    expect(manifest.licenseScope).toBe('DEV_ONLY_NON_COMMERCIAL');
    const states = manifest.actions.map((a) => a.actionState);
    for (const s of ['idle', 'walk', 'eat_rice', 'happy_maid', 'thinking_tail_wag', 'rage_spray', 'clumsy_panic', 'game_focus', 'sing_stage', 'hungry_lazy', 'sleep_mute']) {
      expect(states).toContain(s);
    }
    // 素材路径全部相对（D14：随包分发，禁止外部绝对路径）
    for (const a of manifest.actions) {
      for (const c of a.clips) expect(c.webmPath.startsWith('assets/blue-whale-maid/')).toBe(true);
    }
  });

  it('sleep_mute 为循环段；ambientPool ≥70 条且含睡眠接力（weight 0 不参与抽取）', () => {
    const manifest = loadRealManifest();
    const sleep = manifest.actions.find((a) => a.actionState === 'sleep_mute');
    expect(sleep?.clips).toHaveLength(1);
    expect(sleep?.clips[0]?.loop).toBe(true);
    expect(sleep?.clips[0]?.clipId).toBe('睡觉-循环');
    expect(manifest.ambientPool.length).toBeGreaterThanOrEqual(70);
    const sleep接力 = manifest.ambientPool.filter((c) => c.category === '睡眠接力');
    expect(sleep接力).toHaveLength(2); // 睡觉-开始/起来，weight 0
    for (const c of sleep接力) expect(c.weight).toBe(0);
  });

  it('pickAmbient：weight 加权抽取 + weight 0 永不被抽中 + 确定性', () => {
    const manifest = loadRealManifest();
    const pool = manifest.ambientPool.filter((c) => c.weight > 0);
    // rng=0 → 命中最前面的权重段；rng→1 → 最后一段
    const first = pickAmbient(manifest, () => 0);
    const last = pickAmbient(manifest, () => 0.9999999);
    expect(first.clipId).toBe(pool[0]?.clipId);
    expect(last.clipId).toBe(pool[pool.length - 1]?.clipId);
    expect(() => pickAmbient(manifest, () => 0)).not.toThrow();
    // 睡眠接力（weight 0）不可达
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickAmbient(manifest, Math.random).clipId);
    }
    expect(seen.has('睡觉-开始')).toBe(false);
    expect(seen.has('睡觉-起来')).toBe(false);
  });
});

describe('ambient-pool 池空兜底', () => {
  it('无池回落 defaultAction 首个 clip；有池但全 weight 0 也回落', async () => {
    const empty = PetAvatarManifestSchema.parse({
      petId: 'x', renderer: 'webm-alpha', licenseScope: 'DEV_ONLY_NON_COMMERCIAL', attribution: '',
      actions: [{ actionState: 'idle', clips: [{ clipId: 'idle-0', webmPath: 'a.webm' }] }],
    });
    expect(pickAmbient(empty, () => 0.5)).toMatchObject({ clipId: 'idle-0', category: 'idle' });
    const zeroPool = { ...empty, ambientPool: [{ clipId: 'z', webmPath: 'z.webm', category: '睡眠接力', weight: 0 }] };
    expect(pickAmbient(zeroPool, () => 0.9)).toMatchObject({ clipId: 'idle-0' });
  });
});

describe('pickAmbient defaultAction 缺失回落', () => {
  it('defaultAction 槽位不在 actions 时回落 actions[0]', () => {
    const m = PetAvatarManifestSchema.parse({
      petId: 'x', renderer: 'webm-alpha', licenseScope: 'DEV_ONLY_NON_COMMERCIAL', attribution: '',
      defaultAction: 'walk',
      actions: [
        { actionState: 'idle', clips: [{ clipId: 'idle-9', webmPath: 'i.webm' }] },
        { actionState: 'walk', clips: [{ clipId: 'walk-1', webmPath: 'w.webm' }] },
      ],
    });
    // defaultAction=walk 存在 → 找 walk（池空）→ clipId walk-1
    expect(pickAmbient(m, () => 0.5)).toMatchObject({ clipId: 'walk-1' });
  });
});
