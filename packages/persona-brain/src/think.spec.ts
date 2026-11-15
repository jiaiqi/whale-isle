import { describe, expect, it } from 'vitest';
import { createThinkStreamParser, parseEmotionPrefix, stripThink } from './think';

/** T-M1-04：<think> 内心戏剥离（整段/流式跨块/未闭合兜底）+ 情绪前缀解析 */

describe('stripThink（整段剥离）', () => {
  it('基础剥离：可见正文与内心戏分离', () => {
    const { visible, innerThoughts } = stripThink('<think>想小鱼了</think>哼，本鱼才没有偷懒！');
    expect(visible).toBe('哼，本鱼才没有偷懒！');
    expect(innerThoughts).toEqual(['想小鱼了']);
  });

  it('多段 think 与无 think 混排', () => {
    const { visible, innerThoughts } = stripThink('a<think>一</think>b<think>二</think>c');
    expect(visible).toBe('abc');
    expect(innerThoughts).toEqual(['一', '二']);
  });

  it('未闭合 think：余下全部视为内心戏', () => {
    const { visible, innerThoughts } = stripThink('开头<think>偷偷数白米饭');
    expect(visible).toBe('开头');
    expect(innerThoughts).toEqual(['偷偷数白米饭']);
  });

  it('自定义标签（innerVoiceConfig.thinkTagName 可配）', () => {
    const { visible, innerThoughts } = stripThink('<Thoughts>内部的</Thoughts>好', 'Thoughts');
    expect(visible).toBe('好');
    expect(innerThoughts).toEqual(['内部的']);
  });

  it('纯内心戏（无可见输出）', () => {
    const { visible, innerThoughts } = stripThink('<think>只有内心戏</think>');
    expect(visible).toBe('');
    expect(innerThoughts).toEqual(['只有内心戏']);
  });
});

describe('createThinkStreamParser（流式剥离）', () => {
  it('分块跨标签边界安全（"<thi" 悬挂不吐出）', () => {
    const parser = createThinkStreamParser();
    const first = parser.feed('好<thi');
    expect(first.visibleChunk).toBe('好');
    expect(first.thoughtChunk).toBeNull();
    const second = parser.feed('nk>想小鱼了</think>，鱼片！');
    expect(second.thoughtChunk).toBe('想小鱼了');
    expect(second.visibleChunk).toBe('，鱼片！');
    const final = parser.result();
    expect(final.visible).toBe('好，鱼片！');
    expect(final.innerThoughts).toEqual(['想小鱼了']);
  });

  it('一次喂入完整内容', () => {
    const parser = createThinkStreamParser();
    const feed = parser.feed('<think>饭呢</think>开饭！');
    expect(feed.visibleChunk).toBe('开饭！');
    expect(feed.thoughtChunk).toBe('饭呢');
    expect(parser.result()).toEqual({ visible: '开饭！', innerThoughts: ['饭呢'] });
  });

  it('未闭合：result() 把余量计入内心戏', () => {
    const parser = createThinkStreamParser();
    parser.feed('前<think>思考中……');
    const feed = parser.feed('还在想');
    expect(feed.visibleChunk).toBe('');
    const final = parser.result();
    expect(final.visible).toBe('前');
    expect(final.innerThoughts).toEqual(['思考中……还在想']);
  });

  it('关闭标签跨块悬挂（</thin 悬挂）', () => {
    const parser = createThinkStreamParser();
    const first = parser.feed('<think>abc</thin'); // 'abc' 随本块发射（悬挂的只是关闭标签后半）
    expect(first.thoughtChunk).toBe('abc');
    const feed = parser.feed('k>done'); // 补全关闭标签 → 内心戏闭合，'done' 为可见正文
    expect(feed.thoughtChunk).toBeNull();
    expect(feed.visibleChunk).toBe('done');
  });
});

describe('parseEmotionPrefix（情绪前缀 → TTS 路由）', () => {
  it('五档前缀映射', () => {
    expect(parseEmotionPrefix('[傲娇反驳] 哼，本鱼才没有偷懒！')).toEqual({
      emotionTag: 'tsundere_refuse',
      body: '哼，本鱼才没有偷懒！',
    });
    expect(parseEmotionPrefix('[破防喷水] 噗——').emotionTag).toBe('rage_spray');
    expect(parseEmotionPrefix('[嘴甜常态] 主人~').emotionTag).toBe('sweet_normal');
    expect(parseEmotionPrefix('[困倦摸鱼] zzz').emotionTag).toBe('lazy_yawn');
    expect(parseEmotionPrefix('[干饭兴奋] 米！').emotionTag).toBe('happy_rice');
  });

  it('无前缀 / 未知前缀 → emotionTag null 且正文原样', () => {
    expect(parseEmotionPrefix('普通回复')).toEqual({ emotionTag: null, body: '普通回复' });
    expect(parseEmotionPrefix('[未知标签] 正文')).toEqual({ emotionTag: null, body: '[未知标签] 正文' });
  });
});
