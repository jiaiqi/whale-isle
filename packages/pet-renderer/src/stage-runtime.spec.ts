import { describe, expect, it } from 'vitest';
import {
  Desktop2dStageAdapter,
  expressionToDesktopAction,
  expressionToVrmBlendShapes,
  StageRuntime,
  visemeToLive2dParams,
  visemeToVrmBlendShapes,
} from './stage-runtime';

describe('[SIMULATION] V2-P3-01 统一 2D/Live2D/VRM 3D StageRuntime', () => {
  it('准确映射口型 viseme 与情绪表情至 VRM BlendShapes / Live2D 参数 / 2D 动作槽位', () => {
    expect(visemeToVrmBlendShapes({ timestampMs: 0, durationMs: 50, viseme: 'closed', amplitude: 0.9, rmsDb: -6 })).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
    expect(visemeToVrmBlendShapes({ timestampMs: 0, durationMs: 50, viseme: 'open', amplitude: 0.8, rmsDb: -6 }).aa).toBe(0.8);
    expect(visemeToVrmBlendShapes({ timestampMs: 0, durationMs: 50, viseme: 'wide', amplitude: 0.7, rmsDb: -6 }).ee).toBe(0.7);
    expect(visemeToVrmBlendShapes({ timestampMs: 0, durationMs: 50, viseme: 'round', amplitude: 1.0, rmsDb: -6 }).ou).toBe(0.85);
    expect(visemeToVrmBlendShapes({ timestampMs: 0, durationMs: 50, viseme: 'teeth', amplitude: 0.6, rmsDb: -6 }).ih).toBe(0.6);

    expect(visemeToLive2dParams({ timestampMs: 0, durationMs: 50, viseme: 'closed', amplitude: 0.5, rmsDb: -6 }).ParamMouthOpenY).toBe(0);
    expect(visemeToLive2dParams({ timestampMs: 0, durationMs: 50, viseme: 'open', amplitude: 0.8, rmsDb: -6 }).ParamMouthOpenY).toBe(0.8);
    expect(visemeToLive2dParams({ timestampMs: 0, durationMs: 50, viseme: 'wide', amplitude: 1.0, rmsDb: -6 }).ParamMouthForm).toBe(0.85);
    expect(visemeToLive2dParams({ timestampMs: 0, durationMs: 50, viseme: 'round', amplitude: 1.0, rmsDb: -6 }).ParamMouthForm).toBe(-0.65);
    expect(visemeToLive2dParams({ timestampMs: 0, durationMs: 50, viseme: 'teeth', amplitude: 1.0, rmsDb: -6 }).ParamMouthOpenY).toBe(0.45);

    expect(expressionToVrmBlendShapes('happy', 0.9).happy).toBe(0.9);
    expect(expressionToVrmBlendShapes('angry_pout', 0.8).angry).toBe(0.8);
    expect(expressionToVrmBlendShapes('sad', 0.5).sad).toBe(0.5);
    expect(expressionToVrmBlendShapes('surprised', 0.7).surprised).toBe(0.7);
    expect(expressionToVrmBlendShapes('neutral', 1.0).relaxed).toBe(0.6);

    expect(expressionToDesktopAction('rage_spray')).toBe('rage_spray');
    expect(expressionToDesktopAction('thinking')).toBe('thinking_tail_wag');
    expect(expressionToDesktopAction('sleeping')).toBe('sleep_mute');
    expect(expressionToDesktopAction('singing')).toBe('sing_stage');
    expect(expressionToDesktopAction('speaking')).toBe('happy_maid');
    expect(expressionToDesktopAction('gaming')).toBe('game_focus');
    expect(expressionToDesktopAction('idle')).toBe('idle');
  });

  it('在同一 characterId 下跨 desktop-2d / live2d / vrm-3d / obs-stage 无缝切换并保留歌词、表情与口型', () => {
    const stage = new StageRuntime();
    stage.registerBinding({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      backend: 'live2d',
      assetPath: 'assets/stage/xiaojing.model3.json',
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    });
    stage.registerBinding({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      backend: 'vrm-3d',
      assetPath: 'assets/stage/xiaojing.vrm',
      licenseScope: 'COMMERCIAL_READY',
    });
    stage.registerBinding({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      backend: 'obs-stage',
      assetPath: 'assets/pet-packs/xiaojing/manifest.json',
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    });

    const loaded = stage.loadCharacter({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      backend: 'desktop-2d',
      assetPath: 'assets/pet-packs/xiaojing/manifest.json',
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    });
    expect(loaded.devWatermarkActive).toBe(true);
    expect(loaded.realDeviceRenderVerified).toBe(false);

    stage.transitionScene({
      sceneId: 'scene-concert',
      title: '潮汐夜舞台',
      lightingPreset: 'concert_neon',
      transparentBackground: false,
    });
    stage.startSinging('song-1', {
      enabled: true,
      songId: 'song-1',
      positionMs: 1200,
      durationMs: 6000,
      activeIndex: 0,
      activeLine: { index: 0, startMs: 0, endMs: 3000, primaryText: '潮汐告白', secondaryText: 'Tide Confession' },
      nextLine: null,
      lineProgress: 0.4,
      policy: {
        enabled: true,
        showBilingual: true,
        showRomaji: false,
        desktopVisible: true,
        obsVisible: true,
        position: 'bottom',
        fontScale: 1,
      },
    }, true);
    stage.applyLipSync({ timestampMs: 1200, durationMs: 50, viseme: 'open', amplitude: 0.8, rmsDb: -4 });

    // 热切换至 Live2D 与 VRM 3D 后各执行一次停演归零，覆盖不同后端 stop 分支
    const live2dSnap = stage.switchBackend('live2d');
    expect(live2dSnap.characterId).toBe('char_xiaojing');
    expect(live2dSnap.activeBackend).toBe('live2d');
    expect(live2dSnap.lyrics?.activeLine?.primaryText).toBe('潮汐告白');
    expect((live2dSnap.adapterState.parameters as Record<string, number>).ParamMouthOpenY).toBe(0.8);
    expect((stage.stopPerformance('live2d_stop').adapterState.parameters as Record<string, number>).ParamMouthOpenY).toBe(0);

    // 恢复唱歌与口型并热切换至 VRM 3D（商用许可绑定应取消 DEV 水印）
    stage.startSinging('song-1', {
      enabled: true,
      songId: 'song-1',
      positionMs: 1200,
      durationMs: 6000,
      activeIndex: 0,
      activeLine: { index: 0, startMs: 0, endMs: 3000, primaryText: '潮汐告白', secondaryText: 'Tide Confession' },
      nextLine: null,
      lineProgress: 0.4,
      policy: {
        enabled: true,
        showBilingual: true,
        showRomaji: false,
        desktopVisible: true,
        obsVisible: true,
        position: 'bottom',
        fontScale: 1,
      },
    }, false);
    stage.applyLipSync({ timestampMs: 1200, durationMs: 50, viseme: 'open', amplitude: 0.8, rmsDb: -4 });
    const vrmSnap = stage.switchBackend('vrm-3d');
    expect(vrmSnap.activeBackend).toBe('vrm-3d');
    expect(vrmSnap.devWatermarkActive).toBe(false);
    expect((vrmSnap.adapterState.blendShapes as Record<string, number>).aa).toBe(0.8);
    expect((vrmSnap.adapterState.blendShapes as Record<string, number>).happy).toBe(0.85);
    expect((stage.stopPerformance('vrm_stop').adapterState.blendShapes as Record<string, number>).aa).toBe(0);

    // 热切换至 OBS 透明舞台
    const obsSnap = stage.switchBackend('obs-stage');
    expect(obsSnap.activeBackend).toBe('obs-stage');
    expect(obsSnap.adapterState.transparentBackground).toBe(true);

    // 说话计划、空字符串兜底、VRM/Live2D 歌词为 null、场景切换（含 Live2D/VRM/OBS）与停演归零
    stage.loadScene({ sceneId: 'obs-scene', title: '透明舞台', transparentBackground: true });
    stage.showLyrics(null);
    stage.switchBackend('live2d');
    stage.showLyrics(null);
    stage.switchBackend('vrm-3d');
    stage.showLyrics(null);
    stage.switchBackend('desktop-2d');
    stage.setExpression('  ');
    stage.playAnimation('  ');
    expect(stage.snapshot().expression).toBe('idle');
    expect(stage.snapshot().animationId).toBe('idle');
    stage.startSpeech({ emotion: 'happy', intensity: 0.6, gestureIds: [] });
    stage.startSpeech({ emotion: 'happy', intensity: 0.6, gestureIds: ['wave_hand'] });
    expect(stage.snapshot().animationId).toBe('wave_hand');

    const stopped = stage.stopPerformance('done');
    expect(stopped.performingMode).toBe('idle');
    expect(stopped.lipSync.viseme).toBe('closed');
    expect(stopped.lyrics).toBeNull();

    // 未登记角色切换、新角色清空旧绑定与缺适配器异常分支
    const another = stage.loadCharacter({
      characterId: 'char_other',
      displayName: '海豚',
      backend: 'desktop-2d',
      assetPath: 'other.json',
      licenseScope: 'COMMERCIAL_READY',
    });
    expect(another.registeredBackends).toEqual(['desktop-2d']);
    expect(() => stage.switchBackend('vrm-3d')).toThrow(/尚未登记/);

    const partialStage = new StageRuntime({ adapters: [new Desktop2dStageAdapter('desktop-2d')] });
    expect(() => partialStage.switchBackend('live2d')).toThrow(/尚未登记/);
    expect(() => partialStage.loadCharacter({
      characterId: 'x',
      displayName: 'x',
      backend: 'vrm-3d',
      assetPath: 'x.vrm',
    })).toThrow(/未注册舞台渲染适配器/);
  });
});
