# 中控台空状态插画

## 生成记录

- 生成日期：2026-11-26
- 生成工具：OpenAI 内置 image_gen
- 模型：工具没有向调用方公开具体 model ID，因此不臆测型号。
- 风格：Tidepaper「潮汐纸」——暖白纸面、墨蓝手绘线、淡水彩海图纹理；小鲸保持项目现有二次元 Q 版女仆造型。
- 画布：状态插画为 960×720，hero 为 1600×800；全部为带 alpha 的 WebP；单张文件均不超过 250 KB。
- 定妆样张：xiaojing-character-sheet-sample.webp，1024×1024。它是身份锚点样张，不是一个 UI 状态。
- 角色身份参考：项目 blue-whale-maid 的“女仆屈膝礼仪”“待机呼吸休闲”“吃饭·碗饭”“点击回应-傲娇生气”等 WebM 抽帧；场景图以定妆样张和 Tidepaper 首张样式图继续锚定。没有使用 CrossPet 图像。

## 文件清单

| 状态 | Light | Dark | 画面 |
| --- | --- | --- | --- |
| 空聊天 | empty-chat-light.webp | empty-chat-dark.webp | 小鲸趴在空白海图上托腮等待，旁边是无字小气泡。 |
| 空记忆 | empty-memory-light.webp | empty-memory-dark.webp | 小鲸整理装有空白漂流瓶的木箱，手正把一只瓶子放回箱内。 |
| 游戏离线 | game-offline-light.webp | game-offline-dark.webp | 小鲸抱着断线手柄；旁边有一小块耕地和树苗。使用原创通用道具，不含星露谷游戏素材。 |
| 直播离线 | live-offline-light.webp | live-offline-dark.webp | 小鲸坐在熄灯舞台边，麦克风放在台面；没有舞台灯光或光束。 |
| 已暂停 | halted-light.webp | halted-dark.webp | 小鲸双手握住空白八角停止牌，周围海浪静止；牌面无字无符号。 |
| 引导 Hero | onboarding-hero-light.webp | onboarding-hero-dark.webp | 小鲸从桌面岛屿旁的海水中浮出，远处有海平线；左侧保留透明留白。 |
| 定妆样张 | xiaojing-character-sheet-sample.webp | — | 小鲸全身正面略三分之四站姿，供身份核对和后续创作锚定。 |

Dark 版以对应 Light 图为构图参考，保持角色、动作、物件和留白不变；画布外透明，海图纸面区域改为 #0D1220，主线改为暖白 #EEE9DF，珊瑚由 #E5603F 提亮为 #FF7D5C，海潮青保持 #1D7A8A。人物蓝色、白色、金色本身保持可辨，不套整图黑色滤镜。

## 提示词记录

以下是本轮实际使用的分块提示记录：每张 Light 图都组合“角色身份锁 + Tidepaper 风格与禁项 + 对应场景提示”；Dark 图使用对应 Light 图作构图参考，并应用表格中的 Dark 配色约束。生成时逐张调用，参考图在上方文件清单和下表列出。英文关键词按 image_gen 输入语义记录，便于后续复现。

### 共用角色身份锁

> Draw the same Xiaojing from the attached project WebM frames: a 2.5-head chibi anime maid girl, round face, large blue eyes and subtle blush; long wavy deep navy hair fading to ocean-blue ends, separated bangs and curled ahoge; white frilled maid headband; whale-fin-shaped navy side ornaments, not cat ears; small sky-blue bow fixed on her character-left / viewer-right; navy maid dress with white puff sleeves, ruffled apron and hem, navy chest bow with pale-blue accent, small blue whale apron emblem, restrained gold vine details, white socks and dark maid shoes. Preserve face, proportions, hair silhouette, accessory side, costume and palette. She is the actual project character char_xiaojing, not a separate whale mascot. Do not use CrossPet characters or images.

### 共用 Light 风格与禁项

