/**
 * 「跨 AI 跟随与接口」（T-M6-49，对齐 design/pet-stage.html Tab 4）。
 *
 * 左：只读跟随状态（source/session、工具调用数、≥8 次戴皇冠、单宠/多 AI 策略）。
 * 右：对外本机驱动口示例 + 真实试调（经内嵌 WebUI 18780 + device token，不伪造 200）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Crown, Play, Terminal, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import type { WorkFollowStatus } from '@workbench/shared-protocol';

const SOURCE_LABEL: Record<string, string> = {
  acp: 'ACP Harness',
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  qwen: 'Qwen Code',
  kimi: 'Kimi CLI',
  grok: 'Grok CLI',
};

export function WorkFollowPanel({ characterName }: { characterId: string; characterName: string }): React.JSX.Element {
  const [status, setStatus] = useState<WorkFollowStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback((): void => {
    void window.directorBridge.workFollowStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    reload();
    // 切 Tab 会反复挂载：必须返回清理函数退订，否则监听器叠加
    return window.directorBridge.onWorkFollowUpdate((next) => setStatus(next));
  }, [reload]);

  const setMode = async (mode: 'single' | 'multi'): Promise<void> => {
    const next = await window.directorBridge.workFollowMode(mode);
    setStatus(next);
    toast.success(mode === 'multi' ? '多 AI 各来一只（按来源映射角色）' : '单宠模式：主桌宠随活跃 AI 自动换装');
  };

  const simulate = async (): Promise<void> => {
    setBusy('sim');
    try {
      const sessionId = `demo-${Date.now().toString(36)}`;
      await window.directorBridge.workFollowIngest({ source: 'claude', sessionId, kind: 'start', taskTitle: '演示：整理本仓库文档' });
      for (let index = 0; index < 8; index += 1) {
        await window.directorBridge.workFollowIngest({ source: 'claude', sessionId, kind: 'tool', toolName: 'Read' });
      }
      await window.directorBridge.workFollowIngest({ source: 'claude', sessionId, kind: 'stop' });
      toast.success('已注入一条演示会话：8 次工具调用 → 自动戴皇冠（真实写入 work-follow 状态）');
      reload();
    } finally { setBusy(null); }
  };

  const callSay = async (): Promise<void> => {
    setBusy('api');
    try {
      const info = await window.directorBridge.webuiInfo();
      const response = await fetch(`http://127.0.0.1:${info.port}/api/pet/default/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ text: `巡检完成！我是${characterName}，设备状态一切正常。`, scene: 'normal' }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (response.ok && body.ok === true) toast.success(`POST /api/pet/default/say → ${response.status}（桌宠已开口）`);
      else toast.error(`API 返回 ${response.status}：${body.error ?? '未知错误'}`);
    } catch (error) {
      toast.error(`试调失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(null); }
  };

  const copyExample = async (): Promise<void> => {
    const info = await window.directorBridge.webuiInfo().catch(() => null);
    const port = info?.port ?? 18780;
    const example = [
      `GET  http://127.0.0.1:${port}/api/pet/default/state   -H "Authorization: Bearer <device token>"`,
      `POST http://127.0.0.1:${port}/api/pet/default/say     -d '{"text":"巡检完成！","scene":"normal"}'`,
      `POST http://127.0.0.1:${port}/api/pet/default/action  -d '{"actionState":"happy_maid","durationMs":6000}'`,
    ].join('\n');
    await navigator.clipboard.writeText(example);
    toast.success('已复制本机接口调用示例（token 请从 WebUI 地址栏取）');
  };

  const sessions = status?.sessions ?? [];
  const active = sessions.filter((session) => session.active);

  return (
    <section className="grid gap-3 xl:grid-cols-2" data-work-follow-panel>
      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Workflow size={15} style={{ color: 'var(--blue)' }} />跨 AI 工作跟随 · {characterName}
          </h3>
          <div className="seg-tabs">
            <button type="button" data-follow-mode="single" className={`seg-tab${status?.mode === 'single' ? ' on' : ''}`} onClick={() => void setMode('single')}>单宠换装</button>
            <button type="button" data-follow-mode="multi" className={`seg-tab${status?.mode === 'multi' ? ' on' : ''}`} onClick={() => void setMode('multi')}>多 AI 各一只</button>
          </div>
        </div>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--text-2)' }}>
          只读事件名/工具名/模型名，不碰对话正文与凭据；单会话工具调用 ≥ 8 次自动戴小皇冠。
          当前活跃会话 {active.length} 个。
        </p>

        <div className="space-y-2" data-follow-sessions>
          {sessions.map((session) => (
            <div key={`${session.sessionId}:${session.source}`} className="rounded-xl px-3 py-2" style={{ border: `1px solid ${session.active ? 'var(--blue-line)' : 'var(--stroke)'}`, background: 'var(--surface-2)' }}>
              <div className="flex items-center gap-2 text-[12px] font-semibold">
                <span className="grid h-5 w-5 place-items-center rounded-full text-[9px]" style={{ background: session.active ? 'var(--green-dim)' : 'var(--inset)', color: session.active ? 'var(--green)' : 'var(--text-3)' }}>{session.active ? '●' : '○'}</span>
                {SOURCE_LABEL[session.source] ?? session.source}
                {session.crowned && <Crown size={12} style={{ color: 'var(--amber)' }} />}
                <span className="ml-auto mono text-[10px]" style={{ color: 'var(--text-3)' }}>{session.toolCalls} 次工具</span>
              </div>
              <div className="mt-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                {session.taskTitle || '(未提供任务名)'} · {session.modelName || '未知模型'} · 角色 {session.characterId || '不换装'}
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              还没有跟随事件：在本机 CLI 装钩子（tools/hooks/work-follow-hook.mjs）或在 ACP Harness 里开会话，或先点下方「注入演示会话」。
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-pill ghost" data-follow-demo disabled={busy !== null} onClick={() => void simulate()}>注入演示会话</button>
          <button className="btn-pill ghost" onClick={() => reload()}>刷新</button>
        </div>

        <div className="mt-3 space-y-1" data-follow-recent>
          {(status?.recent ?? []).slice(0, 6).map((entry, index) => (
            <div key={`${entry.at}:${index}`} className="mono flex gap-2 text-[10px]" style={{ color: 'var(--text-3)' }}>
              <span>{new Date(entry.at).toLocaleTimeString('zh-CN')}</span>
              <span>{SOURCE_LABEL[entry.source] ?? entry.source}</span>
              <span>{entry.kind}</span>
              {entry.toolName !== '' && <span>· {entry.toolName}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Terminal size={15} style={{ color: 'var(--green)' }} />对外本机驱动口
        </h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--text-2)' }}>
          复用内嵌 WebUI（127.0.0.1:18780 + device token）；所有入参过 Zod Schema，睡觉态默认拒收（wake=true 可叫醒）。
        </p>
        <pre className="whitespace-pre-wrap rounded-xl p-3 text-[10.5px]" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-2)' }} data-pet-api-doc>{`GET  /api/pet/:agentId/state
POST /api/pet/:agentId/say     {"text":"巡检完成！","scene":"normal"}
POST /api/pet/:agentId/action  {"actionState":"happy_maid","durationMs":6000}`}</pre>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-pill primary" data-pet-api-try disabled={busy !== null} onClick={() => void callSay()}>
            <Play size={12} />试调 /say
          </button>
          <button className="btn-pill ghost" onClick={() => void copyExample()}>
            <Copy size={12} />复制示例
          </button>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
          插件侧：在 manifest.json 声明 <span className="mono">{'{"resource":"pet:control","policy":"allow"}'}</span> 后，setup(ctx) 可拿到
          <span className="mono"> ctx.petApi.state/say/action</span>；未声明的插件拿到 undefined。
        </p>
      </div>
    </section>
  );
}
