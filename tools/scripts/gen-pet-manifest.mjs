#!/usr/bin/env node
/**
 * T-M5-01：dsh-pet 官方素材 → PetAvatarManifest 生成器（D14：产物入库、独立运行）。
 *
 * 输入：packages/pet-renderer/assets/blue-whale-maid/*.webm（114 个 VP9-alpha，640×360，
 *       文件名 = dsh-pet 原动作名）
 * 输出：同目录 manifest.json（shared-protocol PetAvatarManifestSchema 校验产物）
 *
 * 语义槽位映射（手写表——中文动作名 → 我们的 11 个 PetActionState）；
 * 未映射动作进入 ambientPool（随机氛围池，category 取自映射表的扩展分类）。
 * 素材许可：CC BY-NC-SA 4.0 → licenseScope 必须为 DEV_ONLY_NON_COMMERCIAL。
 */
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
import { PetAvatarManifestSchema } from '../../packages/shared-protocol/dist/index.js';

const ASSET_DIR = join(repoRoot, 'packages/pet-renderer/assets/blue-whale-maid');
const OUT = join(ASSET_DIR, 'manifest.json');

/** 中文动作名 → 语义槽位（PetActionState）。一个名字只映射到一个槽位。 */
const SLOT_MAP = {
  idle: ['待机呼吸休闲'],
  walk: ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑'],
  eat_rice: ['吃白饭', '吃Token', '吃早餐', '吃午餐', '吃晚餐', '大口吃零食'],
  happy_maid: ['女仆屈膝礼仪', '优雅女仆舞'],
  thinking_tail_wag: ['深度思考碎碎念', '原地专心玩魔方', '写代码', '轻快记录', '下五子棋'],
  rage_spray: ['玩水枪', '用鲸鱼尾巴拍打地面'],
  clumsy_panic: ['被吓一跳', '原地重力下蹲压缩', '打瞌睡被惊醒', '偷吃零食被抓住'],
  game_focus: ['玩游戏气急败坏', '原地敲击桌面互动', '原地蹲下玩玩具汽车', '拆礼物'],
  sing_stage: ['小提琴演奏', '吹笛子', '悠闲哼歌', '轻快摇摆舞', '可爱宅舞', '原地跳跃抓碎头顶物品'],
  hungry_lazy: ['原地小憩沉眠', '哈欠连天', '晨间刷牙'],
};

/** sleep_mute：dsh-pet 三段接力（start/loop/end）。首段与末段一次性播放，loop 段循环。 */
const SLEEP = {
  start: '睡觉-开始',
  loop: '睡觉-循环',
  end: '睡觉-起来',
};

/** 未映射动作的氛围分类（供 ambientPool.category 与随机权重） */
const CATEGORY_RULES = [
  { category: '吃', weight: 16, test: (n) => /吃|零食|面|饭|糖|蟹|瓜|粥|糕|粽|团|饺子|汤圆|火锅|冰淇淋/.test(n) },
  { category: '玩', weight: 18, test: (n) => /玩|舞|歌|笛|琴|魔术|陀螺|毽子|秋千|猫|花|马|球|风筝|鸽子|泡泡|蜜蜂|蝴蝶/.test(n) },
  { category: '时节', weight: 12, test: (n) => /中秋|雪|烟花|红包|福|乞巧|舞狮|南瓜|茱萸|河灯|幽灵|圣诞|孔明灯|年糕|青团|腊八|重阳|落叶/.test(n) },
  { category: '余额', weight: 8, test: (n) => /余额/.test(n) },
  { category: '小动作', weight: 10, test: () => true },
];

const files = readdirSync(ASSET_DIR).filter((f) => f.endsWith('.webm')).sort();
if (files.length < 100) throw new Error(`素材数量异常：${files.length}（应为 114）`);

const nameToPath = new Map(files.map((f) => [f.replace(/\.webm$/, ''), join('assets/blue-whale-maid', f)]));
const used = new Set();
const clipOf = (name, over = {}) => {
  const p = nameToPath.get(name);
  if (!p) throw new Error(`映射表里的动作找不到素材文件：${name}`);
  used.add(name);
  return { clipId: name, webmPath: p, fps: 24, ...over };
};

const actions = [];
for (const [state, names] of Object.entries(SLOT_MAP)) {
  actions.push({
    actionState: state,
    clips: names.filter((n) => nameToPath.has(n)).map((n) => clipOf(n)),
  });
}
// sleep_mute：三段接力——loop 段循环（start/end 一次性）。当前渲染器取加权随机，
// 先以 loop 段为唯一 clip（start/end 进 ambientPool 供后续三段接力增强使用）。
const sleepClips = [{ clipId: SLEEP.loop, webmPath: nameToPath.get(SLEEP.loop), fps: 24, loop: true }];
used.add(SLEEP.loop);
actions.push({ actionState: 'sleep_mute', clips: sleepClips });

const ambientPool = [];
for (const name of nameToPath.keys()) {
  if (used.has(name)) continue;
  if (name === SLEEP.start || name === SLEEP.end) {
    ambientPool.push({ clipId: name, webmPath: nameToPath.get(name), category: '睡眠接力', weight: 0 });
    continue;
  }
  const rule = CATEGORY_RULES.find((r) => r.test(name));
  ambientPool.push({ clipId: name, webmPath: nameToPath.get(name), category: rule.category, weight: rule.weight });
}

const manifest = {
  petId: 'blue-whale-maid',
  renderer: 'webm-alpha',
  licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
  attribution: '形象与动画素材来自 PC2005-cloud/dsh-pet（CC BY-NC-SA 4.0，本地开发测试用途，禁止商用）',
  width: 640,
  height: 360,
  footlineRatio: 0.92,
  defaultAction: 'idle',
  actions,
  ambientPool,
};

const parsed = PetAvatarManifestSchema.parse(manifest); // 产物必须过契约
writeFileSync(OUT, JSON.stringify(parsed, null, 2) + '\n');

const slotCount = actions.reduce((s, a) => s + a.clips.length, 0);
console.log(`✓ manifest.json 生成：${files.length} 素材 → ${actions.length} 个语义槽位（${slotCount} clips）+ ambientPool ${ambientPool.length} 条`);
console.log(`  未覆盖槽位检查: ${actions.filter((a) => a.clips.length === 0).map((a) => a.actionState).join(',') || '无'}`);
