/**
 * 声音工坊 2.0（主进程引擎）：声线版本管理、真实声学质检、一致性体检、
 * AI 音色设计候选流、本地录音/上传音色克隆、多句试戴与音频安全读取。
 *
 * 设计边界与诚实红线：
 * - **出厂默认不动**：随包 `assets/voice/xiaojing-07-tiancui-yuanqi.wav` 永远是出厂版本且不可删除；
 *   用户所有「定格」与「克隆」只写本地 `userData/voice-workshop/`，不进 git。
 * - **定格 / 克隆激活 = 写本地克隆参考**：将所选版本的参考音频复制成 `voice-clone-sample.wav`
 *   （主进程既有的 VoiceClone 参考源），运行期无缝生效；回退到出厂即删除该副本。
 * - **声学质检 100% 确定性计算**：从真实 WAV RIFF/PCM 字节解析采样率/声道/位深/时长/RMS/Peak/SNR，绝不伪造指标。
 * - **克隆强制声音权属声明**：契约层要求 `consent.attested === true` 与来源说明，未声明直接拒绝。
 * - **一致性体检沿用既有工具**：`tools/scripts/speaker-cosine.py`（sherpa-onnx CAM++）+ 同一句 ×10 真实克隆；
 *   工具缺失返回 `unavailable`，绝不编造数字。
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeVoiceWorkshopDescription,
  estimateDataUriBase64Bytes,
  MIMO_MAX_REFERENCE_BASE64_BYTES,
  MIMO_WORKSHOP_AUDITION_LINES,
  VOICE_WORKSHOP_DIAL_OPTIONS,
  type VoiceAudioQuality,
  type VoiceCloneConsent,
  type VoiceConsistencyResult,
  type VoicePerformanceIntensity,
  type VoiceTimbreVersion,
  type VoiceWorkshopCandidate,
  type VoiceWorkshopDial,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';

/** 一次合成的请求（由宿主用真实的 MiMo provider 实现，便于单测注入假实现） */
export interface WorkshopSynthInput {
  mode: 'voicedesign' | 'voiceclone';
  text: string;
  description: string;
  /** 五档情绪键；缺省 = 中性（不发风格指令、不打标签） */
  emotion?: string;
  intensity: VoicePerformanceIntensity;
  /** voiceclone 用：参考音频路径 */
  referencePath?: string;
  /** 可选：中止信号（用于中途取消在飞候选生成） */
  signal?: AbortSignal;
}

export interface WorkshopSynthResult {
  bytes: Uint8Array;
  providerKind: string;
  durationMs?: number;
}

export type WorkshopSynth = (input: WorkshopSynthInput) => Promise<WorkshopSynthResult>;

/** 说话人余弦（外部工具）的返回；不可用时为 null（绝不造数） */
export type SpeakerCosineRunner = (wavPaths: string[]) => Promise<{ mean: number; min: number; std: number } | null>;

export interface VoiceWorkshopDeps {
  /** userData 目录 */
  userDataDir: string;
  /** 随包参考音频的绝对路径 */
  bundledReferencePath: string;
  bundledLabel: string;
  bundledDescription: string;
  /** 主进程既有的克隆参考落点（定格即写这里） */
  cloneSamplePath: string;
  synth: WorkshopSynth;
  runSpeakerCosine?: SpeakerCosineRunner;
  /** 参考音频、角色绑定或授权状态变化时触发（用于失效主进程 TTS 合成缓存） */
  onReferenceChanged?: () => void;
  now?: () => Date;
}

export interface WorkshopAuditionRow {
  key: string;
  label: string;
  emotion: string | null;
  intensity: VoicePerformanceIntensity;
  text: string;
  audioBase64: string;
  providerKind: string;
  durationMs: number | null;
}

/** 体检用的固定句（与 bench 同句，便于和历史数字横比） */
export const CONSISTENCY_SENTENCE = '主人，今天也辛苦啦，我给你倒杯热茶好不好呀。';
/** 体检样本数：固定 10 条（UI 跑前要提示消耗 10 次合成） */
export const CONSISTENCY_SAMPLES = 10;
/** 单个参考音频原始字节上限（对应 MiMo Base64 编码后 ≤ 10,000,000 bytes，约 7.49 MB） */
export const MAX_REFERENCE_WAV_BYTES = Math.floor(((MIMO_MAX_REFERENCE_BASE64_BYTES - 24) / 4) * 3);
/** 本地留存的未裁剪原始素材副本字节上限（绝不直接发云端） */
const MAX_LOCAL_RAW_WAV_BYTES = 30 * 1024 * 1024;

/**
 * 判据（写死，不随 UI 调）：
 * - mean ≥ 0.85 且 min ≥ 0.80 → 锁得稳（对标定稿 07：0.9059 / 0.8814）
 * - min ≥ 0.70 → 偶尔飘（对标 02：0.8275 / 0.7189）
 * - 否则 → 会换人（对标 VoiceDesign 纯描述漂移：最小 0.4145）
 */
export function verdictFor(mean: number, min: number): { verdict: 'stable' | 'drifty' | 'swapped'; detail: string } {
  if (mean >= 0.85 && min >= 0.8) {
    return { verdict: 'stable', detail: '锁得稳：10 条听起来是同一个人，可以当固定声线用' };
  }
  if (min >= 0.7) {
    return { verdict: 'drifty', detail: '偶尔飘：整体是同一个人，但有个别条目音色会偏，长句/高情绪时更明显' };
  }
  return { verdict: 'swapped', detail: '会换人：部分条目已经不是同一个声音，不建议当固定声线' };
}

