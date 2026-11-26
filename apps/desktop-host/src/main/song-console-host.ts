/**
 * 点歌台宿主装配（V2-P3-01 点歌台 · 生产调用路径）。
 *
 * 把三块接起来：
 *  1. `SongConsole` 编排内核（@workbench/voice-runtime）；
 *  2. **真实 Python 客户端**：audio-ai-worker 的 `/api/song/*` 原子能力端点（HTTP）；
 *  3. **SQLite `song_cache_index`**：缓存索引走 `@workbench/local-store`，不自己造内存表。
 *
 * 诚实口径：worker 未启动或能力缺失时，`request()` 会返回 `unavailable` 并逐项列出缺口；
 * 本模块**不会**在缺后端时伪造 Demucs/RVC 处理结果或首切片播放。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SongAudioResultSchema,
  SongBlacklistFileSchema,
  SongCapabilitiesResultSchema,
  SongSeparateResultSchema,
  type SongBlacklistEntry,
  type SongConsoleCapability,
  type SongConsoleStatus,
} from '@workbench/shared-protocol';
import { openSqliteStoreWithRecovery } from '@workbench/local-store';
import {
  SongConsole,
  type SongCachePort,
  type SongConsolePipelinePort,
  type SongConsoleSession,
} from '@workbench/voice-runtime';

/**
 * 首切片播放挂载端口（宿主注入）。
 * 只在 `prebuffer_ready` 且产物真实存在时触发——**无真实后端时永远不会走到这里**。
 * `playFile` 必须在真实播放结束（而非启动）后 resolve，回执才算闭合。
 */
export interface SongPlaybackPort {
  playFile(input: {
    filePath: string;
    durationMs: number;
    requestId: string;
    cacheKey: string;
  }): Promise<{ ok: boolean; reason?: string; playedMs?: number }>;
  stop(): void;
}

export interface SongConsoleHostOptions {
  userDataDir: string;
  /** audio-ai-worker 基址（默认与服务默认端口一致） */
  workerEndpoint?: string;
  /** 产物目录（默认 `<userDataDir>/songs`） */
  cacheDir?: string;
  /** 违禁曲目黑名单（内容侧数据；缺省为空表，不放行任何"猜测"） */
  blacklist?: SongBlacklistEntry[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  onStatus?: (status: SongConsoleStatus) => void;
  /** 首切片就绪后的播放挂载（不给就不播，绝不假装播过） */
  playback?: SongPlaybackPort;
  /** SQLite 数据库路径（默认 `<userDataDir>/workbench.db`，与内核其余域同库） */
  dbPath?: string;
}

/** 播放回执（真实播放结束/失败/取消后写入；未触发播放时为 null） */
export interface SongPlaybackReceipt {
  requestId: string;
  cacheKey: string;
  filePath: string;
  status: 'PLAYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  startedAt: number;
  endedAt?: number;
  playedMs?: number;
  reason?: string;
}

export interface SongConsoleHost {
  request(input: Parameters<SongConsole['request']>[0]): Promise<SongConsoleSession>;
  snapshot(): ReturnType<SongConsole['snapshot']>;
  cancel(requestId: string): { ok: boolean; cancelled: boolean; reason?: string };
  /** 应用退出清理：停止播放、标记当前请求取消（后台补齐不落缓存） */
  shutdown(reason?: string): { cancelledRequestId: string | null };
  capabilities(): Promise<{ ok: boolean; capabilities: SongConsoleCapability[]; error?: string }>;
  /** 最近一次首切片播放挂载结果（未触发时为 null，供验收取证） */
  lastPlayback: () => SongPlaybackReceipt | null;
  /** 播放回执流水（含进行中），供 e2e / 中控台取证 */
  playbackReceipts: () => SongPlaybackReceipt[];
}

interface WorkerCapabilitiesResponse {
  capabilities?: SongConsoleCapability[];
  ready?: boolean;
  missing?: string[];
}

async function readErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown; hint?: unknown };
    const err = typeof parsed.error === 'string' ? parsed.error : text.slice(0, 200);
    const hint = typeof parsed.hint === 'string' && parsed.hint ? `（${parsed.hint}）` : '';
    return `HTTP ${res.status}：${err}${hint}`;
  } catch {
    return `HTTP ${res.status}：${text.slice(0, 200)}`;
  }
}

