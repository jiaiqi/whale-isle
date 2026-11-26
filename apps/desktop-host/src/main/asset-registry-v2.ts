/**
 * Whale Isle V2 — 统一十态 AssetRegistry、舞台/场景/声音资产创作与版本回滚（V2-P2-07 / REQ-CR-03）
 *
 * 设计基线：
 *   - 舞台/桌面背景与声音/音效创作提供纯本地确定性质检（图像魔数/宽高比、RIFF WAV 块解析/削波/时长、OGG/MP3/M4A 嗅探）
 *     与零版权隐患的程序化原创生成（海洋渐变场景 PNG + 16-bit PCM WAV 音效）；
 *   - 十态 `AssetRegistryV2` 将所有提交版本的资产落盘到不可变内容快照目录 `<userData>/asset-registry/snapshots/`，
 *     每次发布、校验、回滚与商业清源导出均强制重新校验 SHA-256 哈希；
 *   - 复用 `evaluateAssetDistributionPolicy`，任何 `CC BY-NC-SA 4.0` / `DEV_ONLY` / 未审图 / 篡改文件
 *     一律在 `exportCleanBundle` 被强拦截，绝不混入商用或公开直播分发包。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import {
  AssetDistributionChannelSchema,
  AssetIntegrityCheckSchema,
  AssetPipelineStatusSchema,
  AssetProvenanceSchema,
  AssetRegistryCategorySchema,
  AssetRegistryEntrySchema,
  CommercialCleanExportResultSchema,
  SoundAssetInspectionSchema,
  StageSceneInspectionSchema,
  type AssetDistributionChannel,
  type AssetIntegrityCheck,
  type AssetPipelineStatus,
  type AssetProvenance,
  type AssetRegistryCategory,
  type AssetRegistryEntry,
  type CommercialCleanExportResult,
  type SoundAssetInspection,
  type StageSceneInspection,
} from '@workbench/shared-protocol';
import { evaluateAssetDistributionPolicy } from './character-studio-v2';
import { inspectImageAsset } from './media-gateway';
import { encodeRgbaPng } from './pixel-avatar-v2';

const REGISTRY_DIR = 'asset-registry';
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function assertSafeSegment(id: string, label: string): string {
  if (!SAFE_SEGMENT_RE.test(id) || id.includes('..')) {
    throw new Error(`${label} 非法：${id}`);
  }
  return id;
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/** 确定性舞台/桌面场景图像质检 */
export function inspectStageSceneAsset(filePath: string): StageSceneInspection {
  if (!existsSync(filePath)) {
    return StageSceneInspectionSchema.parse({
      valid: false,
      mimeType: 'application/octet-stream',
      isHdOrAbove: false,
      sha256: sha256Buffer(Buffer.alloc(0)),
      errors: [`场景图像不存在：${filePath}`],
    });
  }
  const buf = readFileSync(filePath);
  const qa = inspectImageAsset(buf);
  const warnings = [...qa.warnings];
  const errors: string[] = [];
  if (!qa.valid) errors.push(...qa.warnings);

  let aspectRatio: string | undefined;
  let isHdOrAbove = false;
  if (qa.valid && qa.width !== undefined && qa.height !== undefined) {
    const d = gcd(qa.width, qa.height);
    aspectRatio = `${qa.width / d}:${qa.height / d}`;
    isHdOrAbove = qa.width >= 1280 && qa.height >= 720;
    if (!isHdOrAbove) warnings.push(`场景分辨率低于 1280×720（实际 ${qa.width}×${qa.height}）`);
  } else if (qa.valid) {
    warnings.push('非 PNG 格式仅校验魔数，未解析像素宽高');
  }

  return StageSceneInspectionSchema.parse({
    valid: qa.valid,
    mimeType: qa.mimeType,
    ...(qa.width !== undefined ? { width: qa.width } : {}),
    ...(qa.height !== undefined ? { height: qa.height } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    isHdOrAbove,
    sha256: qa.sha256,
    warnings,
    errors,
  });
}

export type StageSceneTheme = 'tidepaper_mist' | 'night_tide' | 'obsidian_stage';

const STAGE_THEME_COLORS: Record<StageSceneTheme, { top: [number, number, number]; bottom: [number, number, number]; wave: [number, number, number] }> = {
  tidepaper_mist: { top: [243, 246, 248], bottom: [219, 234, 244], wave: [33, 128, 141] },
  night_tide: { top: [15, 23, 38], bottom: [22, 54, 72], wave: [56, 189, 248] },
  obsidian_stage: { top: [9, 13, 22], bottom: [28, 34, 52], wave: [99, 102, 241] },
};

/** 生成原创渐变海洋/舞台背景 PNG（零第三方素材依赖，完全商用清源） */
export function createProceduralStageScenePng(input: {
  outputPath: string;
  theme?: StageSceneTheme;
  width?: number;
  height?: number;
}): { outputPath: string; inspection: StageSceneInspection } {
  const theme = input.theme ?? 'tidepaper_mist';
  const width = Math.max(64, Math.min(3840, input.width ?? 320));
  const height = Math.max(64, Math.min(2160, input.height ?? 180));
  const palette = STAGE_THEME_COLORS[theme];
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const ty = y / Math.max(1, height - 1);
    const waveY = 0.72 + 0.04 * Math.sin((y / height) * Math.PI * 3);
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const horizon = waveY + 0.03 * Math.sin((x / width) * Math.PI * 4);
      const isWave = ty >= horizon;
      const mix = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
      const r = isWave ? mix(palette.bottom[0], palette.wave[0], (ty - horizon) * 1.4) : mix(palette.top[0], palette.bottom[0], ty);
      const g = isWave ? mix(palette.bottom[1], palette.wave[1], (ty - horizon) * 1.4) : mix(palette.top[1], palette.bottom[1], ty);
      const b = isWave ? mix(palette.bottom[2], palette.wave[2], (ty - horizon) * 1.4) : mix(palette.top[2], palette.bottom[2], ty);
      data[idx] = Math.min(255, Math.max(0, r));
      data[idx + 1] = Math.min(255, Math.max(0, g));
      data[idx + 2] = Math.min(255, Math.max(0, b));
      data[idx + 3] = 255;
    }
  }

  const absOut = resolve(input.outputPath);
  mkdirSync(resolve(absOut, '..'), { recursive: true });
  writeFileSync(absOut, encodeRgbaPng({ width, height, data }));
  return { outputPath: absOut, inspection: inspectStageSceneAsset(absOut) };
}

