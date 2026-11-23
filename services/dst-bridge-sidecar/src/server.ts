/**
 * DST sidecar HTTP 双面服务（M7 / T-M7-D4）。
 *
 * 宿主面（统一桥接协议，供 dst-adapter / AutodriveRunner 消费）：
 *   GET /state · POST /act · GET /action_status?id= · POST /cancel · GET /health
 * 游戏面（Klei 653007 官方 localhost QueryServer 通道）：
 *   POST /v1/tick  body={token,snapshot} → {planId,expiresAt,actions}（fruitstarzero 模式）
 * 文件降级：unsafedata/dst_bridge_snapshot.json → unsafedata/dst_bridge_plan.json
 *
 * 契约：直接消费 @workbench/shared-protocol（单点事实源）。
 * 真机前置：cluster_token.txt 需人类用 Klei 账号生成；本服务不生成/绕过 token。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DstActionReceiptSchema,
  DstStateSnapshotSchema,
  GameBridgeActionAcceptedSchema,
  GameBridgeActionRequestSchema,
  GameBridgeHealthSchema,
  type DstActionReceipt,
  type DstStateSnapshot,
} from '@workbench/shared-protocol';

const PLAN_TTL_MS = 5_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface PlanAction {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface TickPlan {
  planId: string;
  /** epoch 毫秒（与 DstStateSnapshot.capturedAt 同单位）；mod 据此做过期校验 */
  expiresAt: number;
  actions: PlanAction[];
}

export interface TickResult {
  ok: boolean;
  status: number;
  plan?: TickPlan;
  error?: string;
}

export interface SidecarOptions {
  pairToken: string;
  port?: number;
  host?: string;
  bridgeVersion?: string;
  /** 人类接管哨兵（mod 每 tick 读取）；sidecar 与专用服须共享工作目录约定 */
  controlFile?: string;
  onLog?: (line: string) => void;
}

export interface SidecarStats {
  ticks: number;
  plans: number;
  receipts: number;
  actionsAccepted: number;
  lastTickAt: number | null;
  hasSnapshot: boolean;
  mode: 'http' | 'file' | 'both';
}

export interface DstSidecar {
  start(): Promise<number>;
  close(): Promise<void>;
  port(): number;
  applyTick(body: unknown): TickResult;
  setTakeover(active: boolean): void;
  enableFileFallback(options?: FileFallbackOptions): void;
  stats(): SidecarStats;
}

export interface FileFallbackOptions {
  snapshotFile?: string;
  planFile?: string;
  intervalMs?: number;
}

