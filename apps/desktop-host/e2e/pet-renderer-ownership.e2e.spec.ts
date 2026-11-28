import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mainEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main', 'index.js');

describe('[E2E-HOST] 角色实例归属', () => {
  it('旧视频延迟完成与连续重载后仅保留一个可见角色', { timeout: 50_000 }, async () => {
    const app = await electron.launch({
      executablePath: require('electron') as string,
      args: ['--use-mock-keychain', mainEntry],
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      let stage = app.windows().find((page) => page.url().includes('pet-stage'));
      const deadline = Date.now() + 20_000;
      while (stage === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        stage = app.windows().find((page) => page.url().includes('pet-stage'));
      }
      if (stage === undefined) throw new Error('桌宠窗口未就绪');
      await stage.waitForFunction(() => Boolean((window as unknown as { __petStageTest?: object }).__petStageTest));
      const result = await stage.evaluate(async () => {
        const hooks = (window as unknown as { __petStageTest: {
          reloadCharacter(id: string): Promise<void>;
          playAction(action: string): void;
        } }).__petStageTest;
        const originalPlay = HTMLMediaElement.prototype.play;
        let release: (() => void) | undefined;
        let signalStarted: (() => void) | undefined;
        let started = new Promise<void>((resolve) => { signalStarted = resolve; });
        let pending = new Promise<void>((resolve) => { release = resolve; });
        let delayed = false;
        HTMLMediaElement.prototype.play = async function () {
          if (!delayed) {
            delayed = true;
            signalStarted?.();
            await pending;
          }
          return originalPlay.call(this);
        };
        try {
          const oldLoad = hooks.reloadCharacter('blue-whale-maid');
          await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('未观察到真实视频播放')), 10_000))]);
          await hooks.reloadCharacter('blue-whale-maid');
          release?.();
          await oldLoad;
          await Promise.all(Array.from({ length: 12 }, () => hooks.reloadCharacter('blue-whale-maid')));
          started = new Promise<void>((resolve) => { signalStarted = resolve; });
          pending = new Promise<void>((resolve) => { release = resolve; });
          delayed = false;
          hooks.playAction('game_focus');
          await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('未观察到动作切换')), 10_000))]);
          await hooks.reloadCharacter('blue-whale-maid');
          // 新角色播放中才释放旧动作，覆盖旧 finally 对新队列的影响。
          hooks.playAction('game_focus');
          release?.();
          await new Promise((resolve) => setTimeout(resolve, 500));
          const media = Array.from(document.querySelectorAll<HTMLVideoElement>('#stage video'));
          return {
            count: media.length,
            visible: media.filter((el) => Number(getComputedStyle(el).opacity) > 0).length,
            ready: media.every((el) => el.readyState >= 2 && el.videoWidth > 0),
          };
        } finally {
          release?.();
          HTMLMediaElement.prototype.play = originalPlay;
        }
      });
      expect(result).toEqual({ count: 1, visible: 1, ready: true });
    } finally {
      await app.close();
    }
  });
});
