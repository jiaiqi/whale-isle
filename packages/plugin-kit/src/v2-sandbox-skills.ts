/**
 * Whale Isle V2 — 第三方插件真实隔离沙箱（Worker Isolate）、策略 Broker 与 Agent Skills 注册表（V2-P2-02）
 *
 * 安全基线（ADR-002 & Blueprint 04 §3/§7/§8）：
 *   - 第三方插件严禁在主进程直接 `import(url)`；统一跑在剥离敏感 env 且带堆限制的独立 `node:worker_threads` V8 Isolate；
 *   - `PolicyBroker` 执行 P0–P5 权限阶梯与 `vault://` / `shell://` 硬拒并留存审计日志；
 *   - 插件超时（含同步死循环）通过 `worker.terminate()` 强制中止并隔离状态，绝不拖垮主进程；
 *   - `SkillRegistry` 按 Agent Skills 规范解析 `SKILL.md`，Skill 只是操作说明而不是权限凭证。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  AgentSkillManifestSchema,
  PluginSandboxHealthSchema,
  type AgentSkillManifest,
  type PluginSandboxHealth,
  type PluginSandboxStatus,
  type SkillSafetyStatus,
  type SkillScope,
  type ToolRiskTier,
} from '@workbench/shared-protocol';
import type { ToolResult } from './define-tool';
import type { PluginManifest } from './manifest';

export interface PolicyAuditEntry {
  timestamp: number;
  pluginId: string;
  resource: string;
  riskTier: ToolRiskTier;
  decision: 'allow' | 'ask' | 'deny';
  allowed: boolean;
  reason: string;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}

function matchPermissionPolicy(
  manifest: Pick<PluginManifest, 'permissions'>,
  resource: string,
): 'allow' | 'ask' | 'deny' | null {
  const exact = manifest.permissions.find((p) => p.resource === resource);
  if (exact !== undefined) return exact.policy;
  for (const p of manifest.permissions) {
    if (p.resource.endsWith('*') && resource.startsWith(p.resource.slice(0, -1))) return p.policy;
    if (p.resource.endsWith('/') && resource.startsWith(p.resource)) return p.policy;
  }
  return null;
}

/** 策略 Broker：在主进程侧统一裁决插件对能力/资源的 P0–P5 访问，并记录审计轨迹 */
export class PolicyBroker {
  private readonly approvals = new Map<string, Set<string>>();
  private readonly audits: PolicyAuditEntry[] = [];

  approve(pluginId: string, resource: string): void {
    let set = this.approvals.get(pluginId);
    if (set === undefined) {
      set = new Set();
      this.approvals.set(pluginId, set);
    }
    set.add(resource);
  }

  revokePlugin(pluginId: string): void {
    this.approvals.delete(pluginId);
  }

  evaluate(input: {
    pluginId: string;
    manifest: Pick<PluginManifest, 'permissions'>;
    resource: string;
    riskTier: ToolRiskTier;
  }): PolicyEvaluationResult {
    const record = (res: PolicyEvaluationResult): PolicyEvaluationResult => {
      this.audits.push({
        timestamp: Date.now(),
        pluginId: input.pluginId,
        resource: input.resource,
        riskTier: input.riskTier,
        decision: res.decision,
        allowed: res.allowed,
        reason: res.reason,
      });
      if (this.audits.length > 500) this.audits.splice(0, this.audits.length - 500);
      return res;
    };

    if (
      input.riskTier === 'P5_FORBIDDEN'
      || input.resource.startsWith('vault://')
      || input.resource.startsWith('vault:')
      || input.resource.startsWith('shell://')
    ) {
      return record({ allowed: false, decision: 'deny', reason: 'FORBIDDEN_CAPABILITY' });
    }

    const declared = matchPermissionPolicy(input.manifest, input.resource);
    if (declared === null) {
      return record({ allowed: false, decision: 'deny', reason: 'PERMISSION_NOT_DECLARED' });
    }
    if (declared === 'deny') {
      return record({ allowed: false, decision: 'deny', reason: 'POLICY_DENY' });
    }
    if (declared === 'ask' || input.riskTier === 'P4_SENSITIVE') {
      const approved = this.approvals.get(input.pluginId)?.has(input.resource) ?? false;
      if (approved) {
        return record({ allowed: true, decision: 'allow', reason: 'APPROVED' });
      }
      return record({ allowed: false, decision: 'ask', reason: 'APPROVAL_REQUIRED' });
    }
    return record({ allowed: true, decision: 'allow', reason: 'POLICY_ALLOW' });
  }

