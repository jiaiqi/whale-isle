# EXTERNAL-FUSION E · 第一垂直切片设计（Envoy + 星露谷攻略 → 真实实玩回执）

> 日期：2026-11-27 · 鲸屿基准：`dba66ec`（`origin/feat/whale-isle-v2`）
> 性质：**设计文档，不含产品代码**。切片施工对应 `V2-P4-04A → 04B → 04C → 04D`，UI 收尾为 `04E`。
> owner 批准：第一垂直切片 = 「Envoy + 星露谷攻略」；接受 Envoy 作为外部 MCP、依赖 Python/uv。

---

## 1. 为什么选这条切片

| 维度 | 这条切片 | 其它候选 |
|---|---|---|
| 能产生**真实**证据 | 星露谷有本地真实客户端 + 已有 BWF 三态回执，能证明「知识 → 行动 → 回执」不是纸上闭环 | 抖音只读只能证明「读到了」 |
| 外部能力最完整 | Envoy 是九个参考仓里唯一有**确定性证据包 + 知识四态 + 溯源**的 | 其余仓多为单一渠道技巧 |
| 风险最低 | 只读材料 + 本地游戏；不碰平台风控、不碰写操作 | 社媒写路径仍在红线外 |
| 可独立验收 | 一条知识走完全链路即可判定成败 | L2/L3 社交需要授权与长时观察 |

**不做什么**（切片边界）：不接第二个知识源；不做知识自动晋升到 `promoted`；不做多游戏；不做社媒/渠道桥接；不做 UI 之外的推荐算法。

---

## 2. 端到端链路

```
① 材料授权          owner 把一份攻略材料放进「授权目录」，并声明许可
        │
        ▼
② Envoy 读取        外部 MCP 进程读取材料 → 返回 material 元数据 + 抽取片段
        │           （只读；SHA-256；sourceRevision；extraction 状态）
        ▼
③ 真实 Evidence Pack 鲸屿计算规范化 digest，生成 evidenceId + locator
        │           （同材料同参数 → 同 digest，可复核）
        ▼
④ GameKnowledge    知识单元入库：claim / topic / gameVersion / modContext
        │           unitState=candidate，evidenceRefs=[...]，evidenceLevel=unverified
        ▼
⑤ 适用性校验        真实 get_state → 版本/季节/日期/Mod 对比
        │           不匹配 → uncertain（附原因），不硬套
        ▼
⑥ 执行 + 三态回执    game-bridge-mcp 动作锁 → BWF 真实回执 COMPLETED/FAILED/UNCERTAIN
        │           模型台词不算回执
        ▼
⑦ 落库 + 展示       回执写 SQLite → 知识页「实玩回执区」显示真实结果
                    → 依回执把 evidenceLevel 提升为 real-device（仅 COMPLETED/明确 FAILED）
```

---

## 3. 各边界的数据形态（设计草案）

### 3.1 ② → ③ 材料与证据

```jsonc
// Envoy 返回（归一前，示意）
{
  "materialId": "mat_spring_crops_v1",
  "originUri": "file:///…/owner-authorized/spring-crops.md",
  "title": "春季作物攻略（owner 授权副本）",
  "sha256": "…64 hex…",
  "sourceRevision": "mtime:1764200000",
  "extraction": "complete",
  "chunks": [
    { "locator": { "kind": "text", "startLine": 42, "endLine": 58 },
      "text": "……（材料原文，不得由模型补全）" }
  ]
}
```

```jsonc
// 鲸屿 EvidenceRef（落库形态）
{
  "evidenceId": "ev_9f2c…",
  "materialId": "mat_spring_crops_v1",
  "locator": { "kind": "text", "startLine": 42, "endLine": 58 },
  "sourceRevision": "mtime:1764200000",
  "materialSha256": "…64 hex…",
  "extraction": "complete",
  "capturedAt": "2026-11-27T…"
}
```

**硬规则**：
- `claim` 必须能在 `locator` 指向的原文里找到依据；找不到 → `candidate` 且标「待人工复核」。
- 材料正文**不改写、不摘要成事实**：摘要只能作为 `evidenceSummary`，不能替代 `claim` 的出处。
- 材料缺失/被移动 → 证据 `extraction: failed`，知识保持 `candidate`，不得升 `verified`。

### 3.2 ④ 知识单元

```jsonc
{
  "knowledgeId": "kn_…",           // 由 gameId+topic+claim 的规范化哈希去重
  "gameId": "stardew",
  "gameVersion": "1.6",
  "modContext": [],
  "topic": "春季作物",
  "claim": "……（以材料原文为准）",
  "sourceType": "wiki",
  "evidenceRefs": ["ev_9f2c…"],
  "unitState": "candidate",
  "evidenceLevel": "unverified",
  "confidence": 0.5,
  "applicability": ["春季", "晴天"],
  "knownLimitations": []
}
```

`confidence` 初始值**不来自模型自评**：有 1 份可复核证据 = 0.5；多份独立材料互证才上调；实玩 `COMPLETED` 上调，`FAILED` 下调并记 `contradictoryEvidence`。

### 3.3 ⑤ 适用性校验（必须用真实状态）

输入：知识声明的 `gameVersion` / `modContext` / `applicability` + 真实 `get_state`（季节、日期、游戏版本、已装 Mod）。

| 情形 | 结论 | 行为 |
|---|---|---|
| 版本匹配、Mod 匹配、季节/日期满足 | `compatible` | 允许执行 |
| 版本或 Mod 不匹配 | `mod-mismatch` / `outdated` | **不执行**，说明原因 |
| 关键状态读不到（BWF 不可达） | `uncertain` | **不执行**，提示「游戏状态不可读」 |
| 知识的 `applicability` 无法从状态判定 | `uncertain` | 交 owner 决定，不猜 |

**禁止**：用模型常识补全游戏版本/季节/Mod；用「应该差不多」放行。

### 3.4 ⑥ 实玩回执

```jsonc
{
  "knowledgeId": "kn_…",
  "actionId": "act_…",
  "receiptStatus": "COMPLETED",     // COMPLETED | FAILED | UNCERTAIN
  "observedStateDelta": { "…": "…" }, // 执行前后 get_state 的真实差异
  "evidenceLevel": "real-device",
  "capturedAt": "2026-11-27T…"
}
```

**铁律**（AGENTS §2.2）：
- 只认 BWF 的真实状态回执；**模型说「我已经浇好水了」不算回执**。
- `UNCERTAIN` 不得当作成功；不得自动重试超过上限。
- 回执必须带执行前后的状态差异；无差异的 `COMPLETED` 要标「可疑」并复核。

---

## 4. 最小验收（切片可判定的最小集）

> 全部满足才算「闭环」。缺任一条 → 本切片最高 `IMPLEMENTED_UNVERIFIED`。

| # | 判据 | 证据级别 | 谁来验 |
|---|---|---|---|
| 1 | owner 授权材料被**真实读取**，产出 `materialId + sha256 + sourceRevision` | `[REAL-DEVICE]` | 人类在场，记录命令与输出 |
| 2 | 生成 **Evidence Pack**，同材料同参数重跑两次 digest 一致 | `[REAL-DEVICE]` | 人类执行 |
| 3 | 知识入库为 `candidate`，`evidenceRefs` 可点开定位到原文行号 | `[E2E-HOST]` | 自动化 + 人工抽查 |
| 4 | 真实 `get_state` 参与适用性判定；不匹配时**拒绝执行**并说明 | `[REAL-DEVICE]` | 人类执行（可人为改版本/季节构造不匹配） |
| 5 | 按知识执行一次真实动作，拿到 BWF `COMPLETED`（或如实 `FAILED`/`UNCERTAIN`） | `[REAL-DEVICE]` | 人类执行 |
| 6 | 回执落 SQLite，重启后仍在，知识页可复查 | `[E2E-HOST]` + 人工 | 自动化 + 人工 |
| 7 | 全链路 `pnpm verify:gate` 绿 | 自动化 | CI |

**反例验收（必须做）**：
- 材料被删 → 证据 `failed`，知识不升级；
- Envoy 不可用 → 知识页显示「外部知识源不可用」，回退本地攻略，**不显示假证据**；
- BWF 不可达 → 适用性 `uncertain`，不执行，不写假回执；
- 执行后状态无变化 → 标「可疑」，不升 `verified`。

---

## 5. 人类执行脚本（验收时照此跑，逐条留证）

```bash
# 0) 前置：owner 把材料放进授权目录，声明许可（CC BY-NC-SA 仅限开发自用）
#    路径示例：~/WhaleIsle/knowledge-materials/owner-authorized/

# 1) 契约与单测
pnpm typecheck && pnpm --filter @workbench/shared-protocol test
pnpm --filter @workbench/game-bridge-mcp test

# 2) 外部知识源拉起（Envoy 由 owner 预先安装；鲸屿不自动安装）
#    宿主编排入口（切片实现后提供）：v2:knowledge-source-status
#    期望：available，且 version 与 SHA 记录在证据里

# 3) 证据包复现（同一材料跑两次，digest 必须一致）
#    命令由 04D 提供；输出写入 docs/v2/evidence/ 下的 JSON

# 4) 真实游戏
pnpm verify:gate
#    打开中控台 → 能力 → 知识 → 导入材料 → 查看证据
#    启动星露谷（V2-P3-06 启动器）→ 等 BWF ready
#    选择一条 compatible 知识 → 执行 → 记录回执

# 5) 归档
#    证据文件：EXTERNAL-FUSION-D1-slice-verification.md
#    + 原始 JSON：material / evidence-pack / get_state before/after / receipt
```

