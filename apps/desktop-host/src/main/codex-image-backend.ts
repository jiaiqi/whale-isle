/**
 * 本机 Codex CLI 生图后端（T-M6-61）。
 *
 * 复用 `codex login` 的 ChatGPT 订阅额度出图，不需要任何 API Key：
 *   - 优先 `codex-imagegen`（开源封装 jdmnk/codex-imagegen-cli，直接读 ~/.codex/auth.json，
 *     支持 generate 与参考图 edit，速度快）；
 *   - 兜底官方 `codex exec`（把「写入指定 PNG 路径」作为指令交给 CLI，慢速且依赖模型配合）。
 *
 * 安全铁律：
 *   - 只 existsSync 检查 auth.json，绝不读取/打印/回传 token 内容；
 *   - 执行层一律 execFile 参数数组（严禁拼接 shell 字符串），单张 90s 超时；
 *   - stderr/stdout 报错统一脱敏（sk-* / Bearer / token 字段），绝不进日志或渲染进程。
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type CodexBackendKind = 'codex-imagegen' | 'codex-exec';

export interface CodexCliDetection {
  /** 找到任一可用二进制 */
  available: boolean;
  backend: CodexBackendKind | null;
  binary: string | null;
  /** ~/.codex/auth.json（或 $CODEX_HOME/auth.json）存在；只检查存在性 */
  loggedIn: boolean;
  codexHome: string;
  /** 未安装 codex-imagegen 时的可复制安装提示（不替用户静默安装） */
  installHint: string;
  /** 未登录时的引导 */
  loginHint: string;
}

export interface ExecFileLike {
  (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
}

export const CODEX_IMAGEGEN_INSTALL_HINT = 'npm install -g codex-imagegen-cli';
export const CODEX_LOGIN_HINT = 'codex login';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** 常见安装位置：PATH 之外再补 ~/.local/bin、/opt/homebrew/bin、/usr/local/bin。 */
function candidateDirs(homeDir: string, pathEnv: string): string[] {
  const fromPath = pathEnv.split(':').map((entry) => entry.trim()).filter((entry) => entry !== '');
  return [...fromPath, join(homeDir, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

export function detectCodexCli(deps: {
  homeDir: string;
  pathEnv?: string;
  codexHome?: string;
  exists?: (path: string) => boolean;
}): CodexCliDetection {
  const exists = deps.exists ?? existsSync;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
  const codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? join(deps.homeDir, '.codex');
  const dirs = candidateDirs(deps.homeDir, pathEnv);
  let backend: CodexBackendKind | null = null;
  let binary: string | null = null;
  for (const dir of dirs) {
    const imagegen = join(dir, 'codex-imagegen');
    if (exists(imagegen)) { backend = 'codex-imagegen'; binary = imagegen; break; }
  }
  if (binary === null) {
    for (const dir of dirs) {
      const codex = join(dir, 'codex');
      if (exists(codex)) { backend = 'codex-exec'; binary = codex; break; }
    }
  }
  const loggedIn = exists(join(codexHome, 'auth.json'));
  return {
    available: binary !== null,
    backend,
    binary,
    loggedIn,
    codexHome,
    installHint: CODEX_IMAGEGEN_INSTALL_HINT,
    loginHint: CODEX_LOGIN_HINT,
  };
}

/** 报错脱敏：sk-*、Bearer、JSON token 字段一律替换；截断 300 字。 */
export function redactCodexError(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-••••')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ••••')
    .replace(/"(?:access_token|refresh_token|id_token|token|api_key)"\s*:\s*"[^"]*"/gi, '"$1":"••••"')
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}/g, '••••')
    .slice(0, 300);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export function sniffImageMime(buffer: Buffer): 'image/png' | 'image/webp' | 'image/jpeg' | null {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(PNG_MAGIC)) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

export interface RunCodexImageArgs {
  detection: CodexCliDetection;
  prompt: string;
  size: string;
  refPath?: string;
  outPng: string;
  timeoutMs?: number;
  execFileImpl?: ExecFileLike;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => Buffer;
  statSize?: (path: string) => number;
}

export interface CodexImageResult {
  ok: boolean;
  buffer?: Buffer;
  mimeType?: string;
  error?: string;
}

function execFilePromise(
  impl: ExecFileLike,
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `Codex CLI 超时（${Math.round(timeoutMs / 1000)}s 未返回）` });
    }, timeoutMs);
    try {
      impl(file, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) {
          const detail = redactCodexError(`${stderr}\n${stdout}`.trim() || error.message);
          resolve({ ok: false, error: `Codex CLI 执行失败：${detail}` });
          return;
        }
        resolve({ ok: true, stdout });
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `Codex CLI 启动失败：${redactCodexError(error instanceof Error ? error.message : String(error))}` });
    }
  });
}

