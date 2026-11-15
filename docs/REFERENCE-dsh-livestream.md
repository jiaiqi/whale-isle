# REFERENCE — dsh-livestream 复评档案

> 仓库：https://github.com/luckui/dsh-livestream ｜ 许可证：**代码 MIT + 大肥鱼动画素材 CC BY-NC-SA 4.0**（两段式 LICENSE 原文核实："This license covers the source code only"）｜ 主语言：TypeScript（pnpm monorepo）｜ Stars：76 ｜ 最近推送：2026-10-28
> 分析方式：README 全文 + 顶层结构 + LICENSE 原文；未逐行审计源码。分析日期：2026-11-15

## 1. 结论摘要

B 站直播全链路的参照实现：**真实开播**（调 B 站开播接口 + 经 OBS WebSocket 驱动本机推流）→ 弹幕/礼物/SC/上舰/进场/关注实时收流 → 按轻重缓急逐件交给 agent。README 演示视频标题《大肥鱼彩排、Claudia被记仇？》——**"赛博饭碗"（右上角饭碗 = 这场吃掉的 token 换算的米饭）与"记仇"叙事的直接出处**，是我们直播层体验设计的活样板。

## 2. 采用什么

- **开播/推流链路**：插件调 B 站开播接口 → 驱动本机 OBS（30+，开 WebSocket）推流；弹幕礼物从 B 站消息服务收——M4 OBS 阶段的链路参照（我们用 OBS Browser Source 呈现层，思想一致）。
- **注意力调度原型**："弹幕、礼物、SC、上舰、进场、关注，插件按轻重缓急一件一件交给她"；人多先回舰长和老粉，冷场自己找话说——**P0/P1/P2 三级队列的社区实践出处**。
- **情绪标记 → 表情切换**：在话里写 `[shocked]`、`[shy]`，TTS 念到那里就换表情，且**挑姿势最像的那一帧切，不叠影**——与 SPEC §3.4 情绪前缀（`[傲娇反驳]`）设计同源；"挑最像帧"是 webm 素材换装的衔接细节。
- **常客识别**："这一场和以前来过的观众、他们说过的话都记得；常来的人会被认出来"——常客账本的体验目标。
- **音频 ducking**：她说话时点播视频自动调小声——`voice.duck` 同款机制。
- **舞台透明度**：舞台终端每行记录"调用 …"，观众看得到她做了什么——工具调用可观察性。
- **谢幕结算**：下播谢幕画面（播了多久、几条弹幕、吃了几粒米、谢谢的人）——`SLEEP_OFF_DUTY` 收播仪式参照。
- **模拟观众彩排**：控制台"不开播也能彩排"——`danmaku-storm-replay` 的产品化同思路。
- **密钥管理**：B 站 cookie、豆包 TTS 三元组全走 `.env`，不进仓库。

## 3. 不采用什么（为什么）

- DSH 插件形态与 pnpm monorepo 结构（我们是独立 Electron app，模块边界已按 SPEC 划定）。
- **豆包 TTS**：我们语音主线是本地 GPT-SoVITS（M2 工单），云端降级链已有 SiliconFlow/OpenAI——不为 B 站方案引入第二家云端 TTS。
- **大肥鱼动画素材商用**：`packages/dsh-livestream/assets/characters/dafeiyu/` 为 CC BY-NC-SA 4.0（社区衍生作品），商业用途需自备角色素材或向原作者申请——与 dsh-pet 素材同列台账红线。

## 4. 验证路径、预算边界与回退方案

- 验证路径：M4 真机抽检项（OBS 挂浏览器源）与其演示效果对齐；模拟观众彩排先行（`[SIMULATION]`）。
- 回退：B 站开播接口依赖 cookie 与实名认证，若 M4 只做抖音，其"B 站事件归一"部分仅作归一协议（`NormalizedLiveEventSchema` 的 eventType 枚举）设计参照。

## 5. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-15 | 预置 | 初版档案建立；许可证确认为"代码 MIT / 素材 CC BY-NC-SA 4.0"两段式 | LICENSE 原文核实 |
