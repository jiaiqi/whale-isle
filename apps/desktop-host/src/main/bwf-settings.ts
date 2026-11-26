/**
 * BWF /settings 远程设置推送与 config.json 端口同步（T-M6-16 + 可配置端口）。
 *
 * BWF（1.1.27+本仓补丁）在 MCP 同端口暴露 /settings：POST {revision, settings} 由
 * ModEntry.ApplyRemoteSettings 应用并 Helper.WriteConfig 落盘——改 ShowHud 每帧生效，无需重启游戏；
 * 改 McpPort 需写入 Mods/BlindWhaleFarmer/config.json 并重启星露谷生效（默认 18088，避开 Amazon Quick 等占用的 18080）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BWF_MCP_PORT } from '@workbench/shared-protocol';

export const BWF_DEFAULT_PORT = DEFAULT_BWF_MCP_PORT;

/**
 * 一律用 `127.0.0.1` 而不是 `localhost`：macOS 上 localhost 优先解析到 IPv6 `::1`，
 * BWF 的 HttpListener 只注册了 IPv4 前缀，`::1` 会一路 404（真机 2026-11-25 踩坑）。
 */
export function bwfBaseUrl(port: number = BWF_DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}`;
}

export function bwfMcpEndpoint(port: number = BWF_DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * 解析宿主应连的 BWF 端点。
 * `testEndpoint` 只由 `PET_STAGE_E2E` 注入（单桌宠链路 E2E 指向仿真 BWF），
 * 生产环境恒为 `undefined`，因此永远回落到真实端口；空串按未注入处理。
 */
export function resolveBwfEndpoint(options: { testEndpoint?: string | undefined; port?: number }): string {
  const injected = options.testEndpoint?.trim() ?? '';
  return injected === '' ? bwfMcpEndpoint(options.port) : injected;
}

export const BWF_BASE_URL = bwfBaseUrl(BWF_DEFAULT_PORT);

export interface BwfSettingsPush {
  /** 游戏侧真正应用了吗（快照回读 showHud == 目标值；旧 DLL 忽略未知键时为 false） */
  applied: boolean;
  /** MCP 端口可达吗（游戏没开时为 false，配置仍在本地持久化，开游戏后会自愈同步） */
  reachable: boolean;
  showHud: boolean;
}

export interface BwfPortSyncResult {
  ok: boolean;
  updated: boolean;
  configPath?: string;
  previousPort?: number;
  error?: string;
}

export interface BwfPlayerInControlPush {
  /** 游戏侧真正切到目标态了吗（回读快照 == 目标值） */
  applied: boolean;
  /** /settings 可达吗（游戏没开时为 false） */
  reachable: boolean;
  /** 游戏侧 DLL 认识 playerInControl 这个键吗（未打 T-M6-73 补丁的旧 DLL 为 false） */
  supported: boolean;
  playerInControl: boolean;
}

/**
 * T-M6-73：把宿主侧「我来操作 / 交还给 AI」同步成游戏内接管态（BWF `playerInControl`）。
 *
 * 补丁那边 `ApplyRemoteSettings` 把 `SetPlayerInControl` 排到主线程执行，所以 POST 返回的
 * 快照仍是旧值——必须隔一拍再回读一次才算真回执。旧 DLL 不认识这个键，回读里根本没有该字段，
 * 这时如实报 `supported: false`，宿主据此提示「按 F7 或更新 BWF 补丁」，而不是假装成功。
 */
export async function pushBwfPlayerInControl(
  inControl: boolean,
  baseUrl: string = BWF_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<BwfPlayerInControlPush> {
  try {
    const response = await fetchImpl(`${baseUrl}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: `whaleisle-${Date.now()}`, settings: { playerInControl: inControl } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { applied: false, reachable: true, supported: false, playerInControl: inControl };
    // 最多试 3 次，覆盖主线程一帧的调度延迟
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const snapshot = await fetchImpl(`${baseUrl}/settings`, { signal: AbortSignal.timeout(5_000) });
      if (!snapshot.ok) continue;
      const body = (await snapshot.json()) as { settings?: { playerInControl?: unknown } };
      const value = body.settings?.playerInControl;
      if (value === undefined) return { applied: false, reachable: true, supported: false, playerInControl: inControl };
      if (value === inControl) return { applied: true, reachable: true, supported: true, playerInControl: inControl };
    }
    return { applied: false, reachable: true, supported: true, playerInControl: inControl };
  } catch {
    return { applied: false, reachable: false, supported: false, playerInControl: inControl };
  }
}

/**
 * 将目标端口原子同步到星露谷 Mods/BlindWhaleFarmer/config.json 的 McpPort 字段，
 * 保留其他字段（ShowHud 等）。若目录不存在则如实返回 ok:false，绝不伪造写入。
 */
export function syncBwfConfigPort(modsDir: string, port: number): BwfPortSyncResult {
  if (modsDir.trim() === '') return { ok: false, updated: false, error: '未配置星露谷 Mods 目录' };
  const bwfDir = join(modsDir, 'BlindWhaleFarmer');
  if (!existsSync(bwfDir)) {
    return { ok: false, updated: false, error: '未检测到 BlindWhaleFarmer Mod 目录' };
  }
  const configPath = join(bwfDir, 'config.json');
  try {
    let data: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        data = { ...(parsed as Record<string, unknown>) };
      }
    }
    const previousPort = typeof data.McpPort === 'number' ? data.McpPort : undefined;
    if (previousPort === port) {
      return { ok: true, updated: false, configPath, previousPort };
    }
    data.McpPort = port;
    const tmp = `${configPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, configPath);
    return {
      ok: true,
      updated: true,
      configPath,
      ...(previousPort === undefined ? {} : { previousPort }),
    };
  } catch (error) {
    return {
      ok: false,
      updated: false,
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** POST /settings {revision, settings:{showHud}} → 回读快照验证应用（fetch 可注入便于单测） */
export async function pushBwfShowHud(
  showHud: boolean,
  baseUrl: string = BWF_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<BwfSettingsPush> {
  try {
    const response = await fetchImpl(`${baseUrl}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: `whaleisle-${Date.now()}`, settings: { showHud } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { applied: false, reachable: true, showHud };
    const body = (await response.json()) as { settings?: { showHud?: unknown } };
    const applied = body.settings?.showHud === showHud;
    return { applied, reachable: true, showHud };
  } catch {
    return { applied: false, reachable: false, showHud };
  }
}
