/**
 * 随包桌宠素材（T-M6-45 批次 1.1）。
 *
 * `assets/pet-packs/` 由 `pnpm sync:pet-packs` 拉取，经 electron-builder `extraResources`
 * 进入 `Resources/pet-packs/`（不进 asar / 不进 dist）。主进程在这里：
 *   1. 解析素材根目录（开发态仓库路径 / 打包后 resourcesPath）；
 *   2. 注册只读 `whale-pet://` 协议，严格禁止走出 pet-packs 根目录；
 *   3. 把 aboutme 9 套角色的原始 manifest/actions 转成 workbench 契约 manifest 与角色条目；
 *   4. 汇总「桌宠工坊 → 动作预览与素材库」所需的动作/槽位/皮肤/字体目录（IPC `pet:studio-catalog`）。
 *
 * 外部 JSON 视为数据：所有相对路径必须落在 spritesheet/ 或 audio/ 内，拒绝 `..` 与绝对路径。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { ipcMain } from 'electron';
import {
  PetAvatarManifestSchema,
  PetCharacterSchema,
  PetStudioCatalogSchema,
  type PetAvatarManifest,
  type PetCharacter,
  type PetStudioCatalog,
} from '@workbench/shared-protocol';
import {
  ABOUTME_PACKS,
  buildAboutmePackArtifacts,
  type AboutmeSourceAnimation,
  type AboutmeSourceManifest,
} from '@workbench/pet-renderer/aboutme-pets';

/** 允许通过 whale-pet:// 读取的扩展名 → MIME（与 objective 白名单一致，宁缺勿滥）。 */
const MIME_BY_EXT: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
};

export const PET_PACKS_SCHEME = 'whale-pet';

export function resolvePetPacksDir(options: { isPackaged: boolean; resourcesPath: string; repoRoot: string }): string {
  return options.isPackaged ? join(options.resourcesPath, 'pet-packs') : join(options.repoRoot, 'assets', 'pet-packs');
}

export type PetPacksResolution =
  | { ok: true; path: string; mime: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * `whale-pet://aboutme-pets/pets/dsh/spritesheet/x.webp` → `<packsRoot>/aboutme-pets/pets/...`。
 * 单次解码后逐段拒绝空段、`.`、`..`、反斜杠与 NUL；最终再做一次前缀断言。
 */
export function resolvePetPacksAsset(packsRoot: string, requestUrl: string): PetPacksResolution {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, status: 400, error: '非法 URL' };
  }
  if (url.protocol !== `${PET_PACKS_SCHEME}:`) return { ok: false, status: 400, error: `协议不匹配：${url.protocol}` };
  if (url.hostname === '') return { ok: false, status: 404, error: '缺少素材分组' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(`${url.hostname}${url.pathname}`);
  } catch {
    return { ok: false, status: 400, error: '非法百分号编码' };
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return { ok: false, status: 403, error: '非法路径字符' };
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: false, status: 403, error: '路径穿越被拒绝' };
  }
  const mime = MIME_BY_EXT[extname(decoded).toLowerCase()];
  if (mime === undefined) return { ok: false, status: 403, error: `不允许的素材类型：${extname(decoded) || '(无扩展名)'}` };
  const root = join(packsRoot);
  const absolute = join(root, ...segments);
  if (absolute !== root && !absolute.startsWith(root + sep)) return { ok: false, status: 403, error: '路径穿越被拒绝' };
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return { ok: false, status: 404, error: '素材不存在' };
  return { ok: true, path: absolute, mime };
}

/**
 * 只读协议处理器。读文件委托注入（生产用 `net.fetch(file://)`，天然支持音频 Range 请求；
 * 测试注入假实现以断言穿越请求根本不会触达文件系统）。
 */
