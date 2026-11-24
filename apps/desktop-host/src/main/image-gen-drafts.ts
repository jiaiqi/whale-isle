/**
 * 生图草稿的路径/并发/提示词纯工具（T-M6-56），从 creator-host 拆出便于单测。
 *
 * 安全边界：任务 id 白名单字符、草稿目录必须位于 userData/creator-drafts 下、
 * 参考图必须是真实存在的 PNG/WebP/JPG 且 ≤20MB。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{3,59}$/;
const IMAGE_EXT = /\.(webp|png|jpe?g)$/i;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

export function assertDraftJobId(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new Error('非法草稿任务 id');
  return jobId;
}

/** 草稿目录严格位于 root 之下（防 ../ 穿越）。 */
export function draftDirFor(root: string, jobId: string): string {
  assertDraftJobId(jobId);
  const resolvedRoot = resolve(root);
  mkdirSync(resolvedRoot, { recursive: true });
  const dir = resolve(join(resolvedRoot, jobId));
  if (dir !== resolvedRoot && !dir.startsWith(`${resolvedRoot}${sep}`)) throw new Error('草稿目录越界');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface ReferenceStat {
  isFile: () => boolean;
  size: number;
}

export function resolveReferenceImage(
  raw: string | undefined,
  deps: { exists?: (path: string) => boolean; stat?: (path: string) => ReferenceStat } = {},
): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const exists = deps.exists ?? existsSync;
  const stat = deps.stat ?? ((path: string) => statSync(path));
  const path = resolve(raw);
  if (!exists(path)) throw new Error('参考图不存在');
  const info = stat(path);
  if (!info.isFile()) throw new Error('参考图不存在');
  if (!IMAGE_EXT.test(path)) throw new Error('参考图必须是 PNG/WebP/JPG');
  if (info.size > MAX_REFERENCE_BYTES) throw new Error('参考图超过 20MB');
  return path;
}

/** 每张图的提示词：统一画幅/透明底/Q 版，避免模型自由发挥导致入库后大小不一。 */
export function draftPosePrompt(prompt: string, pose: string): string {
  return `${prompt.trim()}\n\n本次只生成姿态「${pose}」的一张角色立绘：单人、全身、完整不裁切、透明背景、2.5 头身 Q 版、无文字无水印。`;
}

export function draftExtension(mimeType: string): 'png' | 'webp' | 'jpg' {
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  return 'png';
}

export interface DraftFileCandidate {
  pose: string;
  status: string;
  file?: string;
}

/** 只收集「已完成且文件真实存在」的草稿，供 importImages 后处理。 */
export function collectDoneDraftFiles(
  items: readonly DraftFileCandidate[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  return items
    .filter((item) => item.status === 'done' && item.file !== undefined && exists(item.file))
    .map((item) => item.file as string);
}

/** 简单工作池：并发上限固定，异常由 worker 自行消化（批量任务不因单张失败中断）。 */
export async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(Math.floor(limit), queue.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** 模型候选：保留用户候选；为空时给协议默认生图模型（诚实标注为候选，不代表账号一定可用）。 */
export function imageModelsFor(protocol: 'openai' | 'gemini', candidates: readonly string[]): string[] {
  const base = candidates.length > 0
    ? candidates
    : (protocol === 'gemini'
      ? ['gemini-2.5-flash-image-preview', 'gemini-2.0-flash-preview-image-generation']
      : ['gpt-image-1', 'dall-e-3']);
  return [...new Set(base)].slice(0, 12);
}