/** 计算 WAV 字节的 SHA-256 指纹（用于资产留痕与缓存版本锚定） */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 严格校验 RIFF/WAVE 文件头与 MiMo Base64 ≤ 10MB 硬红线 */
export function assertValidWavBytes(bytes: Uint8Array): void {
  const encodedBytes = estimateDataUriBase64Bytes(bytes.byteLength, 'audio/wav');
  if (encodedBytes > MIMO_MAX_REFERENCE_BASE64_BYTES) {
    throw new Error(
      `参考音频 Base64 编码后（${(encodedBytes / 1_000_000).toFixed(2)} MB）超过 MiMo 10 MB 上限（原始 WAV 约 7.5 MB），请裁剪至 5–12 秒片段`,
    );
  }
  if (bytes.byteLength < 44) {
    throw new Error('WAV 文件过小或损坏（不足 44 字节）');
  }
  const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  const wave = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('只接受标准 RIFF/WAVE 格式的 .wav 音频');
  }
}

/**
 * 确定性 WAV 声学质检：纯 PCM 解析，不依赖外部二进制，100% 源自真实采样值。
 * 若文件不是标准 PCM/Float WAV（如压缩编码或测试 stub 极短字节），返回 null（绝不编造指标）。
 */
export function analyzeWavBuffer(bytes: Uint8Array): VoiceAudioQuality | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string =>
    String.fromCharCode(bytes[off] ?? 0, bytes[off + 1] ?? 0, bytes[off + 2] ?? 0, bytes[off + 3] ?? 0);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = tag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (bodyStart + chunkSize > bytes.byteLength) break;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = view.getUint16(bodyStart, true);
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitDepth = view.getUint16(bodyStart + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataLength = chunkSize;
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (
    dataOffset < 0 ||
    dataLength <= 0 ||
    channels <= 0 ||
    sampleRate <= 0 ||
    (audioFormat !== 1 && audioFormat !== 3) ||
    ![8, 16, 24, 32].includes(bitDepth)
  ) {
    return null;
  }

  const bytesPerSample = bitDepth / 8;
  const frameSize = bytesPerSample * channels;
  const totalFrames = Math.floor(dataLength / frameSize);
  if (totalFrames <= 0) return null;

  const durationMs = Math.round((totalFrames / sampleRate) * 1000);
  const windowFrames = Math.max(1, Math.floor(sampleRate * 0.05)); // 50ms 窗估算底噪与语音电平
  const windowRms: number[] = [];

  let sumSq = 0;
  let peak = 0;
  let winSumSq = 0;
  let winCount = 0;

  for (let frame = 0; frame < totalFrames; frame++) {
    let mono = 0;
    const base = dataOffset + frame * frameSize;
    for (let ch = 0; ch < channels; ch++) {
      const pos = base + ch * bytesPerSample;
      let sample = 0;
      if (audioFormat === 3 && bitDepth === 32) {
        sample = view.getFloat32(pos, true);
      } else if (bitDepth === 16) {
        sample = view.getInt16(pos, true) / 32768;
      } else if (bitDepth === 8) {
        sample = ((bytes[pos] ?? 128) - 128) / 128;
      } else if (bitDepth === 24) {
        const b0 = bytes[pos] ?? 0;
        const b1 = bytes[pos + 1] ?? 0;
        const b2 = bytes[pos + 2] ?? 0;
        const raw = b0 | (b1 << 8) | (b2 << 16);
        const signed = (raw & 0x800000) !== 0 ? raw | ~0xffffff : raw;
        sample = signed / 8388608;
      } else if (bitDepth === 32) {
        sample = view.getInt32(pos, true) / 2147483648;
      }
      mono += sample;
    }
    mono /= channels;
    const abs = Math.abs(mono);
    if (abs > peak) peak = abs;
    const sq = mono * mono;
    sumSq += sq;
    winSumSq += sq;
    winCount += 1;
    if (winCount >= windowFrames) {
      windowRms.push(Math.sqrt(winSumSq / winCount));
      winSumSq = 0;
      winCount = 0;
    }
  }

  const rms = Math.sqrt(sumSq / totalFrames);
  const toDb = (val: number): number => (val <= 1e-5 ? -96 : Math.max(-96, Math.round(20 * Math.log10(val) * 10) / 10));
  const rmsDb = toDb(rms);
  const peakDb = toDb(peak);
  const clipping = peakDb >= -0.5;

  let estimatedSnrDb: number | null = null;
  if (windowRms.length >= 6) {
    const sorted = [...windowRms].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
    const speech = sorted[Math.floor(sorted.length * 0.85)] ?? 0;
    if (speech > 1e-4) {
      estimatedSnrDb = Math.round((toDb(speech) - Math.max(-80, toDb(floor))) * 10) / 10;
    }
  }

  const hints: string[] = [];
  let severity = 0;
  const raise = (level: 1 | 2, msg: string): void => {
    if (level > severity) severity = level;
    hints.push(msg);
  };

  if (durationMs < 3000) {
    raise(2, '时长不足 3 秒：零样本克隆特征偏少，建议提供 5–12 秒清晰干声');
  } else if (durationMs > 30000) {
    raise(2, '时长超过 30 秒：建议裁剪出最清晰稳定的 5–12 秒单人片段');
  } else if (durationMs < 5000 || durationMs > 15000) {
    raise(1, '时长可用，但 5–12 秒区间通常最稳（可在波形上裁剪微调）');
  }

  if (clipping) {
    raise(2, '峰值接近 0 dBFS（存在削波爆音风险），建议开启 -3 dBFS 归一化或调低麦距重录');
  } else if (rmsDb < -30) {
    raise(1, '整体响度偏低（<-30 dBFS），建议开启 -3 dBFS 归一化提升人声清晰度');
  }

  if (estimatedSnrDb !== null && estimatedSnrDb < 14) {
    raise(2, `估算信噪比偏低（约 ${estimatedSnrDb} dB），背景底噪可能被带入克隆声线`);
  }

  if (sampleRate < 16000) {
    raise(1, `采样率 ${sampleRate} Hz 偏低，建议 ≥24 kHz`);
  }

  if (hints.length === 0) {
    hints.push('时长、响度与底噪均处于推荐克隆区间，可以直接定格入库');
  }

  return {
    durationMs,
    sampleRate,
    channels,
    bitDepth,
    rmsDb,
    peakDb,
    clipping,
    estimatedSnrDb,
    grade: severity === 2 ? 'warn' : severity === 1 ? 'fair' : 'good',
    hints,
  };
}

