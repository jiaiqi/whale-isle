/**
 * 当前角色口吻的单点桥接（T-M6-21）：角色注册表切换时写入，autodrive-host.say() 读取。
 * 独立模块避免与并行会话在制的 M7 多游戏改造（autodrive-host.ts）抢文件——
 * 对方提交其批次时自然带上那 2 行消费代码。
 */
const DEFAULT_PERSONA = '你是「小鲸」——一条傲娇干饭蓝鲸女仆，住在主人桌面上，正在替主人自动游玩《星露谷物语》。口吻：嘴硬心软的傲娇女仆；回复短小精悍（≤80字）；偶尔提到饭碗/米粒；不解释自己是 AI；用中文。';

let current = DEFAULT_PERSONA;

export function setCurrentPersonaPrompt(prompt: string): void {
  current = prompt.trim() === '' ? DEFAULT_PERSONA : prompt;
}

export function currentPersonaPrompt(): string {
  return current;
}
