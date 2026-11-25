import { describe, expect, it, vi } from 'vitest';
import {
  normalizeError,
  redactLogData,
  redactSensitiveText,
  sanitizeErrorContext,
  StructuredLogger,
  WhaleError,
} from './index';

describe('errors & structured logger', () => {
  it('sanitizes sensitive error context and converts non-errors cleanly', () => {
    const deep: Record<string, unknown> = {
      apiKey: 'secret-value-1',
      nested: {
        token: 'secret-token',
        safe: 42,
        arr: [true, null, undefined, Symbol('x'), { a: { b: { c: { d: 'too-deep' } } } }],
      },
    };
    const sanitized = sanitizeErrorContext(deep) as Record<string, unknown>;
    expect(sanitized.apiKey).toBe('{{MASKED}}');
    const nested = sanitized.nested as Record<string, unknown>;
    expect(nested.token).toBe('{{MASKED}}');
    expect(nested.safe).toBe(42);
    expect(JSON.stringify(nested.arr)).toContain('[TRUNCATED]');

    const cause = new Error('boom');
    const err = new WhaleError('PLUGIN_FAILED', '插件失败', {
      recoverable: false,
      cause,
      context: { password: 'pw', ok: 'yes' },
    });
    expect(err.toSafeJSON()).toEqual({
      name: 'WhaleError',
      code: 'PLUGIN_FAILED',
      message: '插件失败',
      recoverable: false,
      context: { password: '{{MASKED}}', ok: 'yes' },
    });
    expect(new WhaleError('INTERNAL_ERROR', 'minimal').toSafeJSON().context).toBeUndefined();
    expect(normalizeError(err)).toBe(err);
    expect(normalizeError(cause, 'CONFIG_INVALID').code).toBe('CONFIG_INVALID');
    expect(normalizeError('raw string').message).toBe('raw string');
  });

  it('logs with levels, child scopes, ring buffer eviction, redaction, and sink isolation', () => {
    const sink = vi.fn(() => {
      throw new Error('sink failed');
    });
    let tick = 1000;
    const logger = new StructuredLogger('kernel', {
      minLevel: 'warn',
      maxEntries: 10,
      sink,
      now: () => ++tick,
    });
    expect(logger.getMinLevel()).toBe('warn');

    logger.debug('ignored-debug');
    logger.info('ignored-info');
    expect(logger.recent()).toHaveLength(0);

    logger.setMinLevel('debug');
    const fakePrefix = 'sk';
    const fakeToken = `${fakePrefix}-abcdefghijkl123456`;
    const child = logger.child('gateway');
    child.debug('dbg', { msg: `Bearer ${fakeToken}`, list: [fakeToken, 1] });
    child.info(`raw ${fakeToken}`);
    child.warn('warned');
    child.error('errored', { authorization: fakeToken });

    expect(sink).toHaveBeenCalledTimes(4);
    const logs = logger.recent(10);
    expect(logs).toHaveLength(4);
    expect(logs[0]?.scope).toBe('kernel:gateway');
    expect(JSON.stringify(logs)).not.toContain(fakeToken);
    expect(redactSensitiveText(`use ${fakeToken}`)).toBe('use {{MASKED}}');
    expect(redactLogData({ arr: [fakeToken] })).toEqual({ arr: ['{{MASKED}}'] });

    expect(logger.recent(10, 'error')).toHaveLength(1);
    for (let i = 0; i < 15; i += 1) {
      logger.info(`spam-${i}`);
    }
    expect(logger.recent(50)).toHaveLength(10);
    logger.clear();
    expect(logger.recent()).toHaveLength(0);
  });
});
