/** aboutme-pets 角色包商店（T-M6-41）：9 包状态、单包/全量导入、进度；素材仅落 userData。 */
import { useEffect, useState } from 'react';
import { Check, Download, Loader2, PackageOpen, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PetPackCatalogItem, PetPackImportProgress } from './bridge';

export function CharacterPackStore({ onImported }: { onImported?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<PetPackCatalogItem[]>([]);
  const [progress, setProgress] = useState<Record<string, PetPackImportProgress>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const list = await window.directorBridge.petPackCatalog().catch(() => []);
    setCatalog(list);
  };
  useEffect(() => {
    if (!open) return;
    void load();
    return window.directorBridge.onPetPackImportProgress((event) => {
      setProgress((previous) => ({ ...previous, [event.packId]: event }));
    });
  }, [open]);

  const run = async (input: { all?: boolean; packSlugs?: string[] }, key: string): Promise<void> => {
    setBusy(key);
    try {
      const result = await window.directorBridge.petPackImport(input);
      if (!result.ok) toast.error(result.error ?? `导入失败：${result.failed?.map((item) => `${item.slug}:${item.error}`).join('；') ?? ''}`);
      else toast.success(`已导入 ${result.imported?.length ?? 0} 套角色包`);
      if (result.catalog !== undefined) setCatalog(result.catalog);
      await load();
      window.dispatchEvent(new CustomEvent('pet:characters-changed'));
      onImported?.();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" className="btn-pill ghost" onClick={() => setOpen(true)} data-pet-pack-store>
        <PackageOpen size={11} />角色包商店
      </button>
      {open && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.52)', backdropFilter: 'blur(6px)' }} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="pack-store-title" className="card w-full max-w-[720px] p-5" style={{ boxShadow: 'var(--shadow-2)' }}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 id="pack-store-title" className="text-[15px] font-semibold">aboutme-pets 角色包商店</h3>
                <p className="mt-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>9 套角色包 · 素材仅下载到 userData，不进入 Git / 安装包 · CC BY-NC-SA 4.0</p>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭角色包商店" onClick={() => setOpen(false)}><X size={13} /></button>
            </div>
            <div className="mb-3 flex justify-end">
              <button type="button" className="btn-pill primary" disabled={busy !== null} onClick={() => void run({ all: true }, 'all')}>
                {busy === 'all' ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}一键导入全部 9 套
              </button>
            </div>
            <div className="grid max-h-[58vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
              {catalog.map((pack) => {
                const state = progress[pack.catalogId] ?? progress[pack.slug];
                const pct = state !== undefined && state.total > 0 ? Math.round((state.completed / state.total) * 100) : null;
                return (
                  <div key={pack.slug} className="card px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[12px] font-semibold">{pack.displayName}</div>
                        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-3)' }}>{pack.installed ? `${pack.actionCount} 动作 · ${pack.audioClipCount} 音轨` : '未安装'} · {pack.voiceId}</div>
                      </div>
                      {pack.installed ? <Check size={14} style={{ color: 'var(--green)' }} /> : (
                        <button type="button" className="btn-pill ghost" style={{ fontSize: 10 }} disabled={busy !== null} onClick={() => void run({ packSlugs: [pack.slug] }, pack.slug)}>
                          {busy === pack.slug ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}导入
                        </button>
                      )}
                    </div>
                    {pct !== null && !pack.installed && (
                      <div className="mt-2">
                        <div className="h-[4px] overflow-hidden rounded-full" style={{ background: 'var(--inset)' }}>
                          <i className="block h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: 'var(--blue)' }} />
                        </div>
                        <div className="mt-1 truncate text-[9.5px]" style={{ color: 'var(--text-3)' }}>{state?.message}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