interface StoredState {
  schemaVersion: 1;
  currentVersionId: string;
  versions: VoiceTimbreVersion[];
  characterBindings?: Record<string, string>;
}

function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

export class VoiceWorkshop {
  private readonly deps: VoiceWorkshopDeps;
  private state: StoredState;
  /** 候选索引（落 `voice-workshop/candidates/index.json`）：定格/试戴要读回描述与台词 */
  private candidates: Map<string, VoiceWorkshopCandidate>;
  /** 在飞生成任务取消控制器（jobId → AbortController） */
  private activeJobs = new Map<string, AbortController>();
  /** 本次会话（进程生命周期）已花掉的合成次数：MiMo 限免，UI 要如实显示 */
  private sessionCalls = 0;

  constructor(deps: VoiceWorkshopDeps) {
    this.deps = deps;
    mkdirSync(this.workshopDir(), { recursive: true });
    mkdirSync(this.candidatesDir(), { recursive: true });
    mkdirSync(this.versionsDir(), { recursive: true });
    this.state = this.loadState();
    this.candidates = this.loadCandidates();
  }

  /** 工坊状态（声线卡 + 版本时间线 + 多角色绑定 + 已持久化候选 + 会话调用计数） */
  snapshot(): VoiceWorkshopState {
    return {
      currentVersionId: this.state.currentVersionId,
      versions: this.state.versions,
      characterBindings: { ...(this.state.characterBindings ?? {}) },
      candidates: [...this.candidates.values()].reverse(),
      sessionCalls: this.sessionCalls,
    };
  }

  /** 中止正在进行的设计候选生成任务 */
  cancelJob(jobId: string): boolean {
    const controller = this.activeJobs.get(jobId);
    if (controller === undefined) return false;
    controller.abort();
    this.activeJobs.delete(jobId);
    return true;
  }

  /**
   * 生成候选：描述 + 拨盘 → VoiceDesign 一次一条，共 `count` 条。
   * 支持 `jobId` 中途中止；每次调用都计入会话计数；失败逐条如实抛错（不补位、不伪造候选）。
   */
  async generateCandidates(input: {
    description: string;
    dial?: VoiceWorkshopDial;
    count: number;
    previewText?: string;
    jobId?: string;
    signal?: AbortSignal;
  }): Promise<VoiceWorkshopCandidate[]> {
    const description = composeVoiceWorkshopDescription(input.description, input.dial);
    const candidates: VoiceWorkshopCandidate[] = [];
    const text = input.previewText?.trim() || MIMO_WORKSHOP_AUDITION_LINES[0].text;
    const jobController = input.jobId !== undefined ? new AbortController() : null;
    if (input.jobId !== undefined && jobController !== null) {
      this.activeJobs.set(input.jobId, jobController);
    }
    const signal = input.signal ?? jobController?.signal;
    try {
      for (let i = 0; i < input.count; i++) {
        if (signal?.aborted) {
          throw new Error('生成任务已取消');
        }
        const result = await this.synth({
          mode: 'voicedesign',
          text,
          description,
          intensity: 'B',
          ...(signal === undefined ? {} : { signal }),
        });
        if (signal?.aborted) {
          throw new Error('生成任务已取消');
        }
        const id = randomUUID();
        const file = join(this.candidatesDir(), `${id}.wav`);
        writeFileSync(file, result.bytes);
        const quality = analyzeWavBuffer(result.bytes);
        const candidate: VoiceWorkshopCandidate = {
          id,
          description,
          text,
          file,
          bytes: result.bytes.byteLength,
          durationMs: result.durationMs ?? quality?.durationMs ?? null,
          createdAt: this.iso(),
        };
        this.candidates.set(id, candidate);
        candidates.push(candidate);
      }
    } finally {
      if (input.jobId !== undefined) this.activeJobs.delete(input.jobId);
      // 中途失败或取消也要落索引：已经付过费的候选不能因为后面一条报错就丢掉
      if (this.candidates.size > 0) this.persistCandidates();
    }
    return candidates;
  }

  /**
   * 多句试戴：把候选当参考音频走 VoiceClone，套 4 句（中性/调皮/傲娇/撒娇）与所选强度。
   * 若提供 customText，则仅消耗 1 次合成试听该自定义台词，避免浪费配额。
   */
  async audition(input: {
    candidateId: string;
    intensity: VoicePerformanceIntensity;
    customText?: string;
  }): Promise<WorkshopAuditionRow[]> {
    const candidate = this.findCandidate(input.candidateId);
    return this.runAuditionWithReference({
      referencePath: candidate.file,
      description: candidate.description,
      intensity: input.intensity,
      ...(input.customText === undefined ? {} : { customText: input.customText }),
    });
  }

  /** 对已入库/已定格的任意版本（含出厂版与克隆版）进行多句或自定义试戴 */
  async auditionVersion(input: {
    versionId: string;
    intensity: VoicePerformanceIntensity;
    customText?: string;
  }): Promise<WorkshopAuditionRow[]> {
    const version = this.currentVersion(input.versionId);
    this.assertNotRevoked(version);
    const referencePath = this.effectiveReferencePath(version);
    if (!existsSync(referencePath)) {
      throw new Error(`找不到这条声线版本的参考音频：${referencePath}`);
    }
    return this.runAuditionWithReference({
      referencePath,
      description: version.description,
      intensity: input.intensity,
      ...(input.customText === undefined ? {} : { customText: input.customText }),
    });
  }

