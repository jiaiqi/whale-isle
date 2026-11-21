/**
 * ACP 模拟器（T-M6-02，tools/mock-harness 同源思想）：假 agent 子进程。
 * 行协议：initialize → session/new → session/prompt → 两条流式 update →
 * （若 prompt 含 [权限] 则先发 request_permission）→ turn complete。
 * 供 agent-harness 单测与后续 Gate 4 扩展使用。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';

export const ACP_SIMULATOR_CODE = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'sim-key', name: '模拟凭据' }], authenticated: true } });
  } else if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: 'sim-session-1' } });
  } else if (msg.method === 'session/prompt') {
    const text = (msg.params.prompt ?? []).map((b) => b.text ?? '').join('');
    pendingPromptId = msg.id;
    const sessionId = msg.params.sessionId;
    const notify = (params) => send({ jsonrpc: '2.0', method: 'session/update', params });
    notify({ sessionId, update: { type: 'text', text: '收到：' + text.slice(0, 40) } });
    if (text.includes('[权限]')) {
      send({ jsonrpc: '2.0', method: 'session/request_permission', params: {
        requestId: 42,
        toolCall: { toolName: 'sim_write_file', input: { path: '/tmp/x.txt', content: 'hello' } },
        options: [ { optionId: 'allow_once', name: '允许一次' }, { optionId: 'allow_always', name: '总是允许' }, { optionId: 'reject', name: '拒绝' } ],
      } });
    } else {
      notify({ sessionId, update: { type: 'text', text: '模拟完成 ✅' } });
      send({ id: msg.id, result: { stopReason: 'end_turn' } });
    }
  } else if (msg.method === 'session/permission_response') {
    const outcome = msg.params.outcome && msg.params.outcome.optionId;
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'sim-session-1',
      update: { type: 'text', text: '审批结果：' + String(outcome) },
    } });
    // 权限路径的 turn 结束（回真实 prompt 请求 id——客户端 pending 才能 resolve）
    send({ id: pendingPromptId, result: { stopReason: 'end_turn' } });
  } else if (msg.method === 'session/cancel') {
    send({ id: msg.id, result: { stopped: true } });
  }
});
`;

/** 启动模拟器（node 子进程）——返回真实 ChildProcess（stdio pipe） */
export function spawnAcpSimulator(): ChildProcessWithoutNullStreams {
  // -e 直跑源码：零临时文件，CI 干净
  return spawn(process.execPath, ['-e', ACP_SIMULATOR_CODE], { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** 同步可用性自检（供 HarnessManager 探测注入） */
export function simulatorAvailable(): boolean {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 5_000 });
  return r.status === 0;
}
