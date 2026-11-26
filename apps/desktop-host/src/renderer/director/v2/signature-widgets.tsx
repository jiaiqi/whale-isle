/**
 * Whale Isle V2 — 四大签名组件与真实阶段标注（V2-P1-05 / Tidepaper v3.1 精修）
 * 1. SonarRing：投射 CharacterCore 9 态即时生命/呼吸/专注/思考/演奏状态
 * 2. ReceiptChip：严格四态（PENDING | COMPLETED | FAILED | UNCERTAIN）
 * 3. LicenseBadge：许可边界徽章（DEV_ONLY_NON_COMMERCIAL / COMMERCIAL_READY / MIT / Apache-2.0 等）
 * 4. ControlOwnershipHud：三层权属（活动 / 游戏角色租约 / 桌面键鼠租约）+ 急停 F8 / 接管 F9 / 睡眠 F10
 */
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Gamepad2,
  Hand,
  HelpCircle,
  Layers,
  Monitor,
  Moon,
  OctagonAlert,
  Play,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  XCircle,
} from 'lucide-react';
import type { CharacterControlMode, CharacterExpression, LifeActivityKind } from '@workbench/shared-protocol';

// ── 1. SonarRing（声呐环） ────────────────────────────────────────────────────

const EXPRESSION_META: Record<
  CharacterExpression | 'halted',
  { label: string; color: string; pulse: boolean }
> = {
  idle: { label: '待命呼吸', color: 'var(--text-3)', pulse: false },
  listening: { label: '倾听中', color: 'var(--blue)', pulse: true },
  thinking: { label: '思考中', color: 'var(--violet)', pulse: true },
  speaking: { label: '说话中', color: 'var(--green)', pulse: true },
  singing: { label: '演唱中', color: 'var(--green)', pulse: true },
  dancing: { label: '舞动中', color: 'var(--violet)', pulse: true },
  gaming: { label: '共玩中', color: 'var(--blue)', pulse: true },
  reacting: { label: '即时反应', color: 'var(--amber)', pulse: true },
  resting: { label: '静息睡眠', color: 'var(--amber)', pulse: false },
  halted: { label: '急停锁定', color: 'var(--red)', pulse: false },
};

export function SonarRing({
  expression,
  halted,
  size = 26,
  label,
}: {
  expression: string;
  halted: boolean;
  size?: number;
  label?: string;
}): React.JSX.Element {
  const key = (halted ? 'halted' : expression) as CharacterExpression | 'halted';
  const meta = EXPRESSION_META[key] ?? EXPRESSION_META.idle;
  const ringClass = meta.pulse ? 'wb-sonar-ring active' : 'wb-sonar-ring';
  return (
    <span
      data-v2-sonar-ring={halted ? 'halted' : expression}
      className={ringClass}
      title={label ?? meta.label}
      style={{
        width: size,
        height: size,
        ['--sonar-color' as string]: meta.color,
      }}
      aria-label={`小鲸状态声呐：${label ?? meta.label}`}
    >
      <span className="wb-sonar-halo" />
      <span className="wb-sonar-core" />
    </span>
  );
}

// ── 2. ReceiptChip（四态回执芯片） ───────────────────────────────────────────

export type NormalizedReceiptStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'UNCERTAIN';

export function normalizeReceiptStatus(raw?: string): NormalizedReceiptStatus {
  switch (raw) {
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
    case 'ERROR':
    case 'ABORTED_BY_HUMAN_TAKEOVER':
      return 'FAILED';
    case 'UNCERTAIN':
    case 'TIMEOUT':
      return 'UNCERTAIN';
    default:
      return 'PENDING';
  }
}

const RECEIPT_META: Record<
  NormalizedReceiptStatus,
  { label: string; color: string; bg: string; line: string }
> = {
  PENDING: { label: '执行中 PENDING', color: 'var(--blue)', bg: 'var(--blue-dim)', line: 'var(--blue-line)' },
  COMPLETED: { label: '已完成 COMPLETED', color: 'var(--green)', bg: 'var(--green-dim)', line: 'var(--green-line)' },
  FAILED: { label: '失败 FAILED', color: 'var(--red)', bg: 'var(--red-dim)', line: 'var(--red-line)' },
  UNCERTAIN: { label: '不确定 UNCERTAIN', color: 'var(--amber)', bg: 'var(--amber-dim)', line: 'var(--amber-line)' },
};

