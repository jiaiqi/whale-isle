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
  LLM_TOOL_WHITELIST,
  RulePlanner,
  extractDecisionJson,
  type AutodriveEvent,
} from '@workbench/game-bridge-mcp';
import { ModelGateway } from '@workbench/model-gateway';
import { readVaultKey } from './provider-vault';
import type { MemoryHost } from './memory-host';
import type { VoiceHost } from './voice-host';

export interface AutodriveHost {
  readonly runner: AutodriveRunner;
  /** 广播目标（两窗 webContents；窗口重建后由 main 更新） */
  setTargets(targets: WebContents[]): void;
  /** 与 Shell 聊天同款回话（WebUI /api/command 复用；人设雷区 0-token 反射） */
  say(text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }>;
  /** 外部订阅总线事件（WebUI WS 推送）；订阅即回放最近 100 条，返回退订函数 */
  subscribe(listener: (event: AutodriveEvent & { seq: number }) => void): () => void;
  /** 当前大脑模式（WebUI 快照用） */
  getBrainMode(): { mode: 'rule' | 'llm'; llmReady: boolean };
}

export function createAutodriveHost(endpoint = 'http://127.0.0.1:18080/mcp', vaultPath?: string, voiceHost?: VoiceHost, memoryHost?: MemoryHost): AutodriveHost {
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
  let brainMode: 'rule' | 'llm' = 'llm'; // 默认 LLM 大脑（llmPlanner 未就绪时自动回落规则）
  let gateway: InstanceType<typeof ModelGateway> | null = null;
  let llmPlanner: LlmPlanner | null = null;
  let recentReceipts: string[] = [];
  let lastGameClock = '';
  let eventSeq = 0;
  const eventHistory: (AutodriveEvent & { seq: number })[] = [];
  const busListeners = new Set<(event: AutodriveEvent & { seq: number }) => void>();
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

  /**
   * 自然语言控 AI（D3 对话指挥）：把主人「先把多余的东西放到出货箱」这类话翻成一个白名单工具指令，
   * 插队到下一轮（不打断当前动作）。解析失败/闲聊 → 静默跳过，只走聊天回话。
   */
  const CHAT_DIRECTIVE_SYSTEM = `你是《星露谷物语》指令解析器。判断用户这句话是不是要对 AI 玩家下达操作指令。
是指令 → 只输出一行 JSON：{"tool":"工具名","args":{},"intent":"一句话"}
不是指令（闲聊/提问/夸奖）→ 只输出 {"tool":""}
常用映射：整理/清理背包、给出货、腾位置 → tidy_backpack；去某地 → travel_to {"location":"Beach|Town|Farm|FarmHouse|Mine"}；钓鱼 → fish；睡觉/回家 → sleep；浇水 → water_crops。
只能使用 BWF 工具名，禁止臆造参数。`;

  /** 关键词直译（确定性优先，避免小模型把「先去海滩钓鱼」解析成闲聊） */
  const KEYWORD_DIRECTIVES: Array<{ re: RegExp; tool: string; args: Record<string, unknown>; intent: string }> = [
    { re: /(去|到|回)(海滩|海边|Beach)/i, tool: 'travel_to', args: { location: 'Beach' }, intent: '主人指令：去海滩' },
    { re: /(去|到|回)(农场|Farm)/i, tool: 'travel_to', args: { location: 'Farm' }, intent: '主人指令：去农场' },
    { re: /(去|到|回)(镇上|镇|Town)/i, tool: 'travel_to', args: { location: 'Town' }, intent: '主人指令：去镇上' },
    { re: /(去|下)(矿洞|矿|Mine)/i, tool: 'travel_to', args: { location: 'Mine' }, intent: '主人指令：去矿洞' },
    { re: /回?家|房子|FarmHouse/i, tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '主人指令：回家' },
    { re: /钓鱼|去钓|fish/i, tool: 'fish', args: {}, intent: '主人指令：钓鱼' },
    { re: /整理.{0,3}背包|清理.{0,3}背包|清.{0,3}背包|出货|卖掉|腾.{0,3}(位置|空位|地方)|背包.{0,4}满/, tool: 'tidy_backpack', args: {}, intent: '主人指令：先整理背包腾位置' },
    { re: /睡觉|休息|睡吧/, tool: 'sleep', args: {}, intent: '主人指令：睡觉' },
    { re: /浇水|浇一下/, tool: 'water_crops', args: {}, intent: '主人指令：浇水' },
  ];

  const tryChatDirective = async (text: string): Promise<void> => {
    if (!runner.isRunning()) return;
    const direct = KEYWORD_DIRECTIVES.find((k) => k.re.test(text));
    if (direct) {
      runner.submitDirective(direct.tool, direct.args, direct.intent);
      console.log('[chat-directive] keyword →', direct.tool, JSON.stringify(direct.args));
      return;
    }
    if (!gateway) return;
    try {
      const r = await gateway.chat('STARDEW_GAME_PLANNER', [
        { role: 'system', content: CHAT_DIRECTIVE_SYSTEM },
        { role: 'user', content: text },
      ], { maxTokens: 120 });
      const d = extractDecisionJson(r.content);
      if (!d || d.tool === '' || !LLM_TOOL_WHITELIST.has(d.tool)) return;
      runner.submitDirective(d.tool, d.args, `主人指令：${d.intent === '' ? text.slice(0, 24) : d.intent}`);
      console.log('[chat-directive] llm →', d.tool);
    } catch {
      /* 指令解析失败不影响聊天回话 */
    }
  };

  const say = async (text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }> => {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: '空消息' };
    if (/大肥鱼/.test(text)) {
      const spray = '谁、谁是鱼！本鱼是鲸！喷水抗议！';
      broadcast({ type: 'receipt', tool: 'reflex_spray', status: 'COMPLETED', summary: spray } as AutodriveEvent);
      speak({ text: spray, scene: 'p0' });
      return { ok: true, reply: spray, reflex: true };
    }
    if (!gateway) return { ok: false, error: '主脑未接通（供应商 key 未配置）' };
    void tryChatDirective(text); // 并行解析指令（不阻塞回话；非指令自动忽略）
    try {
      // T-M5-04：记忆增强——「你昨天做了什么」类问句检索图谱注入 system
      const memoryContext = memoryHost?.contextFor(text) ?? '';
      const system = memoryContext === '' ? XIAOJING_SYSTEM : `${XIAOJING_SYSTEM}

${memoryContext}
（以上是你的长期记忆；回答时自然地使用，不要编造记忆里没有的事）`;
      const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ], { maxTokens: 260 });
      broadcast({ type: 'receipt', tool: 'chat_reply', status: 'COMPLETED', summary: receipt.content } as AutodriveEvent);
      speak({ text: receipt.content, scene: 'normal' });
      return { ok: true, reply: receipt.content };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ipcMain.handle('chat:say', (_e, text: string) => say(text));
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
    // 环形缓冲（≤200 条）+ 单调 seq：中控台刷新后水合历史，不丢对话也不重复插卡
    const withSeq = { ...event, seq: ++eventSeq };
    eventHistory.push(withSeq);
    if (eventHistory.length > 200) eventHistory.splice(0, eventHistory.length - 200);
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('autodrive:event', withSeq);
    }
    // 外部订阅（WebUI WS）：单个订阅者异常不拖垮主广播
    for (const listener of busListeners) {
      try {
        listener(withSeq);
      } catch {
        /* 订阅方自身问题，隔离 */
      }
    }
  };
  const speak = (v: { text: string; scene?: 'normal' | 'inner' | 'p0' }): void => { void voiceHost?.speak(v); };
  const runner = new AutodriveRunner((event) => {
    if (event.type === 'receipt' && event.tool !== 'autodrive' && voiceHost?.config.enabled) {
      // 回执短评（D11 节流 8s 防刷）：翻车心虚 / 收获欢呼
      if (event.status === 'UNCERTAIN') speak({ text: '都、都怪这块石头突然长出来的！', scene: 'normal' });
      else if (event.status === 'COMPLETED' && /fish|钓/.test(String(event.tool)) && /成功|完美/.test(String(event.summary))) {
        speak({ text: '钓到啦！本鱼的手感是天赋！', scene: 'normal' });
      }
    }
    if (event.type === 'state' && typeof (event as { clock?: string }).clock === 'string') {
      lastGameClock = (event as { clock?: string }).clock ?? lastGameClock;
    }
    if (event.type === 'receipt' && event.tool !== 'autodrive') {
      // T-M5-04：回执自动入记忆图谱（换日自动写日记）
      try {
        memoryHost?.onReceipt({
          summary: String(event.summary ?? '').slice(0, 120),
          tool: String(event.tool ?? ''),
          status: String(event.status ?? ''),
          gameClock: String((event as { clock?: string }).clock ?? lastGameClock),
        });
      } catch {
        /* 记忆失败不影响主链路 */
      }
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
  ipcMain.handle('autodrive:status', () => ({ running: runner.isRunning(), events: [...eventHistory] }));

  // 默认 LLM 大脑（用户指令 2026-11-22）：DeepSeek key 就绪即启用；未就绪自动回落规则日程
  if (llmPlanner) {
    (runner as unknown as { planner: unknown }).planner = llmPlanner;
  } else {
    brainMode = 'rule';
  }

  return {
    runner,
    setTargets(targets) {
      windows.length = 0;
      windows.push(...targets);
    },
    say,
    subscribe(listener) {
      // 订阅即回放环形缓冲尾部（WebUI 晚连也能看到当前对话上下文）
      for (const event of eventHistory.slice(-100)) listener(event);
      busListeners.add(listener);
      return () => {
        busListeners.delete(listener);
      };
    },
    getBrainMode() {
      return { mode: brainMode, llmReady: llmPlanner !== null };
    },
  };
}