  /**
   * 定格：把 AI 设计候选音频存成本地版本、复制成主进程的克隆参考，并把当前版本指向它。
   * 只写本地；出厂版本永远在时间线里，可随时回退。
   */
  freeze(input: {
    candidateId: string;
    label?: string;
    intensity?: VoicePerformanceIntensity;
    tags?: string[];
  }): VoiceTimbreVersion {
    const candidate = this.findCandidate(input.candidateId);
    const id = randomUUID();
    const versionFile = join(this.versionsDir(), `${id}.wav`);
    copyFileSync(candidate.file, versionFile);
    copyFileSync(candidate.file, this.deps.cloneSamplePath);
    const rawBytes = new Uint8Array(readFileSync(versionFile));
    const quality = analyzeWavBuffer(rawBytes);
    const version: VoiceTimbreVersion = {
      id,
      label: input.label?.trim() !== undefined && input.label.trim() !== '' ? input.label.trim() : `AI 设计 ${this.iso().slice(0, 16).replace('T', ' ')}`,
      description: candidate.description,
      source: 'ai-design',
      referencePath: versionFile,
      referenceBytes: candidate.bytes,
      referenceSha256: sha256Hex(rawBytes),
      durationMs: candidate.durationMs ?? quality?.durationMs ?? null,
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
      originCandidateId: candidate.id,
      ...(quality === null ? {} : { audioQuality: quality }),
      ...(input.tags === undefined || input.tags.length === 0 ? {} : { tags: input.tags }),
      frozenAt: this.iso(),
      freeze: {
        text: candidate.text,
        intensity: input.intensity ?? 'B',
        provider: 'mimo-tts-voiceclone',
        mode: 'voicedesign → voiceclone',
      },
      consistency: null,
    };
    this.state.versions.push(version);
    this.state.currentVersionId = version.id;
    this.persist();
    this.deps.onReferenceChanged?.();
    return version;
  }

  /**
   * 创建克隆声线版本（支持本地音频上传、麦克风亲录、以及直接从 AI 音色设计候选/版本选取并精修裁剪）。
   * 强制 RIFF 校验、MiMo Base64 ≤ 10MB 红线、声学质检、SHA-256 与声音权属声明留痕。
   * 可选保存未裁剪原始副本（rawWavBase64）支持撤回重裁，仅裁剪后副本发往云端。
   */
  createClonedVersion(input: {
    wavBase64?: string;
    rawWavBase64?: string;
    filePath?: string;
    sourceCandidateId?: string;
    sourceVersionId?: string;
    label: string;
    description?: string;
    consent: VoiceCloneConsent;
    activate?: boolean;
    characterId?: string;
    tags?: string[];
  }): VoiceTimbreVersion {
    if (input.consent.attested !== true || input.consent.source.trim() === '') {
      throw new Error('保存克隆声线前必须确认声音权属并填写授权来源说明');
    }
    const label = input.label.trim();
    if (label === '') throw new Error('请为克隆声线填写名称');

    let originCandidate: VoiceWorkshopCandidate | null = null;
    let originVersion: VoiceTimbreVersion | null = null;
    if (input.sourceCandidateId !== undefined && input.sourceCandidateId.trim() !== '') {
      originCandidate = this.findCandidate(input.sourceCandidateId);
    }
    if (input.sourceVersionId !== undefined && input.sourceVersionId.trim() !== '') {
      originVersion = this.currentVersion(input.sourceVersionId);
      this.assertNotRevoked(originVersion);
    }

    let bytes: Uint8Array;
    if (input.wavBase64 !== undefined && input.wavBase64.trim() !== '') {
      bytes = new Uint8Array(Buffer.from(input.wavBase64, 'base64'));
    } else if (input.filePath !== undefined && input.filePath.trim() !== '') {
      if (!existsSync(input.filePath)) {
        throw new Error(`找不到指定的参考音频文件：${input.filePath}`);
      }
      bytes = new Uint8Array(readFileSync(input.filePath));
    } else if (originCandidate !== null) {
      bytes = new Uint8Array(readFileSync(originCandidate.file));
    } else if (originVersion !== null) {
      const refPath = this.effectiveReferencePath(originVersion);
      if (!existsSync(refPath)) throw new Error(`源声线版本的参考音频不存在：${refPath}`);
      bytes = new Uint8Array(readFileSync(refPath));
    } else {
      throw new Error('缺少参考音频数据（需要 wavBase64、filePath、sourceCandidateId 或 sourceVersionId）');
    }

    assertValidWavBytes(bytes);
    const quality = analyzeWavBuffer(bytes);
    const id = randomUUID();
    const versionFile = join(this.versionsDir(), `${id}.wav`);
    writeFileSync(versionFile, bytes);

    // 可选保留未裁剪原始副本（本地保存，绝不直接上传云端，方便后续撤回重裁）
    let rawReferencePath: string | undefined;
    if (input.rawWavBase64 !== undefined && input.rawWavBase64.trim() !== '') {
      const rawBuf = new Uint8Array(Buffer.from(input.rawWavBase64, 'base64'));
      if (rawBuf.byteLength >= 44 && rawBuf.byteLength <= MAX_LOCAL_RAW_WAV_BYTES) {
        const riff = String.fromCharCode(rawBuf[0] ?? 0, rawBuf[1] ?? 0, rawBuf[2] ?? 0, rawBuf[3] ?? 0);
        const wave = String.fromCharCode(rawBuf[8] ?? 0, rawBuf[9] ?? 0, rawBuf[10] ?? 0, rawBuf[11] ?? 0);
        if (riff === 'RIFF' && wave === 'WAVE') {
          rawReferencePath = join(this.versionsDir(), `${id}.raw.wav`);
          writeFileSync(rawReferencePath, rawBuf);
        }
      }
    }

    const activate = input.activate !== false;
    if (activate) {
      copyFileSync(versionFile, this.deps.cloneSamplePath);
    }

    const derivedFromAi = originCandidate !== null || (originVersion !== null && (originVersion.source === 'ai-design' || originVersion.source === 'factory'));
    const fallbackDesc = originCandidate !== null
      ? originCandidate.description
      : originVersion !== null
        ? originVersion.description
        : `本地参考音频克隆（${input.consent.source.trim()}）`;
    const description = input.description?.trim() || fallbackDesc;
    const version: VoiceTimbreVersion = {
      id,
      label,
      description,
      source: 'uploaded',
      referencePath: versionFile,
      ...(rawReferencePath === undefined ? {} : { rawReferencePath }),
      referenceBytes: bytes.byteLength,
      referenceSha256: sha256Hex(bytes),
      durationMs: quality?.durationMs ?? null,
      licenseScope: input.consent.kind === 'ai_synthetic' || derivedFromAi ? 'DEV_ONLY_NON_COMMERCIAL' : 'COMMERCIAL_READY',
      consent: input.consent,
      ...(quality === null ? {} : { audioQuality: quality }),
      ...(input.tags === undefined || input.tags.length === 0 ? {} : { tags: input.tags }),
      ...(originCandidate === null ? {} : { originCandidateId: originCandidate.id }),
      ...(originVersion === null ? {} : { originVersionId: originVersion.id }),
      frozenAt: this.iso(),
      freeze: {
        text: derivedFromAi
          ? `（AI 设计派生克隆 · ${originCandidate?.text ?? originVersion?.label ?? ''}）`
          : `（本地音频克隆 · ${input.consent.kind} · ${input.consent.source.trim()}）`,
        intensity: 'B',
        provider: 'mimo-tts-voiceclone',
        mode: derivedFromAi ? 'ai-design → trim → voiceclone' : 'uploaded → voiceclone',
      },
      consistency: null,
    };

    this.state.versions.push(version);
    if (activate) {
      this.state.currentVersionId = version.id;
      if (input.characterId !== undefined && input.characterId.trim() !== '') {
        this.state.characterBindings = {
          ...(this.state.characterBindings ?? {}),
          [input.characterId.trim()]: version.id,
        };
      }
    }
    this.persist();
    this.deps.onReferenceChanged?.();
    return version;
  }

