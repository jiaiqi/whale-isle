// 临时 E2E 调试脚本（T-M1-02，验证后删除）：观察 petStage 桥与 alpha 状态链
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const mainEntry = join(here, '../dist/main/index.js');

const app = await electron.launch({
  args: [mainEntry],
  executablePath: electronBinary,
  env: { ...process.env, PET_STAGE_E2E: '1' },
});
const win = await app.firstWindow();
await win.waitForFunction(() => Boolean((window).petStage?.ready), { timeout: 20_000 });
const bridgeShape = await win.evaluate(() => ({
  keys: Object.keys(window.petStage ?? {}),
  hasForceAlpha: typeof window.petStage?.forceAlpha,
  hasOnTestAlpha: typeof window.petStage?.onTestAlpha,
  meta: null,
}));
bridgeShape.meta = await win.evaluate(() => window.petStage?.appMeta?.());
console.log('bridge:', JSON.stringify(bridgeShape, null, 2));

if (bridgeShape.hasForceAlpha === 'function') {
  await win.evaluate(() => window.petStage.forceAlpha(255));
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 300));
    console.log(`t+${i * 300}ms state=`, await win.evaluate(() => window.petStage.getState()));
  }
}
await app.close();
