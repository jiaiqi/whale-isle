/**
 * 供应商安全凭据库与模型发现（T-dir-01，Magpie 交互思想重写）：
 * - API Key 经 Electron safeStorage 加密后落盘 userData/provider-vault.json；渲染进程永远只见掩码。
 *   （凭据库不在主进程 SQLite 的职责清单内——账本/记忆/Token 流水才用 SQLite；文件 KV 避开
 *    better-sqlite3 在 Node ABI 与 Electron ABI 之间的重编译冲突。）
 * - 模型发现 / 连接测试在主进程发 HTTP——UI 层严禁越权直调外部 API（dependency-cruiser 边界）。
 * 运行期安全锁：明文 key 只存在于主进程内存瞬间，绝不经 IPC 回传渲染进程。
 *
 * T-M6-66①（2026-11-25）持久化修复——真实根因是「同一份 vault 文件被多种 safeStorage 密钥交替写入」：
 *   a) macOS safeStorage 的密钥来自 Keychain 条目 `<app name> Safe Storage`。开发态（Electron 身份）
 *      与打包态（app.setName('鲸屿')）身份不同 → 同一 provider-vault.json 里混着两套密钥加密的条目，
 *      换一种启动方式就读不回另一套（2026-11-25 实测本机 vault：7 条里 4 条只能由 Electron 身份解密、
 *      3 条只能由鲸屿身份解密）。
 *   b) `--use-mock-keychain`（E2E / 真机调试为绕开钥匙串弹窗而加）使用 mock 密钥：它写出的密文
 *      真实 Keychain 解不开，真实密文在 mock 下也解不开；若仍写正常 vault 就把好数据永久覆盖。
 *
 * 因此本模块现在：
 *   - 文件升级为 v2（每条记录带写入身份 identity），旧平铺格式继续可读；写入只更新自己那条，
 *     不再用另一身份的密文覆盖整个文件。
 *   - mock keychain 启动时强制改用隔离文件 `provider-vault.mock-keychain.json`（并且拒绝写正常文件）。
 *   - 解密失败 / 身份不符 / 系统加密不可用不再静默：inspectVault() 给出逐服务商状态，供中控台展示。
 *   - 开发态可选环境变量兜底 `WHALE_PROVIDER_KEY_<PRESET>`：只读内存、不落盘、不进日志。
 *   - 解密后校验明文形态（可打印 ASCII）——safeStorage 的 v10 密文无完整性校验，错误密钥可能
 *     返回乱码而不抛错，必须拒绝，避免把乱码当 Key 发出去。
 */