  /** 将指定角色显式锁定到某个声线版本（支持多角色各自独立 VoiceClone 参考锚点） */
  bindCharacter(characterId: string, versionId: string): { characterId: string; version: VoiceTimbreVersion } {
    const charId = characterId.trim();
    if (charId === '') throw new Error('角色 ID 不能为空');
    const version = this.currentVersion(versionId);
    this.assertNotRevoked(version);
    const refPath = this.effectiveReferencePath(version);
    if (!existsSync(refPath)) {
      throw new Error(`该声线版本的参考音频已缺失：${refPath}`);
    }
    this.state.characterBindings = {
      ...(this.state.characterBindings ?? {}),
      [charId]: version.id,
    };
    this.persist();
    this.deps.onReferenceChanged?.();
    return { characterId: charId, version };
  }

  /** 解除角色显式绑定，恢复跟随默认/出厂声线 */
  unbindCharacter(characterId: string): { characterId: string; unbound: boolean } {
    const charId = characterId.trim();
    const map = { ...(this.state.characterBindings ?? {}) };
    const existed = charId in map;
    delete map[charId];
    this.state.characterBindings = map;
    if (existed) {
      this.persist();
      this.deps.onReferenceChanged?.();
    }
    return { characterId: charId, unbound: existed };
  }

  /**
   * 为生产播报/试听解析指定角色实际锁定的声线版本与参考音频路径。
   * 优先命中角色显式绑定 → 否则跟随全局 currentVersionId → 否则出厂。
   */
  resolveReferenceForCharacter(characterId?: string): {
    version: VoiceTimbreVersion;
    referencePath: string;
    revoked: boolean;
  } {
    const boundId = characterId !== undefined ? this.state.characterBindings?.[characterId] : undefined;
    const version = this.state.versions.find((v) => v.id === boundId)
      ?? this.state.versions.find((v) => v.id === this.state.currentVersionId)
      ?? this.state.versions[0]!;
    const revoked = version.consent?.revokedAt !== undefined;
    return {
      version,
      referencePath: this.effectiveReferencePath(version),
      revoked,
    };
  }

  /** 收藏 / 取消收藏声线版本 */
  setFavorite(versionId: string, favorite: boolean): VoiceTimbreVersion {
    const index = this.state.versions.findIndex((item) => item.id === versionId);
    if (index < 0) throw new Error('没有这个声线版本');
    const updated: VoiceTimbreVersion = { ...this.state.versions[index]!, favorite };
    this.state.versions[index] = updated;
    this.persist();
    return updated;
  }

  /** 软归档 / 取消归档声线版本（软归档不影响已有角色引用） */
  setArchived(versionId: string, archived: boolean): VoiceTimbreVersion {
    const index = this.state.versions.findIndex((item) => item.id === versionId);
    if (index < 0) throw new Error('没有这个声线版本');
    const target = this.state.versions[index]!;
    if (target.source === 'factory' && archived) {
      throw new Error('出厂默认声线受保护，不可归档');
    }
    const updated: VoiceTimbreVersion = { ...target, archivedAt: archived ? this.iso() : null };
    this.state.versions[index] = updated;
    this.persist();
    return updated;
  }

