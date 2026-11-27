#!/usr/bin/env node
/**
 * 情绪方法验证 harness：按档情绪参考音频 + 按档克隆。
 *
 * 要回答的问题（判据见 docs/v2/evidence/mimo-tts-candidate-integration.md §2.16.1）：
 * MiMo 上「语气指令」拉不开情绪，那么把情绪**做进参考音频**、再按档克隆，能不能锁住？
 *
 * 五条臂（每臂 5 档情绪 × N 条）：
 * - **A**：固定的中性参考 + 该档情绪指令 → 只看指令够不够；
 * - **B**：按档情绪参考 + 该档情绪指令 → 产品路径（选情绪 → 换参考 → 说）；
 * - **C**：按档情绪参考 + **不带**任何情绪指令 → 情绪到底是不是参考音频带来的；
 * - **D**：五条**中性**参考（各自独立生成）+ 不带指令 → 参考之间的自然差异基线；
 * - **E**：五条**同一情绪指令**（daily）的参考 + 不带指令 → 与 C 严格匹配的对照，
 *   两者只差「参考里带的是不是不同情绪」。
 *
 * 关键口径（不许糊弄）：
 * - 请求体真的带没带情绪指令，`dry-run` 子命令直接打印 messages 自查，不靠推断；
 * - 失败照实写 manifest（ok:false + error），不跳过、不补位；
 * - 每条臂用哪套参考（refs / refs-neutral / refs-daily）都在代码里写死，分析脚本按臂对齐。
 *
 * 用法：
 *   npx tsx tools/scripts/emotion-matrix.mts dry-run --candidate 12-hanhan-difa
 *   npx tsx tools/scripts/emotion-matrix.mts refs --candidate 12-hanhan-difa --from-vault
 *   npx tsx tools/scripts/emotion-matrix.mts refs --candidate 12-hanhan-difa --neutral --from-vault
 *   npx tsx tools/scripts/emotion-matrix.mts refs --candidate 12-hanhan-difa --fixed daily --from-vault
 *   npx tsx tools/scripts/emotion-matrix.mts clone --candidate 12-hanhan-difa --count 3 --from-vault
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MimoTtsProvider,
  MIMO_EMOTION_STYLE_HINTS,
  MIMO_EMOTION_STYLE_TAGS,
  type MimoTtsMode,
} from '../../packages/voice-runtime/src/providers';

/** 语音中心五档情绪（键在契约层有对应的风格指令与标签） */
const EMOTIONS = ['daily', 'bright', 'tsundere', 'sleepy', 'surprised'] as const;

/**
 * 克隆用的中性参考音频（候选自己的基准参考），A 臂用。
 *
 * 2026-11-27 owner 定稿「07 甜脆·元气」后，02 / 08 / 12 与旧 07 的参考音频**已从随包资源撤出**，
 * 归档在本机 `artifacts/voice-archive-2026-11-27/`（`artifacts/` 不入库）。要用本 harness 复现旧实验，
 * 得先把对应参考音频放回这个路径，或用同样的描述 + 同句重新生成一条。
 */
const VOICE_ARCHIVE = 'artifacts/voice-archive-2026-11-27';
const NEUTRAL_REFERENCE: Record<string, string> = {
  '02-yujie-leng': `${VOICE_ARCHIVE}/xiaojing-02-yujie-leng.wav`,
  '08-nianhu-banshui': `${VOICE_ARCHIVE}/xiaojing-08-nianhu-banshui.wav`,
  '12-hanhan-difa': `${VOICE_ARCHIVE}/xiaojing-12-hanhan-difa.wav`,
  '07-nianhu-piqi': `${VOICE_ARCHIVE}/xiaojing-07-nianhu-piqi.wav`,
};

const CANDIDATE_DESCRIPTIONS: Record<string, string> = {
  '02-yujie-leng': '二十岁左右的年轻女声，音调中低，语气平静克制，尾音干脆，像不太爱解释的人',
  '08-nianhu-banshui': '黏糊的迷糊女声，气声多，像半睡半醒时撒娇，字尾含混',
  '12-hanhan-difa': '偏低的中性软声，呆呆的，语气没什么起伏，像在发呆',
  '07-nianhu-piqi': '软糯黏糊但带笑意的女声，撒娇里藏着坏主意，尾音轻轻上翘',
};

