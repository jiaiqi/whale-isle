/**
 * T-M6-33 语音后端探测：界面必须如实展示 mcode / say / 未适配，
 * 不能把 macOS say 兜底冒充成角色 TTS，也不能在 Windows 上假装可用。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { detectVoiceBackend, createVoiceHost, type PlaybackControl } from './voice-host';

describe('detectVoiceBackend', () => {
  it('macOS + mcode-tools → mcode（角色音色链，失败回落 say）', () => {
    const info = detectVoiceBackend('darwin', (cmd) => cmd === 'mcode-tools');
    expect(info.backend).toBe('mcode');
    expect(info.detail).toContain('mcode-tools');
  });

  it('macOS 无 mcode-tools → say，并明确不是角色 TTS', () => {
    const info = detectVoiceBackend('darwin', () => false);
    expect(info.backend).toBe('say');
    expect(info.detail).toContain('say');
    expect(info.detail).toContain('非角色 TTS');
  });

  it('非 macOS → unsupported（Windows 语音未适配如实上报）', () => {
    const info = detectVoiceBackend('win32', () => true);
    expect(info.backend).toBe('unsupported');
    expect(info.detail).toContain('win32');
  });

  it('每次调用重新探测（安装 mcode-tools 后无需重启即可识别）', () => {
    expect(detectVoiceBackend('darwin', () => false).backend).toBe('say');
    expect(detectVoiceBackend('darwin', () => true).backend).toBe('mcode');
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('createVoiceHost（T-M6-38 全局串行抢麦）', () => {
  it('多角色按全局队列串行播放，并广播 speaking/idle 与角色音色', async () => {
    const controls: Array<{ input: { voiceId: string }; deferred: ReturnType<typeof deferred> }> = [];
    const speakers: Array<{ activeAgentId: string | null; state: string; voiceId?: string }> = [];
    const host = createVoiceHost('darwin', {
      resolveVoiceId: (characterId) => characterId === 'agent-b' ? 'diadia_xuemei' : 'qiaopi_mengmei',
      onSpeakerChange: (event) => speakers.push({ activeAgentId: event.activeAgentId, state: event.state, ...(event.voiceId === undefined ? {} : { voiceId: event.voiceId }) }),
      play: (input): PlaybackControl => {
        const gate = deferred();
        controls.push({ input, deferred: gate });
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });

    expect(host.speak({ agentId: 'agent-a', characterId: 'agent-a', speakerName: '小鲸', text: '我先说' }).ok).toBe(true);
    expect(host.speak({ agentId: 'agent-b', characterId: 'agent-b', speakerName: '泡芙', text: '轮到我' }).queued).toBe(true);
    await vi.waitFor(() => expect(speakers).toContainEqual({ activeAgentId: 'agent-a', state: 'speaking', voiceId: 'qiaopi_mengmei' }));

    controls[0]!.deferred.resolve();
    await vi.waitFor(() => expect(speakers).toContainEqual({ activeAgentId: 'agent-b', state: 'speaking', voiceId: 'diadia_xuemei' }));
    expect(controls).toHaveLength(2);

    controls[1]!.deferred.resolve();
    await vi.waitFor(() => expect(speakers.at(-1)).toEqual({ activeAgentId: null, state: 'idle' }));
    expect(host.speakerState()).toEqual({ activeAgentId: null, speakerName: '', state: 'idle' });
  });

  it('TTS 失败/被 P0 抢占会广播语音终态供气泡静音角标使用', async () => {
    const results: Array<{ status: string }> = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const host = createVoiceHost('darwin', {
      onSpeechResult: (event) => results.push({ status: event.status }),
      play: () => {
        const gate = deferred();
        gates.push(gate);
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });
    host.setConfig({ enabled: false });
    host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '静音测试' });
    expect(results.at(-1)).toEqual({ status: 'failed' });
    host.setConfig({ enabled: true });
    host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '第一条' });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    host.speak({ agentId: 'agent-b', speakerName: '泡芙', text: 'P0 抢麦', scene: 'p0' });
    await vi.waitFor(() => expect(results.some((item) => item.status === 'interrupted')).toBe(true));
  });

  it('8s 节流命中时补发 completed 终态，气泡不挂 60s TTL（T-A）', async () => {
    const results: Array<{ status: string }> = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const host = createVoiceHost('darwin', {
      onSpeechResult: (event) => results.push({ status: event.status }),
      play: () => {
        const gate = deferred();
        gates.push(gate);
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });
    host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '同一句话' });
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    const second = host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '同一句话' });
    expect(second.ok).toBe(true);
    expect(second.queued).toBeUndefined();
    await vi.waitFor(() => expect(results.at(-1)).toEqual({ status: 'completed' }));
    expect(gates).toHaveLength(1); // 节流不建立第二个租约
  });

  it('空台词与内心戏关闭不产生回执，不污染正在等待的气泡（T-A）', () => {
    const results: Array<{ status: string }> = [];
    const host = createVoiceHost('darwin', {
      onSpeechResult: (event) => results.push({ status: event.status }),
      play: () => {
        const gate = deferred();
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });
    host.setConfig({ innerVoice: false });
    expect(host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '心声', scene: 'inner' }).ok).toBe(false);
    expect(host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '   ' }).ok).toBe(false);
    expect(results).toEqual([]);
  });

  it('V2 生产合成闭环：推送真实 WAV 口型帧、失败不静默换声、试听租约不发正式气泡状态', async () => {
    const results: Array<{ status: string }> = [];
    const speakers: Array<{ state: string }> = [];
    const lipBatches: number[] = [];
    let legacyPlayCalls = 0;

    const host = createVoiceHost('darwin', {
      onSpeakerChange: (e) => speakers.push({ state: e.state }),
      onSpeechResult: (e) => results.push({ status: e.status }),
      onLipFrames: (e) => lipBatches.push(e.frames.length),
      play: () => {
        legacyPlayCalls += 1;
        return { done: Promise.resolve(), abort: () => undefined };
      },
      playAudio: () => ({ done: Promise.resolve(), abort: () => undefined }),
      synthesize: async (input) => {
        if (input.text.includes('失败测试')) {
          return { ok: false, error: 'MiMo 401 鉴权失败', allowLegacyFallback: false };
        }
        return {
          ok: true,
          audioBase64: 'UklGRg==',
          format: 'wav',
          providerKind: 'mimo-tts-voiceclone',
          lipFrames: [{ timestampMs: 0, durationMs: 60, viseme: 'open', amplitude: 0.7, rmsDb: -12 }],
        };
      },
    });

    // 1. 成功路径：收到真实 lipFrames 且回执 completed
    host.speak({ agentId: 'agent-a', characterId: 'blue-whale-maid', speakerName: '小鲸', text: '真实合成闭环' });
    await vi.waitFor(() => expect(results.at(-1)).toEqual({ status: 'completed' }));
    expect(lipBatches).toEqual([1]);
    expect(legacyPlayCalls).toBe(0);

    // 2. 失败不静默换声（allowLegacyFallback=false）：绝不回落 legacy play，发出唯一 failed 终态
    host.speak({ agentId: 'agent-a', characterId: 'blue-whale-maid', speakerName: '小鲸', text: '失败测试台词' });
    await vi.waitFor(() => expect(results.at(-1)).toEqual({ status: 'failed' }));
    expect(legacyPlayCalls).toBe(0);

    // 3. 试听租约不广播 coop:speaker 也不发正式气泡回执
    const prevSpeakers = speakers.length;
    const prevResults = results.length;
    const gate = deferred();
    host.acquirePreview(() => ({ done: gate.promise, abort: () => gate.resolve() }));
    gate.resolve();
    await vi.waitFor(() => expect(host.speakerState().state).toBe('idle'));
    expect(speakers.length).toBe(prevSpeakers);
    expect(results.length).toBe(prevResults);
  });
});
