/* ==========================================================================
   鲸屿 Whale Isle · v4.5 共享交互外壳 (shell.js)
   - 精简 9 项分组侧栏（多游戏合并为「游戏共玩」，去除内部工单/端口/版本号噪音）
   - 升级版顶栏：全局游戏选择 + 自驾启停组合胶囊、主脑模型短名显示、角色快切、⌘K
   - 赛博饭碗投喂联动 + 深浅主题持久化
   ========================================================================== */
(function () {
  const savedTheme = localStorage.getItem('wb-theme');
  if (savedTheme === 'light') document.documentElement.classList.remove('dark');
  else document.documentElement.classList.add('dark');

  const DEFAULT_STATE = {
    voiceOn: true,
    brainMode: 'llm', // 'llm' | 'rule'
    brainModel: 'deepseek-v4.1',
    autodrive: true,
    activeGame: 'stardew', // 'stardew' | 'terraria' | 'dst'
    activeChar: '小鲸',
    rice: 16370,
    riceCap: 100000,
    activeVoice: '俏皮萌妹',
  };

  const GAMES = {
    stardew: { name: '星露谷', full: '星露谷物语', icon: 'sprout' },
    terraria: { name: '泰拉瑞亚', full: '泰拉瑞亚', icon: 'swords' },
    dst: { name: '饥荒 DST', full: '饥荒：联机版', icon: 'flame' },
  };
  const CHARS = [
    { id: '小鲸', sub: '蓝鲸女仆' },
    { id: '泡芙', sub: '软萌柴犬' },
    { id: '墨鱼', sub: '毒舌军师' },
  ];

  function loadState() {
    try {
      return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('wb-state-v45') || '{}') };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }
  function saveState(next) {
    localStorage.setItem('wb-state-v45', JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('wb:state', { detail: next }));
  }

  let state = loadState();
  window.wbGames = GAMES;
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
        { id: 'chat', href: 'shell-chat.html', icon: 'message-square', label: '聊天对话' },
        { id: 'memory', href: 'memory.html', icon: 'brain', label: '记忆与日记', badge: '92 节点' },
      ],
    },
    {
      label: '声形与舞台',
      items: [
        { id: 'voice', href: 'voice-studio.html', icon: 'audio-lines', label: '声音工坊与音色库' },
        { id: 'pet', href: 'pet-stage.html', icon: 'fish', label: '桌宠舞台与动作库' },
      ],
    },
    {
      label: '游戏与直播',
      items: [
        { id: 'stardew', href: 'stardew.html', icon: 'gamepad-2', label: '游戏共玩', liveKey: 'autodrive' },
        { id: 'coop', href: 'coop.html', icon: 'users', label: '联机协作', badge: '3 人' },
        { id: 'obs', href: 'obs-overlay.html', icon: 'monitor-play', label: 'OBS 透明挂件' },
      ],
    },
    {
      label: '平台与底层',
      items: [
        { id: 'harness', href: 'harness.html', icon: 'terminal', label: 'Harness · Agents' },
        { id: 'providers', href: 'providers.html', icon: 'cpu', label: '模型与服务商' },
        { id: 'plugins', href: 'plugins.html', icon: 'puzzle', label: '扩展与权限' },
      ],
    },
  ];

  const WHALE_SVG = `<svg style="width:22px;height:22px;flex-shrink:0" viewBox="0 0 24 24" fill="none"><path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" fill="var(--blue)" opacity=".28"/><path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" stroke="var(--blue)" stroke-width="1.55" stroke-linejoin="round"/><circle cx="17.5" cy="10.5" r="1" fill="var(--blue)"/></svg>`;

  function injectExtraStyles() {
    if (document.getElementById('wb-shell-extra')) return;
    const style = document.createElement('style');
    style.id = 'wb-shell-extra';
    style.textContent = `
      .wb-char-btn {
        margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 8px; border-radius: 980px; font-size: 11px; font-weight: 550;
        border: 1px solid var(--stroke); background: var(--surface); color: var(--text-2);
        transition: all var(--dur-hover) var(--ease);
      }
      .wb-char-btn:hover { border-color: var(--blue-line); color: var(--blue); background: var(--blue-dim); }
      .wb-split-ctrl {
        display: inline-flex; align-items: center; border-radius: 980px;
        border: 1px solid var(--stroke); background: var(--surface); position: relative;
        transition: border-color var(--dur-hover) var(--ease);
      }
      .wb-split-ctrl.running { border-color: var(--red-line); background: var(--red-dim); }
      .wb-split-ctrl.idle { border-color: var(--green-line); background: var(--green-dim); }
      .wb-split-game {
        display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px 5px 11px;
        border: none; background: transparent; color: var(--text-1); font-size: 11.5px; font-weight: 600;
        border-right: 1px solid var(--stroke); border-radius: 980px 0 0 980px;
      }
      .wb-split-game:hover { background: color-mix(in srgb, var(--text-1) 6%, transparent); }
      .wb-split-act {
        display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px 5px 10px;
        border: none; background: transparent; font-size: 11.5px; font-weight: 600;
        border-radius: 0 980px 980px 0;
      }
      .wb-split-ctrl.running .wb-split-act { color: var(--red); }
      .wb-split-ctrl.idle .wb-split-act { color: var(--green); }
      .wb-pop-menu {
        position: absolute; top: calc(100% + 6px); left: 0; min-width: 158px; z-index: 90;
        padding: 5px; border-radius: var(--r-md); background: var(--bg-elev);
        border: 1px solid var(--stroke-2); box-shadow: var(--shadow-2); display: none;
      }
      .wb-pop-menu.open { display: block; }
      .wb-pop-item {
        display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px;
        border: none; background: transparent; color: var(--text-2); font-size: 12px;
        border-radius: var(--r-sm); text-align: left;
      }
      .wb-pop-item:hover { background: var(--surface-2); color: var(--text-1); }
      .wb-pop-item.on { background: var(--blue-dim); color: var(--blue); font-weight: 600; }
    `;
    document.head.appendChild(style);
  }

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
      <div class="wb-brand" style="position:relative">
        <a href="index.html" title="返回设计系统总览" style="display:flex;align-items:center;gap:9px;text-decoration:none;color:inherit">
          ${WHALE_SVG}
          <span class="t">鲸屿</span>
        </a>
        <button class="wb-char-btn" id="wb-char-btn" title="快速切换当前陪伴角色"></button>
        <div class="wb-pop-menu" id="wb-char-menu" style="right:12px;left:auto"></div>
      </div>
      <div class="wb-nav-scroll">${groupsHtml}</div>
      <div class="wb-side-foot">
        <div class="wb-rice-row">
          <span style="display:flex;align-items:center;gap:6px"><i data-lucide="wheat" class="sm" style="color:var(--amber)"></i>赛博饭碗</span>
          <b id="wb-rice-val">16,370 粒</b>
        </div>
        <div class="wb-rice-bar"><i id="wb-rice-bar" style="width:16%"></i></div>
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
      <div class="wb-crumb">${crumbParent} <i data-lucide="chevron-right" class="xs"></i> <b id="wb-crumb-title">${crumbTitle}</b></div>
      <button class="wb-search-btn" id="wb-open-cmdk"><i data-lucide="search" class="xs"></i><span>快速跳转 / 指令…</span><kbd>⌘K</kbd></button>
      <div class="sp"></div>
      <button class="wb-ctrl" id="wb-ctrl-voice" title="切换全局语音播报"></button>
      <button class="wb-ctrl" id="wb-ctrl-brain" title="点击热切 LLM 大脑 / 本地规则兜底"></button>
      <div class="wb-split-ctrl" id="wb-split-drive">
        <button class="wb-split-game" id="wb-game-pick" title="切换当前接管游戏"></button>
        <button class="wb-split-act" id="wb-ctrl-drive" title="启停当前游戏自动驾驶"></button>
        <div class="wb-pop-menu" id="wb-game-menu"></div>
      </div>
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
    items.push({ id: 'index', href: 'index.html', icon: 'sparkles', label: '设计系统总览', group: '设计规范' });

    mask.innerHTML = `
      <div class="wb-cmdk">
        <div class="wb-cmdk-head">
          <i data-lucide="search" class="sm" style="color:var(--blue)"></i>
          <input id="wb-cmdk-input" placeholder="输入页面名称，如 游戏共玩、模型、记忆、声音…">
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); window.wbOpenCmdK(); }
      else if (e.key === 'Escape') { mask.classList.remove('open'); }
    });
  }

  function syncShellControls() {
    const vBtn = document.getElementById('wb-ctrl-voice');
    const bBtn = document.getElementById('wb-ctrl-brain');
    const splitBox = document.getElementById('wb-split-drive');
    const gPick = document.getElementById('wb-game-pick');
    const dBtn = document.getElementById('wb-ctrl-drive');
    const gMenu = document.getElementById('wb-game-menu');
    const cBtn = document.getElementById('wb-char-btn');
    const cMenu = document.getElementById('wb-char-menu');
    const rVal = document.getElementById('wb-rice-val');
    const rBar = document.getElementById('wb-rice-bar');

    const g = GAMES[state.activeGame] || GAMES.stardew;

    if (cBtn && cMenu) {
      cBtn.innerHTML = `<span>${state.activeChar}</span><i data-lucide="chevron-down" class="xs"></i>`;
      cMenu.innerHTML = CHARS.map((c) => `
        <button class="wb-pop-item${c.id === state.activeChar ? ' on' : ''}" data-pick-char="${c.id}">
          <i data-lucide="fish" class="xs"></i>
          <span>${c.id}</span>
          <span style="margin-left:auto;font-size:10px;color:var(--text-3)">${c.sub}</span>
        </button>`).join('');
      cMenu.querySelectorAll('[data-pick-char]').forEach((el) => {
        el.addEventListener('click', () => {
          cMenu.classList.remove('open');
          window.wbState.patch({ activeChar: el.dataset.pickChar });
          window.wbToast(`已切换当前角色为「${el.dataset.pickChar}」`);
        });
      });
    }

    if (vBtn) {
      vBtn.className = 'wb-ctrl ' + (state.voiceOn ? 'on-green' : '');
      vBtn.innerHTML = `<i data-lucide="${state.voiceOn ? 'volume-2' : 'volume-x'}" class="xs"></i><span>${state.voiceOn ? '语音开' : '已静音'}</span>`;
    }
    if (bBtn) {
      const isLlm = state.brainMode === 'llm';
      bBtn.className = 'wb-ctrl ' + (isLlm ? 'on-violet' : '');
      bBtn.innerHTML = `<i data-lucide="brain" class="xs"></i><span>${isLlm ? 'LLM · ' + state.brainModel : '本地规则兜底'}</span>`;
    }
    if (splitBox && gPick && dBtn && gMenu) {
      splitBox.className = 'wb-split-ctrl ' + (state.autodrive ? 'running' : 'idle');
      gPick.innerHTML = `<i data-lucide="${g.icon}" class="xs" style="color:var(--blue)"></i><span>${g.name}</span><i data-lucide="chevron-down" class="xs" style="opacity:.6"></i>`;
      dBtn.innerHTML = `<i data-lucide="${state.autodrive ? 'square' : 'play'}" class="xs"></i><span>${state.autodrive ? '停止自驾' : '启动自驾'}</span>`;
      gMenu.innerHTML = Object.entries(GAMES).map(([id, info]) => `
        <button class="wb-pop-item${id === state.activeGame ? ' on' : ''}" data-pick-game="${id}">
          <i data-lucide="${info.icon}" class="xs"></i><span>${info.full}</span>
        </button>`).join('');
      gMenu.querySelectorAll('[data-pick-game]').forEach((el) => {
        el.addEventListener('click', () => {
          gMenu.classList.remove('open');
          const gid = el.dataset.pickGame;
          window.wbState.patch({ activeGame: gid });
          window.wbToast(`当前共玩目标已切换为「${GAMES[gid].full}」`);
        });
      });
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
      injectExtraStyles();
      document.body.classList.add('wb-shell');
      if (!document.querySelector('.ambient')) {
        const amb = document.createElement('div');
        amb.className = 'ambient';
        document.body.prepend(amb);
      }
      const crumbParent = document.body.dataset.wbGroup || '鲸屿';
      const crumbTitle = document.body.dataset.wbTitle || document.title;
      document.body.prepend(buildTopbar(crumbParent, crumbTitle));
      document.body.prepend(buildSidebar(pageId));
      buildCmdK();

      document.getElementById('wb-open-cmdk')?.addEventListener('click', () => window.wbOpenCmdK());
      document.getElementById('wb-ctrl-voice')?.addEventListener('click', () => {
        const next = !state.voiceOn;
        window.wbState.patch({ voiceOn: next });
        window.wbToast(next ? `语音已开启（${state.activeVoice}）` : '语音已静音，仅保留气泡字幕');
      });
      document.getElementById('wb-ctrl-brain')?.addEventListener('click', () => {
        const next = state.brainMode === 'llm' ? 'rule' : 'llm';
        window.wbState.patch({ brainMode: next });
        window.wbToast(next === 'llm' ? `已切换至 LLM 大脑（${state.brainModel}）` : '已切回本地规则兜底');
      });
      document.getElementById('wb-ctrl-drive')?.addEventListener('click', () => {
        const next = !state.autodrive;
        const g = GAMES[state.activeGame] || GAMES.stardew;
        window.wbState.patch({ autodrive: next });
        window.wbToast(next ? `已启动《${g.full}》自动驾驶` : `已停止《${g.full}》自动驾驶`);
      });
      document.getElementById('wb-game-pick')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('wb-game-menu')?.classList.toggle('open');
        document.getElementById('wb-char-menu')?.classList.remove('open');
      });
      document.getElementById('wb-char-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('wb-char-menu')?.classList.toggle('open');
        document.getElementById('wb-game-menu')?.classList.remove('open');
      });
      document.addEventListener('click', () => {
        document.getElementById('wb-game-menu')?.classList.remove('open');
        document.getElementById('wb-char-menu')?.classList.remove('open');
      });
      document.getElementById('wb-feed-btn')?.addEventListener('click', () => {
        const nextRice = Math.min(state.riceCap, state.rice + 5000);
        window.wbState.patch({ rice: nextRice });
        window.wbToast(`已投喂 +5,000 粒米（余额 ${nextRice.toLocaleString()} 粒）`);
      });

      syncShellControls();
    } else if (window.lucide) {
      window.lucide.createIcons();
    }
  });
})();
