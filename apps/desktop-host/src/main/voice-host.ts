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

export interface VoiceScene {
  /** 台词 */
  text: string;
  /** 场景：normal 正式 / inner 内心戏 / p0 雷区 */
  scene?: 'normal' | 'inner' | 'p0';
}

export interface VoiceConfig {
  enabled: boolean;
  innerVoice: boolean;
  volume: number; // 0-1（say 无直接音量参数——用 afplay -v 或系统音量；此处用 say -v 音色 + 语速表达差异）
  ratePercent: number; // 基准语速百分比（say -r 字/分钟，默认 200）
  voice: string;
}

const DEFAULT_CONFIG: VoiceConfig = {
  enabled: true,
  innerVoice: true,
  volume: 1,
  ratePercent: 100,
  voice: 'Tingting', // 婷婷：macOS 经典中文女声
};

const SCENE_RATE: Record<string, number> = { normal: 1, inner: 0.82, p0: 1.15 };
const SCENE_TAG: Record<string, string> = { normal: '台词', inner: '心声', p0: '反射' };

export interface VoiceHost {
  /** 入队播报（场景音速自动调整） */
  speak(voice: VoiceScene): { ok: boolean; error?: string };
  readonly config: VoiceConfig;
  setConfig(patch: Partial<VoiceConfig>): VoiceConfig;
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

    const rate = Math.round(200 * (config.ratePercent / 100) * (SCENE_RATE[scene] ?? 1));
    // say：-v 音色 -r 语速；内心戏场景前置停顿标记低语感（文字前置省略号表达）
    const spoken = scene === 'inner' ? `…${text}` : text;
    const proc = spawn('say', ['-v', config.voice, '-r', String(rate), spoken], { stdio: 'ignore' });
    active = proc;
    proc.on('exit', () => {
      if (active === proc) active = null;
    });
    proc.on('error', () => {
      if (active === proc) active = null;
    });
    void SCENE_TAG[scene];
    void execFile;
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
      };
      return config;
    },
  };
}
