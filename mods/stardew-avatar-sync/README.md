# Whale Isle Avatar Sync（T-M6-62）

SMAPI 4.x / Stardew 1.6 外观同步 Mod：读取 `Mods/WhaleIsleAvatar/active-avatar.json`
（鲸屿主进程原子写入），把当前桌宠形象同步成玩家外观。

- 原版兜底：`preset` 发色/发型/衣裤/肤色/帽子 + 角色名（非破坏性外观字段）；
- 多分辨率精灵表自适应：同目录 4 行 × 6 列（兼容旧版 4 列）PNG，行序 下/右/上/左，
  列序 待机/左脚/右脚/过渡/动作/表情。自动识别：
  - `1x` 原版像素：`96×128`（每帧 `16×32`，兼容 `64×128`）
  - `2x` 精致像素：`192×256`（每帧 `32×64`，推荐默认）
  - `4x` 高清 Q 版：`384×512`（每帧 `64×128`）
  坏图自动回落预设；工具/鱼竿/手持物/表情仍由游戏引擎绘制，动作帧必须空手；
- 程序化灵动动画（`liveliness`，默认开启）：统一脚底中心锚点 + 地面柔和投影 + 待机微呼吸 + 行走轻弹跳与微倾 + 动作弹性脉冲；
- 联机：只替换**本端玩家**。多开/联机时每个游戏实例各自安装 Mod、各自读取自己的
  `active-avatar.json`（主进程为每个隔离 profile 写一份）；远端队友在别人画面里仍是原版外观；
- 线程安全：FileSystemWatcher 只置 dirty 标记，UpdateTicked 主线程 200ms 去抖后重载贴图。

构建：`dotnet build -c Release` 并复制 `bin/Release/net6.0/WhaleIsleAvatar.dll`、`manifest.json` 到 `publish/`。
