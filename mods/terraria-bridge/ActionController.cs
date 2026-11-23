/**
 * 动作执行器（M7 / T-M7-T2）：单飞互斥 + 帧级控制写入 + 组合动作世界事实终止判据 + 四态回执。
 *
 * 铁律（AGENTS.md §2.2）：严禁把"发了指令"当"完成"；每一步都重新读 Main.tile / Player /
 * NPC 的真实状态决定是否继续或终止。回执四态与 shared-protocol GameBridgeReceiptStatus 一致：
 * COMPLETED / FAILED / UNCERTAIN / ABORTED_BY_HUMAN_TAKEOVER。
 * 思想参考 Reisenbug/TerraBlind (MIT) 的「三段式回执 + 世界事实终止判据」与
 * MutantPilot (MIT) 的 16ms 帧级控制；未复制源码。
 */
using System;
using System.Collections.Generic;
using Terraria;
using Terraria.ModLoader;

namespace TerrariaBridge
{
    /// <summary>一帧的 AI 控制意图；由 ModPlayer.SetControls 写入真实 Player.control* 字段。</summary>
    internal sealed class ControlFrame
    {
        public bool Left, Right, Up, Jump, UseItem;
        internal static ControlFrame Copy(ControlFrame source)
        {
            return source == null ? null : new ControlFrame
            {
                Left = source.Left, Right = source.Right, Up = source.Up, Jump = source.Jump, UseItem = source.UseItem,
            };
        }
    }

    internal sealed class BridgeAction
    {
        public string ActionId;
        public string Tool;
        public Dictionary<string, object> Args = new Dictionary<string, object>();
        public long StartedAt;
        public string Status = "RUNNING";
        public string Reason;
        public int Step;
        public int StuckTicks;
        public int UncertainStreak;
        public int LastX = int.MinValue;
        public int LastY = int.MinValue;
        public int TargetX = int.MinValue;
        public int TargetY = int.MinValue;
        public int Baseline = -1;
        public int StartHp = -1;
        public bool CancelRequested;
    }

    internal sealed class ActionController
    {
        internal static readonly ActionController Instance = new ActionController();
        private readonly object gate = new object();
        private readonly Dictionary<string, ReceiptDto> receipts = new Dictionary<string, ReceiptDto>();
        private BridgeAction current;
        private ControlFrame frame;

        /// <summary>ModPlayer.SetControls 每帧读取的当前控制帧（拷贝，避免跨线程撕裂）。</summary>
        internal ControlFrame CurrentControls
        {
            get { lock (gate) return ControlFrame.Copy(frame); }
        }

        internal void Reset()
        {
            lock (gate)
            {
                current = null;
                frame = null;
                receipts.Clear();
            }
        }