export function ReceiptChip({
  status,
  detail,
}: {
  status?: string;
  detail?: string;
}): React.JSX.Element {
  const normalized = normalizeReceiptStatus(status);
  const meta = RECEIPT_META[normalized];
  const Icon =
    normalized === 'COMPLETED'
      ? CheckCircle2
      : normalized === 'FAILED'
        ? XCircle
        : normalized === 'UNCERTAIN'
          ? HelpCircle
          : Clock;
  return (
    <span
      data-v2-receipt-chip={normalized}
      title={detail ?? meta.label}
      className="mono inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.line}`,
      }}
    >
      <Icon size={10} />
      <span>{meta.label}</span>
    </span>
  );
}

// ── 3. LicenseBadge（许可边界徽章） ──────────────────────────────────────────

export function LicenseBadge({
  scope,
  compact = false,
}: {
  scope: string;
  compact?: boolean;
}): React.JSX.Element {
  const upper = scope.toUpperCase();
  if (upper.includes('DEV_ONLY') || upper.includes('NC')) {
    return (
      <span
        data-v2-license-badge={scope}
        className="pill pill-amber mono"
        style={{ fontSize: 10 }}
        title="包含非商用授权（如 CC BY-NC-SA 4.0），禁止用于商用或未清源打包"
      >
        <ShieldAlert size={10} />
        <span>{compact ? 'DEV_ONLY · 禁商用' : 'DEV_ONLY_NON_COMMERCIAL · 禁商用'}</span>
      </span>
    );
  }
  if (upper.includes('GPL') || upper.includes('UNLICENSED')) {
    return (
      <span
        data-v2-license-badge={scope}
        className="pill pill-red mono"
        style={{ fontSize: 10 }}
        title="合规阻断许可（GPL-3.0 / 无许可证），严禁引入源码"
      >
        <AlertTriangle size={10} />
        <span>{scope}</span>
      </span>
    );
  }
  if (upper.includes('COMMERCIAL_READY')) {
    return (
      <span
        data-v2-license-badge={scope}
        className="pill pill-green mono"
        style={{ fontSize: 10 }}
        title="已完成商用清源与授权校验"
      >
        <ShieldCheck size={10} />
        <span>{compact ? 'COMMERCIAL_READY' : 'COMMERCIAL_READY · 可商用'}</span>
      </span>
    );
  }
  return (
    <span data-v2-license-badge={scope} className="pill pill-blue mono" style={{ fontSize: 10 }}>
      <ShieldCheck size={10} />
      <span>{scope}</span>
    </span>
  );
}

// ── StageBadge（真实开发阶段诚实标注） ──────────────────────────────────────

export function StageBadge({
  stage,
  label,
}: {
  stage: 'P2' | 'P3' | 'P4' | 'SIMULATION';
  label: string;
}): React.JSX.Element {
  const isSim = stage === 'SIMULATION';
  return (
    <span
      data-v2-stage-badge={stage}
      className={`pill mono ${isSim ? 'pill-amber' : ''}`}
      style={{ fontSize: 9.5 }}
      title={`规划阶段 ${stage}：${label}（绝不冒充已接线生产能力）`}
    >
      <Layers size={9} />
      <span>{stage} · {label}</span>
    </span>
  );
}

// ── 4. ControlOwnershipHud（三层权属 + 急停） ───────────────────────────────

const ACTIVITY_LABEL: Record<LifeActivityKind | string, string> = {
  companion: '桌面陪伴',
  gaming: '游戏共玩',
  streaming: '直播演艺',
  creative: '创作工坊',
  social: '社区互动',
  resting: '安静休眠',
  halted: '急停锁定',
};

const CONTROL_META: Record<
  CharacterControlMode | string,
  { label: string; toneClass: string }
> = {
  autonomous: { label: 'AI 自主托管', toneClass: 'pill-green' },
  coop: { label: '人机协同', toneClass: 'pill-blue' },
  command: { label: '用户指令优先', toneClass: 'pill-violet' },
  manual_takeover: { label: '人类接管中', toneClass: 'pill-amber' },
};

/** 设备级 ComputerUseLease 视图（ADR-004）；未接线时由 HUD 如实显示「未接入 · P3」 */
export type ComputerLeaseState = 'held' | 'free' | 'preempted' | 'halted' | 'permission_denied' | 'unsupported';

export interface ComputerLeaseView {
  state: ComputerLeaseState;
  label: string;
  detail?: string;
  holderId?: string | null;
  purpose?: string;
  humanOverride?: boolean;
  /** `inputExecutor.mode`：disabled / dry_run（界面显示「预演」）/ live */
  inputMode?: 'disabled' | 'dry_run' | 'live';
  /** `pendingHandoffs` 中 status='awaiting_human' 的数量 */
  pendingHandoffs?: number;
  halted?: boolean;
}

