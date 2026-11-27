# P3-01 素材需求书：原创蓝鲸女仆 VRM 1.0

> 状态：**需求规格（供美术 / 3D 生成工具直接执行）** · 日期：2026-11-27 · owner 决策
> 适用范围：桌面桌宠、中控台预览、OBS 舞台三类输出的统一角色形象。
> 关联：[ROADMAP.md](./ROADMAP.md) `V2-P3-01` / `V2-P3-07C`、[adr/](../adr/)、[REQUIREMENTS.md](./REQUIREMENTS.md) `REQ-CR-02` / `REQ-EMB-04`。

---

## 0. 为什么必须重做（一句话说清边界）

现有「大肥鱼」形象及全部衍生动画素材是 **CC BY-NC-SA 4.0**（原型与二创形象授权），明确**禁止商业使用及公开直播**。

owner 2026-11-27 定调：

- **设定保留**——蓝鲸女仆这个角色设定（性格、配色倾向、女仆装束、鲸鱼特征）继续用。
- **素材必须原创重做**——新模型不得是任何第三方作品的衍生，**不得复用现有 CC BY-NC-SA 素材的任何像素、网格、贴图或动画数据**。
- 交付物必须是**可商用 + 可再分发**的原创 VRM 1.0，许可字段由我们自己在 `meta` 里写明。

> 「设定」是抽象概念，不受版权保护；「素材」是具体表达，受版权保护。这条线就是本文件的核心：**照设定重画，不照素材复制。**

---

## 1. 交付物清单（缺一不可）

| 交付物 | 格式 | 说明 |
| --- | --- | --- |
| 角色模型 | `.vrm`（VRM 1.0，glTF 2.0 二进制 + `VRMC_vrm` 扩展） | 主交付物，见 §2 硬性规格 |
| 源文件 | `.blend` + 贴图源（PSD 或分层 PNG） | 便于后续改表情 / 改服装 |
| 表情清单 | Markdown 或 JSON | 逐条说明每个 blendshape 对应的通道与预期观感 |
| 动作清单 | 见 §4 | 首版至少要能演 idle / 说话 / 吃饭 / 生气喷水 / 困倦 |
| 授权声明 | 文本 | 作者署名、许可范围、是否允许再分发与商用 |

**不接受的交付物**：只有 `.glb` 没有 VRM 扩展的、只有网格没有 blendshape 的、贴图带第三方素材的、从其它模型改出来的。

---

## 2. VRM 1.0 硬性规格（可逐条验收）

以下字段名与取值均以 `vrm-c/vrm-specification` 的 `VRMC_vrm-1.0`（Status: **Complete**）为准。
**注意：该规格仓库本身没有任何 LICENSE 文件，禁止把它的 JSON Schema 文件复制进本仓库**；需要类型时用 `@pixiv/three-vrm` 附带的 MIT `types-vrmc-*`。

### 2.1 顶层结构

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 扩展名 | `VRMC_vrm`（大小写敏感） | 不是 `VRM`、不是 `vrm` |
| `specVersion` | `"1.0"` | 规格强制字段 |
| `meta` / `humanoid` | 必须存在 | 规格里只有这三个是强制的 |
| 渲染配套扩展 | `VRMC_materials_mtoon`（卡通着色）、`VRMC_springBone`（头发/裙摆物理） | **这两个不是 `VRMC_vrm` 的子字段**，是并行挂在 glTF 材质/根节点上的独立扩展 |

### 2.2 `meta`（许可与身份，逐字段写死）

| 字段 | 必填 | 本项目要求值 | 理由 |
| --- | --- | --- | --- |
| `name` | ✅ | `小鲸（蓝鲸女仆）` | 规格强制 |
| `authors` | ✅ | 实际作者署名（至少一项非空） | 规格强制；也是 `creditNotation=required` 时的署名来源 |
| `licenseUrl` | ✅ | **`https://vrm.dev/licenses/1.0/`** | VRM 1.0 只接受这一个值 |
| `avatarPermission` | — | `everyone` | 默认 `onlyAuthor` 会把我们锁死 |
| `commercialUsage` | — | 公司主体运营填 **`corporation`**；仅个人主体填 `personalProfit` | 默认 `personalNonProfit`；**「个人可商用」不等于「公司可商用」**，公司直播必须 `corporation` |
| `modification` | — | `allowModificationRedistribution` | 我们需要改表情/动作并再分发 |
| `allowRedistribution` | — | `true` | 默认 `false`；不打开就无法随安装包分发 |
| `creditNotation` | — | `required`（作者要求可改 `unnecessary`） | 默认 `required`，署名成本很低，别省 |
| `version` | — | 语义化版本，如 `1.0.0` | 便于资产台账追踪 |

