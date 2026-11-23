/**
 * 玩家接管看门狗（M7 / T-M7-T2）：F8 显式接管 + 真实键鼠输入检测。
 * 玩家一动，在飞动作必须 <100ms 转成 ABORTED_BY_HUMAN_TAKEOVER；
 * 静默 8s（takeoverReacquireMs 对齐 shared-protocol TerrariaBridgeConfig）后回托管。
 *
 * 思想参考 MutantPilot (MIT) 的 F6 接管与 Reisenbug/TerraBlind (MIT) 的
 * 「玩家物理输入优先」；我们改用 F8 并加入真实硬件输入检测。未复制源码。
 */
using System;
using Microsoft.Xna.Framework.Input;
using Terraria;

namespace TerrariaBridge
{
    internal static class TakeoverWatch
    {
        private const int ReacquireFrames = 8 * 60; // 8s @60fps
        private static bool takeover;
        private static int holdFrames;
        private static bool lastF8;
        private static Keys[] lastKeys = new Keys[0];
        private static int lastMouseX, lastMouseY;
        private static bool lastMouseLeft, lastMouseRight;

        internal static bool IsPlayerMovingPhysically
        {
            get { try { return takeover; } catch { return false; } }
        }

        internal static string CurrentAuthority
        {
            get
            {
                try
                {
                    if (IsPlayerMovingPhysically) return "HUMAN_TAKEOVER_ACTIVE";
                    return ThinkFreeze.IsFrozen ? "PAUSED_BY_PROGRAM" : "AI_AUTOPILOT";
                }
                catch { return "AI_AUTOPILOT"; }
            }
        }

        internal static void Reset()
        {
            takeover = false;
            holdFrames = 0;
            lastF8 = false;
            lastKeys = new Keys[0];
            lastMouseX = lastMouseY = 0;
            lastMouseLeft = lastMouseRight = false;
        }

        internal static void Tick()
        {
            try
            {
                KeyboardState kb = Main.keyState;
                bool f8 = kb.IsKeyDown(Keys.F8);
                if (f8 && !lastF8)
                {
                    takeover = !takeover; // F8 按下切换接管/交还
                    holdFrames = takeover ? ReacquireFrames : 0;
                    if (takeover) ActionController.Instance.Interrupt("ABORTED_BY_HUMAN_TAKEOVER", "F8_TAKEOVER");
                    BridgeLog.Info(takeover ? "F8 玩家接管：AI 动作已中止" : "F8 交还控制权：AI 恢复托管");
                }
                lastF8 = f8;

                // 物理键鼠输入检测：非 F8 的按键按下 / 鼠标移动或点击 → 认定玩家接管
                Keys[] nowKeys = kb.GetPressedKeys();
                bool physical = false;
                foreach (Keys key in nowKeys)
                {
                    if (key == Keys.F8) continue;
                    bool wasDown = false;
                    foreach (Keys old in lastKeys) if (old == key) { wasDown = true; break; }
                    if (!wasDown) { physical = true; break; }
                }
                bool mouseMoved = Math.Abs(Main.mouseX - lastMouseX) > 3 || Math.Abs(Main.mouseY - lastMouseY) > 3;
                bool mouseClicked = (Main.mouseLeft && !lastMouseLeft) || (Main.mouseRight && !lastMouseRight);
                lastKeys = nowKeys;
                lastMouseX = Main.mouseX;
                lastMouseY = Main.mouseY;
                lastMouseLeft = Main.mouseLeft;
                lastMouseRight = Main.mouseRight;

                if (physical || mouseMoved || mouseClicked)
                {
                    if (!takeover)
                    {
                        ActionController.Instance.Interrupt("ABORTED_BY_HUMAN_TAKEOVER", "PLAYER_PHYSICAL_INPUT_DETECTED");
                        BridgeLog.Info("检测到真实键鼠输入：AI 动作已中止，进入玩家接管");
                    }
                    takeover = true;
                    holdFrames = ReacquireFrames;
                }

                // 静默回托管：8s 无输入则 AI 重新接管（不抢正在进行的玩家操作）
                if (takeover && holdFrames > 0)
                {
                    holdFrames--;
                    if (holdFrames == 0)
                    {
                        takeover = false;
                        BridgeLog.Info("静默 8s 到期：AI 回托管");
                    }
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("TakeoverWatch 异常：" + e.Message);
            }
        }
    }
}