        internal AcceptedDto TryAccept(string actionId, string tool, Dictionary<string, object> args)
        {
            try
            {
                lock (gate)
                {
                    if (current != null && current.Status == "RUNNING")
                    {
                        return new AcceptedDto { Accepted = false, Reason = "ACTION_IN_FLIGHT" };
                    }
                    if (TakeoverWatch.IsPlayerMovingPhysically)
                    {
                        Finish("ABORTED_BY_HUMAN_TAKEOVER", "PLAYER_PHYSICAL_INPUT_DETECTED");
                        return new AcceptedDto { Accepted = true, ActionId = actionId };
                    }
                    var action = new BridgeAction
                    {
                        ActionId = actionId,
                        Tool = tool,
                        Args = args ?? new Dictionary<string, object>(),
                        StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    };
                    action.TargetX = ReadIntArg(action, "x", int.MinValue);
                    action.TargetY = ReadIntArg(action, "y", int.MinValue);
                    current = action;
                    BridgeLog.Info("受理动作 " + tool + " / " + actionId);
                    return new AcceptedDto { Accepted = true, ActionId = actionId };
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("TryAccept 异常：" + e.Message);
                return new AcceptedDto { Accepted = false, Reason = "INTERNAL_ERROR" };
            }
        }

        internal StatusDto Query(string actionId)
        {
            try
            {
                lock (gate)
                {
                    if (current != null && current.ActionId == actionId && current.Status == "RUNNING")
                    {
                        return new StatusDto { ActionId = actionId, Running = true };
                    }
                    return receipts.TryGetValue(actionId, out ReceiptDto receipt)
                        ? new StatusDto { ActionId = actionId, Running = false, Receipt = receipt }
                        : new StatusDto { ActionId = actionId, Running = false };
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("Query 异常：" + e.Message);
                return new StatusDto { ActionId = actionId, Running = false };
            }
        }

        internal bool Cancel()
        {
            try
            {
                lock (gate)
                {
                    if (current == null || current.Status != "RUNNING") return false;
                    // 取消后原动作可能已部分执行 → UNCERTAIN，绝不静默记 FAILED
                    Finish("UNCERTAIN", "CANCELLED_BY_HOST");
                    return true;
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("Cancel 异常：" + e.Message);
                return false;
            }
        }

        /// <summary>SurvivalReflex / TakeoverWatch 调用的中断入口（线程安全）。</summary>
        internal void Interrupt(string status, string reason)
        {
            try
            {
                lock (gate)
                {
                    if (current != null && current.Status == "RUNNING") Finish(status, reason);
                }
            }
            catch (Exception e) { BridgeLog.Error("Interrupt 异常：" + e.Message); }
        }

        /// <summary>每帧推进：反射/接管/取消/世界事实终止判据/下一步寻路。</summary>
        internal void Tick()
        {
            try
            {
                lock (gate)
                {
                    if (current == null || current.Status != "RUNNING")
                    {
                        frame = null;
                        return;
                    }
                    BridgeAction action = current;
                    if (TakeoverWatch.IsPlayerMovingPhysically)
                    {
                        Finish("ABORTED_BY_HUMAN_TAKEOVER", "PLAYER_PHYSICAL_INPUT_DETECTED");
                        return;
                    }
                    if (action.CancelRequested)
                    {
                        Finish("UNCERTAIN", "CANCELLED_BY_HOST");
                        return;
                    }
                    Player p = Main.player[Main.myPlayer];
                    int px = (int)Math.Floor(p.position.X / 16f);
                    int py = (int)Math.Floor(p.position.Y / 16f);

                    if (GoalReached(action, p, px, py))
                    {
                        Finish("COMPLETED", null);
                        return;
                    }

                    action.Step++;
                    if (action.LastX == px && action.LastY == py) action.StuckTicks++;
                    else { action.StuckTicks = 0; action.LastX = px; action.LastY = py; }
                    // 局部卡死哨兵 6~8s（60fps）：UNCERTAIN×2 → FAILED（防死循环）
                    if (action.StuckTicks > 8 * 60)
                    {
                        action.StuckTicks = 0;
                        action.UncertainStreak++;
                        if (action.UncertainStreak >= 3)
                        {
                            Finish("FAILED", "PATH_BLOCKED_PERSISTENT");
                        }
                        else
                        {
                            Finish("UNCERTAIN", "PATH_BLOCKED_BY_STONE");
                        }
                        return;
                    }

                    Step step = NavLite.NextStep(action, px, py);
                    frame = new ControlFrame
                    {
                        Left = step.Left,
                        Right = step.Right,
                        Up = step.Up,
                        Jump = step.Jump,
                        UseItem = step.UseItem,
                    };
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("Tick 异常：" + e.Message);
            }
        }

        /// <summary>世界事实终止判据：每一步都重新读世界，而不是"发完指令就宣布胜利"。</summary>
        private bool GoalReached(BridgeAction action, Player p, int px, int py)
        {
            string tool = action.Tool;
            if (tool == "get_state" || tool == "status" || tool == "say" || tool == "set_mode"
                || tool == "update_notes" || tool == "stop")
            {
                return true; // 纯状态/文本意图，无世界变更
            }
            if (tool == "wait")
            {
                int seconds = ReadIntArg(action, "seconds", 1);
                return action.Step >= Math.Max(1, seconds * 60);
            }
            if (tool == "drink_potion" || tool == "eat" || tool == "heal")
            {
                if (action.StartHp < 0) action.StartHp = p.statLife;
                bool healed = p.statLife > action.StartHp || p.statMana > 0;
                if (healed) return true;
                if (action.Step > 30) Finish("FAILED", "NO_POTION_OR_NO_EFFECT"); // 30 帧无效果如实失败
                return false;
            }
            if (tool == "jump" || tool == "grapple")
            {
                // tML 1.4.4 无 onGround；velocity.Y != 0 即已离地/跳跃中（含原本的上升分支）
                return p.velocity.Y != 0f;
            }
            if (tool == "attack")
            {
                int currentHp = NavLite.NearestHostileHp(px, py);
                if (action.Baseline < 0) action.Baseline = currentHp;
                return currentHp < action.Baseline - 1 || action.Step > 10 * 60;
            }
            if (tool == "build_shelter" || tool == "torch" || tool == "light_torch")
            {
                if (action.Baseline < 0) action.Baseline = NavLite.SolidCount(px, py, 4);
                bool enough = NavLite.SolidCount(px, py, 4) >= action.Baseline + 3;
                if (enough) return true;
                return action.Step > 30 * 60; // 兜底超时由上层超时表处理，这里只防死循环
            }
            if (tool == "place" || tool == "place_platform" || tool == "place_wall")
            {
                if (action.TargetX == int.MinValue || action.TargetY == int.MinValue) return true;
                return Main.tile[action.TargetX, action.TargetY] != null && Main.tile[action.TargetX, action.TargetY].HasTile;
            }
            if (tool == "mine" || tool == "dig_tunnel")
            {
                if (action.TargetX == int.MinValue || action.TargetY == int.MinValue)
                {
                    NavLite.PickMineTarget(action, px, py);
                }
                if (action.TargetX == int.MinValue) return false;
                return !NavLite.IsSolid(action.TargetX, action.TargetY);
            }
            if (tool == "move_to" || tool == "flee")
            {
                if (action.TargetX != int.MinValue && action.TargetY != int.MinValue)
                {
                    return Math.Abs(px - action.TargetX) <= 1 && Math.Abs(py - action.TargetY) <= 1;
                }
                if (tool == "flee") return NavLite.DistanceToNearestThreat(px, py) > 25f;
                return false;
            }
            // 其余工具（aim/use_item/interact/collect/equip/unequip/craft）：一帧意图，
            // 无世界变更可断言 → 如实 UNCERTAIN 而非假报 COMPLETED（由上层复核）
            return action.Step > 2;
        }

        private static int ReadIntArg(BridgeAction action, string key, int fallback)
        {
            try
            {
                if (!action.Args.TryGetValue(key, out object value) || value == null) return fallback;
                if (value is int i) return i;
                if (value is long l) return (int)l;
                return Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture);
            }
            catch { return fallback; }
        }

        /// <summary>写回执（调用方必须持有 gate 锁）。</summary>
        private void Finish(string status, string reason)
        {
            BridgeAction action = current;
            if (action == null) return;
            action.Status = status;
            action.Reason = reason;
            var receipt = new ReceiptDto
            {
                ActionId = action.ActionId,
                Tool = action.Tool,
                Status = status,
                Reason = reason,
                StartedAt = action.StartedAt,
                CompletedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            receipts[action.ActionId] = receipt;
            if (receipts.Count > 128)
            {
                foreach (string key in new List<string>(receipts.Keys).GetRange(0, 64)) receipts.Remove(key);
            }
            current = null;
            frame = null;
            BridgeLog.Info("回执 " + action.Tool + " → " + status + (reason == null ? "" : " / " + reason));
        }
    }

    /// <summary>把 ActionController 的控制帧每帧写入真实 Player.control* 字段（帧级写，16ms 级）。</summary>
    public sealed class BridgeControlPlayer : ModPlayer
    {
        public override void SetControls()
        {
            try
            {
                // 生存反射帧优先于普通动作帧（岩浆跳出必须抢到这一帧）
                ControlFrame f = SurvivalReflex.ConsumeFrame() ?? ActionController.Instance.CurrentControls;
                if (f == null) return; // 无 AI 动作时不碰玩家输入
                Player.controlLeft = f.Left;
                Player.controlRight = f.Right;
                Player.controlUp = f.Up;
                Player.controlJump = f.Jump;
                Player.controlUseItem = f.UseItem;
            }
            catch (Exception e)
            {
                BridgeLog.Error("SetControls 异常：" + e.Message);
            }
        }
    }
}
