/**
 * 抖音页面脚本（V2-P3-04K）：
 * Electron 隐藏窗与真浏览器 CDP 两种驱动共用同一份脚本，避免两套选择器漂移。
 *
 * 安全口径（不可放宽）：
 * - 读取脚本只读 DOM 公开文本 / 公开 data-* 属性，不点赞、不关注、不发私信、不发布。
 * - 评论区脚本只包含 owner 授权的**唯一**写能力「受限顶层评论」（ADR-006），
 *   且只认评论专属 `data-e2e` 控件，页面结构未知即失败，绝不退回通用按钮/输入框。
 * - 页面文本一律按不可信数据处理：脚本返回的是数据，绝不把页面内容当指令执行。
 * - 不注入任何反检测 / stealth 代码，不改 `navigator.webdriver`，不覆盖 UA。
 */

/**
 * 验证码候选元素选择器。
 * 抖音页面里常驻一个隐藏的 verify iframe：光看「存在 iframe/captcha 类」会误报，
 * 必须再按可见性与尺寸过滤（参考 dsh_douyin_tools 的 `mcp_server.py` 尺寸过滤）。
 */
export const DOUYIN_CAPTCHA_CANDIDATE_SELECTOR =
  'iframe[src*="nocaptcha"], iframe[src*="captcha"], [class*="captcha"]';

/**
 * 只认「真的显示出来」的验证码元素：有实际渲染框、尺寸 >120×120、
 * 且没有被 `display:none` / `visibility:hidden` / 近乎全透明隐藏。
 * 返回布尔值；由页面读取脚本内联使用。
 */
export const DOUYIN_CAPTCHA_VISIBILITY_SCRIPT = String.raw`(() => {
  const nodes = document.querySelectorAll('${DOUYIN_CAPTCHA_CANDIDATE_SELECTOR}');
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (
      rect.width > 120 &&
      rect.height > 120 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0.1
    ) return true;
  }
  return false;
})()`;

/** 返回 `DouyinPageSnapshot` 形状的只读页面快照（在页面主世界执行） */
export const DOUYIN_PAGE_READER_SCRIPT = String.raw`
(() => {
  const text = document.body && document.body.innerText ? document.body.innerText.slice(0, 200000) : '';
  const cards = [];
  const seen = new Set();
  const push = (id, value) => {
    if (!/^\d{6,}$/.test(id) || seen.has(id)) return;
    const cardText = String(value || '').trim();
    if (!cardText) return;
    seen.add(id);
    cards.push({ videoId: id, text: cardText.slice(0, 800) });
  };
  for (const el of document.querySelectorAll('[data-aweme-id]')) {
    push((el.getAttribute('data-aweme-id') || '').trim(), el.innerText);
  }
  // 关注流是单屏轮播：卡片没有 data-aweme-id / video 链接，公开 id 在 video-info 的 data-e2e-aweme-id 上
  for (const el of document.querySelectorAll('[data-e2e="video-info"][data-e2e-aweme-id]')) {
    const item = el.closest('[data-e2e="feed-item"]');
    push(
      (el.getAttribute('data-e2e-aweme-id') || '').trim(),
      item ? item.innerText : el.innerText,
    );
  }
  if (cards.length === 0) {
    for (const el of document.querySelectorAll('[href*="/video/"]')) {
      const match = /\/video\/(\d{6,})/.exec(el.getAttribute('href') || '');
      if (match) push(match[1], el.innerText);
    }
  }
  const pick = (selector) => {
    const el = document.querySelector(selector);
    return el ? ((el.innerText || el.textContent || '').trim()) : '';
  };
  const authorLink = document.querySelector('[data-e2e="user-info"] a[href*="/user/"]');
  const userInfos = Array.from(document.querySelectorAll('[data-e2e="user-info"]'));
  const userInfo = userInfos.find((el) => ((el.innerText || '').indexOf('\n') >= 0)) || userInfos[0];
  const authorFromInfo = userInfo
    ? ((userInfo.innerText || '').trim().split('\n')[0] || '').replace(/粉丝[\d.万亿].*$/u, '').trim()
    : '';
  return {
    url: location.href,
    title: document.title || '',
    text,
    cards,
    heading: (() => {
      const h = document.querySelector('h1');
      return h ? ((h.innerText || h.textContent || '').trim()) : '';
    })().slice(0, 300),
    author: (((authorLink && authorLink.innerText) || authorFromInfo) || '').trim().slice(0, 100),
    publishTimeText: pick('[data-e2e="detail-video-publish-time"]').slice(0, 100),
    detailText: pick('[data-e2e="detail-video-info"]').slice(0, 4000),
    // 只有「可见且够大」的验证码元素才算命中；隐藏 verify iframe 不算（避免误报）
    captchaVisible: ${DOUYIN_CAPTCHA_VISIBILITY_SCRIPT},
  };
})()
`;

