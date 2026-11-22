/**
 * BWF /settings 远程设置推送（T-M6-16 用户指令：游戏内左上角 MCP 提示 HUD 中控台开关）。
 *
 * BWF（1.1.27+本仓补丁）在 MCP 同端口暴露 /settings：POST {revision, settings} 由
 * ModEntry.ApplyRemoteSettings 应用并 Helper.WriteConfig 落盘——改 ShowHud 每帧生效（DrawHud
 * 每帧读 Config），无需重启游戏；GET 回读快照可确认 showHud 是否真正应用
 * （未打补丁的旧 DLL 会静默忽略未知键 → 快照里没有 showHud，据此提示「需重启游戏换新 DLL」）。
 * 与 /mcp 一样只监听 127.0.0.1；游戏未开/端口未 bind → 如实返回 reachable:false，绝不重试轰炸。
 */
export const BWF_BASE_URL = 'http://127.0.0.1:18080';

export interface BwfSettingsPush {
  /** 游戏侧真正应用了吗（快照回读 showHud == 目标值；旧 DLL 忽略未知键时为 false） */
  applied: boolean;
  /** MCP 端口可达吗（游戏没开时为 false，配置仍在本地持久化，开游戏后会自愈同步） */
  reachable: boolean;
  showHud: boolean;
}

/** POST /settings {revision, settings:{showHud}} → 回读快照验证应用（fetch 可注入便于单测） */
export async function pushBwfShowHud(
  showHud: boolean,
  baseUrl: string = BWF_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<BwfSettingsPush> {
  try {
    const response = await fetchImpl(`${baseUrl}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: `whaleisle-${Date.now()}`, settings: { showHud } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { applied: false, reachable: true, showHud };
    const body = (await response.json()) as { settings?: { showHud?: unknown } };
    const applied = body.settings?.showHud === showHud;
    return { applied, reachable: true, showHud };
  } catch {
    return { applied: false, reachable: false, showHud };
  }
}
