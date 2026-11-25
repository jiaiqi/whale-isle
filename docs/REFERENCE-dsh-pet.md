# REFERENCE — dsh-pet 复评档案

> 仓库：https://github.com/PC2005-cloud/dsh-pet ｜ 许可证：**代码 MIT**（LICENSE 原文核实）｜ 主语言：TypeScript ｜ Stars：6292 ｜ 最近推送：2026-11-15
> 分析方式：README 全文 + 顶层结构 + LICENSE 原文；未逐行审计源码。分析日期：2026-11-15

## 1. 结论摘要

可直接移植的桌宠**渲染 / 物理 / 资产链底座**（MIT，且是同生态最高成熟度：npm 发包、独立模式绿色包、多端实测）。但注意两级红线：① 代码 MIT 可移植需保留版权头；② **"大肥鱼（DeepSeek 鲸鱼娘）"形象本身为 CC BY-NC-SA 4.0**（原型溟月 @上善无形，DeepSeek 女仆版设计 @ZipZipPipe，B站声明原文：不可以以任何形式商业化），内置动画素材连带受限——`DEV_ONLY_NON_COMMERCIAL` 标记是硬约束。

## 2. 采用什么

- **渲染形态**：三种运行形态（DSH web overlay / Electron 透明置顶窗 / 完全独立模式）——与我们 `desktop-host` 的 pet-stage + obs-layer 双形态同构；100+ 段 VP9-Alpha webm 动画按权重**首尾相接无缝衔接**（印证双 video 交叉淡入方案）。
- **物理交互**：点击 Q 弹、拖拽甩抛、双击弹弓、宠物互撞，同一套物理与挤压手感参数可调；**多显示器异构 DPI**（各屏工作区为界、任务栏条带、屏间空洞判定、可锁定当前屏）。
- **安静模式**：睡觉时随机动作 / 碎碎念 / 余额 / 待办全部不打扰 + 周期梦话——`sleep_mute` 状态的直接出处。
- **余额分档动画**：按余额已用百分比分档（满溢→告急→分文不剩）播动画弹气泡——"赛博饭碗"饥饿态动画的分档参照。
- **对外接口设计**：`openapi.yaml`（OpenAPI 3.1 完整契约）+ HTTP（只监听本机）与页内 Cordis 双通道、动作类只回 `{ok}`、数据统一从 `GET /state` 读——与我们"契约先行 + JSON-RPC 回执"的思路一致。
- **工程分层**：`host / client / shared（纯逻辑）/ standalone` 四层，物理与菜单归 shared 便于单测。
- **资产三件套**：`prompts/`（绿幕提示词配方）→ 绿幕视频 → 透明动画管线（`MAKE-YOUR-OWN-PET.md`）→ 插件；CI 含 Safari/HEVC `.mov` 转码流水线——T-M2-04 素材管线的直接蓝本（macOS Safari 不认 webm alpha 会黑底，需 `.mov` 分支）。

## 3. 不采用什么（为什么）

- DSH 插件宿主形态：我们是独立 Electron 宿主，仅吸收机制。
- 手机触屏 / 重力传感器 / 摇一摇玩法：非本项目目标平台能力。
- 天气定位、待办清单等周边功能：超出范围，不引入。
- **内置"蓝色大肥鱼" `.webm` 素材商用**：CC BY-NC-SA 4.0。

## 4. 验证路径、预算边界与回退方案

- ✅ **已核实（2026-11-15，FEATURES.md「🔊 语音」节原文）**：① **"哪一端出声：一次只在一端响——按这只宠物的显示位置推导，两端都开时优先桌面端"**（单端互斥锁语义）；② **"气泡会等语音：合成慢的时候气泡挂着等，出声并播完再收，不会出现'字没了才响'"**（播放完成回执驱动 UI 生命周期）；③ **"合成失败或超时，气泡上留一个静音喇叭，不打断对话"**（失败/超时兜底路径）。TTL 超时与排队为本仓在上述机制上的工程化（`AudioLeaseManager`：TTL 强制释放 + 优先级队列 + P0 抢占）。
- 验证路径：T-M1-01 组件单测（状态切换零黑帧）+ T-M1-02 Playwright 验证 alpha 穿透阈值。
- 回退：若其语音锁实现复杂或与 Electron 不适配，以 `AudioPlaybackLeaseSchema` / `AudioPlaybackReceiptSchema` 契约自研（dsh-pet 仅作机制参考）。

## 5. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-15 | 预置 | 初版档案建立；许可证由"MIT（素材待核实）"细化为"代码 MIT + 大肥鱼形象/素材 CC BY-NC-SA 4.0" | GitHub API + LICENSE 原文核实 |
| 2026-11-24 | 融合分析（recon/07） | 复核：11-15 后仅 1 提交（fb38ce6 记忆素材修复），§2/§3/§4 结论全部维持；补充 **DIY 素材链（prompts/ 3 配方 + chroma_step02 HSV 自动抠像 + 睡觉三段帧连续规则）为 MIT 直移蓝本**，与 Transparent-Video-Maker（MIT）共同构成 T-F 自制素材管线 | 本地克隆 HEAD fb38ce6 + FEATURES/MAKE-YOUR-OWN-PET 全文 |
