/**
 * V2-P3-03 受控 Browser Use、Computer Use 与多账号安全隔离（REQ-SEC-02 / REQ-AUTO-01）：
 * - AccountVault：按 characterId 物理隔离社交账号凭据，依托 SecretVaultPort（Keychain/safeStorage）加密存取，永不下行/导出明文
 * - BrowserProfileMgr：每 (characterId, accountId) 独立目录存放 Cookie 与 Storage，严禁跨角色读取或混用用户日常浏览器
 * - ComputerUseLeaseManager：设备级（host-primary）唯一前台控制租约，物理键鼠输入瞬间抢占，超时/急停自动撤回
 * - BrowserRuntime：确定性脚本（DOM/API/Accessibility）优先于视觉 GUI；遇验证码/反自动化/P5 风险操作立即暂停交还人类
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  AccountVaultEntrySchema,
  BrowserComputerSnapshotSchema,
  BrowserHumanHandoffSchema,
  BrowserProfileSchema,
  BrowserTaskOutcomeSchema,
  BrowserTaskRequestSchema,
  ComputerUseLeaseSchema,
  type AccountVaultEntry,
  type BrowserComputerSnapshot,
  type BrowserHumanHandoff,
  type BrowserPauseReason,
  type BrowserProfile,
  type BrowserStrategy,
  type BrowserTaskOutcome,
  type BrowserTaskRequest,
  type BrowserTaskRequestInput,
  type ComputerInputExecutorStatus,
  type ComputerUseLease,
  type HumanInputMonitorStatus,
  type PermissionRiskLevel,
} from '@workbench/shared-protocol';
import { MemorySecretVault, maskSecret, type SecretVaultPort } from './config-secrets';
import type { RuntimeEventBus } from './event-bus';
import { DeterministicBrowserRunner, detectBotGate } from './browser-runner';
import type { ComputerInputExecutor } from './input-executor';
import type { HumanInputMonitor } from './human-input-monitor';

function sanitizeSegment(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]/gu, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new Error(`非法路径段：${raw}`);
  }
  return cleaned;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

function readJsonArray(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const P5_ACTIONS = new Set<BrowserTaskRequest['action']>(['payment', 'delete']);
const P5_RISK_LEVELS = new Set<PermissionRiskLevel>(['P5']);
const P5_CONFIRM_TTL_MS = 120_000;


export class AccountVault {
  private readonly entries = new Map<string, AccountVaultEntry>();
  private readonly now: () => number;
  private readonly filePath: string | null;

  constructor(
    private readonly secrets: SecretVaultPort = new MemorySecretVault(),
    options: { now?: () => number; filePath?: string } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.filePath = options.filePath ? resolve(options.filePath) : null;
    this.loadPersisted();
  }

  private loadPersisted(): void {
    if (!this.filePath) return;
    for (const raw of readJsonArray(this.filePath)) {
      const parsed = AccountVaultEntrySchema.safeParse(raw);
      if (!parsed.success) continue;
      // 明文密钥只在 SecretVaultPort 内；这里按库中实际掩码重建，绝不把掩码写回磁盘
      const masked = this.secrets.mask(parsed.data.vaultKeyId) ?? '';
      this.entries.set(parsed.data.accountId, { ...parsed.data, maskedSecret: masked });
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const rows = [...this.entries.values()].map((entry) => ({ ...entry, maskedSecret: '' }));
    writeJsonAtomic(this.filePath, rows);
  }

  registerAccount(input: {
    accountId?: string;
    characterId: string;
    platform: string;
    username: string;
    plainSecret: string;
    expiresAt?: number | null;
  }): { ok: boolean; entry?: AccountVaultEntry; error?: string } {
    const charId = input.characterId.trim();
    const platform = input.platform.trim();
    const username = input.username.trim();
    const secret = input.plainSecret.trim();
    if (charId === '' || platform === '' || username === '' || secret === '') {
      return { ok: false, error: 'characterId / platform / username / secret 均不能为空' };
    }
    const accountId = input.accountId?.trim() || `acct-${sanitizeSegment(charId)}-${sanitizeSegment(platform)}`;
    const vaultKeyId = `account:${sanitizeSegment(charId)}:${sanitizeSegment(platform)}:${sanitizeSegment(accountId)}`;
    const stored = this.secrets.set(vaultKeyId, secret);
    if (!stored.ok) {
      return { ok: false, error: stored.error ?? '凭据写入失败' };
    }

    const entry = AccountVaultEntrySchema.parse({
      accountId,
      characterId: charId,
      platform,
      username,
      vaultKeyId,
      maskedSecret: stored.mask ?? maskSecret(secret),
      active: true,
      expiresAt: input.expiresAt ?? null,
      rotatedAt: this.now(),
    });
    this.entries.set(accountId, entry);
    this.persist();
    return { ok: true, entry };
  }

  rotateSecret(accountId: string, newPlainSecret: string): { ok: boolean; entry?: AccountVaultEntry; error?: string } {
    const existing = this.entries.get(accountId);
    if (!existing) return { ok: false, error: `未找到账号 ${accountId}` };
    const secret = newPlainSecret.trim();
    if (secret === '') return { ok: false, error: '新凭据不能为空' };
    const stored = this.secrets.set(existing.vaultKeyId, secret);
    if (!stored.ok) return { ok: false, error: stored.error ?? '轮换写入失败' };
    const updated = {
      ...existing,
      active: true,
      maskedSecret: stored.mask ?? maskSecret(secret),
      rotatedAt: this.now(),
    };
    this.entries.set(accountId, updated);
    this.persist();
    return { ok: true, entry: updated };
  }

  revokeAccount(accountId: string): boolean {
    const existing = this.entries.get(accountId);
    if (!existing) return false;
    this.secrets.delete(existing.vaultKeyId);
    this.entries.set(accountId, { ...existing, active: false, maskedSecret: '' });
    this.persist();
    return true;
  }

  /** 删除角色时级联吊销其全部社交凭据（审计条目由租约管理器保留） */
  deleteCharacter(characterId: string): number {
    let removed = 0;
    for (const [accountId, entry] of [...this.entries.entries()]) {
      if (entry.characterId !== characterId) continue;
      this.secrets.delete(entry.vaultKeyId);
      this.entries.delete(accountId);
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** 仅允许主进程代表所属 characterId 解析短期使用凭据；跨角色或过期/撤销一律拒斥 */
  resolveScopedToken(accountId: string, requestingCharacterId: string): string | null {
    const existing = this.entries.get(accountId);
    if (!existing || !existing.active) return null;
    if (existing.characterId !== requestingCharacterId) return null;
    if (existing.expiresAt !== null && this.now() >= existing.expiresAt) return null;
    return this.secrets.resolve(existing.vaultKeyId);
  }

  getEntry(accountId: string): AccountVaultEntry | null {
    return this.entries.get(accountId) ?? null;
  }

  listAccounts(characterId?: string): AccountVaultEntry[] {
    const all = [...this.entries.values()];
    return characterId ? all.filter((e) => e.characterId === characterId) : all;
  }

  /** 导出配置：强制仅包含脱敏摘要，零明文密钥、零 Cookie */
  exportPublicConfig(): { exportedAt: number; accounts: AccountVaultEntry[]; secretsRedacted: true } {
    return {
      exportedAt: this.now(),
      accounts: this.listAccounts(),
      secretsRedacted: true,
    };
  }
}

export class BrowserProfileMgr {
  private readonly rootDir: string;
  private readonly indexFile: string;
  private readonly profiles = new Map<string, BrowserProfile>();
  private readonly now: () => number;

  constructor(options: { rootDir: string; indexFile?: string; now?: () => number }) {
    this.rootDir = resolve(options.rootDir);
    this.indexFile = resolve(options.indexFile ?? join(this.rootDir, 'profiles.json'));
    this.now = options.now ?? Date.now;
    mkdirSync(this.rootDir, { recursive: true });
    this.loadPersisted();
  }

  private loadPersisted(): void {
    for (const raw of readJsonArray(this.indexFile)) {
      const parsed = BrowserProfileSchema.safeParse(raw);
      if (!parsed.success) continue;
      const dir = resolve(parsed.data.profileDir);
      // 只接受根目录内的 Profile，杜绝索引被篡改后指向用户日常浏览器目录
      if (!dir.startsWith(`${this.rootDir}${sep}`)) continue;
      if (!existsSync(dir)) continue;
      this.profiles.set(parsed.data.profileId, { ...parsed.data, profileDir: dir });
    }
  }

  private persist(): void {
    writeJsonAtomic(this.indexFile, [...this.profiles.values()]);
  }

  createOrGetProfile(input: {
    profileId?: string;
    characterId: string;
    accountId: string;
    accountVault?: AccountVault;
  }): { ok: boolean; profile?: BrowserProfile; error?: string } {
    const charId = input.characterId.trim();
    const accountId = input.accountId.trim();
    if (charId === '' || accountId === '') {
      return { ok: false, error: 'characterId 与 accountId 均不能为空' };
    }
    if (input.accountVault) {
      const acct = input.accountVault.getEntry(accountId);
      if (acct && acct.characterId !== charId) {
        return { ok: false, error: `PROFILE_ISOLATION_VIOLATION: 账号 ${accountId} 属于 ${acct.characterId}，禁止绑定到 ${charId}` };
      }
    }

    const safeChar = sanitizeSegment(charId);
    const safeAcct = sanitizeSegment(accountId);
    const profileDir = resolve(join(this.rootDir, safeChar, safeAcct));
    if (!profileDir.startsWith(`${this.rootDir}${sep}`)) {
      return { ok: false, error: '非法 Profile 路径越界' };
    }
    const profileId = input.profileId?.trim() || `bp-${safeChar}-${safeAcct}`;
    const existing = this.profiles.get(profileId);
    if (existing) {
      if (existing.characterId !== charId) {
        return { ok: false, error: `PROFILE_ISOLATION_VIOLATION: Profile ${profileId} 归属 ${existing.characterId}` };
      }
      return { ok: true, profile: existing };
    }

    mkdirSync(profileDir, { recursive: true });
    const cookiesFile = join(profileDir, 'cookies.json');
    if (!existsSync(cookiesFile)) {
      writeFileSync(cookiesFile, '{}\n', 'utf8');
    }
    const profile = BrowserProfileSchema.parse({
      profileId,
      characterId: charId,
      accountId,
      profileDir,
      isolatedFromUserDaily: true,
      loggedInOrigins: [],
      cookieCount: 0,
      status: 'ready',
      updatedAt: this.now(),
    });
    this.profiles.set(profileId, profile);
    this.persist();
    return { ok: true, profile };
  }

  setOriginCookie(
    profileId: string,
    requestingCharacterId: string,
    origin: string,
    cookieKey: string,
    cookieVal: string,
  ): { ok: boolean; error?: string; profile?: BrowserProfile } {
    const profile = this.profiles.get(profileId);
    if (!profile) return { ok: false, error: `未知 Profile：${profileId}` };
    if (profile.characterId !== requestingCharacterId) {
      return { ok: false, error: `PROFILE_ISOLATION_VIOLATION: 拒绝 ${requestingCharacterId} 写入 ${profile.characterId} 的 Cookie` };
    }
    if (profile.status === 'revoked') {
      return { ok: false, error: 'Profile 已被吊销' };
    }

    const store = this.readCookieStore(profile.profileDir);
    const bucket = store[origin] ?? {};
    bucket[cookieKey] = cookieVal;
    store[origin] = bucket;
    const cookiesFile = join(profile.profileDir, 'cookies.json');
    const tmpFile = `${cookiesFile}.tmp`;
    writeFileSync(tmpFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(tmpFile, cookiesFile);

    const origins = Object.keys(store);
    const cookieCount = origins.reduce((acc, org) => acc + Object.keys(store[org] ?? {}).length, 0);
    const updated: BrowserProfile = {
      ...profile,
      loggedInOrigins: origins,
      cookieCount,
      updatedAt: this.now(),
    };
    this.profiles.set(profileId, updated);
    this.persist();
    return { ok: true, profile: updated };
  }

  readCookies(
    profileId: string,
    requestingCharacterId: string,
  ): { ok: boolean; error?: string; cookies?: Record<string, Record<string, string>> } {
    const profile = this.profiles.get(profileId);
    if (!profile) return { ok: false, error: `未知 Profile：${profileId}` };
    if (profile.characterId !== requestingCharacterId) {
      return { ok: false, error: `PROFILE_ISOLATION_VIOLATION: 拒绝 ${requestingCharacterId} 读取 ${profile.characterId} 的 Cookie` };
    }
    return { ok: true, cookies: this.readCookieStore(profile.profileDir) };
  }

  markStatus(profileId: string, status: BrowserProfile['status']): BrowserProfile | null {
    const profile = this.profiles.get(profileId);
    if (!profile) return null;
    const updated: BrowserProfile = { ...profile, status, updatedAt: this.now() };
    this.profiles.set(profileId, updated);
    this.persist();
    return updated;
  }

  /** 删除角色时级联清理其全部 Profile 目录（Cookie 与 Storage 一并真删除） */
  deleteCharacterProfiles(characterId: string): number {
    let removed = 0;
    for (const [profileId, profile] of [...this.profiles.entries()]) {
      if (profile.characterId !== characterId) continue;
      this.profiles.delete(profileId);
      const dir = resolve(profile.profileDir);
      if (dir.startsWith(`${this.rootDir}${sep}`)) {
        rmSync(dir, { recursive: true, force: true });
      }
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }

  getProfile(profileId: string): BrowserProfile | null {
    return this.profiles.get(profileId) ?? null;
  }

  listProfiles(characterId?: string): BrowserProfile[] {
    const all = [...this.profiles.values()];
    return characterId ? all.filter((p) => p.characterId === characterId) : all;
  }

  private readCookieStore(profileDir: string): Record<string, Record<string, string>> {
    const file = join(profileDir, 'cookies.json');
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
    } catch {
      return {};
    }
  }
}

export interface LeaseAuditEntry {
  at: number;
  deviceId: string;
  action: string;
  holderId: string;
  detail: string;
}

export class ComputerUseLeaseManager {
  private readonly activeByDevice = new Map<string, ComputerUseLease>();
  private readonly humanOverrideUntil = new Map<string, number>();
  private readonly audits: LeaseAuditEntry[] = [];
  private halted = false;
  private readonly now: () => number;
  private readonly events: RuntimeEventBus | undefined;
  private readonly humanOverrideHoldMs: number;

  constructor(options: { events?: RuntimeEventBus; now?: () => number; humanOverrideHoldMs?: number } = {}) {
    this.events = options.events;
    this.now = options.now ?? Date.now;
    this.humanOverrideHoldMs = Math.max(0, Math.round(options.humanOverrideHoldMs ?? 2_000));
  }

  acquireLease(input: {
    deviceId?: string;
    holderId: string;
    characterId: string;
    purpose: string;
    ttlMs?: number;
  }): { ok: boolean; reason?: string; lease?: ComputerUseLease; currentHolder?: ComputerUseLease } {
    const deviceId = input.deviceId?.trim() || 'host-primary';
    const ts = this.now();
    this.expireStale(deviceId, ts);
    this.expireHumanOverride(deviceId, ts);

    if (this.halted) {
      return { ok: false, reason: 'EMERGENCY_HALT_ACTIVE' };
    }
    if (this.humanOverrideUntil.has(deviceId)) {
      return { ok: false, reason: 'DEVICE_HELD_BY_HUMAN' };
    }

    const existing = this.activeByDevice.get(deviceId);
    const ttlMs = Math.max(1_000, Math.min(300_000, Math.round(input.ttlMs ?? 30_000)));
    if (existing) {
      if (existing.holderId === input.holderId) {
        const extended: ComputerUseLease = {
          ...existing,
          lastHeartbeatAt: ts,
          expiresAt: ts + ttlMs,
          purpose: input.purpose,
        };
        this.activeByDevice.set(deviceId, extended);
        return { ok: true, lease: extended };
      }
      this.recordAudit(deviceId, 'acquire_denied', input.holderId, `当前由 ${existing.holderId} 持有`);
      return { ok: false, reason: 'DEVICE_LEASE_BUSY', currentHolder: existing };
    }

    const lease = ComputerUseLeaseSchema.parse({
      leaseId: `cu-${randomUUID().slice(0, 8)}`,
      deviceId,
      holderId: input.holderId,
      holderKind: 'agent',
      characterId: input.characterId,
      controlOwner: 'ai',
      purpose: input.purpose,
      acquiredAt: ts,
      expiresAt: ts + ttlMs,
      lastHeartbeatAt: ts,
      status: 'active',
    });
    this.activeByDevice.set(deviceId, lease);
    this.recordAudit(deviceId, 'acquire', input.holderId, input.purpose);
    return { ok: true, lease };
  }

  heartbeat(leaseId: string, ttlMs = 30_000): { ok: boolean; lease?: ComputerUseLease; reason?: string } {
    const ts = this.now();
    for (const [deviceId, lease] of this.activeByDevice.entries()) {
      if (lease.leaseId !== leaseId) continue;
      if (ts >= lease.expiresAt) {
        this.expireStale(deviceId, ts);
        return { ok: false, reason: 'LEASE_EXPIRED' };
      }
      const next: ComputerUseLease = {
        ...lease,
        lastHeartbeatAt: ts,
        expiresAt: ts + Math.max(1_000, Math.min(300_000, Math.round(ttlMs))),
      };
      this.activeByDevice.set(deviceId, next);
      return { ok: true, lease: next };
    }
    return { ok: false, reason: 'LEASE_NOT_FOUND' };
  }

  releaseLease(leaseId: string, holderId?: string): boolean {
    for (const [deviceId, lease] of this.activeByDevice.entries()) {
      if (lease.leaseId !== leaseId) continue;
      if (holderId !== undefined && lease.holderId !== holderId) return false;
      this.activeByDevice.delete(deviceId);
      this.recordAudit(deviceId, 'release', lease.holderId, '主动归还租约');
      return true;
    }
    return false;
  }

  /** 用户物理键鼠输入瞬间抢占同一设备的 AI 控制权；override 在 holdMs 无新输入后自动失效 */
  notifyHumanInput(
    deviceId = 'host-primary',
    reason = '物理键鼠输入',
    holdMs = this.humanOverrideHoldMs,
  ): { preemptedLease: ComputerUseLease | null } {
    const ts = this.now();
    const wasOverridden = this.humanOverrideUntil.has(deviceId);
    this.humanOverrideUntil.set(deviceId, ts + Math.max(0, Math.round(holdMs)));
    const active = this.activeByDevice.get(deviceId) ?? null;
    if (active) {
      this.activeByDevice.delete(deviceId);
      const preempted: ComputerUseLease = {
        ...active,
        controlOwner: 'human',
        status: 'preempted_by_human',
      };
      this.recordAudit(deviceId, 'preempt_human', active.holderId, reason);
      this.events?.publish('automation:lease-preempted', {
        deviceId,
        leaseId: preempted.leaseId,
        holderId: preempted.holderId,
        reason,
      }, { source: 'computer-use-lease', characterId: preempted.characterId });
      return { preemptedLease: preempted };
    }
    if (!wasOverridden) this.recordAudit(deviceId, 'human_override_set', 'human', reason);
    return { preemptedLease: null };
  }

  releaseHumanOverride(deviceId = 'host-primary'): void {
    if (!this.humanOverrideUntil.delete(deviceId)) return;
    this.recordAudit(deviceId, 'human_override_clear', 'human', '用户交回设备租约资格');
  }

  emergencyHalt(reason = 'emergency_halt'): number {
    this.halted = true;
    const count = this.activeByDevice.size;
    for (const [deviceId, lease] of this.activeByDevice.entries()) {
      this.recordAudit(deviceId, 'halt_revoke', lease.holderId, reason);
    }
    this.activeByDevice.clear();
    this.humanOverrideUntil.clear();
    return count;
  }

  resumeFromHalt(): void {
    this.halted = false;
  }

  isHalted(): boolean {
    return this.halted;
  }

  listActive(): ComputerUseLease[] {
    const ts = this.now();
    for (const deviceId of [...this.activeByDevice.keys()]) {
      this.expireStale(deviceId, ts);
    }
    return [...this.activeByDevice.values()];
  }

  listHumanOverrides(): string[] {
    const ts = this.now();
    for (const deviceId of [...this.humanOverrideUntil.keys()]) {
      this.expireHumanOverride(deviceId, ts);
    }
    return [...this.humanOverrideUntil.keys()];
  }

  /** 每个原子动作执行前重新校验：租约存在、未过期、未急停、未被人类抢占 */
  validateLease(leaseId: string, characterId?: string): {
    ok: boolean;
    reason?: 'LEASE_NOT_FOUND' | 'LEASE_EXPIRED' | 'EMERGENCY_HALT_ACTIVE' | 'DEVICE_HELD_BY_HUMAN' | 'LEASE_CHARACTER_MISMATCH';
    lease?: ComputerUseLease;
  } {
    if (this.halted) return { ok: false, reason: 'EMERGENCY_HALT_ACTIVE' };
    const ts = this.now();
    for (const [deviceId, lease] of this.activeByDevice.entries()) {
      if (lease.leaseId !== leaseId) continue;
      if (characterId !== undefined && lease.characterId !== characterId) {
        return { ok: false, reason: 'LEASE_CHARACTER_MISMATCH' };
      }
      this.expireHumanOverride(deviceId, ts);
      if (this.humanOverrideUntil.has(deviceId)) return { ok: false, reason: 'DEVICE_HELD_BY_HUMAN' };
      if (ts >= lease.expiresAt) {
        this.expireStale(deviceId, ts);
        return { ok: false, reason: 'LEASE_EXPIRED' };
      }
      return { ok: true, lease };
    }
    return { ok: false, reason: 'LEASE_NOT_FOUND' };
  }

  isLeaseActive(leaseId: string): boolean {
    return this.validateLease(leaseId).ok;
  }

  getLease(leaseId: string): ComputerUseLease | null {
    return this.validateLease(leaseId).lease ?? null;
  }

  auditCount(): number {
    return this.audits.length;
  }

  private expireStale(deviceId: string, nowMs: number): void {
    const lease = this.activeByDevice.get(deviceId);
    if (lease && nowMs >= lease.expiresAt) {
      this.activeByDevice.delete(deviceId);
      this.recordAudit(deviceId, 'expire', lease.holderId, 'TTL 超时释放');
    }
  }

  private expireHumanOverride(deviceId: string, nowMs: number): void {
    const until = this.humanOverrideUntil.get(deviceId);
    if (until !== undefined && nowMs >= until) {
      this.humanOverrideUntil.delete(deviceId);
      this.recordAudit(deviceId, 'human_override_clear', 'human', '人类输入停止，租约资格自动恢复');
    }
  }

  private recordAudit(deviceId: string, action: string, holderId: string, detail: string): void {
    this.audits.push({ at: this.now(), deviceId, action, holderId, detail });
    if (this.audits.length > 200) this.audits.shift();
  }
}

export class BrowserRuntime {
  private readonly handoffs = new Map<string, BrowserHumanHandoff>();
  private readonly p5Confirmations = new Map<string, { taskId: string; action: string; url: string; expiresAt: number }>();
  private readonly runner: DeterministicBrowserRunner | null;
  private readonly executor: ComputerInputExecutor | null;
  private readonly monitor: HumanInputMonitor | null;
  private readonly now: () => number;

  constructor(
    readonly profiles: BrowserProfileMgr,
    readonly leases: ComputerUseLeaseManager,
    options: {
      runner?: DeterministicBrowserRunner;
      executor?: ComputerInputExecutor;
      monitor?: HumanInputMonitor;
      now?: () => number;
    } = {},
  ) {
    this.runner = options.runner ?? null;
    this.executor = options.executor ?? null;
    this.monitor = options.monitor ?? null;
    this.now = options.now ?? Date.now;
  }

  chooseStrategy(req: BrowserTaskRequest): BrowserStrategy {
    if (req.selector) return 'deterministic_dom';
    if (req.preferDeterministic) {
      return req.action === 'read' ? 'http_api' : 'deterministic_dom';
    }
    return 'vision_gui';
  }

  /** 签发一次性的 P5 确认令牌；只能由用户在主进程显式操作时调用 */
  issueP5Confirmation(input: { taskId: string; action: string; url: string }): {
    ok: boolean;
    token?: string;
    expiresAt?: number;
    error?: string;
  } {
    if (input.taskId.trim() === '' || input.url.trim() === '') {
      return { ok: false, error: 'taskId 与 url 不能为空' };
    }
    const token = `p5-${randomUUID()}`;
    const expiresAt = this.now() + P5_CONFIRM_TTL_MS;
    this.p5Confirmations.set(token, {
      taskId: input.taskId,
      action: input.action,
      url: input.url,
      expiresAt,
    });
    return { ok: true, token, expiresAt };
  }

  listP5Confirmations(): number {
    const ts = this.now();
    for (const [token, record] of [...this.p5Confirmations.entries()]) {
      if (ts >= record.expiresAt) this.p5Confirmations.delete(token);
    }
    return this.p5Confirmations.size;
  }

  private consumeP5Confirmation(req: BrowserTaskRequest): boolean {
    const token = req.confirmToken;
    if (!token) return false;
    const record = this.p5Confirmations.get(token);
    if (!record) return false;
    if (this.now() >= record.expiresAt) {
      this.p5Confirmations.delete(token);
      return false;
    }
    if (record.taskId !== req.taskId || record.action !== req.action || record.url !== req.url) return false;
    this.p5Confirmations.delete(token);
    return true;
  }

  inspectSafetyGate(req: BrowserTaskRequest): {
    allowed: boolean;
    pauseReason: BrowserPauseReason;
    requiresHumanHandoff: boolean;
    detail: string;
  } {
    if (this.leases.isHalted()) {
      return { allowed: false, pauseReason: 'emergency_halt', requiresHumanHandoff: true, detail: '系统处于急停状态' };
    }
    const gate = detectBotGate([req.url, ...req.pageHints].join(' '));
    if (gate) {
      return { allowed: false, pauseReason: gate.reason, requiresHumanHandoff: true, detail: gate.detail };
    }
    const needsP5 = P5_RISK_LEVELS.has(req.riskLevel) || P5_ACTIONS.has(req.action);
    if (needsP5) {
      const confirmed = this.consumeP5Confirmation(req);
      if (!confirmed) {
        return {
          allowed: false,
          pauseReason: 'p5_explicit_confirm',
          requiresHumanHandoff: true,
          detail: 'P5 高危操作（支付/删除/安全变更）必须获得用户当次一次性确认令牌，boolean 标记不足以放行',
        };
      }
    }
    if ((req.riskLevel === 'P4' || req.action === 'publish') && !req.hasP4Approval) {
      return {
        allowed: false,
        pauseReason: 'p4_approval_required',
        requiresHumanHandoff: true,
        detail: 'P4 对外发布/互动操作需经用户审批通过',
      };
    }
    return { allowed: true, pauseReason: 'none', requiresHumanHandoff: false, detail: '通过策略门禁' };
  }

  async executeTask(rawRequest: BrowserTaskRequestInput): Promise<BrowserTaskOutcome> {
    const req = BrowserTaskRequestSchema.parse(rawRequest);
    const strategyUsed = this.chooseStrategy(req);
    const profile = this.profiles.getProfile(req.profileId);

    if (!profile || profile.characterId !== req.characterId) {
      return this.outcome(req, strategyUsed, {
        ok: false,
        pauseReason: 'profile_isolation_violation',
        requiresHumanHandoff: true,
        detail: `Profile ${req.profileId} 不存在或不属于角色 ${req.characterId}（严格隔离）`,
        profileDir: '',
      });
    }

    const gate = this.inspectSafetyGate(req);
    if (!gate.allowed) {
      const handoff =
        gate.pauseReason === 'captcha_required' || gate.pauseReason === 'anti_bot_gate' || gate.pauseReason === 'login_required'
          ? this.ensureHandoff(req, profile, gate.pauseReason, gate.detail)
          : null;
      return this.outcome(req, strategyUsed, {
        ok: false,
        pauseReason: gate.pauseReason,
        requiresHumanHandoff: true,
        detail: gate.detail,
        profileDir: profile.profileDir,
        ...(handoff ? { handoff } : {}),
      });
    }

    let acquiredLeaseId: string | null = null;
    if (strategyUsed === 'vision_gui') {
      const leaseRes = this.leases.acquireLease({
        deviceId: req.deviceId,
        holderId: `browser:${req.taskId}`,
        characterId: req.characterId,
        purpose: `Browser vision step: ${req.action} ${req.url}`,
      });
      if (!leaseRes.ok || !leaseRes.lease) {
        return this.outcome(req, strategyUsed, {
          ok: false,
          pauseReason: 'lease_revoked',
          requiresHumanHandoff: true,
          detail: `视觉 Computer Use 未能拿到设备独占租约：${leaseRes.reason ?? 'unknown'}`,
          profileDir: profile.profileDir,
        });
      }
      acquiredLeaseId = leaseRes.lease.leaseId;
    }

    try {
      const run = await this.runDeterministic(req, profile, acquiredLeaseId);
      if (run.status === 'handoff') {
        const handoff = this.ensureHandoff(req, profile, run.pauseReason, run.detail);
        return this.outcome(req, strategyUsed, {
          ok: false,
          pauseReason: run.pauseReason,
          requiresHumanHandoff: true,
          detail: run.detail,
          profileDir: profile.profileDir,
          runner: run,
          handoff,
        });
      }
      if (run.status !== 'executed') {
        return this.outcome(req, strategyUsed, {
          ok: false,
          pauseReason: run.pauseReason,
          requiresHumanHandoff: run.status === 'blocked',
          detail: run.detail,
          profileDir: profile.profileDir,
          runner: run,
        });
      }

      this.profiles.markStatus(profile.profileId, 'active');
      return this.outcome(req, strategyUsed, {
        ok: true,
        pauseReason: 'none',
        requiresHumanHandoff: false,
        detail: run.detail,
        profileDir: profile.profileDir,
        runner: run,
      });
    } finally {
      if (acquiredLeaseId) {
        this.leases.releaseLease(acquiredLeaseId);
      }
    }
  }

  private async runDeterministic(
    req: BrowserTaskRequest,
    profile: BrowserProfile,
    leaseId: string | null,
  ): Promise<Awaited<ReturnType<DeterministicBrowserRunner['run']>>> {
    if (!this.runner) {
      return {
        engine: 'none',
        status: 'runner_unavailable',
        detail: '确定性浏览器执行器未接线：本轮不执行任何真实网页动作（PENDING）',
        stepCount: 0,
        pageTextChars: 0,
        injectionSignals: [],
        pauseReason: 'runner_unavailable',
      };
    }
    return this.runner.run(req, {
      profile,
      guard: () => {
        if (this.leases.isHalted()) return { ok: false, reason: 'EMERGENCY_HALT_ACTIVE' };
        if (leaseId) {
          const lease = this.leases.validateLease(leaseId, req.characterId);
          if (!lease.ok) return { ok: false, reason: lease.reason };
        }
        return { ok: true };
      },
    });
  }

  private outcome(
    req: BrowserTaskRequest,
    strategyUsed: BrowserStrategy,
    patch: {
      ok: boolean;
      pauseReason: BrowserPauseReason;
      requiresHumanHandoff: boolean;
      detail: string;
      profileDir: string;
      runner?: {
        engine: 'electron' | 'playwright' | 'none';
        status: 'executed' | 'plan_only' | 'runner_unavailable' | 'blocked' | 'handoff';
        detail: string;
        stepCount: number;
        pageTextChars: number;
        injectionSignals: string[];
      };
      handoff?: BrowserHumanHandoff | null;
    },
  ): BrowserTaskOutcome {
    return BrowserTaskOutcomeSchema.parse({
      ok: patch.ok,
      taskId: req.taskId,
      strategyUsed,
      pauseReason: patch.pauseReason,
      requiresHumanHandoff: patch.requiresHumanHandoff,
      detail: patch.detail,
      profileDir: patch.profileDir,
      ...(patch.runner
        ? {
            runner: {
              engine: patch.runner.engine,
              status: patch.runner.status,
              detail: patch.runner.detail,
              stepCount: patch.runner.stepCount,
              pageTextChars: patch.runner.pageTextChars,
              injectionSignals: patch.runner.injectionSignals,
            },
          }
        : {}),
      handoff: patch.handoff ?? null,
    });
  }

  private ensureHandoff(
    req: BrowserTaskRequest,
    profile: BrowserProfile,
    reason: BrowserPauseReason,
    detail: string,
  ): BrowserHumanHandoff {
    for (const handoff of this.handoffs.values()) {
      if (handoff.taskId === req.taskId && handoff.status === 'awaiting_human') return handoff;
    }
    const handoff = BrowserHumanHandoffSchema.parse({
      handoffId: `ho-${randomUUID().slice(0, 8)}`,
      taskId: req.taskId,
      characterId: req.characterId,
      profileId: profile.profileId,
      reason,
      url: req.url,
      detail,
      requestedAt: this.now(),
      completedAt: null,
      status: 'awaiting_human',
    });
    this.handoffs.set(handoff.handoffId, handoff);
    this.profiles.markStatus(profile.profileId, 'awaiting_human');
    return handoff;
  }

  listHandoffs(includeCompleted = false): BrowserHumanHandoff[] {
    const all = [...this.handoffs.values()];
    return includeCompleted ? all : all.filter((h) => h.status === 'awaiting_human');
  }

  /** 人类在隔离 Profile 内亲手完成验证码/登录后，恢复该 Profile 为可用态 */
  completeHandoff(handoffId: string, outcome: 'completed' | 'cancelled' = 'completed'): {
    ok: boolean;
    handoff?: BrowserHumanHandoff;
    error?: string;
  } {
    const handoff = this.handoffs.get(handoffId);
    if (!handoff) return { ok: false, error: `未知交接单：${handoffId}` };
    if (handoff.status !== 'awaiting_human') return { ok: false, error: '该交接单已结束' };
    const updated: BrowserHumanHandoff = {
      ...handoff,
      status: outcome,
      completedAt: this.now(),
    };
    this.handoffs.set(handoffId, updated);
    const profile = this.profiles.getProfile(handoff.profileId);
    if (profile && outcome === 'completed') this.profiles.markStatus(profile.profileId, 'ready');
    return { ok: true, handoff: updated };
  }

  /** 删除角色时级联清理账号凭据、Profile 目录与待处理交接单；租约审计条目保留 */
  deleteCharacter(accounts: AccountVault, characterId: string): { accountsRemoved: number; profilesRemoved: number } {
    const accountsRemoved = accounts.deleteCharacter(characterId);
    const profilesRemoved = this.profiles.deleteCharacterProfiles(characterId);
    for (const [id, handoff] of [...this.handoffs.entries()]) {
      if (handoff.characterId === characterId) this.handoffs.delete(id);
    }
    return { accountsRemoved, profilesRemoved };
  }

  snapshot(accounts: AccountVault): BrowserComputerSnapshot {
    return BrowserComputerSnapshotSchema.parse({
      accounts: accounts.listAccounts(),
      profiles: this.profiles.listProfiles(),
      activeLeases: this.leases.listActive(),
      humanOverrideDevices: this.leases.listHumanOverrides(),
      pendingHandoffs: this.listHandoffs(),
      inputExecutor: this.executor?.status() ?? {},
      inputMonitor: this.monitor?.status() ?? {},
      p5ConfirmationCount: this.listP5Confirmations(),
      recentAuditCount: this.leases.auditCount(),
      halted: this.leases.isHalted(),
    });
  }
}