  /**
   * 撤销声音授权（合规闭环）：
   * - 立即记录 revokedAt，阻止该版本继续用于任何克隆合成/试戴/绑定
   * - 删除本地参考音频与原始副本
   * - 解绑所有引用该版本的角色；若当前激活它，自动安全回退出厂声线并触发缓存清理
   */
  revokeConsent(versionId: string, reason?: string): { version: VoiceTimbreVersion; unboundCharacters: string[] } {
    const index = this.state.versions.findIndex((item) => item.id === versionId);
    if (index < 0) throw new Error('没有这个声线版本');
    const target = this.state.versions[index]!;
    if (target.source === 'factory') {
      throw new Error('随包出厂声线不可撤权，请直接切换其他声线');
    }
    const nowIso = this.iso();
    const baseConsent: VoiceCloneConsent = target.consent ?? {
      kind: target.source === 'ai-design' ? 'ai_synthetic' : 'self_recorded',
      source: target.label,
      attested: true,
      attestedAt: target.frozenAt,
    };
    const updated: VoiceTimbreVersion = {
      ...target,
      consent: {
        ...baseConsent,
        revokedAt: nowIso,
        ...(reason !== undefined && reason.trim() !== '' ? { revokeReason: reason.trim() } : {}),
      },
      archivedAt: target.archivedAt ?? nowIso,
    };
    this.state.versions[index] = updated;

    // 清理本地参考副本与未裁剪原始副本
    for (const file of [target.referencePath, target.rawReferencePath]) {
      if (file !== undefined && existsSync(file)) {
        try { rmSync(file); } catch { /* 忽略 */ }
      }
    }

    // 解绑全部引用该版本的角色
    const unboundCharacters: string[] = [];
    const bindings = { ...(this.state.characterBindings ?? {}) };
    for (const [charId, vId] of Object.entries(bindings)) {
      if (vId === versionId) {
        delete bindings[charId];
        unboundCharacters.push(charId);
      }
    }
    this.state.characterBindings = bindings;

    if (this.state.currentVersionId === versionId) {
      if (existsSync(this.deps.cloneSamplePath)) rmSync(this.deps.cloneSamplePath);
      this.state.currentVersionId = 'factory';
    }
    this.persist();
    this.deps.onReferenceChanged?.();
    return { version: updated, unboundCharacters };
  }

  /** 重命名任意非出厂声线版本 */
  renameVersion(versionId: string, label: string): VoiceTimbreVersion {
    const trimmed = label.trim();
    if (trimmed === '') throw new Error('声线名称不能为空');
    const index = this.state.versions.findIndex((item) => item.id === versionId);
    if (index < 0) throw new Error('没有这个声线版本');
    const target = this.state.versions[index]!;
    if (target.source === 'factory') {
      throw new Error('出厂默认声线不可改名');
    }
    const updated: VoiceTimbreVersion = { ...target, label: trimmed };
    this.state.versions[index] = updated;
    this.persist();
    return updated;
  }

  /**
   * 删除任意非出厂声线版本：
   * - 若正被任一角色显式绑定，禁止永久删除，要求先解绑/替换（或使用软归档）
   * - 若删的是全局当前激活版，自动安全回退到出厂版本
   */
  deleteVersion(versionId: string): { deletedId: string; currentVersion: VoiceTimbreVersion } {
    const index = this.state.versions.findIndex((item) => item.id === versionId);
    if (index < 0) throw new Error('没有这个声线版本');
    const target = this.state.versions[index]!;
    if (target.source === 'factory') {
      throw new Error('出厂默认声线受保护，不可删除');
    }
    const boundCharacters = Object.entries(this.state.characterBindings ?? {})
      .filter(([, boundId]) => boundId === versionId)
      .map(([charId]) => charId);
    if (boundCharacters.length > 0) {
      throw new Error(`该声线正被角色（${boundCharacters.join('、')}）锁定绑定，请先解除绑定或改绑其他声线，或使用「归档」隐藏`);
    }
    this.state.versions.splice(index, 1);
    for (const file of [target.referencePath, target.rawReferencePath]) {
      if (file !== undefined && existsSync(file)) {
        try { rmSync(file); } catch { /* 忽略已被外部清理的文件 */ }
      }
    }
    if (this.state.currentVersionId === versionId) {
      const factory = this.rollback('factory');
      return { deletedId: versionId, currentVersion: factory };
    }
    this.persist();
    this.deps.onReferenceChanged?.();
    return { deletedId: versionId, currentVersion: this.currentVersion() };
  }

  /**
   * 安全读取已登记版本、未裁剪原始副本或候选的 WAV 音频（仅白名单 ID 查找，彻底杜绝路径穿越），
   * 供前端绘制真实波形、试听与重新裁剪。
   */
  readAudio(target: { kind: 'version' | 'candidate' | 'version-raw'; id: string }): {
    audioBase64: string;
    bytes: number;
    durationMs: number | null;
    quality: VoiceAudioQuality | null;
    sha256: string;
  } {
    let filePath: string;
    if (target.kind === 'candidate') {
      filePath = this.findCandidate(target.id).file;
    } else {
      const version = this.currentVersion(target.id);
      this.assertNotRevoked(version);
      filePath = target.kind === 'version-raw' && version.rawReferencePath !== undefined && existsSync(version.rawReferencePath)
        ? version.rawReferencePath
        : this.effectiveReferencePath(version);
    }
    if (!existsSync(filePath)) {
      throw new Error(`音频文件不存在：${filePath}`);
    }
    const raw = new Uint8Array(readFileSync(filePath));
    const quality = analyzeWavBuffer(raw);
    return {
      audioBase64: Buffer.from(raw).toString('base64'),
      bytes: raw.byteLength,
      durationMs: quality?.durationMs ?? null,
      quality,
      sha256: sha256Hex(raw),
    };
  }

  /** 回退到某个历史版本（含出厂）：出厂 = 删掉本地克隆参考，让主进程回落到随包基准 */
  rollback(versionId: string): VoiceTimbreVersion {
    const version = this.state.versions.find((item) => item.id === versionId);
    if (version === undefined) throw new Error('没有这个声线版本');
    this.assertNotRevoked(version);
    if (version.source === 'factory') {
      if (existsSync(this.deps.cloneSamplePath)) rmSync(this.deps.cloneSamplePath);
    } else {
      if (!existsSync(version.referencePath)) {
        throw new Error(`这条版本的参考音频已经不在磁盘上：${version.referencePath}`);
      }
      copyFileSync(version.referencePath, this.deps.cloneSamplePath);
    }
    this.state.currentVersionId = version.id;
    this.persist();
    this.deps.onReferenceChanged?.();
    return version;
  }

