/**
 * 动作库预览页（T-M5-16，D16）：11 语义槽位卡 + ambientPool 分类网格，
 * 点击任一动作 → 主进程转发 → 桌宠窗立即播放预览 6s 回 idle。
 * 素材零闲置：114 clips 全部可见可点。
 */
import { useEffect, useMemo, useState } from 'react';

interface PetClip {
  clipId: string;
  webmPath: string;
}
interface PetAction {
  actionState: string;
  clips: PetClip[];
}
interface AmbientEntry {
  clipId: string;
  webmPath: string;
  category: string;
  weight: number;
}
interface PetManifestView {
  petId: string;
  actions: PetAction[];
  ambientPool: AmbientEntry[];
}

const ACTION_LABELS: Record<string, string> = {
  idle: '待机呼吸', walk: '漫游走动', eat_rice: '干饭吃米', happy_maid: '开心女仆礼',
  thinking_tail_wag: '歪头思考', rage_spray: '喷水抗议', clumsy_panic: '心虚冒汗',
  game_focus: '游戏专注', sing_stage: '唱歌表演', hungry_lazy: '饿瘪瘫倒', sleep_mute: '睡觉静音',
};

const CATEGORY_ORDER = ['吃', '玩', '时节', '余额', '小动作', '文字', '睡眠接力'];

export function PetsPanel(): React.JSX.Element {
  const [manifest, setManifest] = useState<PetManifestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [tab, setTab] = useState<'slots' | 'ambient'>('slots');

  useEffect(() => {
    void window.directorBridge.petsManifest().then((res) => {
      if (res.ok && res.manifest) setManifest(res.manifest as PetManifestView);
      else setError(res.error ?? 'manifest 未就绪（需重新 build 拷贝素材）');
    });
  }, []);

  const ambientByCategory = useMemo(() => {
    const map = new Map<string, AmbientEntry[]>();
    for (const entry of manifest?.ambientPool ?? []) {
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return [...map.entries()].sort(
      (a, b) => (CATEGORY_ORDER.indexOf(a[0]) + 100) % 100 - ((CATEGORY_ORDER.indexOf(b[0]) + 100) % 100),
    );
  }, [manifest]);

  const preview = (action: string, clipId: string | null): void => {
    void window.directorBridge.petsPreview(action, clipId);
    setPreviewing(clipId ?? action);
    setTimeout(() => setPreviewing(null), 6000);
  };

  const totalClips = (manifest?.actions.reduce((s, a) => s + a.clips.length, 0) ?? 0) + (manifest?.ambientPool.length ?? 0);

  if (error) {
    return <div className="p-6 text-rose-300 text-xs" data-pets-error>{error}</div>;
  }
  if (!manifest) {
    return <div className="p-6 text-slate-400 text-xs">动作库加载中……</div>;
  }

  return (
    <div className="p-5 pb-10">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-sm font-semibold text-slate-300">动作库 · {manifest.petId}</h2>
        <span className="text-[10px] text-slate-500 font-mono">{totalClips} clips（槽位 {(manifest.actions.reduce((s, a) => s + a.clips.length, 0))} + 氛围池 {manifest.ambientPool.length}）· 点击预览 → 桌宠窗即播</span>
        <div className="ml-auto flex gap-1">
          <button data-pets-tab="slots" data-active={tab === 'slots' ? 'true' : 'false'} onClick={() => setTab('slots')}
            className={`px-3 py-1 rounded-lg text-xs ${tab === 'slots' ? 'bg-sky-500/15 text-sky-300' : 'text-slate-400'}`}>语义槽位</button>
          <button data-pets-tab="ambient" data-active={tab === 'ambient' ? 'true' : 'false'} onClick={() => setTab('ambient')}
            className={`px-3 py-1 rounded-lg text-xs ${tab === 'ambient' ? 'bg-sky-500/15 text-sky-300' : 'text-slate-400'}`}>氛围池（{manifest.ambientPool.length}）</button>
        </div>
      </div>

      {tab === 'slots' && (
        <div className="grid grid-cols-3 gap-3" data-pets-slots>
          {manifest.actions.map((action) => (
            <div key={action.actionState} data-slot-card={action.actionState} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="text-xs text-slate-400 font-semibold">{ACTION_LABELS[action.actionState] ?? action.actionState}</div>
              <div className="text-[10px] text-slate-600 font-mono">{action.actionState} · {action.clips.length} clips</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {action.clips.map((clip) => (
                  <button
                    key={clip.clipId}
                    onClick={() => preview(action.actionState, clip.clipId)}
                    data-clip={clip.clipId}
                    className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                      previewing === clip.clipId
                        ? 'border-emerald-400 bg-emerald-400/10 text-emerald-300'
                        : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-sky-500/50'
                    }`}
                  >
                    {clip.clipId}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'ambient' && (
        <div className="space-y-4" data-pets-ambient>
          {ambientByCategory.map(([category, entries]) => (
            <div key={category} data-ambient-category={category}>
              <div className="text-xs text-slate-400 font-semibold mb-2">{category} <span className="text-slate-600 font-mono">× {entries.length} · 权重 {entries[0]?.weight}</span></div>
              <div className="flex flex-wrap gap-1.5">
                {entries.map((entry) => (
                  <button
                    key={entry.clipId}
                    onClick={() => preview('idle', entry.clipId)}
                    data-clip={entry.clipId}
                    className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                      previewing === entry.clipId
                        ? 'border-emerald-400 bg-emerald-400/10 text-emerald-300'
                        : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-sky-500/50'
                    }`}
                  >
                    {entry.clipId}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 text-[10px] text-slate-600 leading-relaxed">
        映射三层（事件唯一事实源 → 动作）：情绪五档（傲娇→喷水/开心→女仆礼…）｜游戏回执（UNCERTAIN→心虚冒汗、钓鱼收获→开心…）｜饭碗档位（&lt;15% 饿瘪瘫倒、投喂→开吃）。
        空闲 30s 自动随机播氛围池一条（{manifest.ambientPool.filter((e) => e.weight > 0).length} 条可达）。
      </div>
    </div>
  );
}
