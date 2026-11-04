import { BadRequestException, ConflictException, ForbiddenException, GoneException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PackageSecurityScanStatus, SkillImportDevice, UserRole, UserStatus } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { SkillImportArtifactSchema, SkillImportChallengeSchema, SkillImportConfirmDeviceSchema, SkillImportDeviceQuerySchema, SkillImportEvent, SkillImportGrantSchema, SkillImportPairingSchema, SkillImportPreviewSchema, SkillImportQuerySchema, SkillImportSelection, SkillImportSessionCreate, SkillImportSessionView, SkillImportUploadGrantSchema } from 'shared';
import { SessionService } from '../auth/session.service';
import { AuditService } from '../audit/audit.service';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { PackageSecurityService } from '../capability-contribution/package-security.service';
import { acceptedScopeHash, assertImportPublicKey, assertImportSignature, importHash, importId, normalizedRoots } from './skill-import-crypto';
import { ImportChallenge, ImportOperation, ImportPairing, ImportScope, ImportSession, ImportUploadTicket, ImportUser } from './skill-import-state';
import { SkillImportStore } from './skill-import-store';
import { applyImportEvent } from './skill-import-events';

const MINUTE = 60_000;
const terminal = new Set(['uploaded', 'cancelled', 'expired', 'failed']);
type ChallengeIndex = { sessionId: string; pairingId: string };
type StandaloneChallenge = { challenge: ImportChallenge; publicKey: string; userId: string };
type ScopeSummary = { scope: ImportScope; rootIds: string[] };

@Injectable()
export class SkillImportService {
  private readonly logger = new Logger('SkillImportMetrics');
  private readonly instanceId: string;
  constructor(
    private readonly store: SkillImportStore,
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly packages: SkillPackageService,
    private readonly security: PackageSecurityService,
    private readonly audit: AuditService,
  ) { this.instanceId = this.config.get<string>('SKILL_IMPORT_INSTANCE_ID') || 'sep-default'; }

  private enabled(): void {
    const flag = this.config.get<boolean | string>('SKILL_IMPORT_ENABLED');
    if (flag !== true && flag !== 'true') throw new ServiceUnavailableException({ code: 'IMPORT_DISABLED', message: '本机 Skill 导入暂未开放' });
  }

  async getConfig(user: ImportUser) {
    await this.assertWeb(user);
    const flag = this.config.get<boolean | string>('SKILL_IMPORT_ENABLED');
    return { enabled: flag === true || flag === 'true', instanceId: this.instanceId, protocolVersion: 1 as const, minClientVersion: this.config.get<string>('SKILL_IMPORT_MIN_CLIENT_VERSION') || '1.0.0' };
  }

