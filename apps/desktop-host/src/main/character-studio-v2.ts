/**
 * Whale Isle V2 — Character Bible、2D/Live2D 创作质检与 CrossPet 全量合法导入（V2-P2-05 / REQ-CR-03）
 *
 * 工程与合规红线：
 *   - 绝不复制任何无许可证仓库源码；仅依据公开文件格式规范与 CrossPet CC BY-NC-SA 4.0 条款进行合法解析与导入；
 *   - 全部 CrossPet 资产强制写入 `CC BY-NC-SA 4.0` 署名、锁定 `DEV_ONLY_NON_COMMERCIAL` 并禁止商用/公开直播分发；
 *   - Character Bible 与 2D/Live2D 注册表原子落盘至 `<userData>/`，与候选区审查流联动而不直接覆盖随包只读资产。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import {
  Asset2dStudioPackageSchema,
  AssetDistributionChannelSchema,
  CharacterBibleAttachRefRequestSchema,
  CharacterBibleSchema,
  CharacterBibleUpsertRequestSchema,
  CrossPetImportedEntrySchema,
  CrossPetImportRequestSchema,
  CrossPetImportResultSchema,
  LicenseDistributionCheckSchema,
  Live2dAssetInspectionSchema,
  PetCustomCharacterSchema,
  type Asset2dStudioPackage,
  type AssetDistributionChannel,
  type AssetProvenance,
  type CharacterBible,
  type CrossPetImportedEntry,
  type CrossPetImportResult,
  type LicenseDistributionCheck,
  type Live2dAssetInspection,
  type Live2dLayerRole,
} from '@workbench/shared-protocol';
import { assertCustomId, customCharactersRoot, invalidateCustomCharacters } from './custom-character';
import { compileBiblePrompt, inspectImageAsset, type MediaGenerationGateway } from './media-gateway';

const BIBLES_DIR = 'character-bibles';
const STUDIO_2D_DIR = 'studio-2d-assets';
const IMAGE_FILE_RE = /\.(webp|png|jpe?g)$/i;
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const RECOMMENDED_2D_LAYERS: readonly Live2dLayerRole[] = ['hair_front', 'eyes', 'mouth', 'body'];

export const CROSSPET_ATTRIBUTION = 'CrossPet（lokicorvus/crosspet，CC BY-NC-SA 4.0；原作者 ZipZipPipe / 上善无形 等）';
export const CROSSPET_REPO_URL = 'https://github.com/lokicorvus/crosspet';

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

function isSafeSubpath(rootDir: string, targetPath: string): boolean {
  const root = resolve(rootDir);
  const target = resolve(rootDir, targetPath);
  return target === root || target.startsWith(`${root}${sep}`);
}

function sha256Hex(chunks: readonly Buffer[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

/** 强制评估资产分发/直播/商业策略：拦截 CC BY-NC-SA 4.0、DEV_ONLY 与未审资产 */
export function evaluateAssetDistributionPolicy(
  provenance: AssetProvenance,
  rawChannel: AssetDistributionChannel,
): LicenseDistributionCheck {
  const channel = AssetDistributionChannelSchema.parse(rawChannel);
  const licenseUpper = provenance.license.toUpperCase();
  const isNcLicense =
    licenseUpper.includes('NC') ||
    licenseUpper.includes('NON_COMMERCIAL') ||
    licenseUpper.includes('NON-COMMERCIAL') ||
    licenseUpper.includes('DEV_ONLY');
  const isReviewRequired = licenseUpper === 'AI_GENERATED_REVIEW_REQUIRED';

  const licenseScope: LicenseDistributionCheck['licenseScope'] =
    isNcLicense || (provenance.sourceType === 'third-party-import' && !provenance.allowCommercial)
      ? 'DEV_ONLY_NON_COMMERCIAL'
      : isReviewRequired
        ? 'REVIEW_REQUIRED'
        : provenance.allowCommercial && provenance.allowLivestream
          ? 'COMMERCIAL_READY'
          : 'DEV_ONLY_NON_COMMERCIAL';

  const attributionRequired =
    Boolean(provenance.author) ||
    provenance.sourceType === 'third-party-import' ||
    licenseUpper.includes('CC ') ||
    licenseUpper.includes('MIT') ||
    licenseUpper.includes('APACHE');
  const attributionText = attributionRequired
    ? (provenance.author ? `${provenance.author}（${provenance.license}）` : `来源授权：${provenance.license}`)
    : undefined;

  if (channel === 'local_personal') {
    return LicenseDistributionCheckSchema.parse({
      allowed: true,
      channel,
      license: provenance.license,
      licenseScope,
      reason: '仅限本机个人开发与自用展示',
      attributionRequired,
      ...(attributionText ? { attributionText } : {}),
    });
  }

  const channelCheckMap: Record<
    Exclude<AssetDistributionChannel, 'local_personal'>,
    { flag: boolean; label: string }
  > = {
    commercial_distribution: { flag: provenance.allowCommercial, label: '商业分发' },
    livestream_public: { flag: provenance.allowLivestream, label: '公开直播分发' },
    redistribution: { flag: provenance.allowRedistribution, label: '再分发' },
  };
  const policy = channelCheckMap[channel];
  const allowed = !isNcLicense && !isReviewRequired && policy.flag;
  const reason = allowed
    ? `${policy.label}授权校验通过（${provenance.license}）`
    : `已阻断${policy.label}：素材授权 ${provenance.license}（${licenseScope}）禁止用于${policy.label}`;

  return LicenseDistributionCheckSchema.parse({
    allowed,
    channel,
    license: provenance.license,
    licenseScope,
    reason,
    attributionRequired,
    ...(attributionText ? { attributionText } : {}),
  });
}

