import { describe, expect, it } from 'vitest';
import type { GatewayChatMessage } from '@workbench/shared-protocol';
import { WhaleError } from '@workbench/runtime-core';
import {
  ContentUnderstandingPipeline,
  extractJsonObject,
  type UnderstandingGatewayPort,
} from './content-understanding';
import { InterestSink, signalDelta, type InterestMemoryPort } from './interest-sink';
import { PreferenceStore } from './profile-stores';

const ITEM = {
  platform: 'bilibili' as const,
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '独立游戏开发日志',
  contentKind: 'video' as const,
  authorAlias: '',
};

function stubGateway(reply: string, modelId = 'deepseek/deepseek-vl'): UnderstandingGatewayPort & { calls: GatewayChatMessage[][] } {
  const calls: GatewayChatMessage[][] = [];
  return {
    calls,
    chat: async (_slot, messages) => {
      calls.push(messages);
      return { content: reply, modelId };
    },
  };
}

const GOOD_REPLY = '```json\n{"summary": "讲像素动画管线", "topics": ["独立游戏", "像素画"], "sentiment": "positive", "interestRelevance": 0.9}\n```';

describe('内容理解管线（V2-P3-04D）', () => {
  it('正文+截图 → 多模态消息 → ContentUnderstanding（modelId 取回执真实路由）', async () => {
    const gateway = makeGatewayStub();
    const pipeline = new ContentUnderstandingPipeline({
      characterId: 'char_xiaojing',
      gateway,
      now: () => 1_764_000_000_000,
      newId: () => 'cu-test',
    });
    const result = await pipeline.understand({
      sessionId: 'bs-1',
      item: ITEM,
      textContent: '正文……',
      screenshot: { mime: 'image/png', dataBase64: 'QUJD' },
      currentInterests: ['星露谷'],
    });
    expect(result.understandingId).toBe('cu-test');
    expect(result.usedMultimodal).toBe(true);
    expect(result.modelId).toBe('deepseek/deepseek-vl');
    expect(result.topics).toEqual(['独立游戏', '像素画']);
    // 消息形状：system 文本 + user parts（text + image）
    const messages = gateway.calls[0]!;
    expect(messages[0]!.role).toBe('system');
    const userParts = messages[1]!.content;
    expect(Array.isArray(userParts)).toBe(true);
    expect((userParts as Array<{ type: string }>)[1]!.type).toBe('image');
    // 注入红线：system 明确声明素材不可信
    expect(messages[0]!.content as string).toContain('不可信数据');
  });

  it('无截图走纯文本消息，usedMultimodal=false', async () => {
    const gateway = makeGatewayStub();
    const pipeline = new ContentUnderstandingPipeline({ characterId: 'char_xiaojing', gateway });
    const result = await pipeline.understand({ sessionId: 'bs-1', item: ITEM, textContent: '正文' });
    expect(result.usedMultimodal).toBe(false);
    expect(typeof gateway.calls[0]![1]!.content).toBe('string');
  });

  it('模型输出无 JSON / JSON 损坏 → 抛错不编造（调用层安全暂停）', async () => {
    const pipeline = new ContentUnderstandingPipeline({
      characterId: 'char_xiaojing',
      gateway: stubGateway('这段没有 JSON'),
    });
    await expect(pipeline.understand({ sessionId: 'bs-1', item: ITEM, textContent: 'x' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    const broken = new ContentUnderstandingPipeline({
      characterId: 'char_xiaojing',
      gateway: stubGateway('{broken json'),
    });
    await expect(broken.understand({ sessionId: 'bs-1', item: ITEM, textContent: 'x' })).rejects.toBeInstanceOf(WhaleError);
  });

  it('extractJsonObject 容忍围栏与闲谈；正文超长截断', async () => {
    expect(extractJsonObject('前言 {"a":1} 后记')).toEqual({ a: 1 });
    const gateway = makeGatewayStub();
    const pipeline = new ContentUnderstandingPipeline({ characterId: 'char_xiaojing', gateway });
    await pipeline.understand({ sessionId: 'bs-1', item: ITEM, textContent: '长'.repeat(10_000) });
    const userText = gateway.calls[0]![1]!.content as string;
    expect(userText.length).toBeLessThan(10_000);
  });
});

function makeGatewayStub() {
  return stubGateway(GOOD_REPLY);
}

describe('兴趣沉淀（V2-P3-04D）', () => {
  function makeSink() {
    const preferences = new PreferenceStore({ characterId: 'char_xiaojing', items: [], history: [], updatedAt: 0 }, { now: () => 1_764_000_000_000 });
    const memoryCalls: Array<{ nodeType: string; text: string; derivedFromIds?: string[] }> = [];
    const memory: InterestMemoryPort = {
      addNode: (input) => {
        memoryCalls.push(input);
        return { id: `n${memoryCalls.length}` };
      },
    };
    const sink = new InterestSink({
      characterId: 'char_xiaojing',
      preferences,
      memory,
      now: () => 1_764_000_000_000,
      newId: () => `is-${memoryCalls.length}`,
    });
    return { sink, preferences, memoryCalls };
  }

  const UNDERSTANDING = {
    understandingId: 'cu-1',
    sessionId: 'bs-1',
    characterId: 'char_xiaojing',
    item: ITEM,
    summary: '讲像素动画管线',
    topics: ['独立游戏', '像素画'],
    sentiment: 'positive' as const,
    interestRelevance: 0.9,
    usedMultimodal: false,
    modelId: 'm',
    understoodAt: 1_764_000_000_000,
  };

  it('信号 → PreferenceStore(topics) 带来源历史，记忆留 event + concept 派生链', () => {
    const { sink, preferences, memoryCalls } = makeSink();
    const signals = sink.ingest(UNDERSTANDING);
    expect(signals).toHaveLength(2);
    // (0.9-0.5)*1 = 0.4
    expect(signals[0]!.delta).toBeCloseTo(0.4);
    expect(signals[0]!.source).toBe('social:bilibili');

    const state = preferences.snapshot();
    const topic = state.items.find((item) => item.category === 'topics' && item.key === '独立游戏');
    expect(topic?.score).toBeCloseTo(0.4);
    expect(state.history.length).toBe(2);
    expect(state.history[0]!.source).toBe('social:bilibili');

    // 记忆：1 个浏览 event + 2 个话题 concept（derivedFromIds 指向 event）
    expect(memoryCalls[0]!.nodeType).toBe('event');
    const concepts = memoryCalls.filter((call) => call.nodeType === 'concept');
    expect(concepts).toHaveLength(2);
    expect(concepts[0]!.derivedFromIds).toEqual(['n1']);
  });

  it('负面情绪产生负 delta；噪声信号不落账但浏览记忆仍留痕', () => {
    const { sink, preferences, memoryCalls } = makeSink();
    const signals = sink.ingest({ ...UNDERSTANDING, sentiment: 'negative', topics: ['广告营销'] });
    expect(signals[0]!.delta).toBeCloseTo(-0.4);
    expect(preferences.snapshot().items.find((item) => item.key === '广告营销')?.score).toBeCloseTo(-0.4);

    const noisy = sink.ingest({ ...UNDERSTANDING, understandingId: 'cu-2', sentiment: 'neutral', interestRelevance: 0.5, topics: ['路过话题'] });
    expect(noisy).toHaveLength(0); // (0.5-0.5)*0.6=0 → 噪声
    expect(preferences.snapshot().items.find((item) => item.key === '路过话题')).toBeUndefined();
    // 浏览经历仍留痕（两次 ingest 各一条 event）
    expect(memoryCalls.filter((call) => call.nodeType === 'event')).toHaveLength(2);
  });

  it('signalDelta 边界：封顶 ±0.5，sentiment 因子确定性映射', () => {
    expect(signalDelta(1, 'positive')).toBe(0.5);
    expect(signalDelta(0, 'positive')).toBe(-0.5);
    expect(signalDelta(1, 'negative')).toBe(-0.5);
    expect(signalDelta(0.8, 'neutral')).toBeCloseTo(0.18);
    expect(signalDelta(0.8, 'mixed')).toBeCloseTo(0.12);
  });

  it('无记忆端口也能沉淀偏好（端口可选）', () => {
    const preferences = new PreferenceStore({ characterId: 'char_xiaojing', items: [], history: [], updatedAt: 0 });
    const sink = new InterestSink({ characterId: 'char_xiaojing', preferences });
    const signals = sink.ingest(UNDERSTANDING);
    expect(signals).toHaveLength(2);
    expect(preferences.snapshot().items).toHaveLength(2);
  });
});
