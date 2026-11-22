/**
 * 供应商安全凭据库与模型发现（T-dir-01，Magpie 交互思想重写）：
 * - API Key 经 Electron safeStorage 加密后落盘 userData/provider-vault.json；渲染进程永远只见掩码。
 *   （凭据库不在主进程 SQLite 的职责清单内——账本/记忆/Token 流水才用 SQLite；文件 KV 避开
 *    better-sqlite3 在 Node ABI 与 Electron ABI 之间的重编译冲突。）
 * - 模型发现 / 连接测试在主进程发 HTTP——UI 层严禁越权直调外部 API（dependency-cruiser 边界）。
 * 运行期安全锁：明文 key 只存在于主进程内存瞬间，绝不经 IPC 回传渲染进程。
 */
import { ipcMain, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const VAULT_FILENAME = 'provider-vault.json';

export interface DiscoverModelsArgs {
  providerId: string;
  /** OpenAI 兼容端点根（如 https://api.deepseek.com/v1），主进程自动拼 /models */
  baseUrl: string;
}

export interface TestChatArgs {
  providerId: string;
  baseUrl: string;
  modelId: string;
  /** 协议（缺省 openai）：anthropic 走 /messages + x-api-key，不拉 /models */
  protocol?: 'openai' | 'anthropic';
}

export interface VaultResult {
  ok: boolean;
  error?: string;
  /** save-key 返回掩码；discover 返回模型 id 列表；test-chat 返回延迟 ms */
  mask?: string;
  models?: string[];
  latencyMs?: number;
}

type VaultFile = Record<string, string>; // providerId → base64(cipher)

/** 掩码规则：≥12 字符露头尾 4 位，否则全掩（与 model-gateway sanitizer 的 {{MASKED}} 精神一致） */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length < 12) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

function loadVault(vaultPath: string): VaultFile {
  if (!existsSync(vaultPath)) return {};
  try {
    return JSON.parse(readFileSync(vaultPath, 'utf8')) as VaultFile;
  } catch {
    return {};
  }
}

/** 主进程内解密（T-M6-01 完整版）：供 gateway 构造使用——仅主进程，绝不回传渲染进程 */
export function readVaultKey(vaultPath: string, providerId: string): string | null {
  return storedKeyInner(vaultPath, providerId);
}

/** 主进程内部写入（导入器专用）：safeStorage 加密落盘，返回掩码；绝不经 IPC 回传明文 */
export function writeVaultKey(vaultPath: string, providerId: string, plainKey: string): { ok: boolean; mask?: string; error?: string } {
  if (typeof providerId !== 'string' || providerId.trim() === '' || typeof plainKey !== 'string' || plainKey.trim() === '') {
    return { ok: false, error: 'providerId 与 key 均不能为空' };
  }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统加密服务不可用（safeStorage），拒绝明文落盘' };
  const file = loadVault(vaultPath);
  file[providerId] = safeStorage.encryptString(plainKey.trim()).toString('base64');
  writeFileSync(vaultPath, JSON.stringify(file, null, 2), 'utf8');
  return { ok: true, mask: maskKey(plainKey) };
}

export function hasVaultKey(vaultPath: string, providerId: string): boolean {
  return storedKeyInner(vaultPath, providerId) !== null;
}

function storedKeyInner(vaultPath: string, providerId: string): string | null {
  const cipherB64 = loadVault(vaultPath)[providerId];
  if (!cipherB64) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  const buffer = safeStorage.decryptString(Buffer.from(cipherB64, 'base64'));
  return buffer.length > 0 ? buffer : null;
}

function isOpenCodeUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/** OpenCode Go 额外头：稳定会话 + 客户端 UA（缺失会 400 MissingSessionID） */
function extraHeaders(providerId: string, baseUrl: string, apiKey: string): Record<string, string> {
  if (providerId !== 'opencode-go' && !isOpenCodeUrl(baseUrl)) return {};
  return {
    Authorization: `Bearer ${apiKey}`,
    'x-opencode-session': `ses_${randomUUID().replace(/-/g, '')}`,
    'User-Agent': 'xiaojing-workbench/1.0',
  };
}

async function discoverModels(providerId: string, baseUrl: string, apiKey: string): Promise<string[]> {
  // OpenCode 的模型清单在协议无关根路径（/inference/go/v1/models），不是 /openai/v1/models
  const url = isOpenCodeUrl(baseUrl) || providerId === 'opencode-go'
    ? 'https://opencode.ai/inference/go/v1/models'
    : `${baseUrl.replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders(providerId, baseUrl, apiKey) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}（端点 ${url}）`);
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? [])
    .map((entry) => entry.id ?? '')
    .filter((id) => id !== '');
  if (ids.length === 0) throw new Error('响应里没有模型（data 为空，确认是否 OpenAI 兼容端点）');
  return ids;
}

export function registerProviderVaultIpc(vaultPath: string): void {
  const writeVault = (file: VaultFile): void => {
    writeFileSync(vaultPath, JSON.stringify(file, null, 2), 'utf8');
  };

  ipcMain.handle('providers:save-key', (_event, providerId: string, plainKey: string): VaultResult => {
    if (typeof providerId !== 'string' || typeof plainKey !== 'string' || plainKey.trim() === '') {
      return { ok: false, error: 'providerId 与 key 均不能为空' };
    }
    const written = writeVaultKey(vaultPath, providerId, plainKey);
    if (!written.ok) return written;
    return { ok: true, mask: written.mask };
  });

  ipcMain.handle('providers:key-mask', (_event, providerId: string): VaultResult => {
    const key = storedKeyInner(vaultPath, providerId);
    if (key === null) return { ok: true, mask: '' };
    return { ok: true, mask: maskKey(key) };
  });

  ipcMain.handle('providers:discover-models', async (_event, args: DiscoverModelsArgs & { protocol?: 'openai' | 'anthropic' }): Promise<VaultResult> => {
    const key = storedKeyInner(vaultPath, args.providerId);
    if (!key) return { ok: false, error: '该供应商尚未保存 API Key，先在卡片里保存' };
    if (args.protocol === 'anthropic') return { ok: false, error: 'Anthropic 协议不提供 /models 列表，请手动添加模型 ID' };
    try {
      const models = await discoverModels(args.providerId, args.baseUrl, key);
      return { ok: true, models };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('providers:test-chat', async (_event, args: TestChatArgs): Promise<VaultResult> => {
    const key = storedKeyInner(vaultPath, args.providerId);
    if (!key) return { ok: false, error: '该供应商尚未保存 API Key，先在卡片里保存' };
    const anthropic = args.protocol === 'anthropic';
    const base = args.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/messages') || base.endsWith('/chat/completions') ? base : `${base}/${anthropic ? 'messages' : 'chat/completions'}`;
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(anthropic
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${key}` }),
          ...extraHeaders(args.providerId, args.baseUrl, key),
        },
        body: JSON.stringify(
          anthropic
            ? { model: args.modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
            : { model: args.modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
        ),
        signal: AbortSignal.timeout(30_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const text = await response.text();
        return { ok: false, latencyMs, error: `HTTP ${response.status}：${text.slice(0, 160)}` };
      }
      return { ok: true, latencyMs };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
