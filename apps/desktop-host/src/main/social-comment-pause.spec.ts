/**
 * 评论暂停策略单测（V2-P3-04K 返工）：
 * 只有风控/登录墙/账号异常才暂停；结构性失败与 uncertain 都不关开关。
 */
import { describe, expect, it } from 'vitest';
import { applyCommentPausePolicy, shouldPauseComments } from './social-comment-pause';

const base = { status: 'failed' as const, failureKind: 'page_error', reason: '视频页已变化，取消发送' };

describe('评论自动暂停策略', () => {
  it('验证码 / 登录墙 / 账号异常 → 暂停', () => {
    expect(shouldPauseComments({ ...base, failureKind: 'captcha' })).toBe(true);
    expect(shouldPauseComments({ ...base, failureKind: 'login_required' })).toBe(true);
  });

  it('结构性错误 → 不暂停（开关保持原样）', () => {
    expect(shouldPauseComments({ ...base, failureKind: 'page_error' })).toBe(false);
    expect(shouldPauseComments({ ...base, failureKind: 'receipt_failed', status: 'uncertain' })).toBe(false);
    expect(shouldPauseComments({ ...base, failureKind: 'model_unavailable' })).toBe(false);
    expect(shouldPauseComments({ ...base, failureKind: 'quota', status: 'skipped' })).toBe(false);
    expect(shouldPauseComments({ ...base, failureKind: '', status: 'sent' })).toBe(false);
  });

  it('applyCommentPausePolicy 只在风控时调用暂停，并如实返回是否暂停', () => {
    const calls: string[] = [];
    const pause = (reason: string): void => { calls.push(reason); };
    expect(applyCommentPausePolicy({ ...base, failureKind: 'page_error' }, pause)).toBe(false);
    expect(calls).toEqual([]);
    expect(applyCommentPausePolicy({ ...base, failureKind: 'captcha', reason: '页面是验证码' }, pause)).toBe(true);
    expect(calls).toEqual(['页面是验证码']);
  });
});