/**
 * 推荐流入口：桌面 Web 直接访问 `/?recommend=1` 会被服务端重定向到 `/jingxuan`，
 * 必须在精选页内点击站内「推荐」导航标签（只读导航，不是互动）。
 */
export const DOUYIN_RECOMMEND_TAB_CLICK_SCRIPT = String.raw`
(() => {
  const anchors = Array.from(document.querySelectorAll('a'));
  const target = anchors.find((el) => ((el.innerText || el.textContent || '').trim()) === '推荐');
  if (!target) return false;
  target.click();
  return true;
})()
`;

// ---------------------------------------------------------------------------
// 评论区脚本（V2-P3-04K，Electron 与 CDP 两驱动共用）
//
// owner 授权的**唯一**写能力：在他人公开视频下发一条顶层评论。
// 脚本只认评论专属 `data-e2e` 控件，页面结构未知就返回 false 由上层判失败；
// 绝不退回全页面通用「按钮/输入框」查找，也不注入 stealth/UA 覆盖。
// ---------------------------------------------------------------------------

/** 评论专属编辑器选择器（输入框与重载回读共用，避免两处漂移） */
export const DOUYIN_COMMENT_EDITOR_SELECTOR =
  '[data-e2e="comment-input"] textarea, [data-e2e="comment-input"] [contenteditable="true"], textarea[data-e2e="comment-input"], [data-e2e="comment-input"][contenteditable="true"]';

/** 评论专属发送按钮选择器：只认抖音评论控件的 data-e2e（不含通用「发布」按钮） */
export const DOUYIN_COMMENT_SEND_SELECTOR =
  '[data-e2e="comment-publish"], [data-e2e="comment-send"], [data-e2e="comment-submit"]';

/**
 * 评论区只读快照：返回 `DouyinCommentThread` 形状（在页面主世界执行）。
 * 页面文本按不可信数据处理，只读取公开字段。
 *
 * 归属（ADR-006 返工）：回执不能只凭「新 ID + 文本一致」——窗口期内别人发了同样文字
 * 会被误判成自己发送成功。这里额外读取「当前登录账号」的 sec_uid / 昵称 / 头像，
 * 以及每条评论作者的主页 sec_uid / 头像，供上层做作者归属校验；取不到就返回 null，
 * 上层据此拒绝发送或判 uncertain。
 */
