# Whale Isle V2 — 开源项目研究、复用策略与许可证治理（Open Source & License Policy）

> **上游依据**：[12-技术选型与开源项目复用.md](./blueprint/12-技术选型与开源项目复用.md) · [TAKEOVER-AUDIT.md](./TAKEOVER-AUDIT.md) · [REFERENCES.md](../REFERENCES.md) · [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)

---

## 一、总原则（Build vs Reuse）

尽量复用成熟开源生态与外部引擎，**绝不把项目清单当作无条件依赖表**。所有候选必须通过：功能匹配、维护状态、源码 vs 权重 vs 素材许可证分离审查、安全边界、部署体积与二次开发成本评估。

- **优先复用外部生态**：浏览器自动化（Playwright / Browser Use）、音视频处理与混音（FFmpeg）、3D 网格与后处理（Hunyuan3D API/权重 + Blender）、TTS/SVS/SVC 模型、MCP/ACP/Skills 开放协议、Git/Worktree 基础设施、游戏官方 Mod 框架（SMAPI / tModLoader）。
- **必须由鲸屿自研掌握**：`CharacterCore` 12 域身份模型、`LifeRuntime` 活动协调器、`PerformanceDirector` 统一表演编排、`AssetRegistry` 授权清单、控制权三层租约、Policy Broker 与审计、AI-First 游戏自主判断与 `CoopRuntime`、Evolution Engine 策略与门禁。

---

## 二、核心参考项目深度复用结论

### 2.1 `lokicorvus/crosspet` (v1.4.1)
- **两段式许可**：源码 **MIT**（可参考与移植）；`characters/` 下立绘、角色设定与生图提示词 **CC BY-NC-SA 4.0**（署名 上善无形 / ZipZipPipe 等，**禁止商用**）。
- **明确复用与吸收**：
  1. `character.json` 的状态-姿态-台词多档池映射、`correctedPose` 打断反应与 `longThink` 思考态转换。
  2. 10 颗心好感度系统与按天回溯小本子（已于 `packages/local-store/src/friendship.ts` 基于 `node:sqlite` 落地）。
  3. 多 AI CLI 工作跟随钩子理念。
  4. **V2 完整合规导入**：Creative Studio（`V2-P2-05`）支持合法导入全部 CrossPet 角色包展示与本地互动，**强制自动打标 `DEV_ONLY_NON_COMMERCIAL` 并阻断进入商业/公开直播输出**。
- **明确不采用**：不移植其 C#/Swift/Web 三端分离桌面壳与安装脚本；商用发行前必须由创作工坊生成鲸屿自有版权资产替换。

### 2.2 既有 V1 评估确认的外部参考
- **桌宠与物理交互**（`PC2005-cloud/dsh-pet`，代码 MIT / 素材 CC BY-NC-SA 4.0）：已复用 TTL 语音锁、播放回执、睡眠模式与 WebM 透明渲染链；内置大肥鱼 114 个 WebM 严格标为 `DEV_ONLY_NON_COMMERCIAL`。
- **模型网关与供应商 UX**（`CC Switch`、`Magpie`）：吸收供应商预设胶囊、Region/Plan 区分、路由粘性、隐私脱敏与四级额度查询理念。
- **游戏控制架构**（`BlindWhaleFarmer` MIT / `TerraBlind` MIT / `fruitstarzero AI Companion` MIT）：吸收互斥动作锁、`uncertain` 重试收敛、物理键鼠瞬间接管、模组内 HTTP 三段式回执与 DST 官方 653007 通道。
- **视觉复盘切片**（`SAOS-3624/dsh-video-storyboard` Apache-2.0）：仅复用 45s 环形切片与事后复盘思路，保留 NOTICE 与署名；实时游戏控制严禁走视觉 OCR 兜底，100% 走结构化状态。

---

## 三、V2 新增能力域开源技术选型雷达（实施前逐项复评）

