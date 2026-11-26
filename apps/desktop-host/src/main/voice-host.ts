/**
 * 语音宿主（D11 第一版）：macOS `say` 引擎——零外部依赖（D14 独立运行）。
 * 场景矩阵（PRODUCT-DESIGN §2.4）：
 *   - 正式台词（chat_reply/回执播报）→ 正常音量+语速
 *   - 内心戏心声 → 音量 45% + 语速 0.82（低语感）
 *   - P0 雷区反射 → 立即打断当前播报（单端不变式）
 *   - 同文本 8s 节流；节流命中补发 completed 终态（T-A 2026-11-24：气泡不挂 60s TTL）
 *   - 终态闭合不变式：凡气泡在等待语音收口，必有且仅有一个 speech-result 终态；
 *     空台词/内心戏关闭不广播等待气泡，故不发回执（见 speak 内注释）。队列串行（active≤1）
 * 后续：Windows SAPI（PowerShell Add-Type）在 T-M6-05 打包工单做平台适配。
 */
import { ipcMain } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoopSpeakerEvent } from '@workbench/shared-protocol';
import { GlobalAudioLeaseManager } from './audio-lease';

export interface VoiceScene {
  /** 台词 */
  text: string;
  /** 场景：normal 正式 / inner 内心戏 / p0 雷区 */
  scene?: 'normal' | 'inner' | 'p0';
  /** T-M6-38：多桌宠归属（默认 default，兼容旧单窗） */
  agentId?: string;
  /** 说话人显示名（群聊/发言态广播） */
  speakerName?: string;
  /** 角色包 id；未显式给 voiceId 时由宿主按注册表解析该角色默认音色 */
  characterId?: string;
  /** 显式音色覆盖（高于角色默认音色） */
  voiceId?: string;
  /** 角色级语速/音高微调（T-M6-41） */
  ratePercent?: number;
  pitchMul?: number;
}

export interface VoiceConfig {
  enabled: boolean;
  innerVoice: boolean;
  volume: number; // 0-1
  ratePercent: number; // 基准语速百分比（say -r 字/分钟，默认 200）
  voice: string;
  /** mcode 音色 id（音色页可选；默认定稿音色） */
  voiceId: string;
  /** 音调倍率（D11 萝莉音）：1.0=原声；1.18=轻萝莉；1.25=标准萝莉；1.32=高音萝莉。
   *  实现：say 输出 aiff → ffmpeg asetrate 变调（+4 半音≈1.25）→ afplay 播放 */
  pitchMul: number;
}

const DEFAULT_CONFIG: VoiceConfig = {
  enabled: true,
  innerVoice: true,
  volume: 1,
  ratePercent: 100,
  voice: 'Tingting',
  voiceId: 'qiaopi_mengmei', // = MCODE_VOICE_ID（常量声明在本文件后方，避免 TDZ）
  pitchMul: 1.25, // 默认标准萝莉（+4 半音，say 回落链用）
};

const SCENE_RATE: Record<string, number> = { normal: 1, inner: 0.82, p0: 1.15 };
const SCENE_TAG: Record<string, string> = { normal: '台词', inner: '心声', p0: '反射' };