/** 持久化 Character Bible 仓库：支持参考图 QA 绑定、候选区晋升与提示词编译 */
export class CharacterBibleStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = resolve(join(userDataDir, BIBLES_DIR));
    mkdirSync(this.rootDir, { recursive: true });
  }

  private filePathOf(characterId: string): string {
    if (!SAFE_ID_RE.test(characterId)) {
      throw new Error(`CharacterBible id 非法：${characterId}`);
    }
    const target = resolve(join(this.rootDir, `${characterId}.json`));
    if (!target.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error('CharacterBible 目录越界');
    }
    return target;
  }

  list(): CharacterBible[] {
    const out: CharacterBible[] = [];
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = CharacterBibleSchema.safeParse(
          JSON.parse(readFileSync(join(this.rootDir, entry.name), 'utf8')) as unknown,
        );
        if (parsed.success) out.push(parsed.data);
      } catch {
        // 跳过损坏配置文件
      }
    }
    return out.sort((a, b) => a.characterId.localeCompare(b.characterId));
  }

  get(characterId: string): CharacterBible | null {
    const filePath = this.filePathOf(characterId);
    if (!existsSync(filePath)) return null;
    return CharacterBibleSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
  }

  upsert(rawInput: unknown): CharacterBible {
    const req = CharacterBibleUpsertRequestSchema.parse(rawInput);
    const existing = this.get(req.characterId);
    const now = new Date().toISOString();
    const next = CharacterBibleSchema.parse({
      characterId: req.characterId,
      displayName: req.displayName,
      version: existing ? existing.version + 1 : 1,
      referenceImages: req.referenceImages ?? existing?.referenceImages ?? [],
      traits: req.traits,
      expressionRules: req.expressionRules,
      styleConstraints: req.styleConstraints,
      forbiddenChanges: req.forbiddenChanges,
      updatedAt: now,
    });
    atomicWriteJson(this.filePathOf(next.characterId), next);
    return next;
  }

  attachReference(rawInput: unknown): CharacterBible {
    const req = CharacterBibleAttachRefRequestSchema.parse(rawInput);
    const existing = this.get(req.characterId);
    if (!existing) throw new Error(`CharacterBible 不存在：${req.characterId}`);
    if (!existsSync(req.path)) throw new Error(`参考图不存在：${req.path}`);
    const inspection = inspectImageAsset(readFileSync(req.path));
    if (!inspection.valid) {
      throw new Error(`参考图 QA 校验失败：${inspection.warnings.join('；')}`);
    }
    const filtered = existing.referenceImages.filter((item) => item.path !== req.path);
    filtered.push({
      role: req.role,
      path: req.path,
      approved: req.approved,
      sha256: inspection.sha256,
    });
    const next = CharacterBibleSchema.parse({
      ...existing,
      version: existing.version + 1,
      referenceImages: filtered,
      updatedAt: new Date().toISOString(),
    });
    atomicWriteJson(this.filePathOf(next.characterId), next);
    return next;
  }

  approveReference(characterId: string, refPath: string, approved: boolean): CharacterBible {
    const existing = this.get(characterId);
    if (!existing) throw new Error(`CharacterBible 不存在：${characterId}`);
    const hit = existing.referenceImages.find((item) => item.path === refPath);
    if (!hit) throw new Error(`参考图未绑定：${refPath}`);
    hit.approved = approved;
    const next = CharacterBibleSchema.parse({
      ...existing,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    });
    atomicWriteJson(this.filePathOf(next.characterId), next);
    return next;
  }

  async promoteFromMediaJob(
    characterId: string,
    gateway: MediaGenerationGateway,
    jobId: string,
    role: 'front' | 'side' | 'back' | 'portrait' | 'sheet' = 'portrait',
  ): Promise<{ ok: boolean; error?: string; published?: string[]; bible?: CharacterBible }> {
    const existing = this.get(characterId);
    if (!existing) return { ok: false, error: `CharacterBible 不存在：${characterId}` };
    const promoted = await gateway.promoteApprovedCandidates(jobId, (approvedItems) => {
      const refs = [...existing.referenceImages];
      for (const item of approvedItems) {
        const nextIdx = refs.findIndex((r) => r.path === item.filePath);
        const refEntry = {
          role,
          path: item.filePath,
          approved: true,
          sha256: item.provenance.sha256,
        };
        if (nextIdx >= 0) refs[nextIdx] = refEntry;
        else refs.push(refEntry);
      }
      const next = CharacterBibleSchema.parse({
        ...existing,
        version: existing.version + 1,
        referenceImages: refs,
        updatedAt: new Date().toISOString(),
      });
      atomicWriteJson(this.filePathOf(characterId), next);
    });
    if (!promoted.ok) return { ok: false, error: promoted.error };
    return { ok: true, published: promoted.published, bible: this.get(characterId)! };
  }

  compilePrompt(characterId: string, poseOrSlot: string, extraPrompt = ''): string {
    const existing = this.get(characterId);
    if (!existing) throw new Error(`CharacterBible 不存在：${characterId}`);
    return compileBiblePrompt(existing, poseOrSlot, extraPrompt);
  }
}

