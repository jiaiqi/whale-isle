/**
 * 兴趣沉淀（V2-P3-04D · REQ-SOC-01 L1 / REQ-CHAR-02，蓝图 08 §5 Interest Update）：
 * ContentUnderstanding → InterestSignal → PreferenceStore(topics) + 记忆图谱。
 * - delta 是模型判定（interestRelevance × sentiment）的确定性映射，程序不发明偏好；
 *   单次 ±0.5 上限由契约兜底，|delta| < 0.05 视为噪声不沉淀。
 * - 记忆经 InterestMemoryPort 窄端口写入（dependency-cruiser：character-core 不直连 memory-graph，
 *   宿主用 MemoryStore 实现端口，注入反转保持包边界）。
 */
import {
  InterestSignalSchema,
  type ContentUnderstanding,
  type ContentSentiment,
  type InterestSignal,
} from '@workbench/shared-protocol';
import type { PreferenceStore } from './profile-stores';

/** 记忆写入窄端口（宿主以 memory-graph MemoryStore 实现） */
export interface InterestMemoryPort {
  addNode(input: {
    nodeType: 'event' | 'concept';
    text: string;
    characterId?: string;
    importance?: number;
    confidence?: number;
    derivedFromIds?: string[];
  }): { id: string };
}

const SENTIMENT_FACTOR: Record<ContentSentiment, number> = {
  positive: 1,
  neutral: 0.6,
  mixed: 0.4,
  negative: -1,
};

/** 噪声门槛：幅度过小的信号不沉淀（防止偏好抖动） */
const SIGNAL_NOISE_FLOOR = 0.05;

export function signalDelta(relevance: number, sentiment: ContentSentiment): number {
  return Number(Math.max(-0.5, Math.min(0.5, (relevance - 0.5) * SENTIMENT_FACTOR[sentiment])).toFixed(4));
}

export interface InterestSinkOptions {
  characterId: string;
  preferences: PreferenceStore;
  memory?: InterestMemoryPort;
  now?: () => number;
  newId?: () => string;
}

export class InterestSink {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: InterestSinkOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `is-${Math.random().toString(36).slice(2, 10)}`);
  }

  /**
   * 沉淀一次内容理解：写浏览经历（episodic event），按话题生成兴趣信号并更新偏好，
   * 返回实际落账的信号列表（噪声信号不落账但仍留浏览记忆）。
   */
  ingest(understanding: ContentUnderstanding): InterestSignal[] {
    const source = `social:${understanding.item.platform}`;
    const title = understanding.item.title || understanding.item.url;

    // 浏览经历（无论是否有兴趣信号都留痕，derivedFromIds 供级联删除）
    const eventNode = this.options.memory?.addNode({
      nodeType: 'event',
      text: `浏览了《${title}》：${understanding.summary}`,
      characterId: this.options.characterId,
      importance: 0.4,
      confidence: 0.9,
    });

    const signals: InterestSignal[] = [];
    for (const topic of understanding.topics) {
      const delta = signalDelta(understanding.interestRelevance, understanding.sentiment);
      if (Math.abs(delta) < SIGNAL_NOISE_FLOOR) continue;
      const signal = InterestSignalSchema.parse({
        signalId: this.newId(),
        characterId: this.options.characterId,
        understandingId: understanding.understandingId,
        topicKey: topic,
        delta,
        confidence: understanding.interestRelevance,
        source,
        evidenceSummary: understanding.summary.slice(0, 300),
        createdAt: this.now(),
      });
      this.options.preferences.recordExperience({
        category: 'topics',
        key: signal.topicKey,
        delta: signal.delta,
        source: signal.source,
        reason: signal.evidenceSummary || `浏览《${title}》`,
        confidence: signal.confidence,
      });
      if (eventNode) {
        this.options.memory?.addNode({
          nodeType: 'concept',
          text: `对「${signal.topicKey}」的兴趣 ${signal.delta > 0 ? '+' : ''}${signal.delta}（${title}）`,
          characterId: this.options.characterId,
          importance: 0.5,
          confidence: signal.confidence,
          derivedFromIds: [eventNode.id],
        });
      }
      signals.push(signal);
    }
    return signals;
  }
}
