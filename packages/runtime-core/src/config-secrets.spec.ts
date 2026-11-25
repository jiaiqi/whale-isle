import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultRuntimeConfig,
  JsonFileConfigStore,
  maskSecret,
  MemoryConfigStore,
  MemorySecretVault,
  RuntimeConfigSchema,
  WhaleError,
} from './index';

describe('ConfigStore & SecretVaultPort', () => {
  it('validates updates, notifies listeners, and resets in MemoryConfigStore', () => {
    const store = new MemoryConfigStore(RuntimeConfigSchema, createDefaultRuntimeConfig(), {
      theme: 'dark',
    });
    expect(store.get().theme).toBe('dark');

    const listener = vi.fn();
    const unsub = store.onChange(listener);
    const updated = store.update({ logLevel: 'debug', voiceEnabled: false });
    expect(updated.logLevel).toBe('debug');
    expect(listener).toHaveBeenCalledTimes(1);

    expect(() => store.update({ theme: 'invalid' as never })).toThrow(WhaleError);
    unsub();
    const reset = store.reset();
    expect(reset.theme).toBe('system');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('persists atomically and falls back safely on corrupt JSON in JsonFileConfigStore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-rc-cfg-'));
    try {
      const file = join(dir, 'nested', 'config.json');
      const defaults = createDefaultRuntimeConfig();
      const s1 = new JsonFileConfigStore(file, RuntimeConfigSchema, defaults);
      expect(s1.get().activeCharacterId).toBe('char_xiaojing');

      const onChange = vi.fn();
      const unsub = s1.onChange(onChange);
      s1.update({ theme: 'light' });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(() => s1.update({ activeCharacterId: '' })).toThrow(WhaleError);

      const s2 = new JsonFileConfigStore(file, RuntimeConfigSchema, defaults);
      expect(s2.get().theme).toBe('light');

      s1.reset();
      expect(s1.get().theme).toBe('system');
      unsub();

      writeFileSync(file, '{corrupt json', 'utf8');
      const s3 = new JsonFileConfigStore(file, RuntimeConfigSchema, defaults);
      expect(s3.get().theme).toBe('system');

      writeFileSync(file, JSON.stringify({ theme: 'bad-enum' }), 'utf8');
      const s4 = new JsonFileConfigStore(file, RuntimeConfigSchema, defaults);
      expect(s4.get().theme).toBe('system');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('masks secrets and never exposes plaintext in MemorySecretVault status', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('short')).toBe('••••••••');
    expect(maskSecret('1234567890abcdef')).toBe('1234••••••••cdef');

    const vault = new MemorySecretVault();
    expect(vault.backend()).toBe('memory');
    expect(vault.set(' ', 'abc').ok).toBe(false);
    expect(vault.mask('missing')).toBeNull();
    expect(vault.resolve('missing')).toBeNull();

    const secret = ['tok', 'alpha', '987654321'].join('_');
    const res = vault.set('deepseek', secret);
    expect(res.ok).toBe(true);
    expect(vault.has('deepseek')).toBe(true);
    expect(vault.mask('deepseek')).toBe('tok_••••••••4321');
    expect(vault.resolve('deepseek')).toBe(secret);

    const status = vault.getStatus(['deepseek', 'missing']);
    expect(status.storedIds).toEqual([{ id: 'deepseek', mask: 'tok_••••••••4321' }]);
    expect(JSON.stringify(vault.getStatus())).not.toContain(secret);

    expect(vault.delete('deepseek')).toBe(true);
    expect(vault.has('deepseek')).toBe(false);
  });
});
