/**
 * 模型与服务商 v5（T-M6-09，按 design/providers.html 重构）：
 *   - 单一当前生效配置（取消三档干饭套餐心智；改动即写 Dexie 并 brainApplyConfig 热更新）
 *   - Master-Detail：256px 服务商目录（云端/自定义/本地）+ 专注配置面板
 *   - 默认模型 Tab：六槽位只从「已启用服务商 × 已启用模型」中选择
 *   - 自定义服务商全生命周期（Dexie customProviders）+ Magpie / CC Switch 只读导入
 * 密钥永远只在主进程 safeStorage；本组件只持有掩码。
 *
 * T-M6-26 拆分：详情/Key 与变体区、模型列表、默认模型页、两个弹窗与公共小组件已移入
 * `./providers/*`；本文件只保留页面容器职责（state / Dexie / bridge / toast），
 * 通过 props 把数据与回调传给纯展示子组件，行为与选择器保持不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bot, CheckCircle2, Download, Info, Server, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import {
  type DiningProfilePreset,
  type ModelProviderConfig,
  type WorkbenchRoleSlot,
} from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import { PageHead } from './shell/page-head';
import type { ImportApplyView, ImportScanView, VaultStatusView } from './bridge';
import { KEY_URL, SLOT_META, parsePastedEndpoint, shortError } from './providers/catalog';
import { CustomProviderDialog, ImportDialog } from './providers/dialogs';
import { ModelList } from './providers/model-list';
import { ProviderDetail } from './providers/provider-detail';
import { ProvidersSidebar } from './providers/providers-sidebar';
import { SlotsTab } from './providers/slots-tab';
import { EmptyState, NoticeBar } from './providers/ui';
import {
  AUTO_KEY, CUSTOM_KEY, DINING_KEY, OVERRIDES_KEY,
  type CustomProviderRecord, type ModelEntry, type ModelTestEntry, type ProviderOverrides,
  type Protocol, type UiProvider,
} from './providers/catalog';
import {
  buildCustomProviderRecord, clearRoleBindings, mergeDiscoveredModels, mergeImportedProviders,
  planProviderTest, resolveAutoBindings, toConfig, toUiCustom, toUiProvider,
} from './providers/catalog';

interface Props {
  profiles: DiningProfilePreset[];
  slotLabels: Record<WorkbenchRoleSlot, string>;
  providers: ModelProviderConfig[];
  store: DirectorStore;
}

/**
 * T-M6-66①：把主进程上报的凭据状态翻成一句人话（零明文）。
 * 顺序按严重度：系统加密不可用 > mock 隔离 > 解密失败需重填 > 正常已加载。
 */
function describeVaultStatus(
  status: VaultStatusView,
  nameOf: (id: string) => string,
): { kind: 'ok' | 'err' | 'info'; text: string } {
  const failed = status.providers.filter((p) => p.state === 'decrypt-failed' || p.state === 'identity-mismatch');
  const fromEnv = status.providers.filter((p) => p.state === 'env');
  const loaded = status.providers.filter((p) => p.state === 'loaded');
  const failedNames = failed
    .map((p) => `${nameOf(p.providerId)}${p.savedBy !== undefined ? `（由 ${p.savedBy} 写入）` : ''}`)
    .join('、');
  if (!status.encryptionAvailable) {
    return {
      kind: 'err',
      text: `系统加密不可用（safeStorage）：API Key 无法保存或读取${failed.length > 0 ? `；已有 ${failed.length} 个 Key 解密失败需重填：${failedNames}` : ''}`,
    };
  }
  if (status.backend === 'mock-keychain') {
    return {
      kind: 'err',
      text: `凭据后端：mock keychain（--use-mock-keychain）· 已隔离到 ${status.vaultFile}，正常凭据库不受影响；本模式保存的 Key 与正常启动不通用`,
    };
  }
  const parts: string[] = [];
  if (loaded.length > 0) parts.push(`已从 macOS 钥匙串加载 ${loaded.length} 个（身份 ${status.identity}）`);
  if (fromEnv.length > 0) parts.push(`${fromEnv.length} 个来自本机环境变量（不落盘）`);
  if (failed.length > 0) parts.push(`${failed.length} 个解密失败需重填：${failedNames}`);
  if (parts.length === 0) {
    return { kind: 'info', text: `凭据后端：macOS 钥匙串（身份 ${status.identity}）· 尚未保存任何 API Key` };
  }
  return {
    kind: failed.length > 0 ? 'err' : fromEnv.length > 0 ? 'info' : 'ok',
    text: `Key 来源与可用性：${parts.join(' · ')}`,
  };
}

/** 常驻状态条（与临时操作提示 NoticeBar 分开，避免保存结果把它覆盖掉） */
function VaultStatusBar({ status, nameOf }: { status: VaultStatusView; nameOf: (id: string) => string }): React.JSX.Element {
  const banner = describeVaultStatus(status, nameOf);
  const failed = status.providers.filter((p) => p.state === 'decrypt-failed' || p.state === 'identity-mismatch').length;
  const Icon = banner.kind === 'ok' ? CheckCircle2 : banner.kind === 'err' ? TriangleAlert : Info;
  return (
    <div
      data-provider-vault-status={status.backend}
      data-vault-failed={failed}
      data-vault-encryption={status.encryptionAvailable ? 'available' : 'unavailable'}
      className="mono mx-6 mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[11px]"
      style={{
        background: banner.kind === 'ok' ? 'var(--green-dim)' : banner.kind === 'err' ? 'var(--red-dim)' : 'var(--blue-dim)',
        border: `1px solid ${banner.kind === 'ok' ? 'var(--green-line)' : banner.kind === 'err' ? 'var(--red-line)' : 'var(--blue-line)'}`,
        color: banner.kind === 'ok' ? 'var(--green)' : banner.kind === 'err' ? 'var(--red)' : 'var(--blue)',
      }}
    >
      <Icon size={12} />
      {banner.text}
    </div>
  );
}