/** 真实 HTTP 客户端：把 audio-ai-worker 的原子能力端点包成 PipetPort */
export function createHttpSongPipeline(options: {
  workerEndpoint: string;
  fetchImpl?: typeof fetch;
}): SongConsolePipelinePort {
  const base = options.workerEndpoint.replace(/\/+$/u, '');
  const doFetch = options.fetchImpl ?? fetch;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readErrorDetail(res));
    return (await res.json()) as T;
  };
  return {
    async probeCapabilities() {
      try {
        const res = await doFetch(`${base}/api/song/capabilities`);
        if (!res.ok) {
          const detail = await readErrorDetail(res);
          return [
            { name: 'demucs', ready: false, detail: `能力探测失败：${detail}`, hint: '检查 audio-ai-worker 是否在运行' },
            { name: 'rvc', ready: false, detail: `能力探测失败：${detail}`, hint: '检查 audio-ai-worker 是否在运行' },
          ];
        }
        const body = SongCapabilitiesResultSchema.parse(
          (await res.json()) as WorkerCapabilitiesResponse,
        );
        return body.capabilities;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return [
          { name: 'demucs', ready: false, detail: `audio-ai-worker 不可达：${detail}`, hint: '启动 services/audio-ai-worker' },
          { name: 'rvc', ready: false, detail: `audio-ai-worker 不可达：${detail}`, hint: '启动 services/audio-ai-worker' },
        ];
      }
    },
    async separate(input) {
      return SongSeparateResultSchema.parse(
        await post<unknown>('/api/song/separate', {
          sourceAudioPath: input.sourceAudioPath,
          outputDir: input.outputDir,
        }),
      );
    },
    async renderSlice(input) {
      // 声线与全部调参必须真的送到推理端，否则「换了声线」只是换了缓存键而音频没变
      return SongAudioResultSchema.parse(
        await post<unknown>('/api/song/render-slice', {
          vocalPath: input.vocalPath,
          accompanimentPath: input.accompanimentPath,
          startMs: input.startMs,
          durationMs: input.durationMs,
          outputPath: input.outputPath,
          rvcModelPath: input.rvcModelPath,
          rvcIndexPath: input.rvcIndexPath,
          pitchShiftSemitones: input.pitchShiftSemitones,
          indexRate: input.indexRate,
          protectVoiceless: input.protectVoiceless,
          vocalGain: input.vocalGain,
          accompanimentGain: input.accompanimentGain,
        }),
      );
    },
    async concat(input) {
      return SongAudioResultSchema.parse(
        await post<unknown>('/api/song/concat', {
          slicePaths: input.slicePaths,
          outputPath: input.outputPath,
        }),
      );
    },
  };
}

/**
 * SQLite 缓存索引适配：走 `song_cache_index` 表（与内核其余域同库）。
 * `song_cache_index` 不存时长，命中时返回 0 表示「索引未知」，由内核用契约里的歌曲时长兜底；
 * 索引行不等于产物文件存在——内核会再验文件，缺失即视为未命中并重跑，不播空文件。
 */
export function createSqliteSongCache(dbPath: string): SongCachePort {
  return {
    lookup(cacheKey) {
      const opened = openSqliteStoreWithRecovery(dbPath);
      try {
        const hit = opened.store.hitSongCache(cacheKey);
        if (!hit) return null;
        return { filePath: hit.filePath, durationMs: 0 };
      } finally {
        opened.store.close();
      }
    },
    store(entry) {
      const opened = openSqliteStoreWithRecovery(dbPath);
      try {
        opened.store.putSongCache({
          cacheKey: entry.cacheKey,
          songTitle: entry.songTitle,
          filePath: entry.filePath,
        });
      } finally {
        opened.store.close();
      }
    },
  };
}

/**
 * 定位违禁曲目黑名单：打包态取 resources/assets，开发态取仓库根 assets。
 * 依次尝试候选路径，返回第一个真实存在的文件；都不存在返回 null（视为空表，不猜）。
 */