/** 组装参数数组（纯函数，便于单测断言）。 */
export function buildCodexArgs(input: {
  backend: CodexBackendKind;
  prompt: string;
  size: string;
  refPath?: string;
  outPng: string;
}): string[] {
  if (input.backend === 'codex-imagegen') {
    if (input.refPath !== undefined && input.refPath !== '') {
      return ['edit', '--image', input.refPath, '--prompt', input.prompt, '--size', input.size, '--background', 'opaque', '--out', input.outPng];
    }
    return ['generate', '--prompt', input.prompt, '--size', input.size, '--background', 'opaque', '--out', input.outPng];
  }
  // 官方 codex exec 兜底：明确要求把图片写入指定路径，退出后由我们校验文件
  const instruction = [
    '使用你的内置图像生成能力生成一张图片，并把它以 PNG 格式写入下面这个文件路径。',
    `图片要求：${input.prompt}`,
    `输出路径：${input.outPng}`,
    '只写入该文件，不要创建其他文件，不要输出解释文字。',
  ].join('\n');
  return ['exec', instruction];
}

export async function runCodexImage(args: RunCodexImageArgs): Promise<CodexImageResult> {
  const { detection } = args;
  if (!detection.available || detection.binary === null) {
    return { ok: false, error: `未检测到本机 Codex CLI。安装快速后端：${detection.installHint}（或安装官方 codex 后重试）` };
  }
  if (!detection.loggedIn) {
    return { ok: false, error: `本机 Codex 未登录：请先在终端运行 ${detection.loginHint}，再回来重试（不会读取你的凭据内容）` };
  }
  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 180_000);
  const impl = args.execFileImpl ?? (nodeExecFile as unknown as ExecFileLike);
  const cliArgs = buildCodexArgs({
    backend: detection.backend ?? 'codex-exec',
    prompt: args.prompt,
    size: args.size,
    ...(args.refPath === undefined ? {} : { refPath: args.refPath }),
    outPng: args.outPng,
  });
  const result = await execFilePromise(impl, detection.binary, cliArgs, timeoutMs);
  if (!result.ok) return { ok: false, error: result.error };
  const exists = args.exists ?? existsSync;
  const statSize = args.statSize ?? ((path: string) => statSync(path).size);
  const readFile = args.readFile ?? ((path: string) => readFileSync(path));
  if (!exists(args.outPng)) {
    return { ok: false, error: 'Codex CLI 已退出但没有产出图片文件（codex exec 兜底模式依赖模型配合，可安装 codex-imagegen 获得稳定快速模式）' };
  }
  if (statSize(args.outPng) <= 0) {
    return { ok: false, error: 'Codex CLI 产出的图片文件为空' };
  }
  const buffer = readFile(args.outPng);
  const mimeType = sniffImageMime(buffer);
  if (mimeType === null) {
    return { ok: false, error: 'Codex CLI 产出的文件不是合法 PNG/WebP/JPEG 图片' };
  }
  return { ok: true, buffer, mimeType };
}

/** 生成临时输出路径（调用方负责用后删除）。 */
export function codexTempOutPath(): string {
  return join(tmpdir(), `whale-codex-${randomUUID()}.png`);
}

export function removeQuietly(path: string): void {
  try { unlinkSync(path); } catch { /* 临时文件清理失败不影响主链路 */ }
}
