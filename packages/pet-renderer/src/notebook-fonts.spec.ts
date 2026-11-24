/** 小本子 8 套手写体映射（T-M6-63）：家族识别、auto 回退、URL 编码。 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTEBOOK_PAPER,
  NOTEBOOK_FONTS,
  NOTEBOOK_FONT_BY_FAMILY,
  NOTEBOOK_PAPER_BY_FAMILY,
  notebookFamilyOf,
  notebookFontById,
  notebookFontForCharacter,
  notebookFontUrl,
  notebookPaperForCharacter,
} from './notebook-fonts';

describe('NOTEBOOK_FONT_BY_FAMILY', () => {
  it('8 个家族各有一套 woff2，id/文件/标签齐全', () => {
    expect(Object.keys(NOTEBOOK_FONT_BY_FAMILY)).toEqual(['deepseek', 'claude', 'gpt', 'gemini', 'glm', 'qwen', 'kimi', 'grok']);
    expect(NOTEBOOK_FONTS).toHaveLength(8);
    for (const font of NOTEBOOK_FONTS) {
      expect(font.file).toMatch(/\.woff2$/);
      expect(font.id).not.toBe('');
      expect(font.label).not.toBe('');
    }
  });
});

describe('notebookFamilyOf / notebookFontForCharacter', () => {
  it('crosspet 皮肤归基础家族；aboutme 直接取 slug', () => {
    expect(notebookFamilyOf('crosspet-deepseek-pajamas')).toBe('deepseek');
    expect(notebookFamilyOf('aboutme-claude')).toBe('claude');
    expect(notebookFontForCharacter('crosspet-gpt-onesie')?.id).toBe('zcool-xiaowei');
    expect(notebookFontForCharacter('aboutme-glm')?.id).toBe('zhi-mang-xing');
  });

  it('自定义/未知角色返回 null（不硬套字体）', () => {
    expect(notebookFamilyOf('custom-my-pet')).toBeNull();
    expect(notebookFamilyOf('blue-whale-maid')).toBeNull();
    expect(notebookFontForCharacter('aboutme-dsh')).toBeNull();
    expect(notebookFontForCharacter('custom-x')).toBeNull();
  });
});

describe('notebookFontById / notebookFontUrl', () => {
  it('auto/空/未知 id 返回 null；已知 id 命中', () => {
    expect(notebookFontById('auto')).toBeNull();
    expect(notebookFontById('')).toBeNull();
    expect(notebookFontById('nope')).toBeNull();
    expect(notebookFontById('notebook-kai')?.label).toBe('小本子楷体');
  });

  it('固定 whale-pet:// 路径并对文件名做百分号编码', () => {
    expect(notebookFontUrl('ma-shan-zheng.woff2')).toBe('whale-pet://crosspet/app/web/fonts/notebook/ma-shan-zheng.woff2');
    expect(notebookFontUrl('中文 体.woff2')).toBe('whale-pet://crosspet/app/web/fonts/notebook/%E4%B8%AD%E6%96%87%20%E4%BD%93.woff2');
  });
});

describe('笔记本纸张主题', () => {
  it('8 家族各有专属纸张/强调色，同家族皮肤一致', () => {
    expect(Object.keys(NOTEBOOK_PAPER_BY_FAMILY)).toHaveLength(8);
    expect(notebookPaperForCharacter('crosspet-deepseek-pajamas')).toBe(NOTEBOOK_PAPER_BY_FAMILY.deepseek);
    expect(notebookPaperForCharacter('aboutme-claude')).toBe(NOTEBOOK_PAPER_BY_FAMILY.claude);
  });

  it('未知/自定义角色回退素色便签', () => {
    expect(notebookPaperForCharacter('custom-x')).toBe(DEFAULT_NOTEBOOK_PAPER);
    expect(notebookPaperForCharacter('blue-whale-maid')).toBe(DEFAULT_NOTEBOOK_PAPER);
  });
});