/** 确定性声音/音效资产质检：解析 WAV RIFF/fmt/data、采样率/声道/时长/峰值削波，或识别 OGG/MP3/M4A */
export function inspectAudioAsset(filePath: string): SoundAssetInspection {
  if (!existsSync(filePath)) {
    return SoundAssetInspectionSchema.parse({
      valid: false,
      format: 'unknown',
      sizeBytes: 0,
      clippingDetected: false,
      sha256: sha256Buffer(Buffer.alloc(0)),
      errors: [`声音资产不存在：${filePath}`],
    });
  }
  const buf = readFileSync(filePath);
  const sha256 = sha256Buffer(buf);
  if (buf.length < 12) {
    return SoundAssetInspectionSchema.parse({
      valid: false,
      format: 'unknown',
      sizeBytes: buf.length,
      clippingDetected: false,
      sha256,
      errors: ['音频文件过短或为空'],
    });
  }

  // RIFF....WAVE 解析
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') {
    let offset = 12;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let bitsPerSample: number | undefined;
    let dataSize = 0;
    let dataStart = -1;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
      const chunkSize = buf.readUInt32LE(offset + 4);
      const bodyStart = offset + 8;
      if (chunkId === 'fmt ' && chunkSize >= 16 && bodyStart + 16 <= buf.length) {
        channels = buf.readUInt16LE(bodyStart + 2);
        sampleRate = buf.readUInt32LE(bodyStart + 4);
        bitsPerSample = buf.readUInt16LE(bodyStart + 14);
      } else if (chunkId === 'data') {
        dataStart = bodyStart;
        dataSize = Math.min(chunkSize, buf.length - bodyStart);
      }
      offset = bodyStart + chunkSize + (chunkSize % 2);
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    if (!sampleRate || !channels || !bitsPerSample || dataStart < 0 || dataSize <= 0) {
      errors.push('WAV 文件缺少有效的 fmt 或 data 块');
      return SoundAssetInspectionSchema.parse({
        valid: false,
        format: 'wav',
        sizeBytes: buf.length,
        clippingDetected: false,
        sha256,
        warnings,
        errors,
      });
    }

    const bytesPerFrame = channels * (bitsPerSample / 8);
    const totalFrames = bytesPerFrame > 0 ? dataSize / bytesPerFrame : 0;
    const durationMs = Math.round((totalFrames / sampleRate) * 1000);
    let peakAmplitude = 0;
    let clippingDetected = false;
    if (bitsPerSample === 16) {
      for (let pos = dataStart; pos + 1 < dataStart + dataSize; pos += 2) {
        const amp = Math.abs(buf.readInt16LE(pos)) / 32768;
        if (amp > peakAmplitude) peakAmplitude = amp;
      }
      clippingDetected = peakAmplitude >= 0.995;
      if (clippingDetected) warnings.push('检测到音频峰值接近 0dBFS，存在削波风险');
    }
    return SoundAssetInspectionSchema.parse({
      valid: true,
      format: 'wav',
      sizeBytes: buf.length,
      sampleRate,
      channels,
      bitsPerSample,
      durationMs,
      peakAmplitude: Number(peakAmplitude.toFixed(4)),
      clippingDetected,
      sha256,
      warnings,
      errors,
    });
  }

  // OGG / MP3 / M4A 容器头嗅探
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') {
    return SoundAssetInspectionSchema.parse({
      valid: true,
      format: 'ogg',
      sizeBytes: buf.length,
      clippingDetected: false,
      sha256,
      warnings: ['OGG 容器已完成魔数校验（PCM 峰值校验仅支持 WAV）'],
    });
  }
  if (buf.subarray(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) {
    return SoundAssetInspectionSchema.parse({
      valid: true,
      format: 'mp3',
      sizeBytes: buf.length,
      clippingDetected: false,
      sha256,
      warnings: ['MP3 文件已完成帧头/ID3 校验'],
    });
  }
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    return SoundAssetInspectionSchema.parse({
      valid: true,
      format: 'm4a',
      sizeBytes: buf.length,
      clippingDetected: false,
      sha256,
      warnings: ['M4A/MP4 音频容器已完成 ftyp 校验'],
    });
  }

  return SoundAssetInspectionSchema.parse({
    valid: false,
    format: 'unknown',
    sizeBytes: buf.length,
    clippingDetected: false,
    sha256,
    errors: ['未识别的音频容器格式（支持 WAV / MP3 / OGG / M4A）'],
  });
}

