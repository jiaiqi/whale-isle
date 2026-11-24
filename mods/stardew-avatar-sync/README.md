# Whale Isle Avatar Sync（T-M6-62）

SMAPI 4.x / Stardew 1.6 外观同步 Mod：读取 `Mods/WhaleIsleAvatar/active-avatar.json`
（鲸屿主进程原子写入），把当前桌宠形象同步成玩家像素外观。

- 原版兜底：`preset` 发色/发型/衣裤/肤色/帽子 + 角色名（非破坏性外观字段）；
- 像素表覆盖：同目录 96×128 PNG（4 行×6 列，每帧 16×32，行序 下/右/上/左，
  列序 待机/左脚/右脚/过渡/动作/表情）按 `Farmer.FacingDirection` 与行走帧覆盖绘制；坏图自动回落预设；
  工具/鱼竿/手持物/表情仍由游戏引擎绘制，像素表动作帧必须是空手；
- 联机：只替换**本端玩家**。多开/联机时每个游戏实例各自安装 Mod、各自读取自己的
  `active-avatar.json`（主进程为每个隔离 profile 写一份）；远端队友在别人画面里仍是原版外观；
- 线程安全：FileSystemWatcher 只置 dirty 标记，UpdateTicked 主线程 200ms 去抖后重载贴图。

构建：`dotnet build -c Release`（需要能访问 NuGet 拉取 Pathoschild.Stardew.ModBuildConfig）。
