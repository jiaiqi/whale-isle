/**
 * L1 只读浏览执行器骨架（V2-P3-04G 续 · REQ-SOC-01 / REQ-LIFE-01，蓝图 08 §5/§10）：
 * - 三段可替换端口：候选来源（CandidateSource）→ 逐条读取（ItemReader）→ 内容理解（Understander）。
 * - 执行器只负责「按预算逐条走完并如实记账」，不决定看什么（ADR-002 AI-First 红线）。
 * - 双门禁：契约层的平台能力矩阵（授权 + 已实测）之外，执行器再自查一次来源自述，
 *   未经逐项实测的平台源一律 PERMISSION_DENIED；本地夹具源必须显式放行才可运行，
 *   且永远不进入产品默认路径——绝不允许把「本地假数据跑通」说成「能浏览网页」。
 * - 预算：maxItems / maxDurationMs 由 SocialRuntime 执行；本类只管理解调用配额
 *   （maxUnderstandingCalls）与用户中途打断（isInterrupted）。
 */
import {
  SocialBrowseRunSummarySchema,
  SocialBrowseSourceDescriptorSchema,
  type BrowseCandidate,
  type BrowseSession,
  type SocialBrowseRunSummary,
  type SocialBrowseSourceDescriptor,
  type SocialBrowseSourceKind,
  type SocialPlatformId,
} from '@workbench/shared-protocol';
import { WhaleError } from '@workbench/runtime-core';
import type { SocialRuntime } from './social-runtime';

type BrowseCandidateInput = Parameters<SocialRuntime['recordViewed']>[1];

/** 候选来源端口：只供给候选，不做任何互动写操作 */
export interface SocialBrowseCandidateSource {
  readonly descriptor: SocialBrowseSourceDescriptor;
  listCandidates(input: { objective: string; limit: number }): Promise<BrowseCandidateInput[]>;
}

/** 逐条读取端口：只读公开内容，返回可交给理解器的纯文本 */
export interface SocialBrowseItemReader {
  read(candidate: BrowseCandidate): Promise<{ textContent: string; usedMultimodal?: boolean }>;
}

/** 理解端口：宿主接到 ContentUnderstandingPipeline + InterestSink（模型不可用则抛错，不静默退化） */
export interface SocialBrowseUnderstander {
  integrate(input: { session: BrowseSession; candidate: BrowseCandidate; textContent: string }): Promise<void>;
}

export interface SocialBrowseExecutorOptions {
  runtime: SocialRuntime;
  /**
   * 是否允许运行 `local_fixture` 候选源。默认 false：生产路径只认已实测的真实平台源。
   * 单测与开发沙盒显式打开，产品运行期不得打开。
   */
  allowLocalFixture?: boolean;
  /** 默认 8，取调度决策下发的同名预算 */
  maxUnderstandingCalls?: number;
  /** 用户中途打断（P0 急停 / 手动中止 / 用户在玩游戏等），每走一条前检查一次 */
  isInterrupted?: () => boolean;
  onSummary?: (summary: SocialBrowseRunSummary) => void;
}

interface ExecutorRunInput {
  sessionId: string;
  reader?: SocialBrowseItemReader;
  understander?: SocialBrowseUnderstander;
  maxUnderstandingCalls?: number;
}

export class SocialBrowseExecutor {
  private readonly sources = new Map<
    SocialPlatformId,
    { source: SocialBrowseCandidateSource; descriptor: SocialBrowseSourceDescriptor }
  >();

  constructor(private readonly options: SocialBrowseExecutorOptions) {}

  /** 注册候选来源；同一平台后注册的覆盖先注册的（来源可热替换） */
  registerSource(source: SocialBrowseCandidateSource): SocialBrowseSourceDescriptor {
    const descriptor = SocialBrowseSourceDescriptorSchema.parse(source.descriptor);
    // 保存原始实例而不是展开：展开会丢掉类实例的原型方法
    this.sources.set(descriptor.platform, { source, descriptor });
    return descriptor;
  }

  unregisterSource(platform: SocialPlatformId): boolean {
    return this.sources.delete(platform);
  }

  status(): { wired: boolean; sources: SocialBrowseSourceDescriptor[]; runnable: boolean } {
    const sources = [...this.sources.values()].map((entry) => entry.descriptor);
    return {
      wired: true,
      sources,
      // 只有「真实平台 + 自述已实测」才算可运行；夹具源永远不置真
      runnable: sources.some((descriptor) => descriptor.kind === 'platform' && descriptor.verified),
    };
  }

  /** 某平台当前的候选来源（未注册返回 undefined，调用方据此如实拦截，不伪造来源） */
  sourceFor(platform: SocialPlatformId): SocialBrowseCandidateSource | undefined {
    return this.sources.get(platform)?.source;
  }

