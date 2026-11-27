/**
 * V2-P3-02 LiveRuntime：LifeRuntime 驱动的直播中控、平台适配器、曲库版权门禁、礼物合并与 OBS 舞台投影
 * - 严格复用 LiveEventHub（去重 + Guard + 三级注意力调度）
 * - 严禁编造假观众数/码率/假直播连通状态；未接真实平台流或端点头检查失败时诚实标 degraded + realPlatformVerified: false
 * - 公开直播点歌必须经过曲目/伴奏/歌词/声音模型四重授权校验（拦截 unlicensed 与 dev_only_non_commercial）
 */
import { randomUUID } from 'node:crypto';
import {
  LiveObsStagePayloadSchema,
  LivePlatformAdapterStatusSchema,
  LiveRuntimeSnapshotSchema,
  LiveSessionStartInputSchema,
  LiveSessionSummarySchema,
  LiveSongQueueItemSchema,
  LiveSongRequestInputSchema,
  SongCatalogItemSchema,
  SongRightsSchema,
  type LiveGiftThankBatch,
  type LiveObsDanmakuItem,
  type LiveObsStagePayload,
  type LivePlatformAdapterStatus,
  type LivePlatformId,
  type LiveRuntimeSnapshot,
  type LiveSessionStartInput,
  type LiveSessionSummary,
  type LiveSongQueueItem,
  type LiveSongRequestInput,
  type LyricsClockFrame,
  type SongCatalogItem,
  type SongCatalogItemInput,
  type SongLicenseScope,
  type SongRightsInput,
} from '@workbench/shared-protocol';
import { LiveEventHub, type IngestOutcome } from './hub';
import { LiveEngagement } from './engagement';
import type { LiveEngagementAction } from '@workbench/shared-protocol';

function isLivestreamScopeAllowed(scope: SongLicenseScope): boolean {
  return scope === 'original_owned' || scope === 'licensed_livestream' || scope === 'licensed_commercial';
}

/** 公开直播曲库版权与声音模型四重授权门禁 */
export function checkLivestreamSongRights(rawRights: SongRightsInput): { allowed: boolean; reasons: string[] } {
  const rights = SongRightsSchema.parse(rawRights);
  const reasons: string[] = [];
  if (!rights.voiceModelAuthorized) {
    reasons.push('角色声音模型未经授权，禁止公开直播演唱');
  }
  if (!isLivestreamScopeAllowed(rights.songLicense)) {
    reasons.push(`歌曲主版权（${rights.songLicense}）不允许公开直播`);
  }
  if (!isLivestreamScopeAllowed(rights.accompanimentLicense)) {
    reasons.push(`伴奏版权（${rights.accompanimentLicense}）不允许公开直播`);
  }
  if (!isLivestreamScopeAllowed(rights.lyricsLicense)) {
    reasons.push(`歌词权（${rights.lyricsLicense}）不允许公开直播`);
  }
  return { allowed: reasons.length === 0, reasons };
}

function apiModeForPlatform(platform: LivePlatformId) {
  if (platform === 'local_replay') return 'local_replay' as const;
  if (platform === 'douyin_dyhub') return 'dyhub_bridge' as const;
  return 'official_open_api' as const;
}

