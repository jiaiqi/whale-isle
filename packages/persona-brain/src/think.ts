/**
 * <think> 内心戏剥离（T-M1-04）：
 *  - stripThink：整段剥离（未闭合 → 余下全部视为内心戏，reasoning 模型常见输出）；
 *  - createThinkStreamParser：流式剥离——分块跨标签边界安全（'<thi' 悬挂等待），
 *    供云朵气泡逐字渲染（dsh-pet 思想：思考中歪头摇尾巴）；
 *  - parseEmotionPrefix：情绪前缀解析（SPEC §3.4：模型回复强制带 [情绪] 前缀，网关剥离路由 TTS）。
 */

export interface ThinkStripResult {
  visible: string;
  innerThoughts: string[];
}

export function stripThink(text: string, tag = 'think'): ThinkStripResult {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let visible = '';
  const innerThoughts: string[] = [];
  let rest = text;
  for (;;) {
    const openIndex = rest.indexOf(open);
    if (openIndex < 0) {
      visible += rest;
      break;
    }
    visible += rest.slice(0, openIndex);
    rest = rest.slice(openIndex + open.length);
    const closeIndex = rest.indexOf(close);
    if (closeIndex < 0) {
      // 未闭合：余下全部为内心戏
      innerThoughts.push(rest.trim());
      rest = '';
      break;
    }
    innerThoughts.push(rest.slice(0, closeIndex).trim());
    rest = rest.slice(closeIndex + close.length);
  }
  return { visible, innerThoughts: innerThoughts.filter((thought) => thought.length > 0) };
}

export interface ThinkStreamFeed {
  /** 本块可安全渲染的可见文本（跨块边界安全：'<thi' 悬挂不吐出） */
  visibleChunk: string;
  /** 本块新增的内心戏文本（无则 null）——供云朵气泡增量渲染 */
  thoughtChunk: string | null;
}

export interface ThinkStreamParser {
  feed(chunk: string): ThinkStreamFeed;
  /** 流结束：未闭合的 think 余量计入内心戏 */
  result(): ThinkStripResult;
}

/** 返回 source 末尾与 needle 前缀重合的最大长度（0 = 无悬挂） */
function hangingSuffixLength(source: string, needle: string): number {
  const max = Math.min(needle.length - 1, source.length);
  for (let length = max; length > 0; length--) {
    if (source.endsWith(needle.slice(0, length))) return length;
  }
  return 0;
}

export function createThinkStreamParser(tag = 'think'): ThinkStreamParser {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let mode: 'visible' | 'thought' = 'visible';
  let buffer = '';
  let visibleAll = '';
  let thoughtAll = '';
  const thoughts: string[] = [];

  return {
    feed(chunk: string): ThinkStreamFeed {
      buffer += chunk;
      let visibleChunk = '';
      let thoughtChunk = '';
      for (;;) {
        if (mode === 'visible') {
          const openIndex = buffer.indexOf(open);
          if (openIndex >= 0) {
            visibleChunk += buffer.slice(0, openIndex);
            buffer = buffer.slice(openIndex + open.length);
            mode = 'thought';
            continue;
          }
          const hold = hangingSuffixLength(buffer, open);
          visibleChunk += buffer.slice(0, buffer.length - hold);
          buffer = buffer.slice(buffer.length - hold);
          break;
        }
        // thought 模式
        const closeIndex = buffer.indexOf(close);
        if (closeIndex >= 0) {
          thoughtChunk += buffer.slice(0, closeIndex);
          buffer = buffer.slice(closeIndex + close.length);
          thoughts.push(thoughtChunk.trim());
          mode = 'visible';
          continue;
        }
        const hold = hangingSuffixLength(buffer, close);
        thoughtChunk += buffer.slice(0, buffer.length - hold);
        buffer = buffer.slice(buffer.length - hold);
        break;
      }
      visibleAll += visibleChunk;
      thoughtAll += thoughtChunk;
      return { visibleChunk, thoughtChunk: thoughtChunk.length > 0 ? thoughtChunk : null };
    },
    result(): ThinkStripResult {
      // 未闭合 think：流结束时把累积的未闭合内心戏作为一个整体条目（已发射文本不重复计入）
      if (mode === 'thought' && thoughtAll.trim().length > 0) {
        thoughts.push(thoughtAll.trim());
      }
      return { visible: visibleAll, innerThoughts: thoughts.filter((thought) => thought.length > 0) };
    },
  };
}

// ---- 情绪前缀（SPEC §3.4：[嘴甜常态] 等 → AudioPlaybackLease.emotionTag 枚举） ----

export const EMOTION_PREFIX_MAP: Record<string, string> = {
  '[嘴甜常态]': 'sweet_normal',
  '[傲娇反驳]': 'tsundere_refuse',
  '[破防喷水]': 'rage_spray',
  '[困倦摸鱼]': 'lazy_yawn',
  '[干饭兴奋]': 'happy_rice',
};

export interface EmotionPrefixResult {
  emotionTag: string | null;
  body: string;
}

export function parseEmotionPrefix(text: string): EmotionPrefixResult {
  const match = /^\s*\[(.+?)\]\s*/.exec(text);
  if (!match) return { emotionTag: null, body: text };
  const tag = match[1];
  if (tag === undefined) return { emotionTag: null, body: text };
  const mapped = EMOTION_PREFIX_MAP[`[${tag}]`];
  if (!mapped) return { emotionTag: null, body: text };
  return { emotionTag: mapped, body: text.slice(match[0].length) };
}
