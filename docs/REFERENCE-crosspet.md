# REFERENCE — crosspet 复评档案

> 仓库：https://github.com/lokicorvus/crosspet ｜ 许可证：**代码 MIT（根 LICENSE 尾注「仅覆盖源码」）+ `characters/` 立绘/设定/生图提示词 CC BY-NC-SA 4.0（characters/LICENSE.md，署名上善无形 / ZipZipPipe 等）**（2026-11-24 原文核实）｜ 主语言：C#（Windows）/ Swift（macOS）/ JS（web）｜ 版本：v1.4.1（2026-11-24）｜ 本地克隆：`~/Documents/vibe/reference-clones/crosspet`
> 分析方式：LICENSE 全文 + CHANGELOG（1.3.9→1.4.1）+ characters/ 结构抽样（claude 全字段、egg-deepseek 五文件）+ integrations/ 14 目录清单与 `crosspet-hook.py` 关键行；未逐行审计 14 个集成实现与全部角色 JSON。深度融合分析见 `recon/07-pet-trio-fusion.md`。

## 1. 结论摘要

跨 AI 状态桌宠：hook → 状态 JSON → pose 映射 + 静态立绘（约 60 姿态/角色，含 8 节日 fest_*、贴边 peek、busy/dizzy/coaxed 等）。对本仓的价值集中在**机制思想与关系成长内容**（台词体系、小本子、友谊、彩蛋），宿主层（C#/Swift/web 三端）与 Electron 架构不同构，不移植。角色包已随包直入（`assets/pet-packs/crosspet/`，907 webp）并被 pose-skin 渲染路径消费。

## 2. 采用什么

- **已融合**：pose-skin 渲染 + 姿态动效；character.json（lines/fx/greeting/fest_*）读取（`pet-packs.ts` readCrossPetPoseProfile / readCrossPetCharacters）；egg-* 五段彩蛋剧场（readCrossPetEggScripts → egg-theater）；8 套手写字体（notebook-fonts）；友谊规则（friendship.ts 自述移植其 friendship.js）；久坐/喝水提醒；Alt「让开」（global-alt-peek）；集合/解散/叫出来（pet-control-host）；前台应用匹配角色（≈ character.json `apps` 字段）；CLI 工作跟随 hook（9 来源）。
- **待融合**（工单 T-G/T-I 候选）：气泡停留按字数 12–20 秒；`BIG_JOB_TOOLS = 8` → proud 姿态（crosspet-hook.py:876）；`correctedPose`（出错/被打断道歉）；小本子按天留页（有事才留、回溯 60 天）+ 成就纪念日 + 批注落款随机；每对台词三档 6+ 段、引用真实数字、带冷却；迷你小帮手（1.4.1，tools/mini_*.py 素材链）；TRAE / OpenCode / CC GUI / WorkBuddy / Hermes 接入面；CLI 额度显示（Claude/GPT/Gemini 5h/周 + Codex 重置语义）；性格皮肤独立口吻；按会话内模型换角色。

## 3. 不采用什么（为什么）

- C#/Swift/web 三宿主、安装/更新脚本链：本仓是 Electron 单宿主，机制由本仓自有代码承担。
- 额度探测的平台特定实现（如 Windows Codex git.exe 强杀修法）：仅思想。

## 4. 验证路径、预算边界与回退方案

- 台词/文案类移植（CC BY-NC-SA）逐批登记素材台账（THIRD_PARTY_NOTICES §3），署名 CrossPet 与原作者。
- 机制移植前先读对应源文件复核（本档案是索引不是替代）；每项机制改动独立、可单独撤销。

## 5. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-21 | 第二轮代码级复评 | 初次入表（REFERENCES §4：hook→状态→pose、BIG_JOB_TOOLS、lines{pose:[台词池]}、31 角色 919 立绘） | 21 仓库深挖 |
| 2026-11-24 | 融合分析（recon/07） | 本档案建立；本地克隆升级至 **v1.4.1**（新增豆包/群星 GPT/迷你小帮手、接入 TRAE/OpenCode/CC GUI）；许可证二段式（代码 MIT + 角色 CC BY-NC-SA）由 LICENSE 原文确认 | 用户要求深度融合三桌宠上游 |
