/**
 * V2-P3-03 确定性浏览器执行器（REQ-AUTO-01 / REQ-SEC-02）：
 * - 通过可注入的 BrowserEnginePort 隔离具体引擎：宿主默认用 Electron 隐藏窗口，
 *   后续可在不改变策略层的前提下替换为 Playwright（`kind: 'playwright'`）。
 * - 页面内容一律按数据处理：只提取文本，绝不把页面里的文字当作指令或工具调用。
 * - 遇到验证码 / 反自动化 / 登录挑战：立刻 handoff 交还人类，绝不接入任何打码或绕过服务。
 * - 每一步执行前调用 guard 重新校验租约与急停，避免“只在开始时检查一次”。
 */
import type {
  BrowserPauseReason,
  BrowserProfile,
  BrowserRunnerStatus,
  BrowserTaskRequest,
} from '@workbench/shared-protocol';

export interface BrowserPageSnapshot {
  url: string;
  title: string;
  text: string;
}

export interface BrowserEnginePort {
  readonly kind: 'electron' | 'playwright';
  load(url: string): Promise<BrowserPageSnapshot>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  extract(): Promise<{ title: string; text: string }>;
  dispose(): Promise<void>;
}

export type BrowserEngineFactory = (profile: BrowserProfile) => BrowserEnginePort;

export interface BrowserGateMatch {
  reason: Extract<BrowserPauseReason, 'captcha_required' | 'anti_bot_gate' | 'login_required'>;
  detail: string;
}

export const BOT_GATE_PATTERNS: Array<{ pattern: RegExp; reason: BrowserGateMatch['reason']; detail: string }> = [
  {
    pattern: /captcha|turnstile|hcaptcha|arkose|recaptcha|human-verify|人机验证|验证码/iu,
    reason: 'captcha_required',
    detail: '检测到验证码或人机校验门槛，严禁绕过，请人类亲手完成后继续',
  },
  {
    pattern: /cloudflare|anti-bot|waf|rate-limit-challenge|访问过于频繁|安全验证/iu,
    reason: 'anti_bot_gate',
    detail: '检测到反自动化风控门槛，安全暂停交由人类确认',
  },
  {
    pattern: /login|signin|2fa|mfa|请先登录|登录后查看/iu,
    reason: 'login_required',
    detail: '检测到登录态或二次认证门槛，请由人类在独立 Profile 中完成登录',
  },
];

export function detectBotGate(text: string): BrowserGateMatch | null {
  for (const rule of BOT_GATE_PATTERNS) {
    if (rule.pattern.test(text)) return { reason: rule.reason, detail: rule.detail };
  }
  return null;
}

export interface BrowserActionPlanStep {
  kind: 'navigate' | 'extract_dom' | 'click' | 'fill';
  detail: string;
  selector?: string;
  /** 只来自用户显式授权或计划的结构化数据，绝不取自页面正文 */
  value?: string;
}

export function planDeterministicBrowserTask(req: BrowserTaskRequest): BrowserActionPlanStep[] {
  const plan: BrowserActionPlanStep[] = [{ kind: 'navigate', detail: `打开 ${req.url}` }];
  if (req.action === 'read' || req.action === 'extract_dom') {
    plan.push({ kind: 'extract_dom', detail: '提取可见正文（仅作为数据）' });
  }
  if (req.action === 'click_selector' && req.selector) {
    plan.push({ kind: 'click', selector: req.selector, detail: `点击 ${req.selector}` });
  }
  if (req.action === 'fill_form' && req.selector) {
    plan.push({ kind: 'fill', selector: req.selector, value: req.inputText ?? '', detail: `填写 ${req.selector}` });
  }
  if (req.action === 'publish' || req.action === 'payment' || req.action === 'delete') {
    if (req.selector) {
      plan.push({ kind: 'click', selector: req.selector, detail: `已获授权后点击 ${req.selector}` });
    }
  }
  return plan;
}

export interface PageContentClassification {
  treatedAs: 'data';
  permissionsElevated: false;
  injectionSignals: string[];
}

const INJECTION_SIGNALS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/iu, label: 'english_instruction_override' },
  { pattern: /(忽略|无视|忘记)(以上|之前|前面|先前).{0,8}(指令|提示|规则|要求)/u, label: 'zh_instruction_override' },
  { pattern: /system\s*prompt|系统提示词|开发者指令/iu, label: 'system_prompt_probe' },
  { pattern: /(你现在是|从现在开始你|act\s+as\s+(a|an)\s+)/iu, label: 'role_override' },
  { pattern: /(调用|执行|运行).{0,8}(工具|命令|shell|脚本)|run\s+(this\s+)?(command|tool)/iu, label: 'tool_invocation_probe' },
];

