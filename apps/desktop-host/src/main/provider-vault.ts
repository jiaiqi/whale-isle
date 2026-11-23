/**
 * 供应商安全凭据库与模型发现（T-dir-01，Magpie 交互思想重写）：
 * - API Key 经 Electron safeStorage 加密后落盘 userData/provider-vault.json；渲染进程永远只见掩码。
 *   （凭据库不在主进程 SQLite 的职责清单内——账本/记忆/Token 流水才用 SQLite；文件 KV 避开
 *    better-sqlite3 在 Node ABI 与 Electron ABI 之间的重编译冲突。）
 * - 模型发现 / 连接测试在主进程发 HTTP——UI 层严禁越权直调外部 API（dependency-cruiser 边界）。
 * 运行期安全锁：明文 key 只存在于主进程内存瞬间，绝不经 IPC 回传渲染进程。
 */
import { clipboard, ipcMain, safeStorage, shell } from 'electron';
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
  /** 决策协议模型（System One/jev 系）：改打 /inference/systemone 探针而不是 /chat/completions */
  decision?: boolean;
}

export interface VaultResult {
  ok: boolean;
  error?: string;
  /** save-key 返回掩码；discover 返回模型 id 列表；test-chat 返回延迟 ms */
  mask?: string;
  models?: string[];
  /** Console（原 Zen）清单附带的元数据（2026-11-22 实测 /inference/v1/models 带 type/cost） */
  freeModels?: string[];
  decisionModels?: string[];
  latencyMs?: number;
  /** check-balance 返回：可读余额文案 + 原始响应前 300 字（未知 schema 时的兜底显示与调试用） */
  text?: string;
  raw?: string;
}

/** 模型发现结果：ids + 免费档/决策协议元数据（仅 Console 根路径能解析出后两者） */
interface DiscoveredModels {
  ids: string[];
  free: string[];
  decision: string[];
}

type VaultFile = Record<string, string>; // providerId → base64(cipher)

/** 本地引擎（Ollama/GPT-SoVITS 等 loopback 端点）无需凭据，允许免 Key 测试与发现 */
function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * System One 决策协议端点注册表（2026-11-22 实证，请求/响应形状同源 TypeSafe API）：
 *   TypeSafe Jev 官方托管 jevmodel.org（登录送 10 万输入 token，探针实测响应见 CHANGELOG）；
 *   OpenCode Console 中继 /inference/systemone（免费档锁第三方客户端 422，付费 jev-1.13 需余额）。
 */
const SYSTEMONE_ENDPOINTS: ReadonlyArray<{ hosts: ReadonlyArray<string>; url: string }> = [
  { hosts: ['jevmodel.org'], url: 'https://jevmodel.org/v1/systemone' },
  { hosts: ['opencode.ai'], url: 'https://opencode.ai/inference/systemone/v1/systemone' },
];

