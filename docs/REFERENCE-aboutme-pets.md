# REFERENCE — aboutme-pets 复评档案

> 仓库：https://github.com/hunmer/aboutme-pets ｜ 许可证：**素材 CC BY-NC-SA 4.0（上游 README「来源与许可」节声明）；仓库根无 LICENSE（git 全历史从未有过）；`Transparent-Video-Maker/` 子目录 MIT（第三方依赖 ffmpeg GPL v3 / rembg MIT）；仓库代码（index.html 播放器、转换脚本）无许可**（2026-11-24 逐包核实）｜ 构成：Python 转换链 + 9 包素材（1,040 动作 VP8X alpha 640×360 精灵图 @12fps + 480 m4a 音轨）｜ 本地克隆：`~/Documents/vibe/reference-clones/aboutme-pets`
> ⚠️ **许可口径修正（2026-11-24）**：本仓台账原记「MIT（每套包内 LICENSE-assets.txt / LICENSE-code.txt）」有误——仅 `pets/dsh`、`pets/dsh1` 两包包内带 MIT 文本（Copyright PC2005-cloud，即 dsh-pet 作者）且上游 README 明言「上游两份 LICENSE 均为代码 MIT，不覆盖素材限制；素材禁止商用」；其余 7 包（gpt/claude/gemini/qwen/glm/grok/kimi）无任何 LICENSE 文件；基础立绘来自 crosspet（CC BY-NC-SA）。dsh/dsh1 包内 MIT 文本不改变底层形象权（溟月 @上善无形 / ZipZipPipe 非商用声明）。THIRD_PARTY_NOTICES.md 已同步修正。

## 1. 结论摘要

桌宠素材商店 + 双向转换链。对本仓的价值：① 9 包 1,040 动作的**素材广度**（已全量随包直入并由 sprite-sheet 路径消费）；② manifest 公开 JSON 结构（`animations[]{id,category,sources.webp,spritesheet{frameWidth,frameHeight,columns,rows,frameCount,fps},facing}`）；③ **音画同步时钟**思想（有音轨时 `frame = audio.currentTime × fps`，index.html:518）；④ MIT 的 Transparent-Video-Maker（绿幕/纯色抠像 + rembg AI 抠像 + PNG 序列回编码）是自制素材链（T-F）的可直移组件。

## 2. 采用什么

- **已融合**：9 包导入器（`aboutme-pets.ts` ABOUTME_PACKS → userData/pet-characters）+ 随包直入（sync-pet-packs include `pets/` 全量 → extraResources）；SpritesheetRenderer canvas 逐帧 + 帧 JSON 回退；动作音轨 m4a 播放 + TTS duck 15%；idle-mix 混播；patrol 用 `moving` 帧区间与 `facing` 镜像。
- **待融合**（工单 T-E 候选）：音画同步时钟（有音轨动作以音频驱动帧号，消除声画错位）；上游 12 分类（待机/移动/玩耍/日常起居/吃喝/运动健身/才艺表演/手工节日/工作职业/娱乐休闲/情绪反应/换装造型）接入 ambient-filter 场景过滤；`make_petpack.py` 的动画池映射表（待机/拖拽/点击/移动/余额档/碎碎念/工作状态/睡觉三段/对话表演）作 9 包统一槽位映射参照；无音轨包（claude 8 条 / dsh1 2 条）降级不挂 audio。

## 3. 不采用什么（为什么）

- 仓库代码（index.html 播放器、convert_video_pet_spritesheet.py、spritesheet_to_video_pet.py、make_petpack.py）：**无许可证**，默认保留所有权利——只解析其公开 JSON 结构、参考思想，本仓已有自研实现，不抄码。

## 4. 验证路径、预算边界与回退方案

- 9 包导入端到端验证 + 逐包音轨覆盖实测（待证，README 表为 96/97/106/105/66/8/2 条口径）。
- 素材商用前按 THIRD_PARTY_NOTICES §3 商用清洗线整包替换；公开使用须署名 hunmer/aboutme-pets 与 crosspet 原作者。

## 5. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-21 | 第二轮代码级复评 | 初次入表（REFERENCES §4：spritesheet↔webm 双向转换、音画同步播放器、`moving` 位移数据结构） | 21 仓库深挖 |
| 2026-11-24 | 融合分析（recon/07） | 本档案建立；**许可口径由「MIT」修正为「CC BY-NC-SA（README 声明）」**；TVM 子工具 MIT 确认；9 包音轨覆盖不均已量化 | 逐包 LICENSE 文件核实 + 上游 README 原文 |
