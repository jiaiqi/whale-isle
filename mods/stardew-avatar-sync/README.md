# Whale Isle Avatar Sync（T-M6-62）

SMAPI 4.x / Stardew 1.6 外观同步 Mod：读取 `Mods/WhaleIsleAvatar/active-avatar.json`
（鲸屿主进程原子写入），把当前桌宠形象同步成玩家像素外观。

- 原版兜底：`preset` 发色/发型/衣裤/肤色/帽子 + 角色名（非破坏性外观字段）；
- 像素表覆盖：同目录 64×128 PNG（4 行×4 列，每帧 16×32，行序 下/右/上/左，
  列序 待机+3 行走帧）按 `Farmer.FacingDirection` 与行走帧覆盖绘制；坏图自动回落预设；
- 联机：SaveLoaded / 热切换时 `Multiplayer.SendMessage` 广播本端 characterId，
  同局玩家画面里每个 AI 队友显示各自桌宠形象；
- 线程安全：FileSystemWatcher 只置 dirty 标记，UpdateTicked 主线程 200ms 去抖后重载贴图。

构建：`dotnet build -c Release`（需要能访问 NuGet 拉取 Pathoschild.Stardew.ModBuildConfig）。