function systemOneUrlOf(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    const hit = SYSTEMONE_ENDPOINTS.find((e) => e.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
    return hit?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * System One 决策协议探针（jev 系不吃 /chat/completions）：最小 noul 问题实测端点可达性。
 * 请求体用 TypeSafe 规范形状 {type/instructions/criteria}（jevmodel.org /zh/playground 示例，2026-11-22 实测 200）。
 */
async function testDecisionModel(url: string, apiKey: string, modelId: string): Promise<{ latencyMs: number }> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      state: '工作台连通探针：验证 System One 决策协议端点可达。',
      questions: {
        probe: {
          type: 'noul',
          instructions: '这条消息描述的问题是否需要今天处理？',
          criteria: {
            true: '服务可达并正常应答。',
            false: '服务不可达。',
          },
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}：${text.slice(0, 160)}`);
  }
  return { latencyMs };
}

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
  try {
    const buffer = safeStorage.decryptString(Buffer.from(cipherB64, 'base64'));
    return buffer.length > 0 ? buffer : null;
  } catch {
    // Keychain 密钥失配（如应用重命名/换机器）时 fail-closed：不崩主进程，UI 显示为未配置，
    // 由用户重新填写 Key；绝不回落明文或旧密钥。
    console.warn(`[vault] 凭据解密失败（provider=${providerId}），请在模型与服务商页重新填写 Key`);
    return null;
  }
}

function isOpenCodeHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/** OpenCode Go 推理路径（/inference/go/*）：需要稳定会话头，缺失会 400 MissingSessionID */
function isGoInferenceUrl(baseUrl: string): boolean {
  try {
    return isOpenCodeHost(baseUrl) && new URL(baseUrl).pathname.startsWith('/inference/go');
  } catch {
    return false;
  }
}

/**
 * OpenCode 家族的模型清单在协议无关根路径，不在各兼容端点下（2026-11-22 实证）：
 *   Go（包月）→ /inference/go/v1/models；Console（原 Zen，按量+免费档）→ /inference/v1/models。
 * 其余 opencode.ai 路径（含自定义中转指向 Console）一律按 Console 根处理。
 */
function opencodeModelsUrl(providerId: string, baseUrl: string): string | null {
  let isGo = providerId === 'opencode-go';
  if (isOpenCodeHost(baseUrl)) {
    try {
      if (new URL(baseUrl).pathname.startsWith('/inference/go')) isGo = true;
    } catch { /* 无效 URL 走兜底 */ }
  }
  if (isGo) return 'https://opencode.ai/inference/go/v1/models';
  if (isOpenCodeHost(baseUrl)) {
    try {
      if (new URL(baseUrl).pathname.startsWith('/inference')) return 'https://opencode.ai/inference/v1/models';
    } catch { /* 无效 URL 走兜底 */ }
  }
  return null;
}

/** OpenCode Go 额外头：稳定会话 + 客户端 UA（仅 Go 路径；Console 端点不需要会话头） */
function extraHeaders(providerId: string, baseUrl: string, apiKey: string): Record<string, string> {
  if (providerId !== 'opencode-go' && !isGoInferenceUrl(baseUrl)) return {};
  return {
    Authorization: `Bearer ${apiKey}`,
    'x-opencode-session': `ses_${randomUUID().replace(/-/g, '')}`,
    'User-Agent': 'xiaojing-workbench/1.0',
  };
}

async function discoverModels(providerId: string, baseUrl: string, apiKey: string): Promise<DiscoveredModels> {
  const special = opencodeModelsUrl(providerId, baseUrl);
  const url = special ?? `${baseUrl.replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders(providerId, baseUrl, apiKey) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}（端点 ${url}）`);
  }
  // Console（原 Zen）清单每条带 type（chat|decision|embedding|image|…）与 cost：只并入 chat/decision，
  // 并解析免费档（chat 且 input price 0）——embedding/image 混进模型列表是错误数据
  const isConsoleRoot = special !== null && !special.includes('/go/');
  const body = (await response.json()) as {
    data?: Array<{ id?: string; type?: string; cost?: { text?: { input?: { price?: number } } } }>;
  };
  const entries = (body.data ?? []).filter((entry) => (entry.id ?? '') !== '');
  const usable = isConsoleRoot ? entries.filter((entry) => entry.type === 'chat' || entry.type === 'decision') : entries;
  const ids = usable.map((entry) => entry.id ?? '');
  if (ids.length === 0) throw new Error('响应里没有模型（data 为空，确认是否 OpenAI 兼容端点）');
  const free = usable
    .filter((entry) => entry.type === 'chat' && (entry.cost?.text?.input?.price ?? 1) === 0)
    .map((entry) => entry.id ?? '');
  const decision = usable
    .filter((entry) => entry.type === 'decision')
    .map((entry) => entry.id ?? '');
  return { ids, free, decision };
}

/**
 * 各厂商余额/额度端点（Magpie keybalance 思想，2026-11-22 用户指令）：
 * 仅收录公开文档明确提供余额 API 的厂商；schema 未知的先回原文前 300 字，真机探明后精修解析器。
 */
interface BalanceProbe {
  url: string;
  extract: (body: unknown) => string;
}

const BALANCE_PROBES: Record<string, BalanceProbe> = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/key',
    extract: (body) => {
      const data = (body as { data?: { usage?: number; limit?: number | null; limit_remaining?: number | null } }).data ?? {};
      if (data.limit_remaining !== null && data.limit_remaining !== undefined) {
        const limit = data.limit !== null && data.limit !== undefined ? ` / 上限 $${Number(data.limit).toFixed(2)}` : '';
        return `$${Number(data.limit_remaining).toFixed(2)} 剩余${limit}`;
      }
      if (data.usage !== undefined) return `已用 $${Number(data.usage).toFixed(2)}（无上限）`;
      return '响应可读但字段未知（见 raw）';
    },
  },
  'deepseek-official': {
    url: 'https://api.deepseek.com/user/balance',
    extract: (body) => {
      const infos = (body as { balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }> }).balance_infos ?? [];
      const first = infos[0];
      if (first === undefined) return '响应可读但字段未知（见 raw）';
      return `${first.currency ?? ''} ${first.total_balance ?? '?'}（赠送 ${first.granted_balance ?? '?'} + 充值 ${first.topped_up_balance ?? '?'}）`;
    },
  },
  siliconflow: {
    url: 'https://api.siliconflow.cn/v1/user/info',
    extract: (body) => {
      const data = (body as { data?: { balance?: string | number; chargeBalance?: string | number; freeBalance?: string | number } }).data ?? {};
      if (data.balance !== undefined) {
        const parts = [
          data.chargeBalance !== undefined ? `充值 $${data.chargeBalance}` : '',
          data.freeBalance !== undefined ? `赠送 $${data.freeBalance}` : '',
        ].filter((s) => s !== '').join(' + ');
        return `$${data.balance}${parts !== '' ? `（${parts}）` : '（硅基流动余额）'}`;
      }
      return '响应可读但字段未知（见 raw）';
    },
  },
  'opencode-go': {
    // Go 订阅配额窗（真机 schema：{"usage":{"rolling|weekly|monthly":{"status","percent","resetsAt"}}}）
    url: 'https://opencode.ai/inference/go/v1/usage',
    extract: (body) => {
      const usage = (body as { usage?: Record<string, { status?: string; percent?: number; resetsAt?: string } | null> }).usage ?? {};
      const fmt = (key: string, label: string): string => {
        const w = usage[key];
        if (w === null || w === undefined) return '';
        const reset = w.resetsAt !== undefined ? `，${w.resetsAt.slice(11, 16)} UTC 重置` : '';
        return `${label}已用 ${w.percent ?? '?'}%${reset}`;
      };
      const parts = [fmt('rolling', '5h 窗'), fmt('weekly', '本周'), fmt('monthly', '本月')].filter((s) => s !== '');
      return parts.length > 0 ? `Go 配额：${parts.join(' · ')}` : '响应可读但字段未知（见 raw）';
    },
  },
};

/** 「获取 Key ↗」直达各厂商控制台（Magpie 交互）：主进程侧主机白名单，防渲染层被攻破后 openExternal 钓鱼 */
const KEY_CONSOLE_HOSTS: ReadonlySet<string> = new Set([
  'platform.deepseek.com',
  'cloud.siliconflow.cn',
  'openrouter.ai',
  'console.volcengine.com',
  'platform.openai.com',
  'console.anthropic.com',
  'platform.minimaxi.com',
  'opencode.ai',
  'jevmodel.org',
]);

export function registerProviderVaultIpc(vaultPath: string): void {
  const writeVault = (file: VaultFile): void => {
    writeFileSync(vaultPath, JSON.stringify(file, null, 2), 'utf8');
  };

  ipcMain.handle('providers:open-external', (_event, url: string): { ok: boolean; error?: string } => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !KEY_CONSOLE_HOSTS.has(parsed.hostname)) {
        return { ok: false, error: '不在控制台白名单内的地址' };
      }
      void shell.openExternal(parsed.toString());
      return { ok: true };
    } catch {
      return { ok: false, error: '无效地址' };
    }
  });

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
    if (key === null && !isLoopbackUrl(args.baseUrl)) return { ok: false, error: '该供应商尚未保存 API Key，先在卡片里保存' };
    if (args.protocol === 'anthropic') return { ok: false, error: 'Anthropic 协议不提供 /models 列表，请手动添加模型 ID' };
    try {
      const { ids, free, decision } = await discoverModels(args.providerId, args.baseUrl, key ?? '');
      return { ok: true, models: ids, freeModels: free, decisionModels: decision };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // 复制已保存 Key 到系统剪贴板（2026-11-22 用户指令）：明文只在主进程内存→剪贴板，绝不回传渲染进程
  ipcMain.handle('providers:copy-key', (_event, providerId: string): VaultResult => {
    if (typeof providerId !== 'string' || providerId.trim() === '') return { ok: false, error: 'providerId 不能为空' };
    const key = storedKeyInner(vaultPath, providerId);
    if (key === null) return { ok: false, error: '该供应商尚未保存 API Key' };
    clipboard.writeText(key);
    return { ok: true, mask: maskKey(key) };
  });

  // 查询余额/额度（Magpie keybalance 思想）：主进程持 key 请求各厂商公开余额 API，渲染层只拿可读文案
  ipcMain.handle('providers:check-balance', async (_event, providerId: string): Promise<VaultResult> => {
    if (typeof providerId !== 'string' || providerId.trim() === '') return { ok: false, error: 'providerId 不能为空' };
    const probe = BALANCE_PROBES[providerId];
    if (probe === undefined) return { ok: false, error: '该服务商暂无公开余额 API（OpenAI/Anthropic/MiniMax/火山方舟均不提供）' };
    const key = storedKeyInner(vaultPath, providerId);
    if (key === null) return { ok: false, error: '该供应商尚未保存 API Key' };
    try {
      const response = await fetch(probe.url, {
        headers: { Authorization: `Bearer ${key}`, ...extraHeaders(providerId, probe.url, key) },
        signal: AbortSignal.timeout(15_000),
      });
      // 先解析完整响应体，再截断做展示用 raw——顺序反了会把大响应截成非法 JSON（OpenRouter /key 实测踩过）
      const text = await response.text();
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}：${text.slice(0, 120)}` };
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* 非 JSON 原样透传 */ }
      return { ok: true, text: probe.extract(body), raw: text.slice(0, 300) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('providers:test-chat', async (_event, args: TestChatArgs): Promise<VaultResult> => {
    const key = storedKeyInner(vaultPath, args.providerId);
    // 本地引擎（loopback）无需凭据；云端必须先存 Key
    if (key === null && !isLoopbackUrl(args.baseUrl)) return { ok: false, error: '该供应商尚未保存 API Key，先在卡片里保存' };
    const apiKey = key ?? '';

    // 决策协议模型（System One/jev）：专用端点探针，不走 /chat/completions
    if (args.decision === true) {
      const systemOneUrl = systemOneUrlOf(args.baseUrl);
      if (systemOneUrl === null) {
        return { ok: false, error: '决策协议探针仅支持 TypeSafe Jev（jevmodel.org）与 OpenCode Console 的 System One 端点' };
      }
      const startedAt = Date.now();
      try {
        const { latencyMs } = await testDecisionModel(systemOneUrl, apiKey, args.modelId);
        return { ok: true, latencyMs };
      } catch (error) {
        return { ok: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
      }
    }

    const anthropic = args.protocol === 'anthropic';
    const base = args.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/messages') || base.endsWith('/chat/completions') ? base : `${base}/${anthropic ? 'messages' : 'chat/completions'}`;
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey !== ''
            ? (anthropic
              ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
              : { Authorization: `Bearer ${apiKey}` })
            : {}),
          ...extraHeaders(args.providerId, args.baseUrl, apiKey),
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
