/**
 * 点歌台宿主装配单测（生产调用路径：SongConsole 内核 + HTTP worker 客户端 + SQLite 缓存索引 + 播放挂载）。
 *
 * 诚实口径断言：
 *  - worker 缺失/501 → `unavailable` 且逐项列缺口，不产出占位音频、不落缓存；
 *  - 缓存索引有行但文件不在 → 视为未命中并重跑，绝不播放不存在的文件；
 *  - 首切片就绪才触发播放，播放回执必须记录真实结束状态；
 *  - 取消与退出清理会停播、标记 cancelled，且不落缓存。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { SongConsoleRequestInput } from '@workbench/shared-protocol';
import {
  createSongConsoleHost,
  createSqliteSongCache,
  loadSongBlacklist,
  resolveSongBlacklistPath,
  type SongPlaybackPort,
} from './song-console-host';

let dir: string;
let dbPath: string;
let sourcePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'song-host-'));
  dbPath = join(dir, 'workbench.db');
  sourcePath = join(dir, 'source.wav');
  writeFileSync(sourcePath, 'RIFF0000WAVE');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function request(overrides: Partial<SongConsoleRequestInput> = {}): SongConsoleRequestInput {
  return {
    requestId: 'req-1',
    characterId: 'blue-whale-maid',
    voiceProfileId: 'voice-xiaojing',
    song: {
      songId: 'song-1',
      title: '晴天',
      artist: '周杰伦',
      durationMs: 60_000,
      rights: {
        songLicense: 'original_owned',
        accompanimentLicense: 'original_owned',
        lyricsLicense: 'original_owned',
        voiceModelAuthorized: true,
        voiceConsentSource: 'owner_self_recorded',
      },
    },
    sourceAudioPath: sourcePath,
    ...overrides,
  } as SongConsoleRequestInput;
}

/** worker 替身：可编程路由；记录收到的请求体 */
function worker(options: {
  capabilities?: Array<{ name: string; ready: boolean; detail: string; hint?: string }>;
  unavailable?: string[];
  fail?: 'separate' | 'render';
  onRender?: () => Promise<void> | void;
}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const outputDirOf = (body: Record<string, unknown>, suffix: string): string => {
    const target = String(body.outputPath ?? '');
    if (target) {
      writeFileSync(target, `OGG-${suffix}`);
      return target;
    }
    const outDir = String(body.outputDir ?? dir);
    const vocal = join(outDir, 'vocals.wav');
    const acc = join(outDir, 'no_vocals.wav');
    writeFileSync(vocal, 'WAV-vocal');
    writeFileSync(acc, 'WAV-acc');
    return '';
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path: new URL(url).pathname, body });
    const json = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/song/capabilities')) {
      const caps = options.capabilities ?? [
        { name: 'demucs', ready: true, detail: 'demucs 可执行' },
        { name: 'rvc', ready: true, detail: 'rvc 就绪' },
        { name: 'ffmpeg', ready: true, detail: 'ffmpeg 可执行' },
        { name: 'rmvpe', ready: true, detail: 'RMVPE 索引就绪' },
      ];
      const missing = caps.filter((c) => !c.ready).map((c) => c.name);
      return json({ capabilities: caps, ready: missing.length === 0, missing });
    }
    if (url.endsWith('/api/song/separate')) {
      if (options.fail === 'separate') {
        return json({ error: '未找到 demucs（demucs）', hint: '安装 demucs v4', capability: 'demucs' }, 501);
      }
      const outDir = String(body.outputDir ?? dir);
      mkdirSync(outDir, { recursive: true });
      const vocal = join(outDir, 'vocals.wav');
      const acc = join(outDir, 'no_vocals.wav');
      writeFileSync(vocal, 'WAV-vocal');
      writeFileSync(acc, 'WAV-acc');
      return json({ vocalPath: vocal, accompanimentPath: acc });
    }
    if (url.endsWith('/api/song/render-slice')) {
      await options.onRender?.();
      if (options.fail === 'render') {
        return json({ error: 'RVC 声线转换失败：退出码 1', capability: 'rvc' }, 502);
      }
      mkdirSync(String(body.outputPath).replace(/\/[^/]+$/u, ''), { recursive: true });
      outputDirOf(body, String(body.startMs));
      return json({ audioPath: String(body.outputPath), durationMs: Number(body.durationMs) });
    }
    if (url.endsWith('/api/song/concat')) {
      const target = String(body.outputPath);
      mkdirSync(target.replace(/\/[^/]+$/u, ''), { recursive: true });
      writeFileSync(target, 'OGG-final');
      return json({ audioPath: target, durationMs: 60_000 });
    }
    return json({ error: 'not found' }, 404);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function playbackStub() {
  const played: string[] = [];
  let stopCalls = 0;
  const port: SongPlaybackPort = {
    playFile: async ({ filePath }) => {
      played.push(filePath);
      return { ok: true, playedMs: 1_000 };
    },
    stop: () => {
      stopCalls += 1;
    },
  };
  return { port, played, stopCalls: () => stopCalls };
}

