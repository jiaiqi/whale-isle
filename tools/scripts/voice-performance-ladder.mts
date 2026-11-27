#!/usr/bin/env node
/**
 * 表演重做：强度阶梯 A / B / C（owner 2026-11-27：「音色对，表演要重做，三档都要重做，主要是情绪太弱」）。
 *
 * 三档（调皮 / 傲娇 / 撒娇）× 三级（A 提级对照 / B 明显夸张 / C 副语言）× 每格 2 条 = 18 条。
 * 判据先注册在 `docs/v2/evidence/mimo-tts-candidate-integration.md` §2.18.1，跑完不改线。
 *
 * 边界：**不动**随包参考资产、默认声线、`MIMO_TIMBRE_PRESETS`、UI。这里只把「指令 + 标点/标签」
 * 作为请求参数拼出来，通过 provider 的 `emotionStyleHints` / `emotionStyleTags` 注入合成键
 * （`bright@A` 这类），因此不碰契约层、也不影响产品里真实生效的五档映射。
 *
 * 用法：
 *   npx tsx tools/scripts/voice-performance-ladder.mts --ref assets/voice/xiaojing-07-tiancui-yuanqi.wav \
 *     --count 2 --from-vault --out artifacts/tts-ab/perform2-07-tiancui
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MimoTtsProvider,
  MIMO_EMOTION_STYLE_HINTS,
  MIMO_EMOTION_STYLE_TAGS,
} from '../../packages/voice-runtime/src/providers';

interface Performance {
  key: string;
  label: string;
  /** 契约层五档里的哪一档（决定前缀标签与 A 级指令） */
  emotion: string;
}

const PERFORMANCES: Performance[] = [
  { key: 'tiaopi', label: '调皮', emotion: 'bright' },
  { key: 'aojiao', label: '傲娇', emotion: 'tsundere' },
  { key: 'chajiao', label: '撒娇', emotion: 'daily' },
];

/** A 级：正文与 §2.17 完全一致（含那个内联标签），只把指令加上「更外放」 */
const BASE_SENTENCE = '主人，你回来啦，(pauses for a moment) 今天有没有想我呀？';
/** B 级：只用标点承载强度（！ ～ ——），不带任何内联标签；三档同文，差异只来自指令 */
const LEVEL_B_TEXT = '主人！你回来啦——今天有没有想我呀～';

const LEVEL_B_HINTS: Record<string, string> = {
  bright: '情绪外放夸张，语调起伏大，重音明显，尾音拖长上扬，像在台上表演',
  tsundere: '情绪外放夸张，语气冲，咬字重，尾音先压下再挑起，明显不服气',
  daily: '情绪外放夸张，甜得发腻，语调起伏大，尾音拖长，带撒娇的鼻音',
};

/** C 级：在 B 的标点之上再加两个内联标签（每档不同，见 manifest 的 verifiedTags 字段） */
const LEVEL_C_TEXTS: Record<string, string> = {
  tiaopi: '主人！(giggles) 你回来啦——今天有没有想我呀～(laughs)',
  aojiao: '主人！(hmph) 你回来啦——今天有没有想我呀～(sighs deeply)',
  chajiao: '主人～(sighs deeply) 你回来啦——今天有没有想我呀～(inhales)',
};

/** 哪些标签是此前实测过的、哪些没验证过（没验证的若被念出来，听感上立刻能听出） */
const VERIFIED_TAGS = new Set(['sighs deeply', 'cough', 'pauses for a moment']);

const TIMBRE_DESCRIPTION = '八九岁小女孩，声音甜而脆，元气满满，语速快，句尾翘起来，像随时要跳起来';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const vaultKeys: Record<string, string | null> = {};