export function ProvidersPanel({ profiles, slotLabels, providers, store }: Props): React.JSX.Element {
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<'providers' | 'defaults'>('providers');
  const [overrides, setOverrides] = useState<ProviderOverrides>({});
  const [customs, setCustoms] = useState<CustomProviderRecord[]>([]);
  const [profile, setProfile] = useState<DiningProfilePreset | null>(null);
  const [activeProvId, setActiveProvId] = useState<string>('opencode-go');
  const [search, setSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  /** 当前服务商的逐模型连通测试结果（Magpie「Test models」交互）：modelId → ✓延迟 / ✗原因 */
  const [modelTests, setModelTests] = useState<Record<string, ModelTestEntry>>({});
  const [rowTesting, setRowTesting] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const batchCancelRef = useRef(false);
  /** 槽位自动挑选开关（Dexie 持久；Partial——未开启的槽位无键） */
  const [autoFlags, setAutoFlags] = useState<Partial<Record<WorkbenchRoleSlot, boolean>>>({});
  /** overrides 的同步镜像：批量测试循环里逐条写 tested，函数式 setState 的闭包会过期 */
  const overridesRef = useRef<ProviderOverrides>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** T-M6-66①：主进程如实上报的 Key 来源与可用性（only masks/states，never plaintext） */
  const [vaultStatus, setVaultStatus] = useState<VaultStatusView | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProto, setNewProto] = useState<Protocol>('openai');
  const [newUrl, setNewUrl] = useState('');
  const [newFullUrl, setNewFullUrl] = useState(false);
  const [newModels, setNewModels] = useState('');
  const [impOpen, setImpOpen] = useState(false);
  const [impSource, setImpSource] = useState<'magpie' | 'ccswitch' | 'file'>('magpie');
  const [impFilePath, setImpFilePath] = useState<string | undefined>(undefined);
  const [impScan, setImpScan] = useState<ImportScanView | null>(null);
  const [impSelected, setImpSelected] = useState<Set<string>>(new Set());
  const [impPolicy, setImpPolicy] = useState<'skip' | 'overwrite'>('skip');
  const [impBusy, setImpBusy] = useState(false);

  useEffect(() => {
    void Promise.all([
      store.getConfig<string>('activeDiningProfile'),
      store.getConfig<DiningProfilePreset[]>(DINING_KEY),
      store.getConfig<ProviderOverrides>(OVERRIDES_KEY),
      store.getConfig<CustomProviderRecord[]>(CUSTOM_KEY),
      store.getConfig<Partial<Record<WorkbenchRoleSlot, boolean>>>(AUTO_KEY),
    ]).then(async ([activeId, storedProfiles, storedOverrides, storedCustoms, storedAuto]) => {
      const base = (storedProfiles ?? []).find((p) => p.profileId === activeId) ?? storedProfiles?.[0] ?? profiles[0];
      if (base !== undefined) {
        setProfile({ ...base, displayName: '当前生效配置' });
        if (activeId === undefined) void store.setConfig('activeDiningProfile', base.profileId);
      }
      setOverrides(storedOverrides ?? {});
      overridesRef.current = storedOverrides ?? {};
      setCustoms(storedCustoms ?? []);
      const flags = storedAuto ?? {};
      setAutoFlags(flags);
      setHydrated(true);
      setModelTests((storedOverrides ?? {})['opencode-go']?.tested ?? {});
      // 凭据真相在主进程 vault：水合时对账掩码，修复历史 override 缺/残留 keyMask
      // （T-M6-09 遗留 bug——内置服务商保存 Key 后 keymask 未写 Dexie，重开面板显示未连接）
      const ids = [...providers.map((p) => p.id), ...(storedCustoms ?? []).map((c) => c.id)];
      const masks = await Promise.all(
        ids.map(async (id) => ({ id, mask: (await window.directorBridge.providerKeyMask(id)).mask ?? '' })),
      );
      // Key 来源与可用性（T-M6-66①）：解密失败/系统加密不可用必须让用户看见，不能只显示「未配置」
      void window.directorBridge.providerVaultStatus(ids).then(setVaultStatus).catch(() => setVaultStatus(null));
      const reconciled = { ...(storedOverrides ?? {}) };
      let changed = false;
      for (const { id, mask } of masks) {
        if ((reconciled[id]?.keyMask ?? '') !== mask) {
          reconciled[id] = { ...reconciled[id], keyMask: mask };
          changed = true;
        }
      }
      if (changed) {
        setOverrides(reconciled);
        overridesRef.current = reconciled;
        void store.setConfig(OVERRIDES_KEY, reconciled);
      }
      // 已启用自动挑选的槽位：按持久化测试结果静默重解析并落绑定
      const flagged = (Object.entries(flags) as Array<[WorkbenchRoleSlot, boolean]>).filter(([, v]) => v === true).map(([slot]) => slot);
      if (flagged.length > 0 && base !== undefined) {
        const resolved = resolveAutoBindings(providers, reconciled, storedCustoms ?? [], flagged);
        if (Object.keys(resolved.bindings).length > 0 || resolved.missing.length > 0) {
          const roleBindings = { ...base.roleBindings, ...resolved.bindings };
          const next = { ...base, roleBindings };
          setProfile({ ...next, displayName: '当前生效配置' });
          void store.setConfig(DINING_KEY, [{ ...next, displayName: '当前生效配置' }]);
          const uiMerged = [
            ...providers.map((p) => toUiProvider(p, reconciled[p.id])),
            ...(storedCustoms ?? []).map((c) => toUiCustom(c, reconciled[c.id]?.keyMask ?? '')),
          ];
          void window.directorBridge.brainApplyConfig({
            profile: { ...next, displayName: '当前生效配置' },
            providerModels: {},
            providers: uiMerged.filter((p) => p.enabled).map(toConfig),
          }).then((r) => {
            window.dispatchEvent(new CustomEvent('wb:brain', { detail: {
              mode: r.mode,
              llmReady: r.llmReady,
              mainModelId: next.roleBindings.MAIN_PERSONA_BRAIN ?? '',
            } }));
          });
        }
      }
    });
  }, [profiles, providers, store]);

  const merged = useMemo<UiProvider[]>(() => {
    const builtin = providers.map((p) => toUiProvider(p, overrides[p.id]));
    const custom = customs.map((c) => toUiCustom(c, overrides[c.id]?.keyMask ?? ''));
    return [...builtin, ...custom];
  }, [providers, customs, overrides]);

  const active = merged.find((p) => p.id === activeProvId) ?? merged[0];
  const providerUrl = active !== undefined ? (active.variants[active.activeVariant]?.baseUrl ?? '') : '';

  const persistOverrides = useCallback((next: ProviderOverrides): void => {
    overridesRef.current = next;
    setOverrides(next);
    void store.setConfig(OVERRIDES_KEY, next);
  }, [store]);

  /** T-M6-66①：保存 Key 后立刻刷新该服务商的真实可用性（解密失败 → 已加载） */
  const refreshVaultProvider = useCallback((providerId: string): void => {
    void window.directorBridge.providerVaultStatus([providerId]).then((next) => {
      setVaultStatus((prev) => {
        if (prev === null) return next;
        const rest = prev.providers.filter((p) => p.providerId !== providerId);
        return { ...prev, ...next, providers: [...rest, ...next.providers] };
      });
    }).catch(() => undefined);
  }, []);

  /** 逐模型测试结果落 override.tested（跨会话持久，自动挑选的依据）；不触发主脑热更新——批量 58 次也不打主进程 */
  const persistTested = useCallback((providerId: string, modelId: string, entry: ModelTestEntry): void => {
    setModelTests((prev) => ({ ...prev, [modelId]: entry }));
    const current = overridesRef.current;
    const next: ProviderOverrides = {
      ...current,
      [providerId]: { ...current[providerId], tested: { ...(current[providerId]?.tested ?? {}), [modelId]: entry } },
    };
    overridesRef.current = next;
    void store.setConfig(OVERRIDES_KEY, next);
    setOverrides(next);
  }, [store]);

  const persistCustoms = useCallback((next: CustomProviderRecord[]): void => {
    setCustoms(next);
    void store.setConfig(CUSTOM_KEY, next);
  }, [store]);

  const persistProfile = useCallback((next: DiningProfilePreset): void => {
    const clean: DiningProfilePreset = { ...next, displayName: '当前生效配置' };
    setProfile(clean);
    void store.setConfig(DINING_KEY, [clean]);
    void store.setConfig('activeDiningProfile', clean.profileId);
  }, [store]);

  const syncBrain = useCallback((nextProfile: DiningProfilePreset, nextProviders: UiProvider[]): void => {
    void window.directorBridge
      .brainApplyConfig({
        profile: nextProfile,
        providerModels: {},
        providers: nextProviders.filter((p) => p.enabled).map(toConfig),
      })
      .then((r) => {
        window.dispatchEvent(new CustomEvent('wb:brain', { detail: {
          mode: r.mode,
          llmReady: r.llmReady,
          mainModelId: nextProfile.roleBindings.MAIN_PERSONA_BRAIN ?? '',
        } }));
        // 成功/失败都只 toast：异步回调若 setNotice 会把「保存并检测」刚显示的结果条
        // （已连接/凭据已保存·检测未通过）约 1s 后整个覆盖掉——真机实证：多内置商缺 Key 时
        // 失败回调用红色「主脑回落规则」盖掉了检测结果，用户误读成保存失败
        if (r.ok) {
          toast(`主脑已热更新：${r.providers.join(' / ') || '—'}${r.missingKeys.length > 0 ? `（缺 Key：${r.missingKeys.join(', ')}）` : ''}`);
        } else {
          toast.error(`主脑回落规则：${r.error ?? '未知错误'}（顶栏大脑状态同步）`);
        }
      });
  }, []);

  const commitProvider = useCallback((ui: UiProvider): void => {
    if (profile === null) return;
    const nextMerged = merged.map((p) => (p.id === ui.id ? ui : p));
    if (ui.custom) {
      persistCustoms(customs.map((c) =>
        c.id === ui.id ? { ...c, name: ui.name, protocol: ui.protocol, variants: ui.variants, models: ui.models, enabled: ui.enabled } : c,
      ));
      persistOverrides({ ...overridesRef.current, [ui.id]: { ...overridesRef.current[ui.id], keyMask: ui.keyMask, testOk: ui.testOk } });
    } else {
      // keyMask/testOk 必须一并落 Dexie：configured 是从 override.keyMask 派生的，
      // 漏存会让「保存并检测」刚成功就回退成「未配置」（OpenCode Go 已连接不显示的根因）。
      // 展开基准用 overridesRef：逐模型测试 persistTested 也会写 overrides，闭包态会把它冲掉
      persistOverrides({
        ...overridesRef.current,
        [ui.id]: { ...overridesRef.current[ui.id], keyMask: ui.keyMask, testOk: ui.testOk, enabled: ui.enabled, models: ui.models, variants: ui.variants, activeVariant: ui.activeVariant },
      });
    }
    syncBrain(profile, nextMerged);
  }, [profile, merged, customs, overrides, persistCustoms, persistOverrides, syncBrain]);

  const patchActive = (patch: Partial<UiProvider>): void => {
    if (active === undefined) return;
    commitProvider({ ...active, ...patch });
  };

  const selectProvider = (id: string): void => {
    setActiveProvId(id);
    setModelSearch('');
    setModelTests(overridesRef.current[id]?.tested ?? {});
    batchCancelRef.current = true;
  };

  const bindSlot = (slot: WorkbenchRoleSlot, value: string): void => {
    if (profile === null) return;
    const next: DiningProfilePreset = { ...profile, roleBindings: { ...profile.roleBindings, [slot]: value } };
    persistProfile(next);
    syncBrain(next, merged);
    setNotice({ kind: 'ok', text: `${slotLabels[slot]} 已更新为 ${value === '' ? '（未绑定）' : value}` });
  };

  /** 槽位下拉变更：auto → 自动挑选；手动选择会先关闭该槽位的自动开关（Dexie 同步） */
  const changeSlot = (slot: WorkbenchRoleSlot, value: string): void => {
    if (value === 'auto') {
      applyAutoBindings([slot]);
      return;
    }
    if (autoFlags[slot] === true) {
      const flags = { ...autoFlags, [slot]: false };
      setAutoFlags(flags);
      void store.setConfig(AUTO_KEY, flags);
    }
    bindSlot(slot, value);
  };

  const setVariant = (index: number): void => {
    if (active === undefined) return;
    const variant = active.variants[index];
    if (variant === undefined) return;
    patchActive({ activeVariant: index, protocol: variant.protocol });
  };

  const setUrl = (url: string): void => {
    if (active === undefined) return;
    patchActive({ variants: active.variants.map((v, i) => (i === active.activeVariant ? { ...v, baseUrl: url } : v)) });
  };

  const setFullUrl = (checked: boolean): void => {
    if (active === undefined) return;
    patchActive({ variants: active.variants.map((v, i) => (i === active.activeVariant ? { ...v, isFullUrl: checked } : v)) });
    toast(checked ? '已开启完整地址模式（isFullUrl）' : '已切回自动拼接端点后缀');
  };

  const setProtocol = (protocol: Protocol): void => {
    if (active === undefined) return;
    patchActive({ protocol, variants: active.variants.map((v, i) => (i === active.activeVariant ? { ...v, protocol } : v)) });
  };

  const setKeyDraft = (value: string): void => {
    if (active === undefined) return;
    setKeyDrafts((d) => ({ ...d, [active.id]: value }));
  };

  const toggleActiveEnabled = (): void => {
    if (active === undefined) return;
    patchActive({ enabled: !active.enabled });
  };

  const openKeyConsole = (): void => {
    if (active === undefined) return;
    void window.directorBridge.openKeyConsole(KEY_URL[active.id] ?? '');
  };

  const toggleModel = (modelId: string): void => {
    if (active === undefined || profile === null) return;
    const models = active.models.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m));
    const fullId = `${active.id}/${modelId}`;
    if (models.find((m) => m.id === modelId)?.enabled === false) {
      const cleared = clearRoleBindings(profile.roleBindings, (binding) => binding === fullId);
      if (cleared.changed) persistProfile({ ...profile, roleBindings: cleared.roleBindings });
    }
    patchActive({ models });
  };

  /** 一键全开/全关当前服务商的全部模型（作用于全部而非仅搜索过滤结果）；全关时清空相关角色绑定 */
  const toggleAllModels = (enabled: boolean): void => {
    if (active === undefined || profile === null || active.models.length === 0) return;
    if (active.models.every((m) => m.enabled) === enabled) return;
    const models = active.models.map((m) => ({ ...m, enabled }));
    if (!enabled) {
      const activeModels = active.models;
      const providerId = active.id;
      const cleared = clearRoleBindings(profile.roleBindings, (binding) => activeModels.some((m) => binding === `${providerId}/${m.id}`));
      if (cleared.changed) persistProfile({ ...profile, roleBindings: cleared.roleBindings });
    }
    patchActive({ models });
    toast(
      enabled
        ? `已开启 ${active.name} 全部 ${active.models.length} 个模型`
        : `已关闭 ${active.name} 全部 ${active.models.length} 个模型（相关角色绑定已清空）`,
    );
  };

  /** 单模型连通测试（Magpie「Test this model」）：决策协议模型自动改走 System One 探针；结果持久化 */
  const testModelOne = useCallback(async (modelId: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> => {
    if (active === undefined) return { ok: false, error: '未选中服务商' };
    const isDecision = active.models.find((m) => m.id === modelId)?.caps.includes('decision') ?? false;
    const res = await window.directorBridge.testProviderChat({
      providerId: active.id,
      baseUrl: providerUrl,
      modelId,
      protocol: active.protocol,
      decision: isDecision,
    });
    const entry: ModelTestEntry = res.ok ? { ok: true, latencyMs: res.latencyMs } : { ok: false, error: res.error ?? '未知错误' };
    persistTested(active.id, modelId, entry);
    return entry;
  }, [active, providerUrl, persistTested]);

  const testRow = async (modelId: string): Promise<void> => {
    setRowTesting(modelId);
    try {
      const r = await testModelOne(modelId);
      if (!r.ok) toast.error(`${modelId}：${shortError(r.error)}`);
    } finally {
      setRowTesting(null);
    }
  };

  /**
   * 批量测试当前服务商全部开启的模型（Magpie「Test models」）：4 并发微型请求，
   * 行内 ✓延迟/✗状态码实时更新；再次点击 = 停止；>50 个先确认（防误点大清单烧 token/时间）。
   */
  const testAllModels = async (): Promise<void> => {
    if (active === undefined) return;
    if (batchProgress !== null) {
      batchCancelRef.current = true;
      return;
    }
    const targets = active.models.filter((m) => m.enabled);
    if (targets.length === 0) {
      toast.error('没有开启的模型可测试');
      return;
    }
    if (targets.length > 50 && !window.confirm(`将对 ${targets.length} 个开启的模型各发一次微型请求（约 ${Math.ceil((targets.length / 4) * 1.5)} 秒，消耗少量 token），继续？`)) {
      return;
    }
    batchCancelRef.current = false;
    setBatchProgress({ done: 0, total: targets.length });
    let done = 0;
    let okCount = 0;
    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (;;) {
        if (batchCancelRef.current) return;
        const m = queue.shift();
        if (m === undefined) return;
        const res = await testModelOne(m.id);
        if (res.ok) okCount += 1;
        done += 1;
        setBatchProgress({ done, total: targets.length });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setBatchProgress(null);
    const bad = targets.length - okCount;
    toast(
      bad === 0
        ? `全部 ${targets.length} 个模型应答正常`
        : `${bad}/${targets.length} 个模型未应答（行内红标，悬浮可看原因）`,
    );
    // 有槽位开着自动挑选 → 按最新测试结果立即重解析
    const flagged = (Object.entries(autoFlags) as Array<[WorkbenchRoleSlot, boolean]>).filter(([, v]) => v === true).map(([slot]) => slot);
    if (flagged.length > 0) applyAutoBindings(flagged, true);
  };

  /**
   * 自动挑选落绑定（纯解析在 resolveAutoBindings）：绑定值永远是具体 `${provider}/${model}`，
   * 主进程与 App 启动路径零改动；auto 标记单独存 Dexie。missing 槽位保留现有绑定只在提示里点名。
   */
  const applyAutoBindings = (slots: WorkbenchRoleSlot[], silent = false): void => {
    if (profile === null) return;
    const resolved = resolveAutoBindings(providers, overridesRef.current, customs, slots);
    if (Object.keys(resolved.bindings).length > 0) {
      const roleBindings = { ...profile.roleBindings, ...resolved.bindings };
      const next = { ...profile, roleBindings };
      persistProfile(next);
      syncBrain(next, merged);
    }
    const flags = { ...autoFlags };
    for (const slot of slots) flags[slot] = true;
    setAutoFlags(flags);
    void store.setConfig(AUTO_KEY, flags);
    if (!silent) {
      if (resolved.missing.length === slots.length) {
        toast.error('没有「已测通且开启」的模型：先对目标服务商点「测试模型」再自动挑选');
      } else if (resolved.missing.length > 0) {
        toast(`已自动分配 ${slots.length - resolved.missing.length} 个槽位；${resolved.missing.map((s) => slotLabels[s]).join('、')} 缺可测通模型（先「测试模型」）`);
      } else {
        toast(`已按测试结果自动分配 ${slots.length} 个槽位`);
      }
    }
  };

  const setAsMain = (fullId: string): void => {
    if (profile === null) return;
    const next = { ...profile, roleBindings: { ...profile.roleBindings, MAIN_PERSONA_BRAIN: fullId } };
    persistProfile(next);
    syncBrain(next, merged);
    toast(`主脑已切换为 ${fullId}`);
  };

  const addModelManual = (): void => {
    if (active === undefined) return;
    const id = window.prompt('输入模型 ID（例如：glm-5.3-flash）')?.trim() ?? '';
    if (id === '') return;
    if (active.models.some((m) => m.id === id)) {
      toast.error('该模型已存在');
      return;
    }
    const caps = active.protocol === 'anthropic' ? ['anth', 'tool'] : ['tool'];
    patchActive({ models: [{ id, enabled: true, caps }, ...active.models] });
    toast(`已添加模型 ${id}`);
  };

  const removeModel = (modelId: string): void => {
    if (active === undefined || profile === null) return;
    const fullId = `${active.id}/${modelId}`;
    const cleared = clearRoleBindings(profile.roleBindings, (binding) => binding === fullId);
    persistProfile({ ...profile, roleBindings: cleared.roleBindings });
    patchActive({ models: active.models.filter((m) => m.id !== modelId) });
  };

  const deleteCustom = (): void => {
    if (active === undefined || !active.custom || profile === null) return;
    if (!window.confirm(`确认删除自定义服务商「${active.name}」？相关角色绑定会同步清理。`)) return;
    persistCustoms(customs.filter((c) => c.id !== active.id));
    const rest: ProviderOverrides = {};
    for (const [id, value] of Object.entries(overridesRef.current)) if (id !== active.id) rest[id] = value;
    persistOverrides(rest);
    const cleared = clearRoleBindings(profile.roleBindings, (binding) => binding.startsWith(`${active.id}/`));
    persistProfile({ ...profile, roleBindings: cleared.roleBindings });
    setActiveProvId(providers[0]?.id ?? 'opencode-go');
    toast(`已删除自定义服务商「${active.name}」`);
  };

  /** 复制已保存 Key 到系统剪贴板（2026-11-22 用户指令）：主进程解密直写剪贴板，明文不回传渲染层、不在界面显示 */
  const copySavedKey = async (): Promise<void> => {
    if (active === undefined) return;
    const r = await window.directorBridge.copyProviderKey(active.id);
    if (r.ok && (r.mask ?? '') !== '') {
      toast(`Key 已复制到系统剪贴板（${r.mask}），可粘贴到任何地方`);
    } else {
      toast.error(r.error ?? '该供应商尚未保存 API Key');
    }
  };

  /** 查询余额/额度（Magpie keybalance 思想）：主进程持 key 请求厂商公开余额 API，结果持久化到 override.balance */
  const checkBalance = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(`balance:${active.id}`);
    try {
      const r = await window.directorBridge.checkProviderBalance(active.id);
      if (!r.ok || r.text === undefined) {
        toast.error(r.error ?? '查询失败');
        setNotice({ kind: 'err', text: `余额查询失败：${r.error ?? '未知错误'}` });
        return;
      }
      const entry = { text: r.text, at: Date.now() };
      const current = overridesRef.current;
      const next: ProviderOverrides = { ...current, [active.id]: { ...current[active.id], balance: entry } };
      overridesRef.current = next;
      void store.setConfig(OVERRIDES_KEY, next);
      setOverrides(next);
      setNotice({ kind: 'ok', text: `${active.name} 余额：${r.text}` });
      toast(`余额：${r.text}`);
    } finally {
      setBusy(null);
    }
  };

  const saveAndTest = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(`save:${active.id}`);
    setNotice(null);
    try {
      // 智能清洗：整段粘贴「Authorization: Bearer sk-xxx」时剥掉前缀与引号，只留 Key 本体
      const draft = (keyDrafts[active.id] ?? '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');
      let keyMask = active.keyMask;
      if (draft !== '') {
        const saved = await window.directorBridge.saveProviderKey(active.id, draft);
        if (!saved.ok) {
          setNotice({ kind: 'err', text: saved.error ?? '凭据保存失败' });
          toast.error(saved.error ?? '凭据保存失败');
          return;
        }
        keyMask = saved.mask ?? '';
        setKeyDrafts((d) => ({ ...d, [active.id]: '' }));
        refreshVaultProvider(active.id);
      }
      if (keyMask === '') {
        setNotice({ kind: 'err', text: '尚未保存凭据：先粘贴 Key 再点「保存并检测」' });
        return;
      }
      // 先拉真实模型清单（顺带校验 Key），测试模型以清单为准——
      // 预设模型 ID 失效（如 OpenRouter 下架旧型号）不再把「检测 404」误报成「保存失败」
      let models = active.models;
      let discovered: Set<string> | null = null;
      let freeIds: Set<string> = new Set();
      const decisionIds = new Set<string>();
      if (active.protocol === 'openai' && !active.local) {
        const res = await window.directorBridge.discoverModels({ providerId: active.id, baseUrl: providerUrl, protocol: active.protocol });
        if (res.ok && res.models !== undefined) {
          discovered = new Set(res.models);
          freeIds = new Set(res.freeModels ?? []);
          for (const id of res.decisionModels ?? []) decisionIds.add(id);
          // 元数据分类（Console 清单的 type+cost 是服务端真相）：决策协议 / 免费档 / 普通 chat
          const capsOfId = (id: string): string[] =>
            decisionIds.has(id) ? ['decision'] : freeIds.has(id) ? ['free'] : ['tool'];
          models = mergeDiscoveredModels(models, res.models.map((id) => ({ id, enabled: true, caps: capsOfId(id) })));
        }
      }
      // 检测候选：决策协议模型（System One/jev）不吃 /chat/completions 必失败，排除；
      // 免费档优先（用户动机就是免费模型），清单内模型优先；Key 级/余额级错误（401/402）换模型无意义即止
      const { candidates, decisionModel } = planProviderTest(models, discovered, freeIds);
      if (candidates.length === 0) {
        // 纯决策协议服务商（TypeSafe Jev / Console jev 系）：没有 chat 模型不是错误——用原生 System One 探针做连通检测
        if (decisionModel === undefined) {
          setNotice({ kind: 'err', text: '没有可用于连通测试的模型，请先拉取或手动添加' });
          return;
        }
        const probe = await window.directorBridge.testProviderChat({ providerId: active.id, baseUrl: providerUrl, modelId: decisionModel, protocol: active.protocol, decision: true });
        persistTested(active.id, decisionModel, probe.ok ? { ok: true, latencyMs: probe.latencyMs } : { ok: false, error: probe.error ?? '未知错误' });
        commitProvider({ ...active, keyMask, configured: true, enabled: true, models, testOk: probe.ok });
        if (probe.ok) {
          setNotice({ kind: 'ok', text: `已连接（决策探针 ${decisionModel}）· 响应 ${probe.latencyMs ?? 0}ms · 已启用 ${models.filter((m) => m.enabled).length} 个模型` });
          toast(`${active.name} 凭据已加密保存，System One 决策探针通过（${probe.latencyMs ?? 0}ms）`);
        } else {
          setNotice({ kind: 'err', text: `凭据已加密保存（${keyMask}），但 System One 决策探针未通过（${decisionModel}）：${probe.error ?? '未知错误'}` });
          toast.error(`决策探针未通过：${probe.error ?? '未知错误'}`);
        }
        return;
      }
      const attempts: string[] = [];
      let okModel = '';
      let latencyMs = 0;
      // 定向两探：免费档一次（用户动机）+ 付费档一次（余额真相）——真机实证免费档全档同错（429 FreeUsageLimit），
      // 连试第二个免费模型毫无信息量；付费档失败即定论（402 无余额），Key 级错误（401）立即止
      const firstFree = candidates.find((id) => freeIds.has(id));
      const firstPaid = candidates.find((id) => !freeIds.has(id));
      const attemptIds = [...new Set([firstFree, firstPaid])].filter((id): id is string => id !== undefined);
      for (const modelId of attemptIds) {
        const tested = await window.directorBridge.testProviderChat({ providerId: active.id, baseUrl: providerUrl, modelId, protocol: active.protocol });
        // 两档结果同步进逐模型 tested（自动挑选据此避开通不过的模型）
        persistTested(active.id, modelId, tested.ok ? { ok: true, latencyMs: tested.latencyMs } : { ok: false, error: tested.error ?? '未知错误' });
        if (tested.ok) {
          okModel = modelId;
          latencyMs = tested.latencyMs ?? 0;
          break;
        }
        attempts.push(`${modelId}：${tested.error ?? '未知错误'}`);
        if (/HTTP 401|invalid credential|unauthorized/i.test(tested.error ?? '')) break;
      }
      if (okModel === '') {
        // Key 已成功加密落盘：不能把「检测失败」误报成「保存失败」——保留掩码与配置态，如实汇总每档失败原因
        // （真机实证：Console 免费档 403 官方锁客户端 + 付费档 402 无余额，逐条展示用户才能看懂该充哪边）
        commitProvider({ ...active, keyMask, configured: true, enabled: true, models, testOk: false });
        setNotice({ kind: 'err', text: `凭据已加密保存（${keyMask}），但连通检测未通过 — ${attempts.join('；')}` });
        toast.error(`连通检测未通过：${attempts[attempts.length - 1] ?? ''}`);
        return;
      }
      commitProvider({ ...active, keyMask, configured: true, enabled: true, models, testOk: true });
      setNotice({ kind: 'ok', text: `已连接（${okModel}${freeIds.has(okModel) ? ' · 免费档' : ''}）· 响应 ${latencyMs}ms · 已启用 ${models.filter((m) => m.enabled).length} 个模型` });
      toast(`${active.name} 凭据已加密保存，连通检测通过（${latencyMs}ms）`);
    } finally {
      setBusy(null);
    }
  };

  const testLocal = async (): Promise<void> => {
    if (active === undefined) return;
    const modelId = active.models.find((m) => m.enabled)?.id;
    if (modelId === undefined) {
      toast.error('请先添加模型');
      return;
    }
    const res = await window.directorBridge.testProviderChat({ providerId: active.id, baseUrl: providerUrl, modelId, protocol: active.protocol });
    setNotice(res.ok ? { kind: 'ok', text: `健康检查通过（${res.latencyMs ?? 0}ms）` } : { kind: 'err', text: res.error ?? '检测失败' });
    if (res.ok) toast(`${active.name} 健康检查通过`);
  };

  const pullModels = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(`pull:${active.id}`);
    try {
      const res = await window.directorBridge.discoverModels({ providerId: active.id, baseUrl: providerUrl, protocol: active.protocol });
      if (!res.ok || res.models === undefined) {
        const text = res.error ?? '拉取模型失败';
        setNotice({ kind: 'err', text });
        toast.error(text);
        return;
      }
      const freeIds = new Set(res.freeModels ?? []);
      const decisionIds = new Set(res.decisionModels ?? []);
      const models = mergeDiscoveredModels(active.models, res.models.map((id) => ({
        id,
        enabled: true,
        caps: decisionIds.has(id) ? ['decision'] : freeIds.has(id) ? ['free'] : ['tool'],
      })));
      commitProvider({ ...active, models });
      toast(`已从 ${active.name} 同步 ${res.models.length} 个可用模型`);
    } finally {
      setBusy(null);
    }
  };

  const syncAllToMain = (): void => {
    if (profile === null) return;
    const main = profile.roleBindings.MAIN_PERSONA_BRAIN ?? '';
    if (main === '') {
      toast.error('主脑尚未绑定模型');
      return;
    }
    const roleBindings = { ...profile.roleBindings };
    for (const meta of SLOT_META) if (meta.group === 'llm') roleBindings[meta.slot] = main;
    persistProfile({ ...profile, roleBindings });
    syncBrain({ ...profile, roleBindings }, merged);
    toast(`对话与推理角色已全部对齐至 ${main}`);
  };

  const createCustom = (): void => {
    const name = newName.trim();
    if (name === '') {
      toast.error('请填写服务商名称');
      return;
    }
    const baseUrl = newUrl.trim() === '' ? 'http://127.0.0.1:8000/v1' : newUrl.trim();
    const modelIds = newModels.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== '');
    const record = buildCustomProviderRecord({ name, protocol: newProto, baseUrl, isFullUrl: newFullUrl, modelIds });
    persistCustoms([...customs, record]);
    setAddOpen(false);
    setNewName('');
    setNewUrl('');
    setNewModels('');
    setNewFullUrl(false);
    setActiveProvId(record.id);
    toast(`已创建自定义服务商「${name}」，请保存凭据`);
  };

  /** 自定义弹窗的智能粘贴：curl / export / 端点 URL → 填 URL + 协议 + isFullUrl（识别不了就原样输入） */
  const pasteNewUrl = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    const parsed = parsePastedEndpoint(e.clipboardData.getData('text'));
    if (parsed === null) return;
    e.preventDefault();
    setNewUrl(parsed.baseUrl);
    if (parsed.protocol !== undefined) setNewProto(parsed.protocol);
    setNewFullUrl(parsed.isFullUrl ?? false);
    toast(parsed.note);
  };

  const scanImport = useCallback(async (source: 'magpie' | 'ccswitch' | 'file', filePath?: string): Promise<void> => {
    setImpBusy(true);
    setImpScan(null);
    try {
      const res = await window.directorBridge.providerImportScan({ source, filePath });
      setImpScan(res);
      setImpSelected(new Set(res.items.filter((i) => i.hasKey).map((i) => i.id)));
      if (!res.ok) toast.error(res.error ?? '扫描失败');
    } finally {
      setImpBusy(false);
    }
  }, []);

  const openImport = (): void => {
    setImpOpen(true);
    setImpSource('magpie');
    setImpFilePath(undefined);
    void scanImport('magpie');
  };

  const selectImportSource = (source: 'magpie' | 'ccswitch'): void => {
    setImpSource(source);
    setImpFilePath(undefined);
    void scanImport(source);
  };

  const pickImportFile = async (): Promise<void> => {
    const picked = await window.directorBridge.providerImportPickFile();
    if (!picked.ok || picked.path === undefined) {
      if (picked.error !== undefined && picked.error !== '已取消') toast.error(picked.error);
      return;
    }
    setImpSource('file');
    setImpFilePath(picked.path);
    await scanImport('file', picked.path);
  };

  const toggleImportItem = (id: string): void => {
    setImpSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const applyImport = async (): Promise<void> => {
    if (impScan === null || impSelected.size === 0) {
      toast.error('请至少勾选 1 个服务商');
      return;
    }
    setImpBusy(true);
    try {
      const res: ImportApplyView = await window.directorBridge.providerImportApply({
        source: impSource,
        filePath: impFilePath,
        selectedIds: [...impSelected],
        policy: impPolicy,
      });
      if (!res.ok) {
        toast.error(res.error ?? '导入失败');
        return;
      }
      const next = mergeImportedProviders(res.items, customs, overrides);
      persistCustoms(next.customs);
      persistOverrides(next.overrides);
      if (profile !== null) {
        syncBrain(profile, [
          ...providers.map((p) => toUiProvider(p, next.overrides[p.id])),
          ...next.customs.map((c) => toUiCustom(c, next.overrides[c.id]?.keyMask ?? '')),
        ]);
      }
      const created = res.items.filter((i) => i.action === 'create').length;
      const updated = res.items.filter((i) => i.action === 'update').length;
      const skipped = res.items.filter((i) => i.action === 'skip').length;
      toast(`导入完成：新增 ${created} 家，更新 ${updated} 家${skipped > 0 ? `，跳过 ${skipped} 家（已有凭据）` : ''}`);
      setImpOpen(false);
    } finally {
      setImpBusy(false);
    }
  };

  if (!hydrated || profile === null) {
    return <div className="p-6 text-sm" style={{ color: 'var(--text-3)' }}>配置加载中…</div>;
  }

  const modelKeyword = modelSearch.trim().toLowerCase();
  const filteredModels = active === undefined
    ? []
    : active.models.filter((m) => modelKeyword === '' || m.id.toLowerCase().includes(modelKeyword));
  // 开启的模型排最前、停用的沉底（组内保持原相对顺序）——2026-11-22 用户指令
  const shownModels: ModelEntry[] = [...filteredModels.filter((m) => m.enabled), ...filteredModels.filter((m) => !m.enabled)];
  const enabledCount = merged.filter((p) => p.enabled).length;
  const configuredCount = merged.filter((p) => p.configured).length;
  const slotOptions = merged
    .filter((p) => p.enabled)
    .flatMap((p) => p.models
      // 决策协议（System One）模型暂不进聊天槽位下拉：网关尚无适配，绑定即坏；适配工单落地后放开
      .filter((m) => m.enabled && !m.caps.includes('decision'))
      .map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.name} · ${m.id}`, audio: p.audio })));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div style={{ borderBottom: '1px solid var(--stroke)', flexShrink: 0 }}>
        <div className="wb-page" style={{ padding: '18px 28px 14px' }}>
          <PageHead
            eyebrow="能力 · 模型"
            eyebrowIcon={Bot}
            title="模型与饭碗"
            description="内置主流服务商 + OpenCode Go + 自定义兼容端点 · 取消三档切换，改完即生效"
            compact
            actions={(
              <>
                <button className="btn-pill ghost" onClick={openImport} data-provider-import>
                  <Download size={13} />导入 Magpie / CC Switch
                </button>
                <div className="seg">
                  <button className={tab === 'providers' ? 'on' : ''} data-ptab="providers" onClick={() => setTab('providers')}>
                    <Server size={12} />服务商配置
                  </button>
                  <button className={tab === 'defaults' ? 'on' : ''} data-ptab="defaults" onClick={() => setTab('defaults')}>
                    <SlidersHorizontal size={12} />默认模型 (6)
                  </button>
                </div>
              </>
            )}
          />
        </div>
      </div>

      {vaultStatus !== null && (
        <VaultStatusBar status={vaultStatus} nameOf={(id) => merged.find((p) => p.id === id)?.name ?? id} />
      )}

      {notice !== null && <NoticeBar notice={notice} />}

      {tab === 'providers' ? (
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '256px 1fr' }}>
          <ProvidersSidebar
            providers={merged}
            activeId={active?.id}
            search={search}
            onSearch={setSearch}
            onSelect={selectProvider}
            onAdd={() => setAddOpen(true)}
          />

          <div className="min-h-0 overflow-y-auto px-7 pb-12 pt-5">
            {active === undefined ? (
              <EmptyState className="text-sm">无匹配服务商</EmptyState>
            ) : (
              <div className="mx-auto max-w-[780px]">
                <ProviderDetail
                  active={active}
                  providerUrl={providerUrl}
                  keyDraft={keyDrafts[active.id] ?? ''}
                  busy={busy}
                  onRename={(name) => patchActive({ name })}
                  onProtocol={setProtocol}
                  onDelete={deleteCustom}
                  onToggleEnabled={toggleActiveEnabled}
                  onKeyDraft={setKeyDraft}
                  onSaveAndTest={() => { void saveAndTest(); }}
                  onOpenKeyConsole={openKeyConsole}
                  onCopyKey={() => { void copySavedKey(); }}
                  onCheckBalance={() => { void checkBalance(); }}
                  onVariant={setVariant}
                  onUrl={setUrl}
                  onFullUrl={setFullUrl}
                  onTestLocal={() => { void testLocal(); }}
                />
                <ModelList
                  active={active}
                  shownModels={shownModels}
                  modelSearch={modelSearch}
                  modelTests={modelTests}
                  rowTesting={rowTesting}
                  busy={busy}
                  batchProgress={batchProgress}
                  onSearch={setModelSearch}
                  onToggleAll={toggleAllModels}
                  onTestAll={() => { void testAllModels(); }}
                  onPull={() => { void pullModels(); }}
                  onAddManual={addModelManual}
                  onTest={(modelId) => { void testRow(modelId); }}
                  onSetMain={setAsMain}
                  onRemove={removeModel}
                  onToggleModel={toggleModel}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <SlotsTab
          slotOptions={slotOptions}
          roleBindings={profile.roleBindings}
          autoFlags={autoFlags}
          enabledCount={enabledCount}
          configuredCount={configuredCount}
          onAutoAssign={() => applyAutoBindings(SLOT_META.map((s) => s.slot))}
          onSyncAllMain={syncAllToMain}
          onSlotChange={changeSlot}
        />
      )}

      {addOpen && (
        <CustomProviderDialog
          name={newName}
          protocol={newProto}
          url={newUrl}
          fullUrl={newFullUrl}
          models={newModels}
          onName={setNewName}
          onProtocol={setNewProto}
          onUrl={setNewUrl}
          onPaste={pasteNewUrl}
          onFullUrl={setNewFullUrl}
          onModels={setNewModels}
          onClose={() => setAddOpen(false)}
          onCreate={createCustom}
        />
      )}

      {impOpen && (
        <ImportDialog
          source={impSource}
          scan={impScan}
          selected={impSelected}
          policy={impPolicy}
          busy={impBusy}
          onClose={() => setImpOpen(false)}
          onSelectSource={selectImportSource}
          onPickFile={() => { void pickImportFile(); }}
          onToggle={toggleImportItem}
          onPolicy={setImpPolicy}
          onApply={() => { void applyImport(); }}
        />
      )}
    </div>
  );
}