| 能力域 | 候选项目 / 协议 | 定位 | 准入与风险约束 |
| --- | --- | --- | --- |
| **Agent / Memory / Harness** | **MCP / ACP / Agent Skills** | 开放标准协议 | 作为一等生态标准双向适配（`V2-P2-02`） |
| **长期记忆与图谱** | **Letta / Mem0 / Graphiti** | 记忆架构参考或可选 Provider | 研究提取、巩固与时间衰减设计；本地权威存储保持 `node:sqlite` + JSONL（不引入强耦合后端服务） |
| **研发 Harness** | **OpenHands / Codex CLI / Claude Code / Gemini CLI** | Evolution Engine 执行驱动 | 通过 [agent-adapter.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/tools/evolution-lite/src/agent-adapter.ts) 可插拔调用，禁止绑定单一供应商 |
| **Browser / Computer Use** | **Playwright / Browser Use / Stagehand / OS UI Automation** | 确定性与语义浏览 | 确定性 Playwright 优先；受 `ComputerUseLease` 与独立 `BrowserProfile` 严格约束 |
| **图片与 3D 管线** | **在线图片 API / 本地 Agent（Codex）、Hunyuan3D、Blender、VRM Add-on** | 生成与绑定导出 | 核对 Hunyuan3D 具体权重/API 商用条款；ComfyUI 仅作可选外部工作流避免捆绑传染 |
| **语音与歌声** | **CosyVoice / MOSS-TTS / 实时云端 API / SVS / SVC / FFmpeg** | 真实说话与唱歌 | 严禁把普通 TTS 冒充 SVS/SVC；基础语音 P1 优先通过 `VoiceProvider` 接入而非打包数 GB 推理栈。**权重按逐文件口径判定**（[O5-svs-svc-weight-license-per-file.md](./evidence/O5-svs-svc-weight-license-per-file.md)）：许可干净的只有 HuBERT(Apache-2.0)、FCPE/CREPE(MIT)；RVC 官方底模带「仅供研究使用」条款、OpenVPI 声码器 CC BY-NC-SA、DiffSinger 官方 checkpoint 权重许可未声明、RMVPE 无 LICENSE |
| **社交平台能力** | 官方开放平台 API 优先；社区 MCP/Skills 仅作参考或实验 | 抖音 / B 站 / 小红书 | 严禁将非官方逆向爬虫当生产依赖；逐平台核验规则与授权 |

---

## 四、五级许可证与合规红线（Gate 2 自动化拦截）

1. **安全可商用源码（MIT / Apache-2.0 / BSD）**：允许复用或二次开发，须保留原版权声明、许可证原文及 `NOTICE`（归档于 `docs/licenses/` 与 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）。
2. **模型权重与生成服务条款**：**MIT 代码不等于模型权重或 API 输出可商用**；每个模型与 API 须单独记录权重许可与商用条款。
3. **非商用测试素材（CC BY-NC-SA 4.0 / 未明示版权）**：仅限本地开发测试（`licenseScope: "DEV_ONLY_NON_COMMERCIAL"`），`AssetRegistry` 与打包脚本阻断其进入公开直播与商业发行包。
4. **绝对禁抄红线（UNLICENSED）**：`newbeejmc/Dsh_douyin`、`fore-vip/dsh-live`、`Journey-Together` 等未授权仓库严禁复制任何源码或测试夹具，由 [verify-gate.mjs](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/tools/scripts/verify-gate.mjs) 自动阻断。
5. **传染性红线（GPL-3.0 / AGPL）**：`cortico-world-douyin-live`、`TShock`、`HEROsMod`、`dst-admin-go` 等 GPL-3.0 项目严禁 vendor 引入主仓，防止整仓协议传染。
6. **生成式素材与角色衍生图**：服务条款决定图像输出的权利范围，不能扩大输入角色素材的许可。基于 `blue-whale-maid` 现有角色形象生成的插画继续标记 `DEV_ONLY_NON_COMMERCIAL`，按 CC BY-NC-SA 4.0 署名和相同方式共享，不进入商业发行或公开直播；逐项来源、提示词、工具及服务条款登记在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 与素材目录 README。
