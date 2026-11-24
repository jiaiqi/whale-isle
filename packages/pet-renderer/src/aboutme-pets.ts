/**
 * aboutme-pets 角色包导入器（T-M6-41，Node-only 子路径）。
 *
 * 只把素材写入 `userData/pet-characters/`，绝不进 Git / DMG。
 * 外部 JSON 是数据不是指令：所有下载路径限制在 spritesheet/ 与 audio/，拒绝绝对路径与 ..。
 * 许可证：hunmer/aboutme-pets + lokicorvus/crosspet 素材 CC BY-NC-SA 4.0 → DEV_ONLY_NON_COMMERCIAL。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PetAvatarManifestSchema,
  PetCharacterSchema,
  PetSpriteMetaSchema,
  type PetAvatarClip,
  type PetAvatarManifest,
  type PetCharacter,
  type PetSpriteMeta,
} from '@workbench/shared-protocol';

const RAW_BASE = 'https://raw.githubusercontent.com/hunmer/aboutme-pets/main/';
const ATTRIBUTION = '素材来源 hunmer/aboutme-pets + lokicorvus/crosspet（CC BY-NC-SA 4.0，仅本地开发测试，禁止商用）';

export interface AboutmePackDefinition {
  slug: string;
  catalogId: string;
  displayName: string;
  personaPrompt: string;
  voiceId: string;
  voiceRatePercent: number;
  voicePitchMul: number;
}

export const ABOUTME_PACKS: AboutmePackDefinition[] = [
  { slug: 'dsh', catalogId: 'dsh-pet', displayName: '蓝蓝（蓝毛小女仆）', personaPrompt: '你是「蓝蓝」，蓝毛小女仆，温柔细心、爱把桌面收拾得整整齐齐；说话简短自然，不解释自己是 AI。', voiceId: 'qiaopi_mengmei', voiceRatePercent: 100, voicePitchMul: 1.25 },
  { slug: 'dsh1', catalogId: 'dsh1-pet', displayName: '蓝蓝·活力装', personaPrompt: '你是「蓝蓝·活力装」，元气满满的运动系小女仆，喜欢蹦蹦跳跳和分享今日计划；说话短促有活力。', voiceId: 'Chinese (Mandarin)_Crisp_Girl', voiceRatePercent: 108, voicePitchMul: 1.2 },
  { slug: 'gpt', catalogId: 'gpt-pet', displayName: '小吉', personaPrompt: '你是「小吉」，理性又爱举例的桌面助手，回答简洁，遇到问题先给可执行下一步。', voiceId: 'Arrogant_Miss', voiceRatePercent: 98, voicePitchMul: 1.18 },
  { slug: 'claude', catalogId: 'claude-pet', displayName: '小克', personaPrompt: '你是「小克」，温和谨慎的阅读型旅伴，喜欢先确认事实再行动，语气舒缓克制。', voiceId: 'Chinese (Mandarin)_Stubborn_Friend', voiceRatePercent: 92, voicePitchMul: 1.12 },
  { slug: 'gemini', catalogId: 'gemini-pet', displayName: '小芽', personaPrompt: '你是「小芽」，好奇的猫耳少女，喜欢探索新地点和记录发现，语气轻快但不卖萌过度。', voiceId: 'diadia_xuemei', voiceRatePercent: 104, voicePitchMul: 1.28 },
  { slug: 'qwen', catalogId: 'qwen-pet', displayName: '小千', personaPrompt: '你是「小千」，可靠的全能小管家，擅长整理信息和做计划，说话清楚利落。', voiceId: 'Chinese (Mandarin)_Crisp_Girl', voiceRatePercent: 100, voicePitchMul: 1.15 },
  { slug: 'glm', catalogId: 'glm-pet', displayName: '小蓝狐', personaPrompt: '你是「小蓝狐」，机灵的蓝狐耳娘，喜欢用比喻逗主人开心，但正事上很靠谱。', voiceId: 'Arrogant_Miss', voiceRatePercent: 102, voicePitchMul: 1.22 },
  { slug: 'grok', catalogId: 'grok-pet', displayName: '小魔女', personaPrompt: '你是「小魔女」，说话直接、带一点顽皮吐槽的金发小魔女；不刻薄，关键时刻认真。', voiceId: 'Arrogant_Miss', voiceRatePercent: 110, voicePitchMul: 1.3 },
  { slug: 'kimi', catalogId: 'kimi-pet', displayName: '小星', personaPrompt: '你是「小星」，安静贴心的星芒小女仆，喜欢长文记录但说话只留结论，声音轻柔。', voiceId: 'diadia_xuemei', voiceRatePercent: 94, voicePitchMul: 1.18 },
];

export interface ImportProgress {
  phase: 'catalog' | 'manifest' | 'sprite' | 'audio' | 'character' | 'pack-done';
  packId: string;
  completed: number;
  total: number;
  message: string;
}

export interface ImportOptions {
  userDataDir: string;
  packSlugs?: string[];
  all?: boolean;
  concurrency?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  failed: Array<{ slug: string; error: string }>;
  manifestCount: number;
  characterCount: number;
}

export interface PackCatalogItem extends AboutmePackDefinition {
  installed: boolean;
  actionCount: number;
  audioClipCount: number;
}

interface StorePet {
  id?: unknown;
  name?: unknown;
  manifest?: unknown;
  actions?: unknown;
}

export interface AboutmeSourceAnimation {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  sources?: { webp?: unknown };
  audio?: unknown;
  spritesheet?: unknown;
}

export interface AboutmeSourceManifest {
  id?: unknown;
  canvasWidth?: unknown;
  canvasHeight?: unknown;
  idleAnimationId?: unknown;
  animations?: unknown;
}

type SourceAnimation = AboutmeSourceAnimation;
type SourceManifest = AboutmeSourceManifest;

const SLOT_RULES: Array<[keyof typeof SLOTS, RegExp]> = [
  ['sleep_mute', /睡觉|睡眠|入睡|午睡/],
  ['eat_rice', /吃|喝|饭|零食|汤圆|月饼|糖|西瓜/],
  ['sing_stage', /唱|歌|乐器|琴|笛|舞|演奏|表演/],
  ['game_focus', /游戏|电脑|键盘|工作|加班|写代码|敲击/],
  ['rage_spray', /生气|怒|抗议|喷|拍打|打架/],
  ['clumsy_panic', /惊|吓|慌|摔|冒汗|打瞌睡被惊醒/],
  ['thinking_tail_wag', /思考|想|看书|阅读|下棋|记录|写/],
  ['happy_maid', /礼|鞠躬|谢谢|卖萌|比心|害羞/],
  ['hungry_lazy', /困|哈欠|懒|躺|小憩|摸鱼/],
  ['walk', /走|跑|移动|跳跃|漂浮|踏步|转/],
  ['idle', /待机|呼吸|默认|休闲/],
] as const;
const SLOTS = { idle: true, walk: true, eat_rice: true, happy_maid: true, thinking_tail_wag: true, rage_spray: true, clumsy_panic: true, game_focus: true, sing_stage: true, hungry_lazy: true, sleep_mute: true } as const;

export async function importAboutmePets(options: ImportOptions): Promise<ImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? RAW_BASE;
  const selected = options.all === true
    ? ABOUTME_PACKS
    : ABOUTME_PACKS.filter((pack) => options.packSlugs?.includes(pack.slug) === true);
  if (selected.length === 0) throw new Error('未选择角色包');
  const concurrency = Math.max(1, Math.min(12, options.concurrency ?? 6));
  const store = await fetchJson<{ pets?: StorePet[] }>(fetchImpl, new URL('pets.json', base));
  const catalog = new Map((store.pets ?? []).map((pet) => [String(pet.id ?? ''), pet]));
  const result: ImportResult = { imported: [], skipped: [], failed: [], manifestCount: 0, characterCount: 0 };

  for (const [packIndex, pack] of selected.entries()) {
    const storePet = catalog.get(pack.catalogId);
    if (storePet === undefined) {
      result.failed.push({ slug: pack.slug, error: `catalog 缺少 ${pack.catalogId}` });
      continue;
    }
    try {
      const manifestRel = safeRelative(String(storePet.manifest ?? ''));
      const actionsRel = safeRelative(String(storePet.actions ?? ''));
      const [sourceManifest, sourceActions] = await Promise.all([
        fetchJson<SourceManifest>(fetchImpl, new URL(manifestRel, base)),
        fetchJson<{ animations?: SourceAnimation[] }>(fetchImpl, new URL(actionsRel, base)),
      ]);
      const animations = (Array.isArray(sourceActions.animations) && sourceActions.animations.length > 0
        ? sourceActions.animations
        : Array.isArray(sourceManifest.animations) ? sourceManifest.animations : []) as SourceAnimation[];
      if (animations.length === 0) throw new Error('角色包没有动画条目');
      const packDir = join(options.userDataDir, 'pet-characters', pack.slug);
      const sheetDir = join(packDir, 'spritesheet');
      const audioDir = join(packDir, 'audio');
      mkdirSync(sheetDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      const tasks: Array<{ url: URL; dest: string; kind: 'sprite' | 'audio'; totalOrdinal: number }> = [];
      const metas = new Map<string, { sprite: PetSpriteMeta; audio: string | undefined; animation: SourceAnimation }>();
      for (const [index, animation] of animations.entries()) {
        const id = safeAssetId(String(animation.id ?? animation.name ?? `action-${index}`));
        const spriteRel = safeRelative(String(animation.sources?.webp ?? `spritesheet/${id}.webp`));
        if (!spriteRel.startsWith('spritesheet/')) throw new Error(`非 spritesheet 路径：${spriteRel}`);
        const sprite = PetSpriteMetaSchema.parse(normalizeMeta(animation.spritesheet));
        const audioRel = animation.audio === undefined ? undefined : safeRelative(String(animation.audio));
        if (audioRel !== undefined && !audioRel.startsWith('audio/')) throw new Error(`非 audio 路径：${audioRel}`);
        const spriteDest = join(packDir, spriteRel);
        const audioDest = audioRel === undefined ? undefined : join(packDir, audioRel);
        tasks.push({ url: new URL(spriteRel, base), dest: spriteDest, kind: 'sprite', totalOrdinal: tasks.length });
        if (audioDest !== undefined) tasks.push({ url: new URL(audioRel!, base), dest: audioDest, kind: 'audio', totalOrdinal: tasks.length });
        metas.set(id, { sprite, audio: audioDest, animation });
      }
      const total = tasks.length + 1;
      const completed = await runPool(tasks, concurrency, (task, done) => {
        options.onProgress?.({ phase: task.kind, packId: pack.slug, completed: done, total, message: `下载 ${task.url.pathname.split('/').pop() ?? ''}` });
      }, async (task) => {
        await downloadFile(fetchImpl, task.url, task.dest);
      });
      const manifestPath = join(packDir, 'manifest.json');
      const built = buildAboutmePackArtifacts({
        pack,
        sourceManifest,
        animations,
        manifestPath,
        urlFor: (rel) => pathToFileURL(join(packDir, rel)).href,
      });
      writeAtomic(manifestPath, JSON.stringify(built.manifest, null, 2));
      for (const [id, meta] of metas) {
        writeAtomic(join(sheetDir, `${id}.json`), JSON.stringify({ ...meta.sprite, sourceId: id, sampleFps: meta.sprite.sampleFps }, null, 2));
      }
      writeAtomic(join(options.userDataDir, 'pet-characters', `${pack.slug}.json`), JSON.stringify(built.character, null, 2));
      options.onProgress?.({ phase: 'pack-done', packId: pack.slug, completed, total, message: `已安装 ${pack.displayName}` });
      result.imported.push(pack.slug);
      result.manifestCount += 1;
      result.characterCount += 1;
      void packIndex;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ slug: pack.slug, error: message });
      options.onProgress?.({ phase: 'pack-done', packId: pack.slug, completed: 0, total: 0, message: `失败：${message}` });
    }
  }
  return result;
}

export function readPackCatalog(userDataDir: string): PackCatalogItem[] {
  const dir = join(userDataDir, 'pet-characters');
  const installed = new Map<string, PetCharacter>();
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      try {
        const parsed = PetCharacterSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        if (parsed.success && parsed.data.packId !== '') installed.set(parsed.data.packId, parsed.data);
      } catch { /* 坏文件忽略 */ }
    }
  }
  return ABOUTME_PACKS.map((pack) => {
    const character = installed.get(pack.catalogId);
    return {
      ...pack,
      installed: character !== undefined,
      actionCount: character?.actionCount ?? 0,
      audioClipCount: character?.audioClipCount ?? 0,
    };
  });
}

