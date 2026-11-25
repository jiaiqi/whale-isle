# 鲸屿 Whale Isle V2 · 曜潮设计体系 (Obsidian Tide)

本目录为 **Whale Isle V2 / V2.1** 的完整静态高保真原型套件（共 **16 个文件**），在 `design/v2/`（Tide v5 完整信息架构）的基础上，深度融合：

1. **视觉体系**：`whale-isle-v2-obsidian.html` 的 **曜石深海（Dark） / 晨汐瓷白（Light）** 五层材质色带，**默认 `data-theme="system"` 自动跟随操作系统浅深色**，并支持一键三态循环切换。
2. **双窗硬件约束**：桌面透明桌宠窗（`pet-stage.html`）与托盘状态气泡（`tray-popover.html`）保持完全独立，不强行嵌死在普通中控台内部；通过共享状态键 `wi-v2g-state` 与底部双窗状态条协同。
3. **单一角色锚点**：全局 16 个文件统一以 **小鲸（`char_wh001`）** 为第一数字生命锚点，搭配被动伴侣 **泡芙（`pet_puff`）**，消除历史原型角色命名漂移。
4. **全量蓝图覆写**：100% 映射 `docs/Whale-Isle-V2-Blueprint/` 00–17 篇全部文档（含 V2.1 `17-自演进与开发工坊`）与 `docs/ROADMAP.md` 当前诚实接线状态。

---

## 文件清单（16 个文件）

### 核心基础设施与桌面独立窗口（5 个）
| 文件 | 说明 |
| :--- | :--- |
| `tokens.css` | Obsidian Tide 五层材质令牌、`system/dark/light` 配色、`.strata` 导航、`.sonar` / `.receipt` / `.lic` / `.hud` / `.why` 共享组件样式 |
| `shell.js` | 六大世界 × 十页公共壳、顶部控制仲裁条、全局 `⌘K` 命令面板、脱敏 `标记问题` 上报弹窗（联动 `evolution.html`）、底部双窗条与饭碗投喂 |
| `index.html` | 总览 Gallery：6 大原则、5 层材质条、4 个可交互核心组件、3 桌面表面、6×10 页面导航、蓝图 00–17 映射表、S1–S5 诚实迁移表 |
| `pet-stage.html` | 独立透明桌面桌宠窗：小鲸 VP9-Alpha 概念舞台、拖拽、紫色虚线 `<think>` 云、`大肥鱼` 0-Token 喷水、被动伴侣泡芙、壁纸试看 |
| `tray-popover.html` | 独立 344px 菜单栏状态气泡：心情状态、饭碗实时余额与投喂、AI/玩家切控、静音/睡眠切换 |

### 六大世界 × 十个中控台页面（10 个）
| 世界 | 文件 | 核心能力与原型要点 |
| :--- | :--- | :--- |
| 世界 1 · 伴侣与身份 | `chat.html` | 指挥台 ⇄ 数字生命仪表盘双模式切换、9 态声呐、6 维度目标、Token 五分账、304px `GET_STATE` 侧栏 |
| 世界 1 · 伴侣与身份 | `identity.html` | `char_wh001` 6 维滑块、BR/BD 红线、30 天偏好演化、V/A 情绪轨迹、安静陪伴、声线 `voice_2b7q` 与 `SpeechPerformancePlan` |
| 世界 1 · 伴侣与身份 | `embodiment.html` | Constellation 状态映射、Character Bible 三视图与红锁部位、WebM/Live2D/VRM 技术对比、版本回滚、`L1–L3` 梯子 |
| 世界 2 · 自主数字生命 | `digital-life.html` | 作息调度、3 门禁预算、3×7 平台发现矩阵、`BLOCKED_CAPTCHA` 红线、P4 社交草稿、2-hop SVG 记忆图谱、真删除 |
| 世界 3 · 舞台与协玩 | `game-coop.html` | BWF `:18080` 互斥锁与 `.hud`、8 步决策循环、3 候选四维评分、4 态回执流、朋友式商量、稀有物卖前确认 |
| 世界 3 · 舞台与协玩 | `live-stage.html` | 场控与降级提示、Attention Inbox 30s 合并、P0/P1/P2 队列、曲库 `lic` 拦截、`audio_clock` 双语歌词、声卡隔离 |
| 世界 4 · 创作与资产工坊 | `creative-studio.html` | 5 类工坊、5 列 10 态看板、`AutoQA 4/4`、9 项 3D VRM 检查单、11 步像素流水线、Entry A 计费与商业清源 |
| 世界 5 · 平台与工具生态 | `platform.html` | 4 组模型供应商（含 `未知 / 不可查询` 诚实态）、5 任务路由、3 ACP Harness、MCP 鉴权、SKILL YAML 与 4 层沙盒 |
| 世界 6 · 安全治理与自演进 | `governance.html` | P0–P5 权限阶梯、零明文 Vault（`kc_*`）、Profile 隔离、Computer Use 互斥锁、72h 删数 SLA、许可证台账、7 步演练 |
| 世界 6 · 安全治理与自演进 | `evolution.html` | `whale-isle-dev` Dev Plane 分离宣言、6 列 Dev Board、Issue `#212` L4 人类审批门、Topbar 实时入队、8 条绝对禁令 |

### 说明文档（1 个）
| 文件 | 说明 |
| :--- | :--- |
| `README.md` | 本文件 |

---

## 全局快捷键与工程约束

- **`⌘K` / `Ctrl+K`**：打开全局快速跳转与指令指挥面板。
- **`F8`**：P0 紧急停手，立即将控制权切回人类玩家。
- **`F9`**：在 AI 托管与玩家掌控之间一键切换控制权。
- **`F10`**：切换小鲸「睡眠安静模式」。
- **100% 本地离线可运行**：全部图标通过本地 `../vendor/lucide.min.js` 渲染，零外网 CDN 请求、零彩色 Emoji。

## 本地预览方式

请在仓库 `design/` 目录下启动本地静态服务器，以确保 `../vendor/lucide.min.js` 正常解析：

```bash
cd design
python3 -m http.server 8765
```

然后在浏览器访问：`http://127.0.0.1:8765/v2-gemini/index.html`（建议同时打开 `pet-stage.html` 与 `tray-popover.html` 并列预览三窗联动效果）。
