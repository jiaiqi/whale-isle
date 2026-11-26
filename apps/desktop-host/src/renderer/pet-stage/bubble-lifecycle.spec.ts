import { describe, expect, it } from 'vitest';
import {
  BUBBLE_KIND_TTL_MS,
  bubbleTick,
  cancelBubbleSlot,
  createBubbleLifecycle,
  createBubbleSchedule,
  scheduleBubbleSlot,
  showBubble,
  speakerIdle,
  speechResult,
  speechStarted,
  tickBubbleSchedule,
  ttlForBubbleKind,
} from './bubble-lifecycle';

describe('bubble lifecycle（语音租约驱动）', () => {
  it('speaking 中不收起，语音完成后立即收泡', () => {
    let s = showBubble(createBubbleLifecycle(), '钓到啦！', 100).state;
    s = speechStarted(s).state;
    expect(s.phase).toBe('speaking');
    expect(bubbleTick(s, 50_000).hide).toBe(false);
    const done = speechResult(s, 'completed');
    expect(done.hide).toBe(true);
    expect(done.state.phase).toBe('hidden');
  });
  it('等待中 idle 也收起；静音失败态 idle 保留文字', () => {
    const waiting = showBubble(createBubbleLifecycle(), '马上回来', 0).state;
    expect(speakerIdle(waiting).hide).toBe(true);
    const failed = speechResult(speechStarted(waiting).state, 'failed');
    expect(failed.muted).toBe(true);
    expect(failed.hide).toBe(false);
    expect(speakerIdle(failed.state).state.text).toBe('马上回来');
  });
  it('TTS 失败/超时/中断均保留文字并设静音角标', () => {
    for (const result of ['failed', 'timeout', 'interrupted'] as const) {
      const shown = speechResult(showBubble(createBubbleLifecycle(), '文字', 0).state, result);
      expect(shown).toMatchObject({ show: true, hide: false, muted: true });
      expect(shown.state.phase).toBe('muted');
    }
  });
  it('60s 兜底收起 waiting/speaking/muted', () => {
    for (const state of [
      showBubble(createBubbleLifecycle(), 'a', 0).state,
      speechStarted(showBubble(createBubbleLifecycle(), 'b', 0).state).state,
      speechResult(speechStarted(showBubble(createBubbleLifecycle(), 'c', 0).state).state, 'timeout').state,
    ]) {
      expect(bubbleTick(state, 59_999).hide).toBe(false);
      expect(bubbleTick(state, 60_000).hide).toBe(true);
    }
  });
  it('语音关闭直接静音；hidden 事件幂等', () => {
    const muted = showBubble(createBubbleLifecycle(), '字幕', 0, false);
    expect(muted.state.phase).toBe('muted');
    expect(muted.muted).toBe(true);
    expect(speechStarted(createBubbleLifecycle()).hide).toBe(true);
    expect(speechResult(createBubbleLifecycle(), 'failed').hide).toBe(true);
    expect(showBubble(createBubbleLifecycle(), '', 0).hide).toBe(true);
  });
});

describe('multi-bubble schedule（按语义类型差异化 TTL）', () => {
  it('各类型默认 TTL 与覆盖值安全夹紧', () => {
    expect(BUBBLE_KIND_TTL_MS.reaction).toBeLessThan(BUBBLE_KIND_TTL_MS.dialog);
    expect(BUBBLE_KIND_TTL_MS.legacy).toBe(10_000);
    expect(BUBBLE_KIND_TTL_MS.dialog).toBeLessThan(BUBBLE_KIND_TTL_MS.thought);
    expect(BUBBLE_KIND_TTL_MS.thought).toBeLessThan(BUBBLE_KIND_TTL_MS.status);

    expect(ttlForBubbleKind('notice')).toBe(8_000);
    expect(ttlForBubbleKind('hint', 500)).toBe(1_500);
    expect(ttlForBubbleKind('hint', 120_000)).toBe(60_000);
    expect(ttlForBubbleKind('hint', 7_500)).toBe(7_500);
  });

  it('多槽位调度按各自 TTL 过期，voiceManaged 槽位不被普通 tick 收起', () => {
    let sched = createBubbleSchedule();
    sched = scheduleBubbleSlot(sched, 'reaction', '呀！', 1_000);
    sched = scheduleBubbleSlot(sched, 'status', '星露谷 第1年夏', 1_000);
    sched = scheduleBubbleSlot(sched, 'dialog', '语音播报中', 1_000, { voiceManaged: true });

    const t1 = tickBubbleSchedule(sched, 5_000);
    expect(t1.expired).toEqual([]);
    expect(t1.state).toBe(sched);

    const t2 = tickBubbleSchedule(t1.state, 7_000);
    expect(t2.expired).toEqual(['reaction']);
    expect(t2.state.reaction).toBeUndefined();
    expect(t2.state.status).toBeDefined();
    expect(t2.state.dialog).toBeDefined();

    const t3 = tickBubbleSchedule(t2.state, 20_000);
    expect(t3.expired).toEqual(['status']);
    expect(t3.state.dialog?.expiresAt).toBeNull();

    // 空文本等同清除槽位；cancel 幂等
    const emptied = scheduleBubbleSlot(t3.state, 'dialog', '   ', 21_000);
    expect(emptied.dialog).toBeUndefined();
    expect(cancelBubbleSlot(emptied, 'dialog')).toBe(emptied);
    expect(cancelBubbleSlot(t3.state, 'dialog').dialog).toBeUndefined();
  });
});
