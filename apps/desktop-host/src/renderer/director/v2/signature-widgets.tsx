/**
 * Whale Isle V2 — Obsidian Tide 四大签名组件与真实阶段标注（V2-P1-05）
 * 1. SonarRing：投射 CharacterCore 9 态即时生命/呼吸/专注/思考/演奏状态
 * 2. ReceiptChip：严格四态（PENDING | COMPLETED | FAILED | UNCERTAIN）
 * 3. LicenseBadge：许可边界徽章（DEV_ONLY_NON_COMMERCIAL / COMMERCIAL_READY / MIT / Apache-2.0 等）
 * 4. ControlOwnershipHud：置顶常驻控制权 HUD（急停 F8 / 接管 F9 / 静默睡眠 F10）
 */
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Cpu,
  Gamepad2,
  Hand,
  HelpCircle,
  Layers,
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

// ── 4. ControlOwnershipHud（置顶常驻控制权 HUD） ────────────────────────────

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
    onEmergencyHalt,
    onToggleTakeover,
    onResumeAutonomous,
    onToggleSleep,
    onOpenLifeConsole,
  } = props;

  const isTakeover = !halted && (humanControl || controlMode === 'manual_takeover');
  const ctrl = halted
    ? { label: 'P0 急停锁定', toneClass: 'pill-red' }
    : isTakeover
      ? CONTROL_META.manual_takeover!
      : (CONTROL_META[controlMode] ?? CONTROL_META.autonomous!);
  const actLabel = ACTIVITY_LABEL[activityMode] ?? activityMode;
  const exprMeta = EXPRESSION_META[(halted ? 'halted' : expression) as CharacterExpression | 'halted'] ?? EXPRESSION_META.idle;

  return (
    <div
      className="wb-hud flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-[11px]"
      data-v2-control-hud
      data-halted={halted ? 'true' : 'false'}
      data-control-mode={controlMode}
      data-activity-mode={activityMode}
      {...(running ? { 'data-testid': 'human-control-bar' } : {})}
      style={{
        borderColor: 'var(--stroke)',
        background: halted
          ? 'color-mix(in srgb, var(--red) 10%, var(--bg))'
          : isTakeover
            ? 'color-mix(in srgb, var(--amber) 10%, var(--bg))'
            : 'color-mix(in srgb, var(--bg) 52%, transparent)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <button
        type="button"
        onClick={onOpenLifeConsole}
        className="flex items-center gap-2 rounded-full px-1.5 py-0.5 transition hover:bg-[var(--surface-2)]"
        title="点击打开 V2 生命中枢（12 域快照 / 语音混音 / 额度矩阵 / 记忆控制）"
      >
        <SonarRing expression={expression} halted={halted} size={22} label={`${displayName} · ${exprMeta.label}`} />
        <span className="font-semibold" style={{ color: 'var(--text-1)' }}>{displayName}</span>
        <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{characterId}</span>
      </button>

      <span className={`pill ${ctrl.toneClass}`} style={{ fontSize: 10 }}>
        {isTakeover ? <Hand size={10} /> : <Cpu size={10} />}
        <span>控制权：{ctrl.label}</span>
      </span>

      <span className="pill" style={{ fontSize: 10 }} title={`当前 LifeRuntime 活动与表达态：${actLabel} / ${exprMeta.label}`}>
        {activityMode === 'gaming' ? <Gamepad2 size={10} /> : <Sparkles size={10} />}
        <span>{actLabel} · {exprMeta.label}</span>
      </span>

      {running && (
        <span className="pill pill-blue" style={{ fontSize: 10 }}>
          <Brain size={10} />
          <span>{brainMode === 'paused' ? 'AI 安全暂停' : brainMode === 'rule-standin' ? '规则代驾中' : brainMode === 'rule' ? '手动规则模式' : '游戏接管中'}</span>
        </span>
      )}

      {asleep && (
        <span className="pill pill-amber" style={{ fontSize: 10 }}>
          <Moon size={10} />
          <span>安静睡眠</span>
        </span>
      )}

      <div className="flex-1" />

      <button
        type="button"
        data-v2-hud-sleep
        disabled={busy}
        onClick={onToggleSleep}
        className={`wb-ctrl${asleep ? ' on-blue' : ''}`}
        style={{ padding: '3px 10px', fontSize: 10.5 }}
        title="F10：切换睡眠安静模式（暂停主动发声）"
      >
        {asleep ? <Sun size={11} /> : <Moon size={11} />}
        <span>{asleep ? '唤醒 F10' : '睡眠 F10'}</span>
      </button>

      <button
        type="button"
        data-v2-hud-takeover
        disabled={busy}
        onClick={onToggleTakeover}
        className={`wb-ctrl${isTakeover ? ' on-green' : ''}`}
        style={{ padding: '3px 10px', fontSize: 10.5 }}
        title="F9：一键接管或交还给 AI 托管"
      >
        <Hand size={11} />
        <span>{isTakeover ? '交还给 AI F9' : '我来操作 F9'}</span>
      </button>

      {(halted || controlMode === 'manual_takeover') && (
        <button
          type="button"
          data-v2-hud-resume
          disabled={busy}
          onClick={onResumeAutonomous}
          className="wb-ctrl on-green"
          style={{ padding: '3px 10px', fontSize: 10.5 }}
          title="解除锁定并恢复 AI 自主托管模式"
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
        className="wb-ctrl on-red"
        style={{ padding: '3px 10px', fontSize: 10.5, fontWeight: 650 }}
        title="F8：P0 紧急停手（停游戏动作 + 清混音器 + 锁定活动写入）"
      >
        <OctagonAlert size={11} />
        <span>急停 F8</span>
      </button>
    </div>
  );
}