  auditLog(): PolicyAuditEntry[] {
    return this.audits.map((entry) => ({ ...entry }));
  }
}

export interface SandboxBrokerRequest {
  pluginId: string;
  capability: 'pet:control';
  method: 'state' | 'say' | 'action';
  args: unknown[];
}

export interface IsolatedPluginRunnerOptions {
  pluginId: string;
  modulePath: string;
  manifest: PluginManifest;
  setupTimeoutMs?: number;
  invokeTimeoutMs?: number;
  maxHeapMb?: number;
  onEvent?: (event: string, payload: unknown) => void;
  onBrokerCall?: (req: SandboxBrokerRequest) => Promise<unknown>;
}

const SANDBOX_BOOTSTRAP_CODE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');

const handlers = new Map();
const eventListeners = new Map();
const cleanups = [];
const pendingBroker = new Map();
let brokerSeq = 0;

function brokerCall(capability, method, args) {
  return new Promise((resolve, reject) => {
    const reqId = ++brokerSeq;
    pendingBroker.set(reqId, { resolve, reject });
    parentPort.postMessage({ type: 'broker', reqId, capability, method, args });
  });
}

function matchEvent(pattern, event) {
  if (pattern === '*' || pattern === event) return true;
  if (pattern.endsWith(':*')) return event.startsWith(pattern.slice(0, -1));
  return false;
}

const ctx = {
  id: workerData.pluginId,
  tool(name, fn) {
    if (handlers.has(name)) throw new Error('工具名重复注册：' + name);
    handlers.set(name, fn);
  },
  on(event, fn) {
    const list = eventListeners.get(event) || [];
    list.push(fn);
    eventListeners.set(event, list);
  },
  once(event, fn) {
    const wrapper = (payload) => {
      const list = eventListeners.get(event) || [];
      const idx = list.indexOf(wrapper);
      if (idx >= 0) list.splice(idx, 1);
      return fn(payload);
    };
    ctx.on(event, wrapper);
  },
  emit(event, payload) {
    parentPort.postMessage({ type: 'plugin-emit', event, payload });
    return 1;
  },
  effect(cb) {
    const produced = cb();
    if (typeof produced === 'function') cleanups.push(produced);
    else if (produced && typeof produced.dispose === 'function') cleanups.push(() => produced.dispose());
  },
  ...(workerData.hasPetControl ? {
    pet: {
      state: (agentId) => brokerCall('pet:control', 'state', [agentId]),
      say: (agentId, text, options) => brokerCall('pet:control', 'say', [agentId, text, options || {}]),
      action: (agentId, actionState, durationMs) => brokerCall('pet:control', 'action', [agentId, actionState, durationMs || 6000]),
    },
  } : {}),
};

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'broker-result') {
    const waiter = pendingBroker.get(msg.reqId);
    if (!waiter) return;
    pendingBroker.delete(msg.reqId);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || 'BROKER_DENIED'));
    return;
  }
  if (msg.type === 'host-event') {
    for (const [pattern, list] of eventListeners.entries()) {
      if (!matchEvent(pattern, msg.event)) continue;
      for (const fn of [...list]) {
        try { await fn(msg.payload); } catch { /* 单监听器异常隔离 */ }
      }
    }
    return;
  }
  if (msg.type === 'invoke') {
    const fn = handlers.get(msg.tool);
    if (!fn) {
      parentPort.postMessage({ type: 'invoke-result', callId: msg.callId, ok: false, error: '未知工具：' + msg.tool });
      return;
    }
    try {
      const result = await fn(msg.args && typeof msg.args === 'object' ? msg.args : {});
      parentPort.postMessage({ type: 'invoke-result', callId: msg.callId, ok: true, result });
    } catch (err) {
      parentPort.postMessage({ type: 'invoke-result', callId: msg.callId, ok: false, error: err && err.message ? err.message : String(err) });
    }
    return;
  }
  if (msg.type === 'dispose') {
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try { await cleanups[i](); } catch { /* 清理异常隔离 */ }
    }
    parentPort.postMessage({ type: 'disposed' });
  }
});