> Tidepaper: warm ivory #F3EFE7, deep ink navy #142036, coral #E5603F as the only bright accent, supporting sea-teal #1D7A8A. Fine hand-inked lines, soft restrained watercolor, quiet editorial composition, sparse chart contours/longitude grid/compass details, generous breathing room. Transparent canvas outside the illustration. No text, labels, letters, numbers, UI, logos, watermark, extra characters, separate whale mascot, photorealism or realistic person. Keep every prop attached to a hand, body or surface.

### 每张图的场景提示

| 文件 | Scene prompt | 角色身份参考 | CrossPet 方法/模板借鉴 |
| --- | --- | --- | --- |
| empty-chat-light.webp | Landscape 4:3. Xiaojing lies prone across a blank nautical chart, elbows on the chart, chin cradled in both hands, waiting with a soft curious pout and eyes toward the viewer. Add one small empty speech bubble with no marks, sparse contour lines, a longitude grid and one small compass rose. | 定妆样张、女仆礼帧、待机帧 | docs/prompts/角色生图提示词.md 的角色锁与获批锚点；art/姿态/thinking.md 的“手靠脸、视线和表情表达状态”；art/规则/通用.txt 的完整轮廓与无文字约束。 |
| empty-memory-light.webp | Landscape 4:3. Xiaojing sits beside a small wooden keepsake crate and carefully organizes sealed glass drift bottles nested inside. She holds one bottle with both hands while placing it into the crate; bottles contain only tiny blank folded paper, no labels or writing. Add quiet chart contours and a small compass. | 定妆样张、女仆礼帧；首张 Tidepaper 图作风格参考 | docs/prompts/角色生图提示词.md 的身份锚定；art/姿态/reading.md、writing.md 的动作可读性与手持物关系；art/规则/通用.txt 的道具接触要求。 |
| game-offline-light.webp | Landscape 4:3. Xiaojing sits holding a simple controller to her chest, mildly disappointed but determined. Its short cable has two visibly disconnected ends and no sparks. Nearby is one small rectangular tilled patch with three furrows and one green seedling. Use only generic original game props and a small chart corner. | 定妆样张、傲娇回应帧；首张 Tidepaper 图作风格参考 | docs/prompts/角色生图提示词.md 的身份锁；art/姿态/tired.md 的状态表情分离；art/规则/多会话.txt 中道具必须和角色/手接触的原则。 |
| live-offline-light.webp | Landscape 4:3. Xiaojing sits quietly on the edge of a small unlit stage, hands together in her lap, looking toward one vintage microphone resting beside her. Stage bulbs are off; no light beam, spotlight or glow. Add only sparse nautical contours beneath the stage. | 定妆样张、待机帧；首张 Tidepaper 图作风格参考 | docs/prompts/角色生图提示词.md 的身份锁；art/姿态/sleeping.md 的安静等待状态写法；art/规则/通用.txt 的道具与轮廓核验。 |
| halted-light.webp | Landscape 4:3. Xiaojing stands steadily and holds a short handle with both hands. The handle supports a blank coral octagonal stop placard with an ivory inset line and no symbol. Three small stylized sea-wave crests around her remain completely still, with no motion lines. | 定妆样张、女仆礼帧；首张 Tidepaper 图作风格参考 | docs/prompts/角色生图提示词.md 的角色锁；art/规则/原地.txt 的动作消歧（脚和身体保持静止）；art/规则/通用.txt 的清楚轮廓与禁字。 |
| onboarding-hero-light.webp | Wide 2:1. Across a sparse transparent sea-chart horizon, Xiaojing rises waist-up from calm water beside a tiny raised island shaped like a desktop workspace. One hand rests on the shore; the other lifts a small wave. Put a tiny blank monitor and stool on the island, a small compass on the right, and preserve open transparent space on the left. | 定妆样张、女仆礼帧；首张 Tidepaper 图作风格参考 | art/交接-API生图/新角色与新皮肤.md 的身份/风格参考分工和先定妆；docs/prompts/展示立绘/01-展示图（衣服卡）.md 的场景构图思路（改为透明宽幅海图）。 |

### Dark 配对提示