interface PendingAction {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 常量时间比较（sha256 定长摘要），避免 token 逐字节短路泄露。 */
function safeTokenEqual(actual: string, expected: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return digest(actual).equals(digest(expected));
}

/**
 * 创建 sidecar（不自动监听；start() 才 listen，便于测试注入 ephemeral port）。
 */
export function createDstSidecar(options: SidecarOptions): DstSidecar {
  if (!options.pairToken) throw new Error('pairToken 不能为空：mod 与 sidecar 必须配对鉴权');
  const log = options.onLog ?? (() => undefined);
  const controlFile = options.controlFile ?? 'unsafedata/dst_bridge_control.json';

  let server: Server | null = null;
  let lastSnapshot: DstStateSnapshot | null = null;
  let lastTickAt: number | null = null;
  let pending: PendingAction | null = null;
  let cancelRequested = false;
  let fileTimer: ReturnType<typeof setInterval> | null = null;
  let fallback: Required<FileFallbackOptions> | null = null;
  let lastFrame = '';
  const receipts = new Map<string, DstActionReceipt>();
  const statsInternal: SidecarStats = {
    ticks: 0, plans: 0, receipts: 0, actionsAccepted: 0,
    lastTickAt: null, hasSnapshot: false, mode: 'http',
  };

  function applyTick(body: unknown): TickResult {
    if (!isRecord(body)) return { ok: false, status: 400, error: 'INVALID_BODY' };
    if (!safeTokenEqual(String(body.token ?? ''), options.pairToken)) {
      return { ok: false, status: 401, error: 'INVALID_PAIR_TOKEN' };
    }
    const rawSnapshot = body.snapshot;
    if (!isRecord(rawSnapshot)) return { ok: false, status: 400, error: 'MISSING_SNAPSHOT' };

    // mod 把四态回执作为附带字段塞进快照；先剥离再过契约，契约保持单点事实源不被污染。
    const { lastReceipt, ...snapshotRaw } = rawSnapshot;
    const parsedSnapshot = DstStateSnapshotSchema.safeParse(snapshotRaw);
    if (!parsedSnapshot.success) {
      return { ok: false, status: 400, error: `SNAPSHOT_CONTRACT_VIOLATION: ${parsedSnapshot.error.message.slice(0, 200)}` };
    }
    lastSnapshot = parsedSnapshot.data;
    lastTickAt = Date.now();
    statsInternal.lastTickAt = lastTickAt;
    statsInternal.hasSnapshot = true;
    statsInternal.ticks++;

    if (lastReceipt !== undefined && isRecord(lastReceipt)) {
      const parsedReceipt = DstActionReceiptSchema.safeParse({ ...lastReceipt, snapshot: parsedSnapshot.data });
      if (parsedReceipt.success) {
        receipts.set(parsedReceipt.data.actionId, parsedReceipt.data);
        statsInternal.receipts++;
        if (pending?.actionId === parsedReceipt.data.actionId) {
          pending = null;
          cancelRequested = false;
        }
      } else {
        log(`回执契约违规：${parsedReceipt.error.message.slice(0, 200)}`);
      }
    }

    const actions: PlanAction[] = [];
    if (pending) {
      actions.push(cancelRequested
        ? { actionId: randomUUID(), tool: 'cancel_action', args: {} }
        : { actionId: pending.actionId, tool: pending.tool, args: pending.args });
    }
    cancelRequested = false;
    const plan: TickPlan = { planId: randomUUID(), expiresAt: Date.now() + PLAN_TTL_MS, actions };
    statsInternal.plans++;
    return { ok: true, status: 200, plan };
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('BODY_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new Error('INVALID_JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      // ── 游戏面 ──
      if (req.method === 'POST' && url.pathname === '/v1/tick') {
        const result = applyTick(await readJson(req));
        sendJson(res, result.status, result.ok ? result.plan : { error: result.error });
        return;
      }
      // ── 宿主面 ──
      if (req.method === 'GET' && url.pathname === '/state') {
        if (lastSnapshot === null) {
          sendJson(res, 503, { error: 'NO_SNAPSHOT_YET', hint: '等待 mod 首次 /v1/tick 上报快照' });
          return;
        }
        sendJson(res, 200, DstStateSnapshotSchema.parse(lastSnapshot));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, GameBridgeHealthSchema.parse({
          ok: true,
          gameId: 'dst',
          bridgeVersion: options.bridgeVersion ?? 'dst-sidecar-1.0',
          gameVersion: lastSnapshot === null ? 'UNKNOWN' : 'DST',
          control: lastSnapshot?.control.authority ?? 'AI_AUTOPILOT',
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/act') {
        const parsed = GameBridgeActionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          sendJson(res, 400, { error: 'INVALID_ACTION_REQUEST', detail: parsed.error.message.slice(0, 200) });
          return;
        }
        const { actionId, tool, args } = parsed.data;
        if (pending) {
          sendJson(res, 200, GameBridgeActionAcceptedSchema.parse({ accepted: false, actionId, reason: 'ACTION_IN_FLIGHT' }));
          return;
        }
        pending = { actionId, tool, args, startedAt: Date.now() };
        cancelRequested = false;
        statsInternal.actionsAccepted++;
        sendJson(res, 200, GameBridgeActionAcceptedSchema.parse({ accepted: true, actionId }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/action_status') {
        const actionId = url.searchParams.get('id') ?? '';
        const receipt = receipts.get(actionId);
        const running = pending?.actionId === actionId;
        sendJson(res, 200, {
          actionId,
          running,
          ...(receipt ? { receipt: DstActionReceiptSchema.parse(receipt) } : {}),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/cancel') {
        const wasActive = pending !== null;
        if (wasActive) cancelRequested = true; // 下一次 tick 下发 cancel_action mod 原生中止，不伪造接管
        sendJson(res, 200, { cancelled: wasActive });
        return;
      }
      sendJson(res, 404, { error: 'NOT_FOUND', path: url.pathname });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  function writeControl(active: boolean): void {
    mkdirSync(dirname(controlFile), { recursive: true });
    writeFileSync(controlFile, JSON.stringify({ takeover: active, at: Date.now() }), 'utf8');
  }

  function pollFallback(): void {
    if (!fallback) return;
    if (!existsSync(fallback.snapshotFile)) return;
    try {
      const text = readFileSync(fallback.snapshotFile, 'utf8');
      if (text === lastFrame) return;
      lastFrame = text;
      const result = applyTick(JSON.parse(text) as unknown);
      const plan = result.ok ? result.plan : { error: result.error };
      mkdirSync(dirname(fallback.planFile), { recursive: true });
      const tmp = `${fallback.planFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(plan), 'utf8');
      renameSync(tmp, fallback.planFile);
    } catch (error) {
      log(`文件降级失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        const srv = createServer((req, res) => { void route(req, res); });
        server = srv;
        srv.once('error', reject);
        srv.listen(options.port ?? 18100, options.host ?? '127.0.0.1', () => {
          srv.off('error', reject);
          const address = srv.address();
          if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('sidecar 监听地址不可用'));
        });
      });
    },
    async close() {
      if (fileTimer) { clearInterval(fileTimer); fileTimer = null; }
      fallback = null;
      statsInternal.mode = 'http';
      const srv = server;
      server = null;
      if (!srv) return;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    },
    port() {
      const address = server?.address();
      return address && typeof address === 'object' ? address.port : -1;
    },
    applyTick,
    setTakeover(active: boolean) {
      writeControl(active);
    },
    enableFileFallback(opts: FileFallbackOptions = {}) {
      fallback = {
        snapshotFile: resolve(opts.snapshotFile ?? 'unsafedata/dst_bridge_snapshot.json'),
        planFile: resolve(opts.planFile ?? 'unsafedata/dst_bridge_plan.json'),
        intervalMs: opts.intervalMs ?? 250,
      };
      statsInternal.mode = 'both';
      if (fileTimer) clearInterval(fileTimer);
      fileTimer = setInterval(pollFallback, fallback.intervalMs);
      fileTimer.unref?.();
    },
    stats() {
      return { ...statsInternal };
    },
  };
}
