/**
 * 音色工坊（M1 + M2）：声线版本管理、一致性体检、候选生成与多句试戴。
 *
 * 设计边界（owner 2026-11-27 拍板）：
 * - **出厂默认不动**：随包 `assets/voice/xiaojing-07-tiancui-yuanqi.wav` 永远是出厂版本；
 *   用户「定格」只写 `userData/`（状态 json + 参考音频副本），不进 git。
 * - **定格 = 写本地克隆参考**：定格把候选音频复制成 `voice-clone-sample.wav`（主进程既有的 clone 源），
 *   所以运行期不需要新链路；回退到出厂就是把这份副本删掉，让主进程回落到随包基准。
 * - **一致性体检沿用既有工具**：`tools/scripts/speaker-cosine.py`（sherpa-onnx CAM++）+ 同一句 ×10 真实克隆。
 *   开发态可直接跑；打包态没有 tools 目录就不给假数字，返回 `unavailable` 并写清原因。
 * - **不做 M3**：上传录音通道、音色包导入导出、换引擎一键重做都不在这里留入口；元数据先存全。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  composeVoiceWorkshopDescription,
  MIMO_WORKSHOP_AUDITION_LINES,
  VOICE_WORKSHOP_DIAL_OPTIONS,
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
  now?: () => Date;
}

/** 体检用的固定句（与 bench 同句，便于和历史数字横比） */
export const CONSISTENCY_SENTENCE = '主人，今天也辛苦啦，我给你倒杯热茶好不好呀。';
/** 体检样本数：固定 10 条（UI 跑前要提示消耗 10 次合成） */
export const CONSISTENCY_SAMPLES = 10;

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

interface StoredState {
  schemaVersion: 1;
  currentVersionId: string;
  versions: VoiceTimbreVersion[];
}


export class VoiceWorkshop {
  private readonly deps: VoiceWorkshopDeps;
  private state: StoredState;
  /** 候选索引（落 `voice-workshop/candidates/index.json`）：定格/试戴要读回描述与台词 */
  private candidates: Map<string, VoiceWorkshopCandidate>;
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

  /** 工坊状态（声线卡 + 版本时间线 + 会话调用计数） */
  snapshot(): VoiceWorkshopState {
    return {
      currentVersionId: this.state.currentVersionId,
      versions: this.state.versions,
      sessionCalls: this.sessionCalls,
    };
  }

  /**
   * 生成候选：描述 + 拨盘 → VoiceDesign 一次一条，共 `count` 条。
   * 每次调用都计入会话计数；失败逐条如实抛错（不补位、不伪造候选）。
   */
  async generateCandidates(input: {
    description: string;
    dial?: VoiceWorkshopDial;
    count: number;
  }): Promise<VoiceWorkshopCandidate[]> {
    const description = composeVoiceWorkshopDescription(input.description, input.dial);
    const candidates: VoiceWorkshopCandidate[] = [];
    const text = MIMO_WORKSHOP_AUDITION_LINES[0].text;
    try {
      for (let i = 0; i < input.count; i++) {
        const result = await this.synth({
          mode: 'voicedesign',
          text,
          description,
          intensity: 'B',
        });
        const id = randomUUID();
        const file = join(this.candidatesDir(), `${id}.wav`);
        writeFileSync(file, result.bytes);
        const candidate: VoiceWorkshopCandidate = {
          id,
          description,
          text,
          file,
          bytes: result.bytes.byteLength,
          durationMs: result.durationMs ?? null,
          createdAt: this.iso(),
        };
        this.candidates.set(id, candidate);
        candidates.push(candidate);
      }
    } finally {
      // 中途失败也要落索引：已经付过费的候选不能因为后面一条报错就丢掉
      if (this.candidates.size > 0) this.persistCandidates();
    }
    return candidates;
  }

