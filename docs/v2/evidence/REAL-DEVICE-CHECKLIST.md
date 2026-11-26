# 鲸屿 Whale Isle V2 — 真机验收清单（`[REAL-DEVICE]` 积压 12 单）

> 生成于 2026-11-26 09:40（基于分支 `feat/whale-isle-v2` @ `05707af`，以及 `docs/v2/evidence/*.md` 各自登记的缺口）。
> 目的：在推进 `V2-P3-03` 之前，把 `IMPLEMENTED_UNVERIFIED` 工单按「外部条件」分组，一次准备环境、批量补齐证据。
> 每项完成后：在对应 evidence 文件补 `[REAL-DEVICE]` 段落 → ROADMAP 状态改 `DONE` → 同步 TRACEABILITY / CURRENT / EVALUATION。

---

## 0. 环境准备（先做，解锁后面大部分）

| # | 准备项 | 解锁工单 | 备注 |
|---|---|---|---|
| E1 | 安装 Xcode Command Line Tools（`xcode-select --install`） | 全部 | ✅ **已具备**（2026-11-26 实测）：`xcode-select -p` = `/Applications/Xcode.app/Contents/Developer`，`CLTools_Executables 27.2.0.0.1792721180` 已安装 |
| E2 | 《星露谷物语》+ SMAPI 可启动，`Mods/` 下有 BWF（含 `bwf-patches`）、`WhaleIsleAvatar`、`stardew-mcp-mod` | P1-06、P2-01、P2-06、P2-08 | ✅ **基本具备**（2026-11-26 实测）：游戏根 `~/Library/Application Support/Steam/steamapps/common/Stardew Valley`，SMAPI 4.5.2 在 `Contents/MacOS/StardewModdingAPI`（macOS 无 `.app` 外层）；Mods 实测有 `BlindWhaleFarmer 1.1.27`、`WhaleIsleAvatar 0.3.0-dev.1`、`ConsoleCommands`、`SaveBackup`。⚠️ `stardew-mcp-mod` 未单独安装（仓库内仍为「未开工」，BWF 自带 MCP `18088`）。新启动器已真机拉起并读档成功，见 `P3-stardew-launcher-verification.md` |
| E3 | 第二个星露谷客户端（第二台机器或第二个 Steam 账号） | P2-08 | 联机必须双端 |
| E4 | 真实 API Key：MiniMax / OpenAI 兼容 TTS、Kimi（Moonshot）、MiniMax Coding Plan、图片生成 Key | P1-02、P1-03、P2-03 | 先放进 OS 钥匙串，不要写进 `.env` |
| E5 | OBS Studio + 虚拟声卡（如 BlackHole） | P3-02 | ⚠️ **部分具备**：OBS Studio **33.0.3** 已装于 `/Applications/OBS.app`；未检测到 BlackHole（`/Library/Audio/Plug-Ins/HAL/` 无 `BlackHole*.driver`） |
| E6 | 本地 SVS/SVC Worker（提供 `/sing/health`，返回 `{svs, svc}`） | P3-01 | `vibe/` 下已有 GPT-SoVITS、CosyVoice 仓库（TTS 方向）；歌声需要单独部署 SVS/SVC 推理服务 |
| E7 | 合法 Live2D `.moc3` 模型 + 一个 VRM 模型 | P2-05、P3-01 | 注意许可证要登记进 AssetRegistry |
| E8 | Blender（以及可选 Hunyuan3D） | P2-04 | ✅ **已具备**（2026-11-26）：Homebrew cask 安装 **Blender 5.3.0** 到 `/Applications/Blender.app`，`blender --version` 实测输出 `Blender 5.3.0`；首次启动被 Gatekeeper 拦了一次（已点「完成」放行）。VRM Add-on 尚未验证 |
| E9 | 抖音 / B站 / YouTube 测试直播间权限 | P3-02 | 平台审核周期最长，建议**最先提交申请** |
| E10 | Windows x64 机器 | P1-02 | 仅 SAPI 一项，可最后做 |
| E11 | Codex / OpenCode / Pi / OpenHands CLI 安装登录 | P2-02、P2-03 | `codex login` 同时解锁 Codex 出图 |

> 环境小结（2026-11-26 实测）：**E1 / E2 / E8 已具备**；**E5 部分具备**（OBS 33.0.3 已装，BlackHole 缺失）；E3 / E4 / E6 / E7 / E9 / E10 / E11 仍待准备。

---

## 1. 第一批：只要「星露谷 + SMAPI」（收益最大，4 单）

