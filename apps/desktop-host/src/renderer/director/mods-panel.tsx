/**
 * 星露谷 Mod 管理页（T-M6-06）：只读扫描 + 启停 + 目录内安装。
 * 交互：目录候选一键切换 → 列表开关（manifest.json ↔ manifest.json.disabled）→ 重新扫描刷新。
 * 危险边界：所有操作都限定在玩家 Mods 目录内（主进程校验单段目录名，防路径穿越）。
 */
import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Package, RefreshCw, Upload } from 'lucide-react';
import type { ModsOpView, ModsSnapshotView, ModsStateView } from './bridge';

interface Candidate {
  path: string;
  exists: boolean;
}

export function ModsPanel(): React.JSX.Element {
  const [state, setState] = useState<ModsStateView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const next = await window.directorBridge.modsState();
    setState(next);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const snapshot: ModsSnapshotView | null = state?.snapshot ?? null;
  const candidates: Candidate[] = state?.candidates ?? [];

  const apply = async (label: string, action: () => Promise<ModsOpView & { folderName?: string }>): Promise<void> => {
    setBusy(label);
    setNotice(null);
    const res = await action();
    setBusy(null);
    if (!res.ok) {
      setNotice(`操作失败：${res.error ?? '未知错误'}`);
      return;
    }
    await load();
    setNotice(res.folderName === undefined ? '已刷新' : `已安装：${res.folderName}（重启游戏后生效）`);
  };

  const toggle = async (folderName: string, enabled: boolean): Promise<void> => {
    setBusy(`toggle:${folderName}`);
    setNotice(null);
    const res = await window.directorBridge.modsToggle(folderName, enabled);
    setBusy(null);
    if (!res.ok) {
      setNotice(`启停失败：${res.error ?? '未知错误'}`);
      return;
    }
    await load();
    setNotice(`${enabled ? '已启用' : '已停用'} ${folderName}（下次启动游戏生效）`);
  };

  const openDir = async (): Promise<void> => {
    const res = await window.directorBridge.modsOpenDir();
    if (!res.ok) setNotice(`打开目录失败：${res.error ?? '未知错误'}`);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Package size={18} /> 星露谷 Mod 管理
          </h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            SMAPI 目录约定：停用 = manifest.json 改名 .disabled；改动在下次启动游戏时生效
          </p>
        </div>
        <div className="flex items-center gap-2">
          {snapshot !== null && snapshot.smapiVersion !== '' && (
            <span className="pill pill-violet">SMAPI {snapshot.smapiVersion}</span>
          )}
          <button
            onClick={() => void load()}
            className="pill"
            style={{ border: '1px solid var(--stroke-2)', background: 'var(--surface)' }}
            title="重新扫描"
          >
            <RefreshCw size={13} /> 刷新
          </button>
          <button
            onClick={() => void openDir()}
            className="pill"
            style={{ border: '1px solid var(--stroke-2)', background: 'var(--surface)' }}
          >
            <FolderOpen size={13} /> 打开目录
          </button>
          <button
            onClick={() => void apply('install', () => window.directorBridge.modsInstallZip())}
            className="pill pill-blue"
            disabled={busy !== null}
          >
            <Upload size={13} /> {busy === 'install' ? '安装中…' : '安装 ZIP'}
          </button>
        </div>
      </header>

      {/* 目录区：当前路径 + 平台候选 */}
      <section
        className="mb-4 rounded-2xl p-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--stroke-2)', backdropFilter: 'blur(20px)' }}
      >
        <div className="mono flex items-center justify-between gap-3 text-[11px]" style={{ color: 'var(--text-2)' }}>
          <span className="truncate" title={snapshot?.modsDir ?? ''}>
            {snapshot?.modsDir !== undefined && snapshot.modsDir !== '' ? snapshot.modsDir : '未找到 Mods 目录'}
          </span>
          {state?.configured === true ? (
            <span className="shrink-0" style={{ color: 'var(--green)' }}>自定义路径</span>
          ) : (
            <span className="shrink-0">自动探测</span>
          )}
        </div>
        {candidates.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {candidates.map((c) => {
              const active = snapshot?.modsDir === c.path;
              return (
                <button
                  key={c.path}
                  onClick={() => void apply(`dir:${c.path}`, () => window.directorBridge.modsSetDir(c.path))}
                  className="mono rounded-full px-2.5 py-1 text-[10px]"
                  style={{
                    border: `1px solid ${active ? 'var(--blue-line)' : 'var(--stroke-2)'}`,
                    background: active ? 'var(--blue-dim)' : 'transparent',
                    color: active ? 'var(--blue)' : c.exists ? 'var(--text-2)' : 'var(--text-3)',
                  }}
                  title={c.path}
                >
                  {c.exists ? '●' : '○'} {c.path.split('/').slice(-2).join('/')}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {notice !== null && (
        <div className="mono mb-4 rounded-xl px-3 py-2 text-[11px]" style={{ background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid var(--amber-line)' }}>
          {notice}
        </div>
      )}

      {/* Mod 列表 */}
      {snapshot === null || !snapshot.exists ? (
        <div className="rounded-2xl px-6 py-10 text-center text-sm" style={{ background: 'var(--surface)', border: '1px dashed var(--stroke-2)', color: 'var(--text-2)' }}>
          没有找到 Mods 目录。先安装 SMAPI，或点上方候选路径手动指定星露谷游戏目录下的 Mods 文件夹。
        </div>
      ) : snapshot.mods.length === 0 ? (
        <div className="rounded-2xl px-6 py-10 text-center text-sm" style={{ background: 'var(--surface)', border: '1px dashed var(--stroke-2)', color: 'var(--text-2)' }}>
          Mods 目录是空的——点「安装 ZIP」装第一个 Mod，或把解压好的 Mod 文件夹拖进去再刷新。
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {snapshot.mods.map((mod) => (
            <div
              key={mod.folderName}
              data-mod={mod.folderName}
              className="flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--stroke-2)',
                opacity: mod.enabled ? 1 : 0.62,
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold" style={{ color: 'var(--text-1)' }}>{mod.name}</span>
                  {mod.version !== '' && (
                    <span className="mono rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--inset)', color: 'var(--text-2)' }}>
                      v{mod.version}
                    </span>
                  )}
                  {mod.contentType !== '' && (
                    <span className="mono rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--violet-dim)', color: 'var(--violet)' }}>
                      {mod.contentType}
                    </span>
                  )}
                </div>
                <div className="mono mt-1 truncate text-[10px]" style={{ color: 'var(--text-3)' }} title={mod.uniqueId}>
                  {mod.folderName}
                  {mod.author !== '' ? ` · ${mod.author}` : ''}
                  {mod.uniqueId !== '' ? ` · ${mod.uniqueId}` : ''}
                  {mod.minimumApiVersion !== '' ? ` · 需 SMAPI ≥ ${mod.minimumApiVersion}` : ''}
                </div>
                {mod.parseError !== '' && (
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--amber)' }}>{mod.parseError}</div>
                )}
              </div>
              <button
                onClick={() => void toggle(mod.folderName, !mod.enabled)}
                disabled={busy !== null || mod.parseError !== ''}
                aria-pressed={mod.enabled}
                className="mono shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors"
                style={{
                  border: `1px solid ${mod.enabled ? 'var(--green-line)' : 'var(--stroke-2)'}`,
                  background: mod.enabled ? 'var(--green-dim)' : 'transparent',
                  color: mod.enabled ? 'var(--green)' : 'var(--text-2)',
                  opacity: busy === `toggle:${mod.folderName}` ? 0.5 : 1,
                }}
              >
                {busy === `toggle:${mod.folderName}` ? '处理中…' : mod.enabled ? '已启用' : '已停用'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
