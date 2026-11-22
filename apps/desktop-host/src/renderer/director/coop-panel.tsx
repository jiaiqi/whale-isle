/**
 * 多桌宠联机面板（T-M6-22）：每个 MCP 端点 = 一个游戏实例 = 一只桌宠角色。
 * 单端点即当前单机用法；多开时每个星露谷进程配不同 BWF McpPort，本面板聚合并分别启停。
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Play, Square, Users } from 'lucide-react';

interface EndpointView {
  id: string;
  displayName: string;
  gameId: string;
  endpoint: string;
  characterId: string;
  enabled: boolean;
  running: boolean;
  error: string | null;
}

export function CoopPanel(): React.JSX.Element {
  const [endpoints, setEndpoints] = useState<EndpointView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = (): void => {
    void window.directorBridge.coopEndpoints().then((list) => setEndpoints(list as EndpointView[])).catch(() => undefined);
  };
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  const toggle = async (ep: EndpointView): Promise<void> => {
    setBusy(ep.id);
    if (ep.running) {
      await window.directorBridge.coopStop(ep.id);
      setBusy(null);
      toast(`${ep.displayName} 已停止`);
    } else {
      const r = await window.directorBridge.coopStart(ep.id);
      setBusy(null);
      if (!r.ok) toast.error(r.error ?? '端点操作失败');
      else toast(`${ep.displayName} 已接管`);
    }
    refresh();
  };

  return (
    <div className="card px-4 py-3.5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold" style={{ color: 'var(--text-2)' }}><Users size={12} className="mr-1 inline" />联机端点（多桌宠）</h3>
        <button className="pill" style={{ fontSize: 9 }} onClick={refresh}>刷新</button>
      </div>
      {endpoints.map((ep) => (
        <div key={ep.id} data-coop-endpoint={ep.id} className="flex items-center gap-2 border-t py-2 first:border-0" style={{ borderColor: 'var(--stroke)' }}>
          <span className={`pulse-dot${ep.running ? '' : ' off'}`} />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px]" style={{ color: 'var(--text-1)' }}>{ep.displayName}</div>
            <div className="mono truncate text-[9.5px]" style={{ color: 'var(--text-3)' }}>
              {ep.endpoint} · 角色 {ep.characterId}{ep.error ? ` · ${ep.error.slice(0, 40)}` : ''}
            </div>
          </div>
          <button
            className={`pill${ep.running ? ' pill-green' : ''}`}
            style={{ fontSize: 10, cursor: 'pointer' }}
            disabled={busy === ep.id || !ep.enabled}
            onClick={() => void toggle(ep)}
          >
            {busy === ep.id ? '…' : ep.running ? <><Square size={10} />停止</> : <><Play size={10} />接管</>}
          </button>
        </div>
      ))}
      {endpoints.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>尚未配置端点（默认本机 18080）</div>}
      <p className="mt-2 text-[9.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
        多开：每个星露谷进程各跑一个 BWF Mod，config.json 的 McpPort 设为不同端口；
        在 userData/mcp-endpoints.json 里登记端点即可让不同桌宠各自接管。
      </p>
    </div>
  );
}