每个 dark 输出都以同名 light 图作为首要参考，提示保持脸、发型、服装、动作、物件数量与位置、线宽、裁切、留白完全相同；只调整主题色。地图/纸面区域设为 #0D1220，主线和海图线设为 #EEE9DF，珊瑚改为 #FF7D5C，海潮青保留 #1D7A8A。空白气泡保留暖白内部；漂流瓶保持透明玻璃、木箱保持木色；耕地和树苗保持自然色；舞台与灯具保持熄灭；停止牌保持无字珊瑚八角；Hero 保留左侧透明留白。人物深蓝/海蓝、白褶边和金色装饰需与深色海图分开，不增加发光晕。

## CrossPet 方法说明

本轮只借鉴流程和提示结构，没有把 CrossPet 角色图、角色造型、提示词原文、皮肤、彩蛋或迷你助手素材作为生图输入或成品内容。

- 总体方法摘记：[docs/v2/reviews/crosspet-character-prompt-method.md](../../../../docs/v2/reviews/crosspet-character-prompt-method.md)。
- 小鲸可复用角色锁：[docs/v2/prompts/xiaojing-character-sheet.md](../../../../docs/v2/prompts/xiaojing-character-sheet.md)。
- 上游方法来源：CrossPet docs/prompts/角色生图提示词.md、art/交接-API生图/新角色与新皮肤.md、art/姿态/、art/规则/、docs/prompts/展示立绘/、docs/prompts/贴边/ 和 mini helper 交接。具体采用映射见每张图上表。
- CrossPet 根 LICENSE 的 MIT 仅覆盖源码；角色设计、立绘和提示词由 characters/LICENSE.md 置于 CC BY-NC-SA 4.0。其素材不可直接拿来画小鲸；本轮用的是 Whale Isle 项目已有 WebM 身份参考。

## 权利与许可

小鲸既有角色动画在 packages/pet-renderer/assets/blue-whale-maid/manifest.json 中记录为 CC BY-NC-SA 4.0，licenseScope 为 DEV_ONLY_NON_COMMERCIAL，来源记录为 PC2005-cloud/dsh-pet。新图是依据该角色形象生成的衍生插画，限本地开发和评审；署名 PC2005-cloud/dsh-pet，按 CC BY-NC-SA 4.0 相同方式共享；不得商业使用、公开直播或进入商业发行包。

图像生成服务：OpenAI image_gen。按 [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) 的输出条款处理服务输出权利；条款同时提醒输出可能不唯一，并由用户负责输入/输出权利。服务条款不扩大源角色素材许可，仍以更严格的角色来源范围为准。工具没有披露本次具体模型 ID。

AssetRegistryV2 的 AssetRegistryCategorySchema 目前没有 UI/空状态插画类别；本批不伪装登记成 stage_background 或 desktop_wallpaper。每张文件的来源、授权标记、模型供应方、输入参考、尺寸、文件大小和 SHA-256 见同目录 asset-provenance.json。

## Dark 版外缘描边后处理

2026-11-26 对 6 张 `-dark.webp` 做了确定性后处理，没有重新生成图像：以人物和前景道具的 alpha 轮廓做外扩，常规场景外扩约 3 px，`onboarding-hero` 按画布比例外扩约 4 px；在轮廓外侧加入 `#EEE9DF`、约 55% 不透明度的暖白贴纸描边，并以 1 px Gaussian blur 羽化边缘。背景透明区保持透明，合成预览使用 `#0D1220`。Light 文件未处理。输出重新编码为 WebP；每张仍小于 250 KB。

前后合成自查图：`/tmp/whale-dark-outline-before-after.png`；`halted` 全尺寸对比：`/tmp/whale-halted-outline-before-after.png`。

## 视觉与文件核验

- 6 对场景 light/dark 的像素尺寸分别为 960×720；onboarding-hero 为 1600×800。
- 每张输出均为 RGBA WebP，透明背景保留；各文件小于 250 KB。
- 手工核对角色脸、眼睛、发色、观者右侧发结、白褶边头带、鲸鳍侧饰、女仆裙与鲸鱼围裙标志；核对气泡/瓶身/屏幕/停止牌没有文字。
- 生成中发现的整页底纹 Hero 初稿未采用；最终 Hero 改为透明宽幅图。
