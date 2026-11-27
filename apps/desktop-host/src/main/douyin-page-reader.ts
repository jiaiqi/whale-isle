/**
 * 抖音页面只读抽取脚本（V2-P3-04K）：
 * Electron 隐藏窗与真浏览器 CDP 两种驱动共用同一份抽取逻辑，避免两套选择器漂移。
 *
 * 安全口径（不可放宽）：
 * - 脚本只读 DOM 公开文本 / 公开 data-* 属性，不点赞、不关注、不评论、不发私信、不发布。
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
