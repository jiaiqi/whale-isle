/**
 * 模组生命周期（M7 / T-M7-T2）。
 * 思想参考（未复制源码）：Reisenbug/TerraBlind (MIT) 的模组内 HTTP 服务端思想、
 * MutantPilot (MIT) 的帧级控制与 F6 接管（我们改用 F8）。
 * 全信任进程内代码：所有入口 try/catch 写日志，异常绝不允许冒泡崩游戏。
 */
using System;
using Terraria;
using Terraria.ModLoader;

namespace TerrariaBridge
{
    /// <summary>M7 模组入口；实际生命周期由 BridgeSystem 承担。</summary>
    public sealed class TerrariaBridgeMod : Mod
    {
    }

    /// <summary>ModSystem 生命周期：起停 HTTP 桥、每帧驱动动作/反射/接管/冻结。</summary>
    public sealed class BridgeSystem : ModSystem
    {
        public override void Load()
        {
            try
            {
                BridgeLog.Init(message => WriteModLog(Mod, message));
                BridgeLog.Info("terraria-bridge 载入：统一桥接端点 http://127.0.0.1:18090");
                ThinkFreeze.Reset();
                TakeoverWatch.Reset();
                StateExporter.ResetClock();
                if (!Main.dedServ)
                {
                    BridgeServer.Instance.Start();
                }
                else
                {
                    BridgeLog.Warn("专用服务器模式：HTTP 桥未启动（需玩家客户端承载控制）");
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("Load 异常：" + e.Message);
            }
        }

        public override void Unload()
        {
            try
            {
                BridgeServer.Instance.Stop();
                ActionController.Instance.Reset();
                ThinkFreeze.Reset();
                TakeoverWatch.Reset();
                BridgeLog.Info("terraria-bridge 卸载完成");
            }
            catch (Exception e)
            {
                BridgeLog.Error("Unload 异常：" + e.Message);
            }
            finally
            {
                BridgeLog.Init(null);
            }
        }

        /// <summary>
        /// 经反射调用 Mod.Logger.Info(string)，与本模组 Action&lt;string&gt; 日志委托解耦。
        /// 本模组 csproj 未（也不应）引用 log4net，直接写 Mod.Logger.Info 会触发 CS0012。
        /// </summary>
        private static void WriteModLog(Mod mod, string message)
        {
            try
            {
                object logger = typeof(Mod).GetProperty("Logger")?.GetValue(mod);
                if (logger == null) return;
                foreach (var method in logger.GetType().GetMethods())
                {
                    if (method.Name != "Info") continue;
                    var parameters = method.GetParameters();
                    if (parameters.Length != 1 || !parameters[0].ParameterType.IsAssignableFrom(typeof(string))) continue;
                    method.Invoke(logger, new object[] { message });
                    return;
                }
            }
            catch { /* 日志失败不影响游戏 */ }
        }

        /// <summary>每帧：反射优先 → 接管检测 → 动作推进（世界事实终止判据）。</summary>
        public override void PostUpdatePlayers()
        {
            try
            {
                if (Main.gameMenu || Main.myPlayer < 0 || Main.myPlayer >= Main.player.Length) return;
                StateExporter.TickClock();
                ThinkFreeze.Tick();
                TakeoverWatch.Tick();
                SurvivalReflex.Evaluate();
                ActionController.Instance.Tick();
            }
            catch (Exception e)
            {
                BridgeLog.Error("PostUpdatePlayers 异常：" + e.Message);
            }
        }
    }

    /// <summary>统一日志出口：未初始化时静默，绝不抛异常。</summary>
    internal static class BridgeLog
    {
        // 只依赖 Action<string> 委托，避免绑定 tML 版本间可能变化的 Logger 具体类型（编译/运行更稳）。
        private static Action<string> sink;

        internal static void Init(Action<string> logger) => sink = logger;

        internal static void Info(string message)
        {
            try { sink?.Invoke("[terraria-bridge] " + message); } catch { /* 日志失败不影响游戏 */ }
        }

        internal static void Warn(string message)
        {
            try { sink?.Invoke("[WARN][terraria-bridge] " + message); } catch { /* 日志失败不影响游戏 */ }
        }

        internal static void Error(string message)
        {
            try { sink?.Invoke("[ERROR][terraria-bridge] " + message); } catch { /* 日志失败不影响游戏 */ }
        }
    }
}