export function resolveSongBlacklistPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  cwd?: string;
}): string | null {
  const name = join('assets', 'song-blacklist.json');
  const candidates = input.isPackaged
    ? [join(input.resourcesPath, name), join(input.repoRoot, name)]
    : [
        join(input.repoRoot, name),
        join(input.cwd ?? process.cwd(), name),
        join(input.cwd ?? process.cwd(), '..', '..', name),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 读黑名单文件；文件不存在视为空表（不猜、不放宽） */
export function loadSongBlacklist(path: string): SongBlacklistEntry[] {
  try {
    return SongBlacklistFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).entries;
  } catch {
    // 文件缺失或格式非法：视为空表（宁可少放行，不猜）
    return [];
  }
}

export function createSongConsoleHost(options: SongConsoleHostOptions): SongConsoleHost {
  const pipeline = createHttpSongPipeline({
    workerEndpoint: options.workerEndpoint ?? 'http://127.0.0.1:18770',
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const cache = createSqliteSongCache(options.dbPath ?? join(options.userDataDir, 'workbench.db'));
  const now = options.now ?? (() => Date.now());
  const receipts: SongPlaybackReceipt[] = [];
  let playing: { receipt: SongPlaybackReceipt; requestId: string } | null = null;
  const last = (): SongPlaybackReceipt | null => receipts.at(-1) ?? null;

  const record = (
    status: SongPlaybackReceipt['status'],
    input: { requestId: string; cacheKey: string; filePath: string; startedAt: number },
    extra: { playedMs?: number; reason?: string } = {},
  ): SongPlaybackReceipt => {
    const receipt: SongPlaybackReceipt = {
      requestId: input.requestId,
      cacheKey: input.cacheKey,
      filePath: input.filePath,
      status,
      startedAt: input.startedAt,
      endedAt: now(),
      ...(extra.playedMs === undefined ? {} : { playedMs: extra.playedMs }),
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    };
    receipts.push(receipt);
    if (receipts.length > 32) receipts.shift();
    return receipt;
  };

  const handleStatus = (status: SongConsoleStatus): void => {
    // 首切片就绪 / 整曲命中缓存 → 接到真实播放挂载（失败如实记录，不吞）
    const playable = status.prebufferPath;
    const isPlayableStage = status.stage === 'prebuffer_ready' || status.stage === 'cache_hit';
    if (playable && isPlayableStage && options.playback) {
      // 单声道播放：上一首还在播就先停，避免两首叠在一起冒充「在唱」
      if (playing) options.playback.stop();
      const input = {
        requestId: status.requestId,
        cacheKey: status.cacheKey,
        filePath: playable,
        startedAt: now(),
      };
      playing = { receipt: record('PLAYING', input), requestId: status.requestId };
      void options.playback
        .playFile({
          filePath: playable,
          durationMs: status.prebufferDurationMs ?? 0,
          requestId: status.requestId,
          cacheKey: status.cacheKey,
        })
        .then((res) => {
          record(res.ok ? 'COMPLETED' : 'FAILED', input, {
            ...(res.playedMs === undefined ? {} : { playedMs: res.playedMs }),
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          });
        })
        .catch((err: unknown) => {
          record('FAILED', input, { reason: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          if (playing?.requestId === status.requestId) playing = null;
        });
    }
    // 取消 / 拒播 / 缺能力：停掉在播音频（不留下「状态已取消但还在响」）
    if (['cancelled', 'rejected', 'unavailable'].includes(status.state)) {
      if (playing?.requestId === status.requestId) {
        options.playback?.stop();
        const receipt = playing.receipt;
        record('CANCELLED', receipt, { reason: `点歌进入终态：${status.state}` });
        playing = null;
      }
    }
    options.onStatus?.(status);
  };
  const songConsole = new SongConsole({
    pipeline,
    cache,
    ...(options.blacklist ? { blacklist: options.blacklist } : {}),
    cacheDir: options.cacheDir ?? join(options.userDataDir, 'songs'),
    ...(options.now ? { now: options.now } : {}),
    onStatus: handleStatus,
  });
  return {
    request: (input) => songConsole.request(input),
    snapshot: () => songConsole.snapshot(),
    cancel: (requestId) => songConsole.cancel(requestId),
    lastPlayback: last,
    playbackReceipts: () => [...receipts],
    shutdown(reason = 'app_quit') {
      const active = songConsole.snapshot();
      const cancellable =
        active !== null && !['completed', 'rejected', 'unavailable', 'cancelled', 'idle'].includes(active.state);
      if (playing) {
        options.playback?.stop();
        record('CANCELLED', playing.receipt, { reason });
        playing = null;
      }
      if (cancellable) {
        songConsole.cancel(active.requestId);
        return { cancelledRequestId: active.requestId };
      }
      return { cancelledRequestId: null };
    },
    async capabilities() {
      try {
        const caps = await pipeline.probeCapabilities();
        const missing = caps.filter((c) => !c.ready).map((c) => c.name);
        return missing.length === 0
          ? { ok: true, capabilities: caps }
          : { ok: false, capabilities: caps, error: `能力未就绪：${missing.join('、')}` };
      } catch (err) {
        return {
          ok: false,
          capabilities: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
