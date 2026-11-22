/**
 * 语音宿主（D11 第一版）：macOS `say` 引擎——零外部依赖（D14 独立运行）。
 * 场景矩阵（PRODUCT-DESIGN §2.4）：
 *   - 正式台词（chat_reply/回执播报）→ 正常音量+语速
 *   - 内心戏心声 → 音量 45% + 语速 0.82（低语感）
 *   - P0 雷区反射 → 立即打断当前播报（单端不变式）
 *   - 同文本 8s 节流；队列串行（active≤1）
 * 后续：Windows SAPI（PowerShell Add-Type）在 T-M6-05 打包工单做平台适配。
 */
import { ipcMain } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VoiceScene {
  /** 台词 */
  text: string;
  /** 场景：normal 正式 / inner 内心戏 / p0 雷区 */
  scene?: 'normal' | 'inner' | 'p0';
}

export interface VoiceConfig {
  enabled: boolean;
  innerVoice: boolean;
  volume: number; // 0-1
  ratePercent: number; // 基准语速百分比（say -r 字/分钟，默认 200）
  voice: string;
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
  pitchMul: 1.25, // 默认标准萝莉（+4 半音）
};

const SCENE_RATE: Record<string, number> = { normal: 1, inner: 0.82, p0: 1.15 };
const SCENE_TAG: Record<string, string> = { normal: '台词', inner: '心声', p0: '反射' };

// ---- D11 定稿音色：mcode-tools「俏皮萌妹」（voice-preset.json 五档，用户 2026-11-22 确认） ----
export interface McodeMode {
  label: string; emotion: string; pitch: number; speed: number; volume: number;
}
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
  /** 入队播报（场景音速自动调整） */
  speak(voice: VoiceScene): { ok: boolean; error?: string };
  readonly config: VoiceConfig;
  setConfig(patch: Partial<VoiceConfig>): VoiceConfig;
}