export function createPetPacksProtocolHandler(options: {
  packsRoot: string;
  fetchFile: (path: string) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    const resolved = resolvePetPacksAsset(options.packsRoot, request.url);
    if (!resolved.ok) return new Response(resolved.error, { status: resolved.status });
    try {
      const upstream = await options.fetchFile(resolved.path);
      // 显式声明 MIME 与 CORS：net.fetch(file://) 对 .m4a/.ttf 的推断不一致；
      // 桌宠页为 file://，必须返回 ACAO 允许 crossOrigin='anonymous' 读取 canvas alpha。
      const headers = new Headers(upstream.headers);
      headers.set('Content-Type', resolved.mime);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-cache');
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      return new Response('素材读取失败', { status: 404 });
    }
  };
}

/** `aboutme-pets/pets/dsh/…` → `whale-pet://aboutme-pets/pets/dsh/…`（逐段百分号编码，保留中文文件名） */
function whalePetUrl(rel: string): string {
  const [group, ...rest] = rel.split('/');
  return `${PET_PACKS_SCHEME}://${group}/${rest.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

interface SourceStore {
  pets?: Array<{ id?: unknown; manifest?: unknown; actions?: unknown }>;
}

export interface BundledPacks {
  characters: PetCharacter[];
  manifests: Map<string, PetAvatarManifest>;
  errors: string[];
}

const bundledCache = new Map<string, BundledPacks>();
const crossPetCache = new Map<string, BundledPacks & { lines: Map<string, Record<string, string[]>> }>();

/** CrossPet 动作槽位 → 优先姿势名（按上游文件存在性回退）。 */
const CROSSPET_SLOTS: Array<[string, string[]]> = [
  ['idle', ['idle', 'idle-blink', 'idle-2', 'idle-3']],
  ['walk', ['running', 'swim', 'roll_call']],
  ['eat_rice', ['eat', 'feast', 'drink']],
  ['happy_maid', ['pat', 'happy', 'proud', 'coaxed']],
  ['thinking_tail_wag', ['thinking', 'deepthink', 'reading']],
  ['rage_spray', ['redhot', 'annoyed', 'puffed']],
  ['clumsy_panic', ['surprised', 'oops', 'dizzy']],
  ['game_focus', ['busy_left', 'busy_right', 'writing', 'drawing']],
  ['sing_stage', ['hum']],
  ['hungry_lazy', ['slack', 'tired', 'yawn']],
  ['sleep_mute', ['sleeping', 'sulk']],
];

const CROSSPET_VOICE: Record<string, { voiceId: string; rate: number; pitch: number }> = {
  deepseek: { voiceId: 'qiaopi_mengmei', rate: 100, pitch: 1.2 },
  claude: { voiceId: 'Chinese (Mandarin)_Stubborn_Friend', rate: 94, pitch: 1.1 },
  gemini: { voiceId: 'diadia_xuemei', rate: 104, pitch: 1.26 },
  gpt: { voiceId: 'Arrogant_Miss', rate: 100, pitch: 1.18 },
  glm: { voiceId: 'Arrogant_Miss', rate: 102, pitch: 1.22 },
  qwen: { voiceId: 'Chinese (Mandarin)_Crisp_Girl', rate: 98, pitch: 1.15 },
  kimi: { voiceId: 'diadia_xuemei', rate: 96, pitch: 1.16 },
  grok: { voiceId: 'Arrogant_Miss', rate: 108, pitch: 1.28 },
};

interface CrossPetJson extends CrossPetCharacter {
  lines?: Record<string, string[]>;
}

/** 皮肤归属：深蓝卫衣/针织/睡衣/冬装属于 deepseek；claude-saint→claude；gemini-magician→gemini；gpt-onesie→gpt。 */
function skinOwnerOf(id: string): string {
  if (id.startsWith('deepseek-')) return 'deepseek';
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('gpt-')) return 'gpt';
  if (id.startsWith('egg-')) return 'egg';
  return id;
}

export interface PoseClipSource {
  pose: string;
  src: string;
  category?: string;
}

/**
 * 通用 pose-skin manifest 构建（CrossPet 随包与 userData 自定义角色共用）：
 * 11 语义槽位按姿态名匹配，缺槽位优先未消费姿态、再回退 idle；其余进 ambientPool。
 */
export function buildPoseSkinManifest(input: {
  petId: string;
  clips: PoseClipSource[];
  attribution: string;
}): PetAvatarManifest | null {
  const poses = input.clips.map((clip) => clip.pose);
  if (poses.length === 0) return null;
  const byPose = new Map(input.clips.map((clip) => [clip.pose, clip]));
  const urlOf = (pose: string): string => byPose.get(pose)?.src ?? '';
  const used = new Set<string>();
  const idlePose = poses.includes('idle') ? 'idle' : poses[0]!;
  const actions: PetAvatarManifest['actions'] = [];
  for (const [slot, preferred] of CROSSPET_SLOTS) {
    const candidates = preferred.filter((pose) => poses.includes(pose));
    const unused = poses.find((pose) => !used.has(pose));
    const chosen = candidates.length > 0 ? candidates : [unused ?? idlePose];
    if (chosen.length === 0) continue;
    for (const pose of chosen) used.add(pose);
    actions.push({
      actionState: slot as PetAvatarManifest['actions'][number]['actionState'],
      clips: chosen.map((pose) => ({
        clipId: pose,
        webmPath: urlOf(pose),
        spriteSheetPath: urlOf(pose),
        sprite: { frameWidth: 640, frameHeight: 640, columns: 1, frameCount: 1, sampleFps: 1 },
        loop: true,
        playbackRate: 1,
        fps: 1,
        weight: 1,
      })),
    });
  }
  if (actions.length === 0) return null;
  const ambientPool = input.clips.filter((clip) => !used.has(clip.pose)).map((clip) => ({
    clipId: clip.pose,
    webmPath: clip.src,
    spriteSheetPath: clip.src,
    sprite: { frameWidth: 640, frameHeight: 640, columns: 1, frameCount: 1, sampleFps: 1 },
    category: clip.category ?? (clip.pose.startsWith('fest_') ? '节日' : clip.pose.startsWith('greet_') ? '问候' : '小动作'),
    weight: 10,
  }));
  return PetAvatarManifestSchema.parse({
    petId: input.petId,
    renderer: 'pose-skin',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    attribution: input.attribution,
    width: 640,
    height: 640,
    footlineRatio: 0.96,
    defaultAction: 'idle',
    actions,
    ambientPool,
  });
}

/** 读全部随包 egg-* 彩蛋剧本（T-M6-65）：host/hostSkin/aura + 五段台词。 */
export function readCrossPetEggScripts(packsRoot: string): import('./egg-theater').EggScript[] {
  const root = join(packsRoot, 'crosspet', 'characters');
  if (!existsSync(root)) return [];
  const out: import('./egg-theater').EggScript[] = [];
  for (const dirName of readdirSync(root).sort()) {
    if (!dirName.startsWith('egg-')) continue;
    const profile = readCrossPetPoseProfile(packsRoot, `crosspet-${dirName}`);
    if (profile === null) continue;
    const lines = {
      pop: profile.lines.pop ?? [],
      pretend: profile.lines.pretend ?? [],
      caught: profile.lines.caught ?? [],
      bye: profile.lines.bye ?? [],
      escape: profile.lines.escape ?? [],
    };
    if ([lines.pop, lines.pretend, lines.caught, lines.bye, lines.escape].every((pool) => pool.length === 0)) continue;
    out.push({
      characterId: profile.characterId,
      name: profile.name,
      host: profile.host ?? '',
      hostSkin: profile.hostSkin ?? '',
      aura: profile.aura ?? '',
      lines,
    });
  }
  return out;
}

/**
 * CrossPet 随包角色的完整扩展档案（T-M6-63）。
 *
 * 只返回 character.json 里**真实存在**的可选字段：缺省一律 undefined，绝不拿 Zod 默认值
 * 冒充「该角色有这张姿态/有这个特效」。姿态文件名排除立绘 portrait/portrait-card/avatar。
 */
export interface CrossPetPoseProfile {
  characterId: string;
  name: string;
  poses: string[];
  greeting: string;
  lines: Record<string, string[]>;
  correctedPose?: string;
  longThink?: { after: number; pose: string };
  pokePose?: string;
  fx?: Record<string, string>;
  egg?: boolean;
  idleActions?: string[];
  glyph?: { fill?: string; stroke?: string; text?: string };
  apps?: string[];
  host?: string;
  hostSkin?: string;
  aura?: string;
  accent?: string;
  outfit?: string;
}

const CROSSPET_NON_POSE = new Set(['portrait.webp', 'portrait-card.webp', 'avatar.webp']);

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return out.length > 0 ? out : undefined;
}

/** 读一个随包 CrossPet 角色的完整档案；非 crosspet- 前缀、缺目录或坏 JSON 返回 null。 */
export function readCrossPetPoseProfile(packsRoot: string, characterId: string): CrossPetPoseProfile | null {
  if (!characterId.startsWith('crosspet-')) return null;
  const dirName = characterId.slice('crosspet-'.length);
  // 目录名只允许安全字符，杜绝跨目录读取
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(dirName)) return null;
  const dir = join(packsRoot, 'crosspet', 'characters', dirName);
  const characterPath = join(dir, 'character.json');
  if (!existsSync(characterPath)) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(characterPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = stringOf(raw.name) ?? dirName;
  const poses = readdirSync(dir)
    .filter((file) => file.endsWith('.webp') && !CROSSPET_NON_POSE.has(file))
    .map((file) => file.replace(/\.webp$/, ''));
  if (poses.length === 0) return null;
  const lines: Record<string, string[]> = {};
  if (typeof raw.lines === 'object' && raw.lines !== null && !Array.isArray(raw.lines)) {
    for (const [key, value] of Object.entries(raw.lines as Record<string, unknown>)) {
      const pool = stringArrayOf(value);
      if (pool !== undefined) lines[key] = pool;
    }
  }
  const profile: CrossPetPoseProfile = {
    characterId,
    name,
    poses,
    greeting: stringOf(raw.greeting) ?? '',
    lines,
  };
  const correctedPose = stringOf(raw.correctedPose);
  if (correctedPose !== undefined) profile.correctedPose = correctedPose;
  if (typeof raw.longThink === 'object' && raw.longThink !== null) {
    const after = Number((raw.longThink as { after?: unknown }).after);
    const pose = stringOf((raw.longThink as { pose?: unknown }).pose);
    if (Number.isFinite(after) && after > 0 && pose !== undefined) profile.longThink = { after, pose };
  }
  const pokePose = stringOf(raw.pokePose);
  if (pokePose !== undefined) profile.pokePose = pokePose;
  if (typeof raw.fx === 'object' && raw.fx !== null && !Array.isArray(raw.fx)) {
    const fx: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.fx as Record<string, unknown>)) {
      const kind = stringOf(value);
      if (kind !== undefined) fx[key] = kind;
    }
    if (Object.keys(fx).length > 0) profile.fx = fx;
  }
  if (typeof raw.egg === 'boolean') profile.egg = raw.egg;
  const idleActions = stringArrayOf(raw.idleActions);
  if (idleActions !== undefined) profile.idleActions = idleActions;
  if (typeof raw.glyph === 'object' && raw.glyph !== null) {
    const glyphRaw = raw.glyph as Record<string, unknown>;
    const glyph: { fill?: string; stroke?: string; text?: string } = {};
    const fill = stringOf(glyphRaw.fill);
    const stroke = stringOf(glyphRaw.stroke);
    const text = stringOf(glyphRaw.text);
    if (fill !== undefined) glyph.fill = fill;
    if (stroke !== undefined) glyph.stroke = stroke;
    if (text !== undefined) glyph.text = text;
    if (Object.keys(glyph).length > 0) profile.glyph = glyph;
  }
  const apps = stringArrayOf(raw.apps);
  if (apps !== undefined) profile.apps = apps;
  const host = stringOf(raw.host);
  if (host !== undefined) profile.host = host;
  const hostSkin = stringOf(raw.hostSkin);
  if (hostSkin !== undefined) profile.hostSkin = hostSkin;
  const aura = stringOf(raw.aura);
  if (aura !== undefined) profile.aura = aura;
  const accent = stringOf(raw.accent);
  if (accent !== undefined) profile.accent = accent;
  const outfit = stringOf(raw.outfit);
  if (outfit !== undefined) profile.outfit = outfit;
  return profile;
}

/**
 * CrossPet 30 个角色目录（8 基础 + 7 皮肤 + 15 彩蛋）→ pose-skin 角色与 manifest。
 * 只在工作跟随/换装/彩蛋里使用，不混入「9 角色」主条（UI 侧按 packId 过滤）。
 */
export function readCrossPetCharacters(packsRoot: string): BundledPacks & { lines: Map<string, Record<string, string[]>> } {
  const cached = crossPetCache.get(packsRoot);
  if (cached !== undefined) return cached;
  const root = join(packsRoot, 'crosspet', 'characters');
  const result: BundledPacks & { lines: Map<string, Record<string, string[]>> } = {
    characters: [],
    manifests: new Map(),
    errors: [],
    lines: new Map(),
  };
  if (!existsSync(root)) {
    crossPetCache.set(packsRoot, result);
    return result;
  }
  const skins = readCrossPetEntries(packsRoot);
  for (const dirName of readdirSync(root).sort()) {
    const dir = join(root, dirName);
    if (!existsSync(join(dir, 'character.json'))) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, 'character.json'), 'utf8')) as CrossPetJson;
      // 展示立绘不是姿态：portrait / portrait-card / avatar 不进入动作槽与 ambientPool
      const NON_POSE_FILES = new Set(['portrait.webp', 'portrait-card.webp', 'avatar.webp']);
      const poses = readdirSync(dir)
        .filter((file) => file.endsWith('.webp') && !NON_POSE_FILES.has(file))
        .map((file) => file.replace(/\.webp$/, ''));
      if (poses.length === 0) continue;
      const manifest = buildPoseSkinManifest({
        petId: `crosspet-${dirName}`,
        clips: poses.map((pose) => ({
          pose,
          src: whalePetUrl(`crosspet/characters/${dirName}/${pose}.webp`),
          category: pose.startsWith('fest_') ? '节日' : pose.startsWith('greet_') ? '问候' : '小动作',
        })),
        attribution: 'CrossPet（lokicorvus/crosspet，CC BY-NC-SA 4.0）',
      });
      if (manifest === null) continue;
      const family = skinOwnerOf(dirName);
      const voice = CROSSPET_VOICE[family] ?? CROSSPET_VOICE.deepseek!;
      const kind = dirName.startsWith('egg-') ? 'egg' : skins.find((skin) => skin.id === dirName)?.kind ?? 'base';
      const displayName = typeof data.name === 'string' && data.name !== '' ? data.name : dirName;
      const character = PetCharacterSchema.parse({
        id: `crosspet-${dirName}`,
        displayName: kind === 'egg' ? `${displayName}（串门彩蛋）` : displayName,
        manifestPath: whalePetUrl(`crosspet/characters/${dirName}/character.json`),
        personaPrompt: `你是「${displayName}」，来自 CrossPet 的 AI 拟人伙伴${typeof data.outfit === 'string' && data.outfit !== '' ? `，穿着${data.outfit}` : ''}。口吻自然、简短、不解释自己是 AI，用中文。`,
        voiceId: voice.voiceId,
        voiceRatePercent: voice.rate,
        voicePitchMul: voice.pitch,
        packId: `crosspet-${family}`,
        actionCount: manifest.actions.reduce((sum, action) => sum + action.clips.length, 0),
        audioClipCount: 0,
        anchorRatio: 0.5,
        licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
        builtin: true,
        skins: kind === 'base' ? skins.filter((skin) => skin.kind === 'skin' && skinOwnerOf(skin.id) === family) : [],
      });
      result.characters.push(character);
      result.manifests.set(character.id, manifest);
      if (typeof data.lines === 'object' && data.lines !== null) result.lines.set(character.id, data.lines);
    } catch (error) {
      result.errors.push(`${dirName}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  crossPetCache.set(packsRoot, result);
  return result;
}

/** pose-skin 渲染器用的预置台词（character.json.lines）；无则空表。 */
export function crossPetLinesOf(packsRoot: string, characterId: string): Record<string, string[]> {
  return readCrossPetCharacters(packsRoot).lines.get(characterId) ?? {};
}

/**
 * aboutme-pets 9 套角色（仓库内置直读）。缺哪个包就跳过哪个，绝不因为素材不全而崩主进程。
 * 结果按 packsRoot 缓存：素材在会话内不会变，避免每次切角色都重解析 ~1000 条动画。
 */
export function readBundledAboutmePacks(packsRoot: string): BundledPacks {
  const cached = bundledCache.get(packsRoot);
  if (cached !== undefined) return cached;
  const base = join(packsRoot, 'aboutme-pets');
  const baseGroup = 'aboutme-pets';
  const result: BundledPacks = { characters: [], manifests: new Map(), errors: [] };
  const storePath = join(base, 'pets.json');
  if (!existsSync(storePath)) {
    bundledCache.set(packsRoot, result);
    return result;
  }
  let catalog: Map<string, { manifest?: unknown; actions?: unknown }>;
  try {
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as SourceStore;
    catalog = new Map((store.pets ?? []).map((pet) => [String(pet.id ?? ''), pet]));
  } catch (error) {
    result.errors.push(`pets.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    bundledCache.set(packsRoot, result);
    return result;
  }
  for (const pack of ABOUTME_PACKS) {
    const entry = catalog.get(pack.catalogId);
    if (entry === undefined) continue;
    const manifestRel = String(entry.manifest ?? `pets/${pack.slug}/manifest.json`);
    const actionsRel = String(entry.actions ?? `pets/${pack.slug}/actions.json`);
    try {
      const sourceManifest = JSON.parse(readFileSync(join(base, manifestRel), 'utf8')) as AboutmeSourceManifest;
      const sourceActions = JSON.parse(readFileSync(join(base, actionsRel), 'utf8')) as { animations?: AboutmeSourceAnimation[] };
      const animations = Array.isArray(sourceActions.animations) && sourceActions.animations.length > 0
        ? sourceActions.animations
        : Array.isArray(sourceManifest.animations) ? (sourceManifest.animations as AboutmeSourceAnimation[]) : [];
      if (animations.length === 0) throw new Error('没有动画条目');
      const dirRel = `${baseGroup}/${actionsRel.replace(/\/[^/]+$/, '')}`;
      const built = buildAboutmePackArtifacts({
        pack,
        sourceManifest,
        animations,
        manifestPath: whalePetUrl(`${dirRel}/manifest.json`),
        urlFor: (rel) => whalePetUrl(`${dirRel}/${rel}`),
      });
      // 随包角色标记 builtin：manifest 由本模块直接提供（不从 userData 读盘）。
      result.characters.push({ ...built.character, builtin: true });
      result.manifests.set(built.character.id, built.manifest);
    } catch (error) {
      result.errors.push(`${pack.slug}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  bundledCache.set(packsRoot, result);
  return result;
}

const NOTEBOOK_FONTS: Array<{ file: string; label: string }> = [
  { file: 'long-cang.woff2', label: '龙藏体' },
  { file: 'ma-shan-zheng.woff2', label: '马善政毛笔楷书' },
  { file: 'notebook-kai.woff2', label: '小本子楷体' },
  { file: 'xiaolai.woff2', label: '小赖体' },
  { file: 'zcool-kuaile.woff2', label: '站酷快乐体' },
  { file: 'zcool-qingke-huangyou.woff2', label: '站酷庆科黄油体' },
  { file: 'zcool-xiaowei.woff2', label: '站酷小薇体' },
  { file: 'zhi-mang-xing.woff2', label: '志莽行书' },
];

/** 皮肤/彩蛋所属：7 套换装 + 8 基础 + egg-* 串门彩蛋（按上游目录名判定）。 */
const SKIN_IDS = new Set(['deepseek-hoodie', 'deepseek-knit', 'deepseek-pajamas', 'deepseek-winter', 'claude-saint', 'gemini-magician', 'gpt-onesie']);

interface CrossPetCharacter {
  name?: unknown;
  outfit?: unknown;
  accent?: unknown;
  greeting?: unknown;
}

function readCrossPetEntries(packsRoot: string): PetStudioCatalog['skins'] {
  const dir = join(packsRoot, 'crosspet', 'characters');
  if (!existsSync(dir)) return [];
  const out: PetStudioCatalog['skins'] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'LICENSE.md') continue;
    const characterDir = join(dir, entry);
    if (!existsSync(join(characterDir, 'character.json'))) continue;
    let data: CrossPetCharacter = {};
    try {
      data = JSON.parse(readFileSync(join(characterDir, 'character.json'), 'utf8')) as CrossPetCharacter;
    } catch {
      continue;
    }
    const files = readdirSync(characterDir).filter((file) => file.endsWith('.webp'));
    const preview = ['portrait-card.webp', 'avatar.webp', 'idle.webp', 'pat.webp'].map((name) => files.find((file) => file === name)).find((name) => name !== undefined);
    const kind = entry.startsWith('egg-') ? 'egg' : SKIN_IDS.has(entry) ? 'skin' : 'base';
    out.push({
      id: entry,
      name: typeof data.name === 'string' && data.name !== '' ? data.name : entry,
      outfit: typeof data.outfit === 'string' ? data.outfit : '',
      accent: typeof data.accent === 'string' ? data.accent : '',
      kind,
      previewUrl: preview === undefined ? '' : whalePetUrl(`crosspet/characters/${entry}/${preview}`),
      frameCount: files.length,
    });
  }
  return out;
}

