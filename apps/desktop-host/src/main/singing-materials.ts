/**
 * 演唱素材扫描器（`V2-P3-07A` 宿主侧，`V2-P3-07` 阶段④）。
 *
 * 职责：把 owner 丢进素材目录的 WAV **读成事实**（采样率/位深/声道/时长/峰值/头尾静音/SHA-256），
 * 再交给 `@workbench/voice-runtime` 的纯函数做校验与就绪判定。
 *
 * 诚实口径：
 *  - 只读真实文件，算不出来就报 `unreadable_file` / `unsupported_format`，不猜、不补默认值；
 *  - 授权信息只从 `consent.json` 读**声明编号**，没有就逐个文件标「缺授权声明」，不替 owner 默认授权；
 *  - 落盘只写事实（`<userData>/singing/materials.json`），派生结论每次扫描重算，避免旧结论被当真。
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import {
  SingingConsentFileSchema,
  SingingEmotionKeySchema,
  SingingMaterialManifestSchema,
  SingingMaterialScanResultSchema,
  SingingMaterialSummarySchema,
  SingingProfileSchema,
  type PerformanceChannel,
  type SingingConsentFile,
  type SingingEngineProbe,
  type SingingEmotionKey,
  type SingingMaterialFile,
  type SingingMaterialIssue,
  type SingingMaterialScanResult,
} from '@workbench/shared-protocol';
import { resolveSingingReadiness, summarizeSingingMaterials } from '@workbench/voice-runtime';

const EMOTION_KEYS = new Set<string>(SingingEmotionKeySchema.options);
const SILENCE_THRESHOLD = 10 ** (-50 / 20); // −50 dBFS 以下视为静音
const CHUNK_SIZE = 1024 * 1024;

interface WavFacts {
  sampleRate: number;
  bitDepth: number;
  channels: number;
  durationMs: number;
  peakDbfs: number;
  headSilenceMs: number;
  tailSilenceMs: number;
  sha256: string;
}

type WavReadResult =
  | { ok: true; facts: WavFacts }
  | { ok: false; code: 'unreadable_file' | 'unsupported_format'; message: string };

interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

function readU8(buf: Buffer, offset: number): number {
  return buf.readUInt8(offset);
}

/** 单帧峰值（0–1 以上只可能出现在浮点格式，最后统一钳到 0 dBFS） */
function framePeak(buf: Buffer, offset: number, format: number, bits: number, channels: number): number {
  const sampleBytes = bits / 8;
  let peak = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    const at = offset + channel * sampleBytes;
    let value: number;
    if (format === 3) {
      value = bits === 32 ? buf.readFloatLE(at) : buf.readDoubleLE(at);
    } else if (bits === 8) {
      value = (readU8(buf, at) - 128) / 128;
    } else if (bits === 16) {
      value = buf.readInt16LE(at) / 32_768;
    } else if (bits === 24) {
      const raw = readU8(buf, at) | (readU8(buf, at + 1) << 8) | (readU8(buf, at + 2) << 16);
      const signed = (raw & 0x80_0000) !== 0 ? raw - 0x100_0000 : raw;
      value = signed / 8_388_608;
    } else {
      value = buf.readInt32LE(at) / 2_147_483_648;
    }
    peak = Math.max(peak, Math.abs(value));
  }
  return peak;
}

