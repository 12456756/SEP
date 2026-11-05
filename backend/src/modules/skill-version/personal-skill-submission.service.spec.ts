import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { EnterpriseContext } from '../enterprise/enterprise-context.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SubmitPersonalSkillVersionDtoSchema } from 'shared';
import { Prisma } from '@prisma/client';
import { PERSONAL_SUBMISSION_SELECT, PersonalSkillSubmissionService } from './personal-skill-submission.service';
import { PERSONAL_REVIEW_RELATIONS } from './enterprise-skill-review.service';

describe('PersonalSkillSubmissionService', () => {
  const ctx: EnterpriseContext = {
    enterpriseId: 'ent-1', memberId: 'member-1', departmentId: 'dept-1', role: 'ENTERPRISE_ADMIN',
  };
  const dto = {
    capabilityId: 'cap-1', parentVersionId: 'platform-v1',
    content: '---\r\nname: exact-source\r\n---\r\n\r\n# Body  \r\n',
    changeSummary: 'Update instructions',
  };
  const parent = {
    id: 'platform-v1', capabilityId: 'cap-1', scope: 'PLATFORM',
    status: 'PLATFORM_APPROVED', enterpriseId: null, ownerId: null,
  };
  const query = { status: 'PENDING_ENTERPRISE_REVIEW' as const, page: 2, limit: 10 };
  const submissionSelect = {
    id: true, capabilityId: true, parentVersionId: true, enterpriseId: true,
    ownerId: true, scope: true, version: true, status: true, changeSummary: true,
    submittedAt: true, enterpriseReviewedAt: true, rejectionReason: true,
    createdAt: true, updatedAt: true,
  };
  const reviewSelect = {
    ...submissionSelect,
    ...PERSONAL_REVIEW_RELATIONS,
    capability: { select: { id: true, name: true, description: true } },
    owner: { select: { id: true, name: true, email: true } },
  };


  function build(context: EnterpriseContext = ctx) {
    const skillVersion = {
      findUnique: jest.fn().mockImplementation(async ({ where }) => where.id === parent.id ? parent : null),
      upsert: jest.fn().mockImplementation(async ({ create }) => create),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      skillVersion,
      subscription: { findFirst: jest.fn().mockResolvedValue({ id: 'sub-1' }) },
      skillVersionReview: { create: jest.fn().mockResolvedValue({ id: 'review-1' }) },
      memberSkillVersionSelection: { upsert: jest.fn(), updateMany: jest.fn() },
      subscriptionSkillVersion: { upsert: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (operation) =>
      typeof operation === 'function' ? operation(prisma) : Promise.all(operation));
    const enterpriseContext = {
      resolve: jest.fn().mockResolvedValue(context),
      assertEnterpriseAdmin: jest.fn((value: EnterpriseContext) =>
        EnterpriseContextService.prototype.assertEnterpriseAdmin(value)),
    };
    const reviewsService = { review: jest.fn() };
    const service = new PersonalSkillSubmissionService(prisma as never, enterpriseContext as never, reviewsService as never);
    return { service, prisma, enterpriseContext, reviewsService };
  }

  it('keeps the shared receipt whitelist free of body and relation fields', () => {
    expect(PERSONAL_SUBMISSION_SELECT).toEqual(submissionSelect);
  });

  describe('submit', () => {
    it('preserves frontmatter, CRLF and trailing whitespace through validation and persistence', async () => {
      const { service, prisma } = build();
      const validated = SubmitPersonalSkillVersionDtoSchema.parse(dto);
      const result = await service.submit('user-1', 'request-key-00001', validated);

      expect(result.content).toBe(dto.content);
      expect(prisma.skillVersion.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: {},
        select: expect.objectContaining({ ...submissionSelect, content: true }),
        create: expect.objectContaining({
          content: dto.content, parentVersionId: parent.id, ownerId: 'user-1', createdById: 'user-1',
          enterpriseId: ctx.enterpriseId, scope: 'PERSONAL', status: 'PENDING_ENTERPRISE_REVIEW',
        }),
      }));
    });

    it('returns the same saved record on a retry without creating or reviewing it again', async () => {
      const { service, prisma } = build();
      const saved = await service.submit('user-1', 'request-key-00001', dto);
      prisma.skillVersion.findUnique.mockResolvedValue(saved);
      saved.status = 'ENTERPRISE_APPROVED';

      await expect(service.submit('user-1', 'request-key-00001', dto)).resolves.toMatchObject(saved);
      expect(prisma.skillVersion.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.skillVersionReview.create).not.toHaveBeenCalled();
    });

    it('returns a null publication link for a newly saved client version without changing enterprise defaults', async () => {
      const { service, prisma, reviewsService } = build();
      await expect(service.submit('user-1', 'request-key-00001', dto)).resolves.toMatchObject({
        scope: 'PERSONAL', status: 'PENDING_ENTERPRISE_REVIEW', publishedVersionId: null,
      });
      expect(reviewsService.review).not.toHaveBeenCalled();
      expect(prisma.subscriptionSkillVersion.upsert).not.toHaveBeenCalled();
    });

    it('returns the enterprise publication link on an idempotent retry after review', async () => {
      const { service, prisma } = build();
      prisma.skillVersion.findUnique.mockResolvedValue({
        ...dto, id: 'submitted-v1', status: 'ENTERPRISE_APPROVED',
        adoptedInto: [{ targetVersionId: 'enterprise-v2', adoptedAt: new Date() }], reviewSnapshots: [],
      });
      const receipt = await service.submit('user-1', 'request-key-00001', dto);
      expect(receipt).toMatchObject({ id: 'submitted-v1', status: 'ENTERPRISE_APPROVED', publishedVersionId: 'enterprise-v2' });
      expect(receipt).not.toHaveProperty('adoptedInto');
      expect(receipt).not.toHaveProperty('reviewSnapshots');
      expect(prisma.skillVersion.upsert).not.toHaveBeenCalled();
    });

    it.each([
      { content: 'changed' }, { capabilityId: 'cap-2' },
      { parentVersionId: 'platform-v2' }, { changeSummary: 'different summary' },
    ])('rejects reuse of a key with different submitted fields: %j', async (change) => {
      const { service, prisma } = build();
      const saved = await service.submit('user-1', 'request-key-00001', dto);
      prisma.skillVersion.findUnique.mockResolvedValue(saved);

      await expect(service.submit('user-1', 'request-key-00001', { ...dto, ...change }))
        .rejects.toBeInstanceOf(ConflictException);
      expect(prisma.skillVersion.upsert).toHaveBeenCalledTimes(1);
    });

    it('treats an omitted summary as the persisted null on retries', async () => {
      const { service, prisma } = build();
      const withoutSummary = { ...dto, changeSummary: undefined };
      const saved = await service.submit('user-1', 'request-key-00001', withoutSummary);
      prisma.skillVersion.findUnique.mockResolvedValue(saved);

      expect(saved.changeSummary).toBeNull();
      await expect(service.submit('user-1', 'request-key-00001', withoutSummary)).resolves.toMatchObject(saved);
    });

    it('uses independent idempotency namespaces for users and enterprises', async () => {
      const first = await build().service.submit('user-1', 'request-key-00001', dto);
      const second = await build().service.submit('user-2', 'request-key-00001', dto);
      const third = await build({ ...ctx, enterpriseId: 'ent-2' }).service
        .submit('user-1', 'request-key-00001', dto);
      expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    });

    it.each([false, true])('checks the row returned by an upsert after a concurrent insert (conflict=%s)', async (conflict) => {
      const { service, prisma } = build();
      const concurrent = {
        ...dto, id: 'concurrent-result', content: conflict ? 'different concurrent body' : dto.content,
      };
      prisma.skillVersion.upsert.mockResolvedValue(concurrent);

      const submission = service.submit('user-1', 'request-key-00001', dto);
      if (conflict) await expect(submission).rejects.toBeInstanceOf(ConflictException);
      else await expect(submission).resolves.toMatchObject(concurrent);
      expect(prisma.skillVersion.upsert).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('recovers a Prisma P2002 race and verifies the winning payload (conflict=%s)', async (conflict) => {
      const { service, prisma } = build();
      const winner = { ...dto, id: 'winner', content: conflict ? 'another request' : dto.content };
      prisma.skillVersion.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(parent).mockResolvedValueOnce(winner);
      prisma.skillVersion.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002', clientVersion: '6',
      }));
      const result = service.submit('user-1', 'request-key-00001', dto);
      if (conflict) await expect(result).rejects.toBeInstanceOf(ConflictException);
      else await expect(result).resolves.toMatchObject(winner);
    });

    it.each([
      { scope: 'ENTERPRISE', enterpriseId: 'ent-other', status: 'ENTERPRISE_APPROVED' },
      { scope: 'ENTERPRISE', enterpriseId: 'ent-1', status: 'DRAFT' },
      { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-other' },
      { scope: 'PERSONAL', enterpriseId: 'ent-other', ownerId: 'user-1' },
      { scope: 'PLATFORM', status: 'DRAFT' },
    ])('conceals an inaccessible source version: %j', async (source) => {
      const { service, prisma } = build();
      prisma.skillVersion.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...parent, ...source });

      await expect(service.submit('user-1', 'request-key-00001', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.skillVersion.upsert).not.toHaveBeenCalled();
    });

    it.each([
      { scope: 'ENTERPRISE', enterpriseId: 'ent-1', status: 'ENTERPRISE_APPROVED' },
      { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1', status: 'PERSONAL_ACTIVE' },
      { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1', status: 'PENDING_ENTERPRISE_REVIEW' },
      { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1', status: 'ENTERPRISE_REJECTED' },
      { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1', status: 'ENTERPRISE_APPROVED' },
    ])('accepts the current enterprise publication or the caller personal source: %j', async (source) => {
      const { service, prisma } = build();
      prisma.skillVersion.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...parent, ...source });
      await expect(service.submit('user-1', 'request-key-00001', dto)).resolves.toMatchObject({
        parentVersionId: dto.parentVersionId, scope: 'PERSONAL',
      });
    });

    it('rejects an accessible source belonging to a different capability', async () => {
      const { service, prisma } = build();
      prisma.skillVersion.findUnique.mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...parent, capabilityId: 'cap-other' });

      await expect(service.submit('user-1', 'request-key-00001', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.skillVersion.upsert).not.toHaveBeenCalled();
    });
  });

  describe('authorization and version listing', () => {
    it('requires an active, unexpired subscription and grant before saving a client version', async () => {
      const { service, prisma } = build();
      prisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.submit('user-1', 'request-key-00001', dto)).rejects.toBeInstanceOf(NotFoundException);

      const { where } = prisma.subscription.findFirst.mock.calls[0][0];
      expect(where).toEqual({
        enterpriseId: 'ent-1', status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }],
        employee: { bindings: { some: { capabilityId: 'cap-1', enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
        grants: { some: {
          OR: [{ memberId: 'member-1' }, { departmentId: 'dept-1' }],
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }],
        } },
      });
      expect(where.OR[1].endDate.gt).toEqual(where.grants.some.AND[0].OR[1].expiresAt.gt);
      expect(prisma.skillVersion.findUnique).not.toHaveBeenCalled();
      expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
    });

    it('does not match department-wide grants when the member has no department', async () => {
      const { service, prisma } = build({ ...ctx, departmentId: null });
      await service.submit('user-1', 'request-key-00001', dto);
      expect(prisma.subscription.findFirst.mock.calls[0][0].where.grants.some.OR)
        .toEqual([{ memberId: 'member-1' }]);
    });

    it('allows an ungranted member to list retained enterprise publications without permission to modify the skill', async () => {
      const { service, prisma } = build({ ...ctx, role: 'MEMBER' });
      prisma.subscription.findFirst.mockResolvedValue(null);
      prisma.skillVersion.findFirst.mockResolvedValue({ id: 'retained-version' });
      await expect(service.list('user-1', 'cap-1')).resolves.toEqual([]);
      expect(prisma.subscription.findFirst).toHaveBeenCalledWith({ where: {
        enterpriseId: 'ent-1', status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }],
        employee: { bindings: { some: { capabilityId: 'cap-1', enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
        grants: { some: {
          OR: [{ memberId: 'member-1' }, { departmentId: 'dept-1' }],
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }],
        } },
      }, select: { id: true } });
      expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith({ where: {
        capabilityId: 'cap-1', enterpriseId: 'ent-1', scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED',
      }, select: { id: true } });
      await expect(service.submit('user-1', 'request-key-00001', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.skillVersion.upsert).not.toHaveBeenCalled();
    });

    it.each(['MEMBER', 'DEPT_MANAGER'] as const)(
      'requires active member-only grants for %s listing when there is no department', async (role) => {
        const { service, prisma } = build({ ...ctx, role, departmentId: null });
        await service.list('user-1', 'cap-1');
        const { where } = prisma.subscription.findFirst.mock.calls[0][0];
        expect(where.grants).toEqual({ some: { OR: [{ memberId: 'member-1' }],
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }],
        } });
        expect(where.OR[1].endDate.gt).toEqual(where.grants.some.AND[0].OR[1].expiresAt.gt);
      },
    );

    it('does not reveal an ungranted skill without a retained enterprise publication', async () => {
      const { service, prisma } = build({ ...ctx, role: 'MEMBER' });
      prisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.list('user-1', 'cap-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
    });

    it('allows administrators to enumerate enterprise bindings without a personal grant', async () => {
      const { service, prisma } = build();
      await service.list('admin-1', 'cap-1');
      expect(prisma.subscription.findFirst.mock.calls[0][0].where).not.toHaveProperty('grants');
    });

    it('lists retained enterprise publications after subscriptions expire and hides skills with no enterprise record', async () => {
      const { service, prisma } = build();
      prisma.subscription.findFirst.mockResolvedValue(null);
      prisma.skillVersion.findFirst.mockResolvedValueOnce({ id: 'retained-version' });
      await expect(service.list('user-1', 'cap-1')).resolves.toEqual([]);
      expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith({ where: {
        capabilityId: 'cap-1', enterpriseId: 'ent-1', scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED',
      }, select: { id: true } });
      prisma.skillVersion.findMany.mockClear();
      await expect(service.list('user-1', 'foreign-capability')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
    });

    it('lists only released platform and current enterprise versions plus caller personal versions', async () => {
      const { service, prisma } = build();
      await service.list('user-1', 'cap-1', 'ENTERPRISE_APPROVED');
      const { where, select } = prisma.skillVersion.findMany.mock.calls[0][0];
      expect(where).toEqual({
        capabilityId: 'cap-1', status: 'ENTERPRISE_APPROVED', OR: [
          { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
          { scope: 'ENTERPRISE', enterpriseId: 'ent-1', status: 'ENTERPRISE_APPROVED' },
          { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1' },
        ],
      });
      expect(select).toEqual({ ...submissionSelect, ...PERSONAL_REVIEW_RELATIONS });
    });
  });

  describe('enterprise review', () => {
    const updatedAt = new Date('2026-10-09T08:00:00.000Z');
    const row = (id: string, status: string, overrides = {}) => ({
      id, status, updatedAt, enterpriseReviewedAt: null, rejectionReason: null,
      adoptedInto: [], reviewSnapshots: [], ...overrides,
    });

    it.each(['MEMBER', 'DEPT_MANAGER'] as const)('denies %s access to the unified queue', async (role) => {
      const { service, prisma } = build({ ...ctx, role });
      await expect(service.reviews('user-1', query)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('derives Web and client review states before applying pagination and total', async () => {
      const { service, prisma } = build();
      prisma.skillVersion.findMany.mockResolvedValue([
        row('web-pending', 'PERSONAL_ACTIVE'),
        row('client-approved', 'ENTERPRISE_APPROVED', {
          adoptedInto: [{ targetVersionId: 'enterprise-1', adoptedAt: updatedAt }],
        }),
        row('client-pending', 'PENDING_ENTERPRISE_REVIEW', { submittedAt: updatedAt }),
        row('client-rejected', 'ENTERPRISE_REJECTED'),
      ]);
      const result = await service.reviews('admin-1', { ...query, capabilityId: 'cap-1', limit: 1 });
      expect(result).toMatchObject({
        total: 2, items: [{ id: 'client-pending', reviewStatus: 'PENDING_ENTERPRISE_REVIEW', pending: true, reviewedBy: null }],
        page: 2, limit: 1,
      });
      expect(prisma.skillVersion.findMany).toHaveBeenCalledWith({
        where: {
          enterpriseId: 'ent-1', scope: 'PERSONAL', workingCopyId: null,
          status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
          capabilityId: 'cap-1',
        },
        select: reviewSelect, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      expect(prisma.skillVersion.count).not.toHaveBeenCalled();
    });

    it.each(['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] as const)(
      'uses only the receipt and safe relation whitelist for %s queue items', async (status) => {
        const { service, prisma } = build();
        await service.reviews('admin-1', { ...query, status });
        expect(prisma.skillVersion.findMany).toHaveBeenCalledWith({
          where: {
            enterpriseId: 'ent-1', scope: 'PERSONAL', workingCopyId: null,
            status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
          },
          select: reviewSelect, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        });
        expect(reviewSelect).not.toHaveProperty('content');
      },
    );

    it('returns the published enterprise ID and hides raw review relations in the caller list', async () => {
      const { service, prisma } = build();
      prisma.skillVersion.findMany.mockResolvedValue([
        row('client-approved', 'ENTERPRISE_APPROVED', {
          adoptedInto: [{ targetVersionId: 'enterprise-v2', adoptedAt: updatedAt }],
        }),
        row('client-pending', 'PENDING_ENTERPRISE_REVIEW'),
      ]);
      const versions = await service.list('user-1', 'cap-1');
      expect(versions).toMatchObject([
        { id: 'client-approved', publishedVersionId: 'enterprise-v2' },
        { id: 'client-pending', publishedVersionId: null },
      ]);
      for (const version of versions) {
        expect(version).not.toHaveProperty('adoptedInto');
        expect(version).not.toHaveProperty('reviewSnapshots');
      }
    });

    it('lists reviewed Web snapshots by derived state without publishing the editable working copy', async () => {
      const { service, prisma } = build();
      prisma.skillVersion.findMany.mockResolvedValue([
        row('web-copy', 'PERSONAL_ACTIVE', { reviewSnapshots: [{
          id: 'snapshot', status: 'ENTERPRISE_APPROVED', createdAt: updatedAt,
          workingCopyUpdatedAt: updatedAt, enterpriseReviewedBy: { id: 'admin-1', name: 'Reviewer' },
          enterpriseReviewedAt: updatedAt, rejectionReason: null,
          adoptedInto: [{ targetVersionId: 'enterprise-v2', adoptedAt: updatedAt }],
        }] }),
      ]);
      await expect(service.reviews('admin-1', { ...query, page: 1, status: 'ENTERPRISE_APPROVED' }))
        .resolves.toMatchObject({ total: 1, items: [{ id: 'web-copy', status: 'PERSONAL_ACTIVE',
          reviewStatus: 'ENTERPRISE_APPROVED', publishedVersionId: 'enterprise-v2', pending: false,
          reviewedBy: { id: 'admin-1', name: 'Reviewer' } }] });
    });

    it.each(['ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] as const)(
      'returns the client record reviewer for %s without requiring a Web snapshot', async (status) => {
        const { service, prisma } = build();
        const reviewer = { id: 'admin-1', name: null };
        prisma.skillVersion.findMany.mockResolvedValue([row('client-reviewed', status, {
          enterpriseReviewedBy: reviewer,
          adoptedInto: status === 'ENTERPRISE_APPROVED'
            ? [{ targetVersionId: 'enterprise-v2', adoptedAt: updatedAt }] : [],
        })]);
        await expect(service.reviews('admin-1', { ...query, page: 1, status }))
          .resolves.toMatchObject({ total: 1, items: [{ id: 'client-reviewed', reviewedBy: reviewer }] });
        expect(reviewSelect.enterpriseReviewedBy).toEqual({ select: { id: true, name: true } });
        expect(reviewSelect.reviewSnapshots.select.enterpriseReviewedBy)
          .toEqual({ select: { id: true, name: true } });
      },
    );

    it('does not attribute an older Web snapshot reviewer to an edited pending revision', async () => {
      const { service, prisma } = build();
      prisma.skillVersion.findMany.mockResolvedValue([row('edited-copy', 'PERSONAL_ACTIVE', {
        reviewSnapshots: [{
          id: 'old-snapshot', status: 'ENTERPRISE_APPROVED', createdAt: new Date(updatedAt.getTime() + 1),
          workingCopyUpdatedAt: new Date(updatedAt.getTime() - 1),
          enterpriseReviewedAt: updatedAt, rejectionReason: null,
          enterpriseReviewedBy: { id: 'admin-1', name: 'Previous reviewer' },
          adoptedInto: [{ targetVersionId: 'enterprise-v2', adoptedAt: updatedAt }],
        }],
      })]);
      await expect(service.reviews('admin-1', { ...query, page: 1 }))
        .resolves.toMatchObject({ total: 1, items: [{ id: 'edited-copy', pending: true,
          reviewStatus: 'PENDING_ENTERPRISE_REVIEW', publishedVersionId: null, reviewedBy: null }] });
    });

    it('marks legacy approved but unpublished client records without silently publishing them', async () => {
      const { service, prisma } = build();
      prisma.skillVersion.findMany.mockResolvedValue([row('legacy', 'ENTERPRISE_APPROVED')]);
      await expect(service.reviews('admin-1', { ...query, page: 1, status: 'ENTERPRISE_APPROVED' }))
        .resolves.toMatchObject({ total: 1, items: [{ id: 'legacy', isLegacyUnpublished: true,
          publishedVersionId: null, pending: true }] });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each(['APPROVE', 'REJECT'] as const)('delegates %s with the exact actor and concurrency token', async (decision) => {
      const { service, prisma, reviewsService } = build();
      const input = { decision, comment: 'Review feedback', expectedUpdatedAt: updatedAt.toISOString() };
      const receipt = { id: 'submitted-v1', publishedVersionId: decision === 'APPROVE' ? 'enterprise-v2' : null };
      reviewsService.review.mockResolvedValue(receipt);
      await expect(service.review('admin-1', 'submitted-v1', input)).resolves.toBe(receipt);
      expect(reviewsService.review).toHaveBeenCalledWith('admin-1', 'submitted-v1', input);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.skillVersion.updateMany).not.toHaveBeenCalled();
      expect(prisma.skillVersionReview.create).not.toHaveBeenCalled();
    });

    it.each([ForbiddenException, NotFoundException, ConflictException])(
      'propagates unified review authorization, tenant and concurrency errors %p', async (Exception) => {
        const { service, prisma, reviewsService } = build();
        const error = new Exception('Review denied');
        reviewsService.review.mockRejectedValue(error);
        await expect(service.review('user-1', 'submitted-v1', { decision: 'APPROVE' })).rejects.toBe(error);
        expect(reviewsService.review).toHaveBeenCalledWith('user-1', 'submitted-v1', { decision: 'APPROVE' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });
});
