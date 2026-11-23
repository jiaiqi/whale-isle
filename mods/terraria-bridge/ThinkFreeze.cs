/**
 * AI 思考期世界冻结（M7 / T-M7-T2）：单人模式（Main.netMode == 0）下让模型思考时
 * 暂停世界时钟，避免 AI 想半天回来发现天黑被怪围殴——对齐 BlindWhaleFarmer 的
 * 「思考时冻结游戏时钟」与 shared-protocol TerrariaBridgeConfig.freezeWhileThinking。
 *
 * 安全约束：暂停是单人的，联机（netMode != 0）绝不冻结；
 * 用后台定时器兜底释放，防止游戏暂停后 ModSystem 钩子不再运行导致永久卡死。
 * 思想参考（未复制源码）：BlindWhaleFarmer / TerraBlind (MIT)。异常只写日志不崩游戏。
 */
using System;
using System.Threading;
using Terraria;

namespace TerrariaBridge
{
    internal static class ThinkFreeze
    {
        private static readonly object Gate = new object();
        private static Timer releaseTimer;
        private static bool frozen;
        private static long deadlineUtcMs;

        internal static bool IsFrozen
        {
            get { lock (Gate) return frozen; }
        }

        /// <summary>开始思考：最多冻结 maxMs 毫秒（默认 1s，防模型卡住把游戏冻死）。</summary>
        internal static void BeginThink(int maxMs = 1_000)
        {
            try
            {
                if (Main.netMode != 0) return; // 联机不冻结
                if (TakeoverWatch.IsPlayerMovingPhysically) return; // 玩家接管期间不冻结
                lock (Gate)
                {
                    if (frozen) return;
                    frozen = true;
                    deadlineUtcMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Math.Max(100, maxMs);
                    Main.gamePaused = true;
                    releaseTimer?.Dispose();
                    releaseTimer = new Timer(_ => EndThink(), null, Math.Max(100, maxMs), Timeout.Infinite);
                }
                BridgeLog.Info("AI 思考期冻结世界（单人，" + maxMs + "ms 上限）");
            }
            catch (Exception e)
            {
                BridgeLog.Error("BeginThink 异常：" + e.Message);
            }
        }

        internal static void EndThink()
        {
            try
            {
                lock (Gate)
                {
                    if (!frozen) return;
                    frozen = false;
                    deadlineUtcMs = 0;
                    releaseTimer?.Dispose();
                    releaseTimer = null;
                    Main.gamePaused = false;
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("EndThink 异常：" + e.Message);
            }
        }

        /// <summary>每帧兜底检查（钩子仍运行时生效；暂停期间的真正兜底靠 releaseTimer）。</summary>
        internal static void Tick()
        {
            try
            {
                long deadline;
                lock (Gate)
                {
                    if (!frozen) return;
                    deadline = deadlineUtcMs;
                }
                if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadline) EndThink();
            }
            catch (Exception e)
            {
                BridgeLog.Error("ThinkFreeze.Tick 异常：" + e.Message);
            }
        }

        internal static void Reset()
        {
            try
            {
                lock (Gate)
                {
                    releaseTimer?.Dispose();
                    releaseTimer = null;
                    frozen = false;
                    deadlineUtcMs = 0;
                    if (Main.netMode == 0) Main.gamePaused = false;
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("ThinkFreeze.Reset 异常：" + e.Message);
            }
        }
    }
}