function readVaultKeys(ids: string[]): void {
  const electronBin = join(process.cwd(), 'apps', 'desktop-host', 'node_modules', '.bin', 'electron');
  const script = join(process.cwd(), 'tools', 'scripts', 'vault-key.cjs');
  const result = spawnSync(electronBin, [script, ...ids], { encoding: 'utf8', timeout: 90_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`读取凭据库失败：${result.error?.message ?? result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout) as Record<string, string | null>;
  for (const id of ids) vaultKeys[id] = parsed[id] ?? null;
  console.error(`[from-vault] 已读取：${ids.map((id) => `${id}=${vaultKeys[id] === null ? '未取到' : 'ok'}`).join(' ')}`);
}

/** 某个「档 × 级」的请求参数：合成键 = `<契约情绪>@<级>`，指令与标签按级拼 */
function levelSpec(perf: Performance, level: 'A' | 'B' | 'C'): { hint: string; tag: string; text: string } {
  const baseHint = MIMO_EMOTION_STYLE_HINTS[perf.emotion] ?? '';
  const tag = MIMO_EMOTION_STYLE_TAGS[perf.emotion] ?? '';
  if (level === 'A') return { hint: `${baseHint}，更外放`, tag, text: BASE_SENTENCE };
  if (level === 'B') return { hint: LEVEL_B_HINTS[perf.emotion] ?? baseHint, tag, text: LEVEL_B_TEXT };
  const strong = LEVEL_B_HINTS[perf.emotion] ?? baseHint;
  return { hint: `${strong}，可以笑出声、哼气、叹气、吸气`, tag, text: LEVEL_C_TEXTS[perf.key] ?? LEVEL_B_TEXT };
}

function tagsIn(text: string): string[] {
  return [...text.matchAll(/\(([^)]+)\)/g)].map((m) => m[1] ?? '').filter((s) => s !== '');
}

async function main(): Promise<void> {
  const refPath = arg('ref');
  if (refPath === undefined) throw new Error('需要 --ref <参考音频路径>');
  const count = Number.parseInt(arg('count', '2')!, 10);
  const outRoot = arg('out', join(process.cwd(), 'artifacts', 'tts-ab', 'perform2-07-tiancui'))!;
  if (flag('from-vault')) readVaultKeys(['mimo-tts']);
  const refBytes = new Uint8Array(readFileSync(refPath));

  const rows: Array<Record<string, unknown>> = [];
  for (const perf of PERFORMANCES) {
    const dir = join(outRoot, perf.key);
    mkdirSync(dir, { recursive: true });
    for (const level of ['A', 'B', 'C'] as const) {
      const spec = levelSpec(perf, level);
      const emotionKey = `${perf.emotion}@${level}`;
      const provider = new MimoTtsProvider({
        mode: 'voiceclone',
        voiceDescription: TIMBRE_DESCRIPTION,
        // 合成键：只在这条实验链路里生效，不写回契约层
        emotionStyleHints: { [emotionKey]: spec.hint },
        emotionStyleTags: { [emotionKey]: spec.tag },
        resolveReferenceAudio: () => ({ bytes: refBytes }),
        resolveApiKey: () => vaultKeys['mimo-tts'] ?? process.env.WHALE_MIMO_API_KEY?.trim() ?? null,
      });
      const assistantText = `(${spec.tag})${spec.text}`;
      const used = tagsIn(spec.text);
      console.error(`[${perf.key}${level}] 指令「${spec.hint}」· 正文「${assistantText}」`);
      for (let i = 1; i <= count; i++) {
        const started = Date.now();
        try {
          const out = await provider.synthesize({
            requestId: `perform2-${perf.key}-${level}-${i}`,
            characterId: 'char_xiaojing',
            voiceRef: 'bench_voice',
            text: spec.text,
            emotion: emotionKey,
            styleMode: 'normal',
            speed: 1,
            timeoutMs: 30_000,
            pitchShiftSemitones: 0,
            volume: 1,
          });
          const bytes = new Uint8Array(Buffer.from(out.audioBase64 ?? '', 'base64'));
          const file = join(dir, `${perf.key}-${level}-${i}.wav`);
          writeFileSync(file, bytes);
          rows.push({
            performance: perf.key,
            label: perf.label,
            level,
            emotionKey,
            userText: spec.hint,
            assistantText,
            tagsUsed: used,
            verifiedTags: used.filter((tag) => VERIFIED_TAGS.has(tag)),
            unverifiedTags: used.filter((tag) => !VERIFIED_TAGS.has(tag)),
            i,
            file,
            bytes: bytes.byteLength,
            wallMs: Date.now() - started,
            ok: true,
          });
          console.log(`[${perf.key}${level}] ${i}/${count} wall=${Date.now() - started}ms bytes=${bytes.byteLength}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          rows.push({
            performance: perf.key,
            label: perf.label,
            level,
            emotionKey,
            userText: spec.hint,
            assistantText,
            tagsUsed: used,
            verifiedTags: used.filter((tag) => VERIFIED_TAGS.has(tag)),
            unverifiedTags: used.filter((tag) => !VERIFIED_TAGS.has(tag)),
            i,
            file: null,
            ok: false,
            error: message,
          });
          console.error(`[${perf.key}${level}] ${i}/${count} 失败：${message}`);
        }
      }
    }
  }
  writeFileSync(
    join(outRoot, 'manifest.json'),
    JSON.stringify({ refPath, baseSentence: BASE_SENTENCE, levelBText: LEVEL_B_TEXT, levelCTexts: LEVEL_C_TEXTS, rows }, null, 2),
  );
  const failed = rows.filter((row) => row['ok'] !== true).length;
  console.log(`完成：${rows.length - failed}/${rows.length} 成功 → ${outRoot}`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
