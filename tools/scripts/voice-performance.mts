#!/usr/bin/env node
/**
 * 三种表演复核（调皮 / 傲娇 / 撒娇）：以定稿声线（07 甜脆·元气）的随包参考音频走 VoiceClone，
 * 同一句话各合成 3 条，只用产品里真实可用的控制手段——五档情绪的风格指令 + 助手前缀标签 + 一个内联标签。
 *
 * 为什么不用「每档情绪参考音频」：`docs/v2/evidence/mimo-tts-candidate-integration.md` §2.16 的
 * 六臂实验证明，直接拿 VoiceDesign 生成的情绪参考会把角色音色一起换掉（参考集自相似 0.5158），
 * 两段式参考（保人）又把情绪效果量压回控制组附近（M3 未过）。所以复核退回指令 + 标签，
 * 并在报告里如实写「客观量上拉开多少」。
 *
 * 三种表演一一对应产品五档里的三档，不另造第六种情绪：
 *   调皮 → bright (Playful) · 傲娇 → tsundere (Tsundere) · 撒娇 → daily (Sweet)
 *
 * 用法：
 *   npx tsx tools/scripts/voice-performance.mts --ref assets/voice/xiaojing-07-tiancui-yuanqi.wav \
 *     --count 3 --from-vault --out artifacts/tts-ab/perform-07-tiancui
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MimoTtsProvider,
  MIMO_EMOTION_STYLE_HINTS,
  MIMO_EMOTION_STYLE_TAGS,
} from '../../packages/voice-runtime/src/providers';

/** 三种表演 → 产品五档情绪键（不新增情绪档） */
const PERFORMANCES: Array<{ key: string; label: string; emotion: string }> = [
  { key: 'tiaopi', label: '调皮', emotion: 'bright' },
  { key: 'aojiao', label: '傲娇', emotion: 'tsundere' },
  { key: 'chajiao', label: '撒娇', emotion: 'daily' },
  // 对照：同一句、同一参考、**不带**任何情绪指令与标签——用来把「换句 + 内联标签」的
  // 说话人一致性代价，从「情绪指令」的代价里拆出去。键不在契约表里 → 无指令、无前缀标签。
  { key: 'neutral', label: '中性对照', emotion: 'none' },
];

/** 三种表演用同一句，便于横比；句中只放一个内联标签（§3.1：一句最多一个） */
const SENTENCE = '主人，你回来啦，(pauses for a moment) 今天有没有想我呀？';

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

async function main(): Promise<void> {
  const refPath = arg('ref');
  if (refPath === undefined) throw new Error('需要 --ref <参考音频路径>');
  const count = Number.parseInt(arg('count', '3')!, 10);
  const outRoot = arg('out', join(process.cwd(), 'artifacts', 'tts-ab', 'perform-07-tiancui'))!;
  if (flag('from-vault')) readVaultKeys(['mimo-tts']);
  const refBytes = new Uint8Array(readFileSync(refPath));

  const only = arg('only');
  const selected = only === undefined ? PERFORMANCES : PERFORMANCES.filter((perf) => only.split(',').includes(perf.key));
  if (selected.length === 0) throw new Error(`--only ${only} 没有匹配到任何表演`);

  const rows: Array<Record<string, unknown>> = [];
  for (const perf of selected) {
    const dir = join(outRoot, perf.key);
    mkdirSync(dir, { recursive: true });
    const provider = new MimoTtsProvider({
      mode: 'voiceclone',
      voiceDescription: TIMBRE_DESCRIPTION,
      emotionStyleHints: MIMO_EMOTION_STYLE_HINTS,
      emotionStyleTags: MIMO_EMOTION_STYLE_TAGS,
      resolveReferenceAudio: () => ({ bytes: refBytes }),
      resolveApiKey: () => vaultKeys['mimo-tts'] ?? process.env.WHALE_MIMO_API_KEY?.trim() ?? null,
    });
    const hint = MIMO_EMOTION_STYLE_HINTS[perf.emotion] ?? '';
    const tag = MIMO_EMOTION_STYLE_TAGS[perf.emotion] ?? '';
    console.error(`[${perf.key}] ${perf.label} → 情绪档 ${perf.emotion} · 指令「${hint}」· 前缀 ${tag}`);
    for (let i = 1; i <= count; i++) {
      const started = Date.now();
      try {
        const out = await provider.synthesize({
          requestId: `perform-${perf.key}-${i}`,
          characterId: 'char_xiaojing',
          voiceRef: 'bench_voice',
          text: SENTENCE,
          emotion: perf.emotion,
          styleMode: 'normal',
          speed: 1,
          timeoutMs: 30_000,
          pitchShiftSemitones: 0,
          volume: 1,
        });
        const bytes = new Uint8Array(Buffer.from(out.audioBase64 ?? '', 'base64'));
        const file = join(dir, `${perf.key}-${i}.wav`);
        writeFileSync(file, bytes);
        rows.push({ ...perf, refPath, hint, tag, text: SENTENCE, i, file, bytes: bytes.byteLength, wallMs: Date.now() - started, ok: true });
        console.log(`[${perf.key}] ${i}/${count} wall=${Date.now() - started}ms bytes=${bytes.byteLength}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rows.push({ ...perf, refPath, hint, tag, text: SENTENCE, i, file: null, ok: false, error: message });
        console.error(`[${perf.key}] ${i}/${count} 失败：${message}`);
      }
    }
  }
  // 分次跑（例如先三种表演、再补对照）时合并 manifest，不覆盖上一次的记录
  const manifestPath = join(outRoot, 'manifest.json');
  const selectedKeys = new Set(selected.map((perf) => perf.key));
  let previous: Array<Record<string, unknown>> = [];
  try {
    previous = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  } catch {
    /* 首次运行没有 manifest */
  }
  const merged = [...previous.filter((row) => !selectedKeys.has(String(row['key']))), ...rows];
  writeFileSync(manifestPath, JSON.stringify({ refPath, sentence: SENTENCE, rows: merged }, null, 2));
  const failed = rows.filter((row) => row['ok'] !== true).length;
  console.log(`完成：${rows.length - failed}/${rows.length} 成功 → ${outRoot}`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
