/* ==========================================================================
   大肥鱼工作台 · v4 共享交互外壳 (shell.js)
   统一装配：分组插件侧栏 · 顶栏全局中控条 (语音/LLM大脑/自动驾驶/主题)
   赛博饭碗投喂联动 · ⌘K 命令面板 · 跨页状态持久化 (localStorage)
   ========================================================================== */
(function () {
  const savedTheme = localStorage.getItem('wb-theme');
  if (savedTheme === 'light') document.documentElement.classList.remove('dark');
  else document.documentElement.classList.add('dark');

  const DEFAULT_STATE = {
    voiceOn: true,
    brainMode: 'llm', // 'llm' | 'rule'
    autodrive: true,
    rice: 12480,
    riceCap: 100000,
    activeVoice: '俏皮萌妹',
  };

  function loadState() {
    try {
      return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('wb-state-v4') || '{}') };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }
  function saveState(next) {
    localStorage.setItem('wb-state-v4', JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('wb:state', { detail: next }));
  }

  let state = loadState();
  window.wbState = {
    get: () => ({ ...state }),
    patch: (partial) => {
      state = { ...state, ...partial };
      saveState(state);
      syncShellControls();
      return state;
    },
  };

  let toastTimer = null;
  window.wbToast = function (msg) {
    let el = document.getElementById('wb-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wb-toast';
      el.className = 'wb-toast';
      document.body.appendChild(el);
    }
    el.innerHTML = `<i data-lucide="sparkles" class="sm" style="color:var(--blue)"></i><span>${msg}</span>`;
    if (window.lucide) window.lucide.createIcons();
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  };

  window.wbToggleTheme = function () {
    const root = document.documentElement;
    root.classList.toggle('dark');
    const dark = root.classList.contains('dark');
    localStorage.setItem('wb-theme', dark ? 'dark' : 'light');
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.setAttribute('data-lucide', dark ? 'sun' : 'moon');
    });
    if (window.lucide) window.lucide.createIcons();
  };

  const NAV_GROUPS = [
    {
      label: '交互中枢',
      items: [
        { id: 'chat', href: 'shell-chat.html', icon: 'message-square', label: '聊天 · 小鲸' },
        { id: 'memory', href: 'memory.html', icon: 'brain', label: '记忆图谱与日记', badge: '13 节点' },
      ],
    },
    {
      label: '声形与舞台',
      items: [
        { id: 'voice', href: 'voice-studio.html', icon: 'audio-lines', label: '声音工坊与音色库', badge: '5×5' },
        { id: 'pet', href: 'pet-stage.html', icon: 'fish', label: '桌宠舞台与动作库', badge: '114' },
      ],
    },
    {
      label: '游戏与直播',
      items: [
        { id: 'stardew', href: 'stardew.html', icon: 'sprout', label: '星露谷共玩', liveKey: 'autodrive' },
        { id: 'obs', href: 'obs-overlay.html', icon: 'monitor-play', label: 'OBS 透明挂件', badge: '18765' },
      ],
    },
    {
      label: '平台与底层',
      items: [
        { id: 'harness', href: 'harness.html', icon: 'terminal', label: 'Harness · ACP', badge: '2 在线' },
        { id: 'providers', href: 'providers.html', icon: 'cpu', label: '模型供应商' },
        { id: 'plugins', href: 'plugins.html', icon: 'puzzle', label: '插件与权限策略' },
      ],
    },
  ];

  const WHALE_SVG = `<svg style="width:22px;height:22px;flex-shrink:0" viewBox="0 0 24 24" fill="none"><path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" fill="var(--blue)" opacity=".28"/><path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" stroke="var(--blue)" stroke-width="1.55" stroke-linejoin="round"/><circle cx="17.5" cy="10.5" r="1" fill="var(--blue)"/></svg>`;

  function buildSidebar(activeId) {
    const groupsHtml = NAV_GROUPS.map((g) => {
      const itemsHtml = g.items
        .map((it) => {
          const isOn = it.id === activeId ? ' on' : '';
          let right = '';
          if (it.liveKey) {
            right = `<span class="dot-right" data-nav-live="${it.liveKey}"></span>`;
          } else if (it.badge) {
            right = `<span class="badge">${it.badge}</span>`;
          }
          return `<a class="wb-nav-item${isOn}" href="${it.href}"><i data-lucide="${it.icon}" class="sm"></i><span>${it.label}</span>${right}</a>`;
        })
        .join('');
      return `<div class="wb-nav-sec">${g.label}</div>${itemsHtml}`;
    }).join('');

    const aside = document.createElement('aside');
    aside.className = 'wb-side';
    aside.innerHTML = `
      <a class="wb-brand" href="index.html" title="返回设计系统总览">
        ${WHALE_SVG}
        <span class="t">大肥鱼工作台</span>
        <span class="v">v4</span>
      </a>
      <div class="wb-nav-scroll">${groupsHtml}</div>
      <div class="wb-side-foot">
        <div class="wb-rice-row">
          <span style="display:flex;align-items:center;gap:6px"><i data-lucide="wheat" class="sm" style="color:var(--amber)"></i>赛博饭碗</span>
          <b id="wb-rice-val">12,480 粒</b>
        </div>
        <div class="wb-rice-bar"><i id="wb-rice-bar" style="width:12.5%"></i></div>
        <div class="wb-foot-actions">
          <button class="wb-foot-btn" id="wb-feed-btn"><i data-lucide="plus" class="xs"></i>投喂 5k</button>
          <a class="wb-foot-btn" href="index.html"><i data-lucide="layout-grid" class="xs"></i>总览</a>
        </div>
      </div>
    `;
    return aside;
  }

  function buildTopbar(crumbParent, crumbTitle) {
    const header = document.createElement('header');
    header.className = 'wb-top';
    header.innerHTML = `
      <div class="wb-crumb">${crumbParent} <i data-lucide="chevron-right" class="xs"></i> <b>${crumbTitle}</b></div>
      <button class="wb-search-btn" id="wb-open-cmdk"><i data-lucide="search" class="xs"></i><span>快速跳转 / 指令…</span><kbd>⌘K</kbd></button>
      <div class="sp"></div>
      <button class="wb-ctrl" id="wb-ctrl-voice" title="切换全局语音播报"></button>
      <button class="wb-ctrl" id="wb-ctrl-brain" title="热切换 LLM 大脑 / 规则日程"></button>
      <button class="wb-ctrl" id="wb-ctrl-drive" title="启停星露谷自动驾驶"></button>
      <button class="icon-btn" onclick="wbToggleTheme()" title="切换深浅主题"><i data-lucide="${document.documentElement.classList.contains('dark') ? 'sun' : 'moon'}" data-theme-icon></i></button>
    `;
    return header;
  }

  function buildCmdK() {
    const mask = document.createElement('div');
    mask.className = 'wb-cmdk-mask';
    mask.id = 'wb-cmdk-mask';
    const items = [];
    NAV_GROUPS.forEach((g) => g.items.forEach((it) => items.push({ ...it, group: g.label })));
    items.push({ id: 'index', href: 'index.html', icon: 'sparkles', label: '设计系统 v4「曜石」总览', group: '设计规范' });

    mask.innerHTML = `
      <div class="wb-cmdk">
        <div class="wb-cmdk-head">
          <i data-lucide="search" class="sm" style="color:var(--blue)"></i>
          <input id="wb-cmdk-input" placeholder="输入页面名称或动作，如 声音、记忆、星露谷、投喂…">
          <span class="pill" style="font-size:10px">ESC</span>
        </div>
        <div class="wb-cmdk-list" id="wb-cmdk-list"></div>
      </div>
    `;
    document.body.appendChild(mask);

    const listEl = mask.querySelector('#wb-cmdk-list');
    const inputEl = mask.querySelector('#wb-cmdk-input');

    function render(q) {
      const kw = (q || '').trim().toLowerCase();
      const filtered = items.filter((it) => !kw || it.label.toLowerCase().includes(kw) || it.group.toLowerCase().includes(kw));
      listEl.innerHTML = filtered
        .map((it) => `<a class="wb-cmdk-item" href="${it.href}"><i data-lucide="${it.icon}" class="sm"></i><span>${it.label}</span><span class="hint">${it.group}</span></a>`)
        .join('') || `<div style="padding:18px;text-align:center;color:var(--text-3);font-size:12px">未找到匹配项</div>`;
      if (window.lucide) window.lucide.createIcons();
    }

    inputEl.addEventListener('input', () => render(inputEl.value));
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.classList.remove('open'); });
    window.wbOpenCmdK = function () {
      render('');
      mask.classList.add('open');
      setTimeout(() => { inputEl.value = ''; inputEl.focus(); }, 20);
    };
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        window.wbOpenCmdK();
      } else if (e.key === 'Escape') {
        mask.classList.remove('open');
      }
    });
  }

  function syncShellControls() {
    const vBtn = document.getElementById('wb-ctrl-voice');
    const bBtn = document.getElementById('wb-ctrl-brain');
    const dBtn = document.getElementById('wb-ctrl-drive');
    const rVal = document.getElementById('wb-rice-val');
    const rBar = document.getElementById('wb-rice-bar');

    if (vBtn) {
      vBtn.className = 'wb-ctrl ' + (state.voiceOn ? 'on-green' : '');
      vBtn.innerHTML = `<i data-lucide="${state.voiceOn ? 'volume-2' : 'volume-x'}" class="xs"></i><span>${state.voiceOn ? '语音开 · ' + state.activeVoice : '语音已静音'}</span>`;
    }
    if (bBtn) {
      const isLlm = state.brainMode === 'llm';
      bBtn.className = 'wb-ctrl ' + (isLlm ? 'on-violet' : '');
      bBtn.innerHTML = `<i data-lucide="brain" class="xs"></i><span>${isLlm ? 'LLM 大脑' : '规则日程'}</span>`;
    }
    if (dBtn) {
      dBtn.className = 'wb-ctrl ' + (state.autodrive ? 'on-red' : 'on-green');
      dBtn.innerHTML = `<i data-lucide="${state.autodrive ? 'square' : 'play'}" class="xs"></i><span>${state.autodrive ? '停止自动驾驶' : '启动自动驾驶'}</span>`;
    }
    if (rVal && rBar) {
      const pct = Math.min(100, Math.round((state.rice / state.riceCap) * 100));
      rVal.textContent = `${state.rice.toLocaleString()} 粒`;
      rBar.style.width = `${Math.max(4, pct)}%`;
      rVal.style.color = pct <= 15 ? 'var(--amber)' : 'var(--green)';
    }
    document.querySelectorAll('[data-nav-live="autodrive"]').forEach((dot) => {
      dot.innerHTML = state.autodrive ? '<span class="pulse-dot"></span>' : '<span class="off-dot"></span>';
    });
    if (window.lucide) window.lucide.createIcons();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const pageId = document.body.dataset.wbPage;
    if (pageId) {
      document.body.classList.add('wb-shell');
      if (!document.querySelector('.ambient')) {
        const amb = document.createElement('div');
        amb.className = 'ambient';
        document.body.prepend(amb);
      }
      const crumbParent = document.body.dataset.wbGroup || '工作台';
      const crumbTitle = document.body.dataset.wbTitle || document.title;
      document.body.prepend(buildTopbar(crumbParent, crumbTitle));
      document.body.prepend(buildSidebar(pageId));
      buildCmdK();

      document.getElementById('wb-open-cmdk')?.addEventListener('click', () => window.wbOpenCmdK());
      document.getElementById('wb-ctrl-voice')?.addEventListener('click', () => {
        const next = !state.voiceOn;
        window.wbState.patch({ voiceOn: next });
        window.wbToast(next ? `语音已开启（当前音色：${state.activeVoice}）` : '已静音：小鲸仅输出字幕与云朵气泡');
      });
      document.getElementById('wb-ctrl-brain')?.addEventListener('click', () => {
        const next = state.brainMode === 'llm' ? 'rule' : 'llm';
        window.wbState.patch({ brainMode: next });
        window.wbToast(next === 'llm' ? '已切换至 LLM 大脑（已注入 guide-forager 7 专题）' : '已切回规则日程引擎（0 token 兜底）');
      });
      document.getElementById('wb-ctrl-drive')?.addEventListener('click', () => {
        const next = !state.autodrive;
        window.wbState.patch({ autodrive: next });
        window.wbToast(next ? '自动驾驶已启动：小鲸接管星露谷' : '自动驾驶已停止：控制权交还主人');
      });
      document.getElementById('wb-feed-btn')?.addEventListener('click', () => {
        const nextRice = Math.min(state.riceCap, state.rice + 5000);
        window.wbState.patch({ rice: nextRice });
        window.wbToast(`已投喂 +5,000 粒米（余额 ${nextRice.toLocaleString()} 粒 · 触发 fed_buff）`);
      });

      syncShellControls();
    } else if (window.lucide) {
      window.lucide.createIcons();
    }
  });
})();
