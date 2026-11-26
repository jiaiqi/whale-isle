/**
 * 点歌台（Streaming SVC 点歌台）编排内核 —— SPEC §3.4。
 *
 * 分工：
 *  - 本模块负责**编排**：四重授权门禁 → 违禁黑名单 → 缓存池 → 分离/切片/转换/混音 → 首切片预缓冲 → 后台补齐。
 *  - 重推理（Demucs / RVC / RMVPE）由 `SongConsolePipelinePort` 注入（Python audio-ai-worker 的原子能力端点），
 *    本模块不自己跑 torch，也不假装跑过。
 *
 * 诚实铁律（AGENTS.md §2.2）：
 *  - 任一原子能力缺失或源音频缺失 → 状态直接 `unavailable` 并逐项列出缺口，**绝不产出占位音频冒充真唱**；
 *  - 授权门禁不通过 → `rejected`，且不进入任何音频处理；
 *  - 缓存命中只认**真实存在且非空**的产物文件，不认索引里的一行记录。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import {
  SongConsoleRequestSchema,
  SongConsoleStatusSchema,
  type SongBlacklistEntry,
  type SongConsoleCapability,
  type SongConsoleRequest,
  type SongConsoleRequestInput,
  type SongConsoleStage,
  type SongConsoleStatus,
  type SongConsoleStatusInput,
} from '@workbench/shared-protocol';
import { evaluateSongRights } from './performance';

/** 重推理原子能力端口（由宿主注入；典型实现是 audio-ai-worker 的 HTTP 端点） */
export interface SongConsolePipelinePort {
  /** 探测各原子能力真实就绪情况（只描述事实） */
  probeCapabilities(): Promise<SongConsoleCapability[]>;
  /** Demucs v4：分离人声与伴奏 */
  separate(input: { sourceAudioPath: string; outputDir: string }): Promise<{ vocalPath: string; accompanimentPath: string }>;
  /** RVC v2 (RMVPE)：把一段人声切片转成目标声线并与伴奏混音（声线与调参必须真的送到推理端） */
  renderSlice(input: {
    vocalPath: string;
    accompanimentPath: string;
    startMs: number;
    durationMs: number;
    outputPath: string;
    rvcModelPath: string;
    rvcIndexPath: string;
    pitchShiftSemitones: number;
    indexRate: number;
    protectVoiceless: number;
    vocalGain: number;
    accompanimentGain: number;
  }): Promise<{ audioPath: string; durationMs: number }>;
  /** 把多个切片无缝拼接为最终产物 */
  concat(input: { slicePaths: string[]; outputPath: string }): Promise<{ audioPath: string; durationMs: number }>;
}

/** 缓存池端口（SPEC：`cache/songs/<characterId>_<hash>.ogg`，命中 <50ms） */
export interface SongCachePort {
  lookup(cacheKey: string): { filePath: string; durationMs: number } | null;
  store(entry: { cacheKey: string; songTitle: string; filePath: string; durationMs: number }): void;
}

export interface SongConsoleDeps {
  pipeline: SongConsolePipelinePort;
  cache: SongCachePort;
  /** 违禁曲目黑名单（内容侧数据） */
  blacklist?: SongBlacklistEntry[];
  /** 产物目录（cache/songs） */
  cacheDir: string;
  now?: () => number;
  /** 状态广播（宿主接 EventBus / IPC） */
  onStatus?: (status: SongConsoleStatus) => void;
}

/** 首切片预缓冲就绪后的后台补齐句柄 */
export interface SongConsoleSession {
  status: SongConsoleStatus;
  /** 后台补齐剩余切片并拼接落盘；已 unavailable/rejected 时为 null */
  completion: Promise<SongConsoleStatus> | null;
}

const CRITICAL_CAPABILITIES = ['demucs', 'rvc'] as const;

