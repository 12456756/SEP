import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StorageService } from '../upload/storage/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaRealBillingService } from '../media-gateway/media-real-billing.service';
import { MediaByteCacheService } from '../media-gateway/media-byte-cache.service';
import { VideoFileCacheService } from '../media-gateway/video-file-cache.service';
import { KnowledgePrivateStorage } from '../knowledge/knowledge-private-storage';

export interface EnterpriseDeletionManifest {
  enterpriseId: string;
  documentStoragePaths: string[];
  skillPackageKeys: string[];
  conversationSessionIds: string[];
  taskRuns: Array<{ id: string; status: string; createdAt: string; completedAt: string | null }>;
  computeUsage: { count: number; costCNY: string; walletPaidCNY: string; personalPaidCNY: string };
  mediaReservations: Array<{ receiptId: string; status: string; reservedCny: string; settledCny: string | null; releasedPersonalCny: string }>;
  mediaRequests: Array<{ id: string; kind: string; status: string; createdAt: string }>;
  scopedMedia: Array<{ scope: string; ids: string[] }>;
}

@Injectable()
export class EnterpriseDeletionCleanupService {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly mediaBilling: MediaRealBillingService,
    private readonly byteCache: MediaByteCacheService,
    private readonly videoCache: VideoFileCacheService,
  ) {}

  async buildManifest(tx: Prisma.TransactionClient, enterpriseId: string): Promise<EnterpriseDeletionManifest> {
    const scopePrefix = `[${JSON.stringify(enterpriseId)},`;
    const [documents, documentVersions, versions, taskRuns, usage, members, reservations, gatewayRequests, realRequests,
      gatewayReferences, gatewayQuotes, realReferences, realQuotes] = await Promise.all([
      tx.document.findMany({
        where: { knowledgeBase: { enterpriseId } },
        select: { storagePath: true },
      }),
      tx.documentVersion.findMany({
        where: { document: { knowledgeBase: { enterpriseId } } },
        select: { storagePath: true },
      }),
      tx.skillVersion.findMany({
        where: { enterpriseId },
        select: { packageKey: true },
      }),
      tx.taskRun.findMany({ where: { enterpriseId }, select: { id: true, status: true, createdAt: true, completedAt: true } }),
      tx.computeUsageRecord.aggregate({ where: { enterpriseId }, _count: { _all: true }, _sum: { costCNY: true, walletPaidCNY: true, personalPaidCNY: true } }),
      tx.enterpriseMember.findMany({ where: { enterpriseId }, select: {
        userId: true,
        createdAt: true,
        user: { select: { memberships: { select: { id: true } } } },
      } }),
      tx.mediaRealBillingReservation.findMany({ where: { enterpriseId }, select: { receiptId: true, status: true, reservedCny: true, settledCny: true, personalCny: true } }),
      tx.mediaGatewayRequest.findMany({ where: { enterpriseId }, select: { id: true, scope: true, status: true, createdAt: true, referenceIds: true, receipt: true } }),
      tx.mediaRealRequest.findMany({ where: { enterpriseId }, select: { id: true, scope: true, status: true, createdAt: true, referenceIds: true, receipt: true } }),
      tx.mediaGatewayReference.findMany({ where: { scope: { startsWith: scopePrefix } }, select: { id: true, scope: true } }),
      tx.mediaGatewayQuote.findMany({ where: { scope: { startsWith: scopePrefix } }, select: { id: true, scope: true } }),
      tx.mediaRealReference.findMany({ where: { scope: { startsWith: scopePrefix } }, select: { id: true, scope: true } }),
      tx.mediaRealQuote.findMany({ where: { scope: { startsWith: scopePrefix } }, select: { id: true, scope: true } }),
    ]);
    const taskRunIds = taskRuns.map(({ id }) => id);
    const usageRows = await tx.computeUsageRecord.findMany({ where: { enterpriseId, sessionId: { not: null } }, select: { sessionId: true } });
    const evidenceSessionIds = usageRows.flatMap(({ sessionId }) => sessionId ? [sessionId] : []);
    const unambiguousMembers = members.filter(({ user }) => user.memberships.length === 1);
    const legacySessionCandidates = unambiguousMembers.length
      ? await tx.conversationSession.findMany({ where: {
        userId: { in: unambiguousMembers.map(({ userId }) => userId) },
        createdAt: { gte: new Date(Math.min(...unambiguousMembers.map(({ createdAt }) => createdAt.getTime()))) },
      }, select: { id: true, userId: true, createdAt: true } })
      : [];
    const joinedAtByUser = new Map(unambiguousMembers.map(({ userId, createdAt }) => [userId, createdAt]));
    const eligibleLegacySessionIds = legacySessionCandidates
      .filter(({ userId, createdAt }) => createdAt >= joinedAtByUser.get(userId)!)
      .map(({ id }) => id);
    const attributedSessions = await tx.conversationSession.findMany({ where: { OR: [
      { enterpriseId },
      ...(taskRunIds.length ? [{ taskPlanId: { in: taskRunIds } }] : []),
      ...(evidenceSessionIds.length ? [{ id: { in: evidenceSessionIds } }] : []),
      ...(eligibleLegacySessionIds.length ? [{ id: { in: eligibleLegacySessionIds } }] : []),
    ] }, select: { id: true } });
    return {
      enterpriseId,
      documentStoragePaths: [...documents, ...documentVersions]
        .flatMap(({ storagePath }) => storagePath ? [storagePath] : []),
      skillPackageKeys: versions.flatMap(({ packageKey }) => packageKey ? [packageKey] : []),
      conversationSessionIds: attributedSessions.map(({ id }) => id),
      taskRuns: taskRuns.map(({ id, status, createdAt, completedAt }) => ({ id, status, createdAt: createdAt.toISOString(), completedAt: completedAt?.toISOString() ?? null })),
      computeUsage: {
        count: usage._count._all,
        costCNY: usage._sum.costCNY?.toString() ?? '0',
        walletPaidCNY: usage._sum.walletPaidCNY?.toString() ?? '0',
        personalPaidCNY: usage._sum.personalPaidCNY?.toString() ?? '0',
      },
      mediaReservations: reservations.map((row) => ({ receiptId: row.receiptId, status: row.status,
        reservedCny: row.reservedCny.toString(), settledCny: row.settledCny?.toString() ?? null,
        releasedPersonalCny: row.status === 'RESERVED' ? row.personalCny.toString() : '0' })),
      mediaRequests: [
        ...gatewayRequests.map(({ id, status, createdAt }) => ({ id, kind: 'MOCK', status, createdAt: createdAt.toISOString() })),
        ...realRequests.map(({ id, status, createdAt }) => ({ id, kind: 'REAL', status, createdAt: createdAt.toISOString() })),
      ],
      scopedMedia: [
        ...[gatewayReferences, gatewayQuotes, realReferences, realQuotes].flatMap((rows) => rows.map(({ id, scope }) => ({ scope, ids: [id] }))),
        ...[...gatewayRequests, ...realRequests].map(({ id, scope, referenceIds, receipt }) => {
          const outputs = Array.isArray((receipt as Prisma.JsonObject).outputs) ? (receipt as Prisma.JsonObject).outputs as Prisma.JsonArray : [];
          const outputIds = outputs.flatMap((output) => {
            if (typeof output !== 'object' || output === null || Array.isArray(output)) return [];
            const outputId = (output as Prisma.JsonObject).outputId;
            return typeof outputId === 'string' ? [outputId] : [];
          });
          return { scope, ids: [...new Set([id, ...referenceIds, ...outputIds])] };
        }),
      ],
    };
  }

  async releaseReservedMedia(enterpriseId: string): Promise<EnterpriseDeletionManifest['mediaReservations']> {
    const reservations = await this.prisma.mediaRealBillingReservation.findMany({
      where: { enterpriseId, status: 'RESERVED' },
      select: { receiptId: true },
    });
    for (const { receiptId } of reservations) {
      await this.mediaBilling.release(receiptId);
    }
    const rows = await this.prisma.mediaRealBillingReservation.findMany({ where: { enterpriseId },
      select: { receiptId: true, status: true, reservedCny: true, settledCny: true, personalCny: true } });
    return rows.map((row) => ({ receiptId: row.receiptId, status: row.status, reservedCny: row.reservedCny.toString(),
      settledCny: row.settledCny?.toString() ?? null, releasedPersonalCny: row.status === 'RELEASED' ? row.personalCny.toString() : '0' }));
  }

  async deleteDatabase(tx: Prisma.TransactionClient, enterpriseId: string, _manifest: EnterpriseDeletionManifest): Promise<void> {
    await tx.conversationSession.deleteMany({ where: { id: { in: _manifest.conversationSessionIds } } });
    await tx.taskRun.deleteMany({ where: { enterpriseId } });
    await tx.taskTemplate.deleteMany({ where: { enterpriseId } });
    await tx.mediaGatewayRequest.deleteMany({ where: { enterpriseId } });
    await tx.mediaRealRequest.deleteMany({ where: { enterpriseId } });
    await tx.mediaRealBillingReservation.deleteMany({ where: { enterpriseId } });
    await tx.mediaGatewayReference.deleteMany({ where: { scope: { startsWith: `[${JSON.stringify(enterpriseId)},` } } });
    await tx.mediaGatewayQuote.deleteMany({ where: { scope: { startsWith: `[${JSON.stringify(enterpriseId)},` } } });
    await tx.mediaRealReference.deleteMany({ where: { scope: { startsWith: `[${JSON.stringify(enterpriseId)},` } } });
    await tx.mediaRealQuote.deleteMany({ where: { scope: { startsWith: `[${JSON.stringify(enterpriseId)},` } } });
    await tx.enterpriseSkillDefault.deleteMany({ where: { enterpriseId } });
    await tx.subscriptionSkillVersion.deleteMany({ where: { subscription: { enterpriseId } } });
    await tx.department.updateMany({ where: { enterpriseId }, data: { parentId: null } });
    await tx.capability.updateMany({ where: { enterpriseId, visibility: 'MARKET_PUBLIC' }, data: { enterpriseId: null } });
    await tx.capability.deleteMany({ where: {
      enterpriseId,
      visibility: 'ENTERPRISE_PRIVATE',
      skillVersions: { none: { scope: 'PERSONAL' } },
    } });
    await tx.enterprise.delete({ where: { id: enterpriseId } });
  }

  async cleanupFiles(enterpriseId: string, manifest: EnterpriseDeletionManifest): Promise<void> {
    await this.storage.deleteEnterpriseFiles(enterpriseId);
    const privateStorage = new KnowledgePrivateStorage();
    for (const key of new Set(manifest.documentStoragePaths)) {
      const [document, version] = await Promise.all([
        this.prisma.document.count({ where: { storagePath: key } }),
        this.prisma.documentVersion.count({ where: { storagePath: key } }),
      ]);
      if (!document && !version) await privateStorage.remove(key);
    }
    for (const key of new Set(manifest.skillPackageKeys)) {
      const remainingReferences = await this.prisma.skillVersion.count({ where: { packageKey: key } });
      if (!remainingReferences) await this.storage.delete(key);
    }
  }

  async cleanupMediaCaches(manifest: EnterpriseDeletionManifest): Promise<void> {
    const scopeIds = new Map<string, Set<string>>();
    for (const row of manifest.scopedMedia) {
      const ids = scopeIds.get(row.scope) ?? new Set<string>();
      for (const id of row.ids) ids.add(id);
      scopeIds.set(row.scope, ids);
    }
    const enterprisePrefix = `[${JSON.stringify(manifest.enterpriseId)},`;
    for (const [scope, ids] of scopeIds) {
      if (!scope.startsWith(enterprisePrefix)) continue;
      for (const id of ids) {
        await Promise.all([
          this.byteCache.remove('reference', scope, id),
          this.byteCache.remove('output', scope, id),
          this.videoCache.removeScoped(scope, id),
        ]);
      }
    }
  }
}