> 说明：以上命令中「宿主入口」与「证据包脚本」在 04D 落地后才有确定名称；本文件不虚构不存在的命令。

---

## 6. 失败模式与诚实降级

| 失败 | 用户看到 | 系统行为 | 禁止 |
|---|---|---|---|
| Envoy 未安装 / `uv` 缺失 | 「外部知识源不可用：未找到 envoy（uv）」 | 回退本地攻略 | 自动下载安装 |
| 材料无许可声明 | 红色「许可未知」徽章 | 只允许本地查看，禁止商用与直播引用 | 默认当 MIT |
| 证据定位不到原文 | 「证据待复核」 | 保持 `candidate` | 用模型记忆补全 |
| BWF 不可达 | 「游戏状态不可读」 | 不执行 | 用上次状态冒充当前 |
| 执行超时 | 「不确定」 | `UNCERTAIN`，不自动重试超限 | 当成功 |
| 状态无变化 | 「可疑：执行后状态未变化」 | 记 `FAILED` 或 `UNCERTAIN` | 记 `COMPLETED` |
| 模型声称已完成 | 不显示为回执 | 只显示 BWF 回执 | 把台词当证据 |

---

## 7. 与既有模块的接线点

| 环节 | 现有代码 | 切片需要的改动 |
|---|---|---|
| 材料读取 | 无 | `agent-harness/src/mcp-envoy.ts`（04C） |
| 证据 / 知识 | `shared-protocol/src/knowledge.ts:61-79`、`game-bridge-mcp/src/guide-library.ts` | 契约扩展（04A）+ 证据内核（04B） |
| 游戏状态 | `game-bridge-mcp` 的 BWF 客户端（`get_state`） | 复用，不改协议 |
| 动作执行 | `game-bridge-mcp` 动作互斥锁 + 三态回执 | 复用 |
| 落库 | `local-store/src/sqlite.ts:79-115` | 新增 3 表（04B） |
| 展示 | `sidebar.tsx:27-67` 能力组 | 新增知识页（04E） |

**不改的东西**：`social.ts` 的 L1 只读、`pipeline` 的语音锁、`runtime-core` 的 `ComputerUseLease`、`GuideLibrary` 的对外 API（只加不改）。

---

## 8. 「闭环」与「假闭环」的判定

**真闭环**（七条同时成立）：
1. 材料是 owner 真实提供且许可明确；
2. Envoy 真实读取（有进程、有 SHA、有抽取状态）；
3. 证据定位可在原文复核；
4. 适用性判定用到真实游戏状态；
5. 动作执行拿到 BWF 真实回执；
6. 回执与执行前后状态差异一致；
7. 重启后数据仍在、可复查。

**假闭环**（任一即判定为假）：
- 用模型生成的「攻略摘要」当材料；
- 证据 `locator` 指向不存在的行；
- 适用性用「默认春秋」之类的硬编码；
- 回执来自模型台词或 UI 本地伪造；
- 只有 `[SIMULATION]` 却对外称 `[REAL-DEVICE]`；
- 材料许可不明却进入商用/直播链路。

> **没有真实读取 / 真实执行，就不得宣称闭环。** 这条写在切片验收的第一行，也写进 `docs/v2/VERIFY.md` 的对应条目。

---

## 9. 工作量与风险

| 子单 | 预估 | 主要风险 |
|---|---|---|
| 04A 契约 | 0.5 天 | 字段命名反复（用「鲸屿名优先 + 适配器翻译」固定） |
| 04B 证据内核 | 1.5 天 | SQLite 迁移在真实库失败（事务 + 幂等 + 可回滚） |
| 04C Envoy 适配 | 1 天 | Python/uv 环境差异（明确报错，不静默重试） |
| 04D 切片验收 | 1 天 + 人类 0.5 天 | 真实游戏状态抖动（记录快照，如实记 `FAILED`） |
| 04E 知识页 | 1 天 | 与攻略页职责混淆（文案区分） |

**总预算**：约 5 人日 + 人类验收 0.5 天。**不含** Envoy 自身安装与 Python 依赖下载时间（由 owner 环境决定）。

---

## 10. 完成后的下一步（不在本切片）

- 04F/04G 把「诚实回执」与「观察版本」扩到社媒只读；
- 04H 生命回合与记忆增强；
- 04I 渠道桥接（`BLOCKED`，等授权）。

切片完成后，`docs/v2/ROADMAP.md` 的 `V2-P4-04D` 只有在七条真闭环判据全部有 `[REAL-DEVICE]` 证据时才可标 `DONE`；否则 `IMPLEMENTED_UNVERIFIED` 并写明缺哪一条。