/** C / D / E 臂用「不在任何情绪表里的键」表示不带指令：查表落空 → 无风格指令、无 (Tag) 前缀 */
const NO_EMOTION_KEY = 'none';

/** 与 07 基准参考同句，便于横比 */
const SENTENCE = '主人，今天也辛苦啦，我给你倒杯热茶好不好呀。';

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

function buildProvider(
  mode: MimoTtsMode,
  description: string,
  refPath: () => string | null,
): MimoTtsProvider {
  return new MimoTtsProvider({
    mode,
    voiceDescription: description,
    emotionStyleHints: MIMO_EMOTION_STYLE_HINTS,
    emotionStyleTags: MIMO_EMOTION_STYLE_TAGS,
    resolveReferenceAudio: () => {
      const path = refPath();
      if (path === null || path === '') return null;
      return { bytes: new Uint8Array(readFileSync(path)) };
    },
    resolveApiKey: () => vaultKeys['mimo-tts'] ?? process.env.WHALE_MIMO_API_KEY?.trim() ?? null,
  });
}

async function synthesize(
  provider: MimoTtsProvider,
  emotion: string,
  text: string,
): Promise<{ bytes: Uint8Array; wallMs: number }> {
  const started = Date.now();
  const out = await provider.synthesize({
    requestId: 'emotion-matrix',
    characterId: 'char_xiaojing',
    voiceRef: 'bench_voice',
    text,
    emotion,
    styleMode: 'normal',
    speed: 1,
    timeoutMs: 30_000,
    pitchShiftSemitones: 0,
    volume: 1,
  });
  const bytes = new Uint8Array(Buffer.from(out.audioBase64 ?? '', 'base64'));
  return { bytes, wallMs: Date.now() - started };
}

/**
 * 生成参考音频。
 * - `refEmotion`：每档用自己那一档的情绪键（默认）。
 * - `fixedEmotion`：五条全部用同一个情绪键（匹配对照）。
 * - `null`：不带任何情绪指令（中性参考）。
 */
