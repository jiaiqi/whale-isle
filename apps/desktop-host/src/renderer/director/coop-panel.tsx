/**
 * 多桌宠联机协作大厅（T-M6-39）。
 *
 * 视觉对齐 design/coop.html 三栏：目标 / 小队+群聊 / 黑板护栏。
 * 所有状态来自主进程真实 IPC：端点、窗口、TeamBlackboard、群聊消息与全局 speaker；
 * 未连接、未接管、无目标一律如实显示，不用原型示例数据冒充运行状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2, ChevronDown, ChevronUp, Flag, LifeBuoy, LockKeyhole, MessageSquare, Monitor, Pencil, Play, Plus, Radio, RefreshCw, Rocket,
  Send, ShieldCheck, Square, Trash2, UserPlus, Users, X,
} from 'lucide-react';
import type {
  McpEndpoint,
  PetWindowView,
  TeamAssignment,
  TeamBlackboardSnapshot,
  TeamCommsMessage,
  TeamGoal,
} from '@workbench/shared-protocol';
import { CharacterPackStore } from './character-pack-store';
import {
  GAME_OPTIONS,
  type CharacterSummary,
  type CoopEndpointView,
  type GameId,
  type LaunchStatusView,
} from './bridge';

const GAME_LABEL: Record<GameId, string> = {
  stardew: '星露谷物语',
  terraria: '泰拉瑞亚',
  dst: '饥荒 DST',
};

const DEFAULT_ENDPOINT: Record<GameId, string> = {
  stardew: 'http://127.0.0.1:18080/mcp',
  terraria: 'http://127.0.0.1:18090',
  dst: 'http://127.0.0.1:18100',
};

const KIND_LABEL: Record<TeamCommsMessage['kind'], string> = {
  chat: '群聊',
  proposal: '开麦商量',
  plan_commit: '分工写入',
  need_help: '队友求助',
  handoff: '求助接力',
  directive: 'P0 指挥',
};

const ASSIGNMENT_LABEL: Record<TeamAssignment['status'], string> = {
  working: '执行中',
  idle: '待命',
  need_help: '求助中',
  offline: '离线',
};

const FALLBACK_GOAL: TeamGoal = {
  id: 'team-goal',
  title: '尚未设定共同目标',
  gameId: 'stardew',
  metrics: [],
  deadline: '',
  status: 'paused',
};

const FALLBACK_SNAPSHOT: TeamBlackboardSnapshot = {
  goal: FALLBACK_GOAL,
  assignments: [],
  zoneLocks: [],
  huddleState: { active: false, round: 0, maxRounds: 3, cooldownUntil: 0 },
  version: 0,
};

interface MemberView {
  agentId: string;
  name: string;
  role: 'human' | 'ai';
  endpoint?: CoopEndpointView;
  assignment?: TeamAssignment;
  window?: PetWindowView;
}

function mergeMessages(previous: TeamCommsMessage[], incoming: TeamCommsMessage[]): TeamCommsMessage[] {
  const byId = new Map<string, TeamCommsMessage>();
  for (const message of [...previous, ...incoming]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-100);
}

function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function cooldownText(until: number): string {
  const left = Math.max(0, until - Date.now());
  if (left <= 0) return '可立即自动协商';
  const minutes = Math.ceil(left / 60_000);
  return `${minutes} 分钟后可自动重议`;
}

export function CoopPanel(): React.JSX.Element {
  const [endpoints, setEndpoints] = useState<CoopEndpointView[]>([]);
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [snapshot, setSnapshot] = useState<TeamBlackboardSnapshot>(FALLBACK_SNAPSHOT);
  const [messages, setMessages] = useState<TeamCommsMessage[]>([]);
  const [windows, setWindows] = useState<PetWindowView[]>([]);
  const [speaker, setSpeaker] = useState<{ activeAgentId: string | null; state: 'speaking' | 'idle' }>({ activeAgentId: null, state: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [composing, setComposing] = useState(false);
  const [huddleBusy, setHuddleBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [launchStatus, setLaunchStatus] = useState<LaunchStatusView[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [goalTargets, setGoalTargets] = useState({ gold: '', wood: '' });
  const [addForm, setAddForm] = useState({
    displayName: '新队友',
    characterId: '',
    gameId: 'stardew' as GameId,
    endpoint: DEFAULT_ENDPOINT.stardew,
    routingId: '',
  });
  const chatRef = useRef<HTMLDivElement>(null);
  const addNameRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [endpointResult, boardResult, windowResult] = await Promise.all([
      window.directorBridge.coopEndpoints().catch(() => [] as CoopEndpointView[]),
      window.directorBridge.coopBlackboardGet().catch(() => null),
      window.directorBridge.petWindowList().catch(() => [] as PetWindowView[]),
    ]);
    setEndpoints(endpointResult);
    setWindows(windowResult);
    setLaunchStatus(await window.directorBridge.coopLaunchStatus().catch(() => []));
    if (boardResult !== null) {
      setSnapshot(boardResult.snapshot);
      setMessages((previous) => mergeMessages(previous, boardResult.messages));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void window.directorBridge.characterList().then((list) => {
      setCharacters(list);
      setAddForm((previous) => ({ ...previous, characterId: previous.characterId || list[0]?.id || '' }));
    }).catch(() => undefined);
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const unsubscribeBoard = window.directorBridge.onCoopBlackboardUpdate((payload) => {
      setSnapshot(payload.snapshot);
      setMessages((previous) => mergeMessages(previous, payload.messages));
    });
    const unsubscribeMessage = window.directorBridge.onCoopCommsMessage((message) => {
      setMessages((previous) => mergeMessages(previous, [message]));
    });
    const unsubscribeSpeaker = window.directorBridge.onCoopSpeaker((event) => {
      setSpeaker({ activeAgentId: event.activeAgentId, state: event.state });
    });
    const unsubscribeWindows = window.directorBridge.onPetWindowListChanged((list) => setWindows(list));
    return () => {
      unsubscribeBoard();
      unsubscribeMessage();
      unsubscribeSpeaker();
      unsubscribeWindows();
    };
  }, []);

  useEffect(() => {
    const node = chatRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!addOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAddOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => addNameRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
    };
  }, [addOpen]);

  const members = useMemo<MemberView[]>(() => [
    {
      agentId: 'human',
      name: '主人',
      role: 'human',
      assignment: snapshot.assignments.find((item) => item.agentId === 'human'),
    },
    ...endpoints.map((endpoint) => ({
      agentId: endpoint.id,
      name: endpoint.characterName || endpoint.displayName,
      role: 'ai' as const,
      endpoint,
      assignment: snapshot.assignments.find((item) => item.agentId === endpoint.id),
      window: windows.find((item) => item.agentId === endpoint.id),
    })),
  ], [endpoints, snapshot.assignments, windows]);

  const onlineCount = endpoints.filter((endpoint) => endpoint.running).length;
  const goal = snapshot.goal ?? FALLBACK_GOAL;
  const huddle = snapshot.huddleState;
  const goalPaused = goal.status === 'paused' || goal.title.includes('尚未') || goal.title.includes('等待主人');

  const toggleRunner = async (endpoint: CoopEndpointView): Promise<void> => {
    setBusy(`run:${endpoint.id}`);
    try {
      if (endpoint.running) {
        await window.directorBridge.coopStop(endpoint.id);
        toast(`${endpoint.displayName} 已停止`);
      } else {
        const result = await window.directorBridge.coopStart(endpoint.id);
        if (!result.ok) toast.error(result.error ?? '接管失败');
        else toast(`${endpoint.displayName} 已接管`);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const toggleWindow = async (endpoint: CoopEndpointView): Promise<void> => {
    const open = windows.some((item) => item.agentId === endpoint.id);
    setBusy(`win:${endpoint.id}`);
    try {
      if (open) {
        await window.directorBridge.petWindowClose(endpoint.id);
      } else {
        const result = await window.directorBridge.petWindowOpen(endpoint.id, endpoint.characterId);
        if (!result.ok) toast.error(result.error ?? '桌宠窗打开失败');
      }
      setWindows(await window.directorBridge.petWindowList());
    } finally {
      setBusy(null);
    }
  };

  const submitGoal = async (): Promise<void> => {
    const title = goalDraft.trim();
    if (title === '') {
      toast.error('请填写共同目标');
      return;
    }
    setHuddleBusy(true);
    try {
      const goldTarget = Number(goalTargets.gold);
      const woodTarget = Number(goalTargets.wood);
      const metrics = [...goal.metrics];
      const upsertMetric = (source: 'team_money' | 'shared_wood', label: string, unit: string, target: number, fallbackLabel: string): void => {
        const index = metrics.findIndex((metric) => metric.source === source);
        if (target <= 0) {
          if (index >= 0) metrics.splice(index, 1);
          return;
        }
        const next = { label: label || fallbackLabel, current: metrics[index]?.current ?? 0, target, unit, source };
        if (index >= 0) metrics[index] = next;
        else metrics.push(next);
      };
      upsertMetric('team_money', '团队金币', 'g', goldTarget, '团队金币');
      upsertMetric('shared_wood', '公共木材', '', woodTarget, '公共木材');
      const saved = await window.directorBridge.coopGoalSet({
        ...goal,
        title,
        gameId: endpoints[0]?.gameId ?? goal.gameId,
        metrics,
        status: 'active',
      });
      if (!saved.ok) {
        toast.error(saved.error ?? '目标保存失败');
        return;
      }
      const result = await window.directorBridge.coopHuddleStart({ reason: '主人设定共同目标并要求重新分工', goalTitle: title });
      if (!result.ok) toast.error(result.error ?? '协商未能启动');
      else if (result.fallback === true) toast.warning('目标已保存；协商降级为本地规则分工');
      else toast.success(`目标已保存，协商完成 ${result.rounds ?? 0} 轮`);
      setGoalEditing(false);
      await refresh();
    } finally {
      setHuddleBusy(false);
    }
  };

  const startHuddle = async (goalTitle?: string): Promise<void> => {
    setHuddleBusy(true);
    try {
      const result = await window.directorBridge.coopHuddleStart({
        reason: goalTitle === undefined ? '主人点击发起协商' : '主人设定目标并要求重新分工',
        ...(goalTitle === undefined || goalTitle.trim() === '' ? {} : { goalTitle: goalTitle.trim() }),
      });
      if (!result.ok) toast.error(result.error ?? '协商未能启动');
      else if (result.fallback === true) toast.warning('协商已降级为本地规则分工（预算或 LLM 不可用）');
      else toast.success(`协商完成，共 ${result.rounds ?? 0} 轮`);
      setGoalEditing(false);
      await refresh();
    } finally {
      setHuddleBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text === '') return;
    const sent = await window.directorBridge.coopChatSend({ text });
    if (!sent.ok) toast.error(sent.error ?? '发送失败');
    setInput('');
    await refresh();
  };

  const nextEndpoint = (gameId: GameId): string => {
    const base = gameId === 'stardew' ? 18080 : gameId === 'terraria' ? 18090 : 18100;
    const used = endpoints.filter((endpoint) => endpoint.gameId === gameId)
      .map((endpoint) => Number(new URL(endpoint.endpoint).port || base))
      .filter((port) => Number.isFinite(port));
    let port = base;
    while (gameId === 'dst' ? false : used.includes(port)) port++;
    if (gameId === 'dst') return DEFAULT_ENDPOINT.dst;
    return gameId === 'stardew' ? `http://127.0.0.1:${port}/mcp` : `http://127.0.0.1:${port}`;
  };

  const launch = async (kind: 'human' | 'ai'): Promise<void> => {
    setBusy(`launch:${kind}`);
    try {
      const game = goal.gameId;
      if (kind === 'human') {
        const result = await window.directorBridge.coopLaunchHuman(game);
        if (!result.ok) toast.error(result.error ?? '启动失败'); else toast.success(`真人实例已启动（PID ${result.pid ?? '—'}）`);
      } else {
        const candidate = endpoints.find((endpoint) => endpoint.gameId === game && !endpoint.running) ?? endpoints.find((endpoint) => endpoint.gameId === game);
        if (candidate === undefined) { toast.error('请先添加对应游戏的 AI 队友'); return; }
        const result = await window.directorBridge.coopLaunchAi(candidate.id);
        if (!result.ok) toast.error(result.error ?? 'AI 实例启动失败');
        else toast.success(`AI 实例已启动（端口 ${result.port ?? '—'}，PID ${result.pid ?? '—'}）`);
      }
      await refresh();
    } finally { setBusy(null); }
  };

  const openAdd = (): void => {
    setEditingId(null);
    setAddForm((previous) => ({
      ...previous,
      displayName: '新队友',
      characterId: previous.characterId || characters[0]?.id || '',
      endpoint: nextEndpoint(previous.gameId),
      routingId: '',
    }));
    setAddOpen(true);
  };

  const openEdit = (endpoint: CoopEndpointView): void => {
    setEditingId(endpoint.id);
    setAddForm({
      displayName: endpoint.displayName,
      characterId: endpoint.characterId,
      gameId: endpoint.gameId,
      endpoint: endpoint.endpoint,
      routingId: endpoint.routingId,
    });
    setAddOpen(true);
  };

  const askHelp = async (endpoint: CoopEndpointView): Promise<void> => {
    setBusy(`help:${endpoint.id}`);
    try {
      const member = members.find((item) => item.agentId === endpoint.id);
      const reason = `主人观察到 ${member?.name ?? endpoint.displayName} 当前任务受阻${member?.assignment?.zone ? `（${member.assignment.zone}）` : ''}，请队友评估是否接手救援`;
      const result = await window.directorBridge.coopHelpRequest({ agentId: endpoint.id, reason });
      if (!result.ok) toast.error(result.error ?? '求助未发出');
      else if (result.mode === 'handoff') toast.success(`已由 ${result.helperAgentId ?? '队友'} 接手；仍需真实回执确认恢复`);
      else toast.warning(result.fallback === true ? '已发起求助并降级本地分工' : '求助已提交，等待队友响应');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const removeEndpoint = async (endpoint: CoopEndpointView): Promise<void> => {
    if (endpoint.running) {
      toast.error('请先停止该队友，再移除端点');
      return;
    }
    if (!window.confirm(`从端点表移除「${endpoint.displayName}」？这不会删除角色包或游戏存档。`)) return;
    const next = endpoints
      .filter((item) => item.id !== endpoint.id)
      .map(({ id, displayName, gameId, endpoint: bridge, characterId, routingId, enabled }) => ({ id, displayName, gameId, endpoint: bridge, characterId, routingId, enabled }));
    const saved = await window.directorBridge.coopEndpointsSave(next);
    if (!saved.ok) toast.error(saved.error ?? '移除失败');
    else {
      if (windows.some((item) => item.agentId === endpoint.id)) await window.directorBridge.petWindowClose(endpoint.id);
      toast.success(`已移除「${endpoint.displayName}」`);
    }
    await refresh();
  };

  const saveEndpoint = async (): Promise<void> => {
    const displayName = addForm.displayName.trim();
    if (displayName === '') {
      toast.error('请填写队友名称');
      return;
    }
    if (addForm.gameId === 'dst' && addForm.routingId.trim() === '') {
      toast.error('DST 必须填写逻辑玩家 ID（Klei UserID）');
      return;
    }
    const base = `agent-${Date.now().toString(36)}`;
    let agentId = editingId ?? base;
    let suffix = 1;
    while (!editingId && endpoints.some((endpoint) => endpoint.id === agentId)) agentId = `${base}-${suffix++}`;
    const draft: McpEndpoint = {
      id: agentId,
      displayName,
      gameId: addForm.gameId,
      endpoint: addForm.endpoint.trim(),
      characterId: addForm.characterId || characters[0]?.id || 'blue-whale-maid',
      routingId: addForm.routingId.trim(),
      enabled: true,
    };
    const next: McpEndpoint[] = editingId === null
      ? [...endpoints.map(({ id, displayName: name, gameId, endpoint, characterId, routingId, enabled }) => ({ id, displayName: name, gameId, endpoint, characterId, routingId, enabled })), draft]
      : endpoints.map(({ id, displayName: name, gameId, endpoint, characterId, routingId, enabled }) => id === editingId
        ? draft
        : { id, displayName: name, gameId, endpoint, characterId, routingId, enabled });
    const saved = await window.directorBridge.coopEndpointsSave(next);
    if (!saved.ok) {
      toast.error(saved.error ?? '端点保存失败');
      return;
    }
    setAddOpen(false);
    setEditingId(null);
    toast.success(`「${displayName}」已${editingId === null ? '加入' : '更新'}端点表，接管后显示桌宠`);
    await refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-coop-page data-coop-version={snapshot.version}>
      {/* 共同目标 */}
      <header className="shrink-0 px-5 py-3" style={{ borderBottom: '1px solid var(--stroke)', background: 'color-mix(in srgb, var(--bg-elev) 44%, transparent)' }}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[260px] flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold" style={{ color: 'var(--text-1)' }}>
              <Flag size={14} style={{ color: 'var(--blue)' }} />
              {goalEditing ? (
                <form
                  className="flex flex-1 flex-wrap items-center gap-2"
                  onSubmit={(event) => { event.preventDefault(); void submitGoal(); }}
                >
                  <input
                    value={goalDraft}
                    onChange={(event) => setGoalDraft(event.target.value)}
                    aria-label="共同目标"
                    placeholder="例如：今天凑齐 4000g 与 300 木材建鸡舍"
                    className="min-w-[260px] flex-1 px-3 py-1.5 text-[12.5px] outline-none"
                    style={{ borderRadius: 999, border: '1px solid var(--blue-line)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>
                    <label className="flex items-center gap-1">金币目标
                      <input type="number" min={0} value={goalTargets.gold} onChange={(event) => setGoalTargets({ ...goalTargets, gold: event.target.value })} placeholder="4000" className="mono w-[74px] px-2 py-1 text-[11px] outline-none" style={{ borderRadius: 999, border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-1)' }} />
                    </label>
                    <label className="flex items-center gap-1">木材目标
                      <input type="number" min={0} value={goalTargets.wood} onChange={(event) => setGoalTargets({ ...goalTargets, wood: event.target.value })} placeholder="300" className="mono w-[68px] px-2 py-1 text-[11px] outline-none" style={{ borderRadius: 999, border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-1)' }} />
                    </label>
                  </div>
                  <button type="submit" className="btn-pill primary" disabled={huddleBusy}>
                    <Radio size={11} />设定并协商
                  </button>
                  <button type="button" className="btn-pill ghost" onClick={() => setGoalEditing(false)}>取消</button>
                </form>
              ) : (
                <>
                  <span>共同目标：{goal.title}</span>
                  <span className="pill" style={{ fontSize: 10 }}>{GAME_LABEL[goal.gameId]} · {onlineCount} AI 在线</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="编辑共同目标"
                    onClick={() => {
                      setGoalDraft(goalPaused ? '' : goal.title);
                      setGoalTargets({
                        gold: String(goal.metrics.find((metric) => metric.source === 'team_money')?.target ?? ''),
                        wood: String(goal.metrics.find((metric) => metric.source === 'shared_wood')?.target ?? ''),
                      });
                      setGoalEditing(true);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                </>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-4">
              {goal.metrics.length === 0 && (
                <span className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>还没有可量化进度；设定目标后由真实游戏状态更新。</span>
              )}
              {goal.metrics.map((metric, index) => {
                const ratio = metric.target === 0 ? 0 : Math.min(1, Math.max(0, metric.current / metric.target));
                const color = index % 2 === 0 ? 'var(--amber)' : 'var(--green)';
                return (
                  <div key={`${metric.label}-${index}`} className="min-w-[170px] max-w-[240px] flex-1">
                    <div className="mb-1 flex justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
                      <span>{metric.label}</span>
                      <b className="mono" style={{ color: 'var(--text-1)' }}>{metric.current.toLocaleString()} / {metric.target.toLocaleString()}{metric.unit}</b>
                    </div>
                    <div className="h-[5px] overflow-hidden rounded-full" style={{ background: 'var(--inset)' }}>
                      <i className="block h-full rounded-full transition-[width]" style={{ width: `${Math.round(ratio * 100)}%`, background: color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-pill violet" disabled={huddleBusy || huddle.active} onClick={() => void startHuddle()}>
              {huddleBusy || huddle.active ? <RefreshCw size={11} className="animate-spin" /> : <Radio size={11} />}
              {huddle.active ? `协商中 · 第 ${huddle.round || 1} 轮` : '发起开麦商量'}
            </button>
            <CharacterPackStore onImported={() => { void window.directorBridge.characterList().then(setCharacters).catch(() => undefined); void refresh(); }} />
            <button type="button" className="btn-pill primary" onClick={openAdd}>
              <UserPlus size={11} />添加 AI 队友
            </button>
          </div>
        </div>
      </header>

      <section className="shrink-0 px-5 py-2" style={{ borderBottom: '1px solid var(--stroke)' }}>
        <button type="button" data-coop-launch-wizard className="flex w-full items-center gap-2 text-left text-[11.5px]" style={{ color: 'var(--text-2)' }} onClick={() => setGuideOpen(!guideOpen)} aria-expanded={guideOpen}>
          <Rocket size={12} style={{ color: 'var(--blue)' }} />
          <b style={{ color: 'var(--text-1)' }}>联机一键启动向导</b>
          <span>{GAME_LABEL[goal.gameId]}</span>
          <span className={`pill ${onlineCount > 0 ? 'pill-green' : ''}`} style={{ fontSize: 9.5 }}>{onlineCount} AI 在线</span>
          <span className="ml-auto" style={{ color: 'var(--text-3)' }}>{guideOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
        </button>
        {guideOpen && (
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
            {(goal.gameId === 'stardew' ? [
              { text: '启动真人主机（SMAPI）', action: () => void launch('human') },
              { text: '为 AI 生成隔离 Mods 并拉起实例', action: () => void launch('ai') },
              { text: '游戏内输入 127.0.0.1 加入联机', action: null },
            ] : goal.gameId === 'terraria' ? [
              { text: '启动 tModLoaderServer:7777（路径确认后启用）', action: null },
              { text: '按队友分配 18090/18091 AI 端口', action: null },
              { text: '进入服务器验证桥接在线', action: null },
            ] : [
              { text: '配置 cluster_token（Klei 账号生成）', action: null },
              { text: '勾选托管角色 Klei UserID', action: null },
              { text: '启动专用服与 sidecar :18100', action: null },
            ]).map((step, index) => (
              <div key={step.text} className="flex items-center gap-2 rounded-lg px-3 py-2 text-[11px]" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }}>
                <span className="grid h-5 w-5 place-items-center rounded-full text-[10px]" style={{ background: 'var(--blue-dim)', color: 'var(--blue)' }}>{index + 1}</span>
                <span className="flex-1" style={{ color: 'var(--text-2)' }}>{step.text}</span>
                {step.action !== null ? <button type="button" className="btn-pill ghost" style={{ fontSize: 10 }} disabled={busy !== null} onClick={step.action}>启动</button> : <CheckCircle2 size={12} style={{ color: 'var(--text-3)' }} />}
              </div>
            ))}
            <div className="md:col-span-3 text-[10px]" style={{ color: 'var(--text-3)' }}>
              {launchStatus.find((item) => item.gameId === goal.gameId)?.detail ?? '正在探测本机路径…'}
            </div>
          </div>
        )}
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[270px_minmax(0,1fr)_292px] xl:overflow-hidden">
        {/* 小队成员 */}
        <aside className="min-h-0 overflow-y-auto p-3.5" style={{ borderRight: '1px solid var(--stroke)', background: 'color-mix(in srgb, var(--bg-elev) 24%, transparent)' }}>
          <div className="mb-2 flex items-center justify-between text-[10.5px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-3)' }}>
            <span className="flex items-center gap-1.5"><Users size={12} />小队成员</span>
            <span className="mono">{members.length} 人 · {onlineCount} AI 在线</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {members.map((member) => {
              const assignment = member.assignment;
              const status = assignment?.status ?? (member.role === 'human' ? 'idle' : 'offline');
              const speaking = speaker.state === 'speaking' && speaker.activeAgentId === member.agentId;
              const running = member.role === 'human' || member.endpoint?.running === true;
              return (
                <article
                  key={member.agentId}
                  data-coop-member={member.agentId}
                  className="card px-3 py-2.5"
                  style={speaking ? { borderColor: 'var(--blue-line)', boxShadow: 'var(--glow-blue), inset 0 1px 0 var(--hi)' } : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[12px] font-bold"
                      style={{
                        color: member.role === 'human' ? 'var(--green)' : 'var(--blue)',
                        background: member.role === 'human' ? 'var(--green-dim)' : 'var(--blue-dim)',
                        border: `1px solid ${member.role === 'human' ? 'var(--green-line)' : 'var(--blue-line)'}`,
                      }}
                    >{member.name.slice(0, 1)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold" style={{ color: 'var(--text-1)' }}>
                        <span className="truncate">{member.name}</span>
                        <span className={`pill ${speaking ? 'pill-blue' : status === 'need_help' ? 'pill-amber' : status === 'working' ? 'pill-green' : ''}`} style={{ fontSize: 9.5 }}>
                          {speaking ? '正在说话' : member.role === 'human' ? '真人房主' : !running ? '未接管' : ASSIGNMENT_LABEL[status]}
                        </span>
                      </div>
                      <div className="mono mt-0.5 truncate text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                        {member.role === 'human' ? '键鼠操作 · AI 自动避让' : `${member.endpoint?.endpoint ?? ''} · ${member.endpoint?.characterName ?? ''}${member.endpoint?.gameId === 'dst' ? ` · 玩家 ${member.endpoint.routingId || '未配置'}` : ''}`}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 rounded-lg px-2.5 py-1.5 text-[11.5px]" style={{ color: 'var(--text-2)', background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
                    {assignment?.task || (member.role === 'human' ? '自由探索；进入 AI 区域前先协调' : '等待接管')}
                    {assignment?.zone ? <span style={{ color: 'var(--text-3)' }}> · {assignment.zone}</span> : null}
                  </div>
                  {member.endpoint?.error ? (
                    <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--amber)' }}>{member.endpoint.error}</div>
                  ) : null}
                  {member.role === 'ai' && member.endpoint ? (
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        className="btn-pill ghost mr-auto"
                        style={{ fontSize: 10 }}
                        disabled={busy !== null}
                        onClick={() => void toggleRunner(member.endpoint!)}
                      >
                        {member.endpoint.running ? <><Square size={10} />停止</> : <><Play size={10} />接管</>}
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={member.window !== undefined}
                        aria-label={`${member.name} 桌面桌宠窗`}
                        title="仅控制桌宠窗显示，不启停游戏自治"
                        className="inline-flex h-[22px] w-[38px] items-center rounded-full p-[2px] transition-colors"
                        style={{ background: member.window !== undefined ? 'var(--green)' : 'var(--stroke-2)' }}
                        disabled={busy !== null}
                        onClick={() => void toggleWindow(member.endpoint!)}
                      >
                        <span
                          className="h-[18px] w-[18px] rounded-full bg-white transition-transform"
                          style={{ transform: member.window !== undefined ? 'translateX(16px)' : 'translateX(0)' }}
                        />
                      </button>
                      <Monitor size={11} style={{ color: 'var(--text-3)' }} />
                      {member.endpoint.running && (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`为 ${member.name} 发起求助`}
                          title="请求另一名空闲队友接手"
                          disabled={busy !== null}
                          onClick={() => void askHelp(member.endpoint!)}
                        ><LifeBuoy size={11} /></button>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`编辑 ${member.name}`}
                        title={member.endpoint.running ? '请先停止再编辑' : '编辑端点'}
                        disabled={member.endpoint.running}
                        onClick={() => openEdit(member.endpoint!)}
                      ><Pencil size={11} /></button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`移除 ${member.name}`}
                        title={member.endpoint.running ? '请先停止再移除' : '移除端点'}
                        disabled={member.endpoint.running}
                        onClick={() => void removeEndpoint(member.endpoint!)}
                      ><Trash2 size={11} /></button>
                    </div>
                  ) : null}
                </article>
              );
            })}
            {endpoints.length === 0 && (
              <div className="card px-3 py-4 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                尚未登记 AI 队友。点击右上角「添加 AI 队友」配置桥接地址。
              </div>
            )}
          </div>
          <div className="card mt-3 p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-1)' }}>
              <Monitor size={12} style={{ color: 'var(--blue)' }} />桌面多开说明
            </h4>
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
              每只桌宠绑定一个 agentId 与独立桥接端点。星露谷/泰拉瑞亚每个游戏实例各占一个端口；DST 共用 :18100 时仍需游戏侧按玩家路由。
            </p>
          </div>
        </aside>

        {/* 群聊与协商 */}
        <section className="flex min-h-[420px] min-w-0 flex-col xl:min-h-0">
          <div ref={chatRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-4">
            <div className="flex flex-col gap-3.5">
              {messages.length === 0 && (
                <div className="card px-4 py-6 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>
                  还没有队内消息。先接管 AI 队友，再设定目标或 @ 点名。
                </div>
              )}
              {messages.map((message) => {
                const isMe = message.fromRole === 'human';
                return (
                  <article key={message.id} data-coop-message={message.kind} className={`max-w-[680px] ${isMe ? 'self-end' : ''}`} style={{ width: isMe ? '78%' : undefined }}>
                    <div className={`mb-1 flex items-center gap-1.5 text-[11.5px] ${isMe ? 'justify-end' : ''}`}>
                      {!isMe && <span className="grid h-[22px] w-[22px] place-items-center rounded-[7px] text-[10.5px] font-bold" style={{ background: 'var(--blue-dim)', color: 'var(--blue)', border: '1px solid var(--blue-line)' }}>{message.fromName.slice(0, 1)}</span>}
                      <b style={{ color: 'var(--text-1)' }}>{message.fromName}</b>
                      <span className={`pill ${message.kind === 'proposal' ? 'pill-violet' : message.kind === 'need_help' ? 'pill-amber' : message.kind === 'plan_commit' ? 'pill-green' : ''}`} style={{ fontSize: 9.5 }}>
                        {KIND_LABEL[message.kind]}
                      </span>
                      <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{shortTime(message.ts)}</span>
                    </div>
                    <div
                      className="rounded-2xl px-3.5 py-2.5 text-[12.5px] leading-[1.75]"
                      style={{
                        background: isMe ? 'linear-gradient(135deg, color-mix(in srgb, var(--blue) 20%, transparent), color-mix(in srgb, var(--blue) 10%, transparent))' : 'var(--surface)',
                        border: `1px solid ${message.kind === 'need_help' ? 'var(--amber-line)' : isMe ? 'var(--blue-line)' : 'var(--stroke)'}`,
                        color: 'var(--text-1)',
                      }}
                    >
                      {message.text}
                    </div>
                    {message.planCard !== undefined && (
                      <div className="mt-2 rounded-xl px-3 py-2.5 text-[11.5px]" style={{ border: '1px solid var(--green-line)', background: 'var(--green-dim)' }}>
                        <div className="mb-1.5 flex items-center gap-1.5 font-semibold" style={{ color: 'var(--green)' }}>
                          <ShieldCheck size={12} />{message.planCard.title}
                        </div>
                        {message.planCard.assignments.map((task) => (
                          <div key={task.agentId} className="flex justify-between gap-3 border-b border-dashed py-1 last:border-0" style={{ borderColor: 'var(--stroke)' }}>
                            <b>{task.displayName || task.agentId}</b>
                            <span className="text-right" style={{ color: 'var(--text-2)' }}>{task.task}{task.zone === '' ? '' : ` · ${task.zone}`}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
          <div className="shrink-0 px-4 pb-3.5 pt-2" style={{ borderTop: '1px solid var(--stroke)' }}>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>快速点名：</span>
              {endpoints.map((endpoint) => (
                <button
                  key={endpoint.id}
                  type="button"
                  className="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                  onClick={() => setInput((previous) => `@${endpoint.characterName || endpoint.displayName} ${previous}`)}
                >
                  @{endpoint.characterName || endpoint.displayName}
                </button>
              ))}
              <button
                type="button"
                className="rounded-full px-2.5 py-1 text-[11px]"
                style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                onClick={() => setInput((previous) => `@全队 ${previous}`)}
              >@全队（重议分工）</button>
            </div>
            <div className="flex gap-2">
              <input
                data-coop-input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !composing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder="输入 @角色 单人指挥，或 @全队 重新分工…"
                className="min-w-0 flex-1 px-3.5 py-2 text-[12.5px] outline-none"
                style={{ borderRadius: 999, border: '1px solid var(--stroke-2)', background: 'var(--surface)', color: 'var(--text-1)' }}
              />
              <button type="button" data-coop-send className="btn-pill primary px-4" onClick={() => void send()} disabled={input.trim() === ''}>
                <Send size={11} />发送
              </button>
            </div>
          </div>
        </section>

        {/* 黑板与护栏 */}
        <aside className="min-h-0 overflow-y-auto p-3.5" style={{ borderLeft: '1px solid var(--stroke)', background: 'color-mix(in srgb, var(--bg-elev) 24%, transparent)' }}>
          <section className="card mb-2.5 p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-1)' }}>
              <MessageSquare size={12} style={{ color: 'var(--blue)' }} />分工认领表
            </h4>
            {snapshot.assignments.length === 0 && <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>尚未写入分工。</p>}
            {snapshot.assignments.map((assignment) => (
              <div key={assignment.agentId} className="border-b border-dashed py-1.5 last:border-0" style={{ borderColor: 'var(--stroke)' }}>
                <div className="flex items-center justify-between gap-2">
                  <b className="text-[11.5px]" style={{ color: 'var(--text-1)' }}>{assignment.displayName}</b>
                  <span className={`pill ${assignment.status === 'need_help' ? 'pill-amber' : assignment.status === 'working' ? 'pill-green' : ''}`} style={{ fontSize: 9.5 }}>{ASSIGNMENT_LABEL[assignment.status]}</span>
                </div>
                <div className="mt-0.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>{assignment.task || '—'}</div>
                {assignment.zone !== '' && <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-3)' }}>区域 · {assignment.zone}</div>}
                {assignment.progressNote !== '' && <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-3)' }}>{assignment.progressNote}</div>}
              </div>
            ))}
          </section>

          <section className="card mb-2.5 p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-1)' }}>
              <LockKeyhole size={12} style={{ color: 'var(--amber)' }} />区域软互斥锁
            </h4>
            {snapshot.zoneLocks.length === 0 && <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>暂无区域锁；协商分工后自动申请。</p>}
            {snapshot.zoneLocks.map((lock) => (
              <div key={lock.zone} className="flex items-center justify-between gap-2 border-b border-dashed py-1.5 text-[11px] last:border-0" style={{ borderColor: 'var(--stroke)' }}>
                <span style={{ color: 'var(--text-2)' }}>{lock.zone}</span>
                <b className="mono" style={{ color: 'var(--text-1)' }}>{lock.ownerAgentId}</b>
              </div>
            ))}
          </section>

          <section className="card p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-1)' }}>
              <ShieldCheck size={12} style={{ color: 'var(--green)' }} />协商与防烧钱护栏
            </h4>
            <div className="flex justify-between py-1 text-[11px]" style={{ color: 'var(--text-2)' }}><span>协商轮次上限</span><b className="mono" style={{ color: 'var(--text-1)' }}>{huddle.maxRounds} 轮</b></div>
            <div className="flex justify-between py-1 text-[11px]" style={{ color: 'var(--text-2)' }}><span>当前状态</span><b style={{ color: huddle.active ? 'var(--violet)' : 'var(--text-1)' }}>{huddle.active ? `第 ${huddle.round} 轮` : '空闲'}</b></div>
            <div className="flex justify-between py-1 text-[11px]" style={{ color: 'var(--text-2)' }}><span>自动重议冷却</span><b className="mono" style={{ color: 'var(--text-1)', fontSize: 10 }}>{cooldownText(huddle.cooldownUntil)}</b></div>
            <div className="flex justify-between py-1 text-[11px]" style={{ color: 'var(--text-2)' }}><span>单场 Token 预算</span><b className="mono" style={{ color: 'var(--text-1)' }}>≤ 12,000</b></div>
            <div className="flex justify-between py-1 text-[11px]" style={{ color: 'var(--text-2)' }}><span>黑板注入</span><b className="mono" style={{ color: 'var(--text-1)' }}>≤ 300 字符</b></div>
            <div className="mt-2 rounded-lg px-2.5 py-2 text-[10.5px] leading-relaxed" style={{ background: 'var(--inset)', color: 'var(--text-3)' }}>
              AI 接单和口头确认不等于完成；只有游戏真实回执会推进分工状态。预算不足或 LLM 不可用时自动降级本地规则分工。
            </div>
          </section>
        </aside>
      </div>

      {addOpen && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,.52)', backdropFilter: 'blur(6px)' }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setAddOpen(false); }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="coop-add-title" className="card w-full max-w-[460px] p-5" style={{ boxShadow: 'var(--shadow-2)' }}>
            <div className="mb-4 flex items-center justify-between">
              <h3 id="coop-add-title" className="text-[15px] font-semibold">{editingId === null ? '添加 AI 联机队友' : '编辑 AI 联机队友'}</h3>
              <button type="button" className="icon-btn" aria-label="关闭添加队友" onClick={() => setAddOpen(false)}><X size={13} /></button>
            </div>
            <label className="mb-3 block text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <span className="mb-1 block font-semibold">队友名称</span>
              <input ref={addNameRef} value={addForm.displayName} onChange={(event) => setAddForm({ ...addForm, displayName: event.target.value })} className="w-full px-3 py-2 text-[12.5px] outline-none" style={{ borderRadius: 8, border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }} />
            </label>
            <label className="mb-3 block text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <span className="mb-1 block font-semibold">选择角色与声线</span>
              <select value={addForm.characterId} onChange={(event) => setAddForm({ ...addForm, characterId: event.target.value })} className="w-full px-3 py-2 text-[12.5px] outline-none" style={{ borderRadius: 8, border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}>
                {characters.map((character) => <option key={character.id} value={character.id}>{character.displayName} · {character.voiceId}</option>)}
                {characters.length === 0 && <option value="blue-whale-maid">小鲸（蓝鲸女仆）</option>}
              </select>
            </label>
            <label className="mb-3 block text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <span className="mb-1 block font-semibold">所属游戏</span>
              <select
                value={addForm.gameId}
                onChange={(event) => {
                  const gameId = event.target.value as GameId;
                  setAddForm({ ...addForm, gameId, endpoint: nextEndpoint(gameId), routingId: '' });
                }}
                className="w-full px-3 py-2 text-[12.5px] outline-none"
                style={{ borderRadius: 8, border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
              >
                {GAME_OPTIONS.map((game) => <option key={game.id} value={game.id}>{game.label}</option>)}
              </select>
            </label>
            <label className="mb-3 block text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <span className="mb-1 block font-semibold">逻辑玩家 ID {addForm.gameId === 'dst' ? '（DST 必填）' : '（可选）'}</span>
              <input
                value={addForm.routingId}
                onChange={(event) => setAddForm({ ...addForm, routingId: event.target.value })}
                placeholder={addForm.gameId === 'dst' ? 'Klei UserID；同一 sidecar 下按此区分 AI 角色' : '留空使用端点 id'}
                className="w-full px-3 py-2 font-mono text-[12px] outline-none"
                style={{ borderRadius: 8, border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
              />
            </label>
            <label className="mb-3 block text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <span className="mb-1 block font-semibold">桥接端口 / 端点</span>
              <input data-coop-endpoint-input value={addForm.endpoint} onChange={(event) => setAddForm({ ...addForm, endpoint: event.target.value })} className="w-full px-3 py-2 font-mono text-[12px] outline-none" style={{ borderRadius: 8, border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }} />
            </label>
            <p className="mb-4 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
              保存只登记端点，不会伪造「已连接」。点击队友卡片「接管」时再探活；独立桌宠窗可单独开关，不影响自治。
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-pill ghost" onClick={() => setAddOpen(false)}>取消</button>
              <button type="button" className="btn-pill primary" onClick={() => void saveEndpoint()}>
                <Plus size={11} />{editingId === null ? '加入端点表' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