/** mcode-tools 合成链：connector batch_text_to_audio → get_asset_url → afplay（用户定稿音色管线） */
function speakViaMcode(text: string, mode: string): Promise<void> {
  const m = MCODE_MODES[mode] ?? MCODE_MODES.daily!;
  return new Promise<void>((resolve, reject) => {
    try {
      const tmpDir = mkdtempSync(join(tmpdir(), 'whale-mcode-'));
      const out = join(tmpDir, 'out.mp3');
      const argsFile = join(tmpDir, 'args.json');
      writeFileSync(argsFile, JSON.stringify({ requests: [{
        voice_id: MCODE_VOICE_ID, emotion: m.emotion, pitch: m.pitch,
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
      player.on('exit', () => { void rmSync(tmpDir, { recursive: true, force: true }); resolve(); });
      player.on('error', () => { reject(new Error('afplay 失败')); });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** 合成+播放链（D11 萝莉音）：say 产 aiff → [pitch>1: ffmpeg asetrate 变调] → afplay。
 *  返回代表整条链的进程句柄：杀 afplay 即打断播放（say/ffmpeg 极短）。 */
function spawnSynthesize(config: VoiceConfig, rate: number, text: string): ChildProcess {
  const tmpDir = mkdtempSync(join(tmpdir(), 'whale-voice-'));
  const aiff = join(tmpDir, 'say.aiff');
  const wav = join(tmpDir, 'loli.wav');
  const base = spawn('say', ['-v', config.voice, '-r', String(rate), '-o', aiff, text], { stdio: 'ignore' });
  // 串联：say 结束后转调播放；链句柄以最后段（afplay）为代表
  const chain: import('node:child_process').ChildProcess = base;
  void chain;
  base.on('exit', (code: number | null) => {
    if (code !== 0) return;
    const finish = (): void => {
      const player = spawn('afplay', [wav], { stdio: 'ignore' });
      player.on('exit', () => { void rmSync(tmpDir, { recursive: true, force: true }); });
      // 把 active 更新到播放段（通过事件冒泡：调用方监听的是 base——为支持打断，
      // 直接把 player pid 传播：简单法——播放前 unlink 不可行；用同进程组：base.kill 已无法覆盖。
      // 这里用「链对象」：返回一个轻量 EventEmitter-like ChildProcess 代理不可行——
      // 实际方案：voice-host 的 active 存 { kill }；本次用 spawn 的返回 player 挂到 base 上供 kill）
      (base as unknown as { player?: import('node:child_process').ChildProcess }).player = player;
    };
    if (config.pitchMul > 1.001) {
      const conv = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff,
        '-filter:a', `asetrate=22050*${config.pitchMul.toFixed(3)},aresample=22050,atempo=0.94`, wav], { stdio: 'ignore' });
      conv.on('exit', (c: number | null) => { if (c === 0) finish(); else void rmSync(tmpDir, { recursive: true, force: true }); });
    } else {
      finish(); // 原声直接播 aiff
    }
  });
  // 打断支持：kill 时同时杀播放段
  const origKill = base.kill.bind(base);
  base.kill = ((signal?: NodeJS.Signals) => {
    (base as unknown as { player?: import('node:child_process').ChildProcess }).player?.kill('SIGKILL');
    return origKill(signal);
  }) as typeof base.kill;
  return base;
}

export function registerVoiceHostIpc(host: VoiceHost): void {
  ipcMain.handle('voice:speak', (_e, voice: VoiceScene) => host.speak(voice));
  ipcMain.handle('voice:config:get', () => host.config);
  ipcMain.handle('voice:config:set', (_e, patch: Partial<VoiceConfig>) => host.setConfig(patch));
}

export function createVoiceHost(platform = process.platform): VoiceHost {
  let config: VoiceConfig = { ...DEFAULT_CONFIG };
  let active: ChildProcess | null = null;
  let lastTextAt = new Map<string, number>();

  const speak = (voice: VoiceScene): { ok: boolean; error?: string } => {
    const scene = voice.scene ?? 'normal';
    if (!config.enabled) return { ok: false, error: '语音总开关关闭' };
    if (scene === 'inner' && !config.innerVoice) return { ok: false, error: '内心戏发声关闭' };
    const text = voice.text.trim();
    if (text === '') return { ok: false, error: '空台词' };

    // 节流：同文本 8s 内不重播
    const now = Date.now();
    const key = `${scene}:${text}`;
    const last = lastTextAt.get(key) ?? 0;
    if (now - last < 8_000) return { ok: true };
    lastTextAt.set(key, now);
    if (lastTextAt.size > 100) lastTextAt.clear();

    if (platform !== 'darwin') {
      // Windows/其他平台：T-M6-05 打包工单适配 SAPI；当前如实报未支持
      return { ok: false, error: `平台 ${platform} 语音引擎待适配（当前支持 darwin）` };
    }

    // P0 场景：立即打断在播（单端不变式——雷区抢占）
    if (scene === 'p0' && active) {
      active.kill('SIGKILL');
      active = null;
    } else if (active) {
      // 队列串行：上条还在播时忽略新条（非 P0 不抢）——8s 节流已过滤大部分
      return { ok: true, error: '队列占用（上一条在播）' };
    }

    const spoken = scene === 'inner' ? `…${text}` : text;
    // 首选：mcode-tools「俏皮萌妹」；失败回落 say 变调链（D11 三层保底）
    speakViaMcode(text, SCENE_MODE[scene] ?? 'daily')
      .then(() => undefined)
      .catch(() => {
        const rate = Math.round(200 * (config.ratePercent / 100) * (SCENE_RATE[scene] ?? 1));
        const proc = spawnSynthesize(config, rate, spoken);
        active = proc;
        proc.on('exit', () => { if (active === proc) active = null; });
        proc.on('error', () => { if (active === proc) active = null; });
      });
    return { ok: true };
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
        pitchMul: typeof patch.pitchMul === 'number' ? Math.min(1.6, Math.max(1, patch.pitchMul)) : config.pitchMul,
      };
      return config;
    },
  };
}
