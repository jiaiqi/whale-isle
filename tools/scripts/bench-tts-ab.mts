#!/usr/bin/env node
/**
 * TTS 供应商听感对拍 bench harness（item 10 后续）。
 *
 * 目的：把同一句集送进不同 provider，产出**客观项**（成功率 / 整句耗时 / RTF / 字节数）与可试听的 wav，
 * 听感结论留给人。产物落到 `artifacts/tts-ab/<provider>/<emotion>-<n>.wav` + `manifest.json`
 * （`artifacts/` 被 gitignore，不入库）。
 *
 * 关键口径（不许糊弄）：
 * - 这些 API 都是**非流式**调用，"首包" 与 "整句" 是同一个数；真实首包需要流式实现，本脚本不假装有。
 * - RTF 只在能解析出音频时长时才算（wav 可解析；mp3 记 null，不估算）。
 * - 失败照实写进 manifest（`ok:false` + `error`），不许跳过、不许用估算值补位。
 *
 * 用法：
 *   # 真跑（需要 key，只从环境变量读，绝不写进仓库）
 *   WHALE_MIMO_API_KEY=… WHALE_MIMO_VOICE_DESCRIPTION='年轻女性，普通话，音色偏甜' \
 *     npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign
 *   MINIMAX_API_KEY=… npx tsx tools/scripts/bench-tts-ab.mts --provider minimax
 *   OPENAI_API_KEY=…  npx tsx tools/scripts/bench-tts-ab.mts --provider openai
 *
 *   # 假服务端跑通契约（不需要任何 key，产物标 simulated=true）
 *   npx tsx tools/scripts/bench-tts-ab.mts --fake --provider mimo-voicedesign --limit 3
 *
 *   # 音色一致性：同一段描述连续生成 N 次（配合 tools/scripts/speaker-cosine.py 算嵌入余弦）
 *   WHALE_MIMO_API_KEY=… WHALE_MIMO_VOICE_DESCRIPTION='…' \
 *     npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign --consistency 10
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CloudOpenAiTtsProvider,
  MiniMaxTtsProvider,
  MimoTtsProvider,
  type MimoTtsMode,
  OpenRouterTtsProvider,
  type VoiceProvider,
} from '../../packages/voice-runtime/src/providers';

type ProviderKey = 'mimo-voicedesign' | 'mimo-voiceclone' | 'mimo-tts' | 'minimax' | 'openai' | 'openrouter';

const SENTENCES: Array<{ emotion: string; text: string }> = [
  { emotion: 'sweet_normal', text: '主人，今天也辛苦啦，我给你倒杯热茶好不好呀。' },
  { emotion: 'sweet_normal', text: '欢迎回来，我一直在这里等你哦。' },
  { emotion: 'sweet_normal', text: '外面下雨了，记得带伞再出门。' },
  { emotion: 'sweet_normal', text: '你回来得正好，我刚把饭热上。' },
  { emotion: 'sweet_normal', text: '慢慢来，不用急，我陪着你。' },
  { emotion: 'tsundere_refuse', text: '哼，本鱼才没有偷懒，只是刚好在思考人生而已。' },
  { emotion: 'tsundere_refuse', text: '别误会，我只是顺手帮你整理了一下桌面。' },
  { emotion: 'tsundere_refuse', text: '你再说一遍试试，我可要生气了。' },
  { emotion: 'tsundere_refuse', text: '才、才不是特意等你的，只是刚好路过。' },
  { emotion: 'tsundere_refuse', text: '这种事我自己也能做，不用你帮忙。' },
  { emotion: 'rage_spray', text: '噗——再说我大肥鱼，我就把水喷到你脸上！' },
  { emotion: 'rage_spray', text: '谁胖了，这叫鲸鱼的标准体型懂不懂！' },
  { emotion: 'rage_spray', text: '再拍我脑袋，我就把水柱喷到天花板上。' },
  { emotion: 'rage_spray', text: '你够了啊，我真的要生气了！' },
  { emotion: 'rage_spray', text: '别以为我不会还手，我可是很凶的。' },
  { emotion: 'lazy_yawn', text: '唔……好困啊，能不能让我再睡五分钟嘛。' },
  { emotion: 'lazy_yawn', text: '今天的太阳好舒服，适合躺着什么都不做。' },
  { emotion: 'lazy_yawn', text: '哈欠，你先把事情放一放，陪我发会儿呆吧。' },
  { emotion: 'lazy_yawn', text: '再让我躺一会儿，就一会儿。' },
  { emotion: 'lazy_yawn', text: '动一下都好累，你自己玩吧。' },
  { emotion: 'happy_rice', text: '开饭啦开饭啦，今天的下饭菜看起来特别香！' },
  { emotion: 'happy_rice', text: '有白米饭吃我就很开心了，谢谢你。' },
  { emotion: 'happy_rice', text: '再来一碗，我还能再吃三碗。' },
  { emotion: 'happy_rice', text: '今天有加餐吗，我闻到香味了！' },
  { emotion: 'happy_rice', text: '吃饱了才有力气陪你玩呀。' },
];

const EMOTION_HINTS: Record<string, string> = {
  sweet_normal: '温柔甜软，带笑意',
  tsundere_refuse: '傲娇嘴硬，稍微不服气',
  rage_spray: '生气反驳，音量偏大',
  lazy_yawn: '慵懒困倦，语速偏慢',
  happy_rice: '开心雀跃，语气上扬',
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
/** `--from-vault`：Key 从 Electron 加密凭据库取，不要求 owner 为跑基准另设环境变量 */
let fromVault = false;
/**
 * 凭据库明文只经管道进入本进程内存：不落盘、不打印、不写 manifest。
 * 解密必须用 Electron（见 tools/scripts/vault-key.mjs 头注释）。
 */
