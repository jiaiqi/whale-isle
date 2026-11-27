/**
 * 受限评论的自动暂停策略（V2-P3-04K 返工，ADR-006）。
 *
 * 只有**风控信号**——验证码、登录墙、账号异常（`login_required`）——才允许把
 * 「受限评论」开关打回关闭。结构性错误（页面变化、评论控件缺失、导航失败、
 * 驱动未提供端口）只如实回报失败原因，开关保持原样：一次偶发 DOM 变化不该
 * 悄悄关掉 owner 亲手打开的开关，更不该让下一次重试被误当成风控。
 *
 * 注意：`uncertain`（已点击但无可靠回执）在策略上**不**暂停开关；它已经占额度，
 * 且同视频冷却会阻止对该视频重发；账本里的未决记录在下次启动时仍会触发人工核对。
 */
import type { SocialCommentAction } from '@workbench/shared-protocol';

const RISK_CONTROL_FAILURE_KINDS: ReadonlySet<string> = new Set(['captcha', 'login_required']);

/** 这条动作结果是否属于「必须暂停评论」的风控信号 */
export function shouldPauseComments(action: Pick<SocialCommentAction, 'status' | 'failureKind'>): boolean {
  return action.status === 'failed' && RISK_CONTROL_FAILURE_KINDS.has(action.failureKind);
}

/**
 * 宿主执行一次评论后的统一收尾：只有风控信号才调用暂停；
 * 返回是否真的暂停了，便于日志与测试断言「结构性错误没有关开关」。
 */
export function applyCommentPausePolicy(
  action: Pick<SocialCommentAction, 'status' | 'failureKind' | 'reason'>,
  pause: (reason: string) => void,
): boolean {
  if (!shouldPauseComments(action)) return false;
  pause(action.reason);
  return true;
}