> 这七项是**产品能不能合法卖、能不能随包发**的开关，比多边形数量重要得多。交付时必须逐项核对，不接受「默认值先放着」。

### 2.3 `humanoid`（骨骼）

规格 schema 强制 15 根：`hips`、`spine`、`head`、左右 `upperLeg` / `lowerLeg` / `foot`、左右 `upperArm` / `lowerArm` / `hand`。

本项目额外要求（不做「必需」但桌宠必须能自然动，缺一根就达不到观感）：

- 躯干：`chest`、`upperChest`、`neck`（有 `chest` 才能有 `upperChest`）
- 面部：`leftEye`、`rightEye`、`jaw`
- 肩与脚趾：`leftShoulder` / `rightShoulder`、`leftToes` / `rightToes`
- 手指：至少 `Thumb` / `Index` / `Middle` / `Ring` / `Little` 的 `Proximal`（完整 Distal 更好，但非必需）

硬性约束：humanoid 骨骼的 **scale 分量必须为正数，零不允许**。

### 2.4 `expressions`（表情与口型）

规格里所有 preset 都是**可选**的，所以这里逐条点名，缺一个都算不合格：

| 用途 | 必须存在的 preset | 备注 |
| --- | --- | --- |
| 口型 | `aa` `ih` `ou` `ee` `oh` | 这是 VRM 1.0 **唯一**的 lip sync 机制（5 个日语元音 preset） |
| 眨眼 | `blink`（`blinkLeft` / `blinkRight` 可选） | 2D 视频里眨眼是烘好的，3D 必须显式驱动 |
| 情绪 | `happy` `angry` `sad` `surprised` `relaxed` | 对应产品的嘴甜 / 傲娇 / 喷水 / 打哈欠 / 干饭五档 |
| 兼容 | `neutral` | 规格注明「为向后兼容保留」 |

**重要事实（别按错规格做）**：VRM 1.0 **没有 viseme 概念**——`vrm-specification` 与 `three-vrm` 全仓 grep `viseme` 均 0 命中。任何 Oculus / Rhubarb 的 15 viseme 方案落到 VRM 上都只能映射到上面 5 个元音 preset，或者自建 custom expression。**不要为「viseme 通道」多做一个 blendshape 组，那是白做。**

每个 preset expression 还可以声明三个闸门：`overrideBlink` / `overrideLookAt` / `overrideMouth`（取值 `none` / `block` / `blend`）。建议：

- 口型 preset（`aa` 等）：`overrideMouth: none`，让程序每帧写权重
- 情绪 preset：`overrideBlink: blend`（说话带表情时不要完全压掉眨眼）
- 闭嘴类表情不要设 `overrideMouth: block`，否则口型会突然失效

### 2.5 `lookAt`（视线）

- `type`: `bone`（推荐，开销低）或 `expression`
- `offsetFromHeadBone`: 双眼参考位置，`[x, y, z]` 三元组
- 四个 `rangeMap`：`rangeMapHorizontalInner` / `rangeMapHorizontalOuter` / `rangeMapVerticalDown` / `rangeMapVerticalUp`，每个含 `inputMaxValue`（0–180 度）与 `outputScale`

桌宠需要「看镜头 / 看用户鼠标」的观感，`lookAt` 不配就只能靠转头，效果差一档。

### 2.6 `VRMC_springBone`（头发 / 裙摆物理）

- 扩展名大小写：**`VRMC_springBone`**（大写 B），写错就是不会被加载
- 必须挂：双马尾/长发（≥3 段 joint 每条）、裙摆（≥2 段 × 4 向）、围裙下摆（可选）
- `colliders` + `colliderGroups` 至少给头部与躯干各一组，否则头发会穿模到身体里
- joint 关键参数：`stiffness`（回正力）、`dragForce`（0–1 空气阻力）、`gravityPower` / `gravityDir`、`hitRadius`

### 2.7 材质

