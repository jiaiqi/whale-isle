/**
 * Evolution Engine Lite CLI 入口（V2-P0-05）
 * 用法：pnpm evolution:lite status | next
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvolutionStateStore } from './state-store';

export function runCli(argv: string[], cwd = process.cwd()): { exitCode: number; output: string } {
  const cmd = argv[0] ?? 'status';
  const statePath = join(resolve(cwd), '.evolution-lite', 'state.json');
  const store = new EvolutionStateStore(statePath);

  if (cmd === 'status') {
    return { exitCode: 0, output: store.renderProgressMarkdown() };
  }
  if (cmd === 'next') {
    const next = store.resumeOrPickNext();
    return {
      exitCode: 0,
      output: next ? `${next.id} (${next.status}): ${next.title}` : '无可执行工单',
    };
  }
  return { exitCode: 1, output: `未知子命令：${cmd}（支持 status | next）` };
}

/* v8 ignore next 4 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = runCli(process.argv.slice(2));
  console.log(res.output);
  process.exit(res.exitCode);
}