### `V2-P1-06` 星露谷 AI-First 自主游玩与控制权
- [ ] 开游戏 → 中控台确认 MCP 连接（`127.0.0.1`，不是 `localhost`，见 T-M6-74）
- [ ] AI 自主模式连续跑 1 个游戏日，0 卡死（对照 `STARDEW-STUCK-LEDGER.md`）
- [ ] 13 项控制语义逐项实按：Stop / Pause AI / Resume AI / Take Over / Release Control 等，确认**执行层**真的停（不是只改 UI）
- [ ] 游戏内 F7 与中控台、托盘、桌宠右键三处「我来操作 / 交还给 AI」开关状态同步
- [ ] 交还时，AI 能说出接管期间的变化摘要（地点、时间、金币、背包、体力）
- [ ] P0 急停 → 在途动作立即取消
- 证据：录屏 + `soak-real` 报告目录

### `V2-P2-01` 攻略学习闭环
- [ ] 连续多日实玩，`StrategyNotebook` 条目置信度随实玩回执上升 / 遇到反例下降
- [ ] 夜间复盘产出心得，第二天的规划确实引用了它
- [ ] 装一个会影响机制的 Mod，确认版本/Mod 兼容检查给出提示

### `V2-P2-06` 像素人物与 Stardew Avatar Mod
- [ ] 进游戏查看玩家外观 1× / 放大截图，与导出预览一致
- [ ] 把 `realDeviceInGameVisualVerified` 改为 `true` 并附截图

### `V2-P2-08` CoopRuntime v1 联机（需要 E3）
- [ ] 双端建房 → 小鲸与人类各自持有独立控制租约
- [ ] 任务板分工完成一天的种地/收获
- [ ] 标记 `sell_forbidden` / `keep` 的物品，AI 确实不卖
- [ ] 拔网线断一端 → 宽限重连 → 超时释放资源锁，不死锁
- [ ] 跑 Mod 兼容预检，双端 Mod 不一致时给出提示

---

## 2. 第二批：声音与画面（3 单）

### `V2-P1-02` 语音 / 口型 / 多轨混音
- [ ] 填入真实云端 TTS Key → 实测首包延迟、音色连续性
- [ ] 说话 + BGM 同时播放：鸭降自然、不破音、不互相阻塞
- [ ] 肉眼看桌宠口型开合与音频节奏一致
- [ ] （E10）Windows SAPI 发声，无乱码、无报错

### `V2-P3-01` 统一表演系统
- [ ] 接入 SVS/SVC Worker，`probeBackends()` 返回 `worker_svs` / `worker_svc`
- [ ] 唱一首授权歌曲：歌词时钟与音频对齐（人工听 + 看双语 LRC 高亮）
- [ ] Live2D / VRM 画布实际可见，记录帧率；切换 `desktop-2d → live2d → vrm-3d → obs-stage` 时角色、歌词、口型保持连续
- [ ] 把 `realNeuralInferenceVerified` 和 `realDeviceRenderVerified` 改为 `true`

### `V2-P2-05` Character Bible / Live2D / CrossPet
- [ ] 用真实 `.moc3` 渲染并切换模型
- [ ] 在线 AI 2D 分层生成（需要 E4 里的图片 Key）

---

## 3. 第三批：外部账号与平台（5 单）

### `V2-P1-03` 额度矩阵
- [ ] Kimi：`GET /v1/users/me/balance` 真实响应能被正确解析
- [ ] MiniMax Coding Plan：`GET /v1/api/openplatform/coding_plan/remains` 中 5h 窗口与重置时间解析正确
- [ ] 拿不到的字段仍显示 `unknown`，不编造

### `V2-P2-02` 插件隔离与多 Harness
- [ ] Codex / OpenCode / Pi / OpenHands 逐个装好后真跑一次，把 `verifiedStatus` 从 `adapter-only` 升级

### `V2-P2-03` 图片生成网关
- [ ] 真实 Image API Key 或 `codex login` 后出图 → 进入候选区 → 审核通过/拒绝流程完整

### `V2-P2-04` 3D / Blender（需要 E8）
- [ ] Blender 无头后处理跑通 → 导出 VRM → `inspectGlbOrVrm` 骨骼和口型质检通过

### `V2-P3-02` 直播中控与 OBS（需要 E5、E9）
- [ ] 至少 1 个平台测试直播间真实收流：弹幕、礼物、关注
- [ ] 点一首 NC 曲目 → 被拦截；点一首授权曲目 → 进入排麦
- [ ] OBS Browser Source 叠加舞台，虚拟声卡路由正确
- [ ] 下播后场次摘要内容与真实事件一致

---

## 4. 建议顺序

1. **今天**：E1（CLT）+ 提交 E9 的直播间权限申请（审核时间最长）
2. **第一批**：星露谷 4 单（P1-06 是 V2 的「纠偏核心」，价值最高）
3. **第二批**：声音和画面，可以和 E4 的 Key 配置一起做
4. **第三批**：外部账号，等平台权限下来后再做
5. 全部做完或明确标为 `BLOCKED` 之后，再开 `V2-P3-03`
