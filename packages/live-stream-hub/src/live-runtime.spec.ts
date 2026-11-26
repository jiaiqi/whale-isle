import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkLivestreamSongRights, LiveRuntimeV2, probeLivePlatformEndpoint } from './live-runtime';

function makeSong(overrides?: Partial<{
  songId: string;
  title: string;
  songLicense: 'original_owned' | 'licensed_livestream' | 'licensed_commercial' | 'dev_only_non_commercial' | 'unlicensed';
  accompanimentLicense: 'original_owned' | 'licensed_livestream' | 'licensed_commercial' | 'dev_only_non_commercial' | 'unlicensed';
  lyricsLicense: 'original_owned' | 'licensed_livestream' | 'licensed_commercial' | 'dev_only_non_commercial' | 'unlicensed';
  voiceModelAuthorized: boolean;
}>) {
  return {
    songId: overrides?.songId ?? 'song-original',
    title: overrides?.title ?? '鲸屿晨雾',
    durationMs: 6000,
    rights: {
      songLicense: overrides?.songLicense ?? 'original_owned',
      accompanimentLicense: overrides?.accompanimentLicense ?? 'original_owned',
      lyricsLicense: overrides?.lyricsLicense ?? 'original_owned',
      voiceModelAuthorized: overrides?.voiceModelAuthorized ?? true,
      voiceConsentSource: 'whale-isle-original',
      attribution: 'Whale Isle',
    },
  };
}

