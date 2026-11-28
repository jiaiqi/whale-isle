/**
 * 气泡文本清洗纯函数（2026-11-26）：气泡是纯文本渲染，LLM 偶发把 <think>…</think>
 * 标签原样带进 intent/summary/台词时，标签符号绝不能显示给主人。
 * 主链路已在 autodrive-host 广播前统一 stripThink，这里是渲染层入口的防御性双保险，
 * 覆盖 pet:say 直达、问候/彩蛋、E2E 注入等所有绕过主进程清洗的路径。
 *
 * 轨语义：
 *   thought — 内心戏轨：有 think 块时显示标签「内」的内容，无标签则原文；
 *   dialog / status / notice / reaction / hint — 正式展示轨：剥掉 think 块只显示可见部分。
 * 返回空串 = 无内容可显示，调用方不弹气泡。
 */
import type { BubbleKind } from './bubble-types';

const THINK_RE = /<think>([\s\S]*?)<\/\/?think>/gi;
/** 未闭合的半截 think 块（流式中途）也要吃掉，避免标签符号漏出 */
const THINK_OPEN_RE = /<think>[\s\S]*$/i;

function innerOf(text: string): string {
  const parts: string[] = [];
  for (const match of text.matchAll(THINK_RE)) {
    // 捕获组 1 必然参与匹配（非可选），此处用非空断言避免引入无意义的兜底分支。
    const inner = match[1]!.trim();
    if (inner !== '') parts.push(inner);
  }
  return parts.join(' ').trim();
}

function visibleOf(text: string): string {
  return text.replace(THINK_RE, ' ').replace(THINK_OPEN_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 不可见字符（零宽空格/零宽连字/零宽非连接符/BOM/软连字符/方向标记）与
 * 变体选择符、纯组合记号：它们有码位却不产生任何墨迹。
 * LLM 台词或状态文本里混入这类字符时，气泡外壳照常绘制但正文看起来是空的
 * （真机 2026-11-28 截图：粉色心形 reaction 气泡只有徽标没有正文）。
 * 渲染层必须在清洗阶段剔除它们，否则只剩空气泡。
 */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/gu;
/** 变体选择符与纯组合记号（U+FE00–FE0F、U+0300–036F 等）本身不占位也不出墨。 */
const MARK_ONLY_RE = /[\ufe00-\ufe0f\u0300-\u036f\u20d0-\u20ff]/gu;

/** 去掉零宽/方向/变体选择符等无墨字符，但保留 emoji 的 ZWJ 组合序列完整性之外的可读文本。 */
export function stripInvisibleChars(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

/**
 * 文本是否至少含一个「会出墨」的字符（排除空白、零宽、变体选择符、纯组合记号）。
 * 判断口径：去掉无墨字符后，仍剩至少一个非空白码位。
 */
export function hasVisibleGlyph(text: string): boolean {
  const stripped = stripInvisibleChars(text).replace(MARK_ONLY_RE, '');
  return stripped.replace(/\s+/gu, '').length > 0;
}

export function cleanBubbleText(text: string, track: BubbleKind = 'dialog'): string {
  const visible = stripInvisibleChars(text);
  if (!visible.includes('<')) return visible.trim();
  if (track === 'thought') {
    const inner = innerOf(visible);
    // 有 think 块取内心内容；纯可见文本（无标签）原样显示
    return inner !== '' ? inner : visibleOf(visible);
  }
  return visibleOf(visible);
}
