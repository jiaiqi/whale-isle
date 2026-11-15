# THIRD_PARTY_NOTICES — 第三方开源代码与素材许可证台账

> **纪律**：任何第三方代码/素材进入本仓库前，必须先在此登记；Gate 2（`pnpm verify:gate`）会校验本文件存在且持续维护。
> 台账状态标记：`✅ 已登记` / `⚠️ 待核实` / `⛔ 禁止引入`。

## 1. 运行时依赖（Node / TS）

| 组件 | 版本 | 许可证 | 使用方式 | 用途 | 状态 |
| --- | --- | --- | --- | --- | --- |
| zod | ^3.25 | MIT | 依赖 | `packages/shared-protocol` 契约校验 | ✅ 已登记 |
| typescript | ^5.9 | Apache-2.0 | devDependencies | 全仓类型编译 | ✅ 已登记 |
| @types/node | ^22 | MIT | devDependencies | Node 类型 | ✅ 已登记 |

> 后续引入的每一个新依赖（Electron、React、Dexie、better-sqlite3、dependency-cruiser、FastAPI、Demucs、RVC 等）**必须在本表追加一行**。

## 2. 移植/参考的开源项目代码

| 来源项目 | 许可证 | 移植范围 | 本仓库落点 | 备注与约束 | 状态 |
| --- | --- | --- | --- | --- | --- |
| PC2005-cloud/dsh-pet | MIT | 渲染物理、语音锁、绿幕转 WebM 工具链 | `packages/pet-renderer`、`services/audio-ai-worker/asset_pipeline` | 代码可移植需保留版权头 | ✅ 已登记（代码） |
| PC2005-cloud/dsh-pet（内置素材） | **非商用** | "蓝色大肥鱼" .webm 动作资产包 | `assets/pets/blue-whale-maid/` | **`licenseScope: DEV_ONLY_NON_COMMERCIAL`，禁止商用**；必须提供一键替换自制素材包管线 | ⚠️ 仅限本地开发测试 |
| BlindWhaleFarmer | ⚠️ 待核实 | 动作互斥锁 / 真实回执 / 键鼠接管机制思想 | `packages/game-bridge-mcp`、`mods/stardew-mcp-mod` | 核实许可证前严禁复制源码 | ⚠️ 待核实 |
| newbeejmc/Dsh_douyin | UNLICENSED | — | — | **⛔ 严禁复制源码**，仅参考节目状态机思想 | ⛔ 禁止引入 |
| fore-vip/dsh-live | UNLICENSED | — | — | **⛔ 严禁复制源码**；其密钥回传/虚假指标逻辑绝对禁止 | ⛔ 禁止引入 |

## 3. 素材资产台账

| 素材 | 来源 | 许可证 | licenseScope | 状态 |
| --- | --- | --- | --- | --- |
| 蓝色大肥鱼 .webm 动作包 | dsh-pet 内置 | 非商用 | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 仅开发测试，商用前必须整包替换 |

## 4. 许可证文本归档

- 第三方代码整段移植时，许可证全文与版权声明归档至 `docs/licenses/`（按 `<项目名>-<年份>.txt` 命名）。
