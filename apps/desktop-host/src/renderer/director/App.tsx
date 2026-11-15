import { useEffect, useState } from 'react';
import type { DiningProfilePreset, ModelProviderConfig, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';

/**
 * 中控台模型配置页（T-M1-05，CC Switch/Magpie 风格）：
 *   顶部 3 个干饭套餐胶囊（一键切换 → Dexie 持久）
 *   中部 6 槽位绑定（Magpie 单屏 6 角色）
 *   底部供应商预设卡（Region/Plan 胶囊 + 掩码 Key）
 */

const SLOT_ORDER: WorkbenchRoleSlot[] = [
  'MAIN_PERSONA_BRAIN',
  'STARDEW_GAME_PLANNER',
  'DANMAKU_FAST_ROUTER',
  'VISION_STORYBOARD',
  'VOICE_TTS_SPEECH',
  'VOICE_SVC_SINGING',
];

interface AppProps {
  profiles: DiningProfilePreset[];
  slotLabels: Record<WorkbenchRoleSlot, string>;
  providers: ModelProviderConfig[];
  store: DirectorStore;
  storeKey: string;
}

export function App({ profiles, slotLabels, providers, store, storeKey }: AppProps): React.JSX.Element {
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // 启动 hydrate：Dexie 快照恢复（断电/重启后状态不丢）
  useEffect(() => {
    void store.getConfig<string>(storeKey).then((stored) => {
      setActiveProfileId(stored ?? profiles[0]?.profileId ?? null);
      setHydrated(true);
    });
  }, [profiles, store, storeKey]);

  const activeProfile = profiles.find((profile) => profile.profileId === activeProfileId) ?? profiles[0];

  const switchProfile = (profileId: string): void => {
    setActiveProfileId(profileId);
    void store.setConfig(storeKey, profileId); // 套餐胶囊一键切换 → Dexie 即时同步
  };

  if (!hydrated || !activeProfile) {
    return <div className="p-6 text-slate-400">饭碗加载中……</div>;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <header className="px-6 pt-5 pb-3 border-b border-slate-800">
        <h1 className="text-lg font-bold">🐟 大肥鱼中控台 · 模型配置</h1>
        <p className="text-xs text-slate-400 mt-1">CC Switch 预设 × Magpie 六槽位 · 100% 本地优先</p>
      </header>

      {/* 干饭套餐胶囊 */}
      <section className="px-6 py-4">
        <h2 className="text-sm font-semibold text-slate-300 mb-2">干饭套餐</h2>
        <div className="flex gap-3">
          {profiles.map((profile) => {
            const active = profile.profileId === activeProfile.profileId;
            return (
              <button
                key={profile.profileId}
                data-profile={profile.profileId}
                data-active={active ? 'true' : 'false'}
                onClick={() => switchProfile(profile.profileId)}
                className={`px-4 py-2 rounded-full border text-sm transition-colors ${
                  active
                    ? 'border-amber-400 bg-amber-400/15 text-amber-300 font-semibold'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                }`}
              >
                {profile.displayName}
              </button>
            );
          })}
        </div>
      </section>

      {/* Magpie 六槽位 */}
      <section className="px-6 py-4">
        <h2 className="text-sm font-semibold text-slate-300 mb-2">六槽位绑定（{activeProfile.displayName}）</h2>
        <div className="grid grid-cols-2 gap-3">
          {SLOT_ORDER.map((slot) => (
            <div key={slot} data-slot={slot} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="text-xs text-slate-400">{slotLabels[slot]}</div>
              <div className="text-sm font-mono text-sky-300 mt-1" data-binding={slot}>
                {activeProfile.roleBindings[slot] ?? '（未绑定）'}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 供应商预设卡（CC Switch 风格：Region/Plan 胶囊 + 掩码 Key） */}
      <section className="px-6 py-4 pb-8">
        <h2 className="text-sm font-semibold text-slate-300 mb-2">供应商预设库</h2>
        <div className="grid grid-cols-3 gap-3">
          {providers.map((provider) => (
            <div key={provider.id} data-provider={provider.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{provider.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                  {provider.category}
                </span>
              </div>
              <div className="flex gap-1 mt-2">
                {provider.variants.map((variant) => (
                  <span
                    key={`${variant.region}-${variant.planType}`}
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      variant.region === provider.activeRegion && variant.planType === provider.activePlanType
                        ? 'bg-sky-500/20 text-sky-300'
                        : 'bg-slate-800 text-slate-500'
                    }`}
                  >
                    {variant.region}/{variant.planType === 'PAY_AS_YOU_GO' ? '按量' : variant.planType === 'CODING_PLAN' ? '套餐' : variant.planType === 'LOCAL_GPU' ? '本地' : '免费'}
                  </span>
                ))}
              </div>
              <div className="text-[10px] text-slate-500 mt-2 font-mono">
                Key: {provider.apiKeyMaskedOrRef === '' ? '未配置' : provider.apiKeyMaskedOrRef}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
