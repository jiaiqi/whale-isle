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

/** 每个角色的专属纸张底纹/强调色（深浅主题通用：半透明叠色，不写死白底）。 */
export interface NotebookPaper {
  /** CSS background（纸张底纹） */
  paper: string;
  /** 强调色（书名、页签、落款） */
  accent: string;
  /** 纸张类型名（UI 小字） */
  label: string;
}

export const NOTEBOOK_PAPER_BY_FAMILY: Readonly<Record<string, NotebookPaper>> = {
  deepseek: { paper: 'linear-gradient(180deg, rgba(59,91,181,.18), rgba(59,91,181,.05))', accent: '#6f9bff', label: '深蓝格纹' },
  claude: { paper: 'linear-gradient(180deg, rgba(232,163,61,.18), rgba(232,163,61,.05))', accent: '#e8a33d', label: '米黄信纸' },
  gpt: { paper: 'linear-gradient(180deg, rgba(16,163,127,.16), rgba(16,163,127,.04))', accent: '#3ecfa2', label: '青绿方格' },
  gemini: { paper: 'linear-gradient(180deg, rgba(138,99,255,.18), rgba(138,99,255,.05))', accent: '#a98bff', label: '星紫横线' },
  glm: { paper: 'linear-gradient(180deg, rgba(84,160,255,.16), rgba(84,160,255,.04))', accent: '#6fb7ff', label: '湖蓝便签' },
  qwen: { paper: 'linear-gradient(180deg, rgba(124,77,255,.16), rgba(124,77,255,.04))', accent: '#9d7bff', label: '紫罗兰格' },
  kimi: { paper: 'linear-gradient(180deg, rgba(255,180,84,.14), rgba(255,180,84,.04))', accent: '#ffb454', label: '暖金信笺' },
  grok: { paper: 'linear-gradient(180deg, rgba(255,107,107,.14), rgba(255,107,107,.04))', accent: '#ff8a8a', label: '赤霞横线' },
};

export const DEFAULT_NOTEBOOK_PAPER: NotebookPaper = {
  paper: 'linear-gradient(180deg, rgba(120,150,190,.12), rgba(120,150,190,.03))',
  accent: '#8fb8e8',
  label: '素色便签',
};

export function notebookPaperForCharacter(characterId: string): NotebookPaper {
  const family = notebookFamilyOf(characterId);
  if (family === null) return DEFAULT_NOTEBOOK_PAPER;
  return NOTEBOOK_PAPER_BY_FAMILY[family] ?? DEFAULT_NOTEBOOK_PAPER;
}
