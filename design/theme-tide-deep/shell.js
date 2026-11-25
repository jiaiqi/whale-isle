/* ==========================================================================
   鲸屿 V2 设计稿 · 统一 Shell 装配器 (design/v2/shell.js)
   页面契约：
     <html lang="zh-CN" class="dark">
     <body data-page="game" data-crumb="能力面 · 游戏共玩">
       <div class="strata"></div>
       <div class="wv2-shell">
         <main class="wv2-main"><div class="wv2-wrap"> ...页面内容... </div></main>
         [可选] <aside class="wv2-aside"> ...右栏... </aside>
       </div>
       <script src="vendor/lucide.min.js"></script>
       <script src="shell.js"></script>
       <script> lucide.createIcons(); if (window.pageInit) pageInit(); </script>
   ========================================================================== */
(function () {
  'use strict';

  var NAV = [
    { sec: '生命体 · Lifeform', items: [
      { id: 'home',       icon: 'compass',    label: '总览',       desc: '数字生命仪表盘' },
      { id: 'character',  icon: 'user',       label: '角色',       desc: '人格 · 情绪 · 声音' },
      { id: 'embodiment', icon: 'shapes',     label: '化身',       desc: '桌宠 · 游戏 · 舞台' },
      { id: 'life',       icon: 'globe',      label: '生活',       desc: '日程 · 浏览 · 记忆' }
    ]},
    { sec: '能力面 · Capability', items: [
      { id: 'agent',      icon: 'bot',        label: '智能体',     desc: '模型 · Harness · MCP' },
      { id: 'studio',     icon: 'palette',    label: '创作工坊',   desc: '形象 · 素材 · 资产' },
      { id: 'game',       icon: 'gamepad-2',  label: '游戏共玩',   desc: '控制权 · 决策 · 知识' },
      { id: 'live',       icon: 'radio',      label: '直播舞台',   desc: '弹幕 · 点歌 · 表演' }
    ]},
    { sec: '系统面 · System', items: [
      { id: 'evolution',  icon: 'dna',        label: '进化引擎',   desc: '自主研发 · 发布' },
      { id: 'security',   icon: 'shield',     label: '安全治理',   desc: '权限 · 审计 · 合规' }
    ]}
  ];

  var W = window.WV2 = {};

  /* ── 装配 ── */
  function build() {
    var shell = document.querySelector('.wv2-shell');
    if (!shell) return;
    var body = document.body;
    var pageId = body.getAttribute('data-page') || '';
    var crumb = body.getAttribute('data-crumb') || '';

    if (shell.querySelector('.wv2-aside')) shell.classList.add('has-aside');

    /* 侧栏 */
    var side = document.createElement('aside');
    side.className = 'wv2-side';
    var brand = '<a class="wv2-brand" href="index.html">' +
      '<span class="glyph"><i data-lucide="waves"></i></span>' +
      '<span><span class="t">鲸屿</span><span class="s">Whale Isle V2</span></span>' +
      '<span class="v">V2</span></a>';
    var nav = '<div class="wv2-nav-scroll">';
    NAV.forEach(function (g) {
      nav += '<div class="wv2-nav-sec">' + g.sec + '</div>';
      g.items.forEach(function (it) {
        nav += '<a class="wv2-nav-item' + (it.id === pageId ? ' on' : '') + '" href="' + it.id + '.html" title="' + it.desc + '">' +
          '<i data-lucide="' + it.icon + '"></i><span>' + it.label + '</span>' +
          (it.id === pageId ? '' : '') + '</a>';
      });
    });
    nav += '</div>';
    var foot = '<div class="wv2-foot">' +
      '<div class="wv2-rice-row"><span>饭碗 · 今日预算</span><b>83.2k / 500k</b></div>' +
      '<div class="wv2-rice-bar"><i style="width:16.6%"></i></div>' +
      '<div class="wv2-foot-actions">' +
        '<a class="wv2-foot-btn" href="index.html"><i data-lucide="compass"></i>设计总览</a>' +
        '<a class="wv2-foot-btn" href="security.html"><i data-lucide="shield"></i>权限</a>' +
      '</div></div>';
    side.innerHTML = brand + nav + foot;
    shell.prepend(side);

    /* 顶栏 */
    var live = body.getAttribute('data-live') === 'on';
    var top = document.createElement('header');
    top.className = 'wv2-top';
    top.innerHTML =
      '<span class="wv2-crumb">' + (crumb ? crumb.replace(/·([^·]*)$/, '·<b>$1</b>') : '') + '</span>' +
      '<button class="wv2-chip" data-cmdk><i data-lucide="search" class="sm"></i>搜索<kbd class="kbd">⌘K</kbd></button>' +
      '<span class="sp"></span>' +
      (live ? '<span class="wv2-chip on-red"><span class="dot red pulse"></span><i data-lucide="radio" class="sm"></i>直播中</span>' : '') +
      '<button class="wv2-chip on-tide" data-toggle="voice"><i data-lucide="volume-2" class="sm"></i>语音</button>' +
      '<button class="wv2-chip" data-toggle="dnd"><i data-lucide="bell-off" class="sm"></i>勿扰</button>' +
      '<button class="wv2-chip" data-toggle="theme"><i data-lucide="sun-moon" class="sm"></i>主题</button>' +
      '<span class="wv2-chip on-green"><span class="dot green pulse"></span>主模型 412ms</span>';
    shell.prepend(top);

    /* 命令面板 */
    var mask = document.createElement('div');
    mask.className = 'wv2-cmdk-mask';
    var list = '';
    NAV.forEach(function (g) {
      g.items.forEach(function (it) {
        list += '<a class="wv2-cmdk-item" href="' + it.id + '.html"><i data-lucide="' + it.icon + '" class="sm"></i>' + it.label +
          '<span class="hint">' + g.sec.split(' · ')[0] + ' · ' + it.desc + '</span></a>';
      });
    });
    list += '<a class="wv2-cmdk-item" href="index.html"><i data-lucide="palette" class="sm"></i>设计系统总览<span class="hint">tokens · 组件 · IA</span></a>';
    mask.innerHTML = '<div class="wv2-cmdk"><div class="wv2-cmdk-head"><i data-lucide="search" class="sm"></i>' +
      '<input type="text" placeholder="跳转页面或执行动作…" id="wv2-cmdk-input"></div>' +
      '<div class="wv2-cmdk-list">' + list + '</div></div>';
    document.body.appendChild(mask);

    /* Toast */
    var toast = document.createElement('div');
    toast.className = 'wv2-toast';
    toast.innerHTML = '<i data-lucide="check-circle-2" class="sm"></i><span id="wv2-toast-msg"></span>';
    document.body.appendChild(toast);
  }

  /* ── 交互 ── */
  function wire() {
    /* 主题切换：沿用 html.dark */
    document.querySelectorAll('[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-toggle');
        if (kind === 'theme') {
          var root = document.documentElement;
          root.classList.toggle('dark');
          W.toast(root.classList.contains('dark') ? '深海主题' : '晨汐主题');
        } else {
          btn.classList.toggle('on-tide');
          var on = btn.classList.contains('on-tide');
          var label = kind === 'voice' ? (on ? '语音已开启' : '语音已静音') : (on ? '勿扰已开启' : '勿扰已关闭');
          W.toast(label);
        }
      });
    });
    /* 命令面板 */
    var mask = document.querySelector('.wv2-cmdk-mask');
    var input = document.getElementById('wv2-cmdk-input');
    function open() { mask.classList.add('open'); if (input) { input.value = ''; filter(''); input.focus(); } }
    function close() { mask.classList.remove('open'); }
    function filter(q) {
      var items = mask.querySelectorAll('.wv2-cmdk-item');
      q = (q || '').toLowerCase();
      items.forEach(function (it) {
        it.style.display = (!q || it.textContent.toLowerCase().indexOf(q) >= 0) ? 'flex' : 'none';
      });
    }
    document.querySelectorAll('[data-cmdk]').forEach(function (b) { b.addEventListener('click', open); });
    if (mask) {
      mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
      if (input) input.addEventListener('input', function () { filter(input.value); });
      document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); mask.classList.contains('open') ? close() : open(); }
        if (e.key === 'Escape') close();
      });
    }
    /* 通用演示交互：.sw 开关 */
    document.querySelectorAll('.sw').forEach(function (sw) {
      sw.addEventListener('click', function () { sw.classList.toggle('on'); });
    });
    /* seg 分段控件（同组互斥） */
    document.querySelectorAll('.seg[data-mutex]').forEach(function (seg) {
      seg.querySelectorAll('.seg-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          seg.querySelectorAll('.seg-tab').forEach(function (t) { t.classList.remove('on'); });
          tab.classList.add('on');
        });
      });
    });
  }

  W.toast = function (msg) {
    var t = document.querySelector('.wv2-toast');
    if (!t) return;
    var m = document.getElementById('wv2-toast-msg');
    if (m) m.textContent = msg;
    t.classList.add('show');
    clearTimeout(W._tt);
    W._tt = setTimeout(function () { t.classList.remove('show'); }, 2200);
  };

  document.addEventListener('DOMContentLoaded', function () {
    build();
    if (window.lucide && lucide.createIcons) lucide.createIcons();
    wire();
    if (window.pageInit) window.pageInit();
  });
})();
