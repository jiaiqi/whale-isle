/**
 * 桌宠创作中心宿主（T-M6-53）：选图/拖入 → 主进程零命令行后处理 → 写自定义角色目录。
 *
 * 图像处理顺序（与 design/pet-stage.html 文案一致）：
 *   白底抠像/透明保真 → 内容包围盒 → 90% 身高 + 脚底对齐 → idle-blink 仅闭眼贴回
 *   → avatar 192×192 / portrait-card 256×384 → WebP 编码（复用中控台渲染进程 canvas）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dialog, ipcMain, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { PetCustomCharacterSchema, type PetCustomCharacter } from '@workbench/shared-protocol';
import {
  contentBounds,
  enforceBlinkOnlyEyes,
  eyeRegionDiff,
  keyWhiteBackground,
  planAvatarCrop,
  planNormalize,
  planPortraitCrop,
  sanitizePoseId,
  type RawImage,
} from './image-pipeline';
import { BUILTIN_LOCKS, POSE_TIERS, compileCharacterPrompt, compileEggLinesPrompt, compileEggPrompt, parseEggLines, type EggMode, type PoseTier } from './prompt-compiler';
import { assertCustomId, customCharactersRoot, invalidateCustomCharacters, readCustomCharacters } from './custom-character';

const IMAGE_EXT = /\.(webp|png|jpe?g)$/i;
const STAGE = 640;

function toRaw(image: NativeImage): RawImage {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  for (let index = 0; index < data.length; index += 4) {
    const a = bitmap[index + 3]!;
    // nativeImage 为预乘 BGRA：先反预乘，再做像素算法
    data[index] = a === 0 ? 0 : Math.min(255, Math.round((bitmap[index + 2]! * 255) / a));
    data[index + 1] = a === 0 ? 0 : Math.min(255, Math.round((bitmap[index + 1]! * 255) / a));
    data[index + 2] = a === 0 ? 0 : Math.min(255, Math.round((bitmap[index]! * 255) / a));
    data[index + 3] = a;
  }
  return { width: size.width, height: size.height, data };
}

function fromRaw(raw: RawImage): NativeImage {
  const bitmap = Buffer.alloc(raw.width * raw.height * 4);
  for (let index = 0; index < raw.data.length; index += 4) {
    const a = raw.data[index + 3]!;
    bitmap[index] = Math.round((raw.data[index + 2]! * a) / 255);
    bitmap[index + 1] = Math.round((raw.data[index + 1]! * a) / 255);
    bitmap[index + 2] = Math.round((raw.data[index]! * a) / 255);
    bitmap[index + 3] = a;
  }
  return nativeImage.createFromBitmap(bitmap, { width: raw.width, height: raw.height });
}

function blitStage(scaled: RawImage, plan: ReturnType<typeof planNormalize>): RawImage {
  const stage: RawImage = { width: plan.stageWidth, height: plan.stageHeight, data: new Uint8ClampedArray(plan.stageWidth * plan.stageHeight * 4) };
  for (let y = 0; y < scaled.height; y += 1) {
    const targetY = plan.offsetY + y;
    if (targetY < 0 || targetY >= stage.height) continue;
    for (let x = 0; x < scaled.width; x += 1) {
      const targetX = plan.offsetX + x;
      if (targetX < 0 || targetX >= stage.width) continue;
      const source = (y * scaled.width + x) * 4;
      const target = (targetY * stage.width + targetX) * 4;
      stage.data[target] = scaled.data[source]!;
      stage.data[target + 1] = scaled.data[source + 1]!;
      stage.data[target + 2] = scaled.data[source + 2]!;
      stage.data[target + 3] = scaled.data[source + 3]!;
    }
  }
  return stage;
}

export interface ProcessedPose {
  pose: string;
  file: string;
  warnings: string[];
}

export function createCreatorHost(options: {
  userDataDir: string;
  getDirectorWindow: () => BrowserWindow | null;
  /** 主脑聊天（未配置 Key 时返回 null）；用于彩蛋 5 态台词 */
  chat?: (system: string, user: string) => Promise<string | null>;
}): { registerIpc(): void } {
  const encodeWebp = async (raw: RawImage): Promise<Buffer> => {
    const window = options.getDirectorWindow();
    if (window === null || window.isDestroyed()) throw new Error('中控台窗口未就绪，无法编码 WebP');
    const pngBase64 = fromRaw(raw).toPNG().toString('base64');
    const webpBase64 = await window.webContents.executeJavaScript(
      `(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${pngBase64}';
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const url = canvas.toDataURL('image/webp', 0.92);
        return url.startsWith('data:image/webp') ? url.slice(url.indexOf(',') + 1) : '';
      })()`,
    ) as string;
    if (webpBase64 === '') throw new Error('WebP 编码失败（当前 Chromium 不支持 toDataURL webp）');
    return Buffer.from(webpBase64, 'base64');
  };

  /**
   * Electron nativeImage 只解码 PNG/JPEG，WebP 必须先由中控台渲染进程 canvas 解码。
   * 统一走渲染层解码 → PNG → nativeImage，保证构造、裁剪与缩放在主进程完成。
   */
  const decodeToNative = async (path: string): Promise<NativeImage> => {
    const window = options.getDirectorWindow();
    if (window === null || window.isDestroyed()) throw new Error('中控台窗口未就绪，无法解码图片');
    const ext = (path.split('.').pop() ?? '').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const base64 = readFileSync(path).toString('base64');
    const pngBase64 = await window.webContents.executeJavaScript(
      `(async () => {
        const img = new Image();
        img.src = 'data:${mime};base64,${base64}';
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return canvas.toDataURL('image/png').split(',')[1];
      })()`,
    ) as string;
    const image = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'));
    if (image.isEmpty()) throw new Error('图片解码失败');
    return image;
  };

  const writePose = async (dir: string, pose: string, raw: RawImage): Promise<string> => {
    const buffer = await encodeWebp(raw);
    const file = join(dir, `${pose}.webp`);
    writeFileSync(file, buffer);
    return file;
  };

  const processImage = async (
    dir: string,
    path: string,
    idleRaw: RawImage | null,
  ): Promise<{ pose: string; raw: RawImage; warnings: string[]; file: string }> => {
    const pose = sanitizePoseId(path.split('/').pop() ?? 'pose');
    const warnings: string[] = [];
    const image = await decodeToNative(path);
    let raw = toRaw(image);
    keyWhiteBackground(raw);
    const bounds = contentBounds(raw);
    if (bounds === null) throw new Error(`图片没有可见内容（全透明/全白）：${path.split('/').pop() ?? path}`);
    const plan = planNormalize(bounds, STAGE, STAGE, 0.9, 0.97);
    // 必须从「已抠图」的 raw 重建图片再缩放；直接 resize 原始 image 会把去底结果丢掉
    const scaled = fromRaw(raw).resize({
      width: Math.max(1, Math.round(raw.width * plan.scale)),
      height: Math.max(1, Math.round(raw.height * plan.scale)),
      quality: 'best',
    });
    let stage = blitStage(toRaw(scaled), plan);
    if (pose === 'idle-blink' && idleRaw !== null) {
      const diff = eyeRegionDiff(idleRaw, stage);
      if (diff < 0.002) warnings.push('idle-blink 与 idle 眼部几乎无差异，疑似没有闭眼');
      if (diff > 0.4) warnings.push('idle-blink 眼部差异过大，已按「仅闭眼」规则贴回 idle 其余区域');
      stage = enforceBlinkOnlyEyes(idleRaw, stage);
    }
    const file = await writePose(dir, pose, stage);
    return { pose, raw: stage, warnings, file };
  };

  const importImages = async (input: {
    id: string;
    displayName?: string;
    paths?: string[];
    folder?: string;
    characterPatch?: Partial<PetCustomCharacter>;
  }): Promise<{ ok: true; id: string; poses: string[]; avatar: string; portrait: string; warnings: string[] }> => {
    const id = assertCustomId(input.id);
    const files: string[] = [];
    let sourceCharacter: unknown;
    // 拖入的「文件夹」在 Electron 里也是路径：含目录时优先按文件夹导入
    let folderInput = input.folder;
    const explicitPaths: string[] = [];
    for (const path of input.paths ?? []) {
      if (!existsSync(path)) throw new Error(`路径不存在：${path.split('/').pop() ?? path}`);
      if (statSync(path).isDirectory()) {
        if (folderInput === undefined) folderInput = path;
        continue;
      }
      explicitPaths.push(path);
    }
    if (folderInput !== undefined) {
      const folder = folderInput;
      if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error('文件夹不存在');
      for (const entry of readdirSync(folder)) {
        if (IMAGE_EXT.test(entry)) files.push(join(folder, entry));
      }
      const characterPath = join(folder, 'character.json');
      if (existsSync(characterPath)) {
        try {
          sourceCharacter = JSON.parse(readFileSync(characterPath, 'utf8')) as unknown;
        } catch {
          throw new Error('文件夹内 character.json 不是合法 JSON');
        }
      }
    }
    for (const path of explicitPaths) {
      if (!IMAGE_EXT.test(path)) throw new Error(`不支持的图片格式：${path.split('/').pop() ?? path}`);
      files.push(path);
    }
    if (files.length === 0) throw new Error('没有可导入的 PNG/WebP/JPG 图片');
    const root = customCharactersRoot(options.userDataDir);
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const parsedSource = sourceCharacter === undefined ? {} : PetCustomCharacterSchema.partial().parse(sourceCharacter);
    const baseCharacter = PetCustomCharacterSchema.parse({
      ...parsedSource,
      ...(input.characterPatch ?? {}),
      name: (input.displayName ?? input.characterPatch?.name ?? parsedSource.name ?? id).trim() || id,
    });
    writeFileSync(join(dir, 'character.json'), `${JSON.stringify(baseCharacter, null, 2)}\n`, 'utf8');

    const warnings: string[] = [];
    const poses: string[] = [];
    let idleRaw: RawImage | null = null;
    // 先处理 idle，保证 idle-blink 有基准
    const ordered = [...files].sort((a, b) => Number(!/idle\./i.test(a)) - Number(!/idle\./i.test(b)));
    let referenceStage: RawImage | null = null;
    for (const file of ordered) {
      const pose = sanitizePoseId(file.split('/').pop() ?? 'pose');
      if (['avatar', 'portrait', 'portrait-card'].includes(pose)) continue;
      const result = await processImage(dir, file, idleRaw);
      poses.push(result.pose);
      warnings.push(...result.warnings);
      if (result.pose === 'idle') idleRaw = result.raw;
      if (referenceStage === null) referenceStage = result.raw;
    }
    if (referenceStage === null) throw new Error('没有可用的姿态图片');
    const plan = planNormalize({ x: 0, y: 0, width: STAGE, height: STAGE }, STAGE, STAGE, 0.9, 0.97);
    const stageImage = fromRaw(referenceStage);
    const avatarBuffer = await encodeWebp(toRaw(stageImage.crop(planAvatarCrop(plan)).resize({ width: 192, height: 192, quality: 'best' })));
    const portraitBuffer = await encodeWebp(toRaw(stageImage.crop(planPortraitCrop(plan)).resize({ width: 256, height: 384, quality: 'best' })));
    writeFileSync(join(dir, 'avatar.webp'), avatarBuffer);
    writeFileSync(join(dir, 'portrait-card.webp'), portraitBuffer);

    invalidateCustomCharacters();
    return { ok: true, id, poses, avatar: 'avatar.webp', portrait: 'portrait-card.webp', warnings };
  };

  const registerIpc = (): void => {
    ipcMain.handle('creator:pose-tiers', () => ({ tiers: POSE_TIERS, locks: BUILTIN_LOCKS }));
    ipcMain.handle('creator:compile-character', (_event, input: { lock: string; customName?: string; customTraits?: string; tiers: PoseTier[]; extra?: string }) =>
      ({ ok: true, prompt: compileCharacterPrompt(input) }));
    ipcMain.handle('creator:compile-egg', (_event, input: { mode: EggMode; guest: string; host: string }) =>
      ({ ok: true, prompt: compileEggPrompt(input) }));
    ipcMain.handle('creator:pick-images', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'webp', 'jpg', 'jpeg'] }] });
      return result.canceled ? { ok: false } : { ok: true, paths: result.filePaths };
    });
    ipcMain.handle('creator:pick-folder', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.canceled || result.filePaths.length === 0 ? { ok: false } : { ok: true, folder: result.filePaths[0] };
    });
    ipcMain.handle('creator:import', async (_event, input: Parameters<typeof importImages>[0]) => {
      try {
        return await importImages(input);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('creator:generate-egg-lines', async (_event, input: { id: string; name: string; mode: EggMode; host: string; persona?: string }) => {
      if (options.chat === undefined) return { ok: false, error: '主脑未接入；请先在「模型服务商」配置 Key' };
      try {
        const prompt = compileEggLinesPrompt(input);
        const content = await options.chat(prompt, '只输出一行 JSON，不要解释。');
        if (content === null) return { ok: false, error: '主脑未配置可用 Key；请先在「模型服务商」页配置' };
        const lines = parseEggLines(content);
        if (lines === null) return { ok: false, error: '主脑输出无法解析为 5 态台词 JSON' };
        const id = assertCustomId(input.id);
        const dir = join(customCharactersRoot(options.userDataDir), id);
        mkdirSync(dir, { recursive: true });
        const characterPath = join(dir, 'character.json');
        const existing = existsSync(characterPath)
          ? PetCustomCharacterSchema.parse(JSON.parse(readFileSync(characterPath, 'utf8')))
          : PetCustomCharacterSchema.parse({ name: input.name, reactTo: '*' });
        const merged: PetCustomCharacter = {
          ...existing,
          egg: true,
          lines: { ...existing.lines, ...lines },
        };
        writeFileSync(characterPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
        invalidateCustomCharacters();
        return { ok: true, lines };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('creator:list-custom', () => readCustomCharacters(options.userDataDir).entries.map((entry) => ({ id: entry.id, name: entry.character.displayName, poses: entry.poses })));
  };
  return { registerIpc };
}
