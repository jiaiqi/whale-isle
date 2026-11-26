/**
 * 气泡文本清洗纯函数（2026-11-26）：气泡是纯文本渲染，LLM 偶发把 <think>…</think>
 * 标签原样带进 intent/summary/台词时，标签符号绝不能显示给主人。
 * 主链路已在 autodrive-host 广播前统一 stripThink，这里是渲染层入口的防御性双保险，
 * 覆盖 pet:say 直达、问候/彩蛋、E2E 注入等所有绕过主进程清洗的路径。
 *
 * 轨语义：
 *   thought（云朵泡）— 内心戏轨：有 think 块时显示标签「内」的内容，无标签则原文；
 *   dialog（对话泡）— 正式发言轨：剥掉 think 块只显示可见部分。
 * 返回空串 = 无内容可显示，调用方不弹气泡。
 */

const THINK_RE = /<think>([\s\S]*?)<\/\/?think>/gi;
/** 未闭合的半截 think 块（流式中途）也要吃掉，避免标签符号漏出 */
const THINK_OPEN_RE = /<think>[\s\S]*$/i;

function innerOf(text: string): string {
  const parts: string[] = [];
  for (const match of text.matchAll(THINK_RE)) {
    const inner = (match[1] ?? '').trim();
    if (inner !== '') parts.push(inner);
  }
  return parts.join(' ').trim();
}

function visibleOf(text: string): string {
  return text.replace(THINK_RE, ' ').replace(THINK_OPEN_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanBubbleText(text: string, track: 'thought' | 'dialog'): string {
  if (!text.includes('<')) return text.trim();
  if (track === 'thought') {
    const inner = innerOf(text);
    // 有 think 块取内心内容；纯可见文本（无标签）原样显示
    return inner !== '' ? inner : visibleOf(text);
  }
  return visibleOf(text);
}
