/**
 * 情绪/事件 → 动作映射表（D16，T-M5-16）。
 * 三层映射：persona-brain 情绪五档 ｜ autodrive 游戏事件 ｜ 饭碗余额档位。
 * ambientPool 空闲随机链由宿主计时器调用 pickAmbient（本包 webm-renderer）。
 * 素材零闲置：gen:pet-manifest 保证 114 clips 全在槽位/池中，本表按槽位引用。
 */
import type { PetActionState } from '@workbench/shared-protocol';

export type EmotionTag =
  | 'tsundere_refuse' | 'happy_maid' | 'angry_deny' | 'sad_pout' | 'calm_idle';

export type GameEventKind =
  | 'receipt_completed_harvest' | 'receipt_completed' | 'receipt_uncertain'
  | 'receipt_failed' | 'decision_running' | 'receipt_timeout' | 'sleep';

export type RiceLevel = 'full' | 'ok' | 'hungry' | 'starving' | 'fed_buff';

/** 情绪五档 → 语义槽位（persona-brain EMOTION_PREFIX_MAP 对齐） */
export const EMOTION_ACTION_MAP: Record<EmotionTag, PetActionState> = {
  tsundere_refuse: 'rage_spray',   // 傲娇反驳：喷水/气急败坏池
  happy_maid: 'happy_maid',         // 开心女仆礼
  angry_deny: 'thinking_tail_wag',  // 生气（赌气歪头想对策）
  sad_pout: 'hungry_lazy',          // 难过瘫倒
  calm_idle: 'idle',
};

/** 游戏事件 → 语义槽位 */
export const GAME_EVENT_ACTION_MAP: Record<GameEventKind, PetActionState> = {
  receipt_completed_harvest: 'happy_maid',  // 钓鱼/收获大成功
  receipt_completed: 'game_focus',          // 普通完成回到专注
  receipt_uncertain: 'clumsy_panic',       // 心虚冒汗
  receipt_failed: 'rage_spray',             // 气急败坏
  decision_running: 'game_focus',          // 决策专注
  receipt_timeout: 'thinking_tail_wag',     // 等待回执歪头思考
  sleep: 'sleep_mute',
};

/** 饭碗档位 → 语义槽位（dsh-pet 余额分档动画思想） */
export const RICE_LEVEL_ACTION_MAP: Record<RiceLevel, PetActionState> = {
  full: 'happy_maid',
  ok: 'idle',
  hungry: 'hungry_lazy',   // <15% 饿瘪瘫倒
  starving: 'sleep_mute',  // 见底直接睡（省电）
  fed_buff: 'eat_rice',    // 投喂下饭菜开吃
};

/** autodrive receipt → GameEventKind 归类（供 pet-stage 消费总线事件时用） */
export function classifyAutodriveReceipt(
  status: string,
  tool: string,
  summary: string,
): GameEventKind {
  if (status === 'UNCERTAIN') return 'receipt_uncertain';
  if (status === 'FAILED' || status === 'ERROR') return 'receipt_failed';
  if (status === 'TIMEOUT') return 'receipt_timeout';
  if (/sleep|睡觉/.test(`${tool}${summary}`)) return 'sleep';
  if (/fish|harvest|钓|收获/.test(`${tool}${summary}`)) return 'receipt_completed_harvest';
  return 'receipt_completed';
}

/** 语义槽位 → 该槽位下 clips 数（预览页展示用），由调用方从 manifest 计算 */
export const SLOT_LABELS: Record<PetActionState, string> = {
  idle: '待机呼吸',
  walk: '漫游走动',
  eat_rice: '干饭吃米',
  happy_maid: '开心女仆礼',
  thinking_tail_wag: '歪头思考',
  rage_spray: '喷水抗议',
  clumsy_panic: '心虚冒汗',
  game_focus: '游戏专注',
  sing_stage: '唱歌表演',
  hungry_lazy: '饿瘪瘫倒',
  sleep_mute: '睡觉静音',
};
