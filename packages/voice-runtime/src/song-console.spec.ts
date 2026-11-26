/**
 * 点歌台编排内核单测（SPEC §3.4）。
 *
 * 覆盖：四重授权门禁在真实点歌链路生效、违禁黑名单、缓存池命中/不认空记录、
 * 能力缺失如实 unavailable、首切片预缓冲 → 后台补齐 → 拼接落缓存、
 * 任一切片失败不落缓存（不把半成品当成品）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongBlacklistEntry, SongCatalogItemInput, SongConsoleCapability } from '@workbench/shared-protocol';
import { SongConsole, type SongConsolePipelinePort } from './song-console';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'song-console-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function song(overrides: Partial<SongCatalogItemInput> = {}): SongCatalogItemInput {
  return {
    songId: 'song-original-1',
    title: '潮汐与鲸',
    artist: 'Whale Isle',
    durationMs: 60_000,
    rights: {
      songLicense: 'original_owned',
      accompanimentLicense: 'original_owned',
      lyricsLicense: 'original_owned',
      voiceModelAuthorized: true,
      voiceConsentSource: 'whale-isle-original',
    },
    ...overrides,
  };
}

function readyCaps(): SongConsoleCapability[] {
  return [
    { name: 'demucs', ready: true, detail: 'demucs v4 已就绪', hint: '' },
    { name: 'rvc', ready: true, detail: 'rvc 已就绪', hint: '' },
    { name: 'ffmpeg', ready: true, detail: 'ffmpeg 已就绪', hint: '' },
  ];
}

function writeAudio(path: string, bytes = 64): string {
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

interface FakePipelineOptions {
  caps?: SongConsoleCapability[];
  failSliceIndex?: number;
  failFirstSlice?: boolean;
  failConcat?: boolean;
}

function fakePipeline(options: FakePipelineOptions = {}): SongConsolePipelinePort & { renderCalls: number; concatCalls: number } {
  const state = { renderCalls: 0, concatCalls: 0 };
  const port: SongConsolePipelinePort = {
    probeCapabilities: async () => options.caps ?? readyCaps(),
    separate: async ({ outputDir }) => ({
      vocalPath: writeAudio(join(outputDir, 'vocal.wav')),
      accompanimentPath: writeAudio(join(outputDir, 'accomp.wav')),
    }),
    renderSlice: async ({ outputPath }) => {
      const index = state.renderCalls;
      state.renderCalls += 1;
      if (options.failFirstSlice && index === 0) return { audioPath: '', durationMs: 0 };
      if (options.failSliceIndex === index) return { audioPath: '', durationMs: 0 };
      return { audioPath: writeAudio(outputPath), durationMs: 25_000 };
    },
    concat: async ({ outputPath }) => {
      state.concatCalls += 1;
      if (options.failConcat) return { audioPath: '', durationMs: 0 };
      return { audioPath: writeAudio(outputPath), durationMs: 60_000 };
    },
  };
  return {
    ...port,
    // 用 getter 暴露调用计数（Object.assign 会把 getter 求值成快照，故不用它）
    get renderCalls() {
      return state.renderCalls;
    },
    get concatCalls() {
      return state.concatCalls;
    },
  };
}

function memoryCache(seed?: { cacheKey: string; filePath: string; durationMs: number }) {
  const stored: Array<{ cacheKey: string; songTitle: string; filePath: string; durationMs: number }> = [];
  return {
    stored,
    lookup: (cacheKey: string) =>
      seed && seed.cacheKey === cacheKey
        ? { filePath: seed.filePath, durationMs: seed.durationMs }
        : (stored.find((e) => e.cacheKey === cacheKey) ?? null),
    store: (entry: { cacheKey: string; songTitle: string; filePath: string; durationMs: number }) => {
      stored.push(entry);
    },
  };
}

describe('SongConsole 授权门禁（唱功门禁在真实点歌链路生效）', () => {
  it('dev_only_non_commercial 曲目在公开直播渠道被拒绝，且不触碰任何音频处理', async () => {
    const pipeline = fakePipeline();
    const console_ = new SongConsole({ pipeline, cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-1',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      channel: 'livestream_public',
      song: song({
        rights: {
          songLicense: 'dev_only_non_commercial',
          accompanimentLicense: 'original_owned',
          lyricsLicense: 'original_owned',
          voiceModelAuthorized: true,
          voiceConsentSource: 'dev-asset',
        },
      }),
    });
    expect(result.status.state).toBe('rejected');
    expect(result.status.stage).toBe('rejected');
    expect(result.status.rejectionReason).toContain('授权门禁未通过');
    expect(result.status.rejectionReason).toContain('dev_only_non_commercial');
    expect(pipeline.renderCalls).toBe(0);
    expect(result.completion).toBeNull();
  });

  it('未授权角色声线同样被拒绝（四重门禁的第四重）', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-2',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song({
        rights: {
          songLicense: 'original_owned',
          accompanimentLicense: 'original_owned',
          lyricsLicense: 'original_owned',
          voiceModelAuthorized: false,
          voiceConsentSource: 'none',
        },
      }),
    });
    expect(result.status.state).toBe('rejected');
    expect(result.status.rejectionReason).toContain('角色声音模型未经授权');
  });
});

describe('SongConsole 违禁黑名单', () => {
  it('命中黑名单被拒绝并写明原因', async () => {
    const blacklist: SongBlacklistEntry[] = [
      { keyword: '禁播曲', reason: '版权方明确禁止直播翻唱', scope: 'all_channels' },
    ];
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), blacklist, cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-3',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song({ title: '禁播曲（原唱版）' }),
    });
    expect(result.status.state).toBe('rejected');
    expect(result.status.rejectionReason).toContain('违禁曲目黑名单');
    expect(result.status.rejectionReason).toContain('版权方明确禁止直播翻唱');
  });

  it('public_only 条目在私域桌面渠道放行', async () => {
    const blacklist: SongBlacklistEntry[] = [
      { keyword: '仅公开禁播', reason: '公开渠道限制', scope: 'public_only' },
    ];
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), blacklist, cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-4',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      channel: 'private_desktop',
      song: song({ title: '仅公开禁播' }),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    expect(result.status.state).not.toBe('rejected');
  });
});

describe('SongConsole 缓存池', () => {
  it('缓存命中直接秒播，且查询耗时 <50ms（SPEC 指标）', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    // 先跑一次完整管线，拿到真实 cacheKey 与产物
    const first = await console_.request({
      requestId: 'req-5a',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    await first.completion;
    const cacheKey = first.status.cacheKey;
    const finalPath = join(workDir, `${cacheKey}.ogg`);

    const cache = memoryCache({ cacheKey, filePath: finalPath, durationMs: 60_000 });
    const console2 = new SongConsole({ pipeline: fakePipeline(), cache, cacheDir: workDir });
    const hit = await console2.request({
      requestId: 'req-5b',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: join(workDir, 'src.wav'),
    });
    expect(hit.status.cacheHit).toBe(true);
    expect(hit.status.stage).toBe('cache_hit');
    expect(hit.status.state).toBe('streaming');
    expect(hit.status.prebufferPath).toBe(finalPath);
    expect(hit.status.cacheLookupMs).toBeLessThan(50);
    expect(hit.completion).toBeNull();
  });

  it('缓存索引有记录但产物文件不存在 → 不认，继续走真实管线', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    const probe = await console_.request({
      requestId: 'req-6a',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    await probe.completion;
    const cacheKey = probe.status.cacheKey;
    const missingPath = join(workDir, 'gone.ogg');
    const cache = memoryCache({ cacheKey, filePath: missingPath, durationMs: 60_000 });
    const console2 = new SongConsole({ pipeline: fakePipeline(), cache, cacheDir: workDir });
    const result = await console2.request({
      requestId: 'req-6b',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: join(workDir, 'src.wav'),
    });
    expect(result.status.cacheHit).toBe(false);
    expect(result.status.stage).not.toBe('cache_hit');
  });
});

describe('SongConsole 能力缺失如实上报', () => {
  it('Demucs / RVC 未就绪 → unavailable 并逐项列出缺口，绝不产出占位音频', async () => {
    const caps: SongConsoleCapability[] = [
      { name: 'demucs', ready: false, detail: '未安装 torch/demucs', hint: 'uv sync --extra audio' },
      { name: 'rvc', ready: false, detail: '未找到 rvc/xiaojing.pth', hint: '放置 RVC 权重与 .index' },
    ];
    const console_ = new SongConsole({ pipeline: fakePipeline({ caps }), cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-7',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    expect(result.status.state).toBe('unavailable');
    expect(result.status.unavailableReason).toContain('拒绝以占位音频冒充真唱');
    expect(result.status.missingCapabilities).toHaveLength(2);
    expect(result.status.missingCapabilities.join(' ')).toContain('demucs');
    expect(result.status.missingCapabilities.join(' ')).toContain('rvc');
    expect(result.completion).toBeNull();
  });

  it('源音频缺失 → unavailable（不猜路径、不静默降级）', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-8',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
    });
    expect(result.status.state).toBe('unavailable');
    expect(result.status.missingCapabilities.join(' ')).toContain('源音频');
  });
});

describe('SongConsole 边界与状态快照', () => {
  it('sourceAudioPath 指向不存在的文件 → unavailable（不猜路径）', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-e1',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: join(workDir, 'does-not-exist.wav'),
    });
    expect(result.status.state).toBe('unavailable');
    expect(result.status.missingCapabilities.join(' ')).toContain('文件不存在或为空');
  });

  it('sourceAudioPath 是 0 字节空文件 → unavailable（空文件不算素材）', async () => {
    const empty = join(workDir, 'empty.wav');
    writeFileSync(empty, Buffer.alloc(0));
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-e2',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: empty,
    });
    expect(result.status.state).toBe('unavailable');
    expect(result.status.missingCapabilities.join(' ')).toContain('文件不存在或为空');
  });

  it('路径超长导致 stat 抛错时按不可用处理（不崩）', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-e3',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: `${workDir}/${'x'.repeat(5000)}.wav`,
    });
    expect(result.status.state).toBe('unavailable');
  });

  it('snapshot() 返回最近一次状态；未点歌时为 null', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    expect(console_.snapshot()).toBeNull();
    const result = await console_.request({
      requestId: 'req-e4',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
    });
    expect(console_.snapshot()?.requestId).toBe('req-e4');
    expect(console_.snapshot()?.state).toBe(result.status.state);
  });
});

describe('SongConsole 完整管线', () => {
  it('首切片预缓冲 → 后台补齐剩余切片 → 拼接落缓存（60s 歌按 25s 切片 = 3 片）', async () => {
    const pipeline = fakePipeline();
    const cache = memoryCache();
    const statuses: string[] = [];
    const console_ = new SongConsole({
      pipeline,
      cache,
      cacheDir: workDir,
      onStatus: (s) => statuses.push(`${s.state}/${s.stage}`),
    });
    const result = await console_.request({
      requestId: 'req-9',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song({ durationMs: 60_000 }),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    expect(result.status.state).toBe('streaming');
    expect(result.status.stage).toBe('prebuffer_ready');
    expect(result.status.totalSlices).toBe(3);
    expect(result.status.completedSlices).toBe(1);
    expect(result.status.backgroundJobId).toMatch(/^songjob-/);
    expect(result.completion).not.toBeNull();

    const final = await result.completion!;
    expect(final.state).toBe('completed');
    expect(final.stage).toBe('completed');
    expect(final.completedSlices).toBe(3);
    expect(final.finalPath).toContain(result.status.cacheKey);
    expect(pipeline.renderCalls).toBe(3);
    expect(pipeline.concatCalls).toBe(1);
    expect(cache.stored).toHaveLength(1);
    expect(statuses).toContain('streaming/prebuffer_ready');
    expect(statuses).toContain('completing/completing');
    expect(statuses).toContain('completed/completed');
  });

  it('缓存键为 <characterId>_<hash16>（SPEC §3.4 命名）', async () => {
    const console_ = new SongConsole({ pipeline: fakePipeline(), cache: memoryCache(), cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-10',
      characterId: 'blue-whale-maid',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    expect(result.status.cacheKey).toMatch(/^blue-whale-maid_[0-9a-f]{16}$/);
    await result.completion;
  });

  it('首切片渲染失败 → unavailable 且不落缓存', async () => {
    const cache = memoryCache();
    const console_ = new SongConsole({ pipeline: fakePipeline({ failFirstSlice: true }), cache, cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-11',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    expect(result.status.state).toBe('unavailable');
    expect(result.status.missingCapabilities.join(' ')).toContain('render_slice');
    expect(cache.stored).toHaveLength(0);
  });

  it('后台某切片失败 → unavailable，已产出部分保留但不落缓存', async () => {
    const cache = memoryCache();
    const console_ = new SongConsole({
      pipeline: fakePipeline({ failSliceIndex: 2 }),
      cache,
      cacheDir: workDir,
    });
    const result = await console_.request({
      requestId: 'req-12',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song({ durationMs: 60_000 }),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    const final = await result.completion!;
    expect(final.state).toBe('unavailable');
    expect(final.completedSlices).toBe(2);
    expect(cache.stored).toHaveLength(0);
  });

  it('拼接失败 → unavailable 且不落缓存', async () => {
    const cache = memoryCache();
    const console_ = new SongConsole({ pipeline: fakePipeline({ failConcat: true }), cache, cacheDir: workDir });
    const result = await console_.request({
      requestId: 'req-13',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      song: song(),
      sourceAudioPath: writeAudio(join(workDir, 'src.wav')),
    });
    const final = await result.completion!;
    expect(final.state).toBe('unavailable');
    expect(final.missingCapabilities.join(' ')).toContain('concat');
    expect(cache.stored).toHaveLength(0);
  });
});