  /**
   * 跑完一次会话。会话必须由 SocialRuntime 规划并已 start（能力矩阵已放行）。
   * 任何越权路径都在动第一根手指前抛错，绝不先读后报错。
   */
  async run(input: ExecutorRunInput): Promise<SocialBrowseRunSummary> {
    const runtime = this.options.runtime;
    const session = runtime.getSession(input.sessionId);
    if (!session) {
      throw new WhaleError('CHARACTER_NOT_FOUND', `浏览会话不存在：${input.sessionId}`, {
        context: { sessionId: input.sessionId },
      });
    }
    const entry = this.sources.get(session.platform);
    if (!entry) {
      throw new WhaleError('PERMISSION_DENIED', `平台没有候选来源，不发起：${session.platform}`, {
        recoverable: true,
        context: { platform: session.platform },
      });
    }
    const { source, descriptor } = entry;
    this.assertSourceUsable(descriptor);

    const maxUnderstandingCalls = input.maxUnderstandingCalls ?? this.options.maxUnderstandingCalls ?? 8;
    let candidatesConsidered = 0;
    let itemsViewed = 0;
    let readFailures = 0;
    let understandingCalls = 0;
    let understandingSkipped = 0;
    let understandingFailures = 0;
    let detail = '';

    const candidates = await source.listCandidates({ objective: session.objective, limit: session.maxItems });
    candidatesConsidered = candidates.length;

    for (const raw of candidates) {
      const current = runtime.getSession(input.sessionId);
      if (!current || current.status !== 'active') break;
      if (this.options.isInterrupted?.()) {
        runtime.abort(input.sessionId, 'user_stopped');
        detail = '用户中途打断，立即中止';
        break;
      }
      // 时长预算：tick 到点会以 budget_exhausted 收官
      if (runtime.tick(input.sessionId).status !== 'active') break;

      let textContent: string | undefined;
      if (input.reader) {
        try {
          textContent = (await input.reader.read(raw as BrowseCandidate)).textContent;
        } catch (error) {
          readFailures += 1;
          detail = `逐条读取失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
          continue; // 读取失败不计入已浏览条目，继续下一条
        }
      }

      const before = runtime.getSession(input.sessionId);
      if (!before || before.status !== 'active') break;
      const viewed = runtime.recordViewed(input.sessionId, raw);
      itemsViewed += 1;

      // 理解配额：超额只记浏览事实，不再调用模型
      if (understandingCalls >= maxUnderstandingCalls) {
        understandingSkipped += 1;
      } else if (input.understander && textContent !== undefined) {
        try {
          await input.understander.integrate({
            session: viewed,
            candidate: raw as BrowseCandidate,
            textContent,
          });
          understandingCalls += 1;
        } catch (error) {
          understandingCalls += 1; // 已发生的模型调用照样计入配额，避免「失败不计数」被刷爆
          understandingFailures += 1;
          detail = `内容理解失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
        }
      } else {
        understandingSkipped += 1;
      }

      if (viewed.status !== 'active') break;
    }

    const finished = runtime.getSession(input.sessionId);
    const finalSession =
      finished && finished.status === 'active' ? runtime.complete(input.sessionId) : (finished ?? session);

    const summary = SocialBrowseRunSummarySchema.parse({
      sessionId: input.sessionId,
      platform: session.platform,
      sourceId: descriptor.sourceId,
      sourceKind: descriptor.kind,
      candidatesConsidered,
      itemsViewed,
      readFailures,
      understandingCalls,
      understandingSkipped,
      understandingFailures,
      stopReason: finalSession.stopReason ?? 'objective_met',
      status: finalSession.status,
      detail: detail || (descriptor.kind === 'local_fixture' ? '本地夹具链路（未接任何真实平台）' : ''),
    });
    this.options.onSummary?.(summary);
    return summary;
  }

  /** 双门禁第二道：来源自述与运行期口径互相印证，任一不满足即拒绝 */
  private assertSourceUsable(descriptor: SocialBrowseSourceDescriptor): void {
    if (descriptor.kind === 'local_fixture' && this.options.allowLocalFixture !== true) {
      throw new WhaleError('PERMISSION_DENIED', `本地夹具候选源只能在开发/测试路径运行：${descriptor.sourceId}`, {
        recoverable: false,
        context: { sourceId: descriptor.sourceId },
      });
    }
    if (descriptor.kind === 'platform' && !descriptor.verified) {
      throw new WhaleError('PERMISSION_DENIED', `平台候选源未逐项实测，不发起：${descriptor.sourceId}`, {
        recoverable: true,
        context: { sourceId: descriptor.sourceId },
      });
    }
  }
}

/**
 * 本地夹具候选源：确定性、零网络，只用于单测与开发沙盒验证「候选 → 逐条读取 → 理解配额」链路。
 * 自述 kind=local_fixture / verified=false，任何把它当真实平台的展示都是撒谎。
 */
export class LocalFixtureCandidateSource implements SocialBrowseCandidateSource {
  readonly descriptor: SocialBrowseSourceDescriptor;

  constructor(
    private readonly items: BrowseCandidateInput[],
    options: { platform?: SocialPlatformId; sourceId?: string; note?: string } = {},
  ) {
    this.descriptor = SocialBrowseSourceDescriptorSchema.parse({
      sourceId: options.sourceId ?? 'local-fixture',
      platform: options.platform ?? 'generic_web',
      kind: 'local_fixture',
      verified: false,
      note: options.note ?? '本地夹具：不联网，仅验证链路',
    });
  }

  async listCandidates(input: { objective: string; limit: number }): Promise<BrowseCandidateInput[]> {
    return this.items.slice(0, Math.max(0, input.limit));
  }
}

/** 执行器回执 → 来源种类文案（UI/文档统一口径，禁止出现「已能浏览网页」这类表述） */
export function describeSourceKind(kind: SocialBrowseSourceKind): string {
  return kind === 'local_fixture' ? '本地夹具（未接真实平台）' : '真实平台';
}