  private async database<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ServiceUnavailableException({ code: 'IMPORT_UNAVAILABLE', message: '导入数据服务响应超时', retryable: true })), 3000);
      timeout.unref();
    })]); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(JSON.stringify({ metric: 'skill_import_dependency_error', dependency: 'persistence' }));
      throw new ServiceUnavailableException({ code: 'IMPORT_UNAVAILABLE', message: '导入数据服务暂不可用', retryable: true });
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private async auditEvent(userId: string, action: string, resourceId: string, result = 'SUCCESS', metadata?: Record<string, unknown>): Promise<void> {
    await this.database(() => this.audit.record({ actorId: userId, action, resourceType: 'SKILL_IMPORT', resourceId, result, metadata }));
  }

  private async assertAccount(userId: string, sid: string): Promise<void> {
    if (!sid) throw new UnauthorizedException({ code: 'OWNER_AUTH_REQUIRED', message: '本机导入要求有效的 Web 会话' });
    const user = await this.database(() => this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } }));
    if (!user || user.role !== UserRole.ADMIN || user.status !== UserStatus.ACTIVE) throw new ForbiddenException({ code: 'OWNER_AUTH_REVOKED', message: '导入发起者权限已失效' });
    await this.database(() => this.sessions.assertActiveSession(sid, userId, 'WEB'));
  }

  private async assertWeb(user: ImportUser, session?: ImportSession): Promise<void> {
    if (!user?.id || user.role !== UserRole.ADMIN || !user.sid) throw new ForbiddenException({ code: 'OWNER_AUTH_REQUIRED', message: '仅有效 Web 管理员会话可以导入 Skill' });
    if (session && (session.ownerUserId !== user.id || session.ownerWebSessionId !== user.sid)) throw new ForbiddenException({ code: 'OWNER_MISMATCH', message: '导入会话不属于当前 Web 会话' });
    await this.assertAccount(user.id, user.sid);
  }

  private expire(session: ImportSession): void {
    const now = Date.now();
    if (!terminal.has(session.status) && (now >= Date.parse(session.expiresAt) || now >= Date.parse(session.idleExpiresAt)
      || ((!session.activePairingId) && now >= Date.parse(session.pairingExpiresAt)))) {
      session.status = 'expired'; session.epoch += 1; session.closed = true;
    }
    if (session.preview?.status === 'pending' && now >= session.preview.deadline) {
      const command = session.commands.find((item) => item.commandId === session.preview!.commandId);
      if (command) command.completed = true;
      session.preview.status = 'failed'; session.preview.errorCode = 'PREVIEW_TIMEOUT'; session.preview.result = null;
      session.preview.files = []; session.preview.nextClientCursor = null;
      if (session.status === 'previewing') session.status = 'results';
    }
    if (session.operation?.processing && now >= session.operation.processing.deadline && session.operation.status === 'processing') {
      session.operation.status = 'failed'; session.operation.retryable = true; session.operation.errorCode = 'UPLOAD_TIMEOUT';
      delete session.operation.processing;
    }
  }

  private live(session: ImportSession, allowUploaded = false): void {
    this.expire(session);
    if (Date.now() >= Date.parse(session.expiresAt) || Date.now() >= Date.parse(session.idleExpiresAt)) throw new GoneException({ code: 'SESSION_EXPIRED', message: '导入授权已到期' });
    if (session.closed || terminal.has(session.status) && !(allowUploaded && session.status === 'uploaded')) throw new GoneException({ code: session.status === 'expired' ? 'SESSION_EXPIRED' : session.status === 'cancelled' ? 'SESSION_CANCELLED' : 'SESSION_CLOSED', message: '导入会话已结束' });
  }

  private touch(session: ImportSession): void { session.idleExpiresAt = new Date(Math.min(Date.now() + 10 * MINUTE, Date.parse(session.expiresAt))).toISOString(); }

  private async mutate<R>(id: string, work: (session: ImportSession) => Promise<R>, cleanup = false): Promise<R> {
    if (!cleanup) this.enabled();
    return this.store.update<ImportSession, R>(`session:${id}`, async (session) => {
      if (!session) throw new NotFoundException({ code: 'SESSION_EXPIRED', message: '导入会话不存在或已过期' });
      this.expire(session);
      session.version += 1;
      const result = await work(session);
      return { state: session, result };
    });
  }

  private operationView(session: ImportSession) {
    const operation = session.operation;
    return operation ? { operationId: operation.operationId, status: operation.status, retryable: operation.retryable, sha256: operation.sha256, errorCode: operation.errorCode, expiresAt: session.expiresAt } : null;
  }

  private releaseCompletedOperation(session: ImportSession): void {
    if (!session.operation || !['succeeded', 'failed'].includes(session.operation.status) || session.operation.processing) return;
    session.operation = null;
    session.artifact = null;
    session.status = 'results';
  }

  private view(session: ImportSession): SkillImportSessionView {
    return {
      id: session.id, status: session.status, version: session.version, protocolVersion: 1, instanceId: session.instanceId,
      expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt, deepLink: session.deepLink,
      artifactReady: Boolean(session.artifact), candidateCount: session.candidates.length, progress: session.progress,
      pairings: Object.values(session.pairings).filter((pairing) =>
        Date.now() < Date.parse(pairing.expiresAt)
        && (!session.activePairingId || pairing.pairingId === session.activePairingId),
      ).map((pairing) => ({
        pairingId: pairing.pairingId, keyFingerprint: pairing.keyFingerprint, shortCode: pairing.shortCode,
        label: pairing.label, platform: pairing.platform, clientVersion: pairing.clientVersion, expiresAt: pairing.expiresAt, webConfirmed: pairing.webConfirmed,
      })), operation: this.operationView(session),
    };
  }

  private enqueue(session: ImportSession, type: 'scan' | 'preview' | 'package-selected' | 'cancel', payload: Record<string, unknown>) {
    const command = { sessionId: session.id, commandId: importId(), sequence: ++session.commandSequence, expiresAt: session.expiresAt, type, payload, started: false, completed: false };
    session.commands.push(command);
    return command;
  }

  async createSession(user: ImportUser, input: SkillImportSessionCreate) {
    this.enabled(); await this.assertWeb(user);
    await this.store.rate(`create:${user.id}`, 5, MINUTE);
    return this.store.update<string[], SkillImportSessionView>(`owners:${user.id}`, async (ids) => {
      const active: string[] = [];
      for (const id of ids ?? []) {
        const previous = await this.store.read<ImportSession>(`session:${id}`);
        if (previous && previous.ownerWebSessionId === user.sid && previous.requestId === input.requestId) {
          if (previous.scope !== input.scope) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '同一请求不能修改扫描范围' });
          this.expire(previous); return { state: ids ?? [], result: this.view(previous) };
        }
        if (previous) { this.expire(previous); if (!terminal.has(previous.status) && !previous.closed) active.push(id); }
      }
      if (active.length >= 3) throw new ConflictException({ code: 'SESSION_LIMIT_REACHED', message: '最多同时进行 3 个本机导入任务' });
      const now = Date.now(); const id = importId();
      const account = await this.database(() => this.prisma.user.findUnique({ where: { id: user.id }, select: { name: true } }));
      const session: ImportSession = {
        id, ownerUserId: user.id, ownerWebSessionId: user.sid!, ownerLabel: account?.name || 'SEP 管理员', requestId: input.requestId,
        protocolVersion: 1, instanceId: this.instanceId, scope: input.scope, status: 'waiting-client', version: 1, epoch: 0, createdAt: now,
        expiresAt: new Date(now + 30 * MINUTE).toISOString(), idleExpiresAt: new Date(now + 10 * MINUTE).toISOString(), pairingExpiresAt: new Date(now + 5 * MINUTE).toISOString(),
        deepLink: `sep-import://skills/v1?instanceId=${encodeURIComponent(this.instanceId)}&sessionId=${encodeURIComponent(id)}`,
        pairings: {}, activePairingId: null, candidates: [], scanComplete: false, preview: null, previewRequests: {}, operation: null, artifact: null, closed: false,
        events: {}, eventSequence: 0, eventBytes: 0, commands: [], commandSequence: 0, progress: null,
      };
      await this.auditEvent(user.id, 'SKILL_IMPORT_SESSION_CREATED', id);
      await this.store.put(`session:${id}`, session);
      return { state: [...active, id], result: this.view(session) };
    });
  }

  async getSession(user: ImportUser, id: string, query: z.infer<typeof SkillImportQuerySchema>) {
    await this.store.rate(`${query.view}:${id}:${user.id}`, query.view === 'files' ? 120 : 60, MINUTE);
    return this.mutate(id, async (session) => {
      await this.assertWeb(user, session);
      const view = this.view(session);
      if (query.view === 'candidates') {
        const filter = importHash(JSON.stringify([query.q ?? '', query.source ?? '', query.scope ?? '']));
        const offset = this.cursor(query.cursor, id, 'candidates', filter);
        const candidates = session.candidates.filter((candidate) => (!query.q || `${candidate.name} ${candidate.description ?? ''}`.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) && (!query.source || candidate.sources.includes(query.source)) && (!query.scope || candidate.scope === query.scope));
        const limit = Math.min(query.limit ?? 25, 25);
        const items = candidates.slice(offset, offset + limit);
        while (items.length > 1 && Buffer.byteLength(JSON.stringify({ ...view, items, nextCursor: '' })) > 1024 * 1024 - 4096) items.pop();
        return { ...view, items, nextCursor: offset + items.length < candidates.length ? this.encodeCursor(id, 'candidates', filter, offset + items.length) : null };
      }
      if (query.view === 'preview') {
        const preview = session.preview;
        const superseded = Boolean(preview && (query.requestId && query.requestId !== preview.requestId || query.candidateId && query.candidateId !== preview.candidateId));
        return { ...view, previewStatus: superseded ? 'superseded' : preview?.status ?? 'none', preview: superseded || preview?.status !== 'ready' ? null : this.previewPage(session), errorCode: superseded ? 'PREVIEW_SUPERSEDED' : preview?.errorCode ?? null };
      }
      if (query.view === 'files') {
        const preview = session.preview;
        if (!preview?.result || preview.status !== 'ready' || preview.result.snapshotId !== query.snapshotId) throw new ConflictException({ code: 'SNAPSHOT_EXPIRED', message: '快照尚未就绪或已失效' });
        const offset = this.cursor(query.cursor, id, 'files', preview.result.snapshotId);
        const limit = Math.min(query.limit ?? 100, 100);
        return { snapshotId: preview.result.snapshotId, files: preview.files.slice(offset, offset + limit), nextFilesCursor: offset + limit < preview.files.length ? this.encodeCursor(id, 'files', preview.result.snapshotId, offset + limit) : null };
      }
      if (query.view === 'operation') {
        if (query.operationId && session.operation?.operationId !== query.operationId) throw new NotFoundException('导入操作不存在');
        return { ...view, artifact: session.artifact };
      }
      return view;
    });
  }

  private encodeCursor(sessionId: string, view: string, filter: string, offset: number) { return Buffer.from(JSON.stringify([sessionId, view, filter, offset])).toString('base64url'); }
  private cursor(value: string | undefined, sessionId: string, view: string, filter: string): number {
    if (!value) return 0;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (Array.isArray(parsed) && parsed.length === 4 && parsed[0] === sessionId && parsed[1] === view && parsed[2] === filter && Number.isSafeInteger(parsed[3]) && parsed[3] >= 0 && parsed[3] <= 10_000) return parsed[3] as number;
    } catch { /* Invalid cursor is a request error. */ }
    throw new BadRequestException({ code: 'CURSOR_INVALID', message: '分页游标无效' });
  }

  private previewPage(session: ImportSession) {
    const preview = session.preview!;
    return { ...preview.result!, files: preview.files.slice(0, 100), nextFilesCursor: preview.files.length > 100 ? this.encodeCursor(session.id, 'files', preview.result!.snapshotId, 100) : null };
  }

  async confirmDevice(user: ImportUser, id: string, input: z.infer<typeof SkillImportConfirmDeviceSchema>) {
    return this.mutate(id, async (session) => {
      await this.assertWeb(user, session); this.live(session);
      const pairing = session.pairings[input.pairingId];
      if (!pairing || pairing.keyFingerprint !== input.keyFingerprint || pairing.shortCode !== input.shortCode || Date.now() >= Date.parse(pairing.expiresAt)) throw new ConflictException({ code: 'DEVICE_CONFIRMATION_REQUIRED', message: '设备确认信息不匹配或已过期' });
      if (session.activePairingId && session.activePairingId !== pairing.pairingId || Object.values(session.pairings).some((other) => other.webConfirmed && other.pairingId !== pairing.pairingId)) throw new ConflictException({ code: 'DEVICE_CONFIRMATION_REQUIRED', message: '该会话已确认其他设备' });
      if (!pairing.webConfirmed) await this.auditEvent(user.id, 'SKILL_IMPORT_DEVICE_CONFIRMED', id, 'SUCCESS', { pairingId: pairing.pairingId, keyFingerprint: pairing.keyFingerprint });
      pairing.webConfirmed = true; this.touch(session);
      return this.view(session);
    });
  }

  async requestPreview(user: ImportUser, id: string, input: z.infer<typeof SkillImportPreviewSchema>) {
    await this.store.rate(`preview:${id}`, 20, MINUTE);
    return this.mutate(id, async (session) => {
      await this.assertWeb(user, session); this.live(session, true);
      // A completed operation has already been delivered to Web. Release the
      // single-operation slot so a multi-select queue can continue on the same
      // session while keeping the existing one-operation wire contract.
      this.releaseCompletedOperation(session);
      if (session.operation) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '导入操作已开始' });
      const requestHash = importHash(JSON.stringify(input)); const previous = session.previewRequests[input.requestId];
      if (previous) {
        if (previous.hash !== requestHash) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '预览请求 ID 已用于其他候选' });
        return { requestId: input.requestId, commandId: previous.commandId, status: 'pending' };
      }
      const candidate = session.candidates.find((item) => item.candidateId === input.candidateId && item.revision === input.revision);
      if (!session.scanComplete || !candidate || candidate.availability !== 'previewable') throw new ConflictException({ code: 'CANDIDATE_CHANGED', message: '候选尚未就绪或已变化' });
      if (Object.keys(session.previewRequests).length >= 600) throw new ConflictException({ code: 'SESSION_LIMIT_REACHED', message: '本会话预览次数已达上限' });
      for (const previousCommand of session.commands) if (previousCommand.type === 'preview') previousCommand.completed = true;
      const command = this.enqueue(session, 'preview', input);
      session.previewRequests[input.requestId] = { hash: requestHash, commandId: command.commandId };
      session.preview = { requestId: input.requestId!, candidateId: input.candidateId!, revision: input.revision!, commandId: command.commandId, status: 'pending', deadline: Math.min(Date.now() + MINUTE, Date.parse(session.expiresAt)), errorCode: null, result: null, files: [], nextClientCursor: null, usedCursors: [] };
      session.status = 'previewing'; this.touch(session);
      return { requestId: input.requestId, commandId: command.commandId, status: 'pending' };
    });
  }

  async select(user: ImportUser, id: string, input: SkillImportSelection) {
    await this.store.rate(`selection:${id}`, 20, MINUTE);
    return this.mutate(id, async (session) => {
      await this.assertWeb(user, session); this.live(session, true);
      this.releaseCompletedOperation(session);
      if (session.operation) {
        if (session.operation.operationId !== input.operationId || session.operation.candidateId !== input.candidateId || session.operation.snapshotId !== input.snapshotId) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '该会话已有其他导入操作' });
        return { operationId: input.operationId, status: session.operation.status };
      }
      const preview = session.preview;
      if (preview?.status !== 'ready' || !preview.result || preview.result.candidateId !== input.candidateId || preview.result.snapshotId !== input.snapshotId || Date.now() >= Date.parse(preview.result.expiresAt)) throw new ConflictException({ code: 'SNAPSHOT_EXPIRED', message: '完整预览尚未就绪或快照已过期' });
      if (preview.result.warnings.some((warning) => warning.severity === 'blocking')) throw new ConflictException({ code: 'PACKAGE_REJECTED', message: '该快照存在阻断问题' });
      await this.auditEvent(user.id, 'SKILL_IMPORT_SELECTED', id, 'SUCCESS', { operationId: input.operationId, candidateId: input.candidateId, fileCount: preview.result.fileCount });
      session.operation = { ...input, status: 'pending', retryable: true, sha256: null, errorCode: null };
      this.enqueue(session, 'package-selected', input); session.status = 'packaging'; this.touch(session);
      return { operationId: input.operationId, status: 'pending' };
    });
  }

  async cancel(user: ImportUser, id: string) {
    const result = await this.mutate(id, async (session) => {
      await this.assertWeb(user, session);
      session.closed = true; session.epoch += 1;
      if (!terminal.has(session.status)) session.status = 'cancelled';
      return this.view(session);
    }, true);
    await this.auditEvent(user.id, 'SKILL_IMPORT_CANCELLED', id);
    return result;
  }

  async listDevices(user: ImportUser, query: z.infer<typeof SkillImportDeviceQuerySchema> = { limit: 25 }) {
    this.enabled(); await this.assertWeb(user);
    const limit = query.limit ?? 25;
    const boundary = query.cursor ? await this.database(() => this.prisma.skillImportDevice.findFirst({ where: { id: query.cursor, userId: user.id, instanceId: this.instanceId }, select: { id: true, createdAt: true } })) : null;
    if (query.cursor && !boundary) throw new BadRequestException({ code: 'CURSOR_INVALID', message: '设备分页游标无效' });
    // Keyset pagination remains stable when newer devices are added or the boundary device is revoked.
    const devices = await this.database(() => this.prisma.skillImportDevice.findMany({
      where: { userId: user.id, instanceId: this.instanceId, revokedAt: null, ...(boundary ? { OR: [{ createdAt: { lt: boundary.createdAt } }, { createdAt: boundary.createdAt, id: { lt: boundary.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    }));
    const page = devices.slice(0, limit);
    return { items: page.map((device) => ({ deviceId: device.id, keyFingerprint: device.keyFingerprint, label: device.label, platform: device.platform, clientVersion: device.clientVersion, lastSeenAt: device.lastSeenAt?.toISOString() ?? null, createdAt: device.createdAt.toISOString() })), nextCursor: devices.length > limit ? page[page.length - 1].id : null };
  }

  async revokeDevice(user: ImportUser, deviceId: string) {
    await this.assertWeb(user);
    const result = await this.database(() => this.prisma.skillImportDevice.updateMany({ where: { id: deviceId, userId: user.id, instanceId: this.instanceId }, data: { revokedAt: new Date() } }));
    if (!result.count) throw new NotFoundException('设备不存在');
    await this.auditEvent(user.id, 'SKILL_IMPORT_DEVICE_REVOKED', deviceId);
    return { ok: true };
  }

  private challenge(sessionId: string | null, pairingId: string | null, deviceId: string | null, fingerprint: string, purpose: 'session-grant' | 'device-revoke', deadline = Date.now() + 5 * MINUTE): ImportChallenge {
    return { challengeId: importId(), purpose, instanceId: this.instanceId, sessionId, pairingId, deviceId, keyFingerprint: fingerprint, nonce: importId(), expiresAt: new Date(Math.min(Date.now() + 5 * MINUTE, deadline)).toISOString(), used: false };
  }

  private challengeView(challenge: ImportChallenge) {
    const { used: _used, ...view } = challenge;
    return view;
  }

  private assertClientVersion(version: string): void {
    const minimum = this.config.get<string>('SKILL_IMPORT_MIN_CLIENT_VERSION') || '1.0.0';
    const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
    const actual = parse(version); const expected = parse(minimum);
    if (!actual || !expected) throw new BadRequestException({ code: 'CLIENT_UPGRADE_REQUIRED', message: '客户端版本不支持本机导入' });
    for (let index = 0; index < 3; index += 1) {
      if (actual[index] > expected[index]) return;
      if (actual[index] < expected[index]) throw new BadRequestException({ code: 'CLIENT_UPGRADE_REQUIRED', message: '请升级 SEP 客户端后重试' });
    }
  }

  private pairing(session: ImportSession, pairingId: string): ImportPairing {
    const pairing = session.pairings[pairingId];
    if (!pairing) throw new NotFoundException({ code: 'DEVICE_CONFIRMATION_REQUIRED', message: '配对不存在' });
    if (!pairing.sessionGrantHash && Date.now() >= Date.parse(pairing.expiresAt)) throw new GoneException({ code: 'SESSION_EXPIRED', message: '配对已过期' });
    return pairing;
  }

  private async device(deviceId: string, ownerId?: string): Promise<SkillImportDevice> {
    const device = await this.database(() => this.prisma.skillImportDevice.findFirst({ where: { id: deviceId, instanceId: this.instanceId, revokedAt: null, ...(ownerId ? { userId: ownerId } : {}) } }));
    if (!device) throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: '设备不存在或已撤销' });
    return device;
  }

  async createPairing(input: z.infer<typeof SkillImportPairingSchema>) {
    this.enabled(); this.assertClientVersion(input.clientVersion); assertImportPublicKey(input.publicKey, input.keyFingerprint);
    await this.store.rate(`new-pairing:${input.sessionId}`, 5, MINUTE);
    return this.mutate(input.sessionId, async (session) => {
      this.live(session); await this.assertAccount(session.ownerUserId, session.ownerWebSessionId);
      const previous = Object.values(session.pairings).find((pairing) => pairing.requestId === input.requestId);
      if (previous) {
        if (previous.publicKey !== input.publicKey || previous.keyFingerprint !== input.keyFingerprint) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '配对请求 ID 已被其他设备使用' });
        return { pairingId: previous.pairingId, shortCode: previous.shortCode, ownerLabel: session.ownerLabel, scope: session.scope, expiresAt: previous.expiresAt, challenge: this.challengeView(previous.challenge) };
      }
      if (session.activePairingId) throw new ConflictException({ code: 'CLIENT_BUSY', message: '该导入会话已连接客户端' });
      for (const [key, pairing] of Object.entries(session.pairings)) if (Date.now() >= Date.parse(pairing.expiresAt)) delete session.pairings[key];
      if (Object.keys(session.pairings).length >= 3) throw new ConflictException({ code: 'SESSION_LIMIT_REACHED', message: '该会话的待确认设备过多' });
      const pairingId = importId();
      const challenge = this.challenge(session.id, pairingId, null, input.keyFingerprint, 'session-grant', Date.parse(session.pairingExpiresAt));
      const pairing: ImportPairing = {
        pairingId, requestId: input.requestId, publicKey: input.publicKey, keyFingerprint: input.keyFingerprint,
        label: input.label ?? `${input.platform} SEP`, platform: input.platform, clientVersion: input.clientVersion,
        shortCode: String(randomInt(100_000, 1_000_000)), expiresAt: challenge.expiresAt, webConfirmed: false, localConfirmed: false, deviceId: null, challenge,
      };
      session.pairings[pairingId] = pairing; session.status = 'pairing';
      await this.store.put(`challenge:${challenge.challengeId}`, { sessionId: session.id, pairingId } satisfies ChallengeIndex, 5 * MINUTE);
      return { pairingId, shortCode: pairing.shortCode, ownerLabel: session.ownerLabel, scope: session.scope, expiresAt: pairing.expiresAt, challenge: this.challengeView(challenge) };
    });
  }

  private scopeSummary(device: SkillImportDevice): ScopeSummary | undefined {
    const parsed = z.object({ scope: z.enum(['user', 'project', 'all']), rootIds: z.array(z.string()).max(128) }).strict().safeParse(device.scopeSummary);
    return parsed.success ? { scope: parsed.data.scope!, rootIds: parsed.data.rootIds! } : undefined;
  }

  async createChallenge(input: z.infer<typeof SkillImportChallengeSchema>) {
    this.enabled();
    if (input.purpose === 'device-revoke') {
      const device = await this.device(input.deviceId!);
      await this.store.rate(`revoke-challenge:${device.id}`, 5, MINUTE);
      const challenge = this.challenge(null, null, device.id, device.keyFingerprint, 'device-revoke');
      await this.store.put(`revoke-challenge:${challenge.challengeId}`, { challenge, publicKey: device.publicKey, userId: device.userId } satisfies StandaloneChallenge, 5 * MINUTE);
      return this.challengeView(challenge);
    }
    const sessionId = input.sessionId!;
    await this.store.rate(`challenge:${sessionId}`, 5, MINUTE);
    return this.mutate(sessionId, async (session) => {
      this.live(session, true); await this.assertAccount(session.ownerUserId, session.ownerWebSessionId);
      let pairing: ImportPairing;
      if (input.pairingId) {
        pairing = this.pairing(session, input.pairingId);
        if (pairing.deviceId) await this.device(pairing.deviceId, session.ownerUserId);
      } else {
        const device = await this.device(input.deviceId!, session.ownerUserId);
        const matchingTemporary = Object.values(session.pairings).filter((value) =>
          !value.deviceId
          && !value.webConfirmed
          && Date.now() < Date.parse(value.expiresAt)
        );
        if (matchingTemporary.length > 1) throw new ConflictException({ code: 'PAIRING_CONFLICT', message: '该会话存在多个待绑定配对，请重新扫描' });
        const existing = Object.values(session.pairings).find((value) => value.deviceId === device.id) ?? matchingTemporary[0];
        this.assertClientVersion(input.clientVersion ?? existing?.clientVersion ?? device.clientVersion);
        if (session.activePairingId && session.activePairingId !== existing?.pairingId) throw new ConflictException({ code: 'CLIENT_BUSY', message: '该导入会话已连接其他设备' });
        if (existing) {
          pairing = existing;
          pairing.deviceId = device.id;
          pairing.publicKey = device.publicKey;
          pairing.keyFingerprint = device.keyFingerprint;
          pairing.label = device.label;
          pairing.platform = device.platform;
          pairing.approvedScope = this.scopeSummary(device);
        }
        else {
          if (Object.keys(session.pairings).length >= 3) throw new ConflictException({ code: 'SESSION_LIMIT_REACHED', message: '待确认设备过多' });
          const pairingId = importId();
          pairing = {
            pairingId, requestId: importId(), publicKey: device.publicKey, keyFingerprint: device.keyFingerprint,
            label: device.label, platform: device.platform, clientVersion: device.clientVersion, shortCode: String(randomInt(100_000, 1_000_000)),
            expiresAt: new Date(Math.min(Date.now() + 5 * MINUTE, Date.parse(session.expiresAt))).toISOString(),
            webConfirmed: false, localConfirmed: false, deviceId: device.id, approvedScope: this.scopeSummary(device),
            challenge: this.challenge(session.id, null, device.id, device.keyFingerprint, 'session-grant'),
          };
          session.pairings[pairingId] = pairing;
        }
      }
      const clientVersion = input.clientVersion ?? pairing.clientVersion;
      this.assertClientVersion(clientVersion);
      pairing.clientVersion = clientVersion;
      const challenge = this.challenge(session.id, input.pairingId ? pairing.pairingId : null, pairing.deviceId, pairing.keyFingerprint, 'session-grant', Date.parse(session.expiresAt));
      pairing.challenge = challenge;
      if (!session.activePairingId) { pairing.expiresAt = challenge.expiresAt; session.status = 'pairing'; }
      await this.store.put(`challenge:${challenge.challengeId}`, { sessionId: session.id, pairingId: pairing.pairingId } satisfies ChallengeIndex, 5 * MINUTE);
      return this.challengeView(challenge);
    });
  }

  async grant(input: z.infer<typeof SkillImportGrantSchema>) {
    this.enabled();
    const index = await this.store.read<ChallengeIndex>(`challenge:${input.challengeId}`);
    if (!index) throw new UnauthorizedException({ code: 'GRANT_EXPIRED', message: '挑战不存在或已过期' });
    await this.store.rate(`grant:${index.pairingId}`, 40, MINUTE);
    return this.mutate(index.sessionId, async (session) => {
      this.live(session, true); await this.assertAccount(session.ownerUserId, session.ownerWebSessionId);
      const pairing = this.pairing(session, index.pairingId); const challenge = pairing.challenge;
      this.assertClientVersion(pairing.clientVersion);
      if (challenge.challengeId !== input.challengeId || challenge.used) throw new ConflictException({ code: 'CHALLENGE_USED', message: '挑战已被使用或替换' });
      if (Date.now() >= Date.parse(challenge.expiresAt)) throw new UnauthorizedException({ code: 'GRANT_EXPIRED', message: '挑战已过期' });
      if (pairing.deviceId) await this.device(pairing.deviceId, session.ownerUserId);
      const roots = normalizedRoots(input.rootIds);
      if (input.scope !== session.scope) throw new ForbiddenException({ code: 'SCOPE_MISMATCH', message: '扫描范围与 Web 发起范围不匹配' });
      assertImportSignature(challenge, pairing.publicKey, input.signature, input.rememberDevice, input.scope, roots);
      if (session.acceptedScope && acceptedScopeHash(input.scope, roots) !== acceptedScopeHash(session.acceptedScope.scope, session.acceptedScope.rootIds)) throw new ForbiddenException({ code: 'SCOPE_MISMATCH', message: '已批准的会话不能更改扫描范围' });
      const remembered = pairing.approvedScope?.scope === input.scope && roots.every((root) => pairing.approvedScope!.rootIds.includes(root));
      if (!pairing.webConfirmed && !remembered) {
        return { status: 'pending-web-confirmation' as const, pairingId: pairing.pairingId, retryAfterSeconds: 2, expiresAt: pairing.expiresAt };
      }
      if (session.activePairingId && session.activePairingId !== pairing.pairingId) throw new ConflictException({ code: 'DEVICE_CONFIRMATION_REQUIRED', message: '该会话已由其他设备领取' });
      if (Object.values(session.pairings).some((other) => other.webConfirmed && other.pairingId !== pairing.pairingId)) throw new ConflictException({ code: 'DEVICE_CONFIRMATION_REQUIRED', message: 'Web 已确认其他设备' });
      if (input.rememberDevice) {
        const device = await this.database(() => this.prisma.skillImportDevice.upsert({
          where: { instanceId_userId_keyFingerprint: { instanceId: this.instanceId, userId: session.ownerUserId, keyFingerprint: pairing.keyFingerprint } },
          create: { userId: session.ownerUserId, instanceId: this.instanceId, publicKey: pairing.publicKey, keyFingerprint: pairing.keyFingerprint, label: pairing.label, platform: pairing.platform, clientVersion: pairing.clientVersion, scopeSummary: { scope: input.scope, rootIds: roots }, lastSeenAt: new Date() },
          update: {},
        }));
        // Revocation is permanent for this key. A client re-pairs with a fresh key instead of resurrecting an old binding.
        if (device.revokedAt) throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: '该设备密钥已撤销，请在客户端重新配对' });
        const updated = await this.database(() => this.prisma.skillImportDevice.updateMany({ where: { id: device.id, revokedAt: null }, data: { label: pairing.label, platform: pairing.platform, clientVersion: pairing.clientVersion, scopeSummary: { scope: input.scope, rootIds: roots }, lastSeenAt: new Date() } }));
        if (!updated.count) throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: '设备已撤销' });
        pairing.deviceId = device.id;
      }
      challenge.used = true; pairing.localConfirmed = true;
      const grant = importId(); pairing.sessionGrantHash = importHash(grant); pairing.sessionGrantEpoch = session.epoch;
      pairing.sessionGrantExpiresAt = new Date(Math.min(Date.now() + 10 * MINUTE, Date.parse(session.expiresAt))).toISOString();
      if (!session.activePairingId) {
        await this.auditEvent(session.ownerUserId, 'SKILL_IMPORT_PAIRED', session.id, 'SUCCESS', { pairingWaitMs: Date.now() - session.createdAt, remembered: Boolean(remembered), rememberDevice: input.rememberDevice });
        session.activePairingId = pairing.pairingId; session.acceptedScope = { scope: input.scope, rootIds: roots };
        session.status = 'ready'; this.enqueue(session, 'scan', { scope: input.scope, rootIds: roots }); this.touch(session);
      }
      return { status: 'granted' as const, sessionId: session.id, deviceId: input.rememberDevice ? pairing.deviceId : null, sessionGrant: grant,
        sessionGrantExpiresAt: pairing.sessionGrantExpiresAt, sessionExpiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt,
        acceptedScopeHash: acceptedScopeHash(input.scope, roots) };
    });
  }

  private async byGrant(session: ImportSession, token: string, allowUploaded = false): Promise<ImportPairing> {
    this.live(session, allowUploaded); await this.assertAccount(session.ownerUserId, session.ownerWebSessionId);
    const pairing = session.activePairingId ? session.pairings[session.activePairingId] : undefined;
    if (!token || !pairing || pairing.sessionGrantHash !== importHash(token) || pairing.sessionGrantEpoch !== session.epoch || !pairing.sessionGrantExpiresAt || Date.now() >= Date.parse(pairing.sessionGrantExpiresAt)) throw new UnauthorizedException({ code: 'GRANT_EXPIRED', message: '导入授权已过期', retryable: true });
    if (pairing.deviceId) await this.device(pairing.deviceId, session.ownerUserId);
    return pairing;
  }

  async commands(id: string, token: string, cursor: number) {
    await this.store.rate(`commands:${id}`, 60, MINUTE);
    return this.mutate(id, async (session) => {
      // A successful upload keeps the grant alive so Web can enqueue the next
      // selected skill on the same session.
      await this.byGrant(session, token, true);
      if (cursor > session.commandSequence) throw new BadRequestException({ code: 'CURSOR_INVALID', message: '命令游标无效' });
      // Unacknowledged commands remain deliverable even if a client advanced its read cursor.
      const items = session.commands.filter((command) => !command.completed && (!command.started || command.sequence > cursor)).slice(0, 20).map(({ started: _started, completed: _completed, ...command }) => command);
      return { items, nextCursor: session.commandSequence };
    });
  }

  async event(id: string, token: string, input: SkillImportEvent) {
    await this.store.rate(`events:${id}`, 120, MINUTE);
    return this.mutate(id, async (session) => {
      await this.byGrant(session, token);
      const bytes = Buffer.byteLength(JSON.stringify(input));
      // Ingress middleware independently charges duplicate bytes before JSON parsing.
      if (session.eventBytes + bytes > 128 * 1024 * 1024) throw new BadRequestException({ code: 'EVENT_BUDGET_EXCEEDED', message: '本次导入事件流量已达上限' });
      session.eventBytes += bytes;
      const previous = session.events[input.eventId]; const hash = importHash(JSON.stringify(input));
      if (previous) {
        if (previous.hash !== hash) throw new ConflictException({ code: 'EVENT_CONFLICT', message: '事件 ID 不允许更改内容' });
        return previous.ack;
      }
      if (input.sequence !== session.eventSequence + 1) throw new ConflictException({ code: 'EVENT_SEQUENCE_INVALID', message: '事件序号不连续' });
      const ignored = applyImportEvent(session, input);
      if (!ignored && input.type === 'candidates' && input.payload.final) await this.auditEvent(session.ownerUserId, 'SKILL_IMPORT_SCAN_COMPLETED', session.id, 'SUCCESS', { scanMs: Date.now() - (session.scanStartedAt ?? session.createdAt), candidateCount: session.candidates.length });
      const ack = { ok: true as const, eventId: input.eventId, cursor: input.sequence, ignored };
      session.events[input.eventId] = { hash, ack }; session.eventSequence = input.sequence;
      if (!ignored && input.type !== 'progress') this.touch(session);
      if (input.type === 'progress' && !ignored) this.touch(session);
      return ack;
    });
  }

  async operation(id: string, token: string, operationId: string) {
    await this.store.rate(`operation:${id}`, 60, MINUTE);
    return this.mutate(id, async (session) => {
      await this.byGrant(session, token, true);
      if (session.operation?.operationId !== operationId) throw new NotFoundException('导入操作不存在');
      return this.operationView(session)!;
    });
  }

  async uploadGrant(id: string, token: string, operationId: string, input: z.infer<typeof SkillImportUploadGrantSchema>) {
    await this.store.rate(`upload-grant:${id}:${operationId}`, 5, 5 * MINUTE);
    return this.mutate(id, async (session) => {
      const pairing = await this.byGrant(session, token);
      const operation = session.operation;
      if (!operation || operation.operationId !== operationId || operation.candidateId !== input.candidateId || operation.snapshotId !== input.snapshotId) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '操作与所选快照不匹配' });
      if (operation.status === 'processing') throw new ConflictException({ code: 'UPLOAD_PROCESSING', message: '该包正在处理，请查询操作状态', retryable: true });
      if (operation.status === 'succeeded' || operation.status === 'failed' && !operation.retryable) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '该操作不允许重新上传' });
      const command = session.commands.find((item) => item.type === 'package-selected' && item.payload.operationId === operationId);
      if (!command?.completed) throw new ConflictException({ code: 'PACKAGE_NOT_READY', message: '客户端完成打包后才能申请上传授权' });
      if (operation.packageSha256 && (operation.packageSha256 !== input.packageSha256 || operation.packageBytes !== input.packageBytes)) throw new ConflictException({ code: 'PACKAGE_CHANGED', message: '同一操作必须使用完全相同的 ZIP 字节重试' });
      operation.packageSha256 = input.packageSha256; operation.packageBytes = input.packageBytes;
      const uploadGrant = importId(); const expiresAt = new Date(Math.min(Date.now() + 5 * MINUTE, Date.parse(session.expiresAt), Date.parse(session.idleExpiresAt))).toISOString();
      operation.uploadGrant = { hash: importHash(uploadGrant), expiresAt, epoch: session.epoch, pairingId: pairing.pairingId };
      operation.status = 'pending'; operation.errorCode = null; session.status = 'uploading';
      return { uploadGrant, expiresAt };
    });
  }

  // Called by a guard before Multer can allocate any package buffer.
  async beginUpload(id: string, token: string, expectedOperationId?: string): Promise<ImportUploadTicket> {
    let slot: string | null = null;
    try {
      return await this.mutate(id, async (session) => {
        this.live(session, true); await this.assertAccount(session.ownerUserId, session.ownerWebSessionId);
        const operation = session.operation; const grant = operation?.uploadGrant;
        if (!operation || !grant || !token || grant.hash !== importHash(token) || grant.epoch !== session.epoch || Date.now() >= Date.parse(grant.expiresAt)) throw new UnauthorizedException({ code: 'GRANT_EXPIRED', message: '上传授权不存在或已过期' });
        if (expectedOperationId && expectedOperationId !== operation.operationId) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '上传操作与授权不匹配' });
        if (grant.pairingId !== session.activePairingId) throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: '上传设备已失效' });
        const pairing = this.pairing(session, grant.pairingId);
        if (pairing.deviceId) await this.device(pairing.deviceId, session.ownerUserId);
        await this.store.rate(`upload-start:${id}:${operation.operationId}`, 5, 5 * MINUTE);
        const ticket: ImportUploadTicket = { sessionId: id, operationId: operation.operationId, epoch: session.epoch, pairingId: pairing.pairingId, ticketId: importId(),
          deadline: Math.min(Date.now() + 5 * MINUTE, Date.parse(session.expiresAt), Date.parse(session.idleExpiresAt)), startedAt: Date.now(), slot: '', packageSha256: operation.packageSha256!, packageBytes: operation.packageBytes! };
        if (operation.status === 'succeeded' && session.artifact) return { ...ticket, replay: true };
        if (operation.status === 'processing' || operation.processing) throw new ConflictException({ code: 'UPLOAD_PROCESSING', message: '该包正在处理', retryable: true });
        if (operation.status === 'failed' && !operation.retryable) throw new ConflictException({ code: 'PACKAGE_REJECTED', message: '该包不允许重试' });
        slot = ticket.ticketId; ticket.slot = slot;
        const configured = Number(this.config.get<number>('SKILL_IMPORT_UPLOAD_CONCURRENCY') ?? 1);
        await this.store.acquireSlot(slot, ticket.deadline, Math.max(1, Math.min(4, configured)));
        operation.processing = { ticketId: ticket.ticketId, deadline: ticket.deadline, epoch: session.epoch, pairingId: pairing.pairingId };
        operation.status = 'processing'; operation.retryable = false; operation.errorCode = null;
        return ticket;
      });
    } catch (error) {
      if (slot) await this.store.releaseSlot(slot);
      throw error;
    }
  }

  private async assertUpload(session: ImportSession, ticket: ImportUploadTicket): Promise<ImportOperation> {
    this.live(session, ticket.replay); await this.assertAccount(session.ownerUserId, session.ownerWebSessionId);
    const operation = session.operation;
    if (!operation || operation.operationId !== ticket.operationId || session.epoch !== ticket.epoch || session.activePairingId !== ticket.pairingId || Date.now() >= ticket.deadline) throw new GoneException({ code: 'SESSION_CLOSED', message: '上传授权已被撤销或处理已超时' });
    const pairing = session.pairings[ticket.pairingId];
    if (!pairing) throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: '上传设备已失效' });
    if (pairing.deviceId) await this.device(pairing.deviceId, session.ownerUserId);
    if (!ticket.replay && operation.processing?.ticketId !== ticket.ticketId) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '上传处理租约已变化' });
    return operation;
  }

  async replayUpload(ticket: ImportUploadTicket) {
    return this.mutate(ticket.sessionId, async (session) => { await this.assertUpload(session, ticket); return session.artifact!; });
  }

  async upload(ticket: ImportUploadTicket, file: Express.Multer.File) {
    await this.mutate(ticket.sessionId, async (session) => { await this.assertUpload(session, ticket); return true; });
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'PACKAGE_REJECTED', message: '未上传 Skill ZIP 文件' });
    if (file.buffer.length !== ticket.packageBytes || importHash(file.buffer) !== ticket.packageSha256) {
      await this.failUpload(ticket, 'PACKAGE_CHANGED', false);
      throw new ConflictException({ code: 'PACKAGE_CHANGED', message: 'ZIP 摘要或大小与授权不匹配' });
    }
    try {
      const stored = await this.packages.store(file);
      const scan = await this.security.scanSkill(stored);
      if (scan.status !== PackageSecurityScanStatus.PASSED) throw new BadRequestException({ code: 'PACKAGE_REJECTED', message: '技能包未通过静态规则检查' });
      const warnings = z.array(z.object({ code: z.string(), message: z.string() }).passthrough()).parse(scan.warnings);
      const artifact = SkillImportArtifactSchema.parse({ zipPath: stored.key, sha256: stored.sha256, fileCount: stored.fileCount, totalSize: stored.totalBytes,
        filename: stored.filename, content: stored.content, suggested: stored.suggested, warnings });
      return await this.mutate(ticket.sessionId, async (session) => {
        const operation = await this.assertUpload(session, ticket);
        await this.auditEvent(session.ownerUserId, 'SKILL_IMPORT_UPLOADED', session.id, 'SUCCESS', { operationId: operation.operationId, fileCount: stored.fileCount, packageBytes: stored.totalBytes, uploadMs: Date.now() - ticket.startedAt, sessionMs: Date.now() - session.createdAt });
        operation.status = 'succeeded'; operation.retryable = false; operation.sha256 = stored.sha256; operation.errorCode = null; delete operation.processing;
        session.artifact = artifact; session.status = 'uploaded';
        return artifact;
      });
    } catch (error) {
      const rejected = error instanceof BadRequestException || error instanceof z.ZodError;
      await this.failUpload(ticket, rejected ? 'PACKAGE_REJECTED' : 'IMPORT_UNAVAILABLE', !rejected);
      this.logger.warn(JSON.stringify({ metric: 'skill_import_upload', result: 'blocked', code: rejected ? 'PACKAGE_REJECTED' : 'IMPORT_UNAVAILABLE', elapsedMs: Date.now() - ticket.startedAt }));
      if (rejected) throw new BadRequestException({ code: 'PACKAGE_REJECTED', message: 'Skill ZIP 未通过包校验或静态规则检查' });
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: 'IMPORT_UNAVAILABLE', message: 'Skill 包处理失败，请查询操作状态后重试', retryable: true });
    }
  }

  private async failUpload(ticket: ImportUploadTicket, errorCode: string, retryable: boolean) {
    const owner = await this.mutate(ticket.sessionId, async (session) => {
      const operation = session.operation;
      if (operation?.processing?.ticketId === ticket.ticketId && session.epoch === ticket.epoch) {
        operation.status = 'failed'; operation.retryable = retryable; operation.errorCode = errorCode; delete operation.processing;
        return session.ownerUserId;
      }
      return null;
    }, true);
    if (owner) await this.auditEvent(owner, 'SKILL_IMPORT_UPLOAD_BLOCKED', ticket.sessionId, 'BLOCKED', { operationId: ticket.operationId, reason: errorCode });
  }

  async finishUpload(ticket: ImportUploadTicket, failed = false) {
    try { if (failed && !ticket.replay) await this.failUpload(ticket, 'UPLOAD_INTERRUPTED', true); }
    finally { if (ticket.slot) await this.store.releaseSlot(ticket.slot); }
  }

  async connectorCancel(id: string, token: string) {
    return this.mutate(id, async (session) => {
      await this.byGrant(session, token, true);
      session.epoch += 1; session.closed = true;
      if (!terminal.has(session.status)) session.status = 'cancelled';
      return { ok: true, status: session.status };
    }, true);
  }

  async revokeConnectorDevice(deviceId: string, input: { challengeId?: string; signature?: string }) {
    const result = await this.store.update<StandaloneChallenge, { ok: true; userId: string }>(`revoke-challenge:${input.challengeId}`, async (record) => {
      if (!record || record.challenge.deviceId !== deviceId || Date.now() >= Date.parse(record.challenge.expiresAt)) throw new UnauthorizedException({ code: 'GRANT_EXPIRED', message: '撤销挑战已过期' });
      if (record.challenge.used) throw new ConflictException({ code: 'CHALLENGE_USED', message: '挑战已使用' });
      assertImportSignature(record.challenge, record.publicKey, input.signature, false, 'revoke', []);
      await this.database(() => this.prisma.skillImportDevice.updateMany({ where: { id: deviceId, userId: record.userId, instanceId: this.instanceId }, data: { revokedAt: new Date() } }));
      record.challenge.used = true;
      return { state: record, result: { ok: true, userId: record.userId } };
    });
    await this.auditEvent(result.userId, 'SKILL_IMPORT_DEVICE_REVOKED', deviceId);
    return { ok: true };
  }
}
