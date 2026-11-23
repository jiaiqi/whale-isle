/**
 * 生存反射（M7 / T-M7-T2）：帧级检测岩浆与低血，抢先跳出/喝药并把在飞动作推成
 * UNCERTAIN（反射打断后原动作结果不可判定，绝不能假报 COMPLETED）。
 *
 * 思想参考 Reisenbug/TerraBlind (MIT) 的 SurvivalReflex（跳岩浆/喝药）；
 * MutantPilot (MIT) 的战斗反射；未复制源码。
 * 全部逻辑 try/catch，任何异常只写日志不崩游戏。
 */
using System;
using Terraria;

namespace TerrariaBridge
{
    internal static class SurvivalReflex
    {
        private static ControlFrame pendingFrame;
        private static int cooldownFrames;
        private const int ReflexCooldownFrames = 45; // ~0.75s @60fps，防反射抖动刷屏

        /// <summary>供 ModPlayer.SetControls 消费的一次性反射帧（消费即清空）。</summary>
        internal static ControlFrame ConsumeFrame()
        {
            ControlFrame f = pendingFrame;
            pendingFrame = null;
            return f;
        }

        internal static void Evaluate()
        {
            try
            {
                if (cooldownFrames > 0) { cooldownFrames--; return; }
                Player p = Main.player[Main.myPlayer];
                int px = (int)Math.Floor(p.position.X / 16f);
                int py = (int)Math.Floor(p.position.Y / 16f);

                // 岩浆：脚下/周围 2 格内有液体 → 立即跳开 + 打断在飞动作
                bool lava = false;
                for (int dy = 0; dy <= 2 && !lava; dy++)
                {
                    for (int dx = -2; dx <= 2; dx++)
                    {
                        if (NavLite.IsLava(px + dx, py + dy)) { lava = true; break; }
                    }
                }
                if (lava)
                {
                    pendingFrame = new ControlFrame { Jump = true, Right = p.direction >= 0, Left = p.direction < 0 };
                    ActionController.Instance.Interrupt("UNCERTAIN", "LAVA_ESCAPE_TRIGGERED");
                    cooldownFrames = ReflexCooldownFrames;
                    BridgeLog.Warn("SurvivalReflex：岩浆触发跳出，在飞动作已推 UNCERTAIN");
                    return;
                }

                // 低血：血量 <30% 且背包有药 → 打断在飞动作，让规划器优先喝药
                if (p.statLifeMax > 0 && p.statLife * 100 / p.statLifeMax < 30 && HasPotion(p))
                {
                    ActionController.Instance.Interrupt("UNCERTAIN", "LOW_HP_POTION_REFLEX");
                    pendingFrame = new ControlFrame { UseItem = true };
                    cooldownFrames = ReflexCooldownFrames;
                    BridgeLog.Warn("SurvivalReflex：低血触发喝药，在飞动作已推 UNCERTAIN");
                }
            }
            catch (Exception e)
            {
                BridgeLog.Error("SurvivalReflex 异常：" + e.Message);
            }
        }

        private static bool HasPotion(Player p)
        {
            try
            {
                for (int i = 0; i < p.inventory.Length; i++)
                {
                    Item item = p.inventory[i];
                    if (item != null && !item.IsAir && item.Name != null
                        && (item.Name.Contains("Potion") || item.Name.Contains("药水") || item.Name.Contains("healing")))
                    {
                        return true;
                    }
                }
            }
            catch { /* 背包读取失败 → 当作没药，交上层处理 */ }
            return false;
        }
    }
}
