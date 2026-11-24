/**
 * 小本子手写体映射（T-M6-63 / T-M6-65）。
 *
 * 8 套随包 woff2 按角色家族固定映射；`auto` = 跟随当前角色自动匹配。
 * 这里只给纯配置表与 URL 构造函数，字体加载由渲染层动态注入 @font-face。
 */
export interface NotebookFontDefinition {
  id: string;
  file: string;
  label: string;
}

export const NOTEBOOK_FONT_BY_FAMILY: Readonly<Record<string, NotebookFontDefinition>> = {
  deepseek: { id: 'ma-shan-zheng', file: 'ma-shan-zheng.woff2', label: '马善政毛笔楷书' },
  claude: { id: 'notebook-kai', file: 'notebook-kai.woff2', label: '小本子楷体' },
  gpt: { id: 'zcool-xiaowei', file: 'zcool-xiaowei.woff2', label: '站酷小薇体' },
  gemini: { id: 'zcool-kuaile', file: 'zcool-kuaile.woff2', label: '站酷快乐体' },
  glm: { id: 'zhi-mang-xing', file: 'zhi-mang-xing.woff2', label: '志莽行书' },
  qwen: { id: 'long-cang', file: 'long-cang.woff2', label: '龙藏体' },
  kimi: { id: 'xiaolai', file: 'xiaolai.woff2', label: '小赖体' },
  grok: { id: 'zcool-qingke-huangyou', file: 'zcool-qingke-huangyou.woff2', label: '站酷庆科黄油体' },
};

/** 全部 8 套字体（下拉顺序固定，便于 UI 稳定）。 */
export const NOTEBOOK_FONTS: readonly NotebookFontDefinition[] = Object.values(NOTEBOOK_FONT_BY_FAMILY);

/** 角色 id → 家族：crosspet-claude → claude；aboutme-claude → claude；custom-* 不猜家族。 */
export function notebookFamilyOf(characterId: string): string | null {
  if (characterId.startsWith('crosspet-')) {
    const rest = characterId.slice('crosspet-'.length);
    return rest.split('-')[0] ?? null;
  }
  if (characterId.startsWith('aboutme-')) return characterId.slice('aboutme-'.length);
  return null;
}

/** 角色自动匹配字体；未知角色返回 null（调用方回退默认字体，绝不硬套）。 */
export function notebookFontForCharacter(characterId: string): NotebookFontDefinition | null {
  const family = notebookFamilyOf(characterId);
  if (family === null) return null;
  return NOTEBOOK_FONT_BY_FAMILY[family] ?? null;
}

/** 固定随包路径（whale-pet:// 只读协议）→ 可直接用于 @font-face src。 */
export function notebookFontUrl(file: string): string {
  return `whale-pet://crosspet/app/web/fonts/notebook/${encodeURIComponent(file)}`;
}

/** 指定字体 id → 定义；auto/未知返回 null。 */
export function notebookFontById(fontId: string): NotebookFontDefinition | null {
  if (fontId === '' || fontId === 'auto') return null;
  return NOTEBOOK_FONTS.find((font) => font.id === fontId) ?? null;
}