export interface ControlOwnershipHudProps {
  displayName: string;
  characterId: string;
  expression: string;
  activityMode: string;
  controlMode: string;
  halted: boolean;
  running: boolean;
  humanControl: boolean;
  brainMode: string;
  asleep: boolean;
  busy: boolean;
  /** ADR-004：V2-P3-03 真实设备级租约；不传则诚实显示未接入 */
  computerLease?: ComputerLeaseView | null;
  onEmergencyHalt: () => void;
  onToggleTakeover: () => void;
  onResumeAutonomous: () => void;
  onToggleSleep: () => void;
  onOpenLifeConsole: () => void;
}

export function ControlOwnershipHud(props: ControlOwnershipHudProps): React.JSX.Element {
  const {
    displayName,
    characterId,
    expression,
    activityMode,
    controlMode,
    halted,
    running,
    humanControl,
    brainMode,
    asleep,
    busy,
    computerLease,
    onEmergencyHalt,
    onToggleTakeover,
    onResumeAutonomous,
    onToggleSleep,
    onOpenLifeConsole,
  } = props;

  const isTakeover = !halted && (humanControl || controlMode === 'manual_takeover');
  const ctrl = isTakeover ? CONTROL_META.manual_takeover! : (CONTROL_META[controlMode] ?? CONTROL_META.autonomous!);
  const actLabel = ACTIVITY_LABEL[activityMode] ?? activityMode;
  const exprMeta = EXPRESSION_META[(halted ? 'halted' : expression) as CharacterExpression | 'halted'] ?? EXPRESSION_META.idle;
  const computerLeaseView = computerLease ?? null;
  const hasComputerLease = computerLeaseView !== null;
  const leaseValue = computerLeaseView !== null ? computerLeaseView.label : '未接入 · P3';
  const computerLeaseAttr = computerLeaseView === null
    ? 'idle'
    : computerLeaseView.humanOverride === true
      ? 'human'
      : computerLeaseView.state === 'held'
        ? 'ai'
        : 'idle';
  const gameLeaseAttr = humanControl ? 'human' : brainMode === 'paused' ? 'paused' : running ? 'ai' : 'idle';
  const inputMode = computerLeaseView?.inputMode ?? null;
  const pendingHandoffs = computerLeaseView?.pendingHandoffs ?? 0;
  const leaseDetail = computerLeaseView === null ? '' : (computerLeaseView.detail ?? computerLeaseView.purpose ?? '');
  const leaseTitle = computerLeaseView !== null
    ? (leaseDetail !== '' ? `ComputerUseLease：${leaseValue} · ${leaseDetail}` : `ComputerUseLease：${leaseValue}`)
    : 'ComputerUseLease 由 V2-P3-03 接入；当前如实标注未接入，绝不伪造设备级控制状态';

  if (halted) {
    return (
      <div
        className="wb-hud is-halted"
        data-v2-control-hud
        data-halted="true"
        data-control-mode={controlMode}
        data-activity-mode={activityMode}
        {...(running ? { 'data-testid': 'human-control-bar' } : {})}
      >
        <button
          type="button"
          onClick={onOpenLifeConsole}
          className="wb-hud-person"
          title="点击打开生命中枢（12 域快照 / 统一表演舞台 / 额度矩阵 / 记忆控制）"
        >
          <SonarRing expression="halted" halted size={24} label={`${displayName} · 急停锁定`} />
          <span className="wb-hud-name">{displayName}</span>
          <span className="wb-hud-id">{characterId}</span>
        </button>
        <span className="wb-halt-copy">
          <OctagonAlert size={14} />
          <span>紧急停止已生效：AI 不再发送新的游戏控制、键鼠或对外发布动作。</span>
        </span>
        <div className="wb-hud-actions">
          <button
            type="button"
            data-v2-hud-resume
            disabled={busy}
            onClick={onResumeAutonomous}
            className="wb-ctrl"
            style={{ padding: '5px 12px', fontSize: 11, fontWeight: 650 }}
            title="解除锁定并恢复 AI 自主托管模式"
          >
            <Play size={12} />
            <span>恢复自主</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`wb-hud${isTakeover ? ' is-takeover' : ''}`}
      data-v2-control-hud
      data-halted="false"
      data-control-mode={controlMode}
      data-activity-mode={activityMode}
      {...(running ? { 'data-testid': 'human-control-bar' } : {})}
    >
      <button
        type="button"
        onClick={onOpenLifeConsole}
        className="wb-hud-person"
        title="点击打开生命中枢（12 域快照 / 统一表演舞台 / 额度矩阵 / 记忆控制）"
      >
        <SonarRing expression={expression} halted={false} size={24} label={`${displayName} · ${exprMeta.label}`} />
        <span className="wb-hud-name">{displayName}</span>
        <span className="wb-hud-id">{characterId}</span>
      </button>

      <div className="wb-lease" role="group" aria-label="三层控制权归属">
        <div className="wb-lease-item" title={`LifeActivityAuthority：当前活动与表达态 ${actLabel} / ${exprMeta.label}`}>
          <span className="lb">活动 · LifeActivity</span>
          <span className="vl"><Sparkles size={9} style={{ display: 'inline', verticalAlign: -1, marginRight: 4 }} />{actLabel} · {exprMeta.label}</span>
        </div>
        <div
          className={`wb-lease-item${isTakeover ? ' on' : ''}`}
          data-v2-game-lease={gameLeaseAttr}
          title={`GameCharacterControlLease：${ctrl.label}（只认 F7 / F9 / F8，游戏内普通键鼠不打断 AI）`}
        >
          <span className="lb">游戏角色 · GameCharacter</span>
          <span className="vl"><Gamepad2 size={9} style={{ display: 'inline', verticalAlign: -1, marginRight: 4 }} />{ctrl.label}</span>
        </div>
        <div
          className={`wb-lease-item${computerLeaseView !== null ? ' on' : ' pending'}`}
          data-v2-computer-lease={computerLeaseAttr}
          title={leaseTitle}
        >
          <span className="lb">桌面键鼠 · ComputerUse</span>
          <span className="vl">
            <Monitor size={9} style={{ display: 'inline', verticalAlign: -1, marginRight: 4 }} />
            <span className="vl-text">{leaseValue}</span>
            {inputMode !== null && (
              <span className="wb-input-chip" data-v2-input-mode={inputMode} title={`OS 输入执行器：${inputMode}`}>
                {inputMode === 'dry_run' ? '预演' : inputMode}
              </span>
            )}
          </span>
          {leaseDetail !== '' && <span className="vl-sub" title={leaseDetail}>{leaseDetail}</span>}
        </div>
      </div>

      {pendingHandoffs > 0 && (
        <button
          type="button"
          className="wb-handoff-alert"
          data-v2-computer-handoff={pendingHandoffs}
          onClick={onOpenLifeConsole}
          title="浏览器任务停在验证码 / 登录 / 风控页，需要人类亲自处理；鲸屿不会自动绕过"
        >
          <ShieldAlert size={11} />
          <span>等待你处理验证码 / 登录</span>
          <b>{pendingHandoffs}</b>
        </button>
      )}

      {running && (
        <span className="pill pill-blue" style={{ fontSize: 9.5 }}>
          <Brain size={9} />
          <span>{brainMode === 'paused' ? 'AI 安全暂停' : brainMode === 'rule-standin' ? '规则代驾中' : brainMode === 'rule' ? '手动规则模式' : '游戏接管中'}</span>
        </span>
      )}

      {asleep && (
        <span className="pill pill-amber" style={{ fontSize: 9.5 }}>
          <Moon size={9} />
          <span>安静睡眠</span>
        </span>
      )}

      <div className="wb-hud-actions">
        <button
          type="button"
          data-v2-hud-sleep
          disabled={busy}
          onClick={onToggleSleep}
          className={`wb-ctrl${asleep ? ' on-blue' : ''}`}
          style={{ padding: '5px 10px', fontSize: 10.5 }}
          title="F10：切换睡眠安静模式（暂停主动发声）"
        >
          {asleep ? <Sun size={11} /> : <Moon size={11} />}
          <span>{asleep ? '唤醒' : '睡眠'} <span className="kbd" style={{ height: 15, minWidth: 15 }}>F10</span></span>
        </button>

        <button
          type="button"
          data-v2-hud-takeover
          disabled={busy}
          onClick={onToggleTakeover}
          className={`wb-ctrl${isTakeover ? ' on-green' : ''}`}
          style={{ padding: '5px 10px', fontSize: 10.5 }}
          title="F9：一键接管或交还给 AI 托管"
        >
          <Hand size={11} />
          <span>{isTakeover ? '交还给 AI' : '我来操作'} <span className="kbd" style={{ height: 15, minWidth: 15 }}>F9</span></span>
        </button>

        {isTakeover && (
          <button
            type="button"
            data-v2-hud-resume
            disabled={busy}
            onClick={onResumeAutonomous}
            className="wb-ctrl on-green"
            style={{ padding: '5px 10px', fontSize: 10.5 }}
            title="恢复 AI 自主托管模式"
          >
            <Play size={11} />
            <span>恢复自主</span>
          </button>
        )}

        <button
          type="button"
          data-v2-hud-halt
          disabled={busy}
          onClick={onEmergencyHalt}
          className="btn-stop"
          title="F8：P0 紧急停手（停游戏动作 + 清混音器 + 锁定活动写入）"
        >
          <OctagonAlert size={12} />
          <span>急停</span>
          <span className="kbd">F8</span>
        </button>
      </div>
    </div>
  );
}