/** 真实平台端点探针：禁止虚构在线状态；缺端点或健康检查失败一律诚实标为 degraded */
export async function probeLivePlatformEndpoint(input: {
  platform: LivePlatformId;
  roomId: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<LivePlatformAdapterStatus> {
  const apiMode = apiModeForPlatform(input.platform);
  if (input.platform === 'local_replay') {
    return LivePlatformAdapterStatusSchema.parse({
      platform: input.platform,
      roomId: input.roomId,
      connectionState: 'connected',
      apiMode,
      detail: '[SIMULATION] 本地回放/沙盒流（非真实直播平台）',
      realPlatformVerified: false,
      reconnectAttempts: 0,
      lastEventAt: null,
    });
  }

  if (!input.endpoint || input.endpoint.trim() === '') {
    return LivePlatformAdapterStatusSchema.parse({
      platform: input.platform,
      roomId: input.roomId,
      connectionState: 'degraded',
      apiMode,
      detail: `${input.platform} 未配置本地桥接或官方开放平台端点，处于降级待连状态`,
      realPlatformVerified: false,
      reconnectAttempts: 0,
      lastEventAt: null,
    });
  }

  const doFetch = input.fetchImpl ?? fetch;
  const cleanBase = input.endpoint.trim().replace(/\/+$/u, '');
  try {
    const res = await doFetch(`${cleanBase}/health`, { method: 'GET' });
    if (res.ok) {
      return LivePlatformAdapterStatusSchema.parse({
        platform: input.platform,
        roomId: input.roomId,
        endpoint: cleanBase,
        connectionState: 'connected',
        apiMode,
        detail: `${input.platform} 端点健康检查通过（仍待真实开播流验真）`,
        realPlatformVerified: false,
        reconnectAttempts: 0,
        lastEventAt: null,
      });
    }
    return LivePlatformAdapterStatusSchema.parse({
      platform: input.platform,
      roomId: input.roomId,
      endpoint: cleanBase,
      connectionState: 'degraded',
      apiMode,
      detail: `${input.platform} 健康检查返回 HTTP ${res.status}，已进入降级提示`,
      realPlatformVerified: false,
      reconnectAttempts: 0,
      lastEventAt: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return LivePlatformAdapterStatusSchema.parse({
      platform: input.platform,
      roomId: input.roomId,
      endpoint: cleanBase,
      connectionState: 'degraded',
      apiMode,
      detail: `${input.platform} 不可达：${msg}`,
      realPlatformVerified: false,
      reconnectAttempts: 0,
      lastEventAt: null,
    });
  }
}

export interface LiveRuntimeV2Options {
  characterId: string;
  hub?: LiveEventHub;
  fetchImpl?: typeof fetch;
  giftBatchThreshold?: number;
  now?: () => number;
}

interface GiftBufferEntry {
  kind: 'gift' | 'follow';
  uid: string;
  nickname: string;
  value: number;
  count: number;
  platform: string;
}

export class LiveRuntimeV2 {
  readonly hub: LiveEventHub;
  readonly engagement = new LiveEngagement();
  private readonly engagementListeners = new Set<(action: LiveEngagementAction) => void>();

  subscribeEngagement(listener: (action: LiveEngagementAction) => void): () => void {
    this.engagementListeners.add(listener);
    return () => { this.engagementListeners.delete(listener); };
  }
  private readonly characterId: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly giftBatchThreshold: number;
  private readonly now: () => number;

  private readonly catalog = new Map<string, SongCatalogItem>();
  private songQueue: LiveSongQueueItem[] = [];
  private blockedSongLog: LiveSongQueueItem[] = [];
  private giftBuffer: GiftBufferEntry[] = [];
  private recentGiftThanks: LiveGiftThankBatch[] = [];
  private recentDanmaku: LiveObsDanmakuItem[] = [];
  private summaries: LiveSessionSummary[] = [];

  private active = false;
  private halted = false;
  private sessionId: string | null = null;
  private startedAt = 0;
  private sceneId = 'obs-live-stage';
  private expression = 'idle';
  private activeSongTitle: string | null = null;
  private lyrics: LyricsClockFrame | null = null;
  private highlights: string[] = [];

  private adapter: LivePlatformAdapterStatus = LivePlatformAdapterStatusSchema.parse({
    platform: 'douyin_dyhub',
    roomId: 'unconnected',
    connectionState: 'idle',
    apiMode: 'dyhub_bridge',
    detail: '尚未开播',
    realPlatformVerified: false,
  });

  private counts = {
    totalEvents: 0,
    danmakuCount: 0,
    giftCount: 0,
    followCount: 0,
    songAcceptedCount: 0,
    songBlockedCount: 0,
    moderationAlerts: 0,
    disconnectCount: 0,
  };

  constructor(options: LiveRuntimeV2Options) {
    this.characterId = options.characterId;
    this.now = options.now ?? Date.now;
    this.hub = options.hub ?? new LiveEventHub({ now: this.now });
    this.fetchImpl = options.fetchImpl;
    this.giftBatchThreshold = Math.max(1, options.giftBatchThreshold ?? 3);
  }

  registerCatalogSong(rawSong: SongCatalogItemInput): SongCatalogItem {
    const song = SongCatalogItemSchema.parse(rawSong);
    this.catalog.set(song.songId, song);
    return song;
  }

  listCatalogSongs(): SongCatalogItem[] {
    return [...this.catalog.values()];
  }

  async startSession(rawInput: LiveSessionStartInput = {}): Promise<{
    ok: boolean;
    error?: string;
    snapshot: LiveRuntimeSnapshot;
  }> {
    if (this.halted) {
      return { ok: false, error: '系统处于急停锁定状态，禁止开启直播', snapshot: this.snapshot() };
    }
    const input = LiveSessionStartInputSchema.parse(rawInput);
    const probe = await probeLivePlatformEndpoint({
      platform: input.platform,
      roomId: input.roomId,
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });

    this.sessionId = `live-${randomUUID().slice(0, 8)}`;
    this.active = true;
    this.startedAt = this.now();
    this.engagement.reset(this.startedAt);
    this.sceneId = input.sceneId ?? 'obs-live-stage';
    this.adapter = probe;
    this.songQueue = [];
    this.blockedSongLog = [];
    this.giftBuffer = [];
    this.recentGiftThanks = [];
    this.recentDanmaku = [];
    this.highlights = [`开播：${input.platform} (${input.roomId})`];
    this.counts = {
      totalEvents: 0,
      danmakuCount: 0,
      giftCount: 0,
      followCount: 0,
      songAcceptedCount: 0,
      songBlockedCount: 0,
      moderationAlerts: 0,
      disconnectCount: 0,
    };
    return { ok: true, snapshot: this.snapshot() };
  }

  markDisconnected(reason: string): LiveRuntimeSnapshot {
    this.counts.disconnectCount += 1;
    this.adapter = {
      ...this.adapter,
      connectionState: 'degraded',
      detail: `平台流断连降级：${reason}`,
    };
    this.highlights.push(`断连告警：${reason}`);
    return this.snapshot();
  }

  markReconnected(detail?: string): LiveRuntimeSnapshot {
    this.adapter = {
      ...this.adapter,
      connectionState: 'connected',
      reconnectAttempts: this.adapter.reconnectAttempts + 1,
      detail: detail ?? `${this.adapter.platform} 已恢复连接`,
    };
    this.highlights.push(`恢复连接（第 ${this.adapter.reconnectAttempts} 次）`);
    return this.snapshot();
  }

  ingestEvent(raw: unknown): {
    outcome: IngestOutcome;
    songItem?: LiveSongQueueItem;
    flushedBatch?: LiveGiftThankBatch;
  } {
    const outcome = this.hub.ingest(raw);
    if (outcome.status === 'rejected') {
      return { outcome };
    }
    if (outcome.status === 'dropped') {
      this.counts.moderationAlerts += 1;
      return { outcome };
    }
    if (outcome.status === 'duplicate') {
      return { outcome };
    }

    const ev = outcome.event!;
    const ts = this.now();
    this.counts.totalEvents += 1;
    this.adapter = { ...this.adapter, lastEventAt: ts };

    // 离线、下播和 P0 锁定期间不得触发编排，也不得污染下一场进度。
    if (this.active && !this.halted) {
      for (const action of this.engagement.ingest(ev, ts)) {
        if (action.action.type === 'song_request') {
          this.requestSong({
            title: action.action.title,
            requesterUid: ev.sender.uid || 'viewer-anon',
            requesterName: ev.sender.nickname || '观众',
            priorityBoost: ev.payload.giftDiamondValue ?? 0,
          });
        }
        for (const listener of this.engagementListeners) {
          try { listener(action); } catch { /* 展示端异常不能中断收流。 */ }
        }
      }
    }

    if (ev.eventType === 'DANMAKU') {
      this.counts.danmakuCount += 1;
      const text = String(ev.payload.sanitizedText ?? ev.payload.rawText ?? '');
      this.recentDanmaku.push({
        eventId: ev.eventId,
        nickname: ev.sender.nickname,
        text,
        priority: String(ev.assignedPriority),
        at: ts,
      });
      if (this.recentDanmaku.length > 20) this.recentDanmaku.shift();
      return { outcome };
    }

    if (ev.eventType === 'GIFT' || ev.eventType === 'ENTER_ROOM' || ev.eventType === 'FOLLOW') {
      const kind = ev.eventType === 'GIFT' ? 'gift' : 'follow';
      if (kind === 'gift') this.counts.giftCount += 1;
      else this.counts.followCount += 1;
      this.giftBuffer.push({
        kind,
        uid: ev.sender.uid,
        nickname: ev.sender.nickname,
        value: typeof ev.payload.giftDiamondValue === 'number' ? ev.payload.giftDiamondValue : 0,
        count: ev.eventType === 'GIFT' ? (ev.payload.giftCount ?? Math.max(1, ev.payload.mergedCount)) : 1,
        platform: ev.platform,
      });
      if (this.giftBuffer.length >= this.giftBatchThreshold) {
        const flushedBatch = this.flushGiftThanks();
        return flushedBatch ? { outcome, flushedBatch } : { outcome };
      }
      return { outcome };
    }

    if (ev.eventType === 'SONG_REQUEST') {
      const title = String(ev.payload.songTitle ?? ev.payload.sanitizedText ?? ev.payload.rawText ?? '').trim();
      const songItem = this.requestSong({
        title: title === '' ? '未命名点歌' : title,
        requesterUid: ev.sender.uid,
        requesterName: ev.sender.nickname,
        priorityBoost: typeof ev.payload.giftDiamondValue === 'number' ? ev.payload.giftDiamondValue : 0,
      });
      return { outcome, songItem };
    }

    return { outcome };
  }

  /** 点歌门禁：必须命中授权曲库且允许直播使用，否则拦截记录 */
  requestSong(rawInput: LiveSongRequestInput): LiveSongQueueItem {
    const req = LiveSongRequestInputSchema.parse(rawInput);
    const catalogSong = this.findCatalogSong(req.songId, req.title);
    const ts = this.now();

    if (!catalogSong) {
      const blocked = LiveSongQueueItemSchema.parse({
        queueId: `sq-${randomUUID().slice(0, 8)}`,
        songId: req.songId ?? null,
        title: req.title,
        requesterUid: req.requesterUid,
        requesterName: req.requesterName,
        priorityBoost: req.priorityBoost,
        rightsAllowed: false,
        rightsReasons: ['曲目不在已核验授权曲库中，禁止公开直播演唱'],
        status: 'blocked_rights',
        requestedAt: ts,
      });
      this.blockedSongLog.push(blocked);
      this.counts.songBlockedCount += 1;
      return blocked;
    }

    const rights = checkLivestreamSongRights(catalogSong.rights);
    if (!rights.allowed) {
      const blocked = LiveSongQueueItemSchema.parse({
        queueId: `sq-${randomUUID().slice(0, 8)}`,
        songId: catalogSong.songId,
        title: catalogSong.title,
        requesterUid: req.requesterUid,
        requesterName: req.requesterName,
        priorityBoost: req.priorityBoost,
        rightsAllowed: false,
        rightsReasons: rights.reasons,
        status: 'blocked_rights',
        requestedAt: ts,
      });
      this.blockedSongLog.push(blocked);
      this.counts.songBlockedCount += 1;
      return blocked;
    }

    const item = LiveSongQueueItemSchema.parse({
      queueId: `sq-${randomUUID().slice(0, 8)}`,
      songId: catalogSong.songId,
      title: catalogSong.title,
      requesterUid: req.requesterUid,
      requesterName: req.requesterName,
      priorityBoost: req.priorityBoost,
      rightsAllowed: true,
      rightsReasons: [],
      status: 'queued',
      requestedAt: ts,
    });
    this.songQueue.push(item);
    this.songQueue.sort((a, b) => b.priorityBoost - a.priorityBoost || a.requestedAt - b.requestedAt);
    this.counts.songAcceptedCount += 1;
    return item;
  }

  popNextAuthorizedSong(): { item: LiveSongQueueItem; song: SongCatalogItem } | null {
    const idx = this.songQueue.findIndex((item) => item.status === 'queued' && item.rightsAllowed);
    if (idx < 0) return null;
    const target = this.songQueue[idx];
    if (!target || !target.songId) return null;
    const song = this.catalog.get(target.songId);
    if (!song) return null;

    const updated: LiveSongQueueItem = { ...target, status: 'performing' };
    this.songQueue[idx] = updated;
    this.activeSongTitle = song.title;
    return { item: updated, song };
  }

  completeCurrentSong(queueId: string): boolean {
    const idx = this.songQueue.findIndex((item) => item.queueId === queueId);
    if (idx < 0) return false;
    const cur = this.songQueue[idx]!;
    this.songQueue[idx] = { ...cur, status: 'completed' };
    if (this.activeSongTitle === cur.title) {
      this.activeSongTitle = null;
    }
    return true;
  }

  /** 合并礼物与关注感谢，避免语音队列爆炸并只保留最小化显示昵称 */
  flushGiftThanks(): LiveGiftThankBatch | null {
    if (this.giftBuffer.length === 0) return null;
    const hasGift = this.giftBuffer.some((entry) => entry.kind === 'gift');
    const kind = hasGift ? 'gift' : 'follow';
    const entries = [...this.giftBuffer];
    if (this.engagement.snapshot(this.now()).config.enabled) {
      entries.sort((a, b) => Number(b.kind === 'gift') - Number(a.kind === 'gift')
        || this.engagement.thanksScore(b.platform, b.uid) - this.engagement.thanksScore(a.platform, a.uid));
    }
    const senders = [...new Set(entries.map((entry) => entry.nickname))];
    const totalValue = this.giftBuffer.reduce((acc, entry) => acc + entry.value, 0);
    const count = this.giftBuffer.reduce((acc, entry) => acc + entry.count, 0);
    this.giftBuffer = [];

    const namesPreview = senders.slice(0, 3).join('、') + (senders.length > 3 ? ` 等 ${senders.length} 位` : '');
    const mergedText = kind === 'gift'
      ? `感谢 ${namesPreview} 送来的礼物支持（合计 ${count} 次）！`
      : `欢迎 ${namesPreview} 新加入关注列表！`;

    const batch: LiveGiftThankBatch = {
      batchId: `gt-${randomUUID().slice(0, 8)}`,
      kind,
      count,
      totalValue,
      senders,
      mergedText,
      createdAt: this.now(),
    };
    this.recentGiftThanks.push(batch);
    if (this.recentGiftThanks.length > 10) this.recentGiftThanks.shift();
    return batch;
  }

  updateStageOverlay(patch: {
    expression?: string;
    sceneId?: string;
    lyrics?: LyricsClockFrame | null;
    activeSongTitle?: string | null;
  }): LiveObsStagePayload {
    if (patch.expression !== undefined) this.expression = patch.expression;
    if (patch.sceneId !== undefined) this.sceneId = patch.sceneId;
    if (patch.lyrics !== undefined) this.lyrics = patch.lyrics;
    if (patch.activeSongTitle !== undefined) this.activeSongTitle = patch.activeSongTitle;
    return this.obsStageSnapshot();
  }

  endSession(reason = 'stream_ended'): LiveSessionSummary | null {
    if (!this.active || !this.sessionId) return null;
    this.flushGiftThanks();
    this.highlights.push(`下播：${reason}`);
    const summary = LiveSessionSummarySchema.parse({
      sessionId: this.sessionId,
      characterId: this.characterId,
      platform: this.adapter.platform,
      roomId: this.adapter.roomId,
      startedAt: this.startedAt,
      endedAt: this.now(),
      ...this.counts,
      highlights: [...this.highlights],
      realPlatformVerified: this.adapter.realPlatformVerified,
    });
    this.summaries.push(summary);
    this.active = false;
    this.sessionId = null;
    this.activeSongTitle = null;
    this.lyrics = null;
    this.adapter = {
      ...this.adapter,
      connectionState: 'idle',
      detail: `已下播：${reason}`,
    };
    return summary;
  }

  emergencyHalt(reason = 'emergency_halt'): LiveRuntimeSnapshot {
    this.halted = true;
    this.songQueue = this.songQueue.map((item) =>
      item.status === 'queued' || item.status === 'performing' ? { ...item, status: 'cancelled' } : item,
    );
    this.activeSongTitle = null;
    this.lyrics = null;
    if (this.active) {
      this.endSession(`急停中断：${reason}`);
    }
    this.adapter = {
      ...this.adapter,
      connectionState: 'disconnected',
      detail: `P0 急停锁定：${reason}`,
    };
    return this.snapshot();
  }

  resumeFromHalt(): LiveRuntimeSnapshot {
    this.halted = false;
    if (this.adapter.connectionState === 'disconnected') {
      this.adapter = {
        ...this.adapter,
        connectionState: 'idle',
        detail: '已解除急停，等待重新开播',
      };
    }
    return this.snapshot();
  }

  listSummaries(): LiveSessionSummary[] {
    return [...this.summaries];
  }

  obsStageSnapshot(): LiveObsStagePayload {
    return LiveObsStagePayloadSchema.parse({
      liveActive: this.active,
      sessionId: this.sessionId,
      characterId: this.characterId,
      platform: this.adapter.platform,
      roomId: this.adapter.roomId,
      connectionState: this.adapter.connectionState,
      sceneId: this.sceneId,
      expression: this.expression,
      activeSongTitle: this.activeSongTitle,
      lyrics: this.lyrics,
      recentDanmaku: [...this.recentDanmaku],
      recentGifts: [...this.recentGiftThanks],
      engagement: this.engagement.snapshot(this.now()),
      moderationAlerts: this.counts.moderationAlerts,
      realPlatformVerified: this.adapter.realPlatformVerified,
    });
  }

  snapshot(): LiveRuntimeSnapshot {
    return LiveRuntimeSnapshotSchema.parse({
      active: this.active,
      sessionId: this.sessionId,
      characterId: this.characterId,
      halted: this.halted,
      adapter: this.adapter,
      songQueue: [...this.songQueue],
      blockedSongLog: [...this.blockedSongLog],
      recentGiftThanks: [...this.recentGiftThanks],
      obsStage: this.obsStageSnapshot(),
      summaryCount: this.summaries.length,
    });
  }

  private findCatalogSong(songId: string | undefined, title: string): SongCatalogItem | undefined {
    if (songId && this.catalog.has(songId)) {
      return this.catalog.get(songId);
    }
    const norm = title.trim().toLowerCase();
    for (const song of this.catalog.values()) {
      if (song.title.trim().toLowerCase() === norm || song.songId.trim().toLowerCase() === norm) {
        return song;
      }
    }
    return undefined;
  }
}
