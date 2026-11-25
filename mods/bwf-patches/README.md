# BWF 本地补丁（Blind Whale Farmer, MIT, © Darianliu23）

对上游 `Darianliu23/dsh-stardew-blind-whale-farmer`（1.1.27）做的本地增强补丁。上游升级版本后需检查补丁是否已被上游实现，未实现则在克隆上重放本目录的 `.patch` 再构建。

## 补丁清单

| 文件 | 日期 | 内容 |
| --- | --- | --- |
| `2026-11-22-showhud-settings.patch` | 2026-11-22 | `showHud` 进 `/settings` 远程设置：`ModEntry.ApplyRemoteSettings` 支持远程改 `Config.ShowHud`（`DrawHud` 每帧读取 → 运行时即时生效，且 `Helper.WriteConfig` 自动落盘持久）；`McpServer.SettingsSnapshot` 上报 `showHud` 供回读验证。鲸屿中控台「游戏内提示」开关（T-M6-16）依赖此补丁；**未打补丁的旧 DLL 会静默忽略该键**，宿主端按「需重启游戏换新 DLL」如实提示。 |
| `2026-11-25-player-in-control-settings.patch` | 2026-11-25 | `playerInControl` 进 `/settings`：`ApplyRemoteSettings` 收到该键时切主线程调上游已有的 `SetPlayerInControl(bool)`（该方法本就实现了「取消在跑动作 + 停下内置 AI + 解冻时间 + 恢复玩家移动 + HUD 提示」，原先只由 F7 触发）；`SettingsSnapshot` 上报 `playerInControl` 供宿主回读。鲸屿「我来操作 / 交还给 AI」开关（T-M6-73）依赖此补丁；**未打补丁时宿主开关仍会停掉自己的 runner，但游戏内角色可能继续行动**，宿主如实提示按 F7。顺序要求：先打 `2026-11-22-showhud-settings.patch`，本补丁基于其后的文件状态。 |

## 构建与安装（本机实测流程）

```bash
cd ~/Documents/vibe/reference-clones/dsh-stardew-blind-whale-farmer   # MIT 克隆（保留版权头）
git apply <repo>/mods/bwf-patches/<patch>.patch                        # 或已应用
dotnet build BlindWhaleFarmer/BlindWhaleFarmer.csproj -c Release      # macOS Steam 路径开箱支持
MODS="$HOME/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS/Mods/BlindWhaleFarmer"
cp "$MODS/BlindWhaleFarmer.dll" "$MODS/BlindWhaleFarmer.dll.bak-<版本>"   # 先备份原版
cp BlindWhaleFarmer/bin/Release/net6.0/BlindWhaleFarmer.dll "$MODS/"
# 游戏重启后生效（运行中换文件安全，内存里仍是旧版）
```

验证：`GET http://127.0.0.1:18080/settings` 快照含 `showHud` 键即补丁版在线；`POST {"revision":"x","settings":{"showHud":false}}` 回读 `showHud=false` + SMAPI 日志「已应用 DSH 设置」+ `config.json` 的 `ShowHud` 落盘为 false。