const vaultKeys: Record<string, string | null> = {};

function readVaultKeys(ids: string[]): void {
  const electronBin = join(process.cwd(), 'apps', 'desktop-host', 'node_modules', '.bin', 'electron');
  const script = join(process.cwd(), 'tools', 'scripts', 'vault-key.cjs');
  const result = spawnSync(electronBin, [script, ...ids], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`读取凭据库失败：${result.error?.message ?? result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout) as Record<string, string | null>;
  for (const id of ids) vaultKeys[id] = parsed[id] ?? null;
  // 只报告哪些拿到了，绝不打印明文或任何片段
  console.error(`[from-vault] 已读取：${ids.map((id) => `${id}=${vaultKeys[id] === null ? '未取到' : 'ok'}`).join(' ')}`);
}

/** Key 优先级：--from-vault 拿到的凭据库 > 环境变量 > --fake 的占位值 */
function resolveKey(providerId: string, envName: string, fake: boolean): string | null {
  if (fromVault && vaultKeys[providerId] !== null && vaultKeys[providerId] !== undefined) {
    return vaultKeys[providerId]!;
  }
  return process.env[envName]?.trim() ?? (fake ? 'fake' : null);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 从 wav 头算时长；非 wav 返回 null（不估算） */
function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number): string => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') dataSize = size;
    offset += 8 + size + (size % 2);
  }
  if (byteRate <= 0 || dataSize <= 0) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

function makeWav(seconds = 2, sampleRate = 24000): Uint8Array {
  const samples = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 6000), 44 + i * 2);
  }
  return new Uint8Array(buf);
}

/** 假服务端：真实 HTTP + 真实 wav 字节，只用于证明 bench 与 provider 契约跑得通 */
async function startFakeServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const wav = makeWav();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from(wav).toString('base64') } } }] }));
        return;
      }
      if (req.url === '/v1/t2a_v2') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'ok' },
          data: { audio: Buffer.from(wav).toString('hex') },
          extra_info: { audio_length: 2000, audio_sample_rate: 24000 },
        }));
        return;
      }
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.from(wav));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface BuildResult {
  provider: VoiceProvider;
  simulated: boolean;
  name: string;
  /** 假服务端需要在跑完后关掉，否则进程会被 server 句柄挂住 */
  close?: () => Promise<void>;
}

async function buildProvider(key: ProviderKey, fake: boolean): Promise<BuildResult | null> {
  const fakeServer = fake ? await startFakeServer() : null;
  const base = fakeServer?.baseUrl;
  const description = process.env.WHALE_MIMO_VOICE_DESCRIPTION?.trim() ?? '年轻女声，中文普通话，音色偏甜，语速中等';
  const mimo = (mode: MimoTtsMode): MimoTtsProvider =>
    new MimoTtsProvider({
      mode,
      voiceDescription: description,
      emotionStyleHints: EMOTION_HINTS,
      resolveReferenceAudio: () => {
        const path = process.env.WHALE_MIMO_VOICE_SAMPLE;
        if (path === undefined || path === '') return null;
        // 延迟到调用时读，避免脚本启动就依赖样例文件
        return { bytes: new Uint8Array(readFileSync(path)) };
      },
      ...(base === undefined ? {} : { baseUrl: base }),
      resolveApiKey: () => resolveKey('mimo-tts', 'WHALE_MIMO_API_KEY', fake),
    });

  switch (key) {
    case 'mimo-voicedesign':
      return { provider: mimo('voicedesign'), simulated: fake, name: 'mimo-voicedesign', ...(fakeServer === null ? {} : { close: fakeServer.close }) };
    case 'mimo-voiceclone':
      return { provider: mimo('voiceclone'), simulated: fake, name: 'mimo-voiceclone', ...(fakeServer === null ? {} : { close: fakeServer.close }) };
    case 'mimo-tts':
      return { provider: mimo('tts'), simulated: fake, name: 'mimo-tts', ...(fakeServer === null ? {} : { close: fakeServer.close }) };
    case 'openrouter':
      return {
        provider: new OpenRouterTtsProvider({
          ...(base === undefined ? {} : { baseUrl: base }),
          resolveApiKey: () => resolveKey('openrouter', 'OPENROUTER_API_KEY', fake),
        }),
        simulated: fake,
        name: 'openrouter-gemini',
        ...(fakeServer === null ? {} : { close: fakeServer.close }),
      };
    case 'minimax':
      return {
        provider: new MiniMaxTtsProvider({
          ...(base === undefined ? {} : { baseUrl: base.replace(/\/v1$/, '') }),
          resolveApiKey: () => resolveKey('minimax', 'MINIMAX_API_KEY', fake),
        }),
        simulated: fake,
        name: 'minimax',
        ...(fakeServer === null ? {} : { close: fakeServer.close }),
      };
    case 'openai':
      return {
        provider: new CloudOpenAiTtsProvider({
          ...(base === undefined ? {} : { baseUrl: base }),
          resolveApiKey: () => resolveKey('openai-tts', 'OPENAI_API_KEY', fake),
        }),
        simulated: fake,
        name: 'openai',
        ...(fakeServer === null ? {} : { close: fakeServer.close }),
      };
    default:
      return null;
  }
}

/** 每个 provider 的 bench 音色：--voice 覆盖 > 环境变量 > 账号里已注册/内置的默认值 */
const voiceOverride = arg('voice');

function resolveVoiceRef(key: ProviderKey): string {
  if (voiceOverride !== undefined && voiceOverride.trim() !== '') return voiceOverride.trim();
  switch (key) {
    // MiniMax 定制音色 qiaopi_mengmei 是账号里已注册的 voice_id（2026-11-27 owner 确认）
    case 'minimax':
      return process.env.MINIMAX_VOICE_ID?.trim() || 'qiaopi_mengmei';
    // OpenAI 内置音色名；alloy 是平台默认可用的一个
    case 'openai':
      return process.env.OPENAI_TTS_VOICE?.trim() || 'alloy';
    // mimo-tts 只认 9 个内置音色之一，未知 id 会静默回落 mimo_default
    case 'mimo-tts':
      return process.env.WHALE_MIMO_VOICE?.trim() || 'mimo_default';
    // voicedesign/voiceclone 不使用 voiceRef；openrouter 走 provider 的 voice 选项，这里只是占位
    default:
      return 'bench_voice';
  }
}

async function main(): Promise<void> {
  const fake = flag('fake');
  fromVault = flag('from-vault');
  const requested = arg('provider', 'mimo-voicedesign')!;
  const limitRaw = arg('limit');
  const limit = limitRaw === undefined ? SENTENCES.length : Math.max(1, Number.parseInt(limitRaw, 10));
  const consistency = Number.parseInt(arg('consistency', '0')!, 10);
  /** `--out <目录>`：换产物根目录（默认 artifacts/tts-ab）；真实跑的实验组与假服务端产物分开放 */
  const outRoot = arg('out', join(process.cwd(), 'artifacts', 'tts-ab'))!;

  const providers: ProviderKey[] = requested === 'all'
    ? ['minimax', 'openai', 'openrouter', 'mimo-tts', 'mimo-voicedesign', 'mimo-voiceclone']
    : (requested.split(',') as ProviderKey[]);

  if (fromVault) {
    const ids = new Set<string>();
    for (const key of providers) {
      if (key === 'minimax') ids.add('minimax');
      else if (key === 'openai') ids.add('openai-tts');
      else if (key === 'openrouter') ids.add('openrouter');
      else ids.add('mimo-tts');
    }
    readVaultKeys([...ids]);
  }

  for (const key of providers) {
    const built = await buildProvider(key, fake);
    if (built === null) {
      console.error(`未知 provider：${key}`);
      process.exitCode = 2;
      return;
    }
    const status = await Promise.resolve(built.provider.probe());
    if (!status.available) {
      console.error(`[跳过] ${key} 不可用：${status.detail}`);
      console.error('      真跑需要环境变量（只从环境读，绝不写进仓库）：');
      console.error('        MiMo:    WHALE_MIMO_API_KEY（+ WHALE_MIMO_VOICE_DESCRIPTION；VoiceClone 另需 WHALE_MIMO_VOICE_SAMPLE）');
      console.error('        MiniMax: MINIMAX_API_KEY');
      console.error('        OpenAI:  OPENAI_API_KEY');
      console.error('      只想验证链路可用 --fake（产物会标 simulated=true，不许当实测数据引用）。');
      process.exitCode = 3;
      continue;
    }

    const dir = join(outRoot, built.name);
    mkdirSync(dir, { recursive: true });
    const manifest: Array<Record<string, unknown>> = [];
    /**
     * 情绪稳定性实验：`--consistency 10 --emotion daily` 让 10 次都走同一档情绪
     * （daily = 温柔甜软 + (Sweet) 标签），再看 F0 / RMS / 时长的离散度；
     * 不传回落 `consistency`（无风格指令，只测音色本身）。2026-11-27 owner 要求。
     */
    const consistencyEmotion = arg('emotion', 'consistency');
    const rows = consistency > 0
      ? Array.from({ length: consistency }, () => ({ emotion: consistencyEmotion, text: SENTENCES[0]!.text }))
      : SENTENCES.slice(0, limit);

    /**
     * 音色按 provider 给，不许统一传占位串：MiniMax 把 voiceRef 直接当 voice_id 打进请求，
     * 账号里没有 `bench_voice` 就 25/25 全拒（2026-11-27 实测）。--voice 可覆盖，环境变量次之。
     */
    const voiceRef = resolveVoiceRef(key);
    for (const [i, row] of rows.entries()) {
      const n = i + 1;
      const started = Date.now();
      try {
        const out = await built.provider.synthesize({
          requestId: `bench-${built.name}-${n}`,
          characterId: 'char_xiaojing',
          voiceRef,
          text: row.text,
          emotion: row.emotion,
          styleMode: 'normal',
          speed: 1,
          timeoutMs: 30_000,
          pitchShiftSemitones: 0,
          volume: 1,
        });
        const wallMs = Date.now() - started;
        const bytes = out.audioBase64 === undefined ? new Uint8Array() : new Uint8Array(Buffer.from(out.audioBase64, 'base64'));
        // 扩展名跟真实格式走：MiniMax 返回 mp3，硬改名成 .wav 就是骗人
        const ext = out.format === 'mp3' ? 'mp3' : out.format === 'ogg' ? 'ogg' : 'wav';
        const file = `${row.emotion}-${n}.${ext}`;
        writeFileSync(join(dir, file), bytes);
        const audioMs = wavDurationMs(bytes);
        manifest.push({
          n,
          file,
          emotion: row.emotion,
          text: row.text,
          provider: built.name,
          format: out.format,
          wallMs,
          /** 非流式调用：首包 == 整句，这里显式写清楚，避免被误读 */
          firstPacketMs: wallMs,
          audioMs,
          rtf: audioMs === null ? null : Number((wallMs / audioMs).toFixed(3)),
          bytes: bytes.byteLength,
          simulated: built.simulated,
          ok: true,
        });
        console.log(`[${built.name}] ${n}/${rows.length} ${row.emotion} wall=${wallMs}ms bytes=${bytes.byteLength}`);
      } catch (err) {
        const wallMs = Date.now() - started;
        manifest.push({
          n,
          file: null,
          emotion: row.emotion,
          text: row.text,
          provider: built.name,
          wallMs,
          simulated: built.simulated,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(`[${built.name}] ${n}/${rows.length} ${row.emotion} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const ok = manifest.filter((m) => m['ok'] === true);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      provider: built.name,
      simulated: built.simulated,
      mode: consistency > 0 ? 'consistency' : 'ab',
      note: built.simulated
        ? 'simulated=true：假服务端回的是固定正弦 wav，只证明链路通，不可当实测数据引用'
        : '非流式调用：firstPacketMs 与 wallMs 相同；rtf 仅在 wav 可解析时长时给出',
      total: manifest.length,
      succeeded: ok.length,
      rows: manifest,
    }, null, 2));
    console.log(`[${built.name}] 完成：${ok.length}/${manifest.length} 成功 → ${dir}`);
    await built.close?.();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