- 卡通着色走 **`VRMC_materials_mtoon`**，不是 `VRMC_vrm.materials`（后者不存在）
- 常用参数：`shadingShiftFactor` / `shadingToonyFactor`（阴影硬度）、`outlineWidthMode` + `outlineWidthFactor`（描边）、`matcapTexture`（高光贴图）
- 描边建议做，但**允许在性能不足时整体关闭**（见 §5 降级阶梯）

### 2.8 预计资源预算（目标，不是已达成）

| 项 | 预算 | 备注 |
| --- | --- | --- |
| 三角面 | **≤ 80,000** | 桌宠窗口小，8 万面已经足够细 |
| 材质数 | **≤ 8** | 每个材质 ≈ 一个 draw call 批次；超过就合并图集 |
| 贴图 | 单张 ≤ 2048×2048，总显存 ≤ 256 MB | MToon 通常只需 base / shade / matcap 三张 |
| 目标帧率 | 1080p60 | **未实测**：本机无合法 VRM 资产，此数为设计目标，实机必须复测（见 §6） |

---

## 3. 「设定保留、素材原创」的具体边界

可以做：

- 蓝鲸 + 女仆的**设定组合**：蓝白配色倾向、鲸鱼尾/鳍元素、女仆围裙、圆润体型、活泼又爱吃的性格
- 参考现有素材的**构图思路**做全新绘制（例如「围裙上有一枚鲸鱼刺绣」这个点子）

不可以做：

- 从现有 CC BY-NC-SA 素材里**描图、拓补、取色吸管、切图**，或把它的网格/贴图导入新模型
- 直接把现有动画（`.webm` / 动作曲线）重定向到新骨架
- 在新模型里保留任何可识别的原素材特征（同一枚刺绣图案的位图、同一条裙摆褶皱曲线）

判定口径：**把新旧两个模型并排放在一起，除了「都是蓝鲸女仆」这个设定层面的相似，不应出现像素级或网格级的同源痕迹。** 有疑问就以「重新画一遍」为准。

---

## 4. 动作与表情清单（首版最小集）

| 场景 | 需要的动作 | 需要的表情 / 口型 |
| --- | --- | --- |
| 待机 | 呼吸（程序化 spine/chest 微动，不需要 VRMA）、随机眨眼、视线跟随 | `blink`、`lookAt` |
| 说话 | 口型由程序每帧写 5 个元音 preset（不需要预烘） | `aa` `ih` `ou` `ee` `oh` |
| 嘴甜 | 轻微点头 / 歪头 | `happy` + 元音口型 |
| 傲娇 | 扭头、抱臂（可选） | `angry` 轻度 + `blink` |
| 喷水（生气） | 前倾 + 喷水特效挂点（见下） | `angry` 强 + `surprised` 收尾 |
| 干饭 | 捧碗 / 扒饭循环 | `happy` + 元音口型 |
| 困倦 | 打哈欠（张嘴 → 闭眼） | `relaxed` / `sad` 轻度 + `blink` 长闭 |
| 睡觉 | 闭眼 + 呼吸放慢 | `blink` = 1 常驻 |

**特效挂点**：喷水 / 汗滴 / 音符建议用独立 `Object3D` 空节点挂在 head / chest 下，命名前缀 `fx_`（如 `fx_mouth_spray`）。这样程序可以只驱动粒子，不用改模型。

---

## 5. 性能降级阶梯（渲染器侧，供验收时对齐）

按代价从低到高，超预算时按顺序执行，**不要一上来就砍模型**：

1. `pixelRatio` 限制到 1（桌宠窗口本来就小）
2. 关实时阴影，改用 blob shadow / AO 贴图
3. 关 MToon 描边（每材质少一路 pass）
4. MSAA 4× → 关
5. SpringBone 降到 30 Hz 更新（视觉几乎无感）
6. lookAt 降到 30 Hz
7. pixelRatio 0.75 + 后处理锐化

降级线（工程判断，需实测校准）：单帧 GPU 稳定 > 12 ms 或 CPU > 6 ms 时启动第 1–3 步；仍超再走 5–7。

---

## 6. 验收方式

### 6.1 可以自动化的部分