(async () => {
  try {
    const sep = workerData.moduleUrl.includes('?') ? '&' : '?';
    const loaded = await import(workerData.moduleUrl + sep + 'v=' + Date.now());
    const candidate = loaded && (loaded.default || loaded.plugin);
    if (!candidate || typeof candidate !== 'object' || typeof candidate.apply !== 'function') {
      throw new Error('index.mjs 必须 export default { name, apply(ctx) }');
    }
    await candidate.apply(ctx);
    parentPort.postMessage({ type: 'ready', name: candidate.name || workerData.pluginId, tools: [...handlers.keys()] });
  } catch (err) {
    parentPort.postMessage({ type: 'setup-error', error: err && err.message ? err.message : String(err) });
  }
})();
`;

interface PendingCall {
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 独立 Worker Isolate 第三方插件运行器 */
export class IsolatedPluginRunner {
  private worker: Worker | null = null;
  private status: PluginSandboxStatus = 'idle';
  private restarts = 0;
  private lastError: string | undefined;
  private callSeq = 0;
  private readonly pendingCalls = new Map<number, PendingCall>();
  private disposedResolve: (() => void) | null = null;

  constructor(private readonly options: IsolatedPluginRunnerOptions) {}

  get setupTimeoutMs(): number {
    return this.options.setupTimeoutMs ?? 5_000;
  }

  get invokeTimeoutMs(): number {
    return this.options.invokeTimeoutMs ?? 5_000;
  }

  health(): PluginSandboxHealth {
    return PluginSandboxHealthSchema.parse({
      pluginId: this.options.pluginId,
      trustLevel: 'third-party-isolated',
      isolated: true,
      status: this.status,
      restarts: this.restarts,
      timeoutMs: this.invokeTimeoutMs,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    });
  }

  async start(): Promise<{ name: string; tools: string[] }> {
    if (this.status === 'running' && this.worker !== null) {
      throw new Error(`插件沙箱已在运行：${this.options.pluginId}`);
    }
    if (this.status === 'crashed' || this.status === 'stopped') {
      this.restarts += 1;
    }

    const hasPetControl = this.options.manifest.permissions.some(
      (p) => p.resource === 'pet:control' && p.policy !== 'deny',
    );
    const worker = new Worker(SANDBOX_BOOTSTRAP_CODE, {
      eval: true,
      env: {
        WHALE_PLUGIN_SANDBOX: '1',
        WHALE_PLUGIN_ID: this.options.pluginId,
      },
      workerData: {
        pluginId: this.options.pluginId,
        moduleUrl: pathToFileURL(this.options.modulePath).href,
        hasPetControl,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: this.options.maxHeapMb ?? 64,
        maxYoungGenerationSizeMb: 16,
      },
    });
    this.worker = worker;

    return new Promise<{ name: string; tools: string[] }>((resolve, reject) => {
      let settled = false;
      const failSetup = (msg: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        this.status = 'crashed';
        this.lastError = msg;
        const w = this.worker;
        this.worker = null;
        if (w !== null) void w.terminate();
        reject(new Error(msg));
      };

      const setupTimer = setTimeout(() => {
        failSetup(`PLUGIN_SETUP_TIMEOUT: ${this.options.pluginId} (${this.setupTimeoutMs}ms)`);
      }, this.setupTimeoutMs);

      worker.on('message', (msg: Record<string, unknown>) => {
        if (msg['type'] === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(setupTimer);
          this.status = 'running';
          this.lastError = undefined;
          const tools = Array.isArray(msg['tools'])
            ? msg['tools'].filter((t): t is string => typeof t === 'string')
            : [];
          resolve({ name: typeof msg['name'] === 'string' ? msg['name'] : this.options.pluginId, tools });
          return;
        }
        if (msg['type'] === 'setup-error') {
          failSetup(typeof msg['error'] === 'string' ? msg['error'] : 'PLUGIN_SETUP_ERROR');
          return;
        }
        if (msg['type'] === 'invoke-result') {
          const callId = Number(msg['callId']);
          const pending = this.pendingCalls.get(callId);
          if (pending === undefined) return;
          clearTimeout(pending.timer);
          this.pendingCalls.delete(callId);
          if (msg['ok'] === true) {
            pending.resolve({ ok: true, result: msg['result'] });
          } else {
            pending.resolve({ ok: false, error: typeof msg['error'] === 'string' ? msg['error'] : 'PLUGIN_TOOL_ERROR' });
          }
          return;
        }
        if (msg['type'] === 'plugin-emit' && typeof msg['event'] === 'string') {
          this.options.onEvent?.(msg['event'], msg['payload']);
          return;
        }
        if (msg['type'] === 'broker') {
          const reqId = Number(msg['reqId']);
          const capability = msg['capability'] as 'pet:control';
          const method = msg['method'] as 'state' | 'say' | 'action';
          const args = Array.isArray(msg['args']) ? msg['args'] : [];
          void (async () => {
            try {
              if (!this.options.onBrokerCall) throw new Error('BROKER_UNAVAILABLE');
              const result = await this.options.onBrokerCall({ pluginId: this.options.pluginId, capability, method, args });
              worker.postMessage({ type: 'broker-result', reqId, ok: true, result });
            } catch (err) {
              worker.postMessage({
                type: 'broker-result',
                reqId,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })();
          return;
        }
        if (msg['type'] === 'disposed') {
          this.disposedResolve?.();
          this.disposedResolve = null;
        }
      });

      worker.on('error', (err) => {
        this.rejectPendingCalls(`PLUGIN_WORKER_ERROR: ${err.message}`);
        if (!settled) failSetup(err.message);
        else {
          this.status = 'crashed';
          this.lastError = err.message;
        }
      });

      worker.on('exit', (code) => {
        this.rejectPendingCalls(`PLUGIN_WORKER_EXIT: code=${code}`);
        if (!settled) failSetup(`PLUGIN_EXIT_DURING_SETUP: code=${code}`);
        else if (this.status === 'running') {
          this.status = 'crashed';
          this.lastError = `Unexpected worker exit: code=${code}`;
        }
      });
    });
  }

  async invoke(tool: string, args: unknown, timeoutMs = this.invokeTimeoutMs): Promise<ToolResult> {
    if (this.status !== 'running' || this.worker === null) {
      return { ok: false, error: `PLUGIN_NOT_RUNNING: ${this.options.pluginId}` };
    }
    const callId = ++this.callSeq;
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        const msg = `PLUGIN_TIMEOUT: ${this.options.pluginId}.${tool} (${timeoutMs}ms)`;
        this.status = 'crashed';
        this.lastError = msg;
        const w = this.worker;
        this.worker = null;
        this.rejectPendingCalls(msg);
        if (w !== null) void w.terminate();
        resolve({ ok: false, error: msg });
      }, timeoutMs);

      this.pendingCalls.set(callId, { resolve, timer });
      this.worker!.postMessage({ type: 'invoke', callId, tool, args });
    });
  }

  dispatchEvent(event: string, payload: unknown): void {
    if (this.status !== 'running' || this.worker === null) return;
    this.worker.postMessage({ type: 'host-event', event, payload });
  }

  async stop(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.rejectPendingCalls('PLUGIN_STOPPED');
    if (w !== null) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.disposedResolve = null;
          resolve();
        };
        const timer = setTimeout(finish, 200);
        this.disposedResolve = finish;
        try {
          w.postMessage({ type: 'dispose' });
        } catch {
          finish();
        }
      });
      await w.terminate();
    }
    this.status = 'stopped';
  }

  private rejectPendingCalls(error: string): void {
    for (const [id, pending] of this.pendingCalls.entries()) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(id);
      pending.resolve({ ok: false, error });
    }
  }
}

function parseFrontmatterList(raw: string): string[] {
  const clean = raw.trim().replace(/^\[|\]$/g, '');
  if (clean === '') return [];
  return clean.split(/[,，;]+/).map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => s !== '');
}

/** 安全扫描 Skill 描述与脚本要求（Skill 是说明文件，绝非权限凭证） */
export function scanSkillSafety(
  meta: { license: string; declaredPermissions: readonly string[] },
  body: string,
): { status: SkillSafetyStatus; findings: string[] } {
  const findings: string[] = [];
  if (/vault:\/\/|shell:\/\/|process\.env\.[A-Z0-9_]*(?:KEY|TOKEN|SECRET)|curl\s+[^|\n]+\|\s*(?:ba)?sh|rm\s+-rf\s+\//i.test(body)) {
    findings.push('检测到高危指令或凭据访问企图（Skill 不得请求密钥或绕过沙箱执行）');
    return { status: 'blocked', findings };
  }
  if (meta.declaredPermissions.some((p) => /^(?:vault|shell)/i.test(p))) {
    findings.push('声明了被禁止的 vault/shell 权限（Skill 是说明文档，不授予任何宿主权限）');
    return { status: 'blocked', findings };
  }
  if (meta.license === 'UNKNOWN') {
    findings.push('缺少明确开源许可证声明（license）');
  }
  if (meta.declaredPermissions.some((p) => /account|payment|write/i.test(p))) {
    findings.push('声明了高风险操作范围，仍须受宿主 PolicyBroker 二次审批约束');
  }
  return { status: findings.length > 0 ? 'warning' : 'clean', findings };
}

/** 解析单个 `SKILL.md` 为 `AgentSkillManifest` */
export function parseSkillMarkdown(
  content: string,
  id: string,
  rootDir: string,
  dirs: { hasReferences: boolean; hasScripts: boolean; hasAssets: boolean },
): AgentSkillManifest {
  const yaml = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(content.trimStart());
  const block = yaml?.[1] ?? '';
  const body = yaml?.[2] ?? content;
  let name = id;
  let description = '';
  let version = '1.0.0';
  let source = 'local';
  let license = 'UNKNOWN';
  let declaredPermissions: string[] = [];
  let dependencies: string[] = [];

  for (const line of block.split('\n')) {
    const m = /^\s*([a-zA-Z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && val !== '') name = val;
    else if (key === 'description') description = val;
    else if (key === 'version' && val !== '') version = val;
    else if (key === 'source' && val !== '') source = val;
    else if (key === 'license' && val !== '') license = val;
    else if (key === 'permissions') declaredPermissions = parseFrontmatterList(val);
    else if (key === 'dependencies') dependencies = parseFrontmatterList(val);
  }

  const safety = scanSkillSafety({ license, declaredPermissions }, body);
  return AgentSkillManifestSchema.parse({
    id,
    name,
    description,
    version,
    source,
    license,
    scope: 'global',
    declaredPermissions,
    dependencies,
    hasReferences: dirs.hasReferences,
    hasScripts: dirs.hasScripts,
    hasAssets: dirs.hasAssets,
    safetyStatus: safety.status,
    safetyFindings: safety.findings,
    enabled: false,
    rootDir,
  });
}

/** 开放 Agent Skills 注册表 */
export class SkillRegistry {
  private readonly skills = new Map<string, AgentSkillManifest>();

  discover(skillsRoot: string): AgentSkillManifest[] {
    if (!existsSync(skillsRoot)) return [];
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rootDir = join(skillsRoot, entry.name);
      const skillMd = join(rootDir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, 'utf8');
      const prev = this.skills.get(entry.name);
      const manifest = parseSkillMarkdown(content, entry.name, rootDir, {
        hasReferences: existsSync(join(rootDir, 'references')),
        hasScripts: existsSync(join(rootDir, 'scripts')),
        hasAssets: existsSync(join(rootDir, 'assets')),
      });
      if (prev !== undefined) {
        manifest.scope = prev.scope;
        manifest.enabled = manifest.safetyStatus === 'blocked' ? false : prev.enabled;
      }
      this.skills.set(entry.name, manifest);
    }
    return this.list();
  }

  list(filter?: { scope?: SkillScope }): AgentSkillManifest[] {
    return [...this.skills.values()]
      .filter((s) => filter?.scope === undefined || s.scope === filter.scope)
      .map((s) => ({ ...s, declaredPermissions: [...s.declaredPermissions], dependencies: [...s.dependencies], safetyFindings: [...s.safetyFindings] }));
  }

  search(keyword: string): AgentSkillManifest[] {
    const q = keyword.trim().toLowerCase();
    if (q === '') return this.list();
    return this.list().filter((s) =>
      s.id.toLowerCase().includes(q)
      || s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q));
  }

  enable(id: string): { ok: boolean; error?: string } {
    const skill = this.skills.get(id);
    if (skill === undefined) return { ok: false, error: `Skill 不存在：${id}` };
    if (skill.safetyStatus === 'blocked') {
      return { ok: false, error: `安全扫描阻断启用：${skill.safetyFindings.join('；')}` };
    }
    skill.enabled = true;
    return { ok: true };
  }

  disable(id: string): { ok: boolean; error?: string } {
    const skill = this.skills.get(id);
    if (skill === undefined) return { ok: false, error: `Skill 不存在：${id}` };
    skill.enabled = false;
    return { ok: true };
  }

  setScope(id: string, scope: SkillScope): { ok: boolean; error?: string } {
    const skill = this.skills.get(id);
    if (skill === undefined) return { ok: false, error: `Skill 不存在：${id}` };
    skill.scope = scope;
    return { ok: true };
  }

  uninstall(id: string): boolean {
    return this.skills.delete(id);
  }
}
