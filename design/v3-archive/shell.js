/* 设计稿共享：lucide 图标初始化 + 深浅主题切换（localStorage 持久） */
(function () {
  const saved = localStorage.getItem('wb-theme');
  if (saved === 'light') document.documentElement.classList.remove('dark');
  else document.documentElement.classList.add('dark');

  window.wbToggleTheme = function () {
    const root = document.documentElement;
    root.classList.toggle('dark');
    localStorage.setItem('wb-theme', root.classList.contains('dark') ? 'dark' : 'light');
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      const name = root.classList.contains('dark') ? 'sun' : 'moon';
      el.setAttribute('data-lucide', name);
    });
    if (window.lucide) window.lucide.createIcons();
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide) window.lucide.createIcons();
  });
})();