function detectLayerRole(name: string): Live2dLayerRole {
  const lower = name.toLowerCase();
  if (/(hair_front|front_hair|bangs|前发)/.test(lower)) return 'hair_front';
  if (/(hair_back|back_hair|后发)/.test(lower)) return 'hair_back';
  if (/(eyebrow|brows?|眉)/.test(lower)) return 'brows';
  if (/(eyes?|pupil|iris|眼)/.test(lower)) return 'eyes';
  if (/(mouth|lip|嘴|唇)/.test(lower)) return 'mouth';
  if (/(face|head|脸)/.test(lower)) return 'face';
  if (/(body|torso|limb|身)/.test(lower)) return 'body';
  if (/(outfit|cloth|dress|suit|衣|服)/.test(lower)) return 'outfit';
  if (/(accessory|acc|hat|ribbon|tail|ear|饰|尾)/.test(lower)) return 'accessory';
  return 'other';
}

interface CubismModel3Shape {
  FileReferences?: {
    Moc?: unknown;
    Textures?: unknown;
    Physics?: unknown;
    DisplayInfo?: unknown;
    Expressions?: Array<{ Name?: unknown; File?: unknown }>;
    Motions?: Record<string, Array<{ File?: unknown }>>;
  };
  Groups?: Array<{ Name?: unknown; Ids?: unknown }>;
}

/**
 * 确定性 2D / Live2D 资产质检：
 *   - Live2D Cubism (`*.model3.json` 目录或文件)：检查 `.moc3`、纹理魔数、路径防穿越、Expressions/Motions、口型 `LipSync`/`ParamMouthOpenY` 与眨眼/头部参数；
 *   - 2D 分层资产包（含 `layers.json` 或多张分层图像）：检查图元魔数与核心分层齐全度（前发/眼/嘴/身体）。
 */