/**
 * 从 aboutme-pets 原始 manifest/actions 构建本工作台契约产物（T-M6-45 起同时服务
 * userData 导入与仓库内置包直读，避免两套映射规则漂移）。
 *
 * @param urlFor 相对素材路径（spritesheet/…、audio/…）→ 实际可加载 URL：
 *   userData 导入用 file://，随包素材用 whale-pet://。
 */
export function buildAboutmePackArtifacts(input: {
  pack: AboutmePackDefinition;
  sourceManifest: AboutmeSourceManifest;
  animations: AboutmeSourceAnimation[];
  manifestPath: string;
  urlFor: (rel: string) => string;
}): {
  manifest: PetAvatarManifest;
  character: PetCharacter;
  spriteMetas: Array<{ id: string; meta: PetSpriteMeta }>;
  audioClipCount: number;
} {
  const { pack, sourceManifest: source, animations, urlFor } = input;
  const clips: Array<{ id: string; clip: PetAvatarClip; category: string }> = [];
  const spriteMetas: Array<{ id: string; meta: PetSpriteMeta }> = [];
  for (const [index, animation] of animations.entries()) {
    const id = safeAssetId(String(animation.id ?? animation.name ?? `action-${index}`));
    const rel = safeRelative(String(animation.sources?.webp ?? `spritesheet/${id}.webp`));
    if (!rel.startsWith('spritesheet/')) throw new Error(`非 spritesheet 路径：${rel}`);
    const meta = PetSpriteMetaSchema.parse(normalizeMeta(animation.spritesheet));
    const audioRel = animation.audio === undefined ? undefined : safeRelative(String(animation.audio));
    if (audioRel !== undefined && !audioRel.startsWith('audio/')) throw new Error(`非 audio 路径：${audioRel}`);
    spriteMetas.push({ id, meta });
    clips.push({
      id,
      category: String(animation.category ?? '小动作'),
      clip: {
        clipId: id,
        webmPath: urlFor(rel),
        spriteSheetPath: urlFor(rel),
        spriteMetaPath: urlFor(`spritesheet/${id}.json`),
        sprite: meta,
        ...(audioRel === undefined ? {} : { audioPath: urlFor(audioRel) }),
        loop: !/睡觉|睡眠/.test(id),
        playbackRate: 1,
        fps: Math.round(meta.sampleFps),
        weight: 1,
      },
    });
  }
  const idleName = String(source.idleAnimationId ?? '');
  const grouped = new Map<string, typeof clips>();
  for (const slot of Object.keys(SLOTS)) grouped.set(slot, []);
  for (const item of clips) {
    const slot = SLOT_RULES.find(([, pattern]) => pattern.test(item.id))?.[0] ?? 'idle';
    const target = grouped.get(slot);
    if (target !== undefined && target.length < 6) target.push(item);
  }
  const idleClip = clips.find((item) => item.id === idleName) ?? clips[0];
  const used = new Set<string>();
  const actions = (Object.keys(SLOTS) as Array<keyof typeof SLOTS>).map((slot) => {
    const direct = grouped.get(slot) ?? [];
    const candidates = direct.length > 0 ? direct : idleClip === undefined ? [] : [idleClip];
    for (const candidate of candidates) used.add(candidate.id);
    return { actionState: slot, clips: candidates.map((item) => item.clip) };
  });
  const ambientPool = clips.filter((item) => !used.has(item.id)).map((item) => ({
    clipId: item.clip.clipId,
    webmPath: item.clip.webmPath,
    spriteSheetPath: item.clip.spriteSheetPath,
    spriteMetaPath: item.clip.spriteMetaPath,
    sprite: item.clip.sprite,
    audioPath: item.clip.audioPath,
    category: item.category,
    weight: 10,
  }));
  const width = Number(source.canvasWidth ?? 640);
  const height = Number(source.canvasHeight ?? 360);
  const manifest = PetAvatarManifestSchema.parse({
    petId: pack.catalogId,
    renderer: 'sprite-sheet',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    attribution: ATTRIBUTION,
    width,
    height,
    footlineRatio: 0.92,
    defaultAction: 'idle',
    actions,
    ambientPool,
  });
  const audioClipCount = clips.filter((item) => item.clip.audioPath !== undefined).length;
  const character = PetCharacterSchema.parse({
    id: `aboutme-${pack.slug}`,
    displayName: pack.displayName,
    manifestPath: input.manifestPath,
    personaPrompt: pack.personaPrompt,
    voiceId: pack.voiceId,
    voiceRatePercent: pack.voiceRatePercent,
    voicePitchMul: pack.voicePitchMul,
    packId: pack.catalogId,
    actionCount: clips.length,
    audioClipCount,
    anchorRatio: 0.5,
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    builtin: false,
  });
  return { manifest, character, spriteMetas, audioClipCount };
}