export type SfxPreset = 'chime' | 'pop' | 'alert' | 'sparkle' | 'splash';

const SFX_PRESET_SPEC: Record<SfxPreset, { baseHz: number; endHz: number }> = {
  chime: { baseHz: 880, endHz: 1320 },
  pop: { baseHz: 320, endHz: 740 },
  alert: { baseHz: 660, endHz: 520 },
  sparkle: { baseHz: 1046, endHz: 1760 },
  splash: { baseHz: 480, endHz: 220 },
};

/** 合成纯原创 16-bit PCM WAV 音效（无外部音源版权争议，防削波衰减包络） */
export function synthesizeSfxWav(input: {
  outputPath: string;
  preset?: SfxPreset;
  durationMs?: number;
  sampleRate?: number;
}): { outputPath: string; inspection: SoundAssetInspection } {
  const preset = input.preset ?? 'chime';
  const durationMs = Math.max(40, Math.min(5000, input.durationMs ?? 240));
  const sampleRate = input.sampleRate ?? 22050;
  const spec = SFX_PRESET_SPEC[preset];
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16); // PCM fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM format
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);

  let phase = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const progress = i / Math.max(1, sampleCount - 1);
    const freq = spec.baseHz + (spec.endHz - spec.baseHz) * progress;
    phase += (2 * Math.PI * freq) / sampleRate;
    const attack = Math.min(1, i / Math.max(1, sampleRate * 0.01));
    const decay = Math.pow(1 - progress, 1.3);
    const val = Math.sin(phase) * 0.68 * attack * decay;
    wav.writeInt16LE(Math.round(val * 32767), 44 + i * 2);
  }

  const absOut = resolve(input.outputPath);
  mkdirSync(resolve(absOut, '..'), { recursive: true });
  writeFileSync(absOut, wav);
  return { outputPath: absOut, inspection: inspectAudioAsset(absOut) };
}

