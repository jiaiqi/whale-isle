/**
 * sidecar 可执行入口：node/tsx services/dst-bridge-sidecar/src/index.ts
 * 环境变量：
 *   DST_PAIR_TOKEN     必填，mod 侧 pair_token 必须一致
 *   DST_PORT           默认 18100（宿主面 + 游戏面 /v1/tick 共用）
 *   DST_CLUSTER_DIR    可选，专用服集群目录（含 cluster_token.txt）
 *   DST_AUTOSTART      =1 时自动拉起专用服（需 DST_BINARY 指向可执行文件）
 *   DST_FILE_FALLBACK  =1 时启用 unsafedata/*.json 降级通道
 */
import { resolve } from 'node:path';
import { DstServerProcess } from './dst-process';
import { createDstSidecar } from './server';

async function main(): Promise<void> {
  const pairToken = process.env.DST_PAIR_TOKEN ?? '';
  if (!pairToken) {
    console.error('[dst-sidecar] 缺少 DST_PAIR_TOKEN：请在 sidecar 与 mod 配置同一 token');
    process.exitCode = 1;
    return;
  }

  const sidecar = createDstSidecar({
    pairToken,
    port: Number(process.env.DST_PORT ?? 18100),
    onLog: (line) => console.log(`[dst-sidecar] ${line}`),
  });
  if (process.env.DST_FILE_FALLBACK === '1') {
    sidecar.enableFileFallback({
      snapshotFile: resolve(process.env.DST_SNAPSHOT_FILE ?? 'unsafedata/dst_bridge_snapshot.json'),
      planFile: resolve(process.env.DST_PLAN_FILE ?? 'unsafedata/dst_bridge_plan.json'),
    });
  }
  const port = await sidecar.start();
  console.log(`[dst-sidecar] 宿主面 http://127.0.0.1:${port}（/state · /act · /action_status · /cancel · /health）`);
  console.log(`[dst-sidecar] 游戏面 http://127.0.0.1:${port}/v1/tick（Klei 653007 localhost 通道）`);

  let game: DstServerProcess | null = null;
  if (process.env.DST_AUTOSTART === '1') {
    game = new DstServerProcess({
      clusterDir: process.env.DST_CLUSTER_DIR ?? '',
      binary: process.env.DST_BINARY,
      log: (line) => console.log(`[dst-server] ${line}`),
    });
    game.start();
  }

  const shutdown = () => {
    void (async () => {
      await game?.stop();
      await sidecar.close();
      process.exit(0);
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
