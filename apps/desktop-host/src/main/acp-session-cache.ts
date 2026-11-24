/**
 * ACP 会话 id 缓存（T-M6-51）。
 *
 * session-started / permission / exit 三类事件必须落在同一个 sessionId 上；
 * 之前 permission/exit 用 `acp-${presetId}` 兜底，导致工作跟随出现幽灵会话。
 */
export interface AcpSessionCache {
  onStarted(presetId: string, sessionId: string): string;
  /** 取当前会话；未收到 session-started 时回退稳定兜底 id（仍保持同一 preset 一致） */
  resolve(presetId: string): string;
  onExit(presetId: string): string;
}

export function createAcpSessionCache(): AcpSessionCache {
  const sessions = new Map<string, string>();
  return {
    onStarted(presetId, sessionId) {
      sessions.set(presetId, sessionId);
      return sessionId;
    },
    resolve(presetId) {
      return sessions.get(presetId) ?? `acp-${presetId}`;
    },
    onExit(presetId) {
      const sessionId = this.resolve(presetId);
      sessions.delete(presetId);
      return sessionId;
    },
  };
}
