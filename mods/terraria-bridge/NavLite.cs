/**
 * 轻量滚动视野寻路（M7 / T-M7-T2）。
 * 思想参考 Reisenbug/TerraBlind (MIT) 的 receding-horizon + 物理预测寻路，
 * 以及其 CAPABILITIES.md 两条踩坑：
 *   ① IsPassable ≠ Vacant（平台可通过但不是空位，不能直接放置/落脚判定）；
 *   ② StepCost = int.MaxValue 参与加法会溢出为负数 → 用 MAX/4 封顶并显式检查。
 * 未复制任何源码。
 */
using System;
using Terraria;
using Terraria.ID;

namespace TerrariaBridge
{
    internal struct Step
    {
        public bool Left, Right, Up, Jump, UseItem;
        public string Primitive;
    }

    internal static class NavLite
    {
        private const int MaxCost = int.MaxValue / 4; // 防加法溢出（TerraBlind CAPABILITIES.md 踩坑）

        internal static Step NextStep(BridgeAction action, int px, int py)
        {
            Step step = new Step { Primitive = "idle" };
            try
            {
                string tool = action.Tool;
                if (tool == "flee" && (action.TargetX == int.MinValue || action.TargetY == int.MinValue))
                {
                    // 远离最近威胁：物理预测——优先往开阔方向走
                    int nearestX = NearestThreatX(px, py);
                    int away = nearestX >= px ? -1 : 1;
                    step.Right = away > 0;
                    step.Left = away < 0;
                    step.Jump = !IsPassable(px + away, py) || NeedsJump(px, py, away);
                    step.Primitive = "flee";
                    return step;
                }

                if ((tool == "mine" || tool == "dig_tunnel") && action.TargetX != int.MinValue)
                {
                    int dx = action.TargetX - px;
                    int dy = action.TargetY - py;
                    if (Math.Abs(dx) <= 1 && Math.Abs(dy) <= 1)
                    {
                        step.UseItem = true; // 贴着目标方块挥镐
                        step.Primitive = "mine";
                        return step;
                    }
                    return Approach(px, py, action.TargetX, action.TargetY, "mine");
                }

                if (tool == "build_shelter" || tool == "torch" || tool == "light_torch")
                {
                    // 在玩家周围找一个可放置的空位（IsVacant 而非仅 IsPassable）
                    for (int radius = 1; radius <= 4; radius++)
                    {
                        for (int dy = -radius; dy <= radius; dy++)
                        {
                            for (int dx = -radius; dx <= radius; dx++)
                            {
                                int x = px + dx, y = py + dy;
                                if (!IsVacant(x, y)) continue;
                                if (!IsSolid(x, y + 1)) continue; // 需要下方有支撑，避免悬空放置
                                step.UseItem = true;
                                step.Right = dx > 1;
                                step.Left = dx < -1;
                                step.Jump = dy < 0;
                                step.Primitive = tool;
                                return step;
                            }
                        }
                    }
                    return step;
                }

                if ((tool == "attack" || tool == "aim") && NearestThreatX(px, py) != int.MinValue)
                {
                    int threatX = NearestThreatX(px, py);
                    step.Right = threatX > px;
                    step.Left = threatX < px;
                    step.UseItem = tool == "attack";
                    step.Primitive = "attack";
                    return step;
                }

                if (action.TargetX != int.MinValue && action.TargetY != int.MinValue)
                {
                    return Approach(px, py, action.TargetX, action.TargetY, "move_to");
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("NavLite.NextStep 异常：" + e.Message);
            }
            return step;
        }

        /// <summary>滚动视野下一步：只规划当前可见窗口，带重力/跳跃落点预测。</summary>
        private static Step Approach(int px, int py, int tx, int ty, string primitive)
        {
            Step step = new Step { Primitive = primitive };
            int dx = Math.Sign(tx - px);
            int dy = Math.Sign(ty - py);
            step.Right = dx > 0;
            step.Left = dx < 0;
            step.Up = dy < 0 && IsPassable(px, py - 1);
            step.Jump = NeedsJump(px, py, dx) || (dy < 0 && !IsPassable(px, py - 1));
            return step;
        }

        /// <summary>物理预测：前方一格不可通过，或前方是坑（下方两格都空）→ 跳。</summary>
        private static bool NeedsJump(int px, int py, int direction)
        {
            if (direction == 0) return false;
            int ahead = px + direction;
            if (!InBounds(ahead, py)) return false;
            if (IsSolid(ahead, py)) return true;
            bool gapNear = !IsSolid(ahead, py + 1);
            bool gapFar = !IsSolid(ahead, py + 2);
            return gapNear && gapFar;
        }

        internal static void PickMineTarget(BridgeAction action, int px, int py)
        {
            try
            {
                int bestScore = int.MaxValue;
                for (int radius = 1; radius <= 12; radius++)
                {
                    for (int dy = -radius; dy <= radius; dy++)
                    {
                        for (int dx = -radius; dx <= radius; dx++)
                        {
                            int x = px + dx, y = py + dy;
                            if (!InBounds(x, y)) continue;
                            Tile t = Main.tile[x, y];
                            if (t == null || !t.HasTile) continue;
                            bool interesting = t.TileType == TileID.Trees || IsOre(t.TileType) || t.TileType == TileID.Stone;
                            if (!interesting) continue;
                            int score = StepCost(x, y) + Math.Abs(dx) + Math.Abs(dy);
                            if (score >= bestScore) continue;
                            bestScore = score;
                            action.TargetX = x;
                            action.TargetY = y;
                        }
                    }
                    if (bestScore != int.MaxValue) return;
                }
            }
            catch (Exception e) { BridgeLog.Error("PickMineTarget 异常：" + e.Message); }
        }

        internal static bool IsSolid(int x, int y)
        {
            if (!InBounds(x, y)) return true;
            try
            {
                Tile t = Main.tile[x, y];
                if (t == null) return true;
                if (!t.HasTile) return false;
                return t.TileType != TileID.Platforms; // 平台：可通过（IsPassable）但不是实心障碍
            }
            catch { return true; }
        }

        /// <summary>可通过：空气或平台。注意与 IsVacant 的区别（TerraBlind 踩坑①）。</summary>
        internal static bool IsLava(int x, int y)
        {
            if (!InBounds(x, y)) return false;
            try
            {
                Tile t = Main.tile[x, y];
                return t != null && t.LiquidAmount > 0 && t.LiquidType == LiquidID.Lava;
            }
            catch { return false; }
        }

        internal static bool IsPassable(int x, int y)
        {
            if (!InBounds(x, y)) return false;
            try
            {
                Tile t = Main.tile[x, y];
                if (t == null) return false;
                if (t.LiquidAmount > 0 && t.LiquidType == LiquidID.Lava) return false; // 岩浆不可通过
                return !t.HasTile || t.TileType == TileID.Platforms;
            }
            catch { return false; }
        }

        /// <summary>真正空位：无方块、无液体（IsPassable 为真时仍可能为假——平台）。</summary>
        internal static bool IsVacant(int x, int y)
        {
            if (!InBounds(x, y)) return false;
            try
            {
                Tile t = Main.tile[x, y];
                return t != null && !t.HasTile && t.LiquidAmount == 0;
            }
            catch { return false; }
        }

        /// <summary>带封顶的代价函数（TerraBlind 踩坑②：int.MaxValue 加法溢出）。</summary>
        internal static int StepCost(int x, int y)
        {
            if (!InBounds(x, y)) return MaxCost;
            try
            {
                Tile t = Main.tile[x, y];
                if (t == null) return MaxCost;
                if (t.LiquidAmount > 0 && t.LiquidType == LiquidID.Lava) return MaxCost;
                if (t.HasTile && t.TileType != TileID.Platforms) return MaxCost;
                int baseCost = 1 + (t.HasTile ? 1 : 0);
                return AddCost(baseCost, t.LiquidAmount > 0 ? 5 : 0);
            }
            catch { return MaxCost; }
        }

        private static int AddCost(int a, int b)
        {
            if (a > MaxCost - b) return MaxCost;
            return a + b;
        }

        internal static int SolidCount(int px, int py, int radius)
        {
            int count = 0;
            for (int dy = -radius; dy <= radius; dy++)
            {
                for (int dx = -radius; dx <= radius; dx++)
                {
                    if (IsSolid(px + dx, py + dy)) count++;
                }
            }
            return count;
        }

        internal static bool HasTorchNearby(int px, int py, int radius)
        {
            for (int dy = -radius; dy <= radius; dy++)
            {
                for (int dx = -radius; dx <= radius; dx++)
                {
                    int x = px + dx, y = py + dy;
                    if (!InBounds(x, y)) continue;
                    try
                    {
                        Tile t = Main.tile[x, y];
                        if (t != null && t.HasTile && t.TileType == TileID.Torches) return true;
                    }
                    catch { /* 跳过坏瓦片 */ }
                }
            }
            return false;
        }

        internal static int NearestHostileHp(int px, int py)
        {
            int best = int.MaxValue;
            for (int i = 0; i < Main.npc.Length; i++)
            {
                NPC n = Main.npc[i];
                if (n == null || !n.active || n.friendly || n.townNPC) continue;
                if (Math.Abs(n.position.X / 16f - px) + Math.Abs(n.position.Y / 16f - py) > 25f) continue;
                if (n.life < best) best = n.life;
            }
            return best;
        }

        internal static int DistanceToNearestThreat(int px, int py)
        {
            int best = 999;
            for (int i = 0; i < Main.npc.Length; i++)
            {
                NPC n = Main.npc[i];
                if (n == null || !n.active || n.friendly || n.townNPC) continue;
                int dist = (int)(Math.Abs(n.position.X / 16f - px) + Math.Abs(n.position.Y / 16f - py));
                if (dist < best) best = dist;
            }
            return best;
        }

        private static int NearestThreatX(int px, int py)
        {
            int best = int.MinValue, bestDist = 999;
            for (int i = 0; i < Main.npc.Length; i++)
            {
                NPC n = Main.npc[i];
                if (n == null || !n.active || n.friendly || n.townNPC) continue;
                int dist = (int)(Math.Abs(n.position.X / 16f - px) + Math.Abs(n.position.Y / 16f - py));
                if (dist >= bestDist) continue;
                bestDist = dist;
                best = (int)Math.Floor(n.position.X / 16f);
            }
            return best;
        }

        private static bool IsOre(int type)
        {
            return type == TileID.Copper || type == TileID.Iron || type == TileID.Silver || type == TileID.Gold
                || type == TileID.Lead || type == TileID.Tin || type == TileID.Mythril || type == TileID.Adamantite
                || type == TileID.Orichalcum || type == TileID.Palladium || type == TileID.Titanium || type == TileID.Chlorophyte;
        }

        private static bool InBounds(int x, int y)
        {
            try
            {
                return x >= 0 && y >= 0 && x < Main.tile.Width && y < Main.tile.Height;
            }
            catch { return false; }
        }
    }
}
