import { describe, expect, it } from 'vitest';
import { bubbleTick, createBubbleLifecycle, showBubble, speakerIdle, speechResult, speechStarted } from './bubble-lifecycle';

describe('bubble lifecycle', () => {
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