// ---- D11 定稿音色：mcode-tools「俏皮萌妹」（voice-preset.json 五档，用户 2026-11-22 确认） ----
export interface McodeMode {
  label: string; emotion: string; pitch: number; speed: number; volume: number;
}
/** 音色目录（可选音色，工作台音色页可选；来自 mcode matrix TTS 的音色库） */
export interface McodeVoiceOption {
  id: string;
  label: string;
  desc: string;
}
export const MCODE_VOICES: McodeVoiceOption[] = [
  { id: 'qiaopi_mengmei', label: '俏皮萌妹', desc: '13-16 岁二次元少女，清亮甜美＋娇俏懒散反差（默认，已定稿）' },
  { id: 'diadia_xuemei', label: '嗲嗲学妹', desc: '软糯撒娇学妹音，尾音拖腔重' },
  { id: 'Chinese (Mandarin)_Crisp_Girl', label: '清脆少女', desc: '清亮干脆的标准少女音，咬字清晰' },
  { id: 'Arrogant_Miss', label: '傲娇大小姐', desc: '高傲挑剔的大小姐音，适合傲娇炸毛' },
  { id: 'Chinese (Mandarin)_Stubborn_Friend', label: '倔强朋友', desc: '带点倔强的同级生口吻' },
];
export const MCODE_VOICE_ID = 'qiaopi_mengmei';
export const MCODE_MODES: Record<string, McodeMode> = {
  daily:    { label: '软萌小女仆', emotion: 'happy',     pitch: 0,  speed: 0.95, volume: 1.0 },
  bright:   { label: '俏皮上扬',   emotion: 'happy',     pitch: 4,  speed: 1.05, volume: 1.05 },
  tsundere: { label: '傲娇炸毛',   emotion: 'angry',     pitch: 12, speed: 1.60, volume: 2.0 },
  sleepy:   { label: '慵懒气声',   emotion: 'neutral',   pitch: -4, speed: 0.75, volume: 0.45 },
  surprised:{ label: '惊喜元气',   emotion: 'surprised',pitch: 6,  speed: 1.10, volume: 1.25 },
};
/** D11 场景 → mcode 档位（内心戏=慵懒气声、P0 反射=傲娇炸毛、正式=软萌日常） */
const SCENE_MODE: Record<string, string> = { normal: 'daily', inner: 'sleepy', p0: 'tsundere' };

export interface VoiceHost {
  /** 入队播报（场景音速自动调整）；queued=true 表示已排队，不是已播放 */
  speak(voice: VoiceScene): { ok: boolean; error?: string; queued?: boolean; leaseId?: string };
  readonly config: VoiceConfig;
  setConfig(patch: Partial<VoiceConfig>): VoiceConfig;
  /** 当前全局抢麦状态（多桌宠动作/UI 高亮共用） */
  speakerState(): CoopSpeakerEvent;
  /** 应用退出：停止在播并清空队列 */
  stopAll(): void;
}

/** 实际语音后端（T-M6-33）：界面如实展示「现在到底用哪条链路发声」，不再让用户以为一定是角色 TTS。 */
export type VoiceBackend = 'mcode' | 'say' | 'unsupported';

export interface VoiceBackendInfo {
  backend: VoiceBackend;
  /** 人类可读的后端说明（用于顶栏/设置页 title） */
  detail: string;
}

/**
 * 探测实际语音后端（只读：查一次 PATH，不发声）。
 * - 非 darwin → unsupported（Windows/Linux 语音适配尚未完成，如实报）
 * - darwin 且有 mcode-tools → mcode（首选角色音色链）
 * - darwin 否则 → say（系统语音兜底；不是角色 TTS）
 */
export function detectVoiceBackend(
  platform: string = process.platform,
  hasCommand: (command: string) => boolean = defaultHasCommand,
): VoiceBackendInfo {
  let info: VoiceBackendInfo;
  if (platform !== 'darwin') {
    info = { backend: 'unsupported', detail: `平台 ${platform} 语音引擎待适配（当前仅 macOS）` };
  } else if (hasCommand('mcode-tools')) {
    info = { backend: 'mcode', detail: 'mcode-tools「俏皮萌妹」→ 失败时回落 macOS say' };
  } else {
    info = { backend: 'say', detail: 'macOS 系统语音 say（未检测到 mcode-tools，非角色 TTS）' };
  }
  return info;
}

