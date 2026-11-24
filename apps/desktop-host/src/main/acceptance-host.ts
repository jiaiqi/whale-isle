/**
 * 验收台宿主（T-M6-53）：12 场景直接驱动真实桌宠窗口 + 回退检查 + 脱敏报告。
 * 所有姿态先经 manifest 可用集合解析回退，再发 `pet:pose (source=bench)`。
 */
import { ipcMain } from 'electron';
import {
  BENCH_SCENARIOS,
  buildAcceptanceReport,
  buildFallbackReport,
  type BenchResult,
  type BenchScenario,
} from './acceptance-bench';
import { resolvePose } from './pose-resolver';
import type { PetControlHost } from './pet-control-host';
import type { CharacterRegistry } from './character-registry';
import type { PetWindowManager } from './pet-window-manager';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createAcceptanceHost(options: {
  characters: () => CharacterRegistry;
  petControl: PetControlHost;
  manager: () => PetWindowManager | null;
  /** 当前默认桌宠 agentId */
  defaultAgentId: () => string;
  /** 随机串门彩蛋（缺省时该场景只播惊讶姿态） */
  summonEgg?: () => Promise<{ ok: boolean; agentId?: string; name?: string; error?: string }>;
}): { registerIpc(): void; paused: () => boolean } {
  let paused = false;
  let lastResults: BenchResult[] = [];

  const availablePoses = (): string[] => {
    const character = options.characters().selected();
    const manifest = options.characters().manifestOf(character);
    if (!manifest.ok) return [];
    return [
      ...manifest.manifest.actions.flatMap((action) => action.clips.map((clip) => clip.clipId)),
      ...manifest.manifest.ambientPool.map((clip) => clip.clipId),
    ];
  };

  const characterView = (): { name: string; id: string; available: string[]; fallbacks: ReturnType<typeof buildFallbackReport> } => {
    const character = options.characters().selected();
    const available = availablePoses();
    return { name: character.displayName, id: character.id, available, fallbacks: buildFallbackReport(available) };
  };

  const playPose = (agentId: string, requested: string): { pose: string; fallback: boolean } => {
    const resolved = resolvePose(requested, availablePoses());
    options.petControl.pose(agentId, resolved.pose, undefined, 'bench');
    return { pose: resolved.pose, fallback: resolved.fallback };
  };

  const runScenario = async (scenario: BenchScenario, agentId: string): Promise<BenchResult> => {
    let steps = 0;
    try {
      for (const step of scenario.steps) {
        if (step.kind === 'pose') playPose(agentId, step.value);
        else if (step.kind === 'action') options.petControl.petControlApi.action(agentId, step.value, 1_200);
        else if (step.kind === 'say') options.petControl.petControlApi.say(agentId, step.value, { scene: 'normal', wake: true });
        else if (step.kind === 'crown') options.manager()?.sendAgent(agentId, 'pet:crown', { on: step.value === 'on' });
        else if (step.kind === 'sleep' || step.kind === 'wake') options.manager()?.sendAgent(agentId, 'pet:bench-sleep', { asleep: step.kind === 'sleep' });
        else if (step.kind === 'egg') {
          const summoned = await options.summonEgg?.();
          if (summoned === undefined || !summoned.ok) throw new Error(summoned?.error ?? '彩蛋召唤器未接线');
          if (summoned.agentId !== undefined) {
            await sleep(1_000);
            // 模拟「点击揪出逃跑」：关掉彩蛋窗口
            options.petControl.closeAgent(summoned.agentId);
          }
        }
        steps += 1;
        await sleep(step.delayMs ?? 450);
      }
      return { scenarioId: scenario.id, label: scenario.label, status: 'completed', steps, note: '' };
    } catch (error) {
      return { scenarioId: scenario.id, label: scenario.label, status: 'failed', steps, note: error instanceof Error ? error.message : String(error) };
    }
  };

  const registerIpc = (): void => {
    ipcMain.handle('acceptance:catalog', () => ({
      scenarios: BENCH_SCENARIOS.map(({ id, label, description }) => ({ id, label, description })),
      character: characterView(),
      paused,
    }));
    ipcMain.handle('acceptance:pause', (_event, next: boolean) => {
      paused = Boolean(next);
      options.manager()?.broadcast('pet:pause-events', { paused });
      return { ok: true, paused };
    });
    ipcMain.handle('acceptance:pose', (_event, pose: string) => {
      const agentId = options.defaultAgentId();
      const result = playPose(agentId, String(pose));
      return { ok: true, agentId, ...result };
    });
    ipcMain.handle('acceptance:run', async (_event, scenarioId: string) => {
      const scenario = BENCH_SCENARIOS.find((item) => item.id === String(scenarioId));
      if (scenario === undefined) return { ok: false, error: `未知场景：${scenarioId}` };
      const result = await runScenario(scenario, options.defaultAgentId());
      lastResults = [...lastResults.filter((item) => item.scenarioId !== result.scenarioId), result];
      return { ok: true, result };
    });
    ipcMain.handle('acceptance:run-all', async () => {
      const agentId = options.defaultAgentId();
      lastResults = [];
      for (const scenario of BENCH_SCENARIOS) {
        lastResults.push(await runScenario(scenario, agentId));
      }
      return { ok: true, results: lastResults };
    });
    ipcMain.handle('acceptance:report', () => {
      const view = characterView();
      return {
        ok: true,
        markdown: buildAcceptanceReport({
          characterName: view.name,
          characterId: view.id,
          results: lastResults,
          fallbacks: view.fallbacks,
        }),
      };
    });
  };
  return { registerIpc, paused: () => paused };
}

export { buildFallbackReport };
