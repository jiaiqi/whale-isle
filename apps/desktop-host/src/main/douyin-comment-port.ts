/**
 * 抖音受限评论端口（V2-P3-04K，ADR-006）——两驱动共用的**唯一实现**。
 *
 * owner 授权把「顶层评论」作为唯一写能力，但 macOS 默认驱动是 `cdp-real`：
 * 只把评论写在 Electron 驱动里 = 生产环境功能不可用。因此这里把
 * 「导航 → 读评论区 → 填评论专属编辑器 → 点评论专属发送按钮 → 回执三态判定」
 * 抽成与驱动无关的时序实现，Electron 与 CDP 各自只提供三个原语：
 * `navigate` / `evaluate` / `sleep`。
 *
 * 红线段（不可放宽）：
 * - 只允许 `https://www.douyin.com/video/<数字>`；其他页面直接抛错。
 * - 输入框/发送按钮只认评论专属 `data-e2e` 控件；页面结构未知即失败，
 *   绝不退回全页面通用按钮或通用输入框。
 * - 只有「新增稳定数字 ID + 全文回读 + 重载仍在」判 `sent`；
 *   点击后无可靠回执判 `uncertain`，不自动重发。
 * - 验证码/登录墙立即停手，绝不识别/绕过/重试。
 */
import {
  detectDouyinBlock,
  findNewDouyinComment,
  isDouyinVideoUrl,
  normalizeDouyinUrl,
  type DouyinCommentPort,
  type DouyinCommentReceipt,
  type DouyinCommentThread,
} from '@workbench/character-core';
import {
  buildDouyinCommentClickScript,
  buildDouyinCommentFillScript,
  buildDouyinCommentThreadScript,
} from './douyin-page-reader';

/** 驱动需要提供的最小原语；两驱动只在「怎么执行脚本 / 怎么导航」上不同 */
export interface DouyinCommentPageOps {
  /** 导航并等待页面加载完成（各自的超时口径由驱动自己保证） */
  navigate(url: string): Promise<void>;
  /** 在页面主世界执行脚本并取回值 */
  evaluate<T>(expression: string): Promise<T>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** 评论区就绪等待上限（与 Electron 原实现一致） */
const THREAD_READY_TIMEOUT_MS = 6_000;
const THREAD_POLL_MS = 400;
/** 点击后等待可靠回执的上限（与 Electron 原实现一致） */
const RECEIPT_TIMEOUT_MS = 8_000;
const RECEIPT_POLL_MS = 500;
/** 重载后确认评论仍存在的有界等待窗口 */
const PERSISTED_TIMEOUT_MS = 5_000;
const PERSISTED_POLL_MS = 300;
/** 受控输入后给页面一次渲染机会，再检查急停/撤销 */
const POST_FILL_SETTLE_MS = 200;

const THREAD_SCRIPT = buildDouyinCommentThreadScript();

export function createDouyinCommentPort(ops: DouyinCommentPageOps): DouyinCommentPort {
  const readThread = (): Promise<DouyinCommentThread> => ops.evaluate<DouyinCommentThread>(THREAD_SCRIPT);

  const assertVideoUrl = (url: string): void => {
    if (!isDouyinVideoUrl(url)) throw new Error('只允许抖音视频详情页');
  };

  return {
    async readComments(url: string): Promise<DouyinCommentThread> {
      assertVideoUrl(url);
      await ops.navigate(url);
      const deadline = ops.now() + THREAD_READY_TIMEOUT_MS;
      let thread = await readThread();
      while (ops.now() < deadline && !thread.inputAvailable) {
        if (detectDouyinBlock(thread)?.kind === 'captcha') break;
        await ops.sleep(THREAD_POLL_MS);
        thread = await readThread();
      }
      return thread;
    },

    async postComment(
      input: { url: string; text: string },
      canSend: () => boolean,
    ): Promise<DouyinCommentReceipt> {
      assertVideoUrl(input.url);
      const before = await readThread();
      const block = detectDouyinBlock(before);
      if (block?.kind === 'captcha') return { ok: false, detail: block.detail, blocked: 'captcha' };
      if (!before.inputAvailable) {
        return {
          ok: false,
          detail: '评论输入框不可用',
          ...(block?.kind === 'login' ? { blocked: 'login' as const } : {}),
        };
      }
      if (normalizeDouyinUrl(before.url) !== normalizeDouyinUrl(input.url)) {
        return { ok: false, detail: '视频页已变化，取消发送' };
      }
      if (!canSend()) return { ok: false, detail: '发送已取消' };

      const filled = await ops.evaluate<boolean>(buildDouyinCommentFillScript(input.text));
      if (!filled) return { ok: false, detail: '评论专属编辑器未就绪，未点击发送' };

      // 给受控输入一次渲染机会，然后再次检查急停/撤销；不重新加载、不换按钮硬试。
      await ops.sleep(POST_FILL_SETTLE_MS);
      const current = await readThread();
      const currentBlock = detectDouyinBlock(current);
      if (currentBlock?.kind === 'captcha') return { ok: false, detail: currentBlock.detail, blocked: 'captcha' };
      if (!canSend()) return { ok: false, detail: '发送已取消' };

      const clicked = await ops.evaluate<boolean>(buildDouyinCommentClickScript(input.url, input.text));
      if (!clicked) return { ok: false, detail: '未找到唯一可用的评论专属发送按钮，未发送' };

      const deadline = ops.now() + RECEIPT_TIMEOUT_MS;
      while (ops.now() < deadline) {
        await ops.sleep(RECEIPT_POLL_MS);
        const after = await readThread();
        const afterBlock = detectDouyinBlock(after);
        if (afterBlock?.kind === 'captcha') {
          return { ok: false, detail: afterBlock.detail, blocked: 'captcha', uncertain: true };
        }
        if (after.url !== before.url) {
          return { ok: false, uncertain: true, detail: '点击发送后页面变化，结果不确定' };
        }
        const posted = findNewDouyinComment(before.comments, after.comments, input.text);
        if (posted !== null) {
          // 排除前端乐观插入：重新加载后仍有相同 ID 与全文，才确认已发布。
          // 真实站点评论区异步渲染，重载后给一个有界等待窗口重复抽取；判定条件不放宽。
          await ops.navigate(input.url);
          const persistedDeadline = ops.now() + PERSISTED_TIMEOUT_MS;
          for (;;) {
            const persisted = await readThread();
            const persistedBlock = detectDouyinBlock(persisted);
            if (persistedBlock?.kind === 'captcha') {
              return { ok: false, uncertain: true, blocked: 'captcha', detail: persistedBlock.detail };
            }
            if (persisted.comments.some((item) => item.commentId === posted.commentId && item.text === input.text)) {
              return {
                ok: true,
                commentId: posted.commentId,
                detail: '重新加载后评论 ID 与完整原文仍匹配，已确认发布',
              };
            }
            if (ops.now() >= persistedDeadline) break;
            await ops.sleep(PERSISTED_POLL_MS);
          }
          return { ok: false, uncertain: true, detail: '页面曾显示评论，但重新加载后无法确认；不自动重发' };
        }
      }
      return { ok: false, uncertain: true, detail: '已点击发送，8 秒内没有可靠回执；不得自动重发' };
    },
  };
}