function defaultHasCommand(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore', timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** mcode-tools 合成链：connector batch_text_to_audio → get_asset_url → afplay（用户定稿音色管线） */
function speakViaMcode(
  text: string,
  mode: string,
  voiceId: string,
  onPlayer?: (player: ChildProcess | null) => void,
): Promise<void> {
  const m = MCODE_MODES[mode] ?? MCODE_MODES.daily!;
  return new Promise<void>((resolve, reject) => {
    try {
      const tmpDir = mkdtempSync(join(tmpdir(), 'whale-mcode-'));
      const out = join(tmpDir, 'out.mp3');
      const argsFile = join(tmpDir, 'args.json');
      writeFileSync(argsFile, JSON.stringify({ requests: [{
        voice_id: voiceId, emotion: m.emotion, pitch: m.pitch,
        speed: m.speed, volume: m.volume, text, output_file: out,
      }] }));
      const res = JSON.parse(execFileSync('mcode-tools', ['connector', 'call',
        'connector__matrix__batch_text_to_audio', '--args-file', argsFile],
        { encoding: 'utf8', timeout: 60_000 }) as string) as { success_items?: Array<{ node_id: string }>; message?: string };
      if (!res.success_items?.[0]) { reject(new Error('mcode 合成失败')); return; }
      const url = JSON.parse(execFileSync('mcode-tools', ['get_asset_url', res.success_items[0].node_id],
        { encoding: 'utf8', timeout: 15_000 }) as string) as { download_url?: string };
      if (!url.download_url) { reject(new Error('无下载地址')); return; }
      execFileSync('curl', ['-sL', '-m', '60', '-o', out, url.download_url], { timeout: 70_000 });
      const player = spawn('afplay', [out], { stdio: 'ignore' });
      onPlayer?.(player);
      player.on('exit', () => { onPlayer?.(null); void rmSync(tmpDir, { recursive: true, force: true }); resolve(); });
      player.on('error', () => { onPlayer?.(null); reject(new Error('afplay 失败')); });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface PlaybackControl {
  done: Promise<void>;
  abort(): void;
}


/** 启动一个子进程并等待退出；abort 时杀当前段，保证下一条语音能开始。 */
function runProcess(command: string, args: string[], onSpawn: (proc: ChildProcess | null) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'ignore' });
    onSpawn(proc);
    proc.on('exit', (code) => {
      onSpawn(null);
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${String(code)}`));
    });
    proc.on('error', (error) => {
      onSpawn(null);
      reject(error);
    });
  });
}

/** say 合成链（D11 萝莉音）：say aiff → 可选 ffmpeg 变调 → afplay，整链可中断。 */
function playViaSay(config: VoiceConfig, rate: number, text: string, pitchMul: number): PlaybackControl {
  const tmpDir = mkdtempSync(join(tmpdir(), 'whale-voice-'));
  const aiff = join(tmpDir, 'say.aiff');
  const wav = join(tmpDir, 'loli.wav');
  let current: ChildProcess | null = null;
  let aborted = false;
  const onSpawn = (proc: ChildProcess | null): void => {
    current = proc;
    if (aborted && proc !== null) proc.kill('SIGKILL');
  };
  const done = (async () => {
    try {
      await runProcess('say', ['-v', config.voice, '-r', String(rate), '-o', aiff, text], onSpawn);
      if (aborted) return;
      const playPath = pitchMul > 1.001 ? wav : aiff;
      if (pitchMul > 1.001) {
        await runProcess('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff,
          '-filter:a', `asetrate=22050*${pitchMul.toFixed(3)},aresample=22050,atempo=0.94`, wav], onSpawn);
      }
      if (aborted) return;
      await runProcess('afplay', [playPath], onSpawn);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
  return {
    done,
    abort() {
      aborted = true;
      current?.kill('SIGKILL');
    },
  };
}

/** 首选 mcode 角色音色 → 失败回落 say 变调链；整个降级链共享一个可中断句柄。 */
function playVoice(config: VoiceConfig, scene: string, sceneMode: string, text: string, spoken: string, voiceId: string): PlaybackControl {
  let active: PlaybackControl | null = null;
  let mcodePlayer: ChildProcess | null = null;
  let aborted = false;
  const done = (async () => {
    try {
      active = {
        done: speakViaMcode(text, sceneMode, voiceId, (player) => {
          mcodePlayer = player;
          if (aborted) player?.kill('SIGKILL');
        }),
        abort() { mcodePlayer?.kill('SIGKILL'); },
      };
      await active.done;
    } catch {
      if (aborted) return;
      const rate = Math.round(200 * (config.ratePercent / 100) * (SCENE_RATE[scene] ?? 1));
      active = playViaSay(config, rate, spoken, config.pitchMul);
      await active.done;
    }
  })();
  return {
    done,
    abort() {
      aborted = true;
      active?.abort();
      mcodePlayer?.kill('SIGKILL');
    },
  };
}


/** 音色试听的合成入参：voiceId 是 UI 音色库里的 id，mode 是五档情绪档位 */
export interface VoiceAuditionInput {
  voiceId: string;
  mode: string;
  text: string;
}

/** 合成结果：只有真实拿到音频才算 ok；`system-direct` 这类只给口型帧的后端不算 */
export interface VoiceAuditionOutput {
  providerKind: string;
  format: string;
  audioBase64?: string;
  degraded?: boolean;
  degradedFrom?: string;
}

export type VoiceAuditionSynth = (input: VoiceAuditionInput) => Promise<VoiceAuditionOutput>;

export interface VoiceHostIpcOptions {
  /**
   * 试听的真实合成实现（注入 V2 `VoiceProviderRouter`，走用户选中的商业 provider）。
   * 不注入时退回旧的 mcode→say 链——只在没接 V2 路由的旧装配里出现。
   */
  synthesizeAudition?: VoiceAuditionSynth;
}

/**
 * 把合成结果落临时文件后用 afplay 播放（试听专用，不改全局配置）。
 * Windows/Linux 播放链尚未适配，如实报错，不假装放过。
 */
async function playBase64Audio(base64: string, format: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`试听播放尚未适配 ${process.platform}（当前仅 macOS afplay）`);
  }
  const ext = format === 'mp3' ? 'mp3' : format === 'ogg' ? 'ogg' : 'wav';
  const dir = mkdtempSync(join(tmpdir(), 'whale-audition-'));
  const file = join(dir, `preview.${ext}`);
  writeFileSync(file, Buffer.from(base64, 'base64'));
  try {
    await new Promise<void>((resolve, reject) => {
      const player = spawn('afplay', [file], { stdio: 'ignore' });
      player.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`afplay 退出码 ${String(code)}`));
      });
      player.on('error', (err) => reject(err));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function registerVoiceHostIpc(host: VoiceHost, options: VoiceHostIpcOptions = {}): void {
  ipcMain.handle('voice:speak', (_e, voice: VoiceScene) => host.speak(voice));
  // T-M6-33：实际后端探测（界面如实展示 mcode / say / 未适配）
  ipcMain.handle('voice:backend', () => detectVoiceBackend());
  /**
   * 音色试听（音色页 5×5 矩阵）：
   * 历史缺陷——这里曾**无条件** `spawn('mcode-tools')`，既不看 prefs 里选中的商业 provider，
   * 也不探测二进制是否存在，本机没装 mcode-tools 时把 `spawnSync mcode-tools ENOENT` 原样甩给用户。
   * 现在：有注入路由就走 V2 `VoiceProviderRouter`（选中商业 provider 优先）；
   * 没有注入才退回旧链，并且先探测 mcode-tools，缺失时给人话错误。
   */
  ipcMain.handle('voice:audition', async (_e, voiceId: string, mode: string, text?: string) => {
    const probe = text ?? '哼，本鱼才没有偷懒呢！主人快夸夸我嘛～';
    if (options.synthesizeAudition !== undefined) {
      try {
        const out = await options.synthesizeAudition({ voiceId: String(voiceId), mode: String(mode), text: probe });
        if (out.audioBase64 === undefined || out.audioBase64 === '') {
          return {
            ok: false,
            error: `${out.providerKind} 只返回口型帧、没有可播放音频；试听需要可用的商业 TTS 凭据`,
          };
        }
        await playBase64Audio(out.audioBase64, out.format);
        return {
          ok: true,
          providerKind: out.providerKind,
          degraded: out.degraded === true,
          ...(out.degradedFrom === undefined ? {} : { degradedFrom: out.degradedFrom }),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!defaultHasCommand('mcode-tools')) {
      return {
        ok: false,
        error: '本机没有 mcode-tools，且未接入 V2 语音路由——试听需要先在凭据页配置商业 TTS（MiniMax / OpenAI 兼容 / MiMo）',
      };
    }
    try {
      await speakViaMcode(probe, mode, voiceId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('voice:catalog', () => ({
    voices: MCODE_VOICES,
    modes: Object.entries(MCODE_MODES).map(([id, m]) => ({ id, ...m })),
    currentVoiceId: host.config.voiceId,
  }));
  ipcMain.handle('voice:config:get', () => host.config);
  ipcMain.handle('voice:config:set', (_e, patch: Partial<VoiceConfig>) => host.setConfig(patch));
}

export interface VoiceHostSpeechResult {
  agentId: string;
  speakerName: string;
  status: 'completed' | 'failed' | 'timeout' | 'interrupted' | 'cancelled';
}

export interface VoiceHostPlaybackInput {
  text: string;
  voiceId: string;
  scene: string;
}

export interface CreateVoiceHostOptions {
  /** character-registry 注入：charId → 默认 voiceId */
  resolveVoiceId?: (characterId: string) => string | null;
  /** 主进程广播 coop:speaker（所有桌宠窗 + 中控台） */
  onSpeakerChange?: (event: CoopSpeakerEvent) => void;
  /** 播放租约终态：success/failed/TTL/interrupted → 气泡静音角标 */
  onSpeechResult?: (event: VoiceHostSpeechResult) => void;
  /** 测试注入：替代真实 mcode/say 播放；返回可中断句柄 */
  play?: (input: VoiceHostPlaybackInput) => PlaybackControl;
}

export function createVoiceHost(platform = process.platform, options: CreateVoiceHostOptions = {}): VoiceHost {
  let config: VoiceConfig = { ...DEFAULT_CONFIG };
  const lastTextAt = new Map<string, number>();
  const leases = new GlobalAudioLeaseManager({
    onReceipt: (receipt) => {
      const status = receipt.status === 'COMPLETED'
        ? 'completed'
        : receipt.status === 'TTL_EXPIRED' ? 'timeout'
          : receipt.status === 'INTERRUPTED_BY_P0' ? 'interrupted'
            : receipt.status === 'CANCELLED' ? 'cancelled' : 'failed';
      options.onSpeechResult?.({ agentId: receipt.agentId, speakerName: receipt.speakerName, status });
    },
    onActiveChange: (event) => {
      const state = event.activeAgentId === null
        ? { activeAgentId: null, speakerName: '', state: 'idle' as const }
        : {
            activeAgentId: event.activeAgentId,
            speakerName: event.activeSpeakerName,
            state: 'speaking' as const,
            ...(event.activeVoiceId === undefined ? {} : { voiceId: event.activeVoiceId }),
          };
      options.onSpeakerChange?.(state);
    },
  });

  const speak = (voice: VoiceScene): { ok: boolean; error?: string; queued?: boolean; leaseId?: string } => {
    const scene = voice.scene ?? 'normal';
    if (!config.enabled) {
      options.onSpeechResult?.({ agentId: voice.agentId ?? 'default', speakerName: voice.speakerName ?? '小鲸', status: 'failed' });
      return { ok: false, error: '语音总开关关闭' };
    }
    if (scene === 'inner' && !config.innerVoice) return { ok: false, error: '内心戏发声关闭' };
    const text = voice.text.trim();
    if (text === '') return { ok: false, error: '空台词' };

    const agentId = voice.agentId ?? 'default';
    const resolvedVoiceId = voice.voiceId
      ?? (voice.characterId === undefined ? null : options.resolveVoiceId?.(voice.characterId) ?? null)
      ?? config.voiceId;
    // 节流按 agent + 音色隔离：不同角色说同一句台词不能被互相吞掉
    const now = Date.now();
    const key = `${agentId}:${resolvedVoiceId}:${scene}:${text}`;
    const last = lastTextAt.get(key) ?? 0;
    if (now - last < 8_000) {
      // T-A 语音终态闭合：节流吞掉的台词不会建立租约，租约回执永不到来，
      // 渲染层气泡会停在 waiting 挂满 60s TTL。这句台词刚刚说过（已交付语义），
      // 按 completed 收泡而不是 failed/muted 挂字。
      options.onSpeechResult?.({ agentId, speakerName: voice.speakerName ?? '小鲸', status: 'completed' });
      return { ok: true };
    }
    lastTextAt.set(key, now);
    if (lastTextAt.size > 200) lastTextAt.clear();

    if (platform !== 'darwin' && options.play === undefined) {
      options.onSpeechResult?.({ agentId, speakerName: voice.speakerName ?? '小鲸', status: 'failed' });
      return { ok: false, error: `平台 ${platform} 语音引擎待适配（当前支持 darwin）` };
    }

    const spoken = scene === 'inner' ? `…${text}` : text;
    let playback: PlaybackControl | null = null;
    const effectiveConfig: VoiceConfig = {
      ...config,
      ...(typeof voice.ratePercent === 'number' ? { ratePercent: Math.min(200, Math.max(50, voice.ratePercent)) } : {}),
      ...(typeof voice.pitchMul === 'number' ? { pitchMul: Math.min(1.6, Math.max(1, voice.pitchMul)) } : {}),
    };
    const result = leases.acquire({
      agentId,
      speakerName: voice.speakerName ?? '小鲸',
      voiceId: resolvedVoiceId,
      priority: scene === 'p0' ? 'P0_INTERRUPT' : scene === 'inner' ? 'P2_IDLE' : 'P1_CADENCE',
      ttlMs: 120_000,
      start: async () => {
        playback = options.play?.({ text, voiceId: resolvedVoiceId, scene })
          ?? playVoice(effectiveConfig, scene, SCENE_MODE[scene] ?? 'daily', text, spoken, resolvedVoiceId);
        await playback.done;
      },
      abort: () => playback?.abort(),
    });
    return { ok: true, queued: result === 'queued' };
  };

  return {
    speak,
    get config() {
      return config;
    },
    setConfig(patch) {
      config = {
        ...config,
        ...patch,
        volume: typeof patch.volume === 'number' ? Math.min(1, Math.max(0, patch.volume)) : config.volume,
        ratePercent: typeof patch.ratePercent === 'number' ? Math.min(200, Math.max(50, patch.ratePercent)) : config.ratePercent,
        voice: typeof patch.voice === 'string' && patch.voice.length > 0 ? patch.voice : config.voice,
        voiceId: typeof patch.voiceId === 'string' && patch.voiceId.length > 0 ? patch.voiceId : config.voiceId,
        pitchMul: typeof patch.pitchMul === 'number' ? Math.min(1.6, Math.max(1, patch.pitchMul)) : config.pitchMul,
      };
      return config;
    },
    speakerState() {
      const current = leases.current();
      return current.activeAgentId === null
        ? { activeAgentId: null, speakerName: '', state: 'idle' }
        : {
            activeAgentId: current.activeAgentId,
            speakerName: current.activeSpeakerName,
            state: 'speaking',
            ...(current.activeVoiceId === undefined ? {} : { voiceId: current.activeVoiceId }),
          };
    },
    stopAll() {
      leases.stopAll();
    },
  };
}