- 解析 `.vrm` 的 JSON chunk，断言：`extensions.VRMC_vrm.specVersion === "1.0"`；`meta` 七个许可字段取值符合 §2.2；`humanoid.humanBones` 覆盖 §2.3 清单；`expressions.preset` 覆盖 §2.4 清单；`extensions.VRMC_springBone` 存在且 `springs.length > 0`；每个材质带 `VRMC_materials_mtoon`
- 统计三角面数与材质数，对照 §2.8 预算
- 现有 `packages/shared-protocol/src/media.ts` 的 `inspectGlbOrVrm` 已能做二进制层质检，可在此基础上加「humanoid 槽位命中率 / blendshape 覆盖率」门禁

### 6.2 必须人类真机验收的部分（不许写成已通过）

- 1080p60 实际帧率（本机当前无合法资产，**未实测**）
- 透明窗口叠加下的边缘观感（发灰 / 白边 / 残影）
- 头发裙摆物理是否自然、是否穿模
- 描边粗细在 1080p 与高 DPI 屏上的观感
- **法务确认**：`commercialUsage` 取值是否与实际经营主体一致

### 6.3 证据等级

本文件是**需求规格**，不含任何实测结论。任何「已达标」的说法都必须附带真机截图 / 帧率采样 / 校验脚本输出，否则一律记 `IMPLEMENTED_UNVERIFIED`。

---

## 7. 制作路线（现实约束，别被工具宣传骗）

**2026-11 的事实：生成式 3D 不能直接产出可用 VRM 1.0。** 网格 + 贴图已经成熟；骨架要另一类模型；**表情 blendshape 与 SpringBone 没有通用自动化方案**。Meshy 官方 FAQ 直接写面部绑定「Not in Meshy」；Tripo 的 `spec: "vrm"` 只是「按 VRM 1.0 humanoid 命名骨骼」，输出仍是 GLB。

因此路线只能是：

1. **VRoid Studio 手工捏人 → 导出 VRM 1.0**（最快出货，产出归我们所有，可商用可设许可）
2. 或 **生成式 3D 出网格 + 骨架 → Blender 补表情 / springBone / MToon / meta → 导出 VRM 1.0**
   - Blender 插件用 `saturday06/VRM-Addon-for-Blender`，许可为 **`MIT OR GPL-3.0-or-later` 双许可**
   - **本项目必须走 MIT 那一支**（AGENTS.md 的 GPL 红线）；不得选 GPL-3.0-or-later 分支
   - 插件能自动做的只有「已有骨架 → humanoid 槽位映射」「已有 shape key → expression 预设映射」，**不会凭空生成 blendshape，也不会生成 springBone**
3. 无论哪条路，§2.2 的 `meta` 许可字段都必须手工填对

---

## 8. 待 owner 确认（不阻塞制作，但影响验收）

| 事项 | 现状 | 影响 |
| --- | --- | --- |
| 经营主体 | 未定 | 决定 `commercialUsage` 填 `corporation` 还是 `personalProfit`，填错等于授权不足 |
| 署名方式 | 未定 | `creditNotation` 与 `authors` 的呈现位置（关于页 / 直播简介） |
| 是否接受 AI 生成网格 + 人工补表情 | 未定 | 影响工期与成本；纯手工建模质量更可控 |
| 美术资源来源 | 未定 | 自建 / 外包 / VRoid 基础模型改造，三者许可路径不同 |

---

## 9. 声音素材（另见唱歌链路选型结论）

VRM 之外，唱歌/说话链路还需要 owner 提供**授权声源素材**；型号、句数、采样率、录制环境与授权声明模板已写死在 [evidence/V2-P3-07-svc-svs-selection.md](./evidence/V2-P3-07-svc-svs-selection.md) 第 2 节：

- 六组情绪参考音（owner 2026-11-27 拍板六组验收）：`sweet_normal` 需重录，`tsundere_refuse` / `rage_spray` / `lazy_yawn` / `clumsy_panic` / `happy_rice` 五组全缺（每条 5.0 s ± 0.3 s / 24 kHz mono 16-bit / −3 dBFS）。逐句台词与录制步骤见 [SINGING-RECORDING-CHECKLIST.md](./SINGING-RECORDING-CHECKLIST.md)。
- SVC（RVC）训练干声：≥10 分钟可试、30 分钟以上更稳，纯人声无伴奏，逐文件授权留档。
- 儿童声线必须附监护人授权；没有授权就只能走「成年授权声源 + 儿童化处理」并如实标注，不得宣称是真实儿童音色。
