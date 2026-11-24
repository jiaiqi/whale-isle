/**
 * 自定义闲时动作与内置氛围池混播（T-M6-55）。
 *
 * `character.json.idleActions` 里的姿态只有「manifest 真的存在」才参与轮盘；
 * 自定义动作权重 2、内置氛围动作权重 1——既保留角色个性，也不让桌面只剩重复动作。
 * 纯函数 + 注入 rng，便于确定性单测。
 */
export interface IdleMixPick {
  id: string;
  kind: 'custom-idle' | 'ambient';
}

export function pickIdleMix(input: {
  idleActions: readonly string[];
  available: readonly string[];
  ambientIds: readonly string[];
  rng?: () => number;
}): IdleMixPick | null {
  const available = new Set(input.available);
  const custom = [...new Set(input.idleActions.filter((id) => id.trim() !== '' && available.has(id)))];
  const ambient = [...new Set(input.ambientIds.filter((id) => id.trim() !== '' && available.has(id)))];
  if (custom.length === 0 && ambient.length === 0) return null;
  if (custom.length === 0) {
    const rng = input.rng ?? Math.random;
    return { id: ambient[Math.floor(rng() * ambient.length) % ambient.length]!, kind: 'ambient' };
  }
  if (ambient.length === 0) {
    const rng = input.rng ?? Math.random;
    return { id: custom[Math.floor(rng() * custom.length) % custom.length]!, kind: 'custom-idle' };
  }
  const rng = input.rng ?? Math.random;
  const weights = [...custom.map(() => 2), ...ambient.map(() => 1)];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = rng() * total;
  for (let index = 0; index < weights.length; index += 1) {
    cursor -= weights[index]!;
    if (cursor < 0) {
      return index < custom.length
        ? { id: custom[index]!, kind: 'custom-idle' }
        : { id: ambient[index - custom.length]!, kind: 'ambient' };
    }
  }
  return { id: ambient[ambient.length - 1]!, kind: 'ambient' };
}
