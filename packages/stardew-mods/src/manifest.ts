/**
 * T-M6-06 星露谷 SMAPI Mod 管理 —— manifest.json 宽容解析。
 *
 * 设计来源（SMAPI 真实 manifest 语义）：
 * - 每个 Mod 独占一个目录，目录内 manifest.json 描述 Name / Author / Version /
 *   UniqueID / Description / ContentPackFor / MinimumApiVersion 等字段。
 * - SMAPI 自带的 JSON 解析器容忍 `//` 行注释、块注释与尾逗号，社区 Mod 因此常
 *   直接写注释；Node 的 JSON.parse 不允许，必须先做「字符串安全」的预处理：
 *   引号内的 `//`、块注释起始符绝不能误删，并正确跳过 `\"`、`\\` 转义。
 * - 缺少 Name 的 manifest 会被 SMAPI 拒绝装载（无法在列表中显示），这里同样报错；
 *   folderName / enabled 由调用方（scanModsDir）回填，解析器本身不接触文件系统。
 */
import type { StardewModInfo } from '@workbench/shared-protocol';
import { errorMessage } from './fs-util';

/** JSON 结构中的合法空白（RFC 8259 仅四种，避免 /\s/ 把其它控制字符当空白） */
const isJsonWhitespace = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** unknown → 字符串：字符串去首尾空白；数字（如 Version: 1）转字符串；其余类型给空串 */
const asText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
};

/**
 * 字符串安全地剥离 `//` 行注释与块注释。
 * 逐字符扫描并跟踪双引号状态：引号内的内容原样保留；遇到反斜杠时连同下一个字符
 * 一起吞掉，保证 `\"` 不会被误判为字符串结束。被删除的注释不改变换行数量
 * （行注释保留其结尾换行，块注释保留内部换行），便于 JSON.parse 报错时定位行号。
 */
export function stripSmapiJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === '\\') {
        const escaped = text.charAt(i + 1);
        if (escaped !== '') {
          out += escaped;
          i += 1;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    const next = text.charAt(i + 1);
    if (ch === '/' && next === '/') {
      // 行注释：吞到行尾，保留换行（若注释在文件末尾则无换行可留）
      i += 2;
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
      if (i < text.length) out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      // 块注释：吞到闭合标记；未闭合时吞到文本末尾，交给 JSON.parse 报语法错
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) {
        if (text.charAt(i) === '\n') out += '\n';
        i += 1;
      }
      i += 1; // 跳过闭合标记里的 '/'
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 字符串安全地删除尾逗号（`, }` / `, ]` 形态）。
 * 只丢弃逗号本身，保留其后的空白，因此缩进与行号不变；引号内的 `,}` 不受影响。
 */
export function stripSmapiJsonTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === '\\') {
        const escaped = text.charAt(i + 1);
        if (escaped !== '') {
          out += escaped;
          i += 1;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let lookahead = i + 1;
      while (lookahead < text.length && isJsonWhitespace(text.charAt(lookahead))) lookahead += 1;
      const closing = text.charAt(lookahead);
      if (closing === '}' || closing === ']') continue; // 丢弃尾逗号
    }
    out += ch;
  }
  return out;
}

/** 规范化 manifest 文本：去 BOM → 剥注释 → 剥尾逗号 */
const normalizeSmapiJson = (text: string): string =>
  stripSmapiJsonTrailingCommas(stripSmapiJsonComments(text.replace(/^\uFEFF/, '')));

/**
 * 解析 SMAPI manifest.json 文本。
 *
 * @returns `manifest` 非 null 时 `error` 必为空；解析失败时 `manifest` 为 null，
 *          `error` 为中文短句。`folderName` / `enabled` 是占位值（'' / true），
 *          由 scanModsDir 依据真实目录与文件名回填。
 */
export function parseSmapiManifest(text: string): { manifest: StardewModInfo | null; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(normalizeSmapiJson(text));
  } catch (error) {
    return { manifest: null, error: `manifest JSON 解析失败: ${errorMessage(error)}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { manifest: null, error: 'manifest 必须是 JSON 对象' };
  }
  const record = raw as Record<string, unknown>;
  const name = asText(record['Name']);
  if (name === '') {
    return { manifest: null, error: 'manifest 缺 Name' };
  }
  const contentPackFor = record['ContentPackFor'];
  return {
    manifest: {
      folderName: '',
      uniqueId: asText(record['UniqueID']),
      name,
      author: asText(record['Author']),
      version: asText(record['Version']),
      description: asText(record['Description']),
      enabled: true,
      // ContentPackFor 存在即内容包（SMAPI 用它定位 Content Patcher 等目标 Mod）
      contentType: typeof contentPackFor === 'object' && contentPackFor !== null ? 'content-pack' : '',
      minimumApiVersion: asText(record['MinimumApiVersion']),
      parseError: '',
    },
    error: '',
  };
}
