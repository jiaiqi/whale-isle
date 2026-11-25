# ADR-000：Whale Isle V2 产品宪章级基线决策与风险矩阵

- **状态**：Accepted（合并自原始蓝图 [16-决策记录与风险清单.md](../blueprint/16-%E5%86%B3%E7%AD%96%E8%AE%B0%E5%BD%95%E4%B8%8E%E9%A3%8E%E9%99%A9%E6%B8%85%E5%8D%95.md)，并标注后续 ADR-001 / ADR-002 的承接与细化关系）
- **关联文档**：[PRODUCT.md](../PRODUCT.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [ADR-001](./ADR-001-v2-foundation.md) · [ADR-002](./ADR-002-v2-architecture-revision.md)

---

## 一、产品宪章级基线决策（`D-001` ~ `D-015`）

| ID | 基线决策 | 状态与演进承接 |
| --- | --- | --- |
| **D-001** | 鲸屿定位为 AI Companion & Digital Life Platform | **已确定**（详见 [PRODUCT.md](../PRODUCT.md)） |
| **D-002** | 第一阶段只完成一个完整自主 AI 角色（小鲸 `char_xiaojing`） | **已确定**（详见 [PRODUCT.md](../PRODUCT.md) §4） |
| **D-003** | 其他角色先作为被动桌宠，不先做多 Agent 全自主 | **已确定**（延至 `V2-P5-01` 解锁） |
| **D-004** | Character Identity 与模型 / Harness / 外观 / 声音 / 设备解耦 | **已确定**（`ADR-002` D-102 扩展为 12 域模型） |
| **D-005** | 图片生成优先调用本地 Agent 或在线模型，经统一网关编排 | **已确定**（`MediaGenerationGateway`，见 `V2-P2-03`） |
| **D-006** | 3D 生成优先使用 3D 大模型，Blender 专职后处理与 VRM 导出 | **已确定**（`ADR-002` D-105 明确，见 `V2-P2-04`） |
| **D-007** | 每个角色拥有独立 `VoiceIdentity` 和说话 / 唱歌风格 | **已确定**（`ADR-001` / `ADR-002` D-106 提前至 P1 起步） |
| **D-008** | 同一角色在桌面、游戏和舞台共享统一身份 | **已确定** |
| **D-009** | 保留现有 Whale Isle 工程基础，采用 Strangler Pattern 渐进重构 | **已确定**（`ADR-001` 确认在 `feat/whale-isle-v2` 执行） |
| **D-010** | 独立建设 `Evolution Engine` | **已确定**（`ADR-002` D-110 拆分为 P0 Lite + P4 Full） |
| **D-011** | 研发平面（Dev Plane）与生产运行平面（Runtime Plane）物理隔离 | **已确定**（已落地 `tools/evolution-lite`） |
| **D-012** | 第一款重点打通《星露谷物语》，同步抽象多游戏 Adapter | **已确定**（Terraria / DST / Minecraft 于 P5 正式解冻） |
| **D-013** | MCP、Skills、Harness、插件采用开放适配架构 | **已确定**（`ADR-002` D-111 要求第三方插件独立进程隔离） |
| **D-014** | 商业 / 直播素材必须有明确来源与授权记录 | **已确定**（由 `AssetRegistry` 与 Gate 2 强校验） |
| **D-015** | 社交平台按官方能力和平台规则逐项接入 | **已确定**（`ADR-002` D-107 明确 L1 → L2 → L3 演进路径） |

---

## 二、待实测与 PoC 裁定的工程决策（不凭偏好提前锁定）

> 以下保留自蓝图 §2，标注其中已由后续 ADR 明确工程路线者与仍待 P1–P3 实测验证项：

1. **桌面桌宠渲染格式演进**：P1 延续已验证的零黑帧 VP9-Alpha WebM + Spritesheet；Live2D 与 VRM 3D 舞台在 P2/P3 通过独立渲染后端接入（已由 `ADR-001` 确定基线，细节待 `V2-P3-01` 验证）。
2. **基础说话与唱歌的节奏切分**：`ADR-001` 与 `ADR-002` D-106 已明确 **P1 先交付真实 TTS 说话与口型联动（多轨混音），SVS / SVC 歌声系统留至 `V2-P3-01`**；具体云端 vs 本地模型选型及 GPU 基线在 `V2-P1-02` 与 `V2-P3-01` 实测决定。
3. **主 Agent Runtime 演进边界**：P0–P1 采用轻量可控内核 + `LifeRuntime` 自建编排，外部成熟 Harness（Codex / Claude / Gemini / OpenHands 等）通过 `AgentHarness` 协议接入；是否深度嵌入第三方长期记忆后端（Letta / Mem0）在 `V2-P1-04` 与 `V2-P2-02` 实测比较。
4. **直播第一目标平台**：需在 `V2-P3-02` 逐平台核验官方开放能力与直播权限后决定首通平台（抖音 / B 站）。
5. **Asset Studio 形态**：初期随主中控台（Tidepaper 主基线 + 多主题体系）一体交付；是否支持独立子窗口或单独打包视 P2 资源体量而定。
6. **跨设备与云端同步架构**：P5 `V2-P5-02` 评估局域网直连、用户自建中继或可选托管服务（严禁假设单机即多人）。
7. **商业发行与自制版权资产清源节奏**：商用发行前必须运行清源管线替换全部 `DEV_ONLY_NON_COMMERCIAL` 资产（`dsh-pet` 大肥鱼、`aboutme-pets`、`crosspet`）。

---

## 三、四大核心风险与架构级缓解矩阵

| 风险类别 | 关键风险点 | 强制缓解手段 |
| --- | --- | --- |
| **技术风险** | 跨形态外观漂移；3D 生成网格无法绑定；中文语音延迟与自然度；游戏/网页改版致 Mod 或 Browser 脚本失效；长时记忆污染；Evolution 自动修补引入回归 | Character Bible 三视图锁特征；Blender 自动化检查单；流式分句与超时取消；结构化状态优先 + 确定性回放；`Self` 保护域与级联删除审计；独立 Worktree + 4 道门禁 + 灰度回滚 |
| **平台风险** | 社交平台 API 收缩；直播接口资质限制；自动化风控与验证码；曲库与伴奏版权；观众隐私留存 | 官方开放接口优先，L1 只读先行；逐平台能力矩阵；Per-Character 隔离 Profile，遇验证码安全交还人工；点歌 `LicenseBadge` 强门禁；SQLite 数据分类与删除 SLA |
| **许可证风险** | 非商用桌宠/角色素材误商用；MIT 代码下的模型权重条款不等于可商用；GPL-3.0 传染；字体与曲库侵权 | `licenseScope` 清源标签 + Gate 2 扫描阻断；[OPEN-SOURCE.md](../OPEN-SOURCE.md) 五级许可矩阵；`AssetRegistry` 强制校验来源、Hash 与版权范围 |
| **产品风险** | 首期铺摊过大多线烂尾；过早引入多自主角色；过度打扰或强行抢控；高危游戏操作（卖稀有物）不可逆；更换模型后人格漂移 | 严格执行 **Single Primary Character First**；可配置安静陪伴与沉默权；3 层控制权租约（人类键鼠/急停最高优先级）；高影响操作二次确认；12 域与具体模型完全解耦 |

---

## 四、长期架构判断

鲸屿长期不变的核心资产不是某一个具体大模型、皮肤格式或外部 Harness，而是：

**`Character Identity` + `Memory` + `Voice` + `Embodiment` + `Digital Life` + `Asset Provenance` + `User Trust`。**

只要这七类领域契约与所有权保持稳定，底层模型、语音引擎、游戏适配器和平台接口均可安全替换与持续演进。