  /**
   * 一致性体检：同一句 ×10 真实克隆 → 说话人余弦（外部 CAM++ 工具）。
   * 工具不可用时返回 `unavailable` 并写清原因，**绝不拿时长/能量冒充说话人相似度**。
   */
  async checkConsistency(versionId?: string): Promise<VoiceConsistencyResult> {
    const version = this.currentVersion(versionId);
    this.assertNotRevoked(version);
    const referencePath = this.effectiveReferencePath(version);
    if (!existsSync(referencePath)) {
      return this.storeConsistency(version, {
        verdict: 'unavailable',
        detail: `找不到这条声线的参考音频：${referencePath}`,
        mean: null,
        min: null,
        std: null,
        samples: 0,
        checkedAt: this.iso(),
      });
    }
    const dir = join(this.workshopDir(), 'consistency', randomUUID());
    mkdirSync(dir, { recursive: true });
    const wavs: string[] = [];
    for (let i = 1; i <= CONSISTENCY_SAMPLES; i++) {
      const result = await this.synth({
        mode: 'voiceclone',
        text: CONSISTENCY_SENTENCE,
        description: version.description,
        intensity: 'A',
        referencePath,
      });
      const file = join(dir, `sample-${i}.wav`);
      writeFileSync(file, result.bytes);
      wavs.push(file);
    }
    const runner = this.deps.runSpeakerCosine;
    const stats = runner === undefined ? null : await runner(wavs);
    if (stats === null) {
      return this.storeConsistency(version, {
        verdict: 'unavailable',
        detail: '本机没有可用的说话人嵌入工具（需要仓库内 tools/scripts/speaker-cosine.py + uv + sherpa-onnx），本次只跑了 10 条合成，不给假数字',
        mean: null,
        min: null,
        std: null,
        samples: CONSISTENCY_SAMPLES,
        checkedAt: this.iso(),
      });
    }
    const judged = verdictFor(stats.mean, stats.min);
    return this.storeConsistency(version, {
      verdict: judged.verdict,
      detail: judged.detail,
      mean: stats.mean,
      min: stats.min,
      std: stats.std,
      samples: CONSISTENCY_SAMPLES,
      checkedAt: this.iso(),
    });
  }

  /** 每个候选都可以再生成一次描述（UI 里展示「这条候选实际发出去的描述」） */
  describe(dial?: VoiceWorkshopDial): Array<{ key: string; label: string; options: ReadonlyArray<{ value: string; label: string; phrase: string }> }> {
    void dial;
    return VOICE_WORKSHOP_DIAL_OPTIONS.map((group) => ({
      key: group.key,
      label: group.label,
      options: group.options,
    }));
  }

  private assertNotRevoked(version: VoiceTimbreVersion): void {
    if (version.consent?.revokedAt !== undefined) {
      throw new Error(`声线「${version.label}」已于 ${version.consent.revokedAt.slice(0, 10)} 撤销授权，已禁止继续用于合成、试戴或绑定`);
    }
  }

  private async runAuditionWithReference(input: {
    referencePath: string;
    description: string;
    intensity: VoicePerformanceIntensity;
    customText?: string;
  }): Promise<WorkshopAuditionRow[]> {
    const custom = input.customText?.trim();
    const lines = custom !== undefined && custom !== ''
      ? [{ key: 'custom', label: '自定义', emotion: null as string | null, text: custom }]
      : MIMO_WORKSHOP_AUDITION_LINES.map((line) => ({
          key: line.key as string,
          label: line.label as string,
          emotion: line.emotion as string | null,
          text: line.text as string,
        }));
    const out: WorkshopAuditionRow[] = [];
    for (const line of lines) {
      const result = await this.synth({
        mode: 'voiceclone',
        text: line.text,
        description: input.description,
        ...(line.emotion === null ? {} : { emotion: line.emotion }),
        intensity: input.intensity,
        referencePath: input.referencePath,
      });
      const quality = analyzeWavBuffer(result.bytes);
      out.push({
        key: line.key,
        label: line.label,
        emotion: line.emotion,
        intensity: input.intensity,
        text: line.text,
        audioBase64: Buffer.from(result.bytes).toString('base64'),
        providerKind: result.providerKind,
        durationMs: result.durationMs ?? quality?.durationMs ?? null,
      });
    }
    return out;
  }

  private currentVersion(versionId?: string): VoiceTimbreVersion {
    const id = versionId ?? this.state.currentVersionId;
    const version = this.state.versions.find((item) => item.id === id);
    if (version === undefined) throw new Error('当前声线版本不存在，请重新选择一个版本');
    return version;
  }

  /** 体检要对着「这条声线实际在用的参考音频」跑：出厂版就是随包文件，其它版本是本地副本 */
  private effectiveReferencePath(version: VoiceTimbreVersion): string {
    return version.source === 'factory' ? this.deps.bundledReferencePath : version.referencePath;
  }

  private storeConsistency(version: VoiceTimbreVersion, result: VoiceConsistencyResult): VoiceConsistencyResult {
    const index = this.state.versions.findIndex((item) => item.id === version.id);
    if (index >= 0) {
      this.state.versions[index] = { ...this.state.versions[index]!, consistency: result };
      this.persist();
    }
    return result;
  }

  private findCandidate(candidateId: string): VoiceWorkshopCandidate {
    const candidate = this.candidates.get(candidateId);
    if (candidate === undefined || !existsSync(candidate.file)) {
      throw new Error('找不到这条候选（可能已被清理），请重新生成');
    }
    return candidate;
  }

  private candidatesIndexPath(): string {
    return join(this.candidatesDir(), 'index.json');
  }

