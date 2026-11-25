/* =====================================================================
   鲸屿 Whale Isle · Design v3 · shell.js
   负责：主题 / 外壳（侧栏+顶栏）/ ⌘K 命令面板 / 审批收件箱 / 紧急停止
        + 通用交互接线（tabs / seg / chips / range / modal / drawer / menu / toast）
   页面约定：<body data-page="home" data-crumb="此刻 / 总览">，内容写在 <main class="page"> 中；
            独立窗口页（桌宠舞台 / OBS / 引导 / 托盘 / 远程）加 data-shell="none"。
   ===================================================================== */
(function () {
  'use strict';
  const doc = document.documentElement;
  const LS = { theme: 'wi3-theme', accent: 'wi3-accent', density: 'wi3-density' };
  const ASSET = '../../packages/pet-renderer/assets/blue-whale-maid/';

  /* ---------- 主题 ---------- */
  const qsTheme = new URLSearchParams(location.search).get('theme');
  const theme = qsTheme || localStorage.getItem(LS.theme) || (document.body.dataset.theme || 'light');
  doc.dataset.theme = theme;
  doc.dataset.accent = localStorage.getItem(LS.accent) || 'coral';
  if (localStorage.getItem(LS.density)) doc.dataset.density = localStorage.getItem(LS.density);

  const NAV = [
    { g: '此刻', items: [
      { id: 'home', t: '总览', i: 'compass', href: 'home.html' },
      { id: 'chat', t: '对话', i: 'message-circle', href: 'chat.html', cnt: '2', hot: true },
    ]},
    { g: '角色', items: [
      { id: 'character', t: '角色档案', i: 'user-round', href: 'character.html' },
      { id: 'voice', t: '声音与表演', i: 'audio-lines', href: 'voice.html' },
      { id: 'memory', t: '记忆', i: 'database', href: 'memory.html', cnt: '1.2k' },
    ]},
    { g: '化身', items: [
      { id: 'embodiment', t: '化身与动作库', i: 'shapes', href: 'embodiment.html', cnt: '114' },
      { id: 'pet-stage', t: '桌宠舞台', i: 'app-window', href: 'pet-stage.html', ext: true },
    ]},
    { g: '生活', items: [
      { id: 'game', t: '游戏共玩', i: 'gamepad-2', href: 'game.html' },
      { id: 'knowledge', t: '攻略与心得', i: 'book-open', href: 'knowledge.html' },
      { id: 'live', t: '直播间', i: 'radio', href: 'live.html' },
      { id: 'life', t: '数字生活', i: 'sun-medium', href: 'life.html' },
    ]},
    { g: '创作', items: [
      { id: 'studio', t: '创作工坊', i: 'wand-sparkles', href: 'studio.html' },
      { id: 'assets', t: '资产库', i: 'package', href: 'assets.html' },
    ]},
    { g: '能力', items: [
      { id: 'providers', t: '模型与饭碗', i: 'bot', href: 'providers.html' },
      { id: 'plugins', t: '插件 · MCP · 技能', i: 'puzzle', href: 'plugins.html' },
      { id: 'harness', t: 'Harness 智能体', i: 'square-terminal', href: 'harness.html' },
      { id: 'devices', t: '设备与租约', i: 'monitor-smartphone', href: 'devices.html' },
    ]},
    { g: '治理', items: [
      { id: 'security', t: '安全与授权', i: 'shield-check', href: 'security.html', cnt: '3', hot: true },
      { id: 'evolution', t: '进化引擎', i: 'dna', href: 'evolution.html' },
      { id: 'settings', t: '设置', i: 'settings-2', href: 'settings.html' },
    ]},
  ];

  const CMDS = [
    { t: '紧急停止所有自主动作', i: 'octagon-x', k: '⇧ Esc', run: () => WI.halt() },
    { t: '暂停 AI 游戏控制', i: 'pause', k: 'F8', run: () => WI.toast('已暂停 AI 游戏控制，等待你交还', 'warn', 'pause') },
    { t: '接管星露谷角色', i: 'hand', k: 'T', run: () => WI.toast('你已接管角色 · AI 只观察和建议', 'ok', 'hand') },
    { t: '切换深色 / 浅色', i: 'moon-star', k: '⌘ ⇧ L', run: () => WI.toggleTheme() },
    { t: '让小鲸安静陪伴 30 分钟', i: 'moon', run: () => WI.toast('安静模式 30 分钟 · 不主动发言', 'ok', 'moon') },
    { t: '打开桌宠舞台', i: 'app-window', run: () => (location.href = 'pet-stage.html') },
    { t: '打开 OBS 叠加层', i: 'video', run: () => (location.href = 'obs-overlay.html') },
    { t: '首次启动引导', i: 'sparkles', run: () => (location.href = 'onboarding.html') },
    { t: '菜单栏托盘弹窗', i: 'panel-top', run: () => (location.href = 'tray.html') },
    { t: '手机远程陪伴', i: 'smartphone', run: () => (location.href = 'remote.html') },
    { t: '原型目录', i: 'layout-grid', run: () => (location.href = 'index.html') },
  ];

  const INBOX = [
    { lv: 'p4', t: 'B 站评论草稿等待确认', d: '数字生活 · 对「星露谷 1.6 鱼塘攻略」的评论', href: 'life.html', i: 'message-square-text' },
    { lv: 'p3', t: 'PR #218 通过全部门禁，等待合并审批', d: '进化引擎 · fix(game): 背包满时的整理方案', href: 'evolution.html', i: 'git-pull-request' },
    { lv: 'p5', t: '直播点歌《晴天》缺少直播授权', d: '直播间 · 已自动拦截，可替换为曲库内授权曲', href: 'live.html', i: 'music-4' },
    { lv: 'p3', t: '新形象候选「夏日泳装」待审', d: '创作工坊 · 12 帧 Sprite 已过自动 QA', href: 'studio.html', i: 'image' },
  ];

  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const WI = window.WI = {
    ASSET,
    clip: (name) => ASSET + encodeURIComponent(name) + '.webm',
    $, $$, h,
    icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } }); },
    toast(msg, kind = 'ok', icon) {
      let box = $('.toasts'); if (!box) { box = h('<div class="toasts"></div>'); document.body.appendChild(box); }
      const ic = icon || { ok: 'check-circle-2', warn: 'alert-triangle', err: 'x-octagon', info: 'info' }[kind] || 'info';
      const el = h(`<div class="toast ${kind}"><i data-lucide="${ic}"></i><span>${msg}</span></div>`);
      box.appendChild(el); WI.icons();
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2800);
    },
    open(id) {
      const el = document.getElementById(id); if (!el) return;
      ensureScrim().classList.add('on'); el.classList.add('on'); WI._open = el;
    },
    close() {
      $$('.modal.on, .drawer.on, .palette.on').forEach((m) => m.classList.remove('on'));
      $('.scrim') && $('.scrim').classList.remove('on'); WI._open = null;
    },
    toggleTheme() {
      const t = doc.dataset.theme === 'dark' ? 'light' : 'dark';
      doc.dataset.theme = t; localStorage.setItem(LS.theme, t);
      const b = $('#wi-theme'); if (b) { b.innerHTML = `<i data-lucide="${t === 'dark' ? 'sun' : 'moon'}"></i>`; WI.icons(); }
    },
    setAccent(a) { doc.dataset.accent = a; localStorage.setItem(LS.accent, a); },
    setTheme(t) { doc.dataset.theme = t; localStorage.setItem(LS.theme, t); },
    halt() {
      const b = $('.halt-banner'); if (b) b.classList.add('on');
      WI.toast('已发出紧急停止 · 不再发送新的游戏 / 键鼠 / 发布动作', 'err', 'octagon-x');
      document.dispatchEvent(new CustomEvent('wi:halt'));
    },
    resume() { const b = $('.halt-banner'); if (b) b.classList.remove('on'); WI.toast('已恢复 · 回到协作模式', 'ok', 'play'); document.dispatchEvent(new CustomEvent('wi:resume')); },
    rnd: (a) => a[Math.floor(Math.random() * a.length)],
  };

  function ensureScrim() {
    let s = $('.scrim');
    if (!s) { s = h('<div class="scrim"></div>'); s.addEventListener('click', WI.close); document.body.appendChild(s); }
    return s;
  }

  /* ---------- 构建外壳 ---------- */
  function buildShell() {
    const page = document.body.dataset.page;
    const crumb = (document.body.dataset.crumb || '').split('/').map((s) => s.trim()).filter(Boolean);
    const floats = $$('body > .modal, body > .drawer, body > .menu, body > .palette, body > script, body > [data-float]');
    const content = $$('body > *').filter((n) => !floats.includes(n));

    const rail = h(`<aside class="rail">
      <div class="rail-brand">
        <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14c2.5 0 3-3 5.5-3S11 14 13.5 14 17 9 21 9"/><path d="M14.5 5.5c1-1.4 2.6-2 4-1.6M17 3.6c.2 1 .1 2-.5 2.8"/><path d="M3 19c2 0 2.6-1.6 4.5-1.6S10 19 12 19s2.6-1.6 4.5-1.6S19 19 21 19"/></svg></div>
        <div class="name">鲸屿<small>Whale Isle · v3</small></div>
      </div>
      <nav class="rail-nav">${NAV.map((g) => `
        <div class="rail-group"><div class="rail-group-h">${g.g}</div>
          ${g.items.map((it) => `<a class="rail-link ${it.id === page ? 'on' : ''}" href="${it.href}"><i data-lucide="${it.i}"></i>${it.t}${it.ext ? '<i data-lucide="arrow-up-right" class="ic-xs" style="opacity:.45"></i>' : ''}${it.cnt ? `<span class="cnt ${it.hot ? 'hot' : ''}">${it.cnt}</span>` : ''}</a>`).join('')}
        </div>`).join('')}
      </nav>
      <div class="rail-foot">
        <div class="rail-me" id="wi-me">
          <div class="pv"><video data-clip="待机呼吸休闲" autoplay loop muted playsinline></video></div>
          <div style="min-width:0;flex:1"><b>小鲸 <span class="chip sm accent" style="margin-left:4px;vertical-align:1px">主角色</span></b><span class="ellipsis" style="display:block">安静陪伴中 · 心情 晴</span></div>
          <i data-lucide="chevrons-up-down" class="ic-sm faint"></i>
        </div>
      </div>
    </aside>`);

    const top = h(`<header class="topbar">
      <div class="crumb">${crumb.map((c, i) => (i === crumb.length - 1 ? `<b>${c}</b>` : `<span>${c}</span><span class="sep">/</span>`)).join('')}</div>
      <div class="spacer"></div>
      <div class="search-trigger" id="wi-search"><i data-lucide="search" class="ic-sm"></i><span>搜索页面、记忆、命令…</span><span class="kbd">⌘K</span></div>
      <div class="presence" data-tip="同一个 AI · 当前在场的身体">
        <span class="pz on"><span class="dot ok pulse"></span>桌面</span>
        <span class="pz on"><span class="dot sea pulse"></span>星露谷</span>
        <span class="pz"><span class="dot"></span>直播</span>
      </div>
      <a class="btn ghost sm" href="providers.html" data-tip="今日饭碗 · Token 预算"><i data-lucide="wheat" class="ic-sm t-sun"></i><span class="mono">68%</span></a>
      <button class="btn ghost icon sm" id="wi-inbox" data-tip="审批收件箱"><i data-lucide="inbox"></i></button>
      <button class="btn ghost icon sm" id="wi-theme" data-tip="切换深浅色"><i data-lucide="${doc.dataset.theme === 'dark' ? 'sun' : 'moon'}"></i></button>
      <button class="btn-stop" id="wi-stop" data-tip="停止全部自主动作（游戏 / 键鼠 / 发布）"><i data-lucide="octagon-x" class="ic-sm"></i>停止<span class="kbd">⇧Esc</span></button>
    </header>`);
    const halt = h(`<div class="halt-banner"><i data-lucide="octagon-x" class="ic-sm"></i>紧急停止已生效：AI 不再发送任何新的游戏控制、键鼠或对外发布动作。进行中的语音已截断。<span class="spacer"></span><button class="btn sm" onclick="WI.resume()">交还控制</button></div>`);

    const scroll = h('<div class="page-scroll"></div>');
    content.forEach((n) => scroll.appendChild(n));
    const main = h('<div class="main"></div>');
    main.append(top, halt, scroll);
    const app = h('<div class="app"></div>');
    app.append(rail, main);
    document.body.prepend(app);

    $('#wi-theme').onclick = WI.toggleTheme;
    $('#wi-stop').onclick = WI.halt;
    $('#wi-search').onclick = openPalette;
    $('#wi-inbox').onclick = () => WI.open('wi-inbox-drawer');
    $('#wi-me').onclick = (e) => openMenu('wi-me-menu', e.currentTarget, 'up');

    document.body.appendChild(h(`<div class="drawer" id="wi-inbox-drawer">
      <div class="drawer-h"><i data-lucide="inbox" class="t-accent"></i><h3>审批收件箱</h3><span class="chip sm coral">${INBOX.length} 待处理</span><span class="spacer"></span><button class="btn ghost icon sm" data-close><i data-lucide="x"></i></button></div>
      <div class="drawer-b" style="padding:0">
        <div class="callout info" style="margin:16px 20px 8px"><i data-lucide="info" class="ic-sm"></i><span>所有对外副作用（P4 发布 / P5 敏感）与研发发布都汇总在这里。<b>授权不能让平台禁止的行为变成允许。</b></span></div>
        <div class="list">${INBOX.map((x) => `<a class="li click" href="${x.href}"><div class="ic"><i data-lucide="${x.i}"></i></div><div class="body"><b>${x.t}</b><span>${x.d}</span></div><span class="perm ${x.lv}">${x.lv.toUpperCase()}</span></a>`).join('')}</div>
      </div>
      <div class="drawer-f"><a class="btn sm" href="security.html">查看审计日志</a><button class="btn primary sm" data-close data-toast="已全部标记为稍后处理">稍后处理</button></div>
    </div>`));

    document.body.appendChild(h(`<div class="menu" id="wi-me-menu">
      <div class="eyebrow" style="padding:6px 9px 4px">切换角色</div>
      <button><span class="avatar sm c2">鲸</span>小鲸 <span class="chip sm accent" style="margin-left:auto">Primary</span></button>
      <button><span class="avatar sm c4">柚</span>小柚 <span class="chip sm" style="margin-left:auto">Passive</span></button>
      <button><span class="avatar sm c3">墨</span>墨墨 <span class="chip sm" style="margin-left:auto">Passive</span></button>
      <div class="sep"></div>
      <button onclick="location.href='pet-stage.html'"><i data-lucide="app-window" class="ic-sm"></i>打开桌宠舞台</button>
      <button onclick="WI.toast('安静陪伴 · 30 分钟不主动说话','ok','moon')"><i data-lucide="moon" class="ic-sm"></i>安静陪伴 30 分钟</button>
      <button onclick="location.href='character.html'"><i data-lucide="user-round-plus" class="ic-sm"></i>新建角色…</button>
    </div>`));
  }

  /* ---------- 命令面板 ---------- */
  function buildPalette() {
    const items = [];
    NAV.forEach((g) => g.items.forEach((it) => items.push({ grp: '前往', t: it.t, i: it.i, sub: g.g, run: () => (location.href = it.href) })));
    CMDS.forEach((c) => items.push({ grp: '命令', t: c.t, i: c.i, sub: c.k || '', run: c.run }));
    const pal = h(`<div class="palette" id="wi-palette">
      <div class="p-in"><i data-lucide="search" class="faint"></i><input placeholder="输入页面、命令，或直接对小鲸说话…" /><span class="kbd">Esc</span></div>
      <div class="p-list"></div>
      <div class="p-foot"><span><span class="kbd">↑</span> <span class="kbd">↓</span> 选择</span><span><span class="kbd">↵</span> 执行</span><span style="margin-left:auto">以「&gt;」开头直接发给小鲸</span></div>
    </div>`);
    document.body.appendChild(pal);
    const input = $('input', pal), list = $('.p-list', pal);
    let sel = 0, cur = [];
    function render() {
      const q = input.value.trim().toLowerCase();
      if (q.startsWith('>')) {
        cur = [{ grp: '对话', t: `发送给小鲸：「${input.value.slice(1).trim() || '…'}」`, i: 'send', sub: '↵', run: () => { WI.toast('已发送 · 小鲸正在思考', 'ok', 'message-circle'); } }];
      } else cur = items.filter((x) => !q || x.t.toLowerCase().includes(q) || (x.sub || '').toLowerCase().includes(q));
      sel = Math.min(sel, Math.max(cur.length - 1, 0));
      let last = '';
      list.innerHTML = cur.map((x, i) => { const gh = x.grp !== last ? `<div class="p-group">${x.grp}</div>` : ''; last = x.grp; return `${gh}<div class="p-item ${i === sel ? 'on' : ''}" data-i="${i}"><i data-lucide="${x.i}"></i>${x.t}<span class="faint">${x.sub || ''}</span></div>`; }).join('') || '<div class="empty small">没有匹配项</div>';
      WI.icons();
    }
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, cur.length - 1); render(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
      if (e.key === 'Enter' && cur[sel]) { WI.close(); cur[sel].run(); }
    });
    list.addEventListener('click', (e) => { const it = e.target.closest('.p-item'); if (it) { WI.close(); cur[+it.dataset.i].run(); } });
    WI._palRender = render;
  }
  function openPalette() {
    const p = $('#wi-palette'); if (!p) return;
    ensureScrim().classList.add('on'); p.classList.add('on');
    const i = $('input', p); i.value = ''; WI._palRender(); setTimeout(() => i.focus(), 30);
  }
  WI.palette = openPalette;

  /* ---------- 菜单 ---------- */
  function openMenu(id, anchor, dir) {
    const m = document.getElementById(id); if (!m) return;
    $$('.menu.on').forEach((x) => x !== m && x.classList.remove('on'));
    const r = anchor.getBoundingClientRect();
    m.classList.add('on');
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = r.left, y = r.bottom + 6;
    if (dir === 'up') y = r.top - mh - 6;
    if (x + mw > innerWidth - 8) x = r.right - mw;
    if (y + mh > innerHeight - 8) y = r.top - mh - 6;
    m.style.left = Math.max(8, x) + 'px'; m.style.top = Math.max(8, y) + 'px';
    setTimeout(() => document.addEventListener('click', function off(e) { if (!m.contains(e.target)) { m.classList.remove('on'); document.removeEventListener('click', off); } }), 0);
  }
  WI.menu = openMenu;

  /* ---------- 通用交互接线 ---------- */
  function wire(root = document) {
    // 视频素材
    $$('video[data-clip]', root).forEach((v) => { if (!v.src) v.src = WI.clip(v.dataset.clip); });
    // 下划线页签 / 分段：data-group 关联面板 [data-panel][data-group]
    $$('.tabs, .seg', root).forEach((bar) => {
      if (bar._wired) return; bar._wired = true;
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || !bar.contains(b)) return;
        $$(':scope > button', bar).forEach((x) => x.classList.toggle('on', x === b));
        const g = bar.dataset.group, v = b.dataset.tab || b.dataset.v;
        if (g && v) $$(`[data-panel][data-group="${g}"]`).forEach((p) => p.classList.toggle('on', p.dataset.panel === v));
        bar.dispatchEvent(new CustomEvent('change', { detail: v, bubbles: true }));
      });
    });
    // chips
    $$('[data-chips]', root).forEach((wrap) => {
      if (wrap._wired) return; wrap._wired = true;
      wrap.addEventListener('click', (e) => {
        const c = e.target.closest('.chip.click'); if (!c) return;
        if (wrap.dataset.chips === 'single') $$('.chip.click', wrap).forEach((x) => x.classList.toggle('on', x === c));
        else c.classList.toggle('on');
        wrap.dispatchEvent(new CustomEvent('change', { detail: c.dataset.v, bubbles: true }));
      });
    });
    // 滑杆
    $$('input.range', root).forEach((r) => {
      if (r._wired) return; r._wired = true;
      const upd = () => {
        const p = ((r.value - (r.min || 0)) / ((r.max || 100) - (r.min || 0))) * 100;
        r.style.setProperty('--v', p + '%');
        if (r.dataset.out) { const o = document.querySelector(r.dataset.out); if (o) o.textContent = r.value + (r.dataset.unit || ''); }
      };
      r.addEventListener('input', upd); upd();
    });
  }
  WI.wire = (root) => { wire(root); WI.icons(); };

  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]'); if (o) { e.preventDefault(); WI.open(o.dataset.open); }
    const c = e.target.closest('[data-close]'); if (c) WI.close();
    const t = e.target.closest('[data-toast]'); if (t) WI.toast(t.dataset.toast, t.dataset.kind || 'ok', t.dataset.icon);
    const m = e.target.closest('[data-menu]'); if (m) { e.preventDefault(); e.stopPropagation(); openMenu(m.dataset.menu, m); }
    const hf = e.target.closest('[data-href]'); if (hf && !e.target.closest('button, a, input, .switch')) location.href = hf.dataset.href;
  });
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); WI.toggleTheme(); }
    if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); WI.halt(); return; }
    if (e.key === 'Escape') { WI.close(); $$('.menu.on').forEach((m) => m.classList.remove('on')); }
    if (!typing && e.key === '/' && $('#wi-palette')) { e.preventDefault(); openPalette(); }
  });

  /* ---------- 启动 ---------- */
  const standalone = document.body.dataset.shell === 'none';
  if (!standalone && document.body.dataset.page) buildShell();
  if (!standalone) buildPalette();
  ensureScrim();
  wire();
  WI.icons();
  document.dispatchEvent(new CustomEvent('wi:ready'));
})();
