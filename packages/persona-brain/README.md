# packages/persona-brain — 人格与记忆层

> 状态：**未开工**（对应工单 `T-M1-04`、`T-M3-02`）｜ [SPEC §3.2](../../docs/SPEC.md)

## 职责（"大肥鱼（蓝鲸女仆）"三层人格引擎）

- **`persona.json` 结构化人设**：加载与热更新，必须通过 `@workbench/shared-protocol` 的 `PetPersonaConfigSchema` 校验；新增桌宠 = 新建一份 JSON + 语音包。
- **0.1s 雷区反射钩子**：正则拦截（如 `(大肥鱼|胖鱼|肥鲸|多少斤|水桶腰|卡门)`），命中直接返回 `P0_INTERRUPT` + `rage_spray`，**不消耗主脑 Token**；带 8s 冷却；命中者记入常客记仇账本。
- **`<think>` 内心戏引擎**：流式剥离 think 标签 → 云朵气泡；35% 概率跑题（derailment themes）。
- **赛博饭碗经济**：1 粒米 = 1 Token；低于 15% 触发 `hungry_lazy` 摸鱼态；"下饭菜"Buff（攻略红烧肉 RAG → high_reasoning；礼物 → 工作热情 ×2）。
- **星露谷效用权重**：摸鱼态 `lazy_smart_fish` ↔ 认真态 `serious_maid_for_owner` 切换（与饭碗余量、Buff 联动）。

## 边界（dependency-cruiser 强制）

- ❌ 禁止直接 import UI 组件或直接调 LLM API（一律经 `model-gateway`）。
- ✅ 记仇账本/长期记忆的读写统一走主进程 SQLite 服务（接口经 shared-protocol 契约定义）。