async function cmdRefs(
  candidate: string,
  description: string,
  outRoot: string,
  refEmotion: string | null,
  outDirName: string,
): Promise<void> {
  const refsDir = join(outRoot, outDirName);
  mkdirSync(refsDir, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const emotion of EMOTIONS) {
    const provider = buildProvider('voicedesign', description, () => null);
    try {
      const { bytes, wallMs } = await synthesize(provider, refEmotion ?? emotion, SENTENCE);
      const file = join(refsDir, `${emotion}.wav`);
      writeFileSync(file, bytes);
      rows.push({ emotion, file, bytes: bytes.byteLength, wallMs, ok: true });
      console.log(`[refs:${outDirName}] ${emotion} wall=${wallMs}ms bytes=${bytes.byteLength}`);
    } catch (err) {
      rows.push({ emotion, file: null, ok: false, error: err instanceof Error ? err.message : String(err) });
      console.error(`[refs:${outDirName}] ${emotion} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  writeFileSync(join(refsDir, 'manifest.json'), JSON.stringify({ candidate, outDirName, rows }, null, 2));
}

/** 每条臂用哪套参考音频 */
function armReference(
  arm: string,
  candidate: string,
  outRoot: string,
  emotion: string,
): { refPath: string; emotionKey: string } {
  const neutralRef = NEUTRAL_REFERENCE[candidate];
  if (neutralRef === undefined) throw new Error(`没有 ${candidate} 的中性参考音频`);
  const emotionRef = join(outRoot, 'refs', `${emotion}.wav`);
  switch (arm) {
    case 'A':
      // 固定中性参考 + 该档情绪指令：只看指令
      return { refPath: neutralRef, emotionKey: emotion };
    case 'B':
      // 按档情绪参考 + 该档情绪指令：产品路径
      return { refPath: emotionRef, emotionKey: emotion };
    case 'C':
      // 按档情绪参考 + 不带指令：情绪是不是参考带来的
      return { refPath: emotionRef, emotionKey: NO_EMOTION_KEY };
    case 'D':
      // 五条中性参考（各自独立生成）+ 不带指令：参考之间的自然差异基线
      return { refPath: join(outRoot, 'refs-neutral', `${emotion}.wav`), emotionKey: NO_EMOTION_KEY };
    case 'E':
      // 五条同一情绪指令的参考 + 不带指令：与 C 匹配的对照
      return { refPath: join(outRoot, 'refs-daily', `${emotion}.wav`), emotionKey: NO_EMOTION_KEY };
    case 'F':
      // 两段式（事后探索）：先用中性参考克隆出带情绪的参考，再用它克隆；参考不带指令
      return { refPath: join(outRoot, 'refs-2stage', `${emotion}.wav`), emotionKey: NO_EMOTION_KEY };
    default:
      throw new Error(`未知臂：${arm}`);
  }
}

/**
 * F 臂（**事后探索，不属于预注册判据**）：两段式按档参考。
 *
 * 问题：直接拿 VoiceDesign 生成的情绪参考，五条彼此余弦只有 0.52（等于五个人），
 * 于是 C 臂虽然把情绪锁住了，角色音色也一起被换掉。
 * 两段式：先用候选自己的中性参考 + 情绪指令克隆出一条「同一个人、带该情绪」的参考，
 * 再用它去克隆。若 F 臂既分档、参考集自相似又高，才说明这套方法能产品化。
 */
async function cmdTwoStageRefs(candidate: string, count: number, outRoot: string): Promise<void> {
  const description = CANDIDATE_DESCRIPTIONS[candidate] ?? '';
  const neutralRef = NEUTRAL_REFERENCE[candidate];
  if (neutralRef === undefined) throw new Error(`没有 ${candidate} 的中性参考音频`);
  const dir = join(outRoot, 'refs-2stage');
  mkdirSync(dir, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const emotion of EMOTIONS) {
    const provider = buildProvider('voiceclone', description, () => neutralRef);
    try {
      const { bytes, wallMs } = await synthesize(provider, emotion, SENTENCE);
      const file = join(dir, `${emotion}.wav`);
      writeFileSync(file, bytes);
      rows.push({ emotion, file, bytes: bytes.byteLength, wallMs, ok: true });
      console.log(`[2stage] ${emotion} wall=${wallMs}ms bytes=${bytes.byteLength}`);
    } catch (err) {
      rows.push({ emotion, file: null, ok: false, error: err instanceof Error ? err.message : String(err) });
      console.error(`[2stage] ${emotion} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ candidate, rows }, null, 2));
}

async function cmdClone(candidate: string, count: number, outRoot: string): Promise<void> {
  const description = CANDIDATE_DESCRIPTIONS[candidate] ?? '';
  const rows: Array<Record<string, unknown>> = [];
  for (const arm of (arg('arms', 'A,B,C,D,E') ?? 'A,B,C,D,E').split(',') as Array<'A' | 'B' | 'C' | 'D' | 'E' | 'F'>) {
    const armDir = join(outRoot, `arm${arm}`);
    mkdirSync(armDir, { recursive: true });
    for (const emotion of EMOTIONS) {
      const { refPath, emotionKey } = armReference(arm, candidate, outRoot, emotion);
      const provider = buildProvider('voiceclone', description, () => refPath);
      for (let i = 1; i <= count; i++) {
        try {
          const { bytes, wallMs } = await synthesize(provider, emotionKey, SENTENCE);
          const file = join(armDir, `${emotion}-${i}.wav`);
          writeFileSync(file, bytes);
          rows.push({ arm, emotion, emotionKey, refPath, file, bytes: bytes.byteLength, wallMs, ok: true });
          console.log(`[arm${arm}] ${emotion}-${i} wall=${wallMs}ms bytes=${bytes.byteLength}`);
        } catch (err) {
          rows.push({
            arm,
            emotion,
            emotionKey,
            refPath,
            file: null,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          console.error(`[arm${arm}] ${emotion}-${i} 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  writeFileSync(join(outRoot, 'clone-manifest.json'), JSON.stringify({ candidate, count, rows }, null, 2));
}

async function cmdDryRun(candidate: string, outRoot: string): Promise<void> {
  const description = CANDIDATE_DESCRIPTIONS[candidate] ?? '';
  for (const arm of ['A', 'B', 'C', 'D', 'E'] as const) {
    const emotion = EMOTIONS[0];
    const { emotionKey } = armReference(arm, candidate, outRoot, emotion);
    const captured: unknown[] = [];
    const provider = new MimoTtsProvider({
      mode: 'voiceclone',
      voiceDescription: description,
      emotionStyleHints: MIMO_EMOTION_STYLE_HINTS,
      emotionStyleTags: MIMO_EMOTION_STYLE_TAGS,
      // dry-run 不读真文件（参考音频可能还没生成）：用占位字节，长度照样会进请求体
      resolveReferenceAudio: () => ({ bytes: new Uint8Array(1024) }),
      resolveApiKey: () => 'dry-run',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        captured.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: '' } } }] }) } as never;
      }) as never,
    });
    try {
      await provider.synthesize({
        requestId: 'dry-run', characterId: 'char_xiaojing', voiceRef: 'bench_voice',
        text: SENTENCE, emotion: emotionKey, styleMode: 'normal', speed: 1,
        timeoutMs: 1000, pitchShiftSemitones: 0, volume: 1,
      });
    } catch {
      /* 空音频会抛，忽略：要看的 body 已经抓到了 */
    }
    const body = captured[0] as { messages: Array<{ role: string; content: string }>; audio?: { voice?: string } };
    const userMsg = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const asstMsg = body.messages.find((m) => m.role === 'assistant')?.content ?? '';
    console.log(`臂 ${arm}（emotionKey=${emotionKey}）`);
    console.log(`  user 指令：${userMsg === '' ? '（空 —— 无情绪指令）' : userMsg}`);
    console.log(`  assistant 文本：${asstMsg}`);
    console.log(`  参考音频字段长度：${(body.audio?.voice ?? '').length}`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const candidate = arg('candidate');
  if (candidate === undefined) throw new Error('需要 --candidate');
  const outRoot = arg('out', join(process.cwd(), 'artifacts', 'tts-ab', `emotion-matrix-${candidate}`))!;
  if (flag('from-vault')) readVaultKeys(['mimo-tts']);

  if (mode === 'dry-run') {
    await cmdDryRun(candidate, outRoot);
    return;
  }
  if (mode === 'refs') {
    const description = arg('description') ?? CANDIDATE_DESCRIPTIONS[candidate];
    if (description === undefined) throw new Error(`需要 --description（或候选 ${candidate} 不在表里）`);
    /** `--neutral`：不带情绪指令的中性参考（漂移对照臂 D 用） */
    if (flag('neutral')) {
      await cmdRefs(candidate, description, outRoot, NO_EMOTION_KEY, 'refs-neutral');
      return;
    }
    /** `--fixed <emotion>`：五条全部用同一情绪指令（匹配对照臂 E 用） */
    const fixed = arg('fixed');
    if (fixed !== undefined) {
      await cmdRefs(candidate, description, outRoot, fixed, `refs-${fixed}`);
      return;
    }
    await cmdRefs(candidate, description, outRoot, null, 'refs');
    return;
  }
  if (mode === 'two-stage-refs') {
    const count = Number.parseInt(arg('count', '3')!, 10);
    await cmdTwoStageRefs(candidate, count, outRoot);
    return;
  }
  if (mode === 'clone') {
    const count = Number.parseInt(arg('count', '3')!, 10);
    await cmdClone(candidate, count, outRoot);
    return;
  }
  throw new Error(`未知子命令：${mode}（dry-run | refs | clone）`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
