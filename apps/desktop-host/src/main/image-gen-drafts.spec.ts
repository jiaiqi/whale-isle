/** 生图草稿工具（T-M6-56）：路径防穿越、参考图校验、并发 ≤2、入库文件收集与姿态名衔接。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDraftJobId,
  collectDoneDraftFiles,
  draftDirFor,
  draftExtension,
  draftPosePrompt,
  imageModelsFor,
  resolveReferenceImage,
  runWithConcurrency,
} from './image-gen-drafts';
import { NON_POSE_FILES, sanitizePoseId } from './image-pipeline';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drafts-'));
  dirs.push(dir);
  return dir;
}

describe('草稿目录与任务 id', () => {
  it('合法 id 创建在 root 下；非法 id / 穿越直接拒绝', () => {
    const root = temp();
    const dir = draftDirFor(root, 'gen-abc123');
    expect(dir.startsWith(root)).toBe(true);
    expect(() => assertDraftJobId('../evil')).toThrow('非法');
    expect(() => assertDraftJobId('Gen-UPPER')).toThrow('非法');
    expect(() => assertDraftJobId('ab')).toThrow('非法');
    expect(() => draftDirFor(root, '..')).toThrow();
  });
});

describe('参考图校验', () => {
  it('缺失/非图片/超过 20MB 拒绝；合法图片返回绝对路径', () => {
    const root = temp();
    const ok = join(root, 'ref.png');
    writeFileSync(ok, 'png');
    expect(resolveReferenceImage(ok)).toBe(ok);
    expect(resolveReferenceImage('')).toBeUndefined();
    expect(() => resolveReferenceImage(join(root, 'missing.png'))).toThrow('不存在');
    const text = join(root, 'ref.txt');
    writeFileSync(text, 'x');
    expect(() => resolveReferenceImage(text)).toThrow('PNG/WebP/JPG');
    expect(() => resolveReferenceImage(ok, { stat: () => ({ isFile: () => true, size: 21 * 1024 * 1024 }) })).toThrow('20MB');
    expect(() => resolveReferenceImage(ok, { stat: () => ({ isFile: () => false, size: 1 }) })).toThrow('不存在');
  });
});

describe('提示词与文件命名', () => {
  it('每张带姿态名与统一画幅规则；mime→扩展名', () => {
    const prompt = draftPosePrompt('  画一只海豹  ', 'caught');
    expect(prompt).toContain('画一只海豹');
    expect(prompt).toContain('姿态「caught」');
    expect(prompt).toContain('透明背景');
    expect(draftExtension('image/png')).toBe('png');
    expect(draftExtension('image/webp')).toBe('webp');
    expect(draftExtension('image/jpeg')).toBe('jpg');
  });

  it('草稿文件名经 sanitizePoseId 还原姿态名，且不会被当成 avatar/portrait 过滤', () => {
    const root = temp();
    const files = ['caught.png', 'idle.webp', 'avatar.png'].map((name) => {
      const path = join(root, name);
      writeFileSync(path, 'x');
      return path;
    });
    const done = collectDoneDraftFiles([
      { pose: 'caught', status: 'done', file: files[0] },
      { pose: 'idle', status: 'done', file: files[1] },
      { pose: 'avatar', status: 'done', file: files[2] },
      { pose: 'failed', status: 'failed', file: join(root, 'failed.png') },
      { pose: 'gone', status: 'done', file: join(root, 'gone.png') },
    ]);
    expect(done).toEqual([files[0], files[1], files[2]]);
    expect(done.map((path) => sanitizePoseId(path.split('/').pop() ?? ''))).toEqual(['caught', 'idle', 'avatar']);
    expect(NON_POSE_FILES.has('avatar')).toBe(true);
  });
});

describe('runWithConcurrency', () => {
  it('并发上限 2：峰值不超过 2，所有任务都完成', async () => {
    const items = Array.from({ length: 7 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runWithConcurrency(items, 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(item);
      active -= 1;
    });
    expect(peak).toBe(2);
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('limit 小于 1 按 1；空列表立即完成', async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3], 0, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    expect(peak).toBe(1);
    await expect(runWithConcurrency([], 2, async () => { throw new Error('不该执行'); })).resolves.toBeUndefined();
  });
});

describe('imageModelsFor', () => {
  it('候选为空给协议默认；有候选去重截断；不混入聊天模型', () => {
    expect(imageModelsFor('openai', [])).toEqual(['gpt-image-1', 'dall-e-3']);
    expect(imageModelsFor('gemini', [])).toContain('gemini-2.5-flash-image-preview');
    expect(imageModelsFor('openai', ['gpt-image-1', 'gpt-image-1', 'dall-e-3'])).toEqual(['gpt-image-1', 'dall-e-3']);
    expect(imageModelsFor('openai', Array.from({ length: 20 }, (_, index) => `m-${index}`))).toHaveLength(12);
  });
});
