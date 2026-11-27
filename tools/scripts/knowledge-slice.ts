/** 04D 人类复跑入口：与 Electron 共用 KnowledgeHost；默认只探测，不自动安装或执行游戏动作。 */
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ActionLock, StardewAdapter } from '../../packages/game-bridge-mcp/src/index';
import { KnowledgeHost } from '../../apps/desktop-host/src/main/knowledge-host';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const dataDir = value('--data-dir');
  if (!dataDir) throw new Error('必须显式指定 --data-dir，避免写入正在使用的宿主数据库；首次验证建议使用临时目录');
  const adapter = new StardewAdapter(value('--bwf-endpoint'));
  const game = { adapter, lock: new ActionLock(adapter.transport), blockedReason: () => null };
  const host = new KnowledgeHost({
    userDataDir: resolve(dataDir),
    materialsRoot: resolve(value('--materials-root') ?? join(homedir(), 'WhaleIsle', 'knowledge-materials', 'owner-authorized')),
    guidesDir: resolve('guide-forager'), game: () => game,
  });
  try {
    const status = await host.sourceStatus();
    const record: Record<string, unknown> = { sourceStatus: status, evidenceLevel: 'unverified' };
    const file = value('--import');
    if (file) {
      const request = {
        filePath: resolve(file), topic: value('--topic') ?? 'owner 授权攻略', licenseScope: value('--license') ?? 'unknown',
        ...(value('--license-note') ? { licenseNote: value('--license-note') } : {}),
        ...(value('--game-version') ? { gameVersion: value('--game-version') } : {}),
      };
      const first = await host.importMaterial(request);
      const second = first.ok ? await host.importMaterial(request) : undefined;
      record.import = first;
      record.digestReproduction = first.ok && second?.ok
        ? { available: true, first: first.pack!.digest, second: second.pack!.digest, identical: first.pack!.digest === second.pack!.digest }
        : { available: false, reason: first.error ?? '材料不可读' };
      if (!first.ok) process.exitCode = 2;
    }
    const assess = value('--assess');
    if (assess) record.applicability = await host.assess(assess);
    const execute = value('--execute');
    if (execute) {
      const tool = value('--tool');
      if (!tool) throw new Error('--execute 必须同时指定 --tool，不能自动猜测动作');
      const result = await host.execute({ knowledgeId: execute, tool, args: JSON.parse(value('--args') ?? '{}') });
      record.execution = result;
      if (result.receipt) record.evidenceLevel = result.receipt.evidenceLevel;
      if (!result.ok) process.exitCode = 2;
    }
    record.persisted = { ...host.list(), packs: host.evidence(), receipts: host.receipts() };
    if (status.state !== 'available' && !execute && !file) process.exitCode = 2;
    const output = JSON.stringify(record, null, 2) + '\n';
    const outputPath = value('--output');
    if (outputPath) {
      // 证据归档路径显式指定；材料正文可能私密，不上传外部服务。
      mkdirSync(resolve(outputPath, '..'), { recursive: true });
      writeFileSync(resolve(outputPath), output, { flag: 'wx' });
    }
    process.stdout.write(output);
  } finally { host.close(); }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
