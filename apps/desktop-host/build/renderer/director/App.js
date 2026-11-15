import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
/**
 * 中控台模型配置页（T-M1-05，CC Switch/Magpie 风格）：
 *   顶部 3 个干饭套餐胶囊（一键切换 → Dexie 持久）
 *   中部 6 槽位绑定（Magpie 单屏 6 角色）
 *   底部供应商预设卡（Region/Plan 胶囊 + 掩码 Key）
 */
const SLOT_ORDER = [
    'MAIN_PERSONA_BRAIN',
    'STARDEW_GAME_PLANNER',
    'DANMAKU_FAST_ROUTER',
    'VISION_STORYBOARD',
    'VOICE_TTS_SPEECH',
    'VOICE_SVC_SINGING',
];
export function App({ profiles, slotLabels, providers, store, storeKey }) {
    const [activeProfileId, setActiveProfileId] = useState(null);
    const [hydrated, setHydrated] = useState(false);
    // 启动 hydrate：Dexie 快照恢复（断电/重启后状态不丢）
    useEffect(() => {
        void store.getConfig(storeKey).then((stored) => {
            setActiveProfileId(stored ?? profiles[0]?.profileId ?? null);
            setHydrated(true);
        });
    }, [profiles, store, storeKey]);
    const activeProfile = profiles.find((profile) => profile.profileId === activeProfileId) ?? profiles[0];
    const switchProfile = (profileId) => {
        setActiveProfileId(profileId);
        void store.setConfig(storeKey, profileId); // 套餐胶囊一键切换 → Dexie 即时同步
    };
    if (!hydrated || !activeProfile) {
        return _jsx("div", { className: "p-6 text-slate-400", children: "\u996D\u7897\u52A0\u8F7D\u4E2D\u2026\u2026" });
    }
    return (_jsxs("div", { className: "min-h-screen bg-slate-950 text-slate-100 font-sans", children: [_jsxs("header", { className: "px-6 pt-5 pb-3 border-b border-slate-800", children: [_jsx("h1", { className: "text-lg font-bold", children: "\uD83D\uDC1F \u5927\u80A5\u9C7C\u4E2D\u63A7\u53F0 \u00B7 \u6A21\u578B\u914D\u7F6E" }), _jsx("p", { className: "text-xs text-slate-400 mt-1", children: "CC Switch \u9884\u8BBE \u00D7 Magpie \u516D\u69FD\u4F4D \u00B7 100% \u672C\u5730\u4F18\u5148" })] }), _jsxs("section", { className: "px-6 py-4", children: [_jsx("h2", { className: "text-sm font-semibold text-slate-300 mb-2", children: "\u5E72\u996D\u5957\u9910" }), _jsx("div", { className: "flex gap-3", children: profiles.map((profile) => {
                            const active = profile.profileId === activeProfile.profileId;
                            return (_jsx("button", { "data-profile": profile.profileId, "data-active": active ? 'true' : 'false', onClick: () => switchProfile(profile.profileId), className: `px-4 py-2 rounded-full border text-sm transition-colors ${active
                                    ? 'border-amber-400 bg-amber-400/15 text-amber-300 font-semibold'
                                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'}`, children: profile.displayName }, profile.profileId));
                        }) })] }), _jsxs("section", { className: "px-6 py-4", children: [_jsxs("h2", { className: "text-sm font-semibold text-slate-300 mb-2", children: ["\u516D\u69FD\u4F4D\u7ED1\u5B9A\uFF08", activeProfile.displayName, "\uFF09"] }), _jsx("div", { className: "grid grid-cols-2 gap-3", children: SLOT_ORDER.map((slot) => (_jsxs("div", { "data-slot": slot, className: "rounded-lg border border-slate-800 bg-slate-900/70 p-3", children: [_jsx("div", { className: "text-xs text-slate-400", children: slotLabels[slot] }), _jsx("div", { className: "text-sm font-mono text-sky-300 mt-1", "data-binding": slot, children: activeProfile.roleBindings[slot] ?? '（未绑定）' })] }, slot))) })] }), _jsxs("section", { className: "px-6 py-4 pb-8", children: [_jsx("h2", { className: "text-sm font-semibold text-slate-300 mb-2", children: "\u4F9B\u5E94\u5546\u9884\u8BBE\u5E93" }), _jsx("div", { className: "grid grid-cols-3 gap-3", children: providers.map((provider) => (_jsxs("div", { "data-provider": provider.id, className: "rounded-lg border border-slate-800 bg-slate-900/70 p-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-sm font-semibold", children: provider.name }), _jsx("span", { className: "text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400", children: provider.category })] }), _jsx("div", { className: "flex gap-1 mt-2", children: provider.variants.map((variant) => (_jsxs("span", { className: `text-[10px] px-1.5 py-0.5 rounded ${variant.region === provider.activeRegion && variant.planType === provider.activePlanType
                                            ? 'bg-sky-500/20 text-sky-300'
                                            : 'bg-slate-800 text-slate-500'}`, children: [variant.region, "/", variant.planType === 'PAY_AS_YOU_GO' ? '按量' : variant.planType === 'CODING_PLAN' ? '套餐' : variant.planType === 'LOCAL_GPU' ? '本地' : '免费'] }, `${variant.region}-${variant.planType}`))) }), _jsxs("div", { className: "text-[10px] text-slate-500 mt-2 font-mono", children: ["Key: ", provider.apiKeyMaskedOrRef === '' ? '未配置' : provider.apiKeyMaskedOrRef] })] }, provider.id))) })] })] }));
}
//# sourceMappingURL=App.js.map