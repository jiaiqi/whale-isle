/**
 * 多桌宠联机 agent 池（T-M6-22）：每个 agent = 一个 AutodriveRunner + 独立 MCP 端点 + 角色，
 * 互不共享动作锁/规划器/饭碗（复用并行会话 M7 的 gameAdapters，零侵入其 autodrive-host.ts 在制改造）。
 *
 * 真机拓扑：每个星露谷联机玩家一个游戏进程 + BWF Mod（config.McpPort 各不同），
 * 每个端点由一只桌宠控制。单端点（默认 18080）即当前单机用法。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ipcMain, type WebContents } from 'electron';
import { AutodriveRunner, gameAdapters, type AutodriveEvent } from '@workbench/game-bridge-mcp';
import { McpEndpointSchema, type McpEndpoint } from '@workbench/shared-protocol';

const DEFAULT_ENDPOINTS: McpEndpoint[] = [
  McpEndpointSchema.parse({
    id: 'default',
    displayName: '本机星露谷（小鲸）',
    gameId: 'stardew',
    endpoint: 'http://127.0.0.1:18080/mcp',
    characterId: 'blue-whale-maid',
    enabled: true,
  }),
];

interface Agent {
  endpoint: McpEndpoint;
  runner: AutodriveRunner | null;
  error: string | null;
}

export interface CoopHost {
  list(): Array<McpEndpoint & { running: boolean; error: string | null }>;
  stopAll(): void;
}

export function createCoopHost(options: {
  userDataDir: string;
  windows: () => WebContents[];
  onUsage?: (input: number, output: number) => void;
}): CoopHost {
  const configPath = join(options.userDataDir, 'mcp-endpoints.json');
  const readEndpoints = (): McpEndpoint[] => {
    try {
      if (existsSync(configPath)) {
        const parsed = McpEndpointSchema.array().safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
        if (parsed.success) return parsed.data;
      }
    } catch {
      /* 坏文件 → 默认单机端点 */
    }
    return DEFAULT_ENDPOINTS;
  };

  let endpoints = readEndpoints();
  const agents = new Map<string, Agent>();
  for (const ep of endpoints) agents.set(ep.id, { endpoint: ep, runner: null, error: null });

  const broadcast = (agentId: string, sessionId: string, event: AutodriveEvent): void => {
    // T-M6-27：联机事件带 agentId + sessionId，单会话 UI（中控台/主桌宠）据此过滤，绝不混入单机页
    for (const wc of options.windows()) {
      if (!wc.isDestroyed()) wc.send('autodrive:event', { ...event, agentId, sessionId });
    }
  };

  ipcMain.handle('coop:endpoints', () => optionsEndpointsView());
  ipcMain.handle('coop:start', async (_e, id: string) => {
    const agent = agents.get(id);
    if (!agent) return { ok: false, error: `未知端点：${id}` };
    if (agent.runner?.isRunning()) return { ok: true, already: true };
    try {
      const adapter = gameAdapters.create(agent.endpoint.gameId, { endpoint: agent.endpoint.endpoint });
      // T-M6-27：每个联机 agent 独立 sessionId；事件带 agentId + sessionId 供单会话 UI 过滤
      let sessionId = '';
      const runner = new AutodriveRunner(
        (event) => broadcast(agent.endpoint.id, sessionId, event),
        { endpoint: agent.endpoint.endpoint },
        adapter,
      );
      sessionId = runner.sessionId;
      await runner.start(); // 探活失败会抛，如实上报
      agent.runner = runner;
      agent.error = null;
      return { ok: true };
    } catch (error) {
      agent.error = error instanceof Error ? error.message : String(error);
      return { ok: false, error: agent.error };
    }
  });
  ipcMain.handle('coop:stop', (_e, id: string) => {
    const agent = agents.get(id);
    if (!agent) return { ok: false, error: `未知端点：${id}` };
    agent.runner?.stop();
    agent.runner = null;
    return { ok: true };
  });
  ipcMain.handle('coop:directive', (_e, id: string, tool: string, args: Record<string, unknown>, intent: string) => {
    const agent = agents.get(id);
    if (!agent?.runner?.isRunning()) return { ok: false, error: `端点未运行：${id}` };
    agent.runner.submitDirective(tool, args ?? {}, intent);
    return { ok: true };
  });

  function optionsEndpointsView(): Array<McpEndpoint & { running: boolean; error: string | null }> {
    return [...agents.values()].map((a) => ({
      ...a.endpoint,
      running: a.runner?.isRunning() ?? false,
      error: a.error,
    }));
  }

  return {
    list: optionsEndpointsView,
    stopAll() {
      for (const agent of agents.values()) {
        agent.runner?.stop();
        agent.runner = null;
      }
    },
  };
}
