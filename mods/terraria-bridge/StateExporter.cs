/**
 * 世界事实导出器（M7 / T-M7-T2）：读 Player.statLife/statMana/inventory/position、
 * Main.tile、Main.npc 与进度旗标，产出与 shared-protocol TerrariaStateSnapshotSchema
 * 逐字段对应的 JSON（出站镜像 POCO，无视觉模型）。
 *
 * 思想参考 Reisenbug/TerraBlind (MIT) 的 /state + /terrain ASCII 网格；
 * 未复制源码。任何游戏 API 读取异常均捕获写日志，绝不崩游戏。
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Terraria;
using Terraria.ID;

namespace TerrariaBridge
{
    internal sealed class PositionDto { public double X { get; set; } public double Y { get; set; } }
    internal sealed class BuffDto { public string Name { get; set; } public int TimeSeconds { get; set; } }
    internal sealed class InventoryDto { public int Slot { get; set; } public string ItemName { get; set; } public int Stack { get; set; } }
    internal sealed class ClockDto
    {
        public int DayCount { get; set; }
        public bool IsDay { get; set; }
        public string DayPhase { get; set; }
        public string TimeText { get; set; }
        public bool HardMode { get; set; }
    }
    internal sealed class PlayerDto
    {
        public int Hp { get; set; }
        public int HpMax { get; set; }
        public int Mana { get; set; }
        public int ManaMax { get; set; }
        public PositionDto Position { get; set; }
        public string Facing { get; set; }
        public List<BuffDto> Buffs { get; set; } = new List<BuffDto>();
        public List<InventoryDto> Inventory { get; set; } = new List<InventoryDto>();
        public int SelectedSlot { get; set; }
    }
    internal sealed class WorldDto
    {
        public string Biome { get; set; }
        public List<string> Events { get; set; } = new List<string>();
        public List<string> DownedBosses { get; set; } = new List<string>();
    }
    internal sealed class TilesDto
    {
        public int OriginX { get; set; }
        public int OriginY { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public Dictionary<string, string> Legend { get; set; } = new Dictionary<string, string>();
        public List<string> Rows { get; set; } = new List<string>();
    }
    internal sealed class NpcDto
    {
        public string Name { get; set; }
        public double Hp { get; set; }
        public double HpMax { get; set; }
        public PositionDto Position { get; set; }
        public bool IsHostile { get; set; }
        public bool IsBoss { get; set; }
    }
    internal sealed class ItemDto { public string Name { get; set; } public int Stack { get; set; } public PositionDto Position { get; set; } }
    internal sealed class NearbyDto
    {
        public TilesDto Tiles { get; set; }
        public List<NpcDto> Npcs { get; set; } = new List<NpcDto>();
        public List<ItemDto> Items { get; set; } = new List<ItemDto>();
    }
    internal sealed class DangerDto
    {
        public bool LavaNearby { get; set; }
        public bool FallingDanger { get; set; }
        public string ThreatLevel { get; set; }
    }
    internal sealed class ControlDto { public string Authority { get; set; } public bool IsPlayerMovingPhysically { get; set; } }
    internal sealed class SnapshotDto
    {
        public int SchemaVersion { get; set; } = 1;
        public long CapturedAt { get; set; }
        public ClockDto Clock { get; set; }
        public PlayerDto Player { get; set; }
        public WorldDto World { get; set; }
        public NearbyDto Nearby { get; set; }
        public DangerDto Danger { get; set; }
        public ControlDto Control { get; set; }
    }

    internal static class StateExporter
    {
        private static int dayCount = 1;
        private static bool lastDayTime = true;

        internal static void ResetClock()
        {
            dayCount = 1;
            lastDayTime = Main.dayTime;
        }

        internal static void TickClock()
        {
            try
            {
                if (!lastDayTime && Main.dayTime) dayCount++; // 夜→昼为一个新游戏日
                lastDayTime = Main.dayTime;
            }
            catch (Exception e)
            {
                BridgeLog.Error("TickClock 异常：" + e.Message);
            }
        }

        internal static string ExportJson()
        {
            try
            {
                return JsonSerializer.Serialize(Build(), BridgeJson.Options);
            }
            catch (Exception e)
            {
                BridgeLog.Error("StateExporter 异常：" + e.Message);
                // 坏状态绝不让 HTTP 线程崩：回一个最小合法快照（schemaVersion=1）
                return JsonSerializer.Serialize(new SnapshotDto
                {
                    CapturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    Clock = new ClockDto { DayCount = dayCount, IsDay = true, DayPhase = "day", TimeText = "07:30 AM", HardMode = false },
                    Player = new PlayerDto { Hp = 100, HpMax = 100, Mana = 20, ManaMax = 20, Position = new PositionDto { X = 0, Y = 0 }, Facing = "right" },
                    World = new WorldDto { Biome = "Forest" },
                    Nearby = new NearbyDto { Tiles = EmptyTiles() },
                    Danger = new DangerDto { ThreatLevel = "safe" },
                    Control = new ControlDto { Authority = "AI_AUTOPILOT", IsPlayerMovingPhysically = false },
                }, BridgeJson.Options);
            }
        }

        private static SnapshotDto Build()
        {
            Player p = Main.player[Main.myPlayer];
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            double tickSpan = Main.dayTime ? 54000.0 : 16200.0;
            double progress = tickSpan <= 0 ? 0 : Math.Max(0, Math.Min(1, Main.time / tickSpan));
            int minuteOfDay = Main.dayTime
                ? (int)(4 * 60 + 30 + progress * 870)      // 04:30 → 19:00
                : (int)(19 * 60 + progress * 570);          // 19:00 → 次日 04:30
            minuteOfDay = ((minuteOfDay % 1440) + 1440) % 1440;
            int hour = minuteOfDay / 60;
            string timeText = string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00} {2}",
                hour % 12 == 0 ? 12 : hour % 12, minuteOfDay % 60, hour < 12 ? "AM" : "PM");
            string phase = Main.dayTime
                ? (progress < 0.08 ? "dawn" : progress > 0.92 ? "dusk" : "day")
                : "night";

            int px = (int)Math.Floor(p.position.X / 16f);
            int py = (int)Math.Floor(p.position.Y / 16f);

            var snapshot = new SnapshotDto
            {
                CapturedAt = now,
                Clock = new ClockDto
                {
                    DayCount = dayCount,
                    IsDay = Main.dayTime,
                    DayPhase = phase,
                    TimeText = timeText,
                    HardMode = Main.hardMode,
                },
                Player = new PlayerDto
                {
                    Hp = p.statLife,
                    HpMax = p.statLifeMax,
                    Mana = p.statMana,
                    ManaMax = p.statManaMax,
                    Position = new PositionDto { X = p.position.X / 16f, Y = p.position.Y / 16f },
                    Facing = p.direction < 0 ? "left" : "right",
                    SelectedSlot = p.selectedItem,
                },
                World = BuildWorld(),
                Nearby = BuildNearby(px, py),
                Danger = BuildDanger(px, py, p),
                Control = new ControlDto
                {
                    Authority = TakeoverWatch.CurrentAuthority,
                    IsPlayerMovingPhysically = TakeoverWatch.IsPlayerMovingPhysically,
                },
            };

            // buff 表（镜像 Player.buffType / buffTime）
            try
            {
                for (int i = 0; i < p.buffType.Length; i++)
                {
                    int type = p.buffType[i];
                    if (type <= 0) continue;
                    snapshot.Player.Buffs.Add(new BuffDto
                    {
                        Name = Lang.GetBuffName(type),
                        TimeSeconds = p.buffTime[i] / 60,
                    });
                }
            }
            catch (Exception e) { BridgeLog.Error("buff 导出异常：" + e.Message); }

            // 背包（仅非空槽位；itemName + stack）
            try
            {
                for (int i = 0; i < p.inventory.Length; i++)
                {
                    Item item = p.inventory[i];
                    if (item == null || item.IsAir) continue;
                    snapshot.Player.Inventory.Add(new InventoryDto { Slot = i, ItemName = item.Name, Stack = item.stack });
                }
            }
            catch (Exception e) { BridgeLog.Error("背包导出异常：" + e.Message); }

            return snapshot;
        }

        private static WorldDto BuildWorld()
        {
            var world = new WorldDto { Biome = "Forest" };
            try
            {
                Player p = Main.player[Main.myPlayer];
                if (p.ZoneDungeon) world.Biome = "Dungeon";
                else if (p.ZoneCorrupt) world.Biome = "Corruption";
                else if (p.ZoneCrimson) world.Biome = "Crimson";
                else if (p.ZoneHallow) world.Biome = "Hallow";
                else if (p.ZoneJungle) world.Biome = "Jungle";
                else if (p.ZoneSnow) world.Biome = "Snow";
                else if (p.ZoneDesert) world.Biome = "Desert";
                else if (p.position.Y / 16f > 80) world.Biome = "Underground";

                if (Main.bloodMoon) world.Events.Add("BloodMoon");
                if (Main.raining) world.Events.Add("Rain");
                if (Main.eclipse) world.Events.Add("Eclipse");
                if (Main.snowMoon) world.Events.Add("SnowMoon");
                if (Main.pumpkinMoon) world.Events.Add("PumpkinMoon");

                if (NPC.downedBoss1) world.DownedBosses.Add("EyeOfCthulhu");
                if (NPC.downedBoss2) world.DownedBosses.Add("BrainOrWorm");
                if (NPC.downedBoss3) world.DownedBosses.Add("Skeletron");
                if (NPC.downedQueenBee) world.DownedBosses.Add("QueenBee");
                if (NPC.downedMechBossAny) world.DownedBosses.Add("Mechanical");
                if (NPC.downedPlantBoss) world.DownedBosses.Add("Plantera");
                if (NPC.downedMoonlord) world.DownedBosses.Add("MoonLord");
            }
            catch (Exception e) { BridgeLog.Error("世界旗标导出异常：" + e.Message); }
            return world;
        }

        private static NearbyDto BuildNearby(int px, int py)
        {
            var nearby = new NearbyDto { Tiles = new TilesDto() };
            try
            {
                const int width = 11;
                const int height = 5;
                TilesDto tiles = nearby.Tiles;
                tiles.OriginX = px - width / 2;
                tiles.OriginY = py - height / 2;
                tiles.Width = width;
                tiles.Height = height;
                tiles.Legend["#"] = "solid";
                tiles.Legend["."] = "air";
                tiles.Legend["~"] = "lava";
                tiles.Legend["T"] = "tree";
                tiles.Legend["O"] = "ore";

                for (int dy = 0; dy < height; dy++)
                {
                    var row = new StringBuilder(width);
                    for (int dx = 0; dx < width; dx++)
                    {
                        int x = tiles.OriginX + dx;
                        int y = tiles.OriginY + dy;
                        row.Append(TileChar(x, y));
                    }
                    tiles.Rows.Add(row.ToString());
                }

                for (int i = 0; i < Main.npc.Length; i++)
                {
                    NPC n = Main.npc[i];
                    if (n == null || !n.active) continue;
                    float dist = Math.Abs(n.position.X / 16f - px) + Math.Abs(n.position.Y / 16f - py);
                    if (dist > 20f) continue;
                    nearby.Npcs.Add(new NpcDto
                    {
                        Name = NpcName(n),
                        Hp = n.life,
                        HpMax = n.lifeMax,
                        Position = new PositionDto { X = n.position.X / 16f, Y = n.position.Y / 16f },
                        IsHostile = !n.friendly && !n.townNPC,
                        IsBoss = n.boss,
                    });
                }

                for (int i = 0; i < Main.item.Length; i++)
                {
                    Item item = Main.item[i];
                    if (item == null || !item.active) continue;
                    float dist = Math.Abs(item.position.X / 16f - px) + Math.Abs(item.position.Y / 16f - py);
                    if (dist > 15f) continue;
                    nearby.Items.Add(new ItemDto
                    {
                        Name = item.Name,
                        Stack = item.stack,
                        Position = new PositionDto { X = item.position.X / 16f, Y = item.position.Y / 16f },
                    });
                }
            }
            catch (Exception e) { BridgeLog.Error("邻域导出异常：" + e.Message); }
            return nearby;
        }

        private static string NpcName(NPC n)
        {
            try { return Lang.GetNPCNameValue(n.type); }
            catch { return "npc-" + n.type; }
        }

        private static char TileChar(int x, int y)
        {
            try
            {
                if (x < 0 || y < 0 || x >= Main.tile.Width || y >= Main.tile.Height) return '#';
                Tile tile = Main.tile[x, y];
                if (tile == null) return '#';
                if (!tile.HasTile)
                {
                    return tile.LiquidAmount > 0 && tile.LiquidType == LiquidID.Lava ? '~' : '.';
                }
                if (tile.TileType == TileID.Trees || tile.TileType == TileID.PalmTree) return 'T';
                if (IsOre(tile.TileType)) return 'O';
                return '#';
            }
            catch (Exception e)
            {
                BridgeLog.Error("瓦片读取异常：" + e.Message);
                return '#';
            }
        }

        private static bool IsOre(int type)
        {
            return type == TileID.Copper || type == TileID.Iron || type == TileID.Silver || type == TileID.Gold
                || type == TileID.Lead || type == TileID.Tin || type == TileID.Mythril || type == TileID.Adamantite
                || type == TileID.Orichalcum || type == TileID.Palladium || type == TileID.Titanium || type == TileID.Chlorophyte;
        }

        private static DangerDto BuildDanger(int px, int py, Player p)
        {
            var danger = new DangerDto { ThreatLevel = "safe" };
            try
            {
                bool lava = false;
                for (int y = py - 3; y <= py + 3 && !lava; y++)
                {
                    for (int x = px - 3; x <= px + 3; x++)
                    {
                        if (TileChar(x, y) == '~') { lava = true; break; }
                    }
                }
                danger.LavaNearby = lava;
                // tML 1.4.4 无 onGround；velocity.Y == 0 即着地，非 0 即离地/下坠
                danger.FallingDanger = p.velocity.Y != 0f && p.velocity.Y > 3f;

                bool boss = false, hostile = false;
                for (int i = 0; i < Main.npc.Length; i++)
                {
                    NPC n = Main.npc[i];
                    if (n == null || !n.active || n.friendly || n.townNPC) continue;
                    if (Math.Abs(n.position.X / 16f - px) > 25f) continue;
                    hostile = true;
                    if (n.boss) { boss = true; break; }
                }
                danger.ThreatLevel = boss || lava || p.statLife * 100 / Math.Max(1, p.statLifeMax) < 30
                    ? "critical" : hostile ? "caution" : "safe";
            }
            catch (Exception e) { BridgeLog.Error("危险度导出异常：" + e.Message); }
            return danger;
        }

        private static TilesDto EmptyTiles()
        {
            return new TilesDto
            {
                OriginX = 0, OriginY = 0, Width = 1, Height = 1,
                Legend = new Dictionary<string, string> { ["#"] = "solid", ["."] = "air", ["~"] = "lava" },
                Rows = new List<string> { "." },
            };
        }
    }
}
