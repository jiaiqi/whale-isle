import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface DirectorV2Window {
  directorBridge: {
    v2KernelHealth(): Promise<{
      lifecycle: string;
      activeCharacter: { characterId: string; displayName: string; halted: boolean; controlMode: string };
      plugins: { total: number; enabled: number; errors: number };
      vaultBackend: string;
    }>;
    v2CharacterState(): Promise<{ identity: { characterId: string; displayName: string }; expression: string; halted: boolean }>;
    v2CharacterSnapshot(): Promise<{
      schemaVersion: number;
      identity: { characterId: string; displayName: string };
      goals: Array<{ goalId: string; title: string }>;
      commitments: Array<{ commitmentId: string; title: string }>;
      activityState: { mode: string; expression: string; activeModelRef: string | null; halted: boolean };
    }>;
    v2AddGoal(input: { title: string; priority?: number; relatedActivity?: string }): Promise<{ goalId: string; title: string }>;
    v2AddCommitment(input: { partnerId: string; title: string }): Promise<{ commitmentId: string; title: string }>;
    v2BindModel(modelRef: string | null): Promise<{ activeModelRef: string | null }>;
    v2SelectActivity(input: { mode: string; reason: string; source?: string }): Promise<{
      accepted: boolean;
      reason?: string;
      state: { mode: string; expression: string };
    }>;
    v2EmergencyHalt(reason?: string): Promise<{ halted: boolean; controlMode: string; expression: string }>;
    v2Resume(mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover'): Promise<{ halted: boolean; controlMode: string }>;
    v2StorageCheck(): Promise<{ ok: boolean; engine: string; schemaVersion: string | null; recovered: boolean; integrity: string }>;
    v2VoiceProviders(): Promise<Array<{ kind: string; quality: string; available: boolean; degraded: boolean }>>;
    v2VoiceIdentity(): Promise<{ voiceProfileId: string; characterId: string }>;
    v2VoiceMixerState(): Promise<{ tracks: Array<{ trackId: string; kind: string; outputDeviceId: string }>; outputRoutes: Record<string, string> }>;
    v2VoiceTrackStart(input: { trackId: string; kind: string; label: string }): Promise<{ trackId: string; playing: boolean }>;
    v2VoiceOutputRoute(input: { kind: string; deviceId: string }): Promise<{ outputRoutes: Record<string, string> }>;
    v2VoiceSynthesizePreview(input: { text: string }): Promise<{ providerKind: string; lipFrames: Array<{ viseme: string }> }>;
    characterList(): Promise<Array<{ id: string }>>;
    characterSelect(id: string): Promise<{ ok: boolean }>;
  };
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as Partial<DirectorV2Window>).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

describe('[E2E-HOST] V2 WhaleKernel Electron 宿主集成', () => {
  it('启动后 WhaleKernel 进入 running，支持角色状态读取、紧急停止与恢复', { timeout: 60_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const director = await waitForDirector(app);
      const health = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2KernelHealth(),
      );
      expect(health.lifecycle).toBe('running');
      expect(health.activeCharacter.characterId).toBe('char_xiaojing');
      expect(health.activeCharacter.displayName).toBe('小鲸');
      expect(health.plugins.total).toBeGreaterThanOrEqual(1);
      expect(health.plugins.enabled).toBeGreaterThanOrEqual(1);
      expect(health.plugins.errors).toBe(0);

      const state = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2CharacterState(),
      );
      expect(state.identity.characterId).toBe('char_xiaojing');
      expect(state.halted).toBe(false);

      // V2-P1-01：验证 12 域快照、目标/约定、切换模型/外观后身份与状态不丢失、以及 LifeRuntime 活动同步
      await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        await bridge.v2AddGoal({ title: 'E2E 验证目标', priority: 90, relatedActivity: 'gaming' });
        await bridge.v2AddCommitment({ partnerId: 'owner', title: 'E2E 约定' });
        await bridge.v2BindModel('deepseek-chat');
        const list = await bridge.characterList();
        const alt = list.find((c) => c.id !== 'blue-whale-maid');
        if (alt) await bridge.characterSelect(alt.id);
      });

      const snapshotAfterSwitch = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2CharacterSnapshot(),
      );
      expect(snapshotAfterSwitch.schemaVersion).toBe(1);
      expect(snapshotAfterSwitch.identity.characterId).toBe('char_xiaojing');
      expect(snapshotAfterSwitch.goals.some((g) => g.title === 'E2E 验证目标')).toBe(true);
      expect(snapshotAfterSwitch.commitments.some((c) => c.title === 'E2E 约定')).toBe(true);
      expect(snapshotAfterSwitch.activityState.activeModelRef).toBe('deepseek-chat');

      const gamingRes = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2SelectActivity({
          mode: 'gaming',
          reason: 'E2E 活动联动',
          source: 'user_command',
        }),
      );
      expect(gamingRes.accepted).toBe(true);
      expect(gamingRes.state.mode).toBe('gaming');
      const stateAfterGaming = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2CharacterState(),
      );
      expect(stateAfterGaming.expression).toBe('gaming');

      const halted = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2EmergencyHalt('E2E 急停测试'),
      );
      expect(halted.halted).toBe(true);
      expect(halted.controlMode).toBe('manual_takeover');
      expect(halted.expression).toBe('idle');

      const blockedDuringHalt = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2SelectActivity({
          mode: 'gaming',
          reason: '急停中尝试切入',
          source: 'life_runtime',
        }),
      );
      expect(blockedDuringHalt.accepted).toBe(false);
      expect(blockedDuringHalt.reason).toBe('CHARACTER_HALTED');

      const resumed = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2Resume('autonomous'),
      );
      expect(resumed.halted).toBe(false);
      expect(resumed.controlMode).toBe('autonomous');

      const storage = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2StorageCheck(),
      );
      expect(storage.ok).toBe(true);
      expect(storage.engine).toBe('node:sqlite');
      expect(storage.schemaVersion).toBe('2');
      expect(storage.integrity).toBe('ok');

      // V2-P1-02：验证真实 VoiceProvider 探测、独立 VoiceIdentity、多轨 AudioMixer 与口型预览
      const voiceProviders = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceProviders(),
      );
      expect(voiceProviders.length).toBeGreaterThanOrEqual(4);
      expect(voiceProviders.some((p) => p.kind === 'macos-say' && p.quality === 'system_fallback')).toBe(true);

      const voiceIdentity = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceIdentity(),
      );
      expect(voiceIdentity.characterId).toBe('char_xiaojing');
      expect(voiceIdentity.voiceProfileId).toBe('qiaopi_mengmei');

      const mixerAfterTrack = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        await bridge.v2VoiceTrackStart({ trackId: 'bgm-e2e', kind: 'bgm', label: 'E2E BGM' });
        await bridge.v2VoiceOutputRoute({ kind: 'bgm', deviceId: 'obs-virtual' });
        return bridge.v2VoiceMixerState();
      });
      expect(mixerAfterTrack.tracks.some((t) => t.trackId === 'bgm-e2e')).toBe(true);
      expect(mixerAfterTrack.outputRoutes.bgm).toBe('obs-virtual');

      const preview = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceSynthesizePreview({
          text: '主人，测试语音口型包络！',
        }),
      );
      expect(preview.lipFrames.length).toBeGreaterThan(0);

      await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2EmergencyHalt('V2-P1-02 停播验证'),
      );
      const mixerAfterHalt = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceMixerState(),
      );
      expect(mixerAfterHalt.tracks).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
