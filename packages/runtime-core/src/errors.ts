/**
 * Whale Isle V2 统一错误模型：
 * - 结构化错误码 + 可恢复标识 + 安全脱敏序列化
 * - 严禁把密钥/Authorization 头序列化进日志或渲染层
 */

export type WhaleErrorCode =
  | 'CONFIG_INVALID'
  | 'SECRET_UNAVAILABLE'
  | 'PLUGIN_FAILED'
  | 'PERMISSION_DENIED'
  | 'CHARACTER_NOT_FOUND'
  | 'LIFECYCLE_INVALID'
  | 'RUNTIME_HALTED'
  | 'INTERNAL_ERROR';

const SENSITIVE_KEY_RE = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/i;

/** 对任意对象做键级脱敏，避免错误上下文泄漏凭据 */
export function sanitizeErrorContext(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeErrorContext(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '{{MASKED}}' : sanitizeErrorContext(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface WhaleErrorOptions {
  recoverable?: boolean;
  cause?: unknown;
  context?: Record<string, unknown>;
}

export class WhaleError extends Error {
  readonly code: WhaleErrorCode;
  readonly recoverable: boolean;
  readonly context?: Record<string, unknown>;

  constructor(code: WhaleErrorCode, message: string, options: WhaleErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WhaleError';
    this.code = code;
    this.recoverable = options.recoverable ?? true;
    if (options.context !== undefined) {
      this.context = sanitizeErrorContext(options.context) as Record<string, unknown>;
    }
  }

  toSafeJSON(): {
    name: string;
    code: WhaleErrorCode;
    message: string;
    recoverable: boolean;
    context?: Record<string, unknown>;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.context === undefined ? {} : { context: this.context }),
    };
  }
}

export function normalizeError(error: unknown, fallbackCode: WhaleErrorCode = 'INTERNAL_ERROR'): WhaleError {
  if (error instanceof WhaleError) return error;
  if (error instanceof Error) {
    return new WhaleError(fallbackCode, error.message, { cause: error, recoverable: true });
  }
  return new WhaleError(fallbackCode, String(error), { recoverable: true });
}
