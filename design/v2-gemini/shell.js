(function () {
  'use strict';

  var THEME_KEY = 'wi-v2g-theme';
  var STATE_KEY = 'wi-v2g-state';

  var DEFAULT_STATE = {
    characterId: 'char_wh001',
    character: '小鲸 · Primary',
    controlMode: 'coop', // autonomous | coop | command | takeover | stop
    voiceQuiet: false,
    petWindowOpen: true,
    riceGrains: 12480,
    riceCap: 25000,
    bugReports: [
      {
        id: 'BR-2026-041',
        time: '14:12',
        page: '星露谷共玩',
        summary: '矿洞 45 层梯子寻路卡在矿车旁，重试 2 次后请求接管',
        redacted: true,
        status: '待 Evolution 分析'
      }
    ]
  };

  function safeParse(str, fallback) {
    try { return str ? JSON.parse(str) : fallback; } catch (_e) { return fallback; }
  }

  function loadState() {
    var saved = safeParse(localStorage.getItem(STATE_KEY), {});
    var st = Object.assign({}, DEFAULT_STATE, saved || {});
    if (typeof st.riceGrains !== 'number' || isNaN(st.riceGrains)) st.riceGrains = DEFAULT_STATE.riceGrains;
    return st;
  }

  function saveState(next) {
    localStorage.setItem(STATE_KEY, JSON.stringify(next));
  }

  function getThemePref() {
    var v = localStorage.getItem(THEME_KEY);
    return (v === 'dark' || v === 'light' || v === 'system') ? v : 'system';
  }

  function getResolvedTheme(pref) {
    var p = pref || getThemePref();
    if (p === 'dark' || p === 'light') return p;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(pref) {
    var p = pref || getThemePref();
    document.documentElement.setAttribute('data-theme', p);
    localStorage.setItem(THEME_KEY, p);
    var resolved = getResolvedTheme(p);
    var labelEl = document.getElementById('v2-theme-label');
    if (labelEl) {
      labelEl.textContent = p === 'system'
        ? '系统(' + (resolved === 'light' ? '晨汐' : '深海') + ')'
        : (p === 'dark' ? '曜石深海' : '晨汐瓷白');
    }
    var iconEl = document.getElementById('v2-theme-icon');
    if (iconEl) {
      iconEl.setAttribute('data-lucide', p === 'system' ? 'monitor' : (p === 'dark' ? 'moon' : 'sun'));
      initIcons();
    }
    document.dispatchEvent(new CustomEvent('wi-v2-theme', { detail: { pref: p, resolved: resolved } }));
  }

  function cycleTheme() {
    var order = ['system', 'dark', 'light'];
    var cur = getThemePref();
    var next = order[(order.indexOf(cur) + 1) % order.length];
    applyTheme(next);
    toast('主题切换：' + (next === 'system' ? '默认跟随系统' : (next === 'dark' ? '曜石深海 Dark' : '晨汐瓷白 Light')));
    return next;
  }

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', function () {
        if (getThemePref() === 'system') applyTheme('system');
      });
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function initIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch (_e) {}
    }
  }

  function toast(msg, kind) {
    var wrap = document.getElementById('v2-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'v2-toast-wrap';
      wrap.className = 'wb-toast-wrap';
      document.body.appendChild(wrap);
    }
    var el = document.createElement('div');
    el.className = 'wb-toast';
    if (kind === 'danger') el.style.borderColor = 'var(--red-line)';
    if (kind === 'warn') el.style.borderColor = 'var(--amber-line)';
    var icon = kind === 'danger' ? 'alert-triangle' : (kind === 'warn' ? 'shield' : 'sparkles');
    el.innerHTML = '<i data-lucide="' + icon + '" class="ico-sm"></i><span>' + escapeHtml(msg) + '</span>';
    wrap.appendChild(el);
    initIcons();
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 180ms ease';
      setTimeout(function () { el.remove(); }, 200);
    }, 2400);
  }

  function whaleLogoSvg(size) {
    var s = size || 18;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" fill="currentColor" opacity="0.24"/>' +
      '<path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" stroke="currentColor" stroke-width="1.6"/>' +
      '<circle cx="17.3" cy="10.5" r="1.1" fill="currentColor"/>' +
      '</svg>';
  }

  // Six Worlds x 10 Pages IA
  var NAV_GROUPS = [
    {
      label: '生命体 · Lifeform',
      items: [
        { id: 'home', href: 'chat.html', icon: 'compass', title: '总览与对话', pill: 'LIVE' },
        { id: 'identity', href: 'identity.html', icon: 'user', title: '角色与声音', pill: 'v27' },
        { id: 'embodiment', href: 'embodiment.html', icon: 'shapes', title: '化身星座', pill: '4投影' },
        { id: 'life', href: 'digital-life.html', icon: 'globe', title: '生活与记忆', pill: '92' }
      ]
    },
    {
      label: '能力面 · Capability',
      items: [
        { id: 'coop', href: 'game-coop.html', icon: 'gamepad-2', title: '星露谷共玩', pill: 'V2.1' },
        { id: 'live', href: 'live-stage.html', icon: 'radio', title: '直播舞台', pill: '18765' },
        { id: 'studio', href: 'creative-studio.html', icon: 'palette', title: '创作工坊', pill: 'LAB' },
        { id: 'platform', href: 'platform.html', icon: 'bot', title: '智能体扩展', pill: 'MCP' }
      ]
    },
    {
      label: '系统面 · System',
      items: [
        { id: 'security', href: 'governance.html', icon: 'shield', title: '安全与治理', pill: 'P0-P5' },
        { id: 'evolution', href: 'evolution.html', icon: 'dna', title: '进化引擎', pill: 'DEV' }
      ]
    }
  ];

  var PAGE_META = {};
  NAV_GROUPS.forEach(function (g) {
    g.items.forEach(function (it) { PAGE_META[it.id] = { group: g.label.split(' · ')[0], title: it.title }; });
  });

  var CONTROL_MODES = [
    { id: 'autonomous', label: '自主', title: '按多时间尺度目标与知识自主推进 (F10)' },
    { id: 'coop', label: '协作', title: '人机并行共玩：人类键鼠操作不打断 AI' },
    { id: 'command', label: '指令', title: '仅执行显式指令与紧急保护反射' },
    { id: 'takeover', label: '接管', title: '人工手动接管控制 (F9 / T)' }
  ];

  var CMD_ITEMS = [
    { group: '体系总览', label: '曜潮设计系统总览 (Gallery)', href: 'index.html', key: 'G 0' },
    { group: '桌面独立双窗', label: '独立透明桌宠窗 (Pet Stage)', href: 'pet-stage.html', key: 'Win 1' },
    { group: '桌面独立双窗', label: '系统托盘控制卡 (Tray Popover)', href: 'tray-popover.html', key: 'Tray' },
    { group: '生命体', label: '① 总览与对话指挥台', href: 'chat.html', key: '1' },
    { group: '生命体', label: '② 角色本体与声音身份', href: 'identity.html', key: '2' },
    { group: '生命体', label: '③ 化身星座与多投影映射', href: 'embodiment.html', key: '3' },
    { group: '生命体', label: '④ 数字生活与五类记忆图谱', href: 'digital-life.html', key: '4' },
    { group: '能力面', label: '⑤ 星露谷共玩 V2.1 (目标/候选/证据)', href: 'game-coop.html', key: '5' },
    { group: '能力面', label: '⑥ 直播舞台与 4 重版权点歌', href: 'live-stage.html', key: '6' },
    { group: '能力面', label: '⑦ AI 创作工坊与商业包门禁', href: 'creative-studio.html', key: '7' },
    { group: '能力面', label: '⑧ 智能体网关 · MCP / Skills / Harness', href: 'platform.html', key: '8' },
    { group: '系统面', label: '⑨ 安全、权限与合规台账', href: 'governance.html', key: '9' },
    { group: '系统面', label: '⑩ 进化引擎与独立 Dev Worktree', href: 'evolution.html', key: '10' },
    { group: '全局动作', label: '切换主题 (跟随系统 / 曜石深海 / 晨汐瓷白)', action: 'theme', key: 'T' },
    { group: '全局动作', label: '投喂小鲸饭碗 +5,000 粒米', action: 'feed', key: '+5k' },
    { group: '全局动作', label: '紧急 Stop 冻结全部 Lease', action: 'stop', key: 'F8' },
    { group: '全局动作', label: '手动接管 (Takeover)', action: 'takeover', key: 'F9' },
    { group: '全局动作', label: '恢复自主模式', action: 'autonomous', key: 'F10' },
    { group: '全局动作', label: '标记问题 → 脱敏上报进化引擎', action: 'bug', key: 'B' }
  ];

  function renderArbitratorHtml(state) {
    var html = '<div class="arb-bar" role="group" aria-label="控制权仲裁">';
    CONTROL_MODES.forEach(function (m) {
      var act = state.controlMode === m.id ? ' active' : '';
      html += '<button type="button" class="arb-btn' + act + '" data-v2-mode="' + m.id + '" title="' + escapeHtml(m.title) + '">' + escapeHtml(m.label) + '</button>';
    });
    var stopAct = state.controlMode === 'stop' ? ' active' : '';
    html += '<button type="button" class="arb-btn stop' + stopAct + '" data-v2-mode="stop" title="F8 紧急停止"><i data-lucide="square" class="ico-sm"></i>Stop</button></div>';
    return html;
  }

  function renderRicePct(st) {
    return Math.max(6, Math.min(100, Math.round((st.riceGrains / (st.riceCap || 25000)) * 100)));
  }

  function syncRiceUi(st) {
    var valEl = document.getElementById('v2-rice-val');
    var barEl = document.getElementById('v2-rice-bar');
    if (valEl) valEl.textContent = Number(st.riceGrains).toLocaleString() + ' 粒';
    if (barEl) barEl.style.width = renderRicePct(st) + '%';
  }

  function feedRice(amount) {
    var st = loadState();
    st.riceGrains = (st.riceGrains || 0) + (amount || 5000);
    saveState(st);
    syncRiceUi(st);
    toast('已投喂小鲸饭碗 +' + (amount || 5000).toLocaleString() + ' 粒米');
    document.dispatchEvent(new CustomEvent('wi-v2-state', { detail: st }));
  }

  function injectStrataIfMissing() {
    if (!document.querySelector('.strata')) {
      var d = document.createElement('div');
      d.className = 'strata';
      document.body.prepend(d);
    }
  }

  function injectWorkbenchShell(activePage) {
    injectStrataIfMissing();
    var state = loadState();
    var body = document.body;
    var isFullbleed = body.getAttribute('data-v2-fullbleed') === 'true';
    var existingChildren = Array.prototype.slice.call(body.childNodes).filter(function (n) {
      return !(n.nodeType === 1 && (n.classList.contains('strata') || n.tagName === 'SCRIPT'));
    });

    var shell = document.createElement('div');
    shell.className = 'v2-shell' + (isFullbleed ? ' is-fullbleed' : '');

    var navHtml = '';
    NAV_GROUPS.forEach(function (grp) {
      navHtml += '<div class="v2-nav-group"><div class="v2-nav-label">' + escapeHtml(grp.label) + '</div>';
      grp.items.forEach(function (item) {
        var active = item.id === activePage ? ' active' : '';
        navHtml += '<a class="v2-nav-item' + active + '" href="' + item.href + '">' +
          '<span class="v2-nav-left"><i data-lucide="' + item.icon + '" class="ico-sm"></i><span>' + escapeHtml(item.title) + '</span></span>' +
          '<span class="v2-nav-pill">' + escapeHtml(item.pill) + '</span></a>';
      });
      navHtml += '</div>';
    });

    var sidebar = document.createElement('aside');
    sidebar.className = 'v2-sidebar';
    sidebar.innerHTML =
      '<a class="v2-brand" href="index.html">' +
      '  <div class="v2-brand-mark">' + whaleLogoSvg(18) + '</div>' +
      '  <div><span>WHALE ISLE</span><span class="v2-brand-sub">鲸屿 V2 · 曜潮</span></div>' +
      '  <span class="v2-brand-ver">V2</span>' +
      '</a>' +
      '<div class="v2-nav-scroll">' + navHtml + '</div>' +
      '<div class="v2-sidebar-footer">' +
      '  <a class="v2-window-link" href="pet-stage.html">' +
      '    <span class="row" style="gap:6px;"><i data-lucide="sparkles" class="ico-sm" style="color:var(--tide)"></i>独立透明桌宠窗</span>' +
      '    <span class="pill ' + (state.petWindowOpen ? 'pill-green' : '') + '">' + (state.petWindowOpen ? 'LIVE' : '隐藏') + '</span>' +
      '  </a>' +
      '  <a class="v2-window-link" href="tray-popover.html">' +
      '    <span class="row" style="gap:6px;"><i data-lucide="layers" class="ico-sm" style="color:var(--blue)"></i>系统托盘控制卡</span>' +
      '    <i data-lucide="external-link" class="ico-sm"></i>' +
      '  </a>' +
      '  <div>' +
      '    <div class="rice-head"><span>小鲸的饭碗</span><strong id="v2-rice-val">' + Number(state.riceGrains).toLocaleString() + ' 粒</strong></div>' +
      '    <div class="rice-bar"><i id="v2-rice-bar" style="width:' + renderRicePct(state) + '%"></i></div>' +
      '    <div class="v2-foot-btns">' +
      '      <button type="button" class="v2-foot-btn" id="v2-feed-btn">+ 投喂 5k</button>' +
      '      <a class="v2-foot-btn" href="index.html">设计总览</a>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    var meta = PAGE_META[activePage] || { group: '生命体', title: 'Whale Isle V2' };
    var pref = getThemePref();
    var resolved = getResolvedTheme(pref);
    var themeText = pref === 'system'
      ? '系统(' + (resolved === 'light' ? '晨汐' : '深海') + ')'
      : (pref === 'dark' ? '曜石深海' : '晨汐瓷白');
    var themeIcon = pref === 'system' ? 'monitor' : (pref === 'dark' ? 'moon' : 'sun');

    var topbar = document.createElement('header');
    topbar.className = 'v2-topbar';
    topbar.innerHTML =
      '<div class="v2-crumb"><span>' + escapeHtml(meta.group) + '</span><span>›</span><b>' + escapeHtml(meta.title) + '</b></div>' +
      '<button type="button" class="v2-searchbtn" id="v2-cmdk-btn" title="搜索页面或命令 (⌘K)"><i data-lucide="search" class="ico-sm"></i><span>搜索世界 / 指令…</span><kbd>⌘K</kbd></button>' +
      '<div class="v2-top-sp"></div>' +
      '<div class="v2-top-group">' +
      '  <span class="v2-dot' + (state.controlMode === 'stop' ? ' danger' : (state.voiceQuiet ? ' warn' : '')) + '" id="v2-top-dot" title="Runtime 在线"></span>' +
      '  <div id="v2-top-arb-wrap">' + renderArbitratorHtml(state) + '</div>' +
      '  <button type="button" class="btn btn-sm" id="v2-quiet-btn" title="切换语音 / 安静模式">' +
      '    <i data-lucide="' + (state.voiceQuiet ? 'volume-x' : 'volume-2') + '" class="ico-sm"></i>' +
      '    <span>' + (state.voiceQuiet ? '静音' : '语音开') + '</span>' +
      '  </button>' +
      '  <button type="button" class="btn btn-sm" id="v2-bug-btn" title="一键脱敏上报进化引擎">' +
      '    <i data-lucide="bug" class="ico-sm" style="color:var(--amber)"></i><span>标记问题</span>' +
      '  </button>' +
      '  <button type="button" class="btn btn-sm" id="v2-theme-btn" title="默认跟随系统，点击切换 跟随系统 / 曜石深海 / 晨汐瓷白">' +
      '    <i data-lucide="' + themeIcon + '" class="ico-sm" id="v2-theme-icon"></i>' +
      '    <span id="v2-theme-label">' + escapeHtml(themeText) + '</span>' +
      '  </button>' +
      '</div>';

    var main = document.createElement('main');
    main.className = 'v2-main';
    existingChildren.forEach(function (node) { main.appendChild(node); });

    shell.appendChild(sidebar);
    shell.appendChild(topbar);
    shell.appendChild(main);

    var firstScript = body.querySelector('script');
    body.insertBefore(shell, firstScript || null);

    wireTopbarEvents();
  }

  function wireTopbarEvents() {
    var themeBtn = document.getElementById('v2-theme-btn');
    if (themeBtn) themeBtn.addEventListener('click', cycleTheme);
    var feedBtn = document.getElementById('v2-feed-btn');
    if (feedBtn) feedBtn.addEventListener('click', function () { feedRice(5000); });
    var quietBtn = document.getElementById('v2-quiet-btn');
    if (quietBtn) {
      quietBtn.addEventListener('click', function () {
        var st = loadState();
        st.voiceQuiet = !st.voiceQuiet;
        saveState(st);
        quietBtn.innerHTML = '<i data-lucide="' + (st.voiceQuiet ? 'volume-x' : 'volume-2') + '" class="ico-sm"></i><span>' + (st.voiceQuiet ? '静音' : '语音开') + '</span>';
        initIcons();
        toast(st.voiceQuiet ? '已切换安静陪伴：抑制 TTS，保留气泡' : '已开启全局语音（voice-host 单端锁）');
        document.dispatchEvent(new CustomEvent('wi-v2-state', { detail: st }));
      });
    }
    var arbWrap = document.getElementById('v2-top-arb-wrap');
    if (arbWrap) {
      arbWrap.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-v2-mode]');
        if (btn) setControlMode(btn.getAttribute('data-v2-mode'));
      });
    }
    var cmdBtn = document.getElementById('v2-cmdk-btn');
    if (cmdBtn) cmdBtn.addEventListener('click', openCmdK);
    var bugBtn = document.getElementById('v2-bug-btn');
    if (bugBtn) bugBtn.addEventListener('click', openBugModal);
  }

  function setControlMode(mode) {
    var st = loadState();
    st.controlMode = mode;
    saveState(st);
    document.querySelectorAll('[data-v2-mode]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-v2-mode') === mode);
    });
    var dot = document.getElementById('v2-top-dot');
    if (dot) dot.className = 'v2-dot' + (mode === 'stop' ? ' danger' : (st.voiceQuiet ? ' warn' : ''));
    var labels = { autonomous: '自主模式 (F10)', coop: '人机协作模式', command: '指令响应模式', takeover: '手动接管 (F9)', stop: '紧急 Stop 冻结 (F8)' };
    toast('控制权仲裁切换：' + (labels[mode] || mode), mode === 'stop' ? 'danger' : 'ok');
    document.dispatchEvent(new CustomEvent('wi-v2-state', { detail: st }));
  }

  function ensureOverlays() {
    if (!document.getElementById('v2-cmdk-mask')) {
      var mask = document.createElement('div');
      mask.id = 'v2-cmdk-mask';
      mask.className = 'wb-mask';
      mask.innerHTML =
        '<div class="wb-dialog">' +
        '  <div style="padding:12px 14px;border-bottom:1px solid var(--stroke);display:flex;align-items:center;gap:8px;">' +
        '    <i data-lucide="search" class="ico-sm"></i>' +
        '    <input id="v2-cmdk-input" class="input" style="border:none;background:transparent;padding:2px 4px;" placeholder="跳转六世界页面或执行全局动作..." />' +
        '    <span class="kbd">ESC</span>' +
        '  </div>' +
        '  <div class="wb-cmdk-list" id="v2-cmdk-list"></div>' +
        '</div>';
      mask.addEventListener('click', function (e) { if (e.target === mask) mask.classList.remove('open'); });
      document.body.appendChild(mask);
      document.getElementById('v2-cmdk-input').addEventListener('input', function (e) { renderCmdKList(e.target.value); });
    }

    if (!document.getElementById('v2-bug-mask')) {
      var bmask = document.createElement('div');
      bmask.id = 'v2-bug-mask';
      bmask.className = 'wb-mask';
      bmask.innerHTML =
        '<div class="wb-dialog" style="padding:18px 20px;">' +
        '  <div class="row-between" style="margin-bottom:10px;">' +
        '    <h3 class="card-title"><i data-lucide="bug" class="ico-sm" style="color:var(--amber)"></i>向进化引擎标记问题</h3>' +
        '    <button type="button" class="btn btn-sm btn-ghost" id="v2-bug-close"><i data-lucide="x" class="ico-sm"></i></button>' +
        '  </div>' +
        '  <div class="banner cyan" style="margin-bottom:12px;">' +
        '    <i data-lucide="shield" class="ico-sm"></i>' +
        '    <div>自动附带脱敏版本、时间窗、回执与事件 ID；API Key、Cookie、本地路径与私人记忆<strong>强制脱敏</strong>，仅入队至独立 Dev Worktree。</div>' +
        '  </div>' +
        '  <textarea id="v2-bug-text" class="textarea" rows="3" placeholder="描述遇到的问题与预期表现..."></textarea>' +
        '  <div class="row-between" style="margin-top:12px;">' +
        '    <span class="pill pill-green"><i data-lucide="check" class="ico-sm"></i>已脱敏：0 密钥 / 0 Cookie</span>' +
        '    <div class="row"><button type="button" class="btn btn-sm" id="v2-bug-cancel">取消</button><button type="button" class="btn btn-sm btn-primary" id="v2-bug-submit">生成脱敏 Bug 单</button></div>' +
        '  </div>' +
        '</div>';
      bmask.addEventListener('click', function (e) { if (e.target === bmask) bmask.classList.remove('open'); });
      document.body.appendChild(bmask);
      document.getElementById('v2-bug-close').addEventListener('click', function () { bmask.classList.remove('open'); });
      document.getElementById('v2-bug-cancel').addEventListener('click', function () { bmask.classList.remove('open'); });
      document.getElementById('v2-bug-submit').addEventListener('click', function () {
        var text = (document.getElementById('v2-bug-text').value || '').trim();
        if (!text) { toast('请先输入问题描述', 'warn'); return; }
        var st = loadState();
        var num = 42 + st.bugReports.length;
        st.bugReports.unshift({ id: 'BR-2026-0' + num, time: '刚刚', page: document.body.getAttribute('data-v2-page') || 'workbench', summary: text, redacted: true, status: 'Issue Triage 入队' });
        saveState(st);
        document.getElementById('v2-bug-text').value = '';
        bmask.classList.remove('open');
        toast('已提交脱敏工单 BR-2026-0' + num + ' 至进化引擎');
        document.dispatchEvent(new CustomEvent('wi-v2-state', { detail: st }));
      });
    }
    initIcons();
  }

  function renderCmdKList(q) {
    var listEl = document.getElementById('v2-cmdk-list');
    if (!listEl) return;
    var query = (q || '').trim().toLowerCase();
    var filtered = CMD_ITEMS.filter(function (it) {
      return !query || it.label.toLowerCase().indexOf(query) !== -1 || it.group.toLowerCase().indexOf(query) !== -1;
    });
    listEl.innerHTML = filtered.map(function (it, idx) {
      return '<button type="button" class="wb-cmdk-item" data-cmd-idx="' + idx + '">' +
        '<div><span style="font-size:10px;color:var(--text-3);margin-right:8px;">' + escapeHtml(it.group) + '</span><span>' + escapeHtml(it.label) + '</span></div>' +
        '<span class="kbd">' + escapeHtml(it.key) + '</span></button>';
    }).join('');
    listEl.querySelectorAll('.wb-cmdk-item').forEach(function (btn, idx) {
      btn.addEventListener('click', function () {
        var item = filtered[idx];
        document.getElementById('v2-cmdk-mask').classList.remove('open');
        if (item.href) window.location.href = item.href;
        else if (item.action === 'theme') cycleTheme();
        else if (item.action === 'feed') feedRice(5000);
        else if (item.action === 'stop') setControlMode('stop');
        else if (item.action === 'takeover') setControlMode('takeover');
        else if (item.action === 'autonomous') setControlMode('autonomous');
        else if (item.action === 'bug') openBugModal();
      });
    });
  }

  function openCmdK() {
    ensureOverlays();
    document.getElementById('v2-cmdk-mask').classList.add('open');
    var input = document.getElementById('v2-cmdk-input');
    input.value = '';
    renderCmdKList('');
    setTimeout(function () { input.focus(); }, 20);
  }

  function openBugModal() {
    ensureOverlays();
    document.getElementById('v2-bug-mask').classList.add('open');
    setTimeout(function () { document.getElementById('v2-bug-text').focus(); }, 20);
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdK(); }
    else if (e.key === 'Escape') document.querySelectorAll('.wb-mask.open').forEach(function (m) { m.classList.remove('open'); });
    else if (e.key === 'F8') { e.preventDefault(); setControlMode('stop'); }
    else if (e.key === 'F9') { e.preventDefault(); setControlMode('takeover'); }
    else if (e.key === 'F10') { e.preventDefault(); setControlMode('autonomous'); }
  });

  window.wiV2 = {
    get: loadState,
    patch: function (partial) {
      var next = Object.assign({}, loadState(), partial || {});
      saveState(next);
      syncRiceUi(next);
      document.dispatchEvent(new CustomEvent('wi-v2-state', { detail: next }));
      return next;
    },
    feedRice: feedRice,
    setControlMode: setControlMode,
    cycleTheme: cycleTheme,
    applyTheme: applyTheme,
    getThemePref: getThemePref,
    getResolvedTheme: getResolvedTheme,
    toast: toast,
    openCmdK: openCmdK,
    openBugModal: openBugModal,
    initIcons: initIcons,
    whaleSvg: whaleLogoSvg,
    escapeHtml: escapeHtml
  };

  applyTheme(getThemePref());

  document.addEventListener('DOMContentLoaded', function () {
    injectStrataIfMissing();
    var activePage = document.body.getAttribute('data-v2-page');
    if (activePage) injectWorkbenchShell(activePage);
    ensureOverlays();
    applyTheme(getThemePref());
    initIcons();
  });
})();
