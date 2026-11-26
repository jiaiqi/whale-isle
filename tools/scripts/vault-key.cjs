/**
 * 凭据库取值助手（Electron 进程内，仅开发/基准用）。
 *
 * 为什么必须是 Electron：Key 由 safeStorage 加密，解密只能在 Electron 主进程里做。
 * 本脚本把指定 providerId 的明文写到 **stdout**，由父进程（bench）直接读入内存，
 * 不落盘、不写日志、不打印到终端。父进程必须用管道读，且不得把 stdout 转发到任何日志。
 *
 * 本机现状（2026-11-27 实测）：`Whale Isle/provider-vault.json` 里由**开发态 Electron 身份**
 * 写入的条目（含 `mimo-tts` / `openrouter`）只有以默认 Electron 身份启动才能解开；
 * 用 `app.setName('鲸屿')` 会换到另一把钥匙，解不开。所以本脚本**不要**改名。
 *
 * 用法（父进程）：`electron tools/scripts/vault-key.mjs mimo-tts openrouter`
 * 输出：`{"mimo-tts":"sk-…","openrouter":"sk-or-…"}`；取不到的键为 null，原因写 stderr。
 */
const { app, safeStorage } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const VAULT =
  process.env.WHALE_VAULT_PATH ??
  join(homedir(), 'Library', 'Application Support', 'Whale Isle', 'provider-vault.json');

const ids = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.cjs'));

app.whenReady().then(() => {
  const out = {};
  try {
    const file = JSON.parse(readFileSync(VAULT, 'utf8'));
    const entries = file.entries ?? file.providers ?? file;
    for (const id of ids) {
      const entry = entries[id];
      if (entry === undefined) {
        out[id] = null;
        process.stderr.write(`vault-key: 凭据库没有 ${id}\n`);
        continue;
      }
      try {
        out[id] = safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'));
      } catch (error) {
        out[id] = null;
        process.stderr.write(`vault-key: ${id} 解密失败（写入身份与当前 Electron 身份不一致）：${error.message}\n`);
      }
    }
  } catch (error) {
    for (const id of ids) out[id] = null;
    process.stderr.write(`vault-key: 读取凭据库失败：${error.message}\n`);
  }
  process.stdout.write(JSON.stringify(out));
  app.quit();
});
