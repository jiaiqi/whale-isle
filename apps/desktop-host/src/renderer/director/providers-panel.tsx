/**
 * 供应商配置页（T-dir-01 完整迁移自 App.tsx，Shell 化重构）：Magpie 单屏。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiningProfilePreset, ModelProviderConfig, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';

const SLOT_ORDER: WorkbenchRoleSlot[] = [
  'MAIN_PERSONA_BRAIN',
  'STARDEW_GAME_PLANNER',
  'DANMAKU_FAST_ROUTER',
  'VISION_STORYBOARD',
  'VOICE_TTS_SPEECH',
  'VOICE_SVC_SINGING',
];

interface ProviderOverride {
  keyMask?: string;
  discoveredModels?: string[];
  activeModelId?: string;
  activeRegion?: ModelProviderConfig['activeRegion'];
  activePlanType?: ModelProviderConfig['activePlanType'];
}
type ProviderOverrides = Record<string, ProviderOverride>;
type UiProvider = Omit<ModelProviderConfig, 'discoveredModels'> & { discoveredModels: string[] };

const OVERRIDES_KEY = 'providerOverrides';
const DINING_KEY = 'diningProfiles';

interface Props {
  profiles: DiningProfilePreset[];
  slotLabels: Record<WorkbenchRoleSlot, string>;
  providers: ModelProviderConfig[];
  store: DirectorStore;
}

export function ProvidersPanel({ profiles, slotLabels, providers, store }: Props): React.JSX.Element {
  const [profileList, setProfileList] = useState<DiningProfilePreset[]>(profiles);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<ProviderOverrides>({});
  const [hydrated, setHydrated] = useState(false);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});

  useEffect(() => {
    void Promise.all([
      store.getConfig<string>('activeDiningProfile'),
      store.getConfig<ProviderOverrides>(OVERRIDES_KEY),
      store.getConfig<DiningProfilePreset[]>(DINING_KEY),
    ]).then(([storedProfile, storedOverrides, storedProfiles]) => {
      setActiveProfileId(storedProfile ?? profiles[0]?.profileId ?? null);
      setOverrides(storedOverrides ?? {});
      if (storedProfiles !== undefined && storedProfiles.length > 0) setProfileList(storedProfiles);
      setHydrated(true);
    });
  }, [profiles, store]);

  const persistOverrides = useCallback(
    (next: ProviderOverrides) => {
      setOverrides(next);
      void store.setConfig(OVERRIDES_KEY, next);
    },
    [store],
  );

  const merged = useMemo<UiProvider[]>(
    () =>
      providers.map((provider) => {
        const o = overrides[provider.id] ?? {};
        return {
          ...provider,
          apiKeyMaskedOrRef: o.keyMask ?? provider.apiKeyMaskedOrRef,
          activeRegion: o.activeRegion ?? provider.activeRegion,
          activePlanType: o.activePlanType ?? provider.activePlanType,
          activeModelId: o.activeModelId ?? '',
          discoveredModels: o.discoveredModels ?? provider.discoveredModels.map((m) => m.id),
        };
      }),
    [providers, overrides],
  );

  const activeProfile = profileList.find((p) => p.profileId === activeProfileId) ?? profileList[0];
  /** 套餐/槽位/激活模型变化 → 主进程 gateway 热重建（key 只留在主进程 vault） */
  const syncBrain = (profile: DiningProfilePreset | undefined, o: ProviderOverrides): void => {
    if (profile === undefined) return;
    const providerModels = Object.fromEntries(
      Object.entries(o)
        .map(([id, x]) => [id, x.activeModelId ?? ''] as const)
        .filter(([, model]) => model !== ''),
    );
    void window.directorBridge.brainApplyConfig({ profile, providerModels }).then((r) => {
      window.dispatchEvent(new CustomEvent('wb:brain', { detail: { mode: r.mode, llmReady: r.llmReady } }));
      setNotices((n) => ({
        ...n,
        brain: r.ok
          ? `大脑已应用：${r.providers.join(' / ') || '—'}${r.missingKeys.length > 0 ? `（缺 Key：${r.missingKeys.join(', ')}）` : ''}`
          : `大脑回落规则：${r.error ?? '未知错误'}`,
      }));
    });
  };

  const switchProfile = (profileId: string): void => {
    setActiveProfileId(profileId);
    void store.setConfig('activeDiningProfile', profileId);
    syncBrain(profileList.find((p) => p.profileId === profileId), overrides);
  };

  const bindSlot = (slot: WorkbenchRoleSlot, value: string): void => {
    if (!activeProfile) return;
    const next = profileList.map((p) =>
      p.profileId === activeProfile.profileId ? { ...p, roleBindings: { ...p.roleBindings, [slot]: value } } : p,
    );
    setProfileList(next);
    void store.setConfig(DINING_KEY, next);
    setNotices((n) => ({ ...n, [`slot-${slot}`]: '已保存' }));
    syncBrain(next.find((p) => p.profileId === activeProfile.profileId), overrides);
  };

  const setBusyFor = (id: string, what: string | null): void =>
    setBusy((b) => {
      const next = { ...b };
      if (what === null) delete next[id];
      else next[id] = what;
      return next;
    });

  const saveKey = async (provider: UiProvider): Promise<void> => {
    const draft = (keyDrafts[provider.id] ?? '').trim();
    if (draft === '') {
      setNotices((n) => ({ ...n, [provider.id]: '先粘贴 API Key' }));
      return;
    }
    setBusyFor(provider.id, 'save');
    const result = await window.directorBridge.saveProviderKey(provider.id, draft);
    setBusyFor(provider.id, null);
    if (!result.ok) {
      setNotices((n) => ({ ...n, [provider.id]: `错误：${result.error ?? '保存失败'}` }));
      return;
    }
    setKeyDrafts((d) => ({ ...d, [provider.id]: '' }));
    persistOverrides({ ...overrides, [provider.id]: { ...overrides[provider.id], keyMask: result.mask ?? '' } });
    setNotices((n) => ({ ...n, [provider.id]: '✅ Key 已加密保存' }));
    syncBrain(activeProfile, overrides);
  };

  const discover = async (provider: UiProvider): Promise<void> => {
    const variant = activeVariant(provider);
    setBusyFor(provider.id, 'discover');
    const result = await window.directorBridge.discoverModels({ providerId: provider.id, baseUrl: variant.baseUrl });
    setBusyFor(provider.id, null);
    const models = result.models;
    if (!result.ok || models === undefined) {
      setNotices((n) => ({ ...n, [provider.id]: `错误：拉模型失败：${result.error ?? '未知错误'}` }));
      return;
    }
    persistOverrides({
      ...overrides,
      [provider.id]: { ...overrides[provider.id], discoveredModels: models, activeModelId: overrides[provider.id]?.activeModelId ?? '' },
    });
    setNotices((n) => ({ ...n, [provider.id]: `✅ 发现 ${models.length} 个模型` }));
  };

  const testChat = async (provider: UiProvider): Promise<void> => {
    const modelId = overrides[provider.id]?.activeModelId ?? '';
    if (modelId === '') {
      setNotices((n) => ({ ...n, [provider.id]: '先选一个激活模型再测试' }));
      return;
    }
    const variant = activeVariant(provider);
    setBusyFor(provider.id, 'test');
    const result = await window.directorBridge.testProviderChat({ providerId: provider.id, baseUrl: variant.baseUrl, modelId });
    setBusyFor(provider.id, null);
    setNotices((n) => ({
      ...n,
      [provider.id]: result.ok ? `✅ 测试通过（${result.latencyMs ?? 0}ms）` : `错误：${result.error ?? '测试失败'}`,
    }));
  };

  const setOverrideFor = (providerId: string, patch: ProviderOverride): void => {
    const next = { ...overrides, [providerId]: { ...overrides[providerId], ...patch } };
    persistOverrides(next);
    if (patch.activeModelId !== undefined) syncBrain(activeProfile, next);
  };

  const slotOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [];
    for (const provider of merged) {
      for (const modelId of provider.discoveredModels) {
        options.push({ value: `${provider.id}/${modelId}`, label: `${provider.name} · ${modelId}` });
      }
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [merged]);

  if (!hydrated || !activeProfile) {
    return <div className="p-6 text-slate-400">配置加载中……</div>;
  }

  return (
    <div className="p-5 pb-10">
      {notices['brain'] !== undefined && (
        <div
          data-brain-notice
          className="mono mb-3 rounded-xl px-3 py-2 text-[11px]"
          style={{
            background: notices['brain'].startsWith('大脑已应用') ? 'var(--blue-dim)' : 'var(--amber-dim)',
            border: `1px solid ${notices['brain'].startsWith('大脑已应用') ? 'var(--blue-line)' : 'var(--amber-line)'}`,
            color: notices['brain'].startsWith('大脑已应用') ? 'var(--blue)' : 'var(--amber)',
          }}
        >
          {notices['brain']}
        </div>
      )}
      {/* 干饭套餐 */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">干饭套餐</h2>
        <div className="flex gap-3">
          {profileList.map((profile) => {
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

      {/* 六槽位 */}
      <section className="mt-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-2">六槽位绑定（{activeProfile.displayName}）</h2>
        <div className="grid grid-cols-2 gap-3">
          {SLOT_ORDER.map((slot) => {
            const binding = activeProfile.roleBindings[slot] ?? '';
            return (
              <div key={slot} data-slot={slot} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                <div className="text-xs text-slate-400">{slotLabels[slot]}</div>
                <div className="text-sm font-mono text-sky-300 mt-1" data-binding={slot}>
                  {binding === '' ? '（未绑定）' : binding}
                </div>
                <select
                  data-slot-select={slot}
                  value={binding}
                  onChange={(e) => bindSlot(slot, e.target.value)}
                  className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                >
                  <option value="">（未绑定）</option>
                  {slotOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {notices[`slot-${slot}`] && <div className="text-[10px] text-emerald-400 mt-1">{notices[`slot-${slot}`]}</div>}
              </div>
            );
          })}
        </div>
      </section>

      {/* 供应商卡 */}
      <section className="mt-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-2">供应商预设库</h2>
        <div className="grid grid-cols-2 gap-3">
          {merged.map((provider) => {
            const variant = activeVariant(provider);
            const isBusy = busy[provider.id];
            const notice = notices[provider.id];
            const hasKey = provider.apiKeyMaskedOrRef !== '';
            return (
              <div key={provider.id} data-provider={provider.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{provider.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{provider.category}</span>
                </div>
                <div className="flex gap-1 mt-2">
                  {provider.variants.map((v) => {
                    const selected = v.region === provider.activeRegion && v.planType === provider.activePlanType;
                    return (
                      <button
                        key={`${v.region}-${v.planType}`}
                        onClick={() => setOverrideFor(provider.id, { activeRegion: v.region, activePlanType: v.planType })}
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          selected
                            ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
                            : 'bg-slate-800 text-slate-500 border-slate-800 hover:text-slate-300'
                        }`}
                      >
                        {v.region}/{planLabel(v.planType)}
                      </button>
                    );
                  })}
                </div>
                <div className="text-[10px] text-slate-500 mt-1 font-mono truncate" title={variant.baseUrl}>{variant.baseUrl}</div>
                <div className="flex gap-2 mt-2">
                  <input
                    type="password"
                    placeholder={hasKey ? `已保存：${provider.apiKeyMaskedOrRef}` : '粘贴 API Key'}
                    value={keyDrafts[provider.id] ?? ''}
                    onChange={(e) => setKeyDrafts((d) => ({ ...d, [provider.id]: e.target.value }))}
                    className="flex-1 min-w-0 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono"
                    data-key-input={provider.id}
                  />
                  <button
                    onClick={() => void saveKey(provider)}
                    disabled={isBusy !== undefined}
                    className="rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 px-2 py-1 text-xs font-medium"
                  >
                    保存
                  </button>
                </div>
                <div className="flex gap-2 mt-2 items-center">
                  <select
                    value={provider.activeModelId}
                    onChange={(e) => setOverrideFor(provider.id, { activeModelId: e.target.value })}
                    className="flex-1 min-w-0 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono"
                    data-model-select={provider.id}
                  >
                    <option value="">{provider.discoveredModels.length === 0 ? '（先拉取模型）' : '（选激活模型）'}</option>
                    {provider.discoveredModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => void discover(provider)}
                    disabled={isBusy !== undefined}
                    className="rounded border border-slate-600 hover:border-slate-400 disabled:opacity-40 px-2 py-1 text-xs"
                  >
                    拉取模型
                  </button>
                  <button
                    onClick={() => void testChat(provider)}
                    disabled={isBusy !== undefined}
                    className="rounded border border-emerald-700 hover:border-emerald-500 disabled:opacity-40 px-2 py-1 text-xs"
                  >
                    测试
                  </button>
                </div>
                <div className="mt-1 min-h-[16px]">
                  {isBusy !== undefined && <span className="text-[10px] text-slate-400">{isBusy === 'save' ? '保存中' : isBusy === 'discover' ? '拉取模型中' : '测试中'}……</span>}
                  {isBusy === undefined && notice !== undefined && (
                    <span className={`text-[10px] ${notice.startsWith('✅') ? 'text-emerald-400' : 'text-rose-400'}`}>{notice}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function activeVariant(provider: UiProvider): { baseUrl: string } {
  const found =
    provider.variants.find((v) => v.region === provider.activeRegion && v.planType === provider.activePlanType) ??
    provider.variants[0];
  return { baseUrl: found?.baseUrl ?? '' };
}

function planLabel(plan: UiProvider['activePlanType']): string {
  return plan === 'PAY_AS_YOU_GO' ? '按量' : plan === 'CODING_PLAN' ? '套餐' : plan === 'LOCAL_GPU' ? '本地' : '免费';
}
