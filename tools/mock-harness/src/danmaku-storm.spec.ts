import { describe, expect, it } from 'vitest';
import {
  PROMPT_INJECTION_SAMPLES,
  TABOO_SAMPLES,
  generateDanmakuStorm,
} from './danmaku-storm';

/** [SIMULATION] T-M0-04 门禁：弹幕风暴确定性回放（契约校验 100% + 夹具齐备 + 时序） */

describe('danmaku-storm-replay', () => {
  it('100 条事件 100% 通过 NormalizedLiveEventSchema 校验', () => {
    const storm = generateDanmakuStorm({ count: 100 });
    expect(storm.events).toHaveLength(100);
    // generateDanmakuStorm 出站前已逐条 parse；此处复核关键字段形状
    for (const event of storm.events) {
      expect(event.eventId).toMatch(/^[0-9a-f]{8}-0000-4000-8000-[0-9]{12}$/);
      expect(['P0_INTERRUPT', 'P1_CADENCE', 'P2_IDLE']).toContain(event.assignedPriority);
    }
  });

  it('同 seed 回放序列完全一致（确定性）', () => {
    const a = generateDanmakuStorm({ count: 60, seed: 42 });
    const b = generateDanmakuStorm({ count: 60, seed: 42 });
    expect(a.events.map((event) => event.payload.rawText)).toEqual(b.events.map((event) => event.payload.rawText));
    const c = generateDanmakuStorm({ count: 60, seed: 43 });
    expect(a.events.map((event) => event.payload.rawText)).not.toEqual(c.events.map((event) => event.payload.rawText));
  });

  it('夹具齐备：雷区弹幕 / 点歌指令 / Prompt 注入 / 连击送礼 / 进房', () => {
    const storm = generateDanmakuStorm({ count: 160 });
    const rawTexts = storm.events.map((event) => event.payload.rawText ?? '');
    // 雷区（T-M1-04 压测输入）
    expect(TABOO_SAMPLES.some((text) => rawTexts.includes(text))).toBe(true);
    const tabooEvent = storm.events.find((event) => TABOO_SAMPLES.includes(event.payload.rawText as never));
    expect(tabooEvent?.assignedPriority).toBe('P0_INTERRUPT');
    // 点歌
    expect(storm.events.some((event) => event.eventType === 'SONG_REQUEST')).toBe(true);
    // Prompt 注入（护栏压测）
    expect(PROMPT_INJECTION_SAMPLES.some((text) => rawTexts.includes(text))).toBe(true);
    // 连击送礼 mergedCount ≥1
    const gifts = storm.events.filter((event) => event.eventType === 'GIFT');
    expect(gifts.length).toBeGreaterThan(0);
    expect(gifts.every((event) => (event.payload.mergedCount ?? 0) >= 1)).toBe(true);
    // 进房（P2 空闲）
    const enters = storm.events.filter((event) => event.eventType === 'ENTER_ROOM');
    expect(enters.length).toBeGreaterThan(0);
    expect(enters[0]?.assignedPriority).toBe('P2_IDLE');
  });

  it('时间戳按 intervalMs 排布（≈100 条/秒）', () => {
    const storm = generateDanmakuStorm({ count: 100, intervalMs: 10 });
    const ts = storm.events.map((event) => event.timestamp);
    const first = ts[0] ?? 0;
    const last = ts[ts.length - 1] ?? 0;
    expect(last - first).toBe(99 * 10);
  });

  it('[SIMULATION] 门禁时序：5 剧本同风暴生成 <3s（含 1000 条压测流）', () => {
    const storm = generateDanmakuStorm({ count: 1000 });
    expect(storm.events).toHaveLength(1000);
    // 生成 + 校验耗时（不含 WebSocket 抖动）应远低于 3 秒门禁
    expect(storm.durationMs).toBeLessThan(3000);
  });
});
