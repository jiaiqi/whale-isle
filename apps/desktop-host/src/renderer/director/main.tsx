import { BUILTIN_PROVIDER_PRESETS } from '@workbench/model-gateway/presets';
import type { DiningProfilePreset, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import { createDirectorStore, DirectorDexie } from '@workbench/local-store/dexie';
import { createRoot } from 'react-dom/client';
import { App } from './App';

/** 干饭套餐三胶囊（SPEC §3.3 Magpie 范式）；运行期配置一律经 Dexie 即时状态 */
const DINING_PROFILES: DiningProfilePreset[] = [
  {
    profileId: 'BUDGET_SLACKING',
    displayName: '省饭摸鱼档',
    roleBindings: {
      MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-chat',
      STARDEW_GAME_PLANNER: 'local-ollama/qwen2.5:7b',
      DANMAKU_FAST_ROUTER: 'local-ollama/qwen2.5:7b',
      VISION_STORYBOARD: 'local-ollama/qwen2.5-vl:7b',
      VOICE_TTS_SPEECH: 'local-gpt-sovits/gpt-sovits-v2',
      VOICE_SVC_SINGING: 'local-gpt-sovits/rvc-v2',
    },
    secretMaskingEnabled: true,
  },
  {
    profileId: 'DELUXE_LIVESTREAM',
    displayName: '豪华直播档',
    roleBindings: {
      MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-reasoner',
      STARDEW_GAME_PLANNER: 'deepseek-official/deepseek-chat',
      DANMAKU_FAST_ROUTER: 'siliconflow/Qwen/Qwen2.5-7B-Instruct',
      VISION_STORYBOARD: 'siliconflow/Qwen/Qwen2.5-VL-7B-Instruct',
      VOICE_TTS_SPEECH: 'local-gpt-sovits/gpt-sovits-v2',
      VOICE_SVC_SINGING: 'local-gpt-sovits/rvc-v2',
    },
    secretMaskingEnabled: true,
  },
  {
    profileId: 'OFFLINE_SURVIVAL',
    displayName: '断网求生档',
    roleBindings: {
      MAIN_PERSONA_BRAIN: 'local-ollama/qwen2.5:14b',
      STARDEW_GAME_PLANNER: 'local-ollama/qwen2.5:7b',
      DANMAKU_FAST_ROUTER: 'local-ollama/qwen2.5:7b',
      VISION_STORYBOARD: 'local-ollama/qwen2.5-vl:7b',
      VOICE_TTS_SPEECH: 'local-gpt-sovits/gpt-sovits-v2',
      VOICE_SVC_SINGING: 'local-gpt-sovits/rvc-v2',
    },
    secretMaskingEnabled: true,
  },
];

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
root.render(<App profiles={DINING_PROFILES} slotLabels={SLOT_LABELS} providers={BUILTIN_PROVIDER_PRESETS} store={store} storeKey={STORE_KEY} />);

// E2E/调试观测口（只读快照）
(window as unknown as { __directorSnapshot: () => Promise<Record<string, unknown>> }).__directorSnapshot =
  async () => store.snapshotConfigs();
