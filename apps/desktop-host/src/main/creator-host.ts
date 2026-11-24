/**
 * 桌宠创作中心宿主（T-M6-53）：选图/拖入 → 主进程零命令行后处理 → 写自定义角色目录。
 *
 * 图像处理顺序（与 design/pet-stage.html 文案一致）：
 *   白底抠像/透明保真 → 内容包围盒 → 90% 身高 + 脚底对齐 → idle-blink 仅闭眼贴回
 *   → avatar 192×192 / portrait-card 256×384 → WebP 编码（复用中控台渲染进程 canvas）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog, ipcMain, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import {
  ImageGenBatchRequestSchema,
  ImageGenDraftCommitSchema,
  ImageGenOneRequestSchema,
  ImageGenProviderDescriptorSchema,
  PetCustomCharacterSchema,
  type ImageGenProgress,
  type ImageGenProviderDescriptor,
  type PetCustomCharacter,
} from '@workbench/shared-protocol';
import { generateImage } from './image-gen-client';
import { detectCodexCli, type CodexCliDetection } from './codex-image-backend';
import { collectDoneDraftFiles, draftDirFor, draftExtension, draftPosePrompt, imageModelsFor, resolveReferenceImage, runWithConcurrency } from './image-gen-drafts';
import { hasVaultKey, readVaultKey } from './provider-vault';
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
  /** provider-vault 路径：生图 Key 只在这里解密（T-M6-56） */
  vaultPath?: string;
  /** 本机 Codex CLI 探测用 home（T-M6-61；缺省 process.env.HOME） */
  homeDir?: string;
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

  // ── T-M6-56：AI 直连生图（批量草稿 / 单张重画 / 确认入库） ──
  interface DraftItem {
    pose: string;
    status: 'queued' | 'generating' | 'done' | 'failed';
    index: number;
    total: number;
    file?: string;
    error?: string;
  }
  interface DraftJob {
    id: string;
    dir: string;
    prompt: string;
    size: string;
    referenceImagePath?: string;
    items: DraftItem[];
  }
  const MAX_DRAFT_POSES = 24;
  const draftsRoot = join(options.userDataDir, 'creator-drafts');
  const draftJobs = new Map<string, DraftJob>();

  const providerDocs = (raw: unknown): ImageGenProviderDescriptor[] => {
    if (!Array.isArray(raw)) return [];
    const out: ImageGenProviderDescriptor[] = [];
    for (const entry of raw) {
      const parsed = ImageGenProviderDescriptorSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  };

  const defaultImageModels = (protocol: 'openai' | 'gemini'): string[] => imageModelsFor(protocol, []);

  /** 参考图只接受真实存在的图片文件（≤20MB）；不做任何目录拼接，原样 resolve 后交给读取方。 */
  const resolveDraftReference = (raw?: string): string | undefined => resolveReferenceImage(raw);

  const pushGenProgress = (progress: ImageGenProgress): void => {
    const window = options.getDirectorWindow();
    if (window === null || window.isDestroyed()) return;
    window.webContents.send('creator:gen-progress', progress);
  };

  const generateDraftItem = async (
    job: DraftJob,
    item: DraftItem,
    args: { provider: ImageGenProviderDescriptor; modelId: string; apiKey: string; size: string; referenceImagePath?: string; codex?: CodexCliDetection | null },
  ): Promise<void> => {
    item.status = 'generating';
    pushGenProgress({ jobId: job.id, pose: item.pose, status: 'generating', index: item.index, total: item.total });
    try {
      const image = await generateImage({
        protocol: args.provider.protocol,
        baseUrl: args.provider.baseUrl,
        apiKey: args.apiKey,
        modelId: args.modelId,
        prompt: draftPosePrompt(job.prompt, item.pose),
        size: args.size,
        timeoutMs: args.provider.protocol === 'codex-cli' ? 90_000 : 60_000,
        ...(args.referenceImagePath === undefined ? {} : { referenceImagePath: args.referenceImagePath }),
        ...(args.codex === undefined || args.codex === null ? {} : { codex: { detection: args.codex } }),
      });
      const ext = draftExtension(image.mimeType);
      const file = join(job.dir, `${item.pose}.${ext}`);
      writeFileSync(file, image.buffer);
      item.file = file;
      item.status = 'done';
      delete item.error;
      pushGenProgress({
        jobId: job.id,
        pose: item.pose,
        status: 'done',
        index: item.index,
        total: item.total,
        file: `${item.pose}.${ext}`,
        dataUrl: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
      });
    } catch (error) {
      item.status = 'failed';
      // generateImage 已脱敏；这里再截断，绝不落盘 Key 或请求头
      item.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      pushGenProgress({ jobId: job.id, pose: item.pose, status: 'failed', index: item.index, total: item.total, error: item.error });
    }
  };

  const summarizeJob = (job: DraftJob): Array<{ pose: string; status: DraftItem['status']; file?: string; error?: string }> =>
    job.items.map((item) => ({
      pose: item.pose,
      status: item.status,
      ...(item.file === undefined ? {} : { file: item.file.split(sep).pop() ?? item.file }),
      ...(item.error === undefined ? {} : { error: item.error }),
    }));

  const generateBatch = async (input: unknown): Promise<{ ok: boolean; error?: string; jobId?: string; items?: ReturnType<typeof summarizeJob> }> => {
    const parsed = ImageGenBatchRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: `参数校验失败：${parsed.error.issues[0]?.message ?? '未知'}` };
    const request = parsed.data;
    const isCodex = request.provider.protocol === 'codex-cli';
    let apiKey = '';
    let codex: CodexCliDetection | null = null;
    if (isCodex) {
      codex = detectCodexCli({ homeDir: options.homeDir ?? '' });
      if (!codex.available) return { ok: false, error: `未检测到本机 Codex CLI：${codex.installHint}（或安装官方 codex）` };
      if (!codex.loggedIn) return { ok: false, error: `本机 Codex 未登录：请先运行 ${codex.loginHint}` };
    } else {
      if (options.vaultPath === undefined) return { ok: false, error: 'provider-vault 未就绪，无法读取生图 Key' };
      const key = readVaultKey(options.vaultPath, request.provider.id);
      if (key === null) {
        return { ok: false, error: `供应商「${request.provider.name || request.provider.id}」未配置可用 Key；请先在「模型服务商」页保存` };
      }
      apiKey = key;
    }
    let referenceImagePath: string | undefined;
    try {
      referenceImagePath = resolveDraftReference(request.referenceImagePath);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const poses = [...new Set(request.poses)].slice(0, MAX_DRAFT_POSES);
    const jobId = request.jobId ?? `gen-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let dir: string;
    try {
      dir = draftDirFor(draftsRoot, jobId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const items: DraftItem[] = poses.map((pose, index) => ({ pose, status: 'queued', index, total: poses.length }));
    const job: DraftJob = {
      id: jobId,
      dir,
      prompt: request.prompt,
      size: request.size,
      ...(referenceImagePath === undefined ? {} : { referenceImagePath }),
      items,
    };
    draftJobs.set(jobId, job);
    for (const item of items) pushGenProgress({ jobId, pose: item.pose, status: 'queued', index: item.index, total: item.total });
    const queue = [...items];
    // 并发上限 2：避免中转站/官方限流，也控制内存中的图片 Buffer
    await runWithConcurrency(queue, 2, async (item) => {
      await generateDraftItem(job, item, {
        provider: request.provider,
        modelId: request.modelId,
        apiKey,
        size: request.size,
        ...(referenceImagePath === undefined ? {} : { referenceImagePath }),
        codex,
      });
    });
    return { ok: true, jobId, items: summarizeJob(job) };
  };

  const regenerateOne = async (input: unknown): Promise<{ ok: boolean; error?: string; jobId?: string; item?: ReturnType<typeof summarizeJob>[number] }> => {
    const parsed = ImageGenOneRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: `参数校验失败：${parsed.error.issues[0]?.message ?? '未知'}` };
    const request = parsed.data;
    const job = draftJobs.get(request.jobId);
    if (job === undefined) return { ok: false, error: '草稿任务不存在（应用重启后请重新生成）' };
    const isCodex = request.provider.protocol === 'codex-cli';
    let apiKey = '';
    let codex: CodexCliDetection | null = null;
    if (isCodex) {
      codex = detectCodexCli({ homeDir: options.homeDir ?? '' });
      if (!codex.available) return { ok: false, error: `未检测到本机 Codex CLI：${codex.installHint}` };
      if (!codex.loggedIn) return { ok: false, error: `本机 Codex 未登录：请先运行 ${codex.loginHint}` };
    } else {
      if (options.vaultPath === undefined) return { ok: false, error: 'provider-vault 未就绪，无法读取生图 Key' };
      const key = readVaultKey(options.vaultPath, request.provider.id);
      if (key === null) return { ok: false, error: `供应商「${request.provider.name || request.provider.id}」未配置可用 Key` };
      apiKey = key;
    }
    let referenceImagePath: string | undefined;
    try {
      referenceImagePath = resolveDraftReference(request.referenceImagePath ?? job.referenceImagePath);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const item = job.items.find((entry) => entry.pose === request.pose);
    if (item === undefined) return { ok: false, error: `草稿里没有姿态：${request.pose}` };
    await generateDraftItem(job, item, {
      provider: request.provider,
      modelId: request.modelId,
      apiKey,
      size: request.size,
      ...(referenceImagePath === undefined ? {} : { referenceImagePath }),
      codex,
    });
    const summary = summarizeJob(job).find((entry) => entry.pose === request.pose);
    return summary === undefined ? { ok: false, error: '重画后未生成结果' } : { ok: true, jobId: job.id, item: summary };
  };

  const commitDraft = async (input: unknown): Promise<{ ok: boolean; error?: string; id?: string; poses?: string[]; warnings?: string[] }> => {
    const parsed = ImageGenDraftCommitSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: `参数校验失败：${parsed.error.issues[0]?.message ?? '未知'}` };
    const request = parsed.data;
    const job = draftJobs.get(request.jobId);
    if (job === undefined) return { ok: false, error: '草稿任务不存在（应用重启后请重新生成）' };
    // 目录再次校验，绝不因内存里的 dir 被篡改而越界
    const expectedDir = draftDirFor(draftsRoot, request.jobId);
    if (resolve(job.dir) !== expectedDir) return { ok: false, error: '草稿目录校验失败' };
    const files = collectDoneDraftFiles(job.items);
    if (files.length === 0) return { ok: false, error: '草稿里还没有成功出图的姿态' };
    try {
      const result = await importImages({
        id: request.id,
        paths: files,
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        ...(request.characterPatch === undefined ? {} : { characterPatch: request.characterPatch as Partial<PetCustomCharacter> }),
      });
      return { ok: true, id: result.id, poses: result.poses, warnings: result.warnings };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const registerIpc = (): void => {
    ipcMain.handle('creator:image-gen-providers', (_event, raw: unknown) => {
      const descriptors = providerDocs(raw);
      const configured = descriptors.filter((descriptor) => options.vaultPath !== undefined && hasVaultKey(options.vaultPath, descriptor.id));
      // T-M6-61：本机 Codex CLI（免 API Key）——只探测二进制与 auth.json 存在性，绝不读取凭据
      const codex = detectCodexCli({ homeDir: options.homeDir ?? '' });
      const codexProvider = codex.available && codex.loggedIn
        ? [{
          id: 'codex-cli',
          name: `本机 Codex CLI（免 API Key）· ${codex.backend === 'codex-imagegen' ? '快速模式' : '慢速兜底'}`,
          protocol: 'codex-cli' as const,
          baseUrl: 'https://codex.local/',
          models: [codex.backend ?? 'codex-exec'],
        }]
        : [];
      return {
        ok: true,
        configured: configured.length + codexProvider.length,
        detected: descriptors.length + (codex.available ? 1 : 0),
        codex: {
          detected: codex.available,
          backend: codex.backend,
          loggedIn: codex.loggedIn,
          installHint: codex.installHint,
          loginHint: codex.loginHint,
        },
        providers: [...codexProvider, ...configured.map((descriptor) => {
          const models = [...new Set([
            ...descriptor.candidateModels,
            ...(descriptor.candidateModels.length === 0 && descriptor.protocol !== 'codex-cli' ? defaultImageModels(descriptor.protocol) : []),
          ])].slice(0, 12);
          return {
            id: descriptor.id,
            name: descriptor.name || descriptor.id,
            protocol: descriptor.protocol,
            baseUrl: descriptor.baseUrl,
            models,
          };
        }),
      };
    });
    ipcMain.handle('creator:generate-batch', async (_event, input: unknown) => generateBatch(input));
    ipcMain.handle('creator:regenerate-one', async (_event, input: unknown) => regenerateOne(input));
    ipcMain.handle('creator:commit-draft', async (_event, input: unknown) => commitDraft(input));
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