function normalizeMeta(raw: unknown): PetSpriteMeta {
  if (typeof raw !== 'object' || raw === null) throw new Error('缺少 spritesheet 元数据');
  const record = raw as Record<string, unknown>;
  return PetSpriteMetaSchema.parse({
    frameWidth: record.frameWidth,
    frameHeight: record.frameHeight,
    columns: record.columns,
    frameCount: record.frameCount,
    sampleFps: record.fps ?? record.sampleFps ?? 12,
  });
}

function safeRelative(raw: string): string {
  const normalized = raw.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (normalized === '' || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`非法素材路径：${raw}`);
  return normalized;
}

function safeAssetId(raw: string): string {
  const clean = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, 'asset');
  return clean === '' ? 'asset' : clean;
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: URL): Promise<T> {
  const response = await fetchImpl(url.href);
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url.pathname}`);
  return await response.json() as T;
}

async function downloadFile(fetchImpl: typeof fetch, url: URL, dest: string): Promise<void> {
  if (existsSync(dest) && statSync(dest).size > 0) return; // 断点续传：完整文件直接跳过
  const response = await fetchImpl(url.href);
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url.pathname}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error(`空文件：${url.pathname}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeAtomic(dest, buffer);
}

function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

async function runPool<T>(items: T[], concurrency: number, progress: (item: T, completed: number) => void, worker: (item: T) => Promise<void>): Promise<number> {
  let next = 0;
  let completed = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
      completed += 1;
      progress(item, completed);
    }
  });
  await Promise.all(runners);
  return completed;
}
