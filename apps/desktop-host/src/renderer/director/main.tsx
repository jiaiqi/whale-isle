import { BUILTIN_PROVIDER_PRESETS } from '@workbench/model-gateway/presets';
import type { DiningProfilePreset, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import { createDirectorStore, DirectorDexie } from '@workbench/local-store/dexie';
import { createRoot } from 'react-dom/client';
import { App } from './App';

/** 干饭套餐三胶囊（SPEC §3.3 Magpie 范式）；运行期配置一律经 Dexie 即时状态 */
/** 单一当前生效配置（v5：UI 不再暴露三档套餐；Dexie 仍沿用同一 profile 存储） */
const DEFAULT_PROFILE: DiningProfilePreset = {
  profileId: 'DELUXE_LIVESTREAM',
  displayName: '当前生效配置',
  roleBindings: {
    MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-chat',
    STARDEW_GAME_PLANNER: 'deepseek-official/deepseek-chat',
    DANMAKU_FAST_ROUTER: 'deepseek-official/deepseek-flash',
    VISION_STORYBOARD: 'deepseek-official/deepseek-chat',
    VOICE_TTS_SPEECH: 'local-gpt-sovits/gpt-sovits-v2',
    VOICE_SVC_SINGING: 'local-gpt-sovits/rvc-v2',
  },
  secretMaskingEnabled: true,
};

const SLOT_LABELS: Record<WorkbenchRoleSlot, string> = {
  MAIN_PERSONA_BRAIN: '主脑与内心戏',
  STARDEW_GAME_PLANNER: '星露谷规划器',
  DANMAKU_FAST_ROUTER: '弹幕快反路由',
  VISION_STORYBOARD: '翻车视觉复盘',
  VOICE_TTS_SPEECH: '日常说话 TTS',
  VOICE_SVC_SINGING: '点歌演唱 SVC',
};

const STORE_KEY = 'activeDiningProfile';
const db = new DirectorDexie();
const store = createDirectorStore(db);

// v4 主题：localStorage 记忆（默认深色），首帧前落类避免闪烁
const savedTheme = localStorage.getItem('wb-theme');
document.documentElement.classList.toggle('dark', savedTheme !== 'light');

const root = createRoot(document.getElementById('director-root') as HTMLElement);
root.render(<App profiles={[DEFAULT_PROFILE]} slotLabels={SLOT_LABELS} providers={BUILTIN_PROVIDER_PRESETS} store={store} storeKey={STORE_KEY} />);

// E2E/调试观测口（只读快照）
(window as unknown as { __directorSnapshot: () => Promise<Record<string, unknown>> }).__directorSnapshot =
  async () => store.snapshotConfigs();