/**
 * 桌宠工坊「动作预览与素材库」目录：全量动作（约 1,040）+ 11 语义槽位 + 皮肤/彩蛋 + 字体。
 * 大目录每次切页签调用一次即可，主进程侧读盘很快；不做缓存以便 `pnpm sync:pet-packs` 后即时生效。
 */
export function readPetStudioCatalog(packsRoot: string): PetStudioCatalog {
  const bundled = readBundledAboutmePacks(packsRoot);
  const base = join(packsRoot, 'aboutme-pets');
  const actions: PetStudioCatalog['actions'] = [];
  const slots: PetStudioCatalog['slots'] = [];
  const packIdle = new Map<string, string>();
  for (const pack of ABOUTME_PACKS) {
    const packDir = join(base, 'pets', pack.slug);
    const actionsPath = join(packDir, 'actions.json');
    if (!existsSync(actionsPath)) continue;
    let animations: AboutmeSourceAnimation[] = [];
    try {
      const parsed = JSON.parse(readFileSync(actionsPath, 'utf8')) as { animations?: AboutmeSourceAnimation[] };
      animations = Array.isArray(parsed.animations) ? parsed.animations : [];
    } catch {
      continue;
    }
    // 上游 manifest.idleAnimationId：该角色自己的待机动作（切角色时自动选中）
    try {
      const sourceManifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) as { idleAnimationId?: unknown };
      const idle = String(sourceManifest.idleAnimationId ?? '');
      if (idle !== '' && animations.some((animation) => String(animation.id ?? '') === idle)) packIdle.set(pack.slug, idle);
    } catch { /* 缺 manifest 时回退首个动作 */ }
    for (const [index, animation] of animations.entries()) {
      const clipId = String(animation.id ?? animation.name ?? `action-${index}`);
      const sprite = animation.spritesheet as {
        frameCount?: unknown; columns?: unknown; rows?: unknown;
        frameWidth?: unknown; frameHeight?: unknown;
        fps?: unknown; sampleFps?: unknown;
      } | undefined;
      const webp = String(animation.sources?.webp ?? '');
      const columns = Number(sprite?.columns ?? 0);
      const frameCount = Number(sprite?.frameCount ?? 0);
      actions.push({
        slug: pack.slug,
        packId: pack.catalogId,
        displayName: pack.displayName,
        clipId,
        category: String(animation.category ?? '小动作'),
        frameCount,
        columns,
        rows: Number(sprite?.rows ?? (columns > 0 ? Math.ceil(frameCount / columns) : 0)),
        frameWidth: Number(sprite?.frameWidth ?? 640),
        frameHeight: Number(sprite?.frameHeight ?? 360),
        sampleFps: Number(sprite?.fps ?? sprite?.sampleFps ?? 12),
        hasAudio: animation.audio !== undefined,
        spriteUrl: webp === '' ? '' : whalePetUrl(`aboutme-pets/pets/${pack.slug}/${webp}`),
        audioUrl: animation.audio === undefined ? '' : whalePetUrl(`aboutme-pets/pets/${pack.slug}/${String(animation.audio)}`),
      });
    }
    const manifest = bundled.manifests.get(`aboutme-${pack.slug}`);
    for (const action of manifest?.actions ?? []) {
      slots.push({ packId: pack.catalogId, slot: action.actionState, clipIds: action.clips.map((clip) => clip.clipId) });
    }
  }
  const fonts: PetStudioCatalog['fonts'] = [];
  const notebookDir = join(packsRoot, 'crosspet', 'app', 'web', 'fonts', 'notebook');
  for (const entry of NOTEBOOK_FONTS) {
    if (!existsSync(join(notebookDir, entry.file))) continue;
    fonts.push({ id: entry.file.replace(/\.woff2$/, ''), label: entry.label, file: entry.file, url: whalePetUrl(`crosspet/app/web/fonts/notebook/${entry.file}`) });
  }
  const bubbleFont = join(packsRoot, 'fonts', '上首软糖体.ttf');
  if (existsSync(bubbleFont)) {
    fonts.push({ id: 'shangshou-gummy', label: '上首软糖体（气泡）', file: '上首软糖体.ttf', url: whalePetUrl('fonts/上首软糖体.ttf') });
  }
  return PetStudioCatalogSchema.parse({
    generatedAt: new Date().toISOString(),
    packs: ABOUTME_PACKS.map((pack) => {
      const character = bundled.characters.find((item) => item.id === `aboutme-${pack.slug}`);
      return {
        slug: pack.slug,
        catalogId: pack.catalogId,
        displayName: pack.displayName,
        installed: character !== undefined,
        actionCount: character?.actionCount ?? 0,
        audioClipCount: character?.audioClipCount ?? 0,
        idleClipId: packIdle.get(pack.slug) ?? '',
      };
    }),
    actions,
    slots,
    skins: readCrossPetEntries(packsRoot),
    fonts,
    errors: bundled.errors,
  });
}

export function registerPetPacksIpc(options: { packsRoot: string }): void {
  ipcMain.handle('pet:studio-catalog', () => readPetStudioCatalog(options.packsRoot));
  ipcMain.handle('pet:packs-root', () => options.packsRoot);
  ipcMain.handle('pet:crosspet-catalog', () => ({
    characters: readCrossPetCharacters(options.packsRoot).characters,
    errors: readCrossPetCharacters(options.packsRoot).errors,
  }));
  ipcMain.handle('pet:crosspet-lines', (_event, characterId: string) => crossPetLinesOf(options.packsRoot, String(characterId ?? '')));
}

/** 角色 id → 随包 manifest；供 character-registry 合并（无该角色返回 undefined）。 */
export function bundledManifestOf(packsRoot: string, characterId: string): PetAvatarManifest | undefined {
  return readBundledAboutmePacks(packsRoot).manifests.get(characterId);
}