/** 直查 song_cache_index（生产 store 无列表 API，测试不自造生产接口） */
function cacheRows(): Array<{ cache_key: string; file_path: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT cache_key, file_path FROM song_cache_index').all() as Array<{
      cache_key: string;
      file_path: string;
    }>;
  } finally {
    db.close();
  }
}

describe('点歌台宿主：能力与请求转发', () => {
  it('worker 部分能力缺失时如实逐项上报', async () => {
    const w = worker({
      capabilities: [
        { name: 'demucs', ready: true, detail: 'demucs 可执行' },
        { name: 'rvc', ready: false, detail: '未配置 RVC 声线模型权重', hint: '提供 .pth' },
      ],
    });
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl });
    const caps = await host.capabilities();
    expect(caps.ok).toBe(false);
    expect(caps.error).toContain('rvc');
    expect(caps.capabilities.find((c) => c.name === 'rvc')?.hint).toBe('提供 .pth');
  });

  it('worker 不可达时报 unavailable 且不留假能力', async () => {
    const host = createSongConsoleHost({
      userDataDir: dir,
      dbPath,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const caps = await host.capabilities();
    expect(caps.ok).toBe(false);
    expect(caps.capabilities.every((c) => !c.ready)).toBe(true);
    expect(caps.capabilities[0]?.detail).toContain('不可达');
  });

  it('声线模型与全部调参真的送到推理端（不是只换缓存键）', async () => {
    const w = worker({});
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl });
    const session = await host.request(
      request({
        requestId: 'req-tuning',
        rvcModelPath: '/models/xiaojing.pth',
        rvcIndexPath: '/models/xiaojing.index',
        pitchShiftSemitones: 3,
        indexRate: 0.62,
        protectVoiceless: 0.21,
        vocalGain: 1.2,
        accompanimentGain: 0.6,
      }),
    );
    expect(session.status.stage).toBe('prebuffer_ready');
    const render = w.calls.find((c) => c.path === '/api/song/render-slice');
    expect(render?.body).toMatchObject({
      rvcModelPath: '/models/xiaojing.pth',
      rvcIndexPath: '/models/xiaojing.index',
      pitchShiftSemitones: 3,
      indexRate: 0.62,
      protectVoiceless: 0.21,
      vocalGain: 1.2,
      accompanimentGain: 0.6,
    });
    await session.completion;
  });

  it('门禁不通过时零音频调用', async () => {
    const w = worker({});
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl });
    const session = await host.request(
      request({
        song: {
          songId: 'song-2',
          title: '未授权曲目',
          artist: '某歌手',
          durationMs: 30_000,
          rights: {
            songLicense: 'unlicensed',
            accompanimentLicense: 'original_owned',
            lyricsLicense: 'original_owned',
            voiceModelAuthorized: true,
            voiceConsentSource: 'owner_self_recorded',
          },
        },
      }),
    );
    expect(session.status.state).toBe('rejected');
    expect(w.calls).toHaveLength(0);
  });
});

describe('点歌台宿主：缓存索引与失败不落缓存', () => {
  it('索引有行但文件不存在 → 视为未命中并重跑管线', async () => {
    const w = worker({});
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl });
    const first = await host.request(request({ requestId: 'req-cache' }));
    await first.completion;
    const rows = cacheRows();
    expect(rows).toHaveLength(1);
    // 人为删掉产物，模拟「索引与文件不一致」
    rmSync(rows[0]!.file_path, { force: true });

    const second = await host.request(request({ requestId: 'req-cache-2' }));
    expect(second.status.cacheHit).toBe(false);
    expect(w.calls.filter((c) => c.path === '/api/song/separate')).toHaveLength(2);
    await second.completion;
  });

  it('缓存命中直接秒播、不再分离，并触发真实播放挂载', async () => {
    const w = worker({});
    const pb = playbackStub();
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl, playback: pb.port });
    const first = await host.request(request({ requestId: 'req-warm' }));
    await first.completion;
    expect(cacheRows()).toHaveLength(1);

    const hit = await host.request(request({ requestId: 'req-hit' }));
    expect(hit.status.cacheHit).toBe(true);
    expect(hit.status.stage).toBe('cache_hit');
    expect(w.calls.filter((c) => c.path === '/api/song/separate')).toHaveLength(1);
    // 首切片一次（预热）+ 缓存命中一次；命中那次不再产生新的分离/渲染调用
    expect(pb.played).toHaveLength(2);
    expect(pb.played.at(-1)).toBe(hit.status.prebufferPath);
    await vi.waitFor(() => expect(host.lastPlayback()?.status).toBe('COMPLETED'));
    expect(host.lastPlayback()?.cacheKey).toBe(hit.status.cacheKey);
  });

  it('分离 501 → unavailable 逐项缺口且不落缓存', async () => {
    const w = worker({ fail: 'separate' });
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl });
    const session = await host.request(request({ requestId: 'req-501' }));
    expect(session.status.state).toBe('unavailable');
    expect(session.status.missingCapabilities.join()).toContain('demucs');
    expect(session.status.unavailableReason).toContain('未找到 demucs');
    expect(cacheRows()).toHaveLength(0);
  });

  it('首切片渲染失败 → unavailable 且不播、不落缓存', async () => {
    const w = worker({ fail: 'render' });
    const pb = playbackStub();
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl, playback: pb.port });
    const session = await host.request(request({ requestId: 'req-render-502' }));
    expect(session.status.state).toBe('unavailable');
    expect(pb.played).toHaveLength(0);
    expect(cacheRows()).toHaveLength(0);
  });
});