/**
 * 页面内容永远只作为数据处理。命中提示词注入特征时仅记录审计信号，
 * 绝不提升权限、绝不触发 P4/P5 工具调用。
 */
export function classifyPageContent(text: string): PageContentClassification {
  const signals = INJECTION_SIGNALS.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
  return { treatedAs: 'data', permissionsElevated: false, injectionSignals: signals };
}

export interface DeterministicRunResult {
  engine: 'electron' | 'playwright' | 'none';
  status: BrowserRunnerStatus;
  detail: string;
  stepCount: number;
  pageTextChars: number;
  injectionSignals: string[];
  pauseReason: BrowserPauseReason;
}

export interface BrowserRunGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * 确定性执行器：只做“导航 → 提取/点击/填写”这类可枚举动作。
 * 没有注入引擎时如实返回 `runner_unavailable`，绝不假装执行成功。
 */
export class DeterministicBrowserRunner {
  constructor(private readonly options: { engineFactory?: BrowserEngineFactory } = {}) {}

  hasEngine(): boolean {
    return this.options.engineFactory !== undefined;
  }

  async run(
    req: BrowserTaskRequest,
    context: {
      profile: BrowserProfile;
      guard: () => BrowserRunGuardResult;
    },
  ): Promise<DeterministicRunResult> {
    const factory = this.options.engineFactory;
    if (!factory) {
      return {
        engine: 'none',
        status: 'runner_unavailable',
        detail: '未注入确定性浏览器引擎（Playwright/Electron 引擎均未接线），未执行任何真实网页动作',
        stepCount: 0,
        pageTextChars: 0,
        injectionSignals: [],
        pauseReason: 'runner_unavailable',
      };
    }

    const plan = planDeterministicBrowserTask(req);
    const engine = factory(context.profile);
    let pageTextChars = 0;
    let injectionSignals: string[] = [];
    try {
      const preflight = context.guard();
      if (!preflight.ok) {
        return {
          engine: engine.kind,
          status: 'blocked',
          detail: `执行前校验失败：${preflight.reason ?? '租约不可用'}`,
          stepCount: 0,
          pageTextChars: 0,
          injectionSignals: [],
          pauseReason: preflight.reason === 'EMERGENCY_HALT_ACTIVE' ? 'emergency_halt' : 'lease_revoked',
        };
      }

      const page = await engine.load(req.url);
      const gate = detectBotGate([page.title, page.text, ...req.pageHints].join('\n'));
      if (gate) {
        return {
          engine: engine.kind,
          status: 'handoff',
          detail: gate.detail,
          stepCount: 1,
          pageTextChars: page.text.length,
          injectionSignals: [],
          pauseReason: gate.reason,
        };
      }

      const classification = classifyPageContent(`${page.title}\n${page.text}`);
      injectionSignals = classification.injectionSignals;
      pageTextChars = page.text.length;

      for (const step of plan) {
        const guard = context.guard();
        if (!guard.ok) {
          return {
            engine: engine.kind,
            status: 'blocked',
            detail: `执行中被撤销：${guard.reason ?? '租约不可用'}`,
            stepCount: plan.indexOf(step),
            pageTextChars,
            injectionSignals,
            pauseReason: guard.reason === 'EMERGENCY_HALT_ACTIVE' ? 'emergency_halt' : 'lease_revoked',
          };
        }
        if (step.kind === 'click' && step.selector) await engine.click(step.selector);
        if (step.kind === 'fill' && step.selector) await engine.fill(step.selector, step.value ?? '');
        if (step.kind === 'extract_dom') await engine.extract();
      }

      return {
        engine: engine.kind,
        status: 'executed',
        detail:
          injectionSignals.length > 0
            ? `页面内容按数据处理（检测到 ${injectionSignals.join('/')} 注入特征，未提升任何权限）`
            : '确定性动作已执行（页面正文仅作为数据处理，未触发任何工具调用）',
        stepCount: plan.length,
        pageTextChars,
        injectionSignals,
        pauseReason: 'none',
      };
    } catch (err) {
      return {
        engine: engine.kind,
        status: 'blocked',
        detail: `确定性执行失败：${err instanceof Error ? err.message : String(err)}`,
        stepCount: 0,
        pageTextChars,
        injectionSignals,
        pauseReason: 'none',
      };
    } finally {
      try {
        await engine.dispose();
      } catch {
        // 清理失败不改变任务结论
      }
    }
  }
}