describe('[SIMULATION] V2-P3-02 LiveRuntimeV2 直播中控、版权门禁与 OBS 舞台投影', () => {
  it('严格校验公开直播曲库版权与声音授权，禁止 NC/unlicensed 进入公开直播', () => {
    expect(checkLivestreamSongRights(makeSong().rights).allowed).toBe(true);
    expect(checkLivestreamSongRights(makeSong({ songLicense: 'licensed_livestream', accompanimentLicense: 'licensed_commercial' }).rights).allowed).toBe(true);

    const denied = checkLivestreamSongRights(makeSong({
      songLicense: 'dev_only_non_commercial',
      accompanimentLicense: 'unlicensed',
      lyricsLicense: 'dev_only_non_commercial',
      voiceModelAuthorized: false,
    }).rights);
    expect(denied.allowed).toBe(false);
    expect(denied.reasons.length).toBe(4);
  });

  it('平台端点探测诚实报告连接态（local_replay / HTTP 200 / HTTP 503 / 断网 / 缺端点），绝不虚构在线', async () => {
    const local = await probeLivePlatformEndpoint({ platform: 'local_replay', roomId: 'sim-1' });
    expect(local.connectionState).toBe('connected');
    expect(local.apiMode).toBe('local_replay');
    expect(local.realPlatformVerified).toBe(false);

    const noEndpoint = await probeLivePlatformEndpoint({ platform: 'douyin_dyhub', roomId: 'r-1' });
    expect(noEndpoint.connectionState).toBe('degraded');

    const mockFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('bad', { status: 503 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const okRes = await probeLivePlatformEndpoint({ platform: 'bilibili_open', roomId: 'r-2', endpoint: 'http://127.0.0.1:19991/', fetchImpl: mockFetch });
    expect(okRes.connectionState).toBe('connected');
    expect(okRes.apiMode).toBe('official_open_api');

    const errRes = await probeLivePlatformEndpoint({ platform: 'youtube_live', roomId: 'r-3', endpoint: 'http://127.0.0.1:19991', fetchImpl: mockFetch });
    expect(errRes.connectionState).toBe('degraded');
    expect(errRes.detail).toContain('HTTP 503');

    const throwRes = await probeLivePlatformEndpoint({ platform: 'douyin_dyhub', roomId: 'r-4', endpoint: 'http://127.0.0.1:19991', fetchImpl: mockFetch });
    expect(throwRes.connectionState).toBe('degraded');
    expect(throwRes.detail).toContain('ECONNREFUSED');
  });

  it('完整统筹开播、弹幕过滤去重、礼物合并感谢、点歌授权排麦、断连恢复与下播总结', async () => {
    let clockMs = 1_000_000;
    const runtime = new LiveRuntimeV2({
      characterId: 'char_xiaojing',
      giftBatchThreshold: 2,
      now: () => (clockMs += 100),
    });
    runtime.registerCatalogSong(makeSong({ songId: 's-tide', title: '鲸屿晨雾' }));
    runtime.registerCatalogSong(makeSong({ songId: 's-vip', title: '深海星愿', songLicense: 'licensed_livestream' }));
    runtime.registerCatalogSong(makeSong({ songId: 's-nc', title: '大肥鱼非商用', songLicense: 'dev_only_non_commercial' }));
    expect(runtime.listCatalogSongs()).toHaveLength(3);

    expect(runtime.endSession('not_started')).toBeNull();
    expect(runtime.resumeFromHalt().halted).toBe(false);
    expect(runtime.popNextAuthorizedSong()).toBeNull();

    const started = await runtime.startSession({ platform: 'local_replay', roomId: 'room-01', sceneId: 'obs-custom' });
    expect(started.ok).toBe(true);
    expect(started.snapshot.active).toBe(true);

    // 1. 弹幕与 Guard 拦截 + 去重 + 掩码 + VOTE_CHOICE 其他事件 + 超过 20 条上限裁剪
    const danmakuId = randomUUID();
    const okDanmaku = runtime.ingestEvent({
      eventId: danmakuId,
      platform: 'douyin',
      eventType: 'DANMAKU',
      sender: { uid: 'u-1', nickname: '阿明', intimacyScore: 10, grudgeTags: [] },
      payload: { rawText: 'fuck 你这个', mergedCount: 1 },
      assignedPriority: 'P1_CADENCE',
      timestamp: clockMs,
    });
    expect(okDanmaku.outcome.status).toBe('accepted');

    for (let i = 0; i < 21; i++) {
      runtime.ingestEvent({
        eventId: randomUUID(),
        platform: 'douyin',
        eventType: 'DANMAKU',
        sender: { uid: `u-bulk-${i}`, nickname: `观众${i}`, intimacyScore: 0, grudgeTags: [] },
        payload: { rawText: `弹幕 ${i}`, mergedCount: 1 },
        assignedPriority: 'P2_IDLE',
        timestamp: clockMs,
      });
    }
    expect(runtime.obsStageSnapshot().recentDanmaku).toHaveLength(20);

    // VOTE_CHOICE 分支覆盖
    expect(runtime.ingestEvent({
      eventId: randomUUID(),
      platform: 'douyin',
      eventType: 'VOTE_CHOICE',
      sender: { uid: 'u-vote', nickname: '投票者', intimacyScore: 1, grudgeTags: [] },
      payload: { mergedCount: 1 },
      assignedPriority: 'P2_IDLE',
      timestamp: clockMs,
    }).outcome.status).toBe('accepted');

    // 重复 ID 识别
    expect(runtime.ingestEvent({
      eventId: danmakuId,
      platform: 'douyin',
      eventType: 'DANMAKU',
      sender: { uid: 'u-1', nickname: '阿明', intimacyScore: 10, grudgeTags: [] },
      payload: { rawText: '重复消息', mergedCount: 1 },
      assignedPriority: 'P1_CADENCE',
      timestamp: clockMs,
    }).outcome.status).toBe('duplicate');

    // 非法格式拒收 + 广告词护栏丢弃
    expect(runtime.ingestEvent({ broken: true }).outcome.status).toBe('rejected');
    expect(runtime.ingestEvent({
      eventId: randomUUID(),
      platform: 'douyin',
      eventType: 'DANMAKU',
      sender: { uid: 'u-spam', nickname: '广告号', intimacyScore: 0, grudgeTags: [] },
      payload: { rawText: '加微信领福利', mergedCount: 1 },
      assignedPriority: 'P2_IDLE',
      timestamp: clockMs,
    }).outcome.status).toBe('dropped');

    // 2. 礼物与进场/点赞达阈值（2 条）自动合并感谢 + 4 人以上省略提示
    const gift1 = runtime.ingestEvent({
      eventId: randomUUID(),
      platform: 'douyin',
      eventType: 'GIFT',
      sender: { uid: 'u-g1', nickname: '小红', intimacyScore: 5, grudgeTags: [] },
      payload: { giftName: '小心心', giftDiamondValue: 10, mergedCount: 1 },
      assignedPriority: 'P1_CADENCE',
      timestamp: clockMs,
    });
    expect(gift1.flushedBatch).toBeUndefined();
    const gift2 = runtime.ingestEvent({
      eventId: randomUUID(),
      platform: 'douyin',
      eventType: 'ENTER_ROOM',
      sender: { uid: 'u-f1', nickname: '小蓝', intimacyScore: 1, grudgeTags: [] },
      payload: { mergedCount: 1 },
      assignedPriority: 'P2_IDLE',
      timestamp: clockMs,
    });
    expect(gift2.flushedBatch?.count).toBe(2);
    expect(gift2.flushedBatch?.kind).toBe('gift');

    // 纯进场/点赞 flush + 多于 3 位观众合并摘要 + 超过 10 条 recentGiftThanks 上限裁剪
    expect(runtime.flushGiftThanks()).toBeNull();
    const multiRuntime = new LiveRuntimeV2({ characterId: 'char_xiaojing', giftBatchThreshold: 1 });
    await multiRuntime.startSession({ platform: 'local_replay', roomId: 'multi' });
    for (let g = 0; g < 11; g++) {
      multiRuntime.ingestEvent({
        eventId: randomUUID(),
        platform: 'douyin',
        eventType: 'LIKE',
        sender: { uid: `mf-${g}`, nickname: `粉${g}`, intimacyScore: 1, grudgeTags: [] },
        payload: { mergedCount: 1 },
        assignedPriority: 'P2_IDLE',
        timestamp: clockMs,
      });
    }
    expect(multiRuntime.obsStageSnapshot().recentGifts).toHaveLength(10);

    const fourPeopleRuntime = new LiveRuntimeV2({ characterId: 'char_xiaojing', giftBatchThreshold: 10 });
    await fourPeopleRuntime.startSession({ platform: 'local_replay', roomId: 'four' });
    for (let i = 0; i < 4; i++) {
      fourPeopleRuntime.ingestEvent({
        eventId: randomUUID(),
        platform: 'douyin',
        eventType: 'LIKE',
        sender: { uid: `mf4-${i}`, nickname: `四位${i}`, intimacyScore: 1, grudgeTags: [] },
        payload: { mergedCount: 1 },
        assignedPriority: 'P2_IDLE',
        timestamp: clockMs,
      });
    }
    const multiBatch = fourPeopleRuntime.flushGiftThanks();
    expect(multiBatch?.kind).toBe('follow');
    expect(multiBatch?.mergedText).toContain('等 4 位');

    // 3. 点歌版权门禁（含空点歌名、SONG_REQUEST 含礼物加权）+ 优先级队列
    const emptySongReq = runtime.ingestEvent({
      eventId: randomUUID(),
      platform: 'douyin',
      eventType: 'SONG_REQUEST',
      sender: { uid: 'u-empty', nickname: '空点歌', intimacyScore: 0, grudgeTags: [] },
      payload: { mergedCount: 1 },
      assignedPriority: 'P2_IDLE',
      timestamp: clockMs,
    });
    expect(emptySongReq.songItem?.title).toBe('未命名点歌');
    expect(emptySongReq.songItem?.status).toBe('blocked_rights');

    const blockedUnknown = runtime.requestSong({ title: '未知版权歌曲', requesterUid: 'u1', requesterName: '路人' });
    expect(blockedUnknown.status).toBe('blocked_rights');

    const blockedNc = runtime.ingestEvent({
      eventId: randomUUID(),
      platform: 'douyin',
      eventType: 'SONG_REQUEST',
      sender: { uid: 'u-nc', nickname: '小王', intimacyScore: 0, grudgeTags: [] },
      payload: { songTitle: '大肥鱼非商用', giftDiamondValue: 20, mergedCount: 1 },
      assignedPriority: 'P1_CADENCE',
      timestamp: clockMs,
    });
    expect(blockedNc.songItem?.status).toBe('blocked_rights');

    const normalReq = runtime.requestSong({ songId: 's-tide', title: '鲸屿晨雾', requesterUid: 'u1', requesterName: '阿明', priorityBoost: 0 });
    const vipReq = runtime.requestSong({ title: '深海星愿', requesterUid: 'u2', requesterName: '金主', priorityBoost: 50 });
    expect(normalReq.status).toBe('queued');
    expect(vipReq.status).toBe('queued');

    const popped = runtime.popNextAuthorizedSong();
    expect(popped?.song.songId).toBe('s-vip');
    expect(runtime.completeCurrentSong(popped!.item.queueId)).toBe(true);
    expect(runtime.completeCurrentSong('missing')).toBe(false);

    // 4. OBS 舞台叠加层投影与断连/重连恢复
    runtime.updateStageOverlay({});
    const overlay = runtime.updateStageOverlay({ expression: 'singing', sceneId: 'obs-concert', activeSongTitle: '鲸屿晨雾', lyrics: null });
    expect(overlay.recentDanmaku).toHaveLength(20);
    expect(overlay.moderationAlerts).toBe(1);

    const disc = runtime.markDisconnected('ws_timeout');
    expect(disc.adapter.connectionState).toBe('degraded');
    const rec = runtime.markReconnected();
    expect(rec.adapter.connectionState).toBe('connected');
    expect(rec.adapter.reconnectAttempts).toBe(1);

    // 5. 下播生成可查询摘要 & 未开播状态下急停仍保留已完成歌曲状态
    const summary = runtime.endSession();
    expect(summary).toMatchObject({
      danmakuCount: 22,
      giftCount: 1,
      followCount: 1,
      songAcceptedCount: 2,
      songBlockedCount: 3,
      moderationAlerts: 1,
      disconnectCount: 1,
      realPlatformVerified: false,
    });
    expect(runtime.listSummaries()).toHaveLength(1);
    const offlineHalt = runtime.emergencyHalt();
    expect(offlineHalt.songQueue[0]?.status).toBe('completed');
    runtime.resumeFromHalt();

    // 6. 急停锁定与恢复
    await runtime.startSession({ platform: 'local_replay', roomId: 'room-02' });
    runtime.requestSong({ songId: 's-tide', title: '鲸屿晨雾', requesterUid: 'u1', requesterName: '阿明' });
    const halted = runtime.emergencyHalt('test_halt');
    expect(halted.halted).toBe(true);
    expect(halted.active).toBe(false);
    expect(halted.songQueue[0]?.status).toBe('cancelled');
    expect((await runtime.startSession()).ok).toBe(false);
    expect(runtime.resumeFromHalt().halted).toBe(false);
  });
});
