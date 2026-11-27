/**
 * 抖音受限评论端口单测（V2-P3-04K，ADR-006）。
 *
 * 这里测的是 Electron 与 CDP 两驱动**共用的那一份实现**：
 * 护栏拒绝分支（非视频页 / 输入框缺失 / 页面变化 / canSend=false / 验证码）
 * 与回执三态（sent / uncertain / failed）。
 *
 * 全部用 fake 页面原语跑，不启动浏览器、不访问抖音。
 */
import { describe, expect, it } from 'vitest';
import type { DouyinCommentThread } from '@workbench/character-core';
import { createDouyinCommentPort, type DouyinCommentPageOps } from './douyin-comment-port';
import {
  buildDouyinCommentClickScript,
  buildDouyinCommentFillScript,
  buildDouyinCommentThreadScript,
} from './douyin-page-reader';

const VIDEO_URL = 'https://www.douyin.com/video/7703599797286223291';
const TEXT = '这个解释让我理解了光的折射原理';
const THREAD_SCRIPT = buildDouyinCommentThreadScript();
const FILL_SCRIPT = buildDouyinCommentFillScript(TEXT);
const CLICK_SCRIPT = buildDouyinCommentClickScript(VIDEO_URL, TEXT);

function thread(overrides: Partial<DouyinCommentThread> = {}): DouyinCommentThread {
  return {
    url: VIDEO_URL,
    title: '光的折射 - 抖音',
    text: '正文',
    comments: [{ commentId: '700001', authorAlias: '观众甲', text: '讲得真清楚' }],
    inputAvailable: true,
    ...overrides,
  };
}

interface FakeOpsOptions {
  /** 每次读到评论区时的快照序列；最后一个会一直复用 */
  threadQueue?: DouyinCommentThread[];
  fillResult?: boolean;
  clickResult?: boolean;
  /** 点击成功后页面变成的样子（模拟真实回执） */
  afterClick?: DouyinCommentThread;
}

class FakeOps implements DouyinCommentPageOps {
  readonly navigations: string[] = [];
  readonly evaluated: string[] = [];
  private clock = 0;
  private queue: DouyinCommentThread[];
  private fillResult: boolean;
  private clickResult: boolean;
  private afterClick: DouyinCommentThread | null;
  private clicked = false;

  constructor(options: FakeOpsOptions = {}) {
    this.queue = options.threadQueue ?? [thread()];
    this.fillResult = options.fillResult ?? true;
    this.clickResult = options.clickResult ?? true;
    this.afterClick = options.afterClick ?? null;
  }

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    // 重载确认：真实页面会重新渲染评论区，回执后的「乐观插入」不再生效
    if (this.clicked) {
      this.clicked = false;
      this.afterClick = null;
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    this.evaluated.push(expression);
    if (expression === THREAD_SCRIPT) {
      const current = this.clicked && this.afterClick !== null ? this.afterClick : this.queue[0];
      if (this.queue.length > 1) this.queue.shift();
      return current as T;
    }
    if (expression === FILL_SCRIPT) return this.fillResult as T;
    if (expression === CLICK_SCRIPT) {
      if (this.clickResult) this.clicked = true;
      return this.clickResult as T;
    }
    throw new Error(`未预期的脚本：${expression.slice(0, 60)}`);
  }

  async sleep(): Promise<void> {
    // 不真实等待
  }

  now(): number {
    this.clock += 1_000;
    return this.clock;
  }
}

describe('受限评论端口：readComments 护栏', () => {
  it('非视频详情页直接拒绝，不导航', async () => {
    const ops = new FakeOps();
    const port = createDouyinCommentPort(ops);
    await expect(port.readComments('https://www.douyin.com/jingxuan')).rejects.toThrow('只允许抖音视频详情页');
    expect(ops.navigations).toEqual([]);
  });

  it('视频页返回评论区快照（含输入框可用性）', async () => {
    const ops = new FakeOps();
    const port = createDouyinCommentPort(ops);
    const result = await port.readComments(VIDEO_URL);
    expect(ops.navigations).toEqual([VIDEO_URL]);
    expect(result.inputAvailable).toBe(true);
    expect(result.comments).toHaveLength(1);
  });

  it('输入框迟迟不可用且页面是验证码：立即早退，不空等', async () => {
    const ops = new FakeOps({
      threadQueue: [thread({ title: '验证码中间页', inputAvailable: false })],
    });
    const port = createDouyinCommentPort(ops);
    const result = await port.readComments(VIDEO_URL);
    expect(result.title).toBe('验证码中间页');
    // 早退：thread 脚本只读了一次（不是 6s 内反复读）
    expect(ops.evaluated.filter((script) => script === THREAD_SCRIPT)).toHaveLength(1);
  });
});