  /**
   * 多句试戴：把候选当参考音频走 VoiceClone，套 4 句（中性/调皮/傲娇/撒娇）与所选强度。
   * 音色是在情绪里显形的——只试一句很容易选错，所以固定四句一起出。
   */
  async audition(input: {
    candidateId: string;
    intensity: VoicePerformanceIntensity;
  }): Promise<Array<{ key: string; label: string; emotion: string | null; intensity: VoicePerformanceIntensity; text: string; audioBase64: string; providerKind: string; durationMs: number | null }>> {
    const candidate = this.findCandidate(input.candidateId);
    const out: Array<{ key: string; label: string; emotion: string | null; intensity: VoicePerformanceIntensity; text: string; audioBase64: string; providerKind: string; durationMs: number | null }> = [];
    for (const line of MIMO_WORKSHOP_AUDITION_LINES) {
      const result = await this.synth({
        mode: 'voiceclone',
        text: line.text,
        description: candidate.description,
        ...(line.emotion === null ? {} : { emotion: line.emotion }),
        intensity: input.intensity,
        referencePath: candidate.file,
      });
      out.push({
        key: line.key,
        label: line.label,
        emotion: line.emotion,
        intensity: input.intensity,
        text: line.text,
        audioBase64: Buffer.from(result.bytes).toString('base64'),
        providerKind: result.providerKind,
        durationMs: result.durationMs ?? null,
      });
    }
    return out;
  }

  /**
   * 定格：把候选音频存成本地版本、复制成主进程的克隆参考，并把当前版本指向它。
   * 只写本地；出厂版本永远在时间线里，可随时回退。
   */
  freeze(input: { candidateId: string; label?: string; intensity?: VoicePerformanceIntensity }): VoiceTimbreVersion {
    const candidate = this.findCandidate(input.candidateId);
    const id = randomUUID();
    const versionFile = join(this.versionsDir(), `${id}.wav`);
    copyFileSync(candidate.file, versionFile);
    copyFileSync(candidate.file, this.deps.cloneSamplePath);
    const version: VoiceTimbreVersion = {
      id,
      label: input.label?.trim() !== undefined && input.label.trim() !== '' ? input.label.trim() : `AI 设计 ${this.iso().slice(0, 16).replace('T', ' ')}`,
      description: candidate.description,
      source: 'ai-design',
      referencePath: versionFile,
      referenceBytes: candidate.bytes,
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
    return version;
  }

  /** 回退到某个历史版本（含出厂）：出厂 = 删掉本地克隆参考，让主进程回落到随包基准 */
  rollback(versionId: string): VoiceTimbreVersion {
    const version = this.state.versions.find((item) => item.id === versionId);
    if (version === undefined) throw new Error('没有这个声线版本');
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
    return version;
  }

  /**
   * 一致性体检：同一句 ×10 真实克隆 → 说话人余弦（外部 CAM++ 工具）。
   * 工具不可用时返回 `unavailable` 并写清原因，**绝不拿时长/能量冒充说话人相似度**。
   */
  async checkConsistency(versionId?: string): Promise<VoiceConsistencyResult> {
    const version = this.currentVersion(versionId);
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
    return VOICE_WORKSHOP_DIAL_OPTIONS.map((group) => ({
      key: group.key,
      label: group.label,
      options: group.options,
    }));
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
    writeFileSync(this.candidatesIndexPath(), JSON.stringify([...this.candidates.values()], null, 2));
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
    const bytes = existsSync(this.deps.bundledReferencePath) ? statSync(this.deps.bundledReferencePath).size : 0;
    return {
      id: 'factory',
      label: this.deps.bundledLabel,
      description: this.deps.bundledDescription,
      source: 'factory',
      referencePath: this.deps.bundledReferencePath,
      referenceBytes: bytes,
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
        const factory: VoiceTimbreVersion = storedFactory === undefined
          ? this.factoryVersion()
          : {
              ...this.factoryVersion(),
              frozenAt: typeof storedFactory.frozenAt === 'string' ? storedFactory.frozenAt : this.iso(),
              consistency: storedFactory.consistency ?? null,
            };
        const others = raw.versions.filter((item) => item.id !== 'factory' && typeof item.id === 'string');
        const current = raw.currentVersionId === 'factory' || others.some((item) => item.id === raw.currentVersionId)
          ? raw.currentVersionId
          : 'factory';
        return { schemaVersion: 1, currentVersionId: current, versions: [factory, ...others] };
      }
    } catch {
      /* 首次运行或状态文件损坏：回到出厂版本，用户可在 UI 里重新定格 */
    }
    return { schemaVersion: 1, currentVersionId: 'factory', versions: [factory] };
  }

  private persist(): void {
    writeFileSync(this.statePath(), JSON.stringify(this.state, null, 2));
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