  private loadCandidates(): Map<string, VoiceWorkshopCandidate> {
    const map = new Map<string, VoiceWorkshopCandidate>();
    try {
      const rows = JSON.parse(readFileSync(this.candidatesIndexPath(), 'utf8')) as VoiceWorkshopCandidate[];
      for (const row of rows) {
        if (typeof row?.id === 'string' && typeof row?.file === 'string' && existsSync(row.file)) map.set(row.id, row);
      }
    } catch {
      /* 没有索引就当作空（候选随时可以重新生成） */
    }
    return map;
  }

  private persistCandidates(): void {
    writeFileAtomic(this.candidatesIndexPath(), JSON.stringify([...this.candidates.values()], null, 2));
  }

  private async synth(input: WorkshopSynthInput): Promise<WorkshopSynthResult> {
    this.sessionCalls++;
    return this.deps.synth(input);
  }

  private workshopDir(): string {
    return join(this.deps.userDataDir, 'voice-workshop');
  }
  private candidatesDir(): string {
    return join(this.workshopDir(), 'candidates');
  }
  private versionsDir(): string {
    return join(this.workshopDir(), 'versions');
  }
  private statePath(): string {
    return join(this.workshopDir(), 'state.json');
  }
  private iso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private factoryVersion(): VoiceTimbreVersion {
    let bytes = 0;
    let sha: string | undefined;
    let quality: VoiceAudioQuality | null = null;
    if (existsSync(this.deps.bundledReferencePath)) {
      bytes = statSync(this.deps.bundledReferencePath).size;
      try {
        const raw = new Uint8Array(readFileSync(this.deps.bundledReferencePath));
        sha = sha256Hex(raw);
        quality = analyzeWavBuffer(raw);
      } catch {
        /* 读失败时保持字节数 */
      }
    }
    return {
      id: 'factory',
      label: this.deps.bundledLabel,
      description: this.deps.bundledDescription,
      source: 'factory',
      referencePath: this.deps.bundledReferencePath,
      referenceBytes: bytes,
      ...(sha === undefined ? {} : { referenceSha256: sha }),
      durationMs: quality?.durationMs ?? null,
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
      ...(quality === null ? {} : { audioQuality: quality }),
      tags: ['出厂定稿', '甜脆', '元气'],
      frozenAt: this.iso(),
      freeze: {
        text: '（随包出厂参考音频，自产台词与生成命令见 assets/voice/README.md）',
        intensity: 'A',
        provider: 'mimo-tts-voicedesign',
        mode: 'voicedesign → voiceclone',
      },
      consistency: null,
    };
  }

  private loadState(): StoredState {
    const factory = this.factoryVersion();
    try {
      const raw = JSON.parse(readFileSync(this.statePath(), 'utf8')) as StoredState;
      if (Array.isArray(raw.versions) && typeof raw.currentVersionId === 'string') {
        // 出厂版本始终排在时间线最前，且不允许被删掉；
        // 但体检结论 / 定格时间这些「跑出来的事实」要沿用磁盘上的，否则重启就丢。
        const storedFactory = raw.versions.find((item) => item?.id === 'factory');
        const nextFactory: VoiceTimbreVersion = storedFactory === undefined
          ? this.factoryVersion()
          : {
              ...this.factoryVersion(),
              frozenAt: typeof storedFactory.frozenAt === 'string' ? storedFactory.frozenAt : this.iso(),
              consistency: storedFactory.consistency ?? null,
            };
        const others = raw.versions.filter((item) => item.id !== 'factory' && typeof item.id === 'string');
        const validIds = new Set(['factory', ...others.map((v) => v.id)]);
        const current = validIds.has(raw.currentVersionId) ? raw.currentVersionId : 'factory';
        const bindings: Record<string, string> = {};
        if (raw.characterBindings !== undefined && typeof raw.characterBindings === 'object' && raw.characterBindings !== null) {
          for (const [charId, vId] of Object.entries(raw.characterBindings)) {
            if (typeof charId === 'string' && charId.trim() !== '' && typeof vId === 'string' && validIds.has(vId)) {
              bindings[charId] = vId;
            }
          }
        }
        return { schemaVersion: 1, currentVersionId: current, versions: [nextFactory, ...others], characterBindings: bindings };
      }
    } catch {
      /* 首次运行或状态文件损坏：回到出厂版本，用户可在 UI 里重新定格 */
    }
    return { schemaVersion: 1, currentVersionId: 'factory', versions: [factory], characterBindings: {} };
  }

  private persist(): void {
    writeFileAtomic(this.statePath(), JSON.stringify(this.state, null, 2));
  }
}

/**
 * 说话人余弦工具：只在开发态可用（仓库内 tools/scripts/speaker-cosine.py + uv）。
 * 打包态工具不存在 → 返回 null，调用方写 `unavailable`，不给假数字。
 */
export function createSpeakerCosineRunner(): SpeakerCosineRunner {
  return async (wavPaths) => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const script = join(repoRoot, 'tools', 'scripts', 'speaker-cosine.py');
    if (!existsSync(script) || wavPaths.length < 2) return null;
    const output = await new Promise<string | null>((resolve) => {
      const child = spawn('uv', ['run', '--quiet', '--with', 'numpy', '--with', 'sherpa-onnx', 'python', '-I', script, ...wavPaths], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 300_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? stdout : null);
      });
    });
    if (output === null) return null;
    const line = output.split('\n').find((item) => item.includes('余弦') && item.includes('均值'));
    if (line === undefined) return null;
    const mean = /均值\s*([0-9.]+)/.exec(line)?.[1];
    const min = /最小\s*([0-9.]+)/.exec(line)?.[1];
    const std = /标准差\s*([0-9.]+)/.exec(line)?.[1];
    if (mean === undefined || min === undefined || std === undefined) return null;
    return { mean: Number(mean), min: Number(min), std: Number(std) };
  };
}
