import { describe, expect, it } from 'vitest';
import {
  CHAT_IMAGE_BASE64_MAX_CHARS,
  CHAT_MESSAGE_MAX_PARTS,
  ChatMessageContentSchema,
  GatewayChatMessageSchema,
} from './model';
import {
  BrowseCandidateSchema,
  BrowseSessionSchema,
  ContentUnderstandingSchema,
  InterestSignalSchema,
  SocialPlatformCapabilityEntrySchema,
} from './social';

describe('多模态消息契约（V2-P3-04A · model.ts）', () => {
  it('纯文本字符串与 parts 列表均可作为 content', () => {
    expect(ChatMessageContentSchema.parse('你好')).toBe('你好');
    const parts = ChatMessageContentSchema.parse([
      { type: 'text', text: '看这张图' },
      { type: 'image', source: { kind: 'url', url: 'https://example.com/a.png' } },
    ]);
    expect(Array.isArray(parts)).toBe(true);
  });

  it('base64 图片受字符上限约束，非法 mime 被拒', () => {
    const ok = GatewayChatMessageSchema.parse({
      role: 'user',
      content: [{ type: 'image', source: { kind: 'base64', mime: 'image/png', dataBase64: 'QUJD' } }],
    });
    expect(ok.role).toBe('user');
    expect(() =>
      GatewayChatMessageSchema.parse({
        role: 'user',
        content: [{ type: 'image', source: { kind: 'base64', mime: 'image/svg+xml', dataBase64: 'QUJD' } }],
      }),
    ).toThrow();
    expect(() =>
      GatewayChatMessageSchema.parse({
        role: 'user',
        content: [
          { type: 'image', source: { kind: 'base64', mime: 'image/png', dataBase64: 'A'.repeat(CHAT_IMAGE_BASE64_MAX_CHARS + 1) } },
        ],
      }),
    ).toThrow();
  });

  it('空 parts 与超量 parts 均被拒，角色枚举收紧', () => {
    expect(() => ChatMessageContentSchema.parse([])).toThrow();
    expect(() =>
      ChatMessageContentSchema.parse(
        Array.from({ length: CHAT_MESSAGE_MAX_PARTS + 1 }, () => ({ type: 'text', text: 'x' })),
      ),
    ).toThrow();
    expect(() => GatewayChatMessageSchema.parse({ role: 'tool', content: 'x' })).toThrow();
  });
});

describe('社区数字生活 L1 契约（V2-P3-04A · social.ts）', () => {
  const baseSession = {
    sessionId: 'bs-1',
    characterId: 'char_xiaojing',
    profileId: 'prof-1',
    platform: 'bilibili',
    interactionMode: 'readonly',
    objective: '了解最近的独立游戏讨论',
    status: 'planned',
    startedAt: 1_764_000_000_000,
  };

  it('L1 硬边界：interactionMode 只允许 readonly', () => {
    const session = BrowseSessionSchema.parse(baseSession);
    expect(session.interactionMode).toBe('readonly');
    expect(session.maxItems).toBe(10);
    expect(session.maxDurationMs).toBe(600_000);
    expect(() => BrowseSessionSchema.parse({ ...baseSession, interactionMode: 'readwrite' })).toThrow();
  });

  it('会话预算受上下限约束', () => {
    expect(() => BrowseSessionSchema.parse({ ...baseSession, maxItems: 0 })).toThrow();
    expect(() => BrowseSessionSchema.parse({ ...baseSession, maxItems: 51 })).toThrow();
    expect(() => BrowseSessionSchema.parse({ ...baseSession, maxDurationMs: 5_000 })).toThrow();
  });

  it('平台能力矩阵逐项声明，lastVerifiedAt 默认 0（未实测）', () => {
    const entry = SocialPlatformCapabilityEntrySchema.parse({
      platform: 'douyin',
      capability: 'read_public',
      channel: 'official_api',
      allowed: false,
    });
    expect(entry.lastVerifiedAt).toBe(0);
    expect(entry.riskLevel).toBe('P2');
    expect(() =>
      SocialPlatformCapabilityEntrySchema.parse({
        platform: 'douyin',
        capability: 'teleport',
        channel: 'official_api',
        allowed: true,
      }),
    ).toThrow();
  });

  it('内容理解必须诚实记录模型与摘要，话题数量受限', () => {
    const understanding = ContentUnderstandingSchema.parse({
      understandingId: 'cu-1',
      sessionId: 'bs-1',
      characterId: 'char_xiaojing',
      item: { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx', contentKind: 'video' },
      summary: '独立游戏开发日志，讲像素动画管线',
      interestRelevance: 0.8,
      modelId: 'deepseek/deepseek-vl',
      understoodAt: 1_764_000_000_000,
    });
    expect(understanding.sentiment).toBe('neutral');
    expect(understanding.usedMultimodal).toBe(false);
    expect(() =>
      ContentUnderstandingSchema.parse({
        understandingId: 'cu-2',
        sessionId: 'bs-1',
        characterId: 'char_xiaojing',
        item: { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx', contentKind: 'video' },
        summary: 'x',
        topics: Array.from({ length: 11 }, (_, i) => `t${i}`),
        interestRelevance: 0.5,
        modelId: 'm',
        understoodAt: 1,
      }),
    ).toThrow();
  });

  it('兴趣信号单次幅度封顶 ±0.5，防止一次浏览剧烈改写偏好', () => {
    const signal = InterestSignalSchema.parse({
      signalId: 'is-1',
      characterId: 'char_xiaojing',
      topicKey: '独立游戏',
      delta: 0.3,
      source: 'social:bilibili',
      createdAt: 1_764_000_000_000,
    });
    expect(signal.confidence).toBe(0.5);
    expect(() =>
      InterestSignalSchema.parse({
        signalId: 'is-2',
        characterId: 'char_xiaojing',
        topicKey: '独立游戏',
        delta: 0.8,
        source: 'social:bilibili',
        createdAt: 1,
      }),
    ).toThrow();
  });

  it('浏览候选必须带合法 URL 与内容类型', () => {
    const candidate = BrowseCandidateSchema.parse({
      candidateId: 'cand-1',
      platform: 'generic_web',
      url: 'https://blog.example.com/post/1',
      contentKind: 'text',
      sourceKind: 'subscription',
    });
    expect(candidate.title).toBe('');
    expect(() =>
      BrowseCandidateSchema.parse({
        candidateId: 'cand-2',
        platform: 'generic_web',
        url: 'not-a-url',
        contentKind: 'text',
        sourceKind: 'subscription',
      }),
    ).toThrow();
  });
});
