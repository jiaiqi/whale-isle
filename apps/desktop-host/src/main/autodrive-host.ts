/**
 * autodrive 宿主接线（T-M5-02 宿主层）：主进程持有 AutodriveRunner，
 * 事件单源多播到 director + pet-stage 两窗（webContents.send，preload 桥中继）。
 * 启停由 Shell 显式触发（用户不在游戏时不自动跑）。
 */
import { ipcMain, safeStorage, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutodriveRunner,
  LlmPlanner,
  RulePlanner,
  type AutodriveEvent,
} from '@workbench/game-bridge-mcp';
import { ModelGateway } from '@workbench/model-gateway';
import { readVaultKey } from './provider-vault';

export interface AutodriveHost {
  readonly runner: AutodriveRunner;
  /** 广播目标（两窗 webContents；窗口重建后由 main 更新） */
  setTargets(targets: WebContents[]): void;
}

export function createAutodriveHost(endpoint = 'http://127.0.0.1:18080/mcp', vaultPath?: string): AutodriveHost {
  const windows: WebContents[] = [];

  // ---- T-M6-01 完整版：LLM 大脑（vault key → model-gateway → LlmPlanner） ----
  // 干饭套餐（Magpie 范式）：全部槽位绑定 deepseek-official/deepseek-flash（用户已配 key）
  const DELUXE_PROFILE = {
    profileId: 'DELUXE_LIVESTREAM',
    displayName: 'LIVE 档',
    roleBindings: {
      MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-flash',
      STARDEW_GAME_PLANNER: 'deepseek-official/deepseek-flash',
      DANMAKU_FAST_ROUTER: 'deepseek-official/deepseek-flash',
      VISION_STORYBOARD: 'deepseek-official/deepseek-flash',
      VOICE_TTS_SPEECH: 'deepseek-official/deepseek-flash',
      VOICE_SVC_SINGING: 'deepseek-official/deepseek-flash',
    },
    secretMaskingEnabled: true,
  };
  let brainMode: 'rule' | 'llm' = 'rule';
  let gateway: InstanceType<typeof ModelGateway> | null = null;
  let llmPlanner: LlmPlanner | null = null;
  let recentReceipts: string[] = [];
  const buildBrain = (): void => {
    if (!vaultPath || !safeStorage.isEncryptionAvailable()) return;
    const key = readVaultKey(vaultPath, 'deepseek-official');
    if (!key) return;
    gateway = new ModelGateway({
      profile: DELUXE_PROFILE as never,
      keys: { 'deepseek-official': key },
    });
    llmPlanner = new LlmPlanner({
      chat: (slot, messages, opts) =>
        gateway!.chat(slot as never, messages, { maxTokens: opts?.maxTokens }).catch((error: unknown) => {
          console.error('[llm-planner] gateway.chat 失败:', error instanceof Error ? error.message : String(error));
          throw error;
        }),
      recentReceipts,
    });
  };
  buildBrain();
  ipcMain.handle('planner:switch', (_e, mode: string) => {
    if (mode === 'llm' && !llmPlanner) {
      return { ok: false, error: 'LLM 大脑未就绪（供应商 key 未配置或未重启工作台）' };
    }
    brainMode = mode === 'llm' ? 'llm' : 'rule';
    if (brainMode === 'llm' && llmPlanner) {
      (runner as unknown as { planner: LlmPlanner }).planner = llmPlanner;
    } else {
      (runner as unknown as { planner: LlmPlanner }).planner = new RulePlanner() as unknown as LlmPlanner;
    }
    return { ok: true, mode: brainMode };
  });
  ipcMain.handle('planner:status', () => ({ mode: brainMode, llmReady: llmPlanner !== null }));

  // 聊天回话（D3）：雷区反射先行（不烧主脑）→ 主脑回话 → 广播两窗
  const XIAOJING_SYSTEM = '你是「小鲸」——一条傲娇干饭蓝鲸女仆，住在主人 Mac 桌面上，正在替主人自动游玩《星露谷物语》。口吻：嘴硬心软的傲娇女仆；回复短小精悍（≤80字）；偶尔提到饭碗/米粒；不解释自己是 AI；用中文。';
  ipcMain.handle('chat:say', async (_e, text: string) => {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: '空消息' };
    if (/大肥鱼/.test(text)) {
      const spray = '谁、谁是鱼！本鱼是鲸！喷水抗议！';
      broadcast({ type: 'receipt', tool: 'reflex_spray', status: 'COMPLETED', summary: spray } as AutodriveEvent);
      return { ok: true, reply: spray, reflex: true };
    }
    if (!gateway) return { ok: false, error: '主脑未接通（供应商 key 未配置）' };
    try {
      const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [
        { role: 'system', content: XIAOJING_SYSTEM },
        { role: 'user', content: text },
      ], { maxTokens: 200 });
      broadcast({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: receipt.content } as AutodriveEvent);
      return { ok: true, reply: receipt.content };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('guides:load', () => {
    if (!llmPlanner) return { ok: false, error: 'LLM 大脑未就绪' };
    try {
      const here = dirname(fileURLToPath(import.meta.url)); // .../apps/desktop-host/dist/main
      const dir = join(here, '../../../../guide-forager'); // dist/main → 仓库根/guide-forager（4 级）
      const guides: Record<string, string> = {};
      const missing: string[] = [];
      for (const topic of ['钓鱼', '采矿', '节日', '结婚', '沙漠', '姜岛', '农场类型']) {
        try { guides[topic] = readFileSync(join(dir, topic + '.md'), 'utf8').slice(0, 4000); } catch { missing.push(topic); }
      }
      (llmPlanner as unknown as { deps: { guides: Record<string, string> } }).deps.guides = guides;
      console.log('[guides:load] dir =', dir, '| loaded:', Object.keys(guides).length, '| missing:', missing.join(','));
      return { ok: true, topics: Object.keys(guides) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // ---- T-M5-16（D16）pets 动作库：manifest 读取 + 预览转发 ----
  ipcMain.handle('pets:manifest', () => {
    try {
      const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../renderer/pet-stage/assets/blue-whale-maid/manifest.json');
      return { ok: true, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // preview：actionState（槽位）或 clipId（ambient 单条）——转发给 pet-stage 窗
  ipcMain.handle('pets:preview', (_e, action: string, clipId: string | null) => {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('pet:preview', { action, clipId });
    }
    return { ok: true };
  });
  // ---- D16：饭碗档位联动（每回执扣米 → 档位广播 → 桌宠档位动作） ----
  let riceBalance = 12_480; // 初始（与 fixtures 一致）；后续接 token_ledger 真实计量（T-M5-04）
  let riceLevel = 'hungry'; // 初始 12.48% 即在饥饿线下——首个回执前不发（避免启动即广播）
  const broadcastRice = (level: string): void => {
    // D16 边沿触发：仅档位变化时广播（同档持续不重复刷桌宠动作）
    if (level === riceLevel) return;
    riceLevel = level;
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('pet:rice', { level, balance: riceBalance });
    }
  };
  ipcMain.handle('rice:feed', (_e, grains: number) => {
    riceBalance += Math.max(0, grains);
    // 投喂下饭菜 → fed_buff 档（dsh-pet Buff 思想）；低于满 buff 线回落 ok
    broadcastRice(riceBalance > 100_000 * 0.9 ? 'fed_buff' : riceBalance > 80_000 ? 'full' : 'ok');
    return { ok: true, balance: riceBalance };
  });
  ipcMain.handle('rice:status', () => ({ balance: riceBalance }));
  const broadcast = (event: AutodriveEvent): void => {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('autodrive:event', event);
    }
  };
  const runner = new AutodriveRunner((event) => {
    if (event.type === 'receipt' && event.tool !== 'autodrive') {
      recentReceipts.push(event.status + ' ' + event.tool + ': ' + (event.summary ?? '').slice(0, 80));
      if (recentReceipts.length > 8) recentReceipts = recentReceipts.slice(-8);
      if (llmPlanner) (llmPlanner as unknown as { deps: { recentReceipts: string[] } }).deps.recentReceipts = recentReceipts;
    }
    // 回执扣米（1 回执 = 30 粒模拟计量；真实 token 计量待 T-M5-04 token_ledger 接线）
    if (event.type === 'receipt' && event.tool !== 'autodrive') {
      riceBalance = Math.max(0, riceBalance - 30);
      const ratio = riceBalance / 100_000;
      broadcastRice(ratio < 0.05 ? 'starving' : ratio < 0.15 ? 'hungry' : ratio > 0.8 ? 'full' : 'ok');
      void riceLevel;
    }
    broadcast(event);
  }, { endpoint });

  ipcMain.handle('autodrive:start', async () => {
    try {
      await runner.start();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('autodrive:stop', () => {
    runner.stop();
    return { ok: true };
  });
  ipcMain.handle('autodrive:directive', (_e, tool: string, args: Record<string, unknown>, intent: string) => {
    runner.submitDirective(tool, args ?? {}, typeof intent === 'string' ? intent : '远程指令');
    return { ok: true };
  });
  ipcMain.handle('autodrive:status', () => ({ running: runner.isRunning() }));

  return {
    runner,
    setTargets(targets) {
      windows.length = 0;
      windows.push(...targets);
    },
  };
}
