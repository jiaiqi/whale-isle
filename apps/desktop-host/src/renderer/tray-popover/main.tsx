/**
 * 鲸屿快捷浮窗（T-M6-60）：Magpie 风格 360×500 三段式 Popover。
 *
 * 所有卡片数据都来自真实 IPC（角色/桌宠窗/自驾/饭碗/工作跟随/语音/WebUI），
 * 未接线的能力如实显示空态或错误，不用假数据撑 UI。图标全部 lucide-react，零 emoji。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, AlertCircle, CheckCircle2, ChevronRight, Clock, Copy, DoorOpen, Egg, Eye, EyeOff,
  FlaskConical, Gamepad2, Gift, LayoutDashboard, LogOut, Moon, MoveRight, PawPrint, Play, Plus,
  RefreshCw, Route, Send, Square, Sun, Target, Users, Volume2, VolumeX, Wheat, XCircle,
} from 'lucide-react';
import { whaleMarkPaths } from '../../shared/brand';

type TabId = 'pets' | 'drive' | 'bowl';
type GameId = 'stardew' | 'terraria' | 'dst';

interface CharacterView {
  id: string;
  displayName: string;
  builtin: boolean;
  licenseScope: string;
  voiceId: string;
  packId?: string;
}

interface PetWindowView {
  agentId: string;
  characterId: string;
  visible: boolean;
  locked: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

interface AutodriveEventView {
  type: string;
  clock?: string;
  tool?: string;
  status?: string;
  summary?: string;
  intent?: string;
  objective?: string | null;
  reason?: string;
}

interface AutodriveStatusView {
  running: boolean;
  gameId?: GameId;
  sessionId?: string;
  generation?: number;
  events?: AutodriveEventView[];
}

interface CoopEndpointView {
  id: string;
  displayName: string;
  gameId: GameId;
  characterName: string;
  running: boolean;
  error: string | null;
}

interface RiceView {
  balance: number;
  budget: number;
  consumedToday: number;
  level: 'starving' | 'hungry' | 'ok' | 'full' | 'fed_buff';
}

interface WorkSessionView {
  source: string;
  sessionId: string;
  toolCalls: number;
  taskTitle: string;
  modelName: string;
  active: boolean;
}

interface WorkStatusView {
  mode: 'single' | 'multi';
  sessions: WorkSessionView[];
}

interface VoiceConfigView {
  enabled: boolean;
  innerVoice: boolean;
  volume: number;
  ratePercent: number;
  voice: string;
  pitchMul: number;
}

interface VoiceBackendView {
  backend: 'mcode' | 'say' | 'unsupported';
  detail: string;
}

interface GameHealthView {
  status: 'online' | 'reachable' | 'offline';
  detail: string;
  guidance: string[];
}

interface WebUiView {
  ok: boolean;
  port: number;
  token: string;
}

interface Message {
  kind: 'ok' | 'err';
  text: string;
}

const GAME_LABELS: Record<GameId, string> = {
  stardew: '星露谷物语',
  terraria: '泰拉瑞亚',
  dst: '饥荒 DST',
};

const RICE_LEVEL_LABELS: Record<RiceView['level'], string> = {
  starving: '饿瘪',
  hungry: '肚子叫',
  ok: '正常',
  full: '饱饱',
  fed_buff: '干饭加成',
};

const HEALTH_LABELS: Record<GameHealthView['status'], string> = {
  online: '桥接在线',
  reachable: '可达未就绪',
  offline: '离线',
};

const WORK_SOURCE_LABELS: Record<string, string> = {
  acp: 'ACP',
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  cursor: 'Cursor',
  qwen: '千问',
  kimi: 'Kimi',
  grok: 'Grok',
};

const TOOL_LABELS: Record<string, string> = {
  travel_to: '移动',
  fish: '钓鱼',
  water_crops: '浇水',
  ship_items: '出货',
  get_state: '状态',
  chat_order: '聊天指令',
  cancel_action: '停止动作',
  sleep: '睡觉',
  forage: '采集',
  clear_objective: '取消目标',
};

async function settle<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value));
}

function formatRelative(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function WhaleMark({ size = 18 }: { size?: number }): React.JSX.Element {
  const mark = whaleMarkPaths();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={mark.body} fill="currentColor" />
      <path d={mark.tail} fill="currentColor" />
      <path d={mark.band} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx={mark.eye.cx} cy={mark.eye.cy} r={mark.eye.r} fill="var(--bg)" />
      <circle cx={mark.glint.cx} cy={mark.glint.cy} r={mark.glint.r} fill="var(--text-2)" />
    </svg>
  );
}

function StatusIcon({ status }: { status?: string }): React.JSX.Element {
  if (status === 'COMPLETED') return <CheckCircle2 size={13} style={{ color: 'var(--green)', flex: 'none' }} />;
  if (status === 'UNCERTAIN') return <AlertCircle size={13} style={{ color: 'var(--amber)', flex: 'none' }} />;
  if (status === 'FAILED' || status === 'ERROR' || status === 'TIMEOUT') {
    return <XCircle size={13} style={{ color: 'var(--red)', flex: 'none' }} />;
  }
  return <Clock size={13} style={{ color: 'var(--text-3)', flex: 'none' }} />;
}

function App(): React.JSX.Element {
  const bridge = window.directorBridge;
  const [tab, setTab] = useState<TabId>('pets');
  const [characters, setCharacters] = useState<CharacterView[]>([]);
  const [activeCharacterId, setActiveCharacterId] = useState('');
  const [petWindows, setPetWindows] = useState<PetWindowView[]>([]);
  const [sleeping, setSleeping] = useState(false);
  const [drive, setDrive] = useState<AutodriveStatusView>({ running: false });
  const [objective, setObjective] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<AutodriveEventView[]>([]);
  const [coop, setCoop] = useState<CoopEndpointView[]>([]);
  const [health, setHealth] = useState<GameHealthView | null>(null);
  const [rice, setRice] = useState<RiceView | null>(null);
  const [peak, setPeak] = useState<{ period: 'peak' | 'off-peak'; minutesOfDay: number; nextSwitchInMinutes: number; family: boolean } | null>(null);
  const [work, setWork] = useState<WorkStatusView>({ mode: 'multi', sessions: [] });
  const [voice, setVoice] = useState<VoiceConfigView | null>(null);
  const [voiceBackend, setVoiceBackend] = useState<VoiceBackendView | null>(null);
  const [webui, setWebui] = useState<WebUiView | null>(null);
  const [updatedAt, setUpdatedAt] = useState(Date.now());
  const [nowTick, setNowTick] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [chatText, setChatText] = useState('');
  const [chatReply, setChatReply] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  const notify = useCallback((kind: Message['kind'], text: string) => {
    setMessage({ kind, text });
    if (messageTimer.current !== null) clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(null), 4200);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const [chars, prefs, windows, sleepState, status, objectiveState, endpoints, riceState, workState, voiceState, webuiState, backend, peakState] =
      await Promise.all([
        settle<CharacterView[]>(bridge.characterList(), []),
        settle<{ characterId?: string }>(bridge.prefsGet(), {}),
        settle<PetWindowView[]>(bridge.petWindowList(), []),
        settle<{ ok: boolean; asleep: boolean; count: number }>(bridge.petSleepStatus(), { ok: false, asleep: false, count: 0 }),
        settle<AutodriveStatusView>(bridge.autodriveStatus(), { running: false, events: [] }),
        settle<{ ok: boolean; objective: string | null }>(bridge.autodriveObjectiveStatus(), { ok: false, objective: null }),
        settle<CoopEndpointView[]>(bridge.coopEndpoints(), []),
        settle<RiceView | null>(bridge.riceStatus().then((value) => value as RiceView), null),
        settle<WorkStatusView>(bridge.workFollowStatus().then((value) => value as WorkStatusView), { mode: 'multi', sessions: [] }),
        settle<VoiceConfigView | null>(bridge.voiceConfigGet(), null),
        settle<WebUiView>(bridge.webuiInfo(), { ok: false, port: 0, token: '' }),
        settle<VoiceBackendView | null>(bridge.voiceBackend(), null),
        settle<{ period: 'peak' | 'off-peak'; minutesOfDay: number; nextSwitchInMinutes: number; family: boolean } | null>(bridge.peakStatus(), null),
      ]);
    setCharacters(chars);
    const selected = typeof prefs.characterId === 'string' ? prefs.characterId : '';
    setActiveCharacterId(selected === '' ? (chars[0]?.id ?? '') : selected);
    setPetWindows(windows);
    setSleeping(sleepState.asleep);
    setDrive(status);
    setObjective(objectiveState.objective);
    setCoop(endpoints);
    setRice(riceState);
    setPeak(peakState);
    setWork(workState);
    setVoice(voiceState);
    setWebui(webuiState);
    setVoiceBackend(backend);
    const recentReceipts = (status.events ?? [])
      .filter((event) => event.type === 'receipt' && typeof event.summary === 'string' && event.summary !== '')
      .slice(-3)
      .reverse();
    setReceipts(recentReceipts);
    const gameId = status.gameId ?? 'stardew';
    setHealth(await settle<GameHealthView | null>(bridge.gameHealth(gameId), null));
    setUpdatedAt(Date.now());
  }, [bridge]);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => { void refreshRef.current(); }, 15_000);
    const tick = setInterval(() => setNowTick(Date.now()), 15_000);
    const offWork = bridge.onWorkFollowUpdate((status) => setWork(status as WorkStatusView));
    const offWindows = bridge.onPetWindowListChanged((list) => setPetWindows(list));
    // onAutodriveEvent 没有退订句柄（preload 约定），浮窗进程生命周期与应用一致，直接消费。
    bridge.onAutodriveEvent((raw) => {
      const event = raw as AutodriveEventView;
      if (event.type === 'objective') setObjective(event.objective ?? null);
      if (event.type === 'receipt') {
        if (typeof event.summary === 'string' && event.summary !== '') {
          setReceipts((previous) => [event, ...previous].slice(0, 3));
        }
        if (event.tool === 'chat_order' && event.objective !== undefined) setObjective(event.objective);
      }
      if (event.type === 'state' || event.type === 'cycle-end') {
        setDrive((previous) => (previous.running ? previous : { ...previous, running: true }));
      }
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void bridge.hidePopover();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      offWork();
      offWindows();
      window.removeEventListener('keydown', onKey);
      if (messageTimer.current !== null) clearTimeout(messageTimer.current);
      if (volumeTimer.current !== null) clearTimeout(volumeTimer.current);
    };
  }, [bridge, refresh]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refreshRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const runAction = async (
    key: string,
    action: () => Promise<{ ok: boolean; error?: string }>,
    successText: string,
  ): Promise<boolean> => {
    setBusy(key);
    try {
      const result = await action();
      if (result.ok) notify('ok', successText);
      else notify('err', result.error ?? '操作失败');
      await refreshRef.current();
      return result.ok;
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const activeCharacter = characters.find((character) => character.id === activeCharacterId) ?? characters[0];
  const selectableCharacters = characters.filter((character) => !(character.packId ?? '').startsWith('crosspet-'));
  const bundledCharacters = selectableCharacters.filter((character) => character.packId !== undefined);
  const customCharacters = selectableCharacters.filter((character) => !character.builtin && character.packId === undefined);
  // 自定义角色置前 + 随包 9 角色；素材缺失时回退全部可选角色，确保创作中心新角色可见。
  const visibleCharacters = bundledCharacters.length > 0
    ? [...customCharacters, ...bundledCharacters.slice(0, 9)]
    : selectableCharacters;
  const anyVisible = petWindows.some((window) => window.visible);
  const activeGame: GameId = drive.gameId ?? 'stardew';
  const gameLabel = GAME_LABELS[activeGame];
  const runningCoop = coop.filter((endpoint) => endpoint.running);
  const activeSessions = work.sessions.filter((session) => session.active);
  const riceRatio = rice === null || rice.budget <= 0 ? 0 : Math.max(0, Math.min(1, rice.balance / rice.budget));
  const ringRadius = 47;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const riceColor = riceRatio < 0.15 ? 'var(--red)' : riceRatio < 0.35 ? 'var(--amber)' : 'var(--green)';
  const updatedLabel = formatRelative(updatedAt, nowTick);

  const selectCharacter = (id: string): void => {
    if (busy !== null || id === activeCharacterId) return;
    setActiveCharacterId(id);
    void runAction('character', () => bridge.characterSelect(id), '已切换主桌宠角色');
  };

  const sendChat = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const text = chatText.trim();
    if (text === '' || busy !== null) return;
    setBusy('chat');
    setChatReply(null);
    try {
      const result = await bridge.chatSay(text);
      if (result.ok) {
        setChatReply(result.reply ?? '已收到，我记下啦。');
        setChatText('');
        void refreshRef.current();
      } else {
        notify('err', result.error ?? '发送失败');
      }
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const toggleDrive = async (): Promise<void> => {
    if (busy !== null) return;
    if (drive.running) {
      setBusy('drive');
      try {
        await bridge.autodriveStop();
        notify('ok', '已停止自驾，控制权交还主人');
        await refreshRef.current();
      } catch (error) {
        notify('err', error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
      return;
    }
    await runAction('drive', () => bridge.autodriveStart(activeGame), `自驾已启动：${gameLabel}`);
  };

  const clearObjective = async (): Promise<void> => {
    setBusy('objective');
    try {
      const result = await bridge.autodriveClearObjective();
      if (result.ok) {
        setObjective(null);
        notify('ok', result.had === true ? '已取消当前多步目标' : '当前没有进行中的目标');
      } else {
        notify('err', '取消失败');
      }
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      await refreshRef.current();
    }
  };

  const feedRice = async (): Promise<void> => {
    setBusy('feed');
    try {
      const result = await bridge.riceFeed(10_000);
      if (result.ok) {
        setRice((previous) => (previous === null ? previous : { ...previous, balance: result.balance }));
        notify('ok', '加了一碗饭：+10,000 粒');
      } else {
        notify('err', '加饭失败');
      }
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      await refreshRef.current();
    }
  };

  const toggleVoice = async (): Promise<void> => {
    if (voice === null) return;
    setVoice({ ...voice, enabled: !voice.enabled });
    try {
      const result = await bridge.voiceConfigSet({ enabled: !voice.enabled });
      setVoice((previous) => (previous === null ? previous : { ...previous, enabled: result.enabled }));
    } catch (error) {
      setVoice((previous) => (previous === null ? previous : { ...previous, enabled: voice.enabled }));
      notify('err', error instanceof Error ? error.message : String(error));
    }
  };

  const changeVolume = (value: number): void => {
    setVoice((previous) => (previous === null ? previous : { ...previous, volume: value }));
    if (volumeTimer.current !== null) clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => {
      volumeTimer.current = null;
      void bridge.voiceConfigSet({ volume: value }).catch((error: unknown) => {
        notify('err', error instanceof Error ? error.message : String(error));
      });
    }, 120);
  };

  const copyWebui = async (): Promise<void> => {
    try {
      const info = webui?.ok === true ? webui : await bridge.webuiInfo();
      if (!info.ok || info.port <= 0) {
        notify('err', 'WebUI 尚未启动');
        return;
      }
      const url = `http://127.0.0.1:${info.port}/?token=${info.token}`;
      if (await bridge.copyText(url)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      } else {
        notify('err', '复制失败');
      }
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error));
    }
  };

  const statusPillClass = drive.running
    ? health !== null && health.status !== 'online' ? 'pill warn' : 'pill on'
    : 'pill';

  return (
    <div className="shell" data-popover-ready="1">
      <header className="top">
        <div className="logo" style={{ color: 'var(--text-1)' }}>
          <WhaleMark size={18} />
        </div>
        <div className="brand">
          <b>鲸屿</b>
          <span className={statusPillClass}>
            <span className="dot" />
            {drive.running ? `自驾中 · ${gameLabel}` : '待机'}
          </span>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className="icon-btn"
          title="刷新全部状态"
          aria-label="刷新全部状态"
          disabled={busy === 'refresh'}
          onClick={() => {
            setBusy('refresh');
            void refreshRef.current().finally(() => setBusy(null));
          }}
        >
          <RefreshCw size={13} className={busy === 'refresh' ? 'spin' : undefined} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="打开中控台"
          aria-label="打开中控台"
          onClick={() => { void bridge.openDirector(); }}
        >
          <LayoutDashboard size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="打开桌宠验收台"
          aria-label="打开桌宠验收台"
          onClick={() => { void bridge.openBench(); }}
        >
          <FlaskConical size={13} />
        </button>
      </header>

      <nav className="tabs" role="tablist" aria-label="快捷浮窗分区">
        <button type="button" role="tab" data-tab="pets" aria-selected={tab === 'pets'} className={`tab${tab === 'pets' ? ' on' : ''}`} onClick={() => setTab('pets')}>
          <PawPrint size={12} />桌宠
        </button>
        <button type="button" role="tab" data-tab="drive" aria-selected={tab === 'drive'} className={`tab${tab === 'drive' ? ' on' : ''}`} onClick={() => setTab('drive')}>
          <Gamepad2 size={12} />自驾
        </button>
        <button type="button" role="tab" data-tab="bowl" aria-selected={tab === 'bowl'} className={`tab${tab === 'bowl' ? ' on' : ''}`} onClick={() => setTab('bowl')}>
          <Wheat size={12} />饭碗
        </button>
      </nav>

      <main className="content">
        {message !== null && (
          <div className={message.kind === 'ok' ? 'ok-text' : 'error-text'} role="status">{message.text}</div>
        )}

        {tab === 'pets' && (
          <section data-panel="pets" style={{ display: 'contents' }}>
            <div className="card char-card">
              <div className="char-avatar" style={{ color: 'var(--blue)' }}>
                <WhaleMark size={25} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="char-name">{activeCharacter?.displayName ?? '未选择角色'}</div>
                <div className="char-meta">
                  {activeCharacter?.builtin === true ? '随包角色' : '本机角色'}
                  {activeCharacter !== undefined ? ` · ${activeCharacter.voiceId}` : ''}
                </div>
              </div>
              <span className="pill on"><span className="dot" />{petWindows.filter((window) => window.visible).length} 只在桌面</span>
            </div>

            <div className="section-title"><Users size={11} />角色快切</div>
            <div className="chips">
              {visibleCharacters.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  data-character-id={character.id}
                  className={`chip${character.id === activeCharacterId ? ' on' : ''}`}
                  disabled={busy !== null}
                  onClick={() => selectCharacter(character.id)}
                  title={character.displayName}
                >
                  {character.displayName}
                </button>
              ))}
              {visibleCharacters.length === 0 && <div className="empty">还没有可用角色</div>}
            </div>

            <div className="section-title"><Activity size={11} />快捷操作</div>
            <div className="actions">
              <button type="button" className="action" data-action="visibility" disabled={busy !== null} onClick={() => {
                void runAction('visibility', () => bridge.petWindowsVisible(!anyVisible), anyVisible ? '已暂藏全部桌宠' : '已唤回全部桌宠');
              }}>
                {anyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                {anyVisible ? '暂藏全部桌宠' : '显示全部桌宠'}
              </button>
              <button type="button" className="action" data-action="sleep" disabled={busy !== null} onClick={() => {
                void runAction('sleep', () => bridge.petSleepAll(!sleeping), sleeping ? '已叫醒全部桌宠' : '已进入安静睡眠');
              }}>
                {sleeping ? <Sun size={14} /> : <Moon size={14} />}
                {sleeping ? '叫醒' : '安静入睡'}
              </button>
              <button type="button" className="action" data-action="assemble" disabled={busy !== null} onClick={() => {
                void runAction('assemble', () => bridge.petAssemble(), '已集合排排站');
              }}>
                <Users size={14} />集合排排站
              </button>
              <button type="button" className="action" data-action="dismiss" disabled={busy !== null} onClick={() => {
                void runAction('dismiss', () => bridge.petDismiss(), '已解散其他桌宠');
              }}>
                <DoorOpen size={14} />解散
              </button>
              <button type="button" className="action" data-action="egg" disabled={busy !== null} onClick={() => {
                setBusy('egg');
                void bridge.petEggSummon().then(async (result) => {
                  if (result.ok) notify('ok', `${result.name ?? '彩蛋角色'}来串门啦`);
                  else notify('err', result.error ?? '没有可召唤的彩蛋');
                  await refreshRef.current();
                }).catch((error: unknown) => notify('err', error instanceof Error ? error.message : String(error))).finally(() => setBusy(null));
              }}>
                <Egg size={14} />召唤彩蛋
              </button>
              <button type="button" className="action" data-action="dock" disabled={busy !== null} onClick={() => {
                void runAction('dock', () => bridge.petDockAll(), '已让全部桌宠贴边');
              }}>
                <MoveRight size={14} />贴边
              </button>
            </div>

            <div className="section-title"><Send size={11} />快捷发话</div>
            <form className="chat-form" onSubmit={(event) => { void sendChat(event); }}>
              <input
                className="chat-input"
                value={chatText}
                onChange={(event) => setChatText(event.target.value)}
                placeholder="和她说句话，回车发送…"
                aria-label="快捷聊天输入"
                disabled={busy === 'chat'}
              />
              <button type="submit" className="send-btn" aria-label="发送" disabled={busy === 'chat' || chatText.trim() === ''}>
                <Send size={13} />
              </button>
            </form>
            {chatReply !== null && <div className="reply" data-chat-reply>{chatReply}</div>}
          </section>
        )}

        {tab === 'drive' && (
          <section data-panel="drive" style={{ display: 'contents' }}>
            <div className="card drive-status">
              <div className="game-badge"><Gamepad2 size={16} /></div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="drive-title">{gameLabel}</div>
                <div className="drive-sub">
                  {health === null ? '探活中…' : `${HEALTH_LABELS[health.status]} · ${health.detail}`}
                </div>
              </div>
              <span className={`status-chip ${health?.status === 'online' ? 'ok' : health === null ? '' : 'warn'}`}>
                {health === null ? '探测中' : HEALTH_LABELS[health.status]}
              </span>
            </div>

            <button
              type="button"
              className={`wide-btn${drive.running ? ' stop' : ''}`}
              data-action="drive-toggle"
              disabled={busy !== null}
              onClick={() => { void toggleDrive(); }}
            >
              {drive.running ? <Square size={13} /> : <Play size={13} />}
              {drive.running ? '停止自驾' : '一键启动自驾'}
            </button>

            <div className="section-title"><Target size={11} />当前多步目标</div>
            {objective !== null ? (
              <div className="objective" data-objective>
                <Target size={14} style={{ color: 'var(--amber)', flex: 'none', marginTop: 1 }} />
                <div className="objective-text">{objective}</div>
                <button type="button" className="mini-btn" disabled={busy !== null} onClick={() => { void clearObjective(); }}>
                  取消目标
                </button>
              </div>
            ) : (
              <div className="empty">没有进行中的多步目标</div>
            )}

            <div className="section-title"><Activity size={11} />最近回执</div>
            <div className="list" data-receipts>
              {receipts.length === 0 && <div className="empty">还没有回执，启动自驾后这里会出现最近 3 条</div>}
              {receipts.map((receipt, index) => (
                <div className="list-row" key={`${receipt.tool ?? 'receipt'}-${index}`}>
                  <StatusIcon status={receipt.status} />
                  <div className="grow">
                    <b>{receipt.summary}</b>
                    <div className="tiny" style={{ marginTop: 2 }}>
                      {TOOL_LABELS[receipt.tool ?? ''] ?? receipt.tool ?? '动作'} · {receipt.status ?? '未知'}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="section-title"><Users size={11} />联机队友</div>
            <div className="list">
              {coop.length === 0 && <div className="empty">未配置联机端点</div>}
              {coop.map((endpoint) => (
                <div className="list-row" key={endpoint.id}>
                  <ChevronRight size={12} style={{ color: 'var(--text-3)', flex: 'none' }} />
                  <div className="grow">
                    <b>{endpoint.characterName || endpoint.displayName}</b>
                    <div className="tiny" style={{ marginTop: 2 }}>{GAME_LABELS[endpoint.gameId]} · {endpoint.displayName}</div>
                  </div>
                  <span className={`status-chip ${endpoint.running ? 'ok' : endpoint.error !== null ? 'warn' : ''}`}>
                    {endpoint.running ? '运行中' : endpoint.error !== null ? '异常' : '待命'}
                  </span>
                </div>
              ))}
              {runningCoop.length > 0 && (
                <div className="tiny" style={{ padding: '0 2px' }}>{runningCoop.length} 位队友正在共玩</div>
              )}
            </div>
          </section>
        )}

        {tab === 'bowl' && (
          <section data-panel="bowl" style={{ display: 'contents' }}>
            <div className="card bowl-card">
              <div className="ring-wrap">
                <svg width="116" height="116" viewBox="0 0 116 116" aria-hidden="true">
                  <circle cx="58" cy="58" r={ringRadius} fill="none" stroke="var(--stroke)" strokeWidth="8" />
                  <circle
                    cx="58"
                    cy="58"
                    r={ringRadius}
                    fill="none"
                    stroke={riceColor}
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={`${ringCircumference}`}
                    strokeDashoffset={`${ringCircumference * (1 - riceRatio)}`}
                    transform="rotate(-90 58 58)"
                    style={{ transition: 'stroke-dashoffset 320ms ease, stroke 320ms ease' }}
                  />
                </svg>
                <div className="ring-center">
                  <span className="ring-percent" data-rice-balance={rice?.balance ?? 0}>{Math.round(riceRatio * 100)}%</span>
                  <span className="ring-caption">今日饭碗余量</span>
                </div>
              </div>
              <div className="bowl-stats">
                <div className="stat"><b>{rice === null ? '—' : formatNumber(rice.balance)}</b><span>剩余粒数</span></div>
                <div className="stat"><b>{rice === null ? '—' : formatNumber(rice.consumedToday)}</b><span>今日已用</span></div>
                <div className="stat"><b>{rice === null ? '—' : RICE_LEVEL_LABELS[rice.level]}</b><span>饭碗档位</span></div>
              </div>
              <button type="button" className="feed-btn" data-action="feed-rice" disabled={busy !== null} onClick={() => { void feedRice(); }}>
                <Plus size={12} />一键加饭 · +10,000 粒
              </button>
              <div className="tiny" style={{ textAlign: 'center' }}>
                {rice === null ? '饭碗数据尚未加载' : `日预算 ${formatNumber(rice.budget)} 粒 · 1 粒 = 1 Token`}
              </div>
            </div>

            {peak?.family === true && (
              <div className="card" data-peak-outfit style={{ padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 6 }}>
                  <span className="tiny" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Clock size={10} />峰谷时段</span>
                  <span className="pill" style={{ fontSize: 9, color: peak.period === 'peak' ? 'var(--red)' : 'var(--green)', background: peak.period === 'peak' ? 'var(--red-dim)' : 'var(--green-dim)' }}>
                    {peak.period === 'peak' ? '高峰' : '空闲'} · {peak.nextSwitchInMinutes} 分
                  </span>
                </div>
                <div style={{ position: 'relative', height: 10, borderRadius: 99, overflow: 'hidden', background: 'var(--inset)' }} data-peak-bar>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(30 / 1440) * 100}%`, background: 'color-mix(in srgb, var(--red) 55%, transparent)' }} />
                  <div style={{ position: 'absolute', left: `${(30 / 1440) * 100}%`, top: 0, bottom: 0, width: `${(480 / 1440) * 100}%`, background: 'color-mix(in srgb, var(--green) 55%, transparent)' }} />
                  <div style={{ position: 'absolute', left: `${(510 / 1440) * 100}%`, top: 0, bottom: 0, right: 0, background: 'color-mix(in srgb, var(--red) 55%, transparent)' }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, width: 2, background: 'var(--text-1)', left: `${(peak.minutesOfDay / 1440) * 100}%` }} />
                </div>
                <div className="tiny" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, opacity: 0.65 }}>
                  <span>00:30</span><span>08:30</span><span>24:00</span>
                </div>
              </div>
            )}

            <div className="section-title"><Route size={11} />跨 AI 工作跟随</div>
            <div className="list" data-work-follow>
              {activeSessions.length === 0 && <div className="empty">暂无活跃 AI 会话（{work.mode === 'multi' ? '多宠模式' : '单宠模式'}）</div>}
              {activeSessions.map((session) => (
                <div className="list-row" key={`${session.source}-${session.sessionId}`}>
                  <Gift size={12} style={{ color: 'var(--violet)', flex: 'none' }} />
                  <div className="grow">
                    <b>{WORK_SOURCE_LABELS[session.source] ?? session.source}</b>
                    <div className="tiny" style={{ marginTop: 2 }}>
                      {session.modelName || session.taskTitle || '正在干活'} · {session.toolCalls} 次工具调用
                    </div>
                  </div>
                  <span className="status-chip ok">活跃</span>
                </div>
              ))}
            </div>

            <div className="section-title"><Volume2 size={11} />语音</div>
            <div className="card" style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="row-between">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {voice?.enabled === true ? <Volume2 size={13} style={{ color: 'var(--green)' }} /> : <VolumeX size={13} style={{ color: 'var(--text-3)' }} />}
                  <span style={{ fontSize: 11.5 }}>语音播报</span>
                </div>
                <button
                  type="button"
                  className={`switch${voice?.enabled === true ? ' on' : ''}`}
                  aria-label="切换语音播报"
                  aria-pressed={voice?.enabled === true}
                  onClick={() => { void toggleVoice(); }}
                />
              </div>
              <div className="row-between">
                <span className="tiny">音量</span>
                <span className="tiny" style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round((voice?.volume ?? 0.8) * 100)}%</span>
              </div>
              <input
                type="range"
                className="slider"
                min={0}
                max={1}
                step={0.05}
                value={voice?.volume ?? 0.8}
                aria-label="语音音量"
                style={{ ['--fill' as string]: `${Math.round((voice?.volume ?? 0.8) * 100)}%` }}
                onChange={(event) => changeVolume(Number(event.target.value))}
              />
              <div className="tiny">
                {voiceBackend === null ? '语音后端探测中…' : `后端：${voiceBackend.detail}`}
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <button type="button" className="footer-btn" data-webui-copy onClick={() => { void copyWebui(); }} title="复制带 token 的 WebUI 地址">
          <Copy size={10} />
          {copied ? '已复制 WebUI 地址' : `${updatedLabel}更新 · 复制 WebUI 地址`}
        </button>
        <div className="spacer" />
        <button type="button" className="footer-btn quit" onClick={() => { void bridge.appQuit(); }} title="退出鲸屿">
          <LogOut size={10} />退出
        </button>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('tray-popover-root') as HTMLElement).render(<App />);