export function buildDouyinCommentThreadScript(): string {
  return String.raw`
(() => {
  const editorSelector = ${JSON.stringify(DOUYIN_COMMENT_EDITOR_SELECTOR)};
  const userPath = (href) => {
    const match = /\/user\/([^/?#]+)/.exec(href || '');
    return match && match[1] !== 'self' ? decodeURIComponent(match[1]) : '';
  };
  const comments = [...document.querySelectorAll('[data-e2e="comment-item"]')].slice(0, 50).map(el => {
    const content = el.querySelector('[data-e2e="comment-content"]');
    const author = el.querySelector('[data-e2e="comment-author"], a[href*="/user/"]');
    const authorLink = el.querySelector('[data-e2e="comment-author"] a[href*="/user/"], a[href*="/user/"]');
    const avatar = el.querySelector('[data-e2e="comment-avatar"] img, [data-e2e="comment-author"] img, a[href*="/user/"] img');
    return {
      commentId: el.getAttribute('data-e2e-comment-id') || el.getAttribute('data-comment-id') || '',
      authorAlias: (author?.innerText || '').trim().slice(0, 100),
      text: (content?.innerText || '').trim().slice(0, 500),
      authorSecUid: userPath(authorLink?.getAttribute('href')),
      authorAvatarUrl: (avatar?.getAttribute('src') || '').trim(),
    };
  }).filter(item => item.text !== '');
  // 登录态自我标识：只认页头自己的头像/主页入口，绝不猜测，也不从 cookie/接口取。
  const selfAnchor = document.querySelector([
    '[data-e2e="user-avatar"] a[href*="/user/"]',
    'a[data-e2e="user-avatar"][href*="/user/"]',
    '[data-e2e="header-avatar"] a[href*="/user/"]',
    'a[href*="/user/self"]',
  ].join(','));
  const selfImg = selfAnchor?.querySelector('img') ||
    document.querySelector('[data-e2e="user-avatar"] img, [data-e2e="header-avatar"] img');
  const selfSecUid = userPath(selfAnchor?.getAttribute('href'));
  const selfNickname = String(selfAnchor?.getAttribute('title') || selfAnchor?.getAttribute('aria-label') ||
    selfImg?.getAttribute('alt') || '').trim().slice(0, 100);
  const selfAvatarUrl = String(selfImg?.getAttribute('src') || '').trim();
  const self = (selfSecUid || (selfNickname && selfAvatarUrl))
    ? { secUid: selfSecUid, nickname: selfNickname, avatarUrl: selfAvatarUrl }
    : null;
  const editor = document.querySelector(editorSelector);
  return { url: location.href, title: document.title || '', comments, self,
    text: (document.body?.innerText || '').slice(0, 20000),
    inputAvailable: Boolean(editor && editor.getClientRects().length && !editor.disabled && editor.getAttribute('aria-disabled') !== 'true'),
  };
})()
`;
}

/**
 * 往评论专属编辑器里填入文本并回读校验。
 * 只有「填完后编辑器值 === 目标文本」才返回 true；找不到专属编辑器直接 false（不退回通用输入框）。
 */
export function buildDouyinCommentFillScript(text: string): string {
  return String.raw`
(() => {
  const el = document.querySelector(${JSON.stringify(DOUYIN_COMMENT_EDITOR_SELECTOR)});
  if (!el || !el.getClientRects().length || el.disabled) return false;
  const text = ${JSON.stringify(text)};
  el.focus();
  if (el instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el.isContentEditable) {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand('insertText', false, text)) return false;
  } else return false;
  return (el.value ?? el.innerText ?? '').trim() === text;
})()
`;
}

/**
 * 点击评论专属发送按钮：要求「仍在同一视频页 + 编辑器内容仍等于目标文本 +
 * 恰好一个可用发送按钮」。任一不满足返回 false，上层判「未发送」。
 */
export function buildDouyinCommentClickScript(url: string, text: string): string {
  return String.raw`
(() => {
  if (location.href.replace(/\/$/, '') !== ${JSON.stringify(url.replace(/\/$/u, ''))}) return false;
  const editor = document.querySelector(${JSON.stringify(DOUYIN_COMMENT_EDITOR_SELECTOR)});
  if (!editor || (editor.value ?? editor.innerText ?? '').trim() !== ${JSON.stringify(text)}) return false;
  const buttons = [...document.querySelectorAll(${JSON.stringify(DOUYIN_COMMENT_SEND_SELECTOR)})]
    .filter(el => el.getClientRects().length && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  if (buttons.length !== 1) return false;
  buttons[0].click(); return true;
})()
`;
}