import { app, clipboard, ipcMain, safeStorage, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const VAULT_FILENAME = 'provider-vault.json';
/** mock keychain（E2E/测试）专用隔离凭据库：绝不被正常实例读写 */
const MOCK_KEYCHAIN_VAULT_FILENAME = 'provider-vault.mock-keychain.json';
/** 开发态环境变量兜底前缀（仅本机、不写文件、不进日志） */
export const PROVIDER_KEY_ENV_PREFIX = 'WHALE_PROVIDER_KEY_';

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

/** 单条凭据：v2 记录写入身份，旧格式（纯 base64 字符串）无身份、解密时按当前身份试解 */
interface VaultEntry {
  cipher: string;
  /** 写入时的 safeStorage 身份（macOS 为 `<app name> Safe Storage` 对应的 app name） */
  identity?: string;
  savedAt?: string;
}

interface VaultFileV2 {
  version: 2;
  entries: Record<string, VaultEntry>;
}

/** 逐服务商凭据可用性（中控台服务商页展示；仅状态与掩码，永不含明文） */
export type VaultKeyState =
  | 'loaded'            // 已从钥匙串解密成功（或由环境变量提供，source='env'）
  | 'env'               // 开发态环境变量兜底
  | 'missing'           // 从未保存
  | 'decrypt-failed'    // 有密文但解密失败（钥匙串身份变化 / mock keychain）
  | 'identity-mismatch' // v2 记录明确由另一应用身份写入，当前身份不可能解密
  | 'encryption-unavailable';

export type VaultKeySource = 'keychain' | 'env' | 'none';

export interface VaultProviderStatus {
  providerId: string;
  state: VaultKeyState;
  source: VaultKeySource;
  mask?: string;
  /** 条目写入时的身份（v2）；旧格式无此字段 */
  savedBy?: string;
}

export interface VaultStatusReport {
  backend: 'keychain' | 'mock-keychain' | 'unavailable';
  encryptionAvailable: boolean;
  /** 当前 safeStorage 身份（dev=Electron，打包=鲸屿） */
  identity: string;
  /** 仅文件名，便于日志与 UI 说明隔离情况 */
  vaultFile: string;
  providers: VaultProviderStatus[];
}

export interface ResolvedProviderKey {
  key: string | null;
  state: VaultKeyState;
  source: VaultKeySource;
  mask?: string;
  savedBy?: string;
}

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

/* ------------------------------------------------------------------------- *
 * safeStorage 身份 / 后端探测
 * ------------------------------------------------------------------------- */

/** 当前 safeStorage 身份：macOS Keychain 服务名为 `<app name> Safe Storage`，密钥随 app name 漂移 */
function appIdentity(): string {
  try {
    return app?.getName?.() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function isPackagedApp(): boolean {
  try {
    return app?.isPackaged === true;
  } catch {
    return false;
  }
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 是否以 Chromium mock keychain 启动（E2E / 真机调试常用 `--use-mock-keychain` 绕开钥匙串弹窗）。
 * mock 密钥与真实 Keychain 互不兼容，必须使用隔离凭据库，绝不读写正常 vault。
 */
export function isMockKeychainLaunch(): boolean {
  try {
    if (app?.commandLine?.hasSwitch?.('use-mock-keychain') === true) return true;
  } catch {
    // 单测里 electron 可能只 mock 了部分 API —— 回落到 argv 判断
  }
  return process.argv.includes('--use-mock-keychain');
}

/** 凭据库文件名：mock keychain 强制隔离 */
export function vaultFileName(options: { mockKeychain?: boolean } = {}): string {
  return options.mockKeychain === true ? MOCK_KEYCHAIN_VAULT_FILENAME : VAULT_FILENAME;
}

/** 凭据库绝对路径（index.ts 在 app ready 前决定 userData 后调用） */
export function resolveVaultPath(userDataDir: string, options: { mockKeychain?: boolean } = {}): string {
  return join(userDataDir, vaultFileName(options));
}

export function vaultBackend(): VaultStatusReport['backend'] {
  if (isMockKeychainLaunch()) return 'mock-keychain';
  return encryptionAvailable() ? 'keychain' : 'unavailable';
}

/** `deepseek-official` → `WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL` */
export function providerKeyEnvVar(providerId: string): string {
  return `${PROVIDER_KEY_ENV_PREFIX}${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/* ------------------------------------------------------------------------- *
 * vault 文件读写（v2 兼容旧平铺格式）
 * ------------------------------------------------------------------------- */

function asVaultEntry(value: unknown): VaultEntry | null {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : { cipher: value };
  }
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.cipher !== 'string' || record.cipher.trim() === '') return null;
  return {
    cipher: record.cipher,
    ...(typeof record.identity === 'string' && record.identity !== '' ? { identity: record.identity } : {}),
    ...(typeof record.savedAt === 'string' ? { savedAt: record.savedAt } : {}),
  };
}

function loadVaultEntries(vaultPath: string): Record<string, VaultEntry> {
  if (!existsSync(vaultPath)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(vaultPath, 'utf8'));
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  const source = root.version === 2 && root.entries !== null && typeof root.entries === 'object' && !Array.isArray(root.entries)
    ? (root.entries as Record<string, unknown>)
    : root;
  const entries: Record<string, VaultEntry> = {};
  for (const [providerId, value] of Object.entries(source)) {
    const entry = asVaultEntry(value);
    if (entry !== null) entries[providerId] = entry;
  }
  return entries;
}

function saveVaultEntries(vaultPath: string, entries: Record<string, VaultEntry>): void {
  const file: VaultFileV2 = { version: 2, entries };
  writeFileSync(vaultPath, JSON.stringify(file, null, 2), 'utf8');
}

/**
 * 删除指定凭据并落盘（2026-11-26 补上：此前 V2 内核 `SecretVaultPort.delete` 是空操作，
 * AccountVault 的级联吊销因此静默失效、密文永久残留）。
 * 仅供主进程内部（AccountVault 级联删除）使用，不经任何 `providers:*` IPC 暴露。
 */
export function deleteVaultKey(vaultPath: string, providerId: string): boolean {
  const entries = loadVaultEntries(vaultPath);
  if (!(providerId in entries)) return false;
  delete entries[providerId];
  saveVaultEntries(vaultPath, entries);
  return true;
}

/**
 * 账号保险箱命名空间（V2-P3-03 `AccountVault` 的 `account:*` 条目与供应商 Key 共用同一 vault 文件）。
 * 供应商通道的全部 IPC 一律拒绝该前缀：否则渲染进程可借 `providers:copy-key` 把社交凭据写入剪贴板，
 * 或借 `providers:discover-models` / `check-balance` / `test-chat` 把凭据作为 Bearer 发到任意 baseUrl，
 * 击穿「凭据永不下行明文」的安全边界。
 */
const ACCOUNT_SCOPE_PREFIX = 'account:';

function isAccountScopedId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(ACCOUNT_SCOPE_PREFIX);
}

const ACCOUNT_SCOPE_ERROR = '该标识属于账号保险箱，不能经供应商通道访问';

/**
 * safeStorage 在 macOS 上产出 `v10` 前缀的 AES-CBC 密文（无认证标签）：用错钥匙时可能不抛错、
 * 直接返回乱码。API Key 实际都是可打印 ASCII 且不含空白，这里显式校验，避免把乱码当 Key 使用。
 */
function looksLikeApiKey(plain: string): boolean {
  return plain.length >= 4 && plain.length <= 4096 && /^[\x21-\x7e]+$/.test(plain);
}

interface DecryptedEntry {
  state: Extract<VaultKeyState, 'loaded' | 'identity-mismatch' | 'decrypt-failed' | 'encryption-unavailable'>;
  key?: string;
}

function decryptEntry(entry: VaultEntry): DecryptedEntry {
  const identity = appIdentity();
  // v2 记录已明确写入身份：身份不符时不做无意义的解密尝试（mock/另一身份的密文只会失败或乱码）
  if (entry.identity !== undefined && entry.identity !== identity) return { state: 'identity-mismatch' };
  if (!encryptionAvailable()) return { state: 'encryption-unavailable' };
  try {
    const plain = safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'));
    if (!looksLikeApiKey(plain)) return { state: 'decrypt-failed' };
    return { state: 'loaded', key: plain };
  } catch {
    return { state: 'decrypt-failed' };
  }
}

/**
 * 开发态环境变量兜底：仅在非打包态启用；只读 process.env，绝不写入 vault、绝不打日志。
 * 之所以只给开发态：打包发行版不应出现「绕过凭据库的隐式 Key 来源」。
 */
function envKeyOf(providerId: string): string | null {
  if (isPackagedApp()) return null;
  const raw = process.env[providerKeyEnvVar(providerId)];
  const key = raw?.trim() ?? '';
  return key === '' ? null : key;
}

function resolveEntry(entries: Record<string, VaultEntry>, providerId: string): ResolvedProviderKey {
  const entry = entries[providerId];
  if (entry !== undefined) {
    const decrypted = decryptEntry(entry);
    if (decrypted.state === 'loaded' && decrypted.key !== undefined) {
      return {
        key: decrypted.key,
        state: 'loaded',
        source: 'keychain',
        mask: maskKey(decrypted.key),
        ...(entry.identity !== undefined ? { savedBy: entry.identity } : {}),
      };
    }
    const fallback = envKeyOf(providerId);
    if (fallback !== null) {
      return { key: fallback, state: 'env', source: 'env', mask: maskKey(fallback) };
    }
    return {
      key: null,
      state: decrypted.state,
      source: 'none',
      ...(entry.identity !== undefined ? { savedBy: entry.identity } : {}),
    };
  }
  const fallback = envKeyOf(providerId);
  if (fallback !== null) return { key: fallback, state: 'env', source: 'env', mask: maskKey(fallback) };
  return { key: null, state: encryptionAvailable() ? 'missing' : 'encryption-unavailable', source: 'none' };
}

/** 主进程内解析凭据（含开发态环境变量兜底）；返回状态供 UI/日志如实展示 */
export function resolveProviderKey(vaultPath: string, providerId: string): ResolvedProviderKey {
  return resolveEntry(loadVaultEntries(vaultPath), providerId);
}

/** 仅为避免重复刷日志：同一 provider/状态只告警一次（日志绝不含 Key 本身） */
const warnedDecryptFailures = new Set<string>();

/** 主进程内解密（T-M6-01 完整版）：供 gateway 构造使用——仅主进程，绝不回传渲染进程 */
export function readVaultKey(vaultPath: string, providerId: string): string | null {
  const resolved = resolveProviderKey(vaultPath, providerId);
  if (resolved.key === null && (resolved.state === 'decrypt-failed' || resolved.state === 'identity-mismatch')) {
    const warnKey = `${providerId}:${resolved.state}:${resolved.savedBy ?? ''}`;
    if (!warnedDecryptFailures.has(warnKey)) {
      warnedDecryptFailures.add(warnKey);
      const by = resolved.savedBy !== undefined ? `，条目由「${resolved.savedBy}」身份写入` : '';
      const mockHint = isMockKeychainLaunch() ? '；当前是 --use-mock-keychain 启动，正常凭据库不可解密' : '';
      console.warn(`[vault] provider=${providerId} 解密失败（${resolved.state}${by}${mockHint}），请在模型与服务商页重新填写 Key`);
    }
  }
  return resolved.key;
}

/** 主进程内部写入（导入器专用）：safeStorage 加密落盘，返回掩码；绝不经 IPC 回传明文 */
export function writeVaultKey(vaultPath: string, providerId: string, plainKey: string): { ok: boolean; mask?: string; error?: string } {
  if (typeof providerId !== 'string' || providerId.trim() === '' || typeof plainKey !== 'string' || plainKey.trim() === '') {
    return { ok: false, error: 'providerId 与 key 均不能为空' };
  }
  if (!encryptionAvailable()) return { ok: false, error: '系统加密服务不可用（safeStorage），拒绝明文落盘' };
  // 硬保险：mock keychain 启动时即使调用方传错路径，也绝不覆盖正常凭据库
  if (isMockKeychainLaunch() && basename(vaultPath) === VAULT_FILENAME) {
    return { ok: false, error: `mock keychain 与正常凭据库必须隔离：拒绝写入 ${VAULT_FILENAME}（应使用 ${MOCK_KEYCHAIN_VAULT_FILENAME}）` };
  }
  const entries = loadVaultEntries(vaultPath);
  let cipher: string;
  try {
    cipher = safeStorage.encryptString(plainKey.trim()).toString('base64');
  } catch {
    // 钥匙串被拒绝/不可用时 encryptString 可能直接抛错：如实返回错误，绝不回落明文
    return { ok: false, error: '系统加密失败（钥匙串不可用或未授权），Key 未保存' };
  }
  entries[providerId] = {
    cipher,
    identity: appIdentity(),
    savedAt: new Date().toISOString(),
  };
  saveVaultEntries(vaultPath, entries);
  return { ok: true, mask: maskKey(plainKey) };
}

export function hasVaultKey(vaultPath: string, providerId: string): boolean {
  return resolveProviderKey(vaultPath, providerId).key !== null;
}

/** 逐服务商可用性快照（中控台服务商页「Key 来源与可用性」；零明文） */
export function inspectVault(vaultPath: string, providerIds?: ReadonlyArray<string>): VaultStatusReport {
  const entries = loadVaultEntries(vaultPath);
  const ids = providerIds === undefined
    ? Object.keys(entries)
    : [...new Set(providerIds.filter((id) => typeof id === 'string' && id !== ''))];
  const providers: VaultProviderStatus[] = ids.map((providerId) => {
    const resolved = resolveEntry(entries, providerId);
    return {
      providerId,
      state: resolved.state,
      source: resolved.source,
      ...(resolved.mask !== undefined && resolved.mask !== '' ? { mask: resolved.mask } : {}),
      ...(resolved.savedBy !== undefined ? { savedBy: resolved.savedBy } : {}),
    };
  });
  return {
    backend: vaultBackend(),
    encryptionAvailable: encryptionAvailable(),
    identity: appIdentity(),
    vaultFile: basename(vaultPath),
    providers,
  };
}

/**
 * 启动时如实报告凭据来源与可用性（零明文）：只打后端/身份/文件名/计数与需重填的 providerId。
 * 返回状态对象，index.ts 亦可转交 UI/日志。
 */
export function logVaultStartup(vaultPath: string): VaultStatusReport {
  const report = inspectVault(vaultPath);
  const loaded = report.providers.filter((p) => p.state === 'loaded').length;
  const fromEnv = report.providers.filter((p) => p.state === 'env').length;
  const failed = report.providers.filter((p) => p.state === 'decrypt-failed' || p.state === 'identity-mismatch');
  const missing = report.providers.filter((p) => p.state === 'missing').length;
  const backendLabel = report.backend === 'mock-keychain'
    ? 'mock-keychain（测试隔离）'
    : report.backend === 'keychain' ? 'macOS Keychain' : '不可用';
  console.log(
    `[vault] 凭据后端=${backendLabel} 身份=${report.identity} 文件=${report.vaultFile} `
    + `已加载=${loaded} 环境变量=${fromEnv} 需重填=${failed.length} 未配置=${missing} 加密可用=${report.encryptionAvailable}`,
  );
  if (report.backend === 'mock-keychain') {
    console.warn(`[vault] 检测到 --use-mock-keychain：凭据只在隔离文件 ${report.vaultFile} 内，正常凭据库不受影响、也不可读`);
  }
  if (!report.encryptionAvailable) {
    console.warn('[vault] 系统加密不可用（safeStorage）——Key 无法保存或读取；开发态可用 WHALE_PROVIDER_KEY_<PRESET> 临时兜底');
  }
  if (failed.length > 0) {
    const detail = failed
      .map((p) => `${p.providerId}(${p.state}${p.savedBy !== undefined ? `，由 ${p.savedBy} 写入` : ''})`)
      .join('、');
    console.warn(`[vault] ${failed.length} 个 Key 解密失败需重填：${detail}`);
  }
  return report;
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
    'User-Agent': 'Whale-Isle/1.0',
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
  'platform.moonshot.cn',
  'platform.moonshot.ai',
  'opencode.ai',
  'jevmodel.org',
]);

export function registerProviderVaultIpc(vaultPath: string): void {
  ipcMain.handle('providers:vault-status', (_event, providerIds?: unknown): VaultStatusReport => {
    const ids = Array.isArray(providerIds)
      ? providerIds.filter((id): id is string => typeof id === 'string' && id !== '' && !isAccountScopedId(id))
      : undefined;
    return inspectVault(vaultPath, ids);
  });

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
    if (isAccountScopedId(providerId)) return { ok: false, error: ACCOUNT_SCOPE_ERROR };
    const written = writeVaultKey(vaultPath, providerId, plainKey);
    if (!written.ok) return written;
    return { ok: true, mask: written.mask };
  });

  ipcMain.handle('providers:key-mask', (_event, providerId: string): VaultResult => {
    if (isAccountScopedId(providerId)) return { ok: false, error: ACCOUNT_SCOPE_ERROR };
    const resolved = resolveProviderKey(vaultPath, providerId);
    return { ok: true, mask: resolved.key === null ? '' : (resolved.mask ?? maskKey(resolved.key)) };
  });

  ipcMain.handle('providers:discover-models', async (_event, args: DiscoverModelsArgs & { protocol?: 'openai' | 'anthropic' }): Promise<VaultResult> => {
    if (isAccountScopedId(args?.providerId)) return { ok: false, error: ACCOUNT_SCOPE_ERROR };
    const key = readVaultKey(vaultPath, args.providerId);
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
    if (isAccountScopedId(providerId)) return { ok: false, error: ACCOUNT_SCOPE_ERROR };
    const key = readVaultKey(vaultPath, providerId);
    if (key === null) return { ok: false, error: '该供应商尚未保存 API Key' };
    clipboard.writeText(key);
    return { ok: true, mask: maskKey(key) };
  });

  // 查询余额/额度（Magpie keybalance 思想）：主进程持 key 请求各厂商公开余额 API，渲染层只拿可读文案
  ipcMain.handle('providers:check-balance', async (_event, providerId: string): Promise<VaultResult> => {
    if (typeof providerId !== 'string' || providerId.trim() === '') return { ok: false, error: 'providerId 不能为空' };
    if (isAccountScopedId(providerId)) return { ok: false, error: ACCOUNT_SCOPE_ERROR };
    const probe = BALANCE_PROBES[providerId];
    if (probe === undefined) return { ok: false, error: '该服务商暂无公开余额 API（OpenAI/Anthropic/MiniMax/火山方舟均不提供）' };
    const key = readVaultKey(vaultPath, providerId);
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
    if (isAccountScopedId(args?.providerId)) return { ok: false, error: ACCOUNT_SCOPE_ERROR };
    const key = readVaultKey(vaultPath, args.providerId);
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