describe('受限评论端口：postComment 护栏', () => {
  it('页面是验证码 → blocked=captcha，不填不点', async () => {
    const ops = new FakeOps({ threadQueue: [thread({ title: '验证码中间页' })] });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, blocked: 'captcha' });
    expect(ops.evaluated).not.toContain(FILL_SCRIPT);
  });

  it('登录墙导致输入框不可用 → blocked=login', async () => {
    const ops = new FakeOps({ threadQueue: [thread({ text: '请先登录后发表评论', inputAvailable: false })] });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, blocked: 'login' });
  });

  it('输入框缺失但非登录墙 → 页面错误，不发送', async () => {
    const ops = new FakeOps({ threadQueue: [thread({ inputAvailable: false })] });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, detail: '评论输入框不可用' });
    expect(ops.evaluated).not.toContain(FILL_SCRIPT);
  });

  it('当前页已不是目标视频页 → 取消发送', async () => {
    const ops = new FakeOps({ threadQueue: [thread({ url: 'https://www.douyin.com/video/7000000000000000001' })] });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, detail: '视频页已变化，取消发送' });
    expect(ops.evaluated).not.toContain(FILL_SCRIPT);
  });

  it('canSend=false → 点击前取消', async () => {
    const ops = new FakeOps();
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => false);
    expect(receipt).toMatchObject({ ok: false, detail: '发送已取消' });
    expect(ops.evaluated).not.toContain(FILL_SCRIPT);
  });

  it('填入后撤销（急停/关开关）→ 点击前再次取消', async () => {
    const ops = new FakeOps();
    let calls = 0;
    const receipt = await createDouyinCommentPort(ops).postComment(
      { url: VIDEO_URL, text: TEXT },
      () => {
        calls += 1;
        return calls === 1;
      },
    );
    expect(receipt).toMatchObject({ ok: false, detail: '发送已取消' });
    expect(ops.evaluated).toContain(FILL_SCRIPT);
    expect(ops.evaluated).not.toContain(CLICK_SCRIPT);
  });

  it('评论专属编辑器未就绪 → 不点击发送（绝不退回通用输入框）', async () => {
    const ops = new FakeOps({ fillResult: false });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, detail: '评论专属编辑器未就绪，未点击发送' });
    expect(ops.evaluated).not.toContain(CLICK_SCRIPT);
  });

  it('填入后页面变验证码 → blocked=captcha，不点击', async () => {
    const ops = new FakeOps({
      threadQueue: [thread(), thread({ title: '验证码中间页' })],
    });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, blocked: 'captcha' });
    expect(ops.evaluated).not.toContain(CLICK_SCRIPT);
  });

  it('找不到唯一评论专属发送按钮 → 未发送', async () => {
    const ops = new FakeOps({ clickResult: false });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, detail: '未找到唯一可用的评论专属发送按钮，未发送' });
  });
});

describe('受限评论端口：回执三态', () => {
  it('新增稳定 ID + 全文一致 + 重载仍在 → ok=true', async () => {
    const posted = thread({
      comments: [
        { commentId: '700001', authorAlias: '观众甲', text: '讲得真清楚' },
        { commentId: '700002', authorAlias: '', text: TEXT },
      ],
    });
    const ops = new FakeOps({ afterClick: posted, threadQueue: [thread(), posted] });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: true, commentId: '700002' });
    // 重载确认：点击后再导航同一视频页一次
    expect(ops.navigations.filter((url) => url === VIDEO_URL)).toHaveLength(1);
  });

  it('新增评论 ID 不是稳定数字 ID → 判 uncertain，不自动重发', async () => {
    const optimistic = thread({
      comments: [
        { commentId: '700001', authorAlias: '观众甲', text: '讲得真清楚' },
        { commentId: 'temp-1', authorAlias: '', text: TEXT },
      ],
    });
    const ops = new FakeOps({ afterClick: optimistic });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, uncertain: true });
  });

  it('点击后页面变化 → uncertain', async () => {
    const ops = new FakeOps({ afterClick: thread({ url: 'https://www.douyin.com/jingxuan' }) });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, uncertain: true, detail: '点击发送后页面变化，结果不确定' });
  });

  it('点击后撞验证码 → uncertain + blocked=captcha', async () => {
    const ops = new FakeOps({ afterClick: thread({ title: '验证码中间页' }) });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, uncertain: true, blocked: 'captcha' });
  });

  it('点击后 8 秒没有可靠回执 → uncertain', async () => {
    const ops = new FakeOps(); // afterClick 为 null：页面始终不出现新评论
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, uncertain: true, detail: '已点击发送，8 秒内没有可靠回执；不得自动重发' });
  });

  it('页面曾显示评论但重载后无法确认 → uncertain，不重发', async () => {
    // 点击后出现新评论，但重载后评论区又回到只有旧评论
    const posted = thread({
      comments: [
        { commentId: '700001', authorAlias: '观众甲', text: '讲得真清楚' },
        { commentId: '700002', authorAlias: '', text: TEXT },
      ],
    });
    const ops = new FakeOps({
      afterClick: posted,
      // 队列：before → 点击后（posted）→ 重载后（旧评论）
      threadQueue: [thread(), posted, thread()],
    });
    const receipt = await createDouyinCommentPort(ops).postComment({ url: VIDEO_URL, text: TEXT }, () => true);
    expect(receipt).toMatchObject({ ok: false, uncertain: true, detail: '页面曾显示评论，但重新加载后无法确认；不自动重发' });
  });
});
