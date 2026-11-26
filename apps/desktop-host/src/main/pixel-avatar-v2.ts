/**
 * Whale Isle V2 — 11 步游戏像素人物流水线与 Stardew Avatar Mod 导出核验（V2-P2-06 / REQ-GAME-05 / REQ-CR-03）
 *
 * 工程边界：
 *   - 内置纯 Node PNG RGBA 编解码（基于 node:zlib），零新增原生图像依赖；
 *   - 严格贯彻候选区审查门禁：未批准（approved）或 QA 失败（validation_failed）资产绝不覆盖星露谷 Mod 目录；
 *   - 导出前与导出后执行确定性 Mod 文件校验（manifest / DLL / active-avatar.json / 贴图维度一致），
 *     始终如实返回 `realDeviceInGameVisualVerified: false`，待人类真机进游戏目视确认。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  PixelAvatarJobRequestSchema,
  PixelAvatarJobSnapshotSchema,
  PixelSpriteQaReportSchema,
  StardewAvatarExportVerificationSchema,
  StardewAvatarSyncSchema,
  type PixelAvatarJobSnapshot,
  type PixelPipelineStep,
  type StardewAvatarExportVerification,
} from '@workbench/shared-protocol';
import { guessModsDirs } from '@workbench/stardew-mods';
import { CharacterBibleStore, evaluateAssetDistributionPolicy } from './character-studio-v2';
import { contentBounds, keyWhiteBackground, type RawImage } from './image-pipeline';
import {
  buildStardewSpriteSheet,
  colorSet,
  detectSpriteSheetMeta,
  readPngDimensions,
  SPRITE_COLS,
  SPRITE_ROWS,
  SPRITE_TIER_SPECS,
  validateSpriteSheet,
} from './pixel-sprite-pipeline';
import { compileStardewSpritePrompt } from './prompt-compiler';
import { createStardewAvatarHost, isSafeCharacterId, MOD_FOLDER, SPRITE_FILE } from './stardew-avatar-host';

const PIXEL_CANDIDATES_DIR = 'pixel-candidates';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** 纯 Node 将 RGBA RawImage 编码为标准 8-bit RGBA PNG */
export function encodeRgbaPng(image: RawImage): Buffer {
  if (image.width <= 0 || image.height <= 0 || image.data.length !== image.width * image.height * 4) {
    throw new Error(`无效 RawImage 尺寸：${image.width}×${image.height}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = image.width * 4;
  const rawScanlines = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const destRow = y * (stride + 1);
    rawScanlines[destRow] = 0; // filter: None
    const srcStart = y * stride;
    rawScanlines.set(image.data.subarray(srcStart, srcStart + stride), destRow + 1);
  }
  const compressed = deflateSync(rawScanlines);
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 纯 Node 解码 8-bit RGB/RGBA 非隔行 PNG（支持 Filter 0-4） */
export function decodeRgbaPng(buffer: Buffer): RawImage {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('PNG 文件头签名无效');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataEnd = offset + 8 + length;
    if (dataEnd + 4 > buffer.length) throw new Error('PNG 块长度越界');
    const chunkData = buffer.subarray(offset + 8, dataEnd);
    if (type === 'IHDR') {
      if (length < 13) throw new Error('PNG IHDR 长度不足');
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8]!;
      colorType = chunkData[9]!;
      interlace = chunkData[12]!;
    } else if (type === 'IDAT') {
      idatParts.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width === 0 || height === 0 || idatParts.length === 0) {
    throw new Error('PNG 缺少 IHDR 或 IDAT 数据');
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`仅支持 8-bit 非隔行 RGB/RGBA PNG（实际 depth=${bitDepth}, color=${colorType}, interlace=${interlace}）`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idatParts));
  if (raw.length < (stride + 1) * height) {
    throw new Error('PNG IDAT 解压后像素长度不足');
  }

  const unpacked = new Uint8Array(width * height * bpp);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    const outRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const val = raw[rowStart + 1 + x]!;
      const left = x >= bpp ? unpacked[outRow + x - bpp]! : 0;
      const up = y > 0 ? unpacked[prevRow + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? unpacked[prevRow + x - bpp]! : 0;
      let recon: number;
      if (filter === 0) recon = val;
      else if (filter === 1) recon = (val + left) & 0xff;
      else if (filter === 2) recon = (val + up) & 0xff;
      else if (filter === 3) recon = (val + ((left + up) >>> 1)) & 0xff;
      else if (filter === 4) recon = (val + paethPredictor(left, up, upLeft)) & 0xff;
      else throw new Error(`不支持的 PNG 滤波器类型：${filter}`);
      unpacked[outRow + x] = recon;
    }
  }

  if (bpp === 4) {
    return { width, height, data: new Uint8ClampedArray(unpacked) };
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < unpacked.length; i += 3, j += 4) {
    rgba[j] = unpacked[i]!;
    rgba[j + 1] = unpacked[i + 1]!;
    rgba[j + 2] = unpacked[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { width, height, data: rgba };
}

/** 将内部 characterId（如 char_xiaojing）规范化为 Stardew Mod 安全 slug（仅小写字母/数字/连字符） */
export function toStardewCharacterId(characterId: string): string {
  const normalized = characterId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!isSafeCharacterId(normalized)) {
    throw new Error(`角色 id 无法映射为合法星露谷头像标识：${characterId}`);
  }
  return normalized;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

/**
 * 确定性校验 Mods/WhaleIsleAvatar 导出产物完整性：
 * 1) manifest.json 合法；2) WhaleIsleAvatar.dll 已编译（且可比对 publish/ 哈希）；
 * 3) active-avatar.json 通过 StardewAvatarSyncSchema；4) 关联精灵图存在、无目录穿越且与 tier 尺寸匹配；
 * 始终保持 `realDeviceInGameVisualVerified: false`（不冒充真实进游戏目视验收）。
 */
export function verifyStardewAvatarExport(modDir: string, publishDir?: string): StardewAvatarExportVerification {
  const absModDir = resolve(modDir);
  const issues: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(absModDir)) {
    issues.push(`WhaleIsleAvatar Mod 目录不存在：${absModDir}`);
    return StardewAvatarExportVerificationSchema.parse({
      ok: false,
      modDir: absModDir,
      modInstalled: false,
      dllCompiled: false,
      activeAvatarValid: false,
      spriteValid: false,
      realDeviceInGameVisualVerified: false,
      issues,
      warnings,
    });
  }

  let modInstalled = false;
  let manifestVersion: string | undefined;
  let uniqueId: string | undefined;
  const manifestPath = join(absModDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    issues.push('缺少 manifest.json');
  } else {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { Version?: unknown; UniqueID?: unknown };
      manifestVersion = typeof m.Version === 'string' ? m.Version : undefined;
      uniqueId = typeof m.UniqueID === 'string' ? m.UniqueID : undefined;
      modInstalled = uniqueId === 'WhaleIsle.AvatarSync' && Boolean(manifestVersion);
      if (!modInstalled) issues.push(`manifest.json UniqueID/Version 异常：${String(uniqueId)}`);
    } catch {
      issues.push('manifest.json JSON 解析失败');
    }
  }

  const dllPath = join(absModDir, 'WhaleIsleAvatar.dll');
  let dllCompiled = false;
  let dllSha256: string | undefined;
  let dllMatchesPublish: boolean | undefined;
  if (!existsSync(dllPath)) {
    issues.push('缺少编译产物 WhaleIsleAvatar.dll');
  } else {
    const dllBuf = readFileSync(dllPath);
    if (dllBuf.length === 0) {
      issues.push('WhaleIsleAvatar.dll 为空文件');
    } else {
      dllCompiled = true;
      dllSha256 = sha256Hex(dllBuf);
      if (publishDir !== undefined && existsSync(join(publishDir, 'WhaleIsleAvatar.dll'))) {
        const pubHash = sha256Hex(readFileSync(join(publishDir, 'WhaleIsleAvatar.dll')));
        dllMatchesPublish = pubHash === dllSha256;
        if (!dllMatchesPublish) warnings.push('已安装 DLL 与仓库 publish/ 最新编译版本哈希不一致，建议重新同步安装 Mod');
      }
    }
  }

  let activeAvatarValid = false;
  let syncedCharacterId: string | undefined;
  let spriteValid = false;
  let spriteFile: string | undefined;
  let spriteTier: '1x' | '2x' | '4x' | undefined;
  let spriteWidth: number | undefined;
  let spriteHeight: number | undefined;

  const activePath = join(absModDir, 'active-avatar.json');
  if (!existsSync(activePath)) {
    issues.push('缺少 active-avatar.json（尚未触发导出同步）');
  } else {
    try {
      const parsed = StardewAvatarSyncSchema.safeParse(JSON.parse(readFileSync(activePath, 'utf8')) as unknown);
      if (!parsed.success) {
        issues.push('active-avatar.json 未通过 StardewAvatarSyncSchema 校验');
      } else {
        activeAvatarValid = true;
        syncedCharacterId = parsed.data.characterId;
        if (!parsed.data.spriteSheetPath) {
          warnings.push('active-avatar.json 未附带精灵表（仅使用原版外观预设）');
          spriteValid = true;
        } else {
          const relName = parsed.data.spriteSheetPath;
          if (basename(relName) !== relName) {
            issues.push(`spriteSheetPath 含目录穿越成分：${relName}`);
          } else {
            spriteFile = relName;
            const spriteAbs = join(absModDir, relName);
            if (!existsSync(spriteAbs)) {
              issues.push(`精灵表贴图不存在：${relName}`);
            } else {
              const dims = readPngDimensions(readFileSync(spriteAbs));
              if (dims === null) {
                issues.push(`精灵表不是合法 PNG：${relName}`);
              } else {
                spriteWidth = dims.width;
                spriteHeight = dims.height;
                const meta = detectSpriteSheetMeta(dims.width, dims.height);
                if (meta === null) {
                  issues.push(`精灵表尺寸不符合 1x/2x/4x 网格规范：${dims.width}×${dims.height}`);
                } else {
                  spriteTier = meta.tier;
                  if (parsed.data.spriteTier !== undefined && parsed.data.spriteTier !== meta.tier) {
                    issues.push(`spriteTier (${parsed.data.spriteTier}) 与实际贴图档位 (${meta.tier}) 不一致`);
                  } else {
                    spriteValid = true;
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      issues.push('active-avatar.json 解析失败');
    }
  }

  return StardewAvatarExportVerificationSchema.parse({
    ok: issues.length === 0,
    modDir: absModDir,
    modInstalled,
    dllCompiled,
    ...(dllSha256 ? { dllSha256 } : {}),
    ...(dllMatchesPublish !== undefined ? { dllMatchesPublish } : {}),
    ...(manifestVersion ? { manifestVersion } : {}),
    ...(uniqueId ? { uniqueId } : {}),
    activeAvatarValid,
    ...(syncedCharacterId ? { syncedCharacterId } : {}),
    spriteValid,
    ...(spriteFile ? { spriteFile } : {}),
    ...(spriteTier ? { spriteTier } : {}),
    ...(spriteWidth !== undefined ? { spriteWidth } : {}),
    ...(spriteHeight !== undefined ? { spriteHeight } : {}),
    realDeviceInGameVisualVerified: false,
    issues,
    warnings,
  });
}

/** 11 步游戏像素人物流水线 V2（联动 CharacterBible、候选区审批与 Stardew Mod 安全导出） */
export class PixelAvatarPipelineV2 {
  private readonly candidatesRoot: string;
  private readonly jobs = new Map<string, PixelAvatarJobSnapshot>();
  private readonly bibles: CharacterBibleStore;

  constructor(
    private readonly options: {
      userDataDir: string;
      repoRoot: string;
      bibles?: CharacterBibleStore;
      defaultModsDirOverride?: string;
    },
  ) {
    this.candidatesRoot = resolve(join(options.userDataDir, PIXEL_CANDIDATES_DIR));
    this.bibles = options.bibles ?? new CharacterBibleStore(options.userDataDir);
    mkdirSync(this.candidatesRoot, { recursive: true });
    this.loadPersistedJobs();
  }

  private loadPersistedJobs(): void {
    for (const entry of readdirSync(this.candidatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobPath = join(this.candidatesRoot, entry.name, 'job.json');
      if (!existsSync(jobPath)) continue;
      try {
        const parsed = PixelAvatarJobSnapshotSchema.safeParse(
          JSON.parse(readFileSync(jobPath, 'utf8')) as unknown,
        );
        if (parsed.success) this.jobs.set(parsed.data.jobId, parsed.data);
      } catch {
        // 损坏的候选任务文件安全跳过
      }
    }
  }

  private saveJob(job: PixelAvatarJobSnapshot): void {
    const jobDir = resolve(join(this.candidatesRoot, job.jobId));
    if (jobDir !== this.candidatesRoot && !jobDir.startsWith(`${this.candidatesRoot}${sep}`)) {
      throw new Error('像素候选目录越界');
    }
    mkdirSync(jobDir, { recursive: true });
    atomicWriteJson(join(jobDir, 'job.json'), job);
  }

  listJobs(characterId?: string): PixelAvatarJobSnapshot[] {
    const all = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return characterId === undefined ? all : all.filter((j) => j.characterId === characterId);
  }

  getJob(jobId: string): PixelAvatarJobSnapshot | undefined {
    return this.jobs.get(jobId);
  }

  /** 执行完整 11 步像素精灵流水线，产物先落入独立候选区等待审核 */
  run11StepPipeline(rawInput: unknown): PixelAvatarJobSnapshot {
    const req = PixelAvatarJobRequestSchema.parse(rawInput);
    const now = new Date().toISOString();
    const jobId = `px-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const jobDir = join(this.candidatesRoot, jobId);
    mkdirSync(jobDir, { recursive: true });

    const steps: PixelPipelineStep[] = [];
    const tierSpec = SPRITE_TIER_SPECS[req.tier];

    // Step 1: 锁定目标游戏与像素网格规范
    steps.push({
      step: 1,
      id: 'target_game_profile',
      label: '游戏网格规范锁定',
      status: 'ok',
      detail: `Stardew Valley ${SPRITE_ROWS}×${SPRITE_COLS}（${tierSpec.label}：${tierSpec.sheetWidth}×${tierSpec.sheetHeight}）`,
    });

    // Step 2: 绑定 Character Bible 并编译像素提示词
    const bible = this.bibles.get(req.characterId);
    const bibleTraits = bible
      ? [
        bible.traits.hairstyle ? `发型=${bible.traits.hairstyle}` : '',
        bible.traits.eyes ? `瞳色=${bible.traits.eyes}` : '',
        bible.traits.outfit ? `服装=${bible.traits.outfit}` : '',
        bible.traits.signatureAccessories.length > 0
          ? `标志配饰=${bible.traits.signatureAccessories.join('、')}`
          : '',
      ].filter(Boolean).join('；')
      : '';
    const compiledPrompt = compileStardewSpritePrompt({
      name: req.displayName,
      characterId: req.characterId,
      traits: bibleTraits,
      tier: req.tier,
    });
    steps.push({
      step: 2,
      id: 'character_bible_lock',
      label: '角色设定与特征锁定',
      status: bible ? 'ok' : 'warn',
      detail: bible
        ? `已挂载 CharacterBible v${bible.version}（已批准参考图 ${bible.referenceImages.filter((r) => r.approved).length} 张）`
        : '未找到专属 CharacterBible，已使用角色名与内置预设提示词',
    });

    // Step 3: 读取与解码原始 PNG 网格
    if (!existsSync(req.sourcePngPath)) {
      steps.push({
        step: 3,
        id: 'source_sheet_ingest',
        label: '源图像解码校验',
        status: 'failed',
        detail: `源 PNG 不存在：${req.sourcePngPath}`,
      });
      const failed = PixelAvatarJobSnapshotSchema.parse({
        jobId,
        characterId: req.characterId,
        displayName: req.displayName,
        tier: req.tier,
        status: 'validation_failed',
        compiledPrompt,
        sourcePngPath: req.sourcePngPath,
        steps,
        error: `源 PNG 不存在：${req.sourcePngPath}`,
        createdAt: now,
        updatedAt: now,
      });
      this.jobs.set(jobId, failed);
      this.saveJob(failed);
      return failed;
    }

    let decoded: RawImage;
    try {
      decoded = decodeRgbaPng(readFileSync(req.sourcePngPath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({
        step: 3,
        id: 'source_sheet_ingest',
        label: '源图像解码校验',
        status: 'failed',
        detail: msg,
      });
      const failed = PixelAvatarJobSnapshotSchema.parse({
        jobId,
        characterId: req.characterId,
        displayName: req.displayName,
        tier: req.tier,
        status: 'validation_failed',
        compiledPrompt,
        sourcePngPath: req.sourcePngPath,
        steps,
        error: msg,
        createdAt: now,
        updatedAt: now,
      });
      this.jobs.set(jobId, failed);
      this.saveJob(failed);
      return failed;
    }

    steps.push({
      step: 3,
      id: 'source_sheet_ingest',
      label: '源图像解码校验',
      status: 'ok',
      detail: `已解码源图 ${decoded.width}×${decoded.height} RGBA`,
    });

    // Step 4: 四向连通去白底（保真已有透明区域）
    const working: RawImage = {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8ClampedArray(decoded.data),
    };
    const keyedPixels = keyWhiteBackground(working);
    const hasContent = contentBounds(working) !== null;
    if (!hasContent) {
      steps.push({
        step: 4,
        id: 'background_flood_key',
        label: '边缘连通去白底',
        status: 'failed',
        detail: '去底后图像全透明/全白，无有效像素内容',
      });
      const failed = PixelAvatarJobSnapshotSchema.parse({
        jobId,
        characterId: req.characterId,
        displayName: req.displayName,
        tier: req.tier,
        status: 'validation_failed',
        compiledPrompt,
        sourcePngPath: req.sourcePngPath,
        steps,
        error: '去底后图像无可见内容',
        createdAt: now,
        updatedAt: now,
      });
      this.jobs.set(jobId, failed);
      this.saveJob(failed);
      return failed;
    }

    steps.push({
      step: 4,
      id: 'background_flood_key',
      label: '边缘连通去白底',
      status: 'ok',
      detail: keyedPixels > 0 ? `洪水填充移除边缘近白背景 ${keyedPixels} 像素` : '源图已具备透明背景，透明保真直通',
    });

    // Steps 5-8: 网格投影切格 → 脚底对齐统一缩放 → 轮廓白晕清理 → 档位调色板收敛
    const built = buildStardewSpriteSheet(working, { tier: req.tier });
    steps.push(
      {
        step: 5,
        id: 'grid_projection_slice',
        label: '4×6 投影自适应切格',
        status: built.emptyCells > 0 ? 'warn' : 'ok',
        detail: `切分 24 格，非空格 ${24 - built.emptyCells}/24（空帧 ${built.emptyCells}）`,
      },
      {
        step: 6,
        id: 'footline_uniform_scale',
        label: '全局等比脚底对齐',
        status: 'ok',
        detail: `采样式=${tierSpec.sampling}，单格=${built.cellWidth}×${built.cellHeight}`,
      },
      {
        step: 7,
        id: 'edge_halo_cleanup',
        label: '轮廓白边光晕清理',
        status: 'ok',
        detail: `已执行 ${tierSpec.haloPasses} 轮近白边缘透明清理`,
      },
      {
        step: 8,
        id: 'tier_palette_quantize',
        label: '档位色板收敛规范化',
        status: 'ok',
        detail: tierSpec.maxColors === null
          ? `4× 档位全彩保留（实际 ${colorSet(built.sheet).size} 色）`
          : `中位切分收敛目标 ≤${tierSpec.maxColors} 色（实际 ${colorSet(built.sheet).size} 色）`,
      },
    );

    // Step 9: 像素精灵表 QA 与候选 PNG 写盘
    const sheetCheck = validateSpriteSheet(built.sheet);
    let opaquePixels = 0;
    for (let i = 3; i < built.sheet.data.length; i += 4) {
      if (built.sheet.data[i]! > 16) opaquePixels += 1;
    }
    const qaWarnings: string[] = [];
    const qaErrors: string[] = [];
    if (!sheetCheck.ok) qaErrors.push(sheetCheck.error ?? '精灵表校验失败');
    if (built.emptyCells > req.maxEmptyCells) {
      qaErrors.push(`空帧数量过多：${built.emptyCells} > 上限 ${req.maxEmptyCells}`);
    } else if (built.emptyCells > 0) {
      qaWarnings.push(`存在 ${built.emptyCells} 个空帧（已按待机规范保留空槽）`);
    }

    const outPngBuf = encodeRgbaPng(built.sheet);
    const outPngPath = join(jobDir, SPRITE_FILE);
    writeFileSync(outPngPath, outPngBuf);

    const qa = PixelSpriteQaReportSchema.parse({
      valid: qaErrors.length === 0,
      tier: req.tier,
      width: built.sheet.width,
      height: built.sheet.height,
      cols: sheetCheck.meta?.cols ?? SPRITE_COLS,
      rows: sheetCheck.meta?.rows ?? SPRITE_ROWS,
      cellWidth: built.cellWidth,
      cellHeight: built.cellHeight,
      emptyCells: built.emptyCells,
      opaquePixels,
      colorCount: colorSet(built.sheet).size,
      warnings: qaWarnings,
      errors: qaErrors,
    });
    steps.push({
      step: 9,
      id: 'sprite_sheet_qa',
      label: '精灵表尺寸与帧完整性 QA',
      status: qa.valid ? (qaWarnings.length > 0 ? 'warn' : 'ok') : 'failed',
      detail: qa.valid
        ? `QA 通过：${qa.width}×${qa.height} · ${qa.colorCount} 色 · 非透明 ${qa.opaquePixels} 像素`
        : `QA 失败：${qaErrors.join('；')}`,
    });

    // Step 10: 溯源与商业/直播许可隔离检查
    const provenance = {
      sourceType: req.sourceType,
      ...(req.author ? { author: req.author } : {}),
      license: req.license,
      allowCommercial: req.allowCommercial,
      allowLivestream: req.allowLivestream,
      allowRedistribution: req.allowRedistribution,
      inputRefPaths: [req.sourcePngPath],
      generatedAt: now,
      sha256: sha256Hex(outPngBuf),
      reviewNotes: [],
    };
    const livePolicy = evaluateAssetDistributionPolicy(provenance, 'livestream_public');
    steps.push({
      step: 10,
      id: 'provenance_license_gate',
      label: '溯源哈希与许可隔离门禁',
      status: livePolicy.allowed ? 'ok' : 'warn',
      detail: `SHA256=${provenance.sha256.slice(0, 12)}…；${livePolicy.reason}`,
    });

    // Step 11: 等待人工审查后再导出 Stardew Mod
    steps.push({
      step: 11,
      id: 'stardew_mod_export',
      label: 'Stardew Avatar Mod 原子导出',
      status: 'skipped',
      detail: qa.valid ? '已进入候选区（review_required），审查批准后方可执行导出' : 'QA 未通过，禁止导出',
    });

    const snapshot = PixelAvatarJobSnapshotSchema.parse({
      jobId,
      characterId: req.characterId,
      displayName: req.displayName,
      tier: req.tier,
      status: qa.valid ? 'review_required' : 'validation_failed',
      compiledPrompt,
      sourcePngPath: req.sourcePngPath,
      outputPngPath: outPngPath,
      qa,
      provenance,
      steps,
      ...(qaErrors.length > 0 ? { error: qaErrors.join('；') } : {}),
      createdAt: now,
      updatedAt: now,
    });
    this.jobs.set(jobId, snapshot);
    this.saveJob(snapshot);
    return snapshot;
  }

  /** 候选区人工审批：QA 失败资产禁止 approve */
  reviewJob(params: {
    jobId: string;
    decision: 'approve' | 'reject';
    note?: string;
  }): { ok: boolean; error?: string; job?: PixelAvatarJobSnapshot } {
    const job = this.jobs.get(params.jobId);
    if (!job) return { ok: false, error: `像素流水线任务不存在：${params.jobId}` };
    if (params.decision === 'approve' && job.status === 'validation_failed') {
      return { ok: false, error: '像素 QA 校验失败（validation_failed），禁止批准导出' };
    }
    const nextStatus = params.decision === 'approve' ? 'approved' : 'restricted';
    const nextJob: PixelAvatarJobSnapshot = {
      ...job,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
      ...(job.provenance && params.note?.trim()
        ? {
          provenance: {
            ...job.provenance,
            reviewNotes: [...job.provenance.reviewNotes, `${params.decision}: ${params.note.trim()}`],
          },
        }
        : {}),
    };
    this.jobs.set(job.jobId, nextJob);
    this.saveJob(nextJob);
    return { ok: true, job: nextJob };
  }

  /** 仅允许已批准资产写入 stardew-avatars 并原子导出至 WhaleIsleAvatar Mod（支持单人与联机隔离目录） */
  exportToStardew(params: {
    jobId: string;
    modsDir?: string;
    profileModsDir?: string;
    installModIfMissing?: boolean;
  }): {
    ok: boolean;
    error?: string;
    job?: PixelAvatarJobSnapshot;
    verification?: StardewAvatarExportVerification;
  } {
    const job = this.jobs.get(params.jobId);
    if (!job) return { ok: false, error: `像素流水线任务不存在：${params.jobId}` };
    if (job.status !== 'approved' && job.status !== 'published') {
      return { ok: false, error: `资产状态为 ${job.status}，必须先经候选区批准（approved）后方可导出至游戏` };
    }
    if (!job.outputPngPath || !existsSync(job.outputPngPath)) {
      return { ok: false, error: '候选精灵表 PNG 文件缺失' };
    }

    const stardewId = toStardewCharacterId(job.characterId);
    const avatarsDir = resolve(join(this.options.userDataDir, 'stardew-avatars', stardewId));
    mkdirSync(avatarsDir, { recursive: true });
    const targetSpritePath = join(avatarsDir, SPRITE_FILE);
    const pngTmp = `${targetSpritePath}.tmp-${process.pid}`;
    writeFileSync(pngTmp, readFileSync(job.outputPngPath));
    renameSync(pngTmp, targetSpritePath);

    const targetModsDir = params.profileModsDir ?? params.modsDir ?? this.options.defaultModsDirOverride;
    const avatarHost = createStardewAvatarHost({
      userDataDir: this.options.userDataDir,
      repoRoot: this.options.repoRoot,
      ...(targetModsDir !== undefined ? { modsDirOverride: targetModsDir } : {}),
    });

    if (params.installModIfMissing !== false) {
      const currentState = avatarHost.state();
      if (!currentState.modInstalled && currentState.modsDir !== null) {
        const installed = avatarHost.installMod();
        if (!installed.ok) {
          return { ok: false, error: installed.error ?? '安装 WhaleIsleAvatar Mod 失败' };
        }
      }
    }

    let syncRes: { ok: boolean; error?: string };
    let resolvedModsRoot: string | null = null;
    if (params.profileModsDir) {
      resolvedModsRoot = resolve(params.profileModsDir);
      syncRes = avatarHost.writeForProfile({
        profileModsDir: resolvedModsRoot,
        characterId: stardewId,
        displayName: job.displayName,
      });
    } else {
      avatarHost.setEnabled(true);
      resolvedModsRoot = avatarHost.state().modsDir;
      syncRes = avatarHost.syncCharacter({
        characterId: stardewId,
        displayName: job.displayName,
      });
    }

    if (!syncRes.ok || !resolvedModsRoot) {
      return { ok: false, error: syncRes.error ?? '导出 Stardew Avatar 失败' };
    }

    const publishDir = join(this.options.repoRoot, 'mods', 'stardew-avatar-sync', 'publish');
    const verification = verifyStardewAvatarExport(join(resolvedModsRoot, MOD_FOLDER), publishDir);
    const updatedSteps = job.steps.map((s) =>
      s.step === 11
        ? {
          ...s,
          status: (verification.ok ? 'ok' : 'warn') as PixelPipelineStep['status'],
          detail: verification.ok
            ? `已导出至 ${join(resolvedModsRoot, MOD_FOLDER)}（${verification.spriteFile}）并校验通过`
            : `已写盘但校验存在提醒：${verification.issues.join('；')}`,
        }
        : s,
    );

    const nextJob: PixelAvatarJobSnapshot = PixelAvatarJobSnapshotSchema.parse({
      ...job,
      status: 'published',
      steps: updatedSteps,
      exportedModsDir: resolvedModsRoot,
      updatedAt: new Date().toISOString(),
    });
    this.jobs.set(job.jobId, nextJob);
    this.saveJob(nextJob);
    return { ok: true, job: nextJob, verification };
  }

  /** 只读检查本机或指定 Mods 目录的 WhaleIsleAvatar 导出就绪度 */
  verifyExport(modsDir?: string): StardewAvatarExportVerification {
    const resolvedModsDir =
      modsDir ??
      this.options.defaultModsDirOverride ??
      guessModsDirs(process.platform, process.env.HOME ?? '').find((d) => existsSync(d));
    const publishDir = join(this.options.repoRoot, 'mods', 'stardew-avatar-sync', 'publish');
    const modFolderPath = resolvedModsDir ? join(resolvedModsDir, MOD_FOLDER) : join(this.options.userDataDir, MOD_FOLDER);
    return verifyStardewAvatarExport(modFolderPath, publishDir);
  }
}