describe('点歌台宿主：取消与退出清理', () => {
  it('后台补齐中途取消 → 停播、状态 cancelled、不落缓存', async () => {
    const gateRef: { release: () => void } = { release: () => {} };
    const gate = new Promise<void>((resolve) => {
      gateRef.release = resolve;
    });
    let renderCalls = 0;
    const w = worker({
      onRender: async () => {
        renderCalls += 1;
        // 首切片立即返回，后续切片挂起，留出取消窗口
        if (renderCalls > 1) await gate;
      },
    });
    const pb = playbackStub();
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl, playback: pb.port });
    const session = await host.request(request({ requestId: 'req-cancel' }));
    expect(session.status.stage).toBe('prebuffer_ready');
    await vi.waitFor(() => expect(renderCalls).toBeGreaterThan(1));
    const cancelled = host.cancel('req-cancel');
    expect(cancelled).toEqual({ ok: true, cancelled: true });
    expect(pb.stopCalls()).toBeGreaterThan(0);
    // 在飞的渲染不会被网络层强杀：放行后由后台循环下一轮检查取消标记并收敛
    gateRef.release();
    const final = await session.completion;
    expect(final?.state).toBe('cancelled');
    expect(cacheRows()).toHaveLength(0);
  });

  it('shutdown 清理在播音频并取消进行中的请求', async () => {
    const gateRef: { release: () => void } = { release: () => {} };
    const gate = new Promise<void>((resolve) => {
      gateRef.release = resolve;
    });
    let renderCalls = 0;
    const w = worker({
      onRender: async () => {
        renderCalls += 1;
        if (renderCalls > 1) await gate;
      },
    });
    const pb = playbackStub();
    const host = createSongConsoleHost({ userDataDir: dir, dbPath, fetchImpl: w.fetchImpl, playback: pb.port });
    const session = await host.request(request({ requestId: 'req-quit' }));
    await vi.waitFor(() => expect(renderCalls).toBeGreaterThan(1));
    const result = host.shutdown('app_quit');
    expect(result.cancelledRequestId).toBe('req-quit');
    expect(pb.stopCalls()).toBeGreaterThan(0);
    expect(host.playbackReceipts().at(-1)?.status).toBe('CANCELLED');
    gateRef.release();
    const final = await session.completion;
    expect(final?.state).toBe('cancelled');
    expect(cacheRows()).toHaveLength(0);
  });

  it('没有进行中的请求时 shutdown 不误伤', () => {
    const host = createSongConsoleHost({ userDataDir: dir, dbPath });
    expect(host.shutdown()).toEqual({ cancelledRequestId: null });
  });
});

describe('点歌台宿主：SQLite 缓存适配与黑名单', () => {
  it('缓存适配写入后可读回，未知键返回 null', () => {
    const cache = createSqliteSongCache(dbPath);
    expect(cache.lookup('missing')).toBeNull();
    const file = join(dir, 'x.ogg');
    writeFileSync(file, 'OGG');
    cache.store({ cacheKey: 'k1', songTitle: '晴天', filePath: file, durationMs: 60_000 });
    expect(cache.lookup('k1')?.filePath).toBe(file);
    // 索引不存时长 → 返回 0 由内核用契约时长兜底，不编造
    expect(cache.lookup('k1')?.durationMs).toBe(0);
  });

  it('黑名单文件缺失/损坏一律视为空表，不猜', () => {
    expect(loadSongBlacklist(join(dir, 'nope.json'))).toEqual([]);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(loadSongBlacklist(bad)).toEqual([]);
  });

  it('黑名单路径解析：开发态按候选依次命中，打包态取 resources', () => {
    const repoRoot = join(process.cwd());
    expect(resolveSongBlacklistPath({ isPackaged: false, resourcesPath: '', repoRoot })).toBe(
      join(repoRoot, 'assets', 'song-blacklist.json'),
    );
    expect(resolveSongBlacklistPath({ isPackaged: false, resourcesPath: '', repoRoot: dir, cwd: repoRoot })).toBe(
      join(repoRoot, 'assets', 'song-blacklist.json'),
    );
    // 全都不存在 → null（不猜路径）
    expect(resolveSongBlacklistPath({ isPackaged: false, resourcesPath: '', repoRoot: dir, cwd: dir })).toBeNull();
  });

  it('仓库内置黑名单可被契约解析', () => {
    const entries = loadSongBlacklist(join(process.cwd(), 'assets', 'song-blacklist.json'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.reason.length > 0)).toBe(true);
  });
});