export function inspectLive2dOrLayered2d(targetPath: string): Live2dAssetInspection {
  if (!existsSync(targetPath)) {
    return Live2dAssetInspectionSchema.parse({
      valid: false,
      format: 'unknown',
      hasMouthOpenParam: false,
      hasEyeBlinkParams: false,
      hasHeadAngleParams: false,
      lipSyncReady: false,
      physicsPresent: false,
      sha256: sha256Hex([]),
      errors: [`目标路径不存在：${targetPath}`],
    });
  }

  const stat = statSync(targetPath);
  const rootDir = stat.isDirectory() ? resolve(targetPath) : resolve(targetPath, '..');
  const model3File = stat.isFile() && targetPath.endsWith('.model3.json')
    ? resolve(targetPath)
    : (() => {
        const hit = readdirSync(rootDir, { withFileTypes: true }).find(
          (d) => d.isFile() && d.name.endsWith('.model3.json'),
        );
        return hit ? join(rootDir, hit.name) : null;
      })();

  if (model3File !== null) {
    return inspectCubismModel3(rootDir, model3File);
  }
  return inspectLayered2dDirectory(rootDir);
}

function inspectCubismModel3(rootDir: string, model3Path: string): Live2dAssetInspection {
  const buf = readFileSync(model3Path);
  const errors: string[] = [];
  const warnings: string[] = [];
  const hashChunks: Buffer[] = [buf];

  let parsed: CubismModel3Shape;
  try {
    parsed = JSON.parse(buf.toString('utf8')) as CubismModel3Shape;
  } catch (err) {
    return Live2dAssetInspectionSchema.parse({
      valid: false,
      format: 'cubism-model3',
      model3Path,
      hasMouthOpenParam: false,
      hasEyeBlinkParams: false,
      hasHeadAngleParams: false,
      lipSyncReady: false,
      physicsPresent: false,
      sha256: sha256Hex(hashChunks),
      errors: [`model3.json 解析失败：${err instanceof Error ? err.message : String(err)}`],
    });
  }

  const refs = parsed.FileReferences ?? {};
  let mocPath: string | undefined;
  if (typeof refs.Moc !== 'string' || refs.Moc.trim() === '') {
    errors.push('model3.json 缺少 FileReferences.Moc');
  } else if (!isSafeSubpath(rootDir, refs.Moc)) {
    errors.push(`Moc 路径越界：${refs.Moc}`);
  } else {
    const absMoc = resolve(rootDir, refs.Moc);
    if (!existsSync(absMoc)) errors.push(`Moc 文件不存在：${refs.Moc}`);
    else {
      mocPath = absMoc;
      hashChunks.push(readFileSync(absMoc));
    }
  }

  const textures: string[] = [];
  const rawTextures = Array.isArray(refs.Textures) ? refs.Textures : [];
  if (rawTextures.length === 0) {
    errors.push('model3.json 缺少 FileReferences.Textures');
  }
  for (const rel of rawTextures) {
    if (typeof rel !== 'string' || !isSafeSubpath(rootDir, rel)) {
      errors.push(`纹理路径越界或非法：${String(rel)}`);
      continue;
    }
    const absTex = resolve(rootDir, rel);
    if (!existsSync(absTex)) {
      errors.push(`纹理文件不存在：${rel}`);
      continue;
    }
    const texBuf = readFileSync(absTex);
    const qa = inspectImageAsset(texBuf);
    if (!qa.valid) {
      errors.push(`纹理图像校验失败（${rel}）：${qa.warnings.join('；')}`);
      continue;
    }
    textures.push(rel);
    hashChunks.push(texBuf);
  }

  let physicsPresent = false;
  if (typeof refs.Physics === 'string' && refs.Physics.trim() !== '') {
    if (!isSafeSubpath(rootDir, refs.Physics) || !existsSync(resolve(rootDir, refs.Physics))) {
      warnings.push(`物理配置文件缺失或路径非法：${refs.Physics}`);
    } else {
      physicsPresent = true;
    }
  }

  const expressions = Array.isArray(refs.Expressions)
    ? refs.Expressions.map((e) => String(e.Name ?? e.File ?? '')).filter((s) => s !== '')
    : [];
  const motions = refs.Motions && typeof refs.Motions === 'object' ? Object.keys(refs.Motions) : [];

  const paramSet = new Set<string>();
  const groups = Array.isArray(parsed.Groups) ? parsed.Groups : [];
  let lipSyncGroup = false;
  let eyeBlinkGroup = false;
  for (const g of groups) {
    const ids = Array.isArray(g.Ids) ? g.Ids.map(String) : [];
    for (const id of ids) paramSet.add(id);
    if (g.Name === 'LipSync' && ids.length > 0) lipSyncGroup = true;
    if (g.Name === 'EyeBlink' && ids.length > 0) eyeBlinkGroup = true;
  }

  if (typeof refs.DisplayInfo === 'string' && isSafeSubpath(rootDir, refs.DisplayInfo)) {
    const absCdi = resolve(rootDir, refs.DisplayInfo);
    if (existsSync(absCdi)) {
      try {
        const cdi = JSON.parse(readFileSync(absCdi, 'utf8')) as { Parameters?: Array<{ Id?: unknown }> };
        for (const p of cdi.Parameters ?? []) {
          if (typeof p.Id === 'string' && p.Id !== '') paramSet.add(p.Id);
        }
      } catch {
        warnings.push('cdi3.json 参数描述文件损坏，已忽略');
      }
    }
  }

  const parameters = [...paramSet];
  const hasMouthOpenParam =
    lipSyncGroup || parameters.some((id) => /mouth.*open|parammouthopeny/i.test(id));
  const hasEyeBlinkParams =
    eyeBlinkGroup || parameters.some((id) => /eye.*[lr].*open|parameye/i.test(id));
  const hasHeadAngleParams = parameters.some((id) => /angle[xyz]/i.test(id));
  if (!hasMouthOpenParam) warnings.push('未检测到 LipSync 或 ParamMouthOpenY 口型参数');

  return Live2dAssetInspectionSchema.parse({
    valid: errors.length === 0,
    format: 'cubism-model3',
    model3Path,
    ...(mocPath ? { mocPath } : {}),
    textures,
    expressions,
    motions,
    parameters,
    hasMouthOpenParam,
    hasEyeBlinkParams,
    hasHeadAngleParams,
    lipSyncReady: errors.length === 0 && hasMouthOpenParam,
    physicsPresent,
    sha256: sha256Hex(hashChunks),
    warnings,
    errors,
  });
}