/** 把任意抛出物转成可读原因（不吞错、不编造） */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 状态写入入参：updatedAt 由内核补，其余字段按契约 */
type SongConsolePartial = Omit<SongConsoleStatusInput, 'updatedAt'> & { updatedAt?: number };

export class SongConsole {
  private readonly deps: SongConsoleDeps;
  private readonly now: () => number;
  private lastStatus: SongConsoleStatus | null = null;
  /** 已被取消的 requestId：后台补齐每轮检查，取消后立即停止且不落缓存 */
  private readonly cancelled = new Set<string>();

  constructor(deps: SongConsoleDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 最近一次状态（宿主 UI 轮询用） */
  snapshot(): SongConsoleStatus | null {
    return this.lastStatus;
  }

  /**
   * 取消一次点歌（用户主动取消 / 应用退出清理）。
   * 后台补齐会在下一轮检查时停止，**不落缓存**；返回是否确实需要中断。
   */
  cancel(requestId: string): { ok: boolean; cancelled: boolean; reason?: string } {
    if (!requestId.trim()) return { ok: false, cancelled: false, reason: 'requestId 不能为空' };
    const active = this.lastStatus;
    if (!active || active.requestId !== requestId) {
      return { ok: false, cancelled: false, reason: `没有正在进行的点歌请求：${requestId}` };
    }
    if (['completed', 'rejected', 'unavailable', 'cancelled', 'idle'].includes(active.state)) {
      return { ok: false, cancelled: false, reason: `请求已处于终态：${active.state}` };
    }
    this.cancelled.add(requestId);
    const status = this.emit({
      ...active,
      state: 'cancelled',
      stage: 'cancelled',
    });
    return { ok: true, cancelled: true };
  }

  /**
   * 发起一次点歌：返回首个可播状态（缓存命中 / 首切片就绪 / 被拒 / 缺失），
   * 并给出后台补齐句柄。
   */
  async request(raw: SongConsoleRequestInput): Promise<SongConsoleSession> {
    const req = SongConsoleRequestSchema.parse(raw);
    const rightsCheck = evaluateSongRights(req.song.rights, req.channel);
    const base = {
      requestId: req.requestId,
      characterId: req.characterId,
      songId: req.song.songId,
      songTitle: req.song.title,
      channel: req.channel,
      rightsCheck,
      cacheKey: this.cacheKey(req),
    };

    // ① 四重授权门禁（曲目/伴奏/歌词/角色声线）——不通过就不碰任何音频
    if (!rightsCheck.allowed) {
      return this.finish({
        ...base,
        state: 'rejected',
        stage: 'rejected',
        rejectionReason: `授权门禁未通过：${rightsCheck.reasons.join('；')}`,
      });
    }

    // ② 违禁曲目黑名单
    const blocked = this.matchBlacklist(req);
    if (blocked) {
      return this.finish({
        ...base,
        state: 'rejected',
        stage: 'rejected',
        rejectionReason: `命中违禁曲目黑名单：${blocked.keyword}（${blocked.reason}）`,
      });
    }

    // ③ 缓存池（只认真实存在且非空的产物）
    const lookupStart = this.now();
    const hit = this.deps.cache.lookup(base.cacheKey);
    const cacheLookupMs = this.now() - lookupStart;
    if (hit && this.fileIsUsable(hit.filePath)) {
      return this.finish({
        ...base,
        state: 'streaming',
        stage: 'cache_hit',
        cacheHit: true,
        cacheLookupMs,
        prebufferPath: hit.filePath,
        // 索引里没有真实时长时用契约里的歌曲时长兜底（不是编造：song.durationMs 是真实输入）
        prebufferDurationMs: hit.durationMs > 0 ? hit.durationMs : req.song.durationMs,
        finalPath: hit.filePath,
        totalDurationMs: hit.durationMs > 0 ? hit.durationMs : req.song.durationMs,
        completedSlices: 1,
        totalSlices: 1,
      });
    }

    // ④ 能力与素材前置：缺什么就如实说什么
    const capabilities = await this.deps.pipeline.probeCapabilities();
    const missing: string[] = [];
    for (const name of CRITICAL_CAPABILITIES) {
      const cap = capabilities.find((c) => c.name === name);
      if (!cap || !cap.ready) {
        missing.push(`${name}：${cap?.detail ?? '未上报能力状态'}${cap?.hint ? `（${cap.hint}）` : ''}`);
      }
    }
    if (!req.sourceAudioPath.trim()) {
      missing.push('源音频：未提供本地原曲路径（sourceAudioPath 为空）');
    } else if (!this.fileIsUsable(req.sourceAudioPath)) {
      missing.push(`源音频：文件不存在或为空（${req.sourceAudioPath}）`);
    }
    if (missing.length > 0) {
      return this.finish({
        ...base,
        state: 'unavailable',
        stage: 'unavailable',
        cacheLookupMs,
        unavailableReason: `点歌台能力缺失，拒绝以占位音频冒充真唱：${missing.join('；')}`,
        missingCapabilities: missing,
      });
    }

    // ⑤ 真实管线：分离 → 首切片 → 转换 → 混音（首切片就绪后才开唱）
    const outputDir = this.deps.cacheDir;
    let separated: { vocalPath: string; accompanimentPath: string };
    try {
      separated = await this.deps.pipeline.separate({
        sourceAudioPath: req.sourceAudioPath,
        outputDir,
      });
    } catch (err) {
      // 后端 501/502 或网络失败：如实 unavailable，不吞错也不假装成功
      return this.finish({
        ...base,
        state: 'unavailable',
        stage: 'unavailable',
        cacheLookupMs,
        unavailableReason: `分离失败，拒绝以占位音频冒充真唱：${describeError(err)}`,
        missingCapabilities: [`demucs：${describeError(err)}`],
      });
    }
    const totalDurationMs = req.song.durationMs;
    const totalSlices = Math.max(1, Math.ceil(totalDurationMs / req.sliceMs));

    const firstSlicePath = `${outputDir}/${base.cacheKey}.slice0.ogg`;
    let firstSlice: { audioPath: string; durationMs: number };
    try {
      firstSlice = await this.deps.pipeline.renderSlice({
        ...this.sliceParams(req),
        vocalPath: separated.vocalPath,
        accompanimentPath: separated.accompanimentPath,
        startMs: 0,
        durationMs: Math.min(req.firstSliceMs, totalDurationMs),
        outputPath: firstSlicePath,
      });
    } catch (err) {
      return this.finish({
        ...base,
        state: 'unavailable',
        stage: 'unavailable',
        cacheLookupMs,
        unavailableReason: `首切片渲染失败，拒绝以占位音频冒充真唱：${describeError(err)}`,
        missingCapabilities: [`render_slice：${describeError(err)}`],
      });
    }
    if (!this.fileIsUsable(firstSlice.audioPath)) {
      return this.finish({
        ...base,
        state: 'unavailable',
        stage: 'unavailable',
        unavailableReason: '首切片渲染未产出可用音频，拒绝以占位音频冒充真唱',
        missingCapabilities: ['render_slice：产物文件不存在或为空'],
      });
    }

    const prebufferStatus = this.finish({
      ...base,
      state: 'streaming',
      stage: 'prebuffer_ready',
      cacheLookupMs,
      prebufferPath: firstSlice.audioPath,
      prebufferDurationMs: firstSlice.durationMs,
      completedSlices: 1,
      totalSlices,
      totalDurationMs,
      backgroundJobId: `songjob-${randomUUID().slice(0, 8)}`,
    });

    const completion = this.completeInBackground({
      req,
      base,
      separated,
      firstSlicePath: firstSlice.audioPath,
      totalSlices,
    }).then((session) => session.status);

    return {
      status: prebufferStatus.status,
      completion,
    };
  }

  /** 后台补齐剩余切片并拼接落盘（首切片已可播） */
  private async completeInBackground(input: {
    req: SongConsoleRequest;
    base: Omit<SongConsoleStatusInput, 'state' | 'stage' | 'updatedAt'>;
    separated: { vocalPath: string; accompanimentPath: string };
    firstSlicePath: string;
    totalSlices: number;
  }): Promise<SongConsoleSession> {
    const { req, base, separated, firstSlicePath, totalSlices } = input;
    this.emit({ ...base, state: 'completing', stage: 'completing', completedSlices: 1, totalSlices });
    const slicePaths = [firstSlicePath];
    let completed = 1;
    for (let index = 1; index < totalSlices; index += 1) {
      if (this.cancelled.has(base.requestId)) {
        return this.finish({
          ...base,
          state: 'cancelled',
          stage: 'cancelled',
          completedSlices: completed,
          totalSlices,
        });
      }
      const startMs = index * req.sliceMs;
      const durationMs = Math.min(req.sliceMs, req.song.durationMs - startMs);
      if (durationMs <= 0) break;
      const out = `${this.deps.cacheDir}/${base.cacheKey}.slice${index}.ogg`;
      let rendered: { audioPath: string; durationMs: number };
      try {
        rendered = await this.deps.pipeline.renderSlice({
          ...this.sliceParams(req),
          vocalPath: separated.vocalPath,
          accompanimentPath: separated.accompanimentPath,
          startMs,
          durationMs,
          outputPath: out,
        });
      } catch (err) {
        return this.finish({
          ...base,
          state: 'unavailable',
          stage: 'unavailable',
          completedSlices: completed,
          totalSlices,
          unavailableReason: `第 ${index} 个切片渲染失败，已产出部分保留但不落缓存：${describeError(err)}`,
          missingCapabilities: [`render_slice：${describeError(err)}`],
        });
      }
      if (!this.fileIsUsable(rendered.audioPath)) {
        return this.finish({
          ...base,
          state: 'unavailable',
          stage: 'unavailable',
          completedSlices: completed,
          totalSlices,
          unavailableReason: `第 ${index} 个切片渲染失败，已产出部分保留但不落缓存`,
          missingCapabilities: [`render_slice：切片 ${index} 产物不可用`],
        });
      }
      slicePaths.push(rendered.audioPath);
      completed += 1;
    }

    if (this.cancelled.has(base.requestId)) {
      return this.finish({
        ...base,
        state: 'cancelled',
        stage: 'cancelled',
        completedSlices: completed,
        totalSlices,
      });
    }
    const finalPath = `${this.deps.cacheDir}/${base.cacheKey}.ogg`;
    let final: { audioPath: string; durationMs: number };
    try {
      final = await this.deps.pipeline.concat({ slicePaths, outputPath: finalPath });
    } catch (err) {
      return this.finish({
        ...base,
        state: 'unavailable',
        stage: 'unavailable',
        completedSlices: completed,
        totalSlices,
        unavailableReason: `切片拼接失败，不落缓存：${describeError(err)}`,
        missingCapabilities: [`concat：${describeError(err)}`],
      });
    }
    if (!this.fileIsUsable(final.audioPath)) {
      return this.finish({
        ...base,
        state: 'unavailable',
        stage: 'unavailable',
        completedSlices: completed,
        totalSlices,
        unavailableReason: '切片拼接未产出可用音频，不落缓存',
        missingCapabilities: ['concat：拼接产物不可用'],
      });
    }
    this.deps.cache.store({
      cacheKey: base.cacheKey,
      songTitle: base.songTitle,
      filePath: final.audioPath,
      durationMs: final.durationMs,
    });
    return this.finish({
      ...base,
      state: 'completed',
      stage: 'completed',
      prebufferPath: firstSlicePath,
      finalPath: final.audioPath,
      totalDurationMs: final.durationMs,
      completedSlices: completed,
      totalSlices,
    });
  }

  /**
   * 缓存键：`<characterId>_<sha256(...)[:16]>`（SPEC §3.4 命名）。
   *
   * 进入键的成分必须覆盖**一切影响输出的输入**，否则换声线/换调参会误复用旧缓存：
   * 源文件指纹（size + mtime，不只用路径）、声线模型与索引、全部混音调参、切片参数。
   */
  private cacheKey(req: SongConsoleRequest): string {
    const digest = createHash('sha256')
      .update(
        [
          req.sourceAudioPath,
          this.sourceFingerprint(req.sourceAudioPath),
          req.characterId,
          req.voiceProfileId,
          req.song.songId,
          req.song.durationMs.toString(),
          req.rvcModelPath,
          req.rvcIndexPath,
          req.pitchShiftSemitones.toString(),
          req.indexRate.toFixed(4),
          req.protectVoiceless.toFixed(4),
          req.vocalGain.toFixed(4),
          req.accompanimentGain.toFixed(4),
          req.firstSliceMs.toString(),
          req.sliceMs.toString(),
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 16);
    return `${req.characterId}_${digest}`;
  }

  /** 声线与调参原样透传给推理端（缓存键已覆盖同一组输入，两边口径必须一致） */
  private sliceParams(req: SongConsoleRequest): {
    rvcModelPath: string;
    rvcIndexPath: string;
    pitchShiftSemitones: number;
    indexRate: number;
    protectVoiceless: number;
    vocalGain: number;
    accompanimentGain: number;
  } {
    return {
      rvcModelPath: req.rvcModelPath,
      rvcIndexPath: req.rvcIndexPath,
      pitchShiftSemitones: req.pitchShiftSemitones,
      indexRate: req.indexRate,
      protectVoiceless: req.protectVoiceless,
      vocalGain: req.vocalGain,
      accompanimentGain: req.accompanimentGain,
    };
  }

  /** 源文件指纹：size + mtime。同名同路径但内容被换掉时指纹变化，缓存自然失效。 */
  private sourceFingerprint(path: string): string {
    if (!path.trim()) return 'no-source';
    try {
      const stat = statSync(path);
      return `${stat.size}@${Math.round(stat.mtimeMs)}`;
    } catch {
      return 'unstatable';
    }
  }

  private matchBlacklist(req: SongConsoleRequest): SongBlacklistEntry | null {
    const entries = this.deps.blacklist ?? [];
    if (entries.length === 0) return null;
    const haystack = `${req.song.title} ${req.song.artist}`.toLowerCase();
    for (const entry of entries) {
      if (entry.scope === 'public_only' && req.channel === 'private_desktop') continue;
      if (haystack.includes(entry.keyword.toLowerCase())) return entry;
    }
    return null;
  }

  private fileIsUsable(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).size > 0;
    } catch {
      return false;
    }
  }

  private finish(partial: SongConsolePartial): SongConsoleSession {
    const status = this.emit(partial);
    return { status, completion: null };
  }

  private emit(partial: SongConsolePartial): SongConsoleStatus {
    const status = SongConsoleStatusSchema.parse({ ...partial, updatedAt: partial.updatedAt ?? this.now() });
    this.lastStatus = status;
    this.deps.onStatus?.(status);
    return status;
  }
}

/** 便捷常量：SPEC §3.4 规定的前 25 秒首切片 */
export const SONG_CONSOLE_FIRST_SLICE_MS = 25_000;

/** 阶段顺序（供 UI 画进度条；unavailable/rejected 为终态） */
export const SONG_CONSOLE_STAGE_ORDER: readonly SongConsoleStage[] = [
  'rights_check',
  'blacklist_check',
  'cache_lookup',
  'cache_hit',
  'separating',
  'slicing',
  'converting',
  'mixing',
  'prebuffer_ready',
  'streaming',
  'completing',
  'completed',
  'cancelled',
] as const;