/** 读取 WAV 事实：一遍流式读完（大文件也不整个进内存）。 */
export function readWavFacts(filePath: string): WavReadResult {
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    return { ok: false, code: 'unreadable_file', message: `文件不可读：${describe(err)}` };
  }
  const fileSize = stat.size;
  if (fileSize < 44) return { ok: false, code: 'unreadable_file', message: '文件小于 44 字节，不是有效 WAV' };

  const fd = openSync(filePath, 'r');
  try {
    const headerLen = Math.min(fileSize, 64 * 1024);
    const header = Buffer.alloc(headerLen);
    readSync(fd, header, 0, headerLen, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, code: 'unsupported_format', message: '不是 RIFF/WAVE 文件' };
    }

    let format: WavFormat | null = null;
    let dataOffset = -1;
    let dataSize = 0;
    let offset = 12;
    while (offset + 8 <= header.length) {
      const id = header.toString('ascii', offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ') {
        if (body + 16 > header.length) break;
        const parsed: WavFormat = {
          audioFormat: header.readUInt16LE(body),
          channels: header.readUInt16LE(body + 2),
          sampleRate: header.readUInt32LE(body + 4),
          byteRate: header.readUInt32LE(body + 8),
          blockAlign: header.readUInt16LE(body + 12),
          bitsPerSample: header.readUInt16LE(body + 14),
        };
        // WAVE_FORMAT_EXTENSIBLE：真实格式在 SubFormat 的头两个字节
        if (parsed.audioFormat === 0xFFFE && body + 26 <= header.length) {
          parsed.audioFormat = header.readUInt16LE(body + 24);
        }
        format = parsed;
      } else if (id === 'data') {
        dataOffset = body;
        dataSize = Math.min(size, Math.max(0, fileSize - body));
      }
      if (size <= 0) break;
      if (format !== null && dataOffset >= 0) break;
      offset = body + size + (size % 2);
    }

    if (format === null) return { ok: false, code: 'unsupported_format', message: '缺少 fmt 块' };
    if (dataOffset < 0) return { ok: false, code: 'unsupported_format', message: '缺少 data 块' };
    if (format.channels <= 0 || format.sampleRate <= 0 || format.blockAlign <= 0 || format.byteRate <= 0) {
      return { ok: false, code: 'unsupported_format', message: 'fmt 块字段非法（声道/采样率/字节率）' };
    }
    const supported = (format.audioFormat === 1 && [8, 16, 24, 32].includes(format.bitsPerSample))
      || (format.audioFormat === 3 && [32, 64].includes(format.bitsPerSample));
    if (!supported) {
      return {
        ok: false,
        code: 'unsupported_format',
        message: `不支持的编码（audioFormat=${format.audioFormat}, ${format.bitsPerSample}bit）`,
      };
    }

    const frameCount = Math.floor(dataSize / format.blockAlign);
    if (frameCount <= 0) return { ok: false, code: 'unreadable_file', message: 'data 块没有完整采样帧' };

    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, Math.max(fileSize, 1)));
    let carry = Buffer.alloc(0);
    let frameIndex = 0;
    let maxAbs = 0;
    let firstNonSilent = -1;
    let lastNonSilent = -1;
    let filePos = 0;

    while (filePos < fileSize) {
      const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, fileSize - filePos), filePos);
      if (bytes <= 0) break;
      const buf = chunk.subarray(0, bytes);
      hash.update(buf);
      const from = Math.max(filePos, dataOffset);
      const to = Math.min(filePos + bytes, dataOffset + dataSize);
      if (to > from) {
        carry = Buffer.concat([carry, buf.subarray(from - filePos, to - filePos)]);
        const usable = carry.length - (carry.length % format.blockAlign);
        for (let cursor = 0; cursor < usable; cursor += format.blockAlign) {
          const peak = framePeak(carry, cursor, format.audioFormat, format.bitsPerSample, format.channels);
          if (peak > maxAbs) maxAbs = peak;
          if (peak > SILENCE_THRESHOLD) {
            if (firstNonSilent < 0) firstNonSilent = frameIndex;
            lastNonSilent = frameIndex;
          }
          frameIndex += 1;
        }
        carry = carry.subarray(usable);
      }
      filePos += bytes;
    }

    const hashHex = hash.digest('hex');
    const frameMs = 1000 / format.sampleRate;
    const durationMs = Math.round(frameCount * frameMs);
    const headSilenceMs = firstNonSilent < 0 ? durationMs : Math.round(firstNonSilent * frameMs);
    const tailSilenceMs = lastNonSilent < 0 ? durationMs : Math.round((frameCount - 1 - lastNonSilent) * frameMs);
    const peakDbfs = maxAbs <= 0 ? -120 : Math.min(0, 20 * Math.log10(maxAbs));

    return {
      ok: true,
      facts: {
        sampleRate: format.sampleRate,
        bitDepth: format.bitsPerSample,
        channels: format.channels,
        durationMs,
        peakDbfs: Number(peakDbfs.toFixed(2)),
        headSilenceMs,
        tailSilenceMs,
        sha256: hashHex,
      },
    };
  } catch (err) {
    return { ok: false, code: 'unreadable_file', message: `读取失败：${describe(err)}` };
  } finally {
    closeSync(fd);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SingingMaterialsHostOptions {
  userDataDir: string;
  /** 素材目录；默认 `<userDataDir>/singing/materials` */
  materialsDir?: string;
  /** 演唱档案；默认 `<userDataDir>/singing/profile.json` */
  profilePath?: string;
  /** 引擎探测（由内核注入；缺省按"未安装"处理，不假装可用） */
  probeEngines?: () => Promise<SingingEngineProbe[]>;
  /** 当前渠道；默认桌面私用 */
  channel?: PerformanceChannel;
  now?: () => number;
}

export interface SingingMaterialsHost {
  directory(): string;
  scan(): Promise<SingingMaterialScanResult>;
  last(): SingingMaterialScanResult | null;
}

function listWavFiles(root: string, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.wav') {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

/** 从相对路径推断：情绪组（目录名或文件名前缀）与素材类型（`training/` 目录） */
function inferMaterial(relativePath: string): { kind: SingingMaterialFile['kind']; emotion?: SingingEmotionKey } {
  const parts = relativePath.split(sep);
  const dirs = parts.slice(0, -1).map((part) => part.toLowerCase());
  const file = basename(relativePath, extname(relativePath)).toLowerCase();
  if (dirs.includes('training') || file.startsWith('training')) {
    return { kind: 'svc_training_dry_vocal' };
  }
  const fromDir = dirs.find((dir) => EMOTION_KEYS.has(dir));
  if (fromDir !== undefined) return { kind: 'emotion_reference', emotion: fromDir as SingingEmotionKey };
  const prefix = file.split('-')[0] ?? '';
  if (EMOTION_KEYS.has(prefix)) return { kind: 'emotion_reference', emotion: prefix as SingingEmotionKey };
  return { kind: 'emotion_reference' };
}

function loadConsent(materialsDir: string, explicit?: SingingConsentFile): { consent: SingingConsentFile; issues: SingingMaterialIssue[] } {
  const issues: SingingMaterialIssue[] = [];
  if (explicit !== undefined) return { consent: explicit, issues };
  const consentPath = join(materialsDir, 'consent.json');
  if (!existsSync(consentPath)) {
    return { consent: SingingConsentFileSchema.parse({}), issues };
  }
  try {
    const parsed = SingingConsentFileSchema.safeParse(JSON.parse(readFileSync(consentPath, 'utf8')));
    if (!parsed.success) {
      issues.push({
        code: 'consent_missing', severity: 'blocker',
        message: `consent.json 格式不合法，按未授权处理：${parsed.error.issues[0]?.message ?? '未知错误'}`,
      });
      return { consent: SingingConsentFileSchema.parse({}), issues };
    }
    return { consent: parsed.data, issues };
  } catch (err) {
    issues.push({
      code: 'consent_missing', severity: 'blocker',
      message: `consent.json 读取失败，按未授权处理：${describe(err)}`,
    });
    return { consent: SingingConsentFileSchema.parse({}), issues };
  }
}

export function createSingingMaterialsHost(options: SingingMaterialsHostOptions): SingingMaterialsHost {
  const materialsDir = options.materialsDir ?? join(options.userDataDir, 'singing', 'materials');
  const profilePath = options.profilePath ?? join(options.userDataDir, 'singing', 'profile.json');
  const manifestPath = join(options.userDataDir, 'singing', 'materials.json');
  const now = options.now ?? (() => Date.now());
  const channel = options.channel ?? 'private_desktop';
  let lastScan: SingingMaterialScanResult | null = null;

  const defaultEngines = (): SingingEngineProbe[] => [
    { engine: 'rvc', installed: false, weightLicense: 'unknown', detail: '未探测（audio-ai-worker 未返回 RVC 能力）', hint: '启动 audio-ai-worker 并放入可追溯的 .pth' },
    { engine: 'diffsinger', installed: false, weightLicense: 'unknown', detail: '未探测（未配置 SVS 后端）', hint: '配置 WHALE_SING_SVS_ENDPOINT' },
    { engine: 'openutau', installed: false, weightLicense: 'unknown', detail: '未探测', hint: '安装 OpenUtau（可选，SVS 前端）' },
  ];

  const buildProfile = (consent: SingingConsentFile): { profile: ReturnType<typeof SingingProfileSchema.parse>; profileSource: 'file' | 'unconfigured' } => {
    if (existsSync(profilePath)) {
      try {
        const parsed = SingingProfileSchema.safeParse(JSON.parse(readFileSync(profilePath, 'utf8')));
        if (parsed.success) return { profile: parsed.data, profileSource: 'file' };
      } catch {
        // 坏档案不阻断扫描：退回未配置档案，让 readiness 如实报缺
      }
    }
    const profile = SingingProfileSchema.parse({
      profileId: consent.identityId,
      characterId: 'xiaojing',
      route: 'svc',
      voice: {
        identityId: consent.identityId,
        displayName: consent.displayName,
        source: consent.source,
        consentScopes: consent.consentScopes,
        consentEvidenceRef: consent.consentEvidenceRef,
        minorVoice: consent.minorVoice,
        guardianConsent: consent.guardianConsent,
        weightLicense: consent.weightLicense,
        svcModelPath: consent.svcModelPath,
        svcIndexPath: consent.svcIndexPath,
        svsVoicebankPath: consent.svsVoicebankPath,
      },
      range: { lowestNote: 'C4', highestNote: 'F5', comfortableLow: 'E4', comfortableHigh: 'D5' },
      style: {},
    });
    return { profile, profileSource: 'unconfigured' };
  };

  const scan = async (): Promise<SingingMaterialScanResult> => {
    mkdirSync(materialsDir, { recursive: true });
    const loaded = loadConsent(materialsDir);
    const consent = loaded.consent;
    const extraIssues: SingingMaterialIssue[] = [...loaded.issues];

    const files: SingingMaterialFile[] = [];
    for (const filePath of listWavFiles(materialsDir)) {
      const rel = relative(materialsDir, filePath);
      const read = readWavFacts(filePath);
      if (!read.ok) {
        extraIssues.push({
          code: read.code, severity: 'blocker',
          message: `${rel}：${read.message}`,
        });
        continue;
      }
      const inferred = inferMaterial(rel);
      const materialId = rel.split(sep).join('/');
      const issuesForFile: SingingMaterialIssue[] = [];
      if (inferred.kind === 'emotion_reference' && inferred.emotion === undefined) {
        issuesForFile.push({
          code: 'unclassified_material', severity: 'warning',
          message: `${rel}：文件名/目录没写情绪组，按未分组处理（不会计入五组覆盖）`, materialId,
        });
      }
      extraIssues.push(...issuesForFile);
      files.push({
        materialId,
        kind: inferred.kind,
        ...(inferred.emotion === undefined ? {} : { emotion: inferred.emotion }),
        filePath,
        sha256: read.facts.sha256,
        sampleRate: read.facts.sampleRate,
        bitDepth: read.facts.bitDepth,
        channels: read.facts.channels,
        durationMs: read.facts.durationMs,
        peakDbfs: read.facts.peakDbfs,
        headSilenceMs: read.facts.headSilenceMs,
        tailSilenceMs: read.facts.tailSilenceMs,
        source: consent.source,
        consentEvidenceRef: consent.consentEvidenceRef,
        recordedAt: new Date(statSync(filePath).mtimeMs).toISOString(),
      });
    }

    // 落盘只写事实（manifest），派生结论不落盘
    const manifest = SingingMaterialManifestSchema.parse({
      version: '1',
      characterId: 'xiaojing',
      files,
      updatedAt: now(),
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const baseSummary = summarizeSingingMaterials(files);
    const issues = [...baseSummary.issues, ...extraIssues];
    const summary = SingingMaterialSummarySchema.parse({
      ...baseSummary,
      issues,
      verdict: issues.some((item) => item.severity === 'blocker')
        ? 'fail'
        : issues.length > 0 ? 'warn' : 'pass',
    });

    const { profile, profileSource } = buildProfile(consent);
    const engines = options.probeEngines === undefined ? defaultEngines() : await options.probeEngines();
    const readiness = resolveSingingReadiness({ profile, materials: files, engines, channel });

    lastScan = SingingMaterialScanResultSchema.parse({
      scannedAt: now(),
      directory: materialsDir,
      profileSource,
      files,
      summary,
      readiness,
    });
    return lastScan;
  };

  return {
    directory: () => materialsDir,
    scan,
    last: () => lastScan,
  };
}

/** 供内核使用的默认素材目录（测试与文档共用同一路径约定） */
export function defaultSingingMaterialsDir(userDataDir: string): string {
  return join(userDataDir, 'singing', 'materials');
}