function inspectLayered2dDirectory(rootDir: string): Live2dAssetInspection {
  const manifestPath = join(rootDir, 'layers.json');
  const hashChunks: Buffer[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const roleSet = new Set<Live2dLayerRole>();
  const textures: string[] = [];

  if (existsSync(manifestPath)) {
    const manifestBuf = readFileSync(manifestPath);
    hashChunks.push(manifestBuf);
    try {
      const raw = JSON.parse(manifestBuf.toString('utf8')) as
        | Array<{ name?: string; role?: string; file?: string }>
        | { layers?: Array<{ name?: string; role?: string; file?: string }> };
      const list = Array.isArray(raw) ? raw : (raw.layers ?? []);
      for (const item of list) {
        const rel = String(item.file ?? item.name ?? '');
        if (rel === '' || !isSafeSubpath(rootDir, rel)) {
          errors.push(`图层路径越界或为空：${rel}`);
          continue;
        }
        const abs = resolve(rootDir, rel);
        if (!existsSync(abs)) {
          errors.push(`图层文件缺失：${rel}`);
          continue;
        }
        const imgBuf = readFileSync(abs);
        const qa = inspectImageAsset(imgBuf);
        if (!qa.valid) {
          errors.push(`图层图像损坏（${rel}）：${qa.warnings.join('；')}`);
          continue;
        }
        hashChunks.push(imgBuf);
        textures.push(rel);
        roleSet.add(detectLayerRole(`${item.role ?? ''} ${item.name ?? ''} ${rel}`));
      }
    } catch (err) {
      errors.push(`layers.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    const images = readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isFile() && IMAGE_FILE_RE.test(d.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const img of images) {
      const imgBuf = readFileSync(join(rootDir, img.name));
      const qa = inspectImageAsset(imgBuf);
      if (!qa.valid) {
        errors.push(`分层图像校验失败（${img.name}）：${qa.warnings.join('；')}`);
        continue;
      }
      hashChunks.push(imgBuf);
      textures.push(img.name);
      roleSet.add(detectLayerRole(img.name));
    }
  }

  if (textures.length === 0 && errors.length === 0) {
    errors.push('目录中未找到 .model3.json 或 2D 分层图像资产');
  }

  const detectedLayers = [...roleSet];
  const missingRecommendedLayers = RECOMMENDED_2D_LAYERS.filter((role) => !roleSet.has(role));
  if (missingRecommendedLayers.length > 0 && errors.length === 0) {
    warnings.push(`2D 分层缺少推荐核心图层：${missingRecommendedLayers.join('、')}`);
  }

  return Live2dAssetInspectionSchema.parse({
    valid: errors.length === 0 && textures.length > 0,
    format: textures.length > 0 || existsSync(manifestPath) ? 'layered-2d-pack' : 'unknown',
    textures,
    detectedLayers,
    missingRecommendedLayers,
    hasMouthOpenParam: roleSet.has('mouth'),
    hasEyeBlinkParams: roleSet.has('eyes'),
    hasHeadAngleParams: false,
    lipSyncReady: errors.length === 0 && roleSet.has('mouth'),
    physicsPresent: false,
    sha256: sha256Hex(hashChunks),
    warnings,
    errors,
  });
}

function normalizeCrossPetCustomId(slug: string): string {
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const id = `cp-${cleaned}`.slice(0, 41).replace(/-+$/g, '');
  return assertCustomId(id);
}

function resolveCrossPetSources(sourceDir: string): {
  licenseRoot: string;
  entries: Array<{ slug: string; dir: string }>;
} {
  if (!existsSync(sourceDir)) {
    throw new Error(`CrossPet 源目录不存在：${sourceDir}`);
  }
  if (existsSync(join(sourceDir, 'character.json'))) {
    const abs = resolve(sourceDir);
    return { licenseRoot: resolve(abs, '..'), entries: [{ slug: basename(abs), dir: abs }] };
  }
  const nestedChars = join(sourceDir, 'characters');
  const charsRoot = existsSync(nestedChars) ? resolve(nestedChars) : resolve(sourceDir);
  const dirs = readdirSync(charsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ slug: d.name, dir: join(charsRoot, d.name) }));
  return { licenseRoot: charsRoot, entries: dirs };
}

function findLicenseSummary(candidates: readonly string[]): { found: boolean; summary: string } {
  for (const dir of candidates) {
    const file = join(dir, 'LICENSE.md');
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      return { found: true, summary: lines.slice(0, 4).join(' | ') };
    }
  }
  return {
    found: false,
    summary: '未在源目录发现 LICENSE.md，已按仓库审计结论强制锁定为 CC BY-NC-SA 4.0（DEV_ONLY_NON_COMMERCIAL）',
  };
}

/** 统一管理 Character Bible、2D/Live2D 注册表、分发许可门禁与 CrossPet 全量导入 */
export class CharacterStudioV2 {
  readonly bibles: CharacterBibleStore;
  private readonly studioRoot: string;
  private readonly registryPath: string;
  private readonly packsRoot: string;

  constructor(private readonly options: { userDataDir: string; packsRoot: string }) {
    this.bibles = new CharacterBibleStore(options.userDataDir);
    this.studioRoot = resolve(join(options.userDataDir, STUDIO_2D_DIR));
    this.registryPath = join(this.studioRoot, 'registry.json');
    this.packsRoot = resolve(options.packsRoot);
    mkdirSync(this.studioRoot, { recursive: true });
  }

  list2dPackages(characterId?: string): Asset2dStudioPackage[] {
    if (!existsSync(this.registryPath)) return [];
    const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8')) as unknown;
    const rawList = Array.isArray(parsed) ? parsed : [];
    const out: Asset2dStudioPackage[] = [];
    for (const item of rawList) {
      const pkg = Asset2dStudioPackageSchema.safeParse(item);
      if (pkg.success && (characterId === undefined || pkg.data.characterId === characterId)) {
        out.push(pkg.data);
      }
    }
    return out;
  }

  private saveRegistry(packages: readonly Asset2dStudioPackage[]): void {
    atomicWriteJson(this.registryPath, packages);
  }

  register2dPackage(input: {
    packageId?: string;
    characterId: string;
    displayName: string;
    kind: Asset2dStudioPackage['kind'];
    rootDir: string;
    provenance: AssetProvenance;
    poseCount?: number;
    status?: Asset2dStudioPackage['status'];
  }): Asset2dStudioPackage {
    const absRoot = resolve(input.rootDir);
    if (!existsSync(absRoot)) throw new Error(`2D 资产目录不存在：${absRoot}`);
    const inspection =
      input.kind === 'live2d' || input.kind === 'layered-2d' ? inspectLive2dOrLayered2d(absRoot) : undefined;
    const now = new Date().toISOString();
    const packageId = input.packageId ?? `${input.kind}-${input.characterId}`;
    const existingAll = this.list2dPackages();
    const existing = existingAll.find((p) => p.packageId === packageId);
    const pkg = Asset2dStudioPackageSchema.parse({
      packageId,
      characterId: input.characterId,
      displayName: input.displayName,
      kind: input.kind,
      rootDir: absRoot,
      status: input.status ?? (inspection && !inspection.valid ? 'validation_failed' : 'approved'),
      provenance: input.provenance,
      ...(inspection ? { live2dInspection: inspection } : {}),
      poseCount: input.poseCount ?? inspection?.textures.length ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const nextList = [...existingAll.filter((p) => p.packageId !== packageId), pkg];
    this.saveRegistry(nextList);
    return pkg;
  }

  check2dDistribution(packageId: string, channel: AssetDistributionChannel): LicenseDistributionCheck {
    const pkg = this.list2dPackages().find((p) => p.packageId === packageId);
    if (!pkg) throw new Error(`2D 资产包不存在：${packageId}`);
    return evaluateAssetDistributionPolicy(pkg.provenance, channel);
  }

  importCrossPetPack(rawReq: unknown = {}): CrossPetImportResult {
    const req = CrossPetImportRequestSchema.parse(rawReq);
    const resolvedSource = resolve(req.sourceDir ?? join(this.packsRoot, 'crosspet', 'characters'));
    const { licenseRoot, entries: discovered } = resolveCrossPetSources(resolvedSource);
    const licenseInfo = findLicenseSummary([
      licenseRoot,
      resolve(licenseRoot, '..'),
      resolvedSource,
    ]);
    const warnings: string[] = [];
    if (!licenseInfo.found) warnings.push(licenseInfo.summary);

    const filterSet = req.characterIds ? new Set(req.characterIds) : null;
    const customRoot = customCharactersRoot(this.options.userDataDir);
    mkdirSync(customRoot, { recursive: true });

    const outEntries: CrossPetImportedEntry[] = [];
    const errors: string[] = [];
    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const item of discovered) {
      if (filterSet && !filterSet.has(item.slug)) continue;
      const charJsonPath = join(item.dir, 'character.json');
      if (!existsSync(charJsonPath)) {
        errors.push(`${item.slug}：缺少 character.json`);
        failedCount += 1;
        continue;
      }

      const rawJsonBuf = readFileSync(charJsonPath);
      let parsedChar;
      try {
        parsedChar = PetCustomCharacterSchema.safeParse(JSON.parse(rawJsonBuf.toString('utf8')) as unknown);
      } catch (err) {
        errors.push(`${item.slug}：character.json 解析失败（${err instanceof Error ? err.message : String(err)}）`);
        failedCount += 1;
        continue;
      }
      if (!parsedChar.success) {
        errors.push(`${item.slug}：character.json 契约校验失败`);
        failedCount += 1;
        continue;
      }

      const charData = parsedChar.data;
      const category: CrossPetImportedEntry['category'] =
        charData.egg || item.slug.startsWith('egg-')
          ? 'egg'
          : charData.skinOf !== ''
            ? 'skin'
            : 'base';
      if (category === 'skin' && !req.includeSkins) continue;
      if (category === 'egg' && !req.includeEggs) continue;

      const poseFiles = readdirSync(item.dir, { withFileTypes: true })
        .filter((d) => d.isFile() && IMAGE_FILE_RE.test(d.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      const hashBuffers: Buffer[] = [rawJsonBuf];
      const validPoseFiles: string[] = [];
      let poseCorrupt = false;
      for (const pose of poseFiles) {
        const poseBuf = readFileSync(join(item.dir, pose.name));
        const qa = inspectImageAsset(poseBuf);
        if (!qa.valid) {
          errors.push(`${item.slug}/${pose.name}：姿态图损坏（${qa.warnings.join('；')}）`);
          poseCorrupt = true;
          break;
        }
        hashBuffers.push(poseBuf);
        validPoseFiles.push(pose.name);
      }
      if (poseCorrupt || validPoseFiles.length === 0) {
        if (!poseCorrupt) errors.push(`${item.slug}：未找到有效姿态图像`);
        failedCount += 1;
        continue;
      }

      const customId = normalizeCrossPetCustomId(item.slug);
      const characterId = `custom-${customId}`;
      const destDir = resolve(join(customRoot, customId));
      const provenance: AssetProvenance = {
        sourceType: 'third-party-import',
        author: CROSSPET_ATTRIBUTION,
        repoOrUrl: CROSSPET_REPO_URL,
        license: 'CC BY-NC-SA 4.0',
        allowCommercial: false,
        allowLivestream: false,
        allowRedistribution: false,
        inputRefPaths: [item.dir],
        generatedAt: new Date().toISOString(),
        sha256: sha256Hex(hashBuffers),
        reviewNotes: ['CrossPet CC BY-NC-SA 4.0 非商用隔离：已禁用商用与公开商业直播分发'],
      };

      if (existsSync(destDir) && !req.overwrite) {
        skippedCount += 1;
        outEntries.push(
          CrossPetImportedEntrySchema.parse({
            slug: item.slug,
            customId,
            characterId,
            displayName: charData.name,
            category,
            poseCount: validPoseFiles.length,
            skipped: true,
            reason: '目标目录已存在且未开启 overwrite',
            licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
            attribution: CROSSPET_ATTRIBUTION,
            bibleUpdated: false,
            provenance,
          }),
        );
        continue;
      }

      mkdirSync(destDir, { recursive: true });
      cpSync(charJsonPath, join(destDir, 'character.json'));
      for (const poseName of validPoseFiles) {
        cpSync(join(item.dir, poseName), join(destDir, poseName));
      }
      atomicWriteJson(join(destDir, '.provenance.json'), {
        licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
        attribution: CROSSPET_ATTRIBUTION,
        provenance,
      });

      this.register2dPackage({
        packageId: `crosspet-import-${customId}`,
        characterId,
        displayName: charData.name,
        kind: 'crosspet-import',
        rootDir: destDir,
        provenance,
        poseCount: validPoseFiles.length,
        status: 'approved',
      });

      let bibleUpdated = false;
      if (req.bindCharacterBible && category === 'base') {
        const refFile = validPoseFiles.includes('portrait.webp')
          ? 'portrait.webp'
          : (validPoseFiles.includes('idle.webp') ? 'idle.webp' : validPoseFiles[0]!);
        const refAbs = join(destDir, refFile);
        const refQa = inspectImageAsset(readFileSync(refAbs));
        this.bibles.upsert({
          characterId,
          displayName: charData.name,
          referenceImages: [
            {
              role: refFile.startsWith('portrait') ? 'portrait' : 'front',
              path: refAbs,
              approved: true,
              sha256: refQa.sha256,
            },
          ],
          traits: {
            hairstyle: '',
            eyes: '',
            palette: charData.accent ? [charData.accent] : [],
            outfit: charData.outfit ?? '',
            proportions: 'CrossPet Q版桌宠比例',
            signatureAccessories: [],
          },
          expressionRules: Object.keys(charData.lines).slice(0, 12),
          styleConstraints: [charData.greeting || `保持 ${charData.name} 原作形象设定`],
          forbiddenChanges: [
            '禁止商用与公开商业直播分发（CC BY-NC-SA 4.0）',
            '保留 CrossPet 与原作者署名',
          ],
        });
        bibleUpdated = true;
      }

      importedCount += 1;
      outEntries.push(
        CrossPetImportedEntrySchema.parse({
          slug: item.slug,
          customId,
          characterId,
          displayName: charData.name,
          category,
          poseCount: validPoseFiles.length,
          skipped: false,
          licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
          attribution: CROSSPET_ATTRIBUTION,
          bibleUpdated,
          provenance,
        }),
      );
    }

    if (importedCount > 0) invalidateCustomCharacters();

    return CrossPetImportResultSchema.parse({
      ok: failedCount === 0,
      sourceDir: resolvedSource,
      licenseFileFound: licenseInfo.found,
      licenseTextSummary: licenseInfo.summary,
      totalDiscovered: outEntries.length + failedCount,
      importedCount,
      skippedCount,
      failedCount,
      entries: outEntries,
      errors,
      warnings,
    });
  }
}