/** 统一十态 AssetRegistry：版本不可变快照、SHA-256 防篡改、一键回滚与商用清源打包 */
export class AssetRegistryV2 {
  private readonly rootDir: string;
  private readonly snapshotsDir: string;
  private readonly registryPath: string;
  private readonly entries = new Map<string, AssetRegistryEntry>();

  constructor(options: { userDataDir: string }) {
    this.rootDir = resolve(join(options.userDataDir, REGISTRY_DIR));
    this.snapshotsDir = join(this.rootDir, 'snapshots');
    this.registryPath = join(this.rootDir, 'registry.json');
    mkdirSync(this.snapshotsDir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.registryPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const raw of parsed) {
        const entry = AssetRegistryEntrySchema.safeParse(raw);
        if (entry.success) this.entries.set(entry.data.assetId, entry.data);
      }
    } catch {
      // 损坏的注册表跳过不阻断启动
    }
  }

  private persist(): void {
    const list = [...this.entries.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
    atomicWriteJson(this.registryPath, list);
  }

  listAssets(filter?: { characterId?: string; category?: AssetRegistryCategory }): AssetRegistryEntry[] {
    return [...this.entries.values()]
      .filter((e) => (filter?.characterId === undefined || e.characterId === filter.characterId))
      .filter((e) => (filter?.category === undefined || e.category === filter.category))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getAsset(assetId: string): AssetRegistryEntry | null {
    return this.entries.get(assetId) ?? null;
  }

  /** 注册资产新版本（拷贝不可变快照、执行类别质检并写 SHA-256） */
  registerVersion(input: {
    assetId: string;
    characterId: string;
    displayName: string;
    category: AssetRegistryCategory;
    sourceFilePath: string;
    initialStatus?: Extract<AssetPipelineStatus, 'draft' | 'candidate' | 'review_required'>;
    provenance: Omit<AssetProvenance, 'sha256' | 'generatedAt'> & { generatedAt?: string };
    note?: string;
  }): { entry: AssetRegistryEntry; version: AssetRegistryEntry['versions'][number]; qaErrors: string[] } {
    const assetId = assertSafeSegment(input.assetId, 'assetId');
    const category = AssetRegistryCategorySchema.parse(input.category);
    if (!existsSync(input.sourceFilePath)) {
      throw new Error(`源资产文件不存在：${input.sourceFilePath}`);
    }

    const qaErrors: string[] = [];
    if (category === 'stage_background' || category === 'desktop_wallpaper') {
      const imgQa = inspectStageSceneAsset(input.sourceFilePath);
      if (!imgQa.valid) qaErrors.push(...imgQa.errors);
    } else if (category === 'sound_sfx' || category === 'voice_bgm') {
      const audioQa = inspectAudioAsset(input.sourceFilePath);
      if (!audioQa.valid) qaErrors.push(...audioQa.errors);
    }

    const buf = readFileSync(input.sourceFilePath);
    if (buf.length === 0) qaErrors.push('资产文件为空（0 bytes）');

    const now = new Date().toISOString();
    const existing = this.entries.get(assetId);
    const nextNum = existing ? existing.versions.length + 1 : 1;
    const versionId = `v${nextNum}`;
    const safeName = basename(input.sourceFilePath).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'asset.bin';
    const snapDir = resolve(join(this.snapshotsDir, assetId, versionId));
    if (!snapDir.startsWith(`${this.snapshotsDir}${sep}`)) throw new Error('快照目录越界');
    mkdirSync(snapDir, { recursive: true });
    const snapshotPath = join(snapDir, safeName);
    copyFileSync(input.sourceFilePath, snapshotPath);

    const status: AssetPipelineStatus =
      qaErrors.length > 0 ? 'validation_failed' : (input.initialStatus ?? 'review_required');
    const provenance = AssetProvenanceSchema.parse({
      ...input.provenance,
      generatedAt: input.provenance.generatedAt ?? now,
      sha256: sha256Buffer(buf),
    });

    const versionRecord = {
      versionId,
      versionNumber: nextNum,
      status,
      snapshotPath,
      fileName: safeName,
      sizeBytes: statSync(snapshotPath).size,
      sha256: provenance.sha256,
      provenance,
      ...(input.note ? { note: input.note } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const nextEntry = AssetRegistryEntrySchema.parse({
      assetId,
      characterId: input.characterId,
      displayName: input.displayName,
      category,
      activeVersionId: existing?.activeVersionId ?? null,
      previousActiveVersionId: existing?.previousActiveVersionId ?? null,
      versions: [...(existing?.versions ?? []), versionRecord],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.entries.set(assetId, nextEntry);
    this.persist();
    return { entry: nextEntry, version: versionRecord, qaErrors };
  }

  /** 校验快照文件 SHA-256 完整性（防丢失与防篡改） */
  verifyIntegrity(assetId: string, versionId?: string): AssetIntegrityCheck {
    const entry = this.entries.get(assetId);
    if (!entry) throw new Error(`资产不存在：${assetId}`);
    const targetId = versionId ?? entry.activeVersionId;
    if (!targetId) throw new Error(`资产 ${assetId} 暂无激活版本`);
    const ver = entry.versions.find((v) => v.versionId === targetId);
    if (!ver) throw new Error(`版本不存在：${assetId}@${targetId}`);
    if (!existsSync(ver.snapshotPath)) {
      return AssetIntegrityCheckSchema.parse({
        ok: false,
        assetId,
        versionId: ver.versionId,
        expectedSha256: ver.sha256,
        reason: `快照文件缺失：${ver.snapshotPath}`,
      });
    }
    const actualSha256 = sha256Buffer(readFileSync(ver.snapshotPath));
    const ok = actualSha256 === ver.sha256;
    return AssetIntegrityCheckSchema.parse({
      ok,
      assetId,
      versionId: ver.versionId,
      expectedSha256: ver.sha256,
      actualSha256,
      reason: ok ? 'SHA-256 完整性校验通过' : '快照文件哈希与登记记录不匹配（疑似被篡改或损坏）',
    });
  }

  /** 十态状态迁移门禁：校验失败禁止审批/发布；发布前强制 SHA-256 校验 */
  transitionStatus(input: {
    assetId: string;
    versionId: string;
    nextStatus: AssetPipelineStatus;
    note?: string;
  }): { ok: boolean; error?: string; entry?: AssetRegistryEntry } {
    const nextStatus = AssetPipelineStatusSchema.parse(input.nextStatus);
    const entry = this.entries.get(input.assetId);
    if (!entry) return { ok: false, error: `资产不存在：${input.assetId}` };
    const ver = entry.versions.find((v) => v.versionId === input.versionId);
    if (!ver) return { ok: false, error: `版本不存在：${input.assetId}@${input.versionId}` };

    if (ver.status === 'validation_failed' && (nextStatus === 'approved' || nextStatus === 'published')) {
      return { ok: false, error: 'QA 校验失败（validation_failed）的版本禁止批准或发布' };
    }
    if (nextStatus === 'published') {
      if (ver.status !== 'approved' && ver.status !== 'published') {
        return { ok: false, error: `版本当前状态为 ${ver.status}，必须先经审批（approved）后方可发布` };
      }
      const integrity = this.verifyIntegrity(entry.assetId, ver.versionId);
      if (!integrity.ok) {
        return { ok: false, error: `发布阻断：${integrity.reason}` };
      }
    }

    const now = new Date().toISOString();
    ver.status = nextStatus;
    ver.updatedAt = now;
    if (input.note?.trim()) {
      ver.note = input.note.trim();
      ver.provenance.reviewNotes.push(`${nextStatus}: ${input.note.trim()}`);
    }

    if (nextStatus === 'published' && entry.activeVersionId !== ver.versionId) {
      entry.previousActiveVersionId = entry.activeVersionId;
      entry.activeVersionId = ver.versionId;
    }
    entry.updatedAt = now;
    this.persist();
    return { ok: true, entry: AssetRegistryEntrySchema.parse(entry) };
  }

  /** 一键回滚至上一版（或指定历史版），强制重验目标快照 SHA-256 */
  rollbackAsset(input: {
    assetId: string;
    targetVersionId?: string;
    note?: string;
  }): { ok: boolean; error?: string; entry?: AssetRegistryEntry } {
    const entry = this.entries.get(input.assetId);
    if (!entry) return { ok: false, error: `资产不存在：${input.assetId}` };

    const targetId =
      input.targetVersionId ??
      entry.previousActiveVersionId ??
      [...entry.versions]
        .reverse()
        .find((v) => v.versionId !== entry.activeVersionId && v.status !== 'validation_failed' && v.status !== 'restricted')
        ?.versionId;

    if (!targetId) {
      return { ok: false, error: '没有可回滚的历史版本' };
    }
    if (targetId === entry.activeVersionId) {
      return { ok: false, error: `目标版本 ${targetId} 已经是当前激活版本` };
    }
    const targetVer = entry.versions.find((v) => v.versionId === targetId);
    if (!targetVer) return { ok: false, error: `目标版本不存在：${targetId}` };
    if (targetVer.status === 'validation_failed' || targetVer.status === 'restricted') {
      return { ok: false, error: `目标版本 ${targetId} 状态为 ${targetVer.status}，禁止回滚激活` };
    }

    const integrity = this.verifyIntegrity(entry.assetId, targetId);
    if (!integrity.ok) {
      return { ok: false, error: `回滚阻断：${integrity.reason}` };
    }

    const now = new Date().toISOString();
    const oldActiveId = entry.activeVersionId;
    if (oldActiveId) {
      const oldVer = entry.versions.find((v) => v.versionId === oldActiveId);
      if (oldVer) {
        oldVer.status = 'deprecated';
        oldVer.updatedAt = now;
        oldVer.provenance.reviewNotes.push(`rolled_back -> ${targetId}${input.note ? ` (${input.note})` : ''}`);
      }
    }
    targetVer.status = 'published';
    targetVer.updatedAt = now;
    entry.previousActiveVersionId = oldActiveId;
    entry.activeVersionId = targetId;
    entry.updatedAt = now;
    this.persist();
    return { ok: true, entry: AssetRegistryEntrySchema.parse(entry) };
  }

  /** 商用/公开直播清源导出：严格过滤 CC BY-NC-SA 4.0、DEV_ONLY、未发布或哈希异常资产 */
  exportCleanBundle(input: {
    outputDir: string;
    channel?: AssetDistributionChannel;
    assetIds?: string[];
  }): CommercialCleanExportResult {
    const channel = AssetDistributionChannelSchema.parse(input.channel ?? 'commercial_distribution');
    const outRoot = resolve(input.outputDir);
    const outAssetsDir = join(outRoot, 'assets');
    mkdirSync(outAssetsDir, { recursive: true });

    const candidates = input.assetIds
      ? [...this.entries.values()].filter((e) => input.assetIds!.includes(e.assetId))
      : [...this.entries.values()];

    const exportedAssets: CommercialCleanExportResult['exportedAssets'] = [];
    const blockedAssets: CommercialCleanExportResult['blockedAssets'] = [];

    for (const entry of candidates.sort((a, b) => a.assetId.localeCompare(b.assetId))) {
      if (!entry.activeVersionId) {
        blockedAssets.push({
          assetId: entry.assetId,
          versionId: null,
          license: 'UNPUBLISHED',
          reason: '资产尚未发布激活版本（activeVersionId 为空）',
        });
        continue;
      }
      const ver = entry.versions.find((v) => v.versionId === entry.activeVersionId)!;
      const integrity = this.verifyIntegrity(entry.assetId, ver.versionId);
      if (!integrity.ok) {
        blockedAssets.push({
          assetId: entry.assetId,
          versionId: ver.versionId,
          license: ver.provenance.license,
          reason: integrity.reason,
        });
        continue;
      }
      const policy = evaluateAssetDistributionPolicy(ver.provenance, channel);
      if (!policy.allowed) {
        blockedAssets.push({
          assetId: entry.assetId,
          versionId: ver.versionId,
          license: ver.provenance.license,
          reason: policy.reason,
        });
        continue;
      }
      const exportedFileName = `${entry.assetId}-${ver.versionId}-${ver.fileName}`;
      copyFileSync(ver.snapshotPath, join(outAssetsDir, exportedFileName));
      exportedAssets.push({
        assetId: entry.assetId,
        versionId: ver.versionId,
        category: entry.category,
        fileName: exportedFileName,
        sha256: ver.sha256,
        license: ver.provenance.license,
      });
    }

    const manifestPath = join(outRoot, 'export-manifest.json');
    const result = CommercialCleanExportResultSchema.parse({
      ok: blockedAssets.length === 0,
      channel,
      outputDir: outRoot,
      manifestPath,
      exportedAssets,
      blockedAssets,
      exportedCount: exportedAssets.length,
      blockedCount: blockedAssets.length,
    });
    atomicWriteJson(manifestPath, result);
    return result;
  }
}
