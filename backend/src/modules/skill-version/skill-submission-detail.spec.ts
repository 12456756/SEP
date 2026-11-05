import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EnterpriseSkillVersionController } from './skill-version.controller';
import { SkillVersionService } from './skill-version.service';

const ctx = { enterpriseId: 'ent-1', memberId: 'member-1', departmentId: null, role: 'ENTERPRISE_ADMIN' };
const date = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T08:00:00Z`);
const platform = { id: 'platform', capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
  enterpriseId: null, version: '1.0.0', content: '# Source', createdAt: date(1), updatedAt: date(1),
  promotedVersions: [], reviews: [] };
const published = { ...platform, id: 'published', scope: 'ENTERPRISE', enterpriseId: 'ent-1',
  status: 'ENTERPRISE_APPROVED', version: '1.1.0', content: '# Published' };
function personal(id = 'submission', overrides: Record<string, unknown> = {}) {
  return { ...platform, id, scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1',
    owner: { id: 'user-1', name: 'Member', email: 'member@example.test' },
    content: '---\r\nname: skill\r\n---\r\n# Submitted\r\n', status: 'PENDING_ENTERPRISE_REVIEW',
    version: '0.0.0-personal.test', parentVersionId: 'platform',
    parentVersion: { id: 'platform', scope: 'PLATFORM', version: '1.0.0' },
    workingCopyId: null, workingCopyUpdatedAt: null, submittedAt: date(2),
    enterpriseReviewedAt: null, enterpriseReviewedBy: null, rejectionReason: null,
    changeSummary: 'Change', adoptedInto: [], reviewSnapshots: [], reviews: [], ...overrides };
}
function review(id: string, versionId: string, day: number, actorType = 'ENTERPRISE') {
  return { id, versionId, actorType, decision: 'APPROVE', comment: id, createdAt: date(day),
    reviewer: { id: 'admin', name: 'Admin' } };
}
function build(role = 'ENTERPRISE_ADMIN') {
  const root = personal();
  const prisma = {
    skillVersion: {
      findFirst: jest.fn().mockImplementation(async ({ where }) => {
        if (where.id === root.id) return root;
        if (where.id === platform.id) return platform;
        if (where.id === published.id) return published;
        if (where.scope === 'PLATFORM') return platform;
        return null;
      }),
      findMany: jest.fn().mockImplementation(async ({ where }) => {
        if (where.scope === 'ENTERPRISE') return [published];
        if (where.id?.in) return [root];
        if (where.scope === 'PERSONAL') return [root];
        return [platform, published];
      }),
    },
    subscription: {
      findFirst: jest.fn().mockResolvedValue({ id: 'sub-1' }),
      findUnique: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', employee: { bindings: [{ defaultSkillVersion: platform }] } }),
      findMany: jest.fn().mockResolvedValue([{ id: 'sub-1', employee: { id: 'employee-1', name: 'Employee' },
        skillVersionSelections: [], grants: [{ id: 'grant-1' }] }]),
    },
    subscriptionSkillVersion: { findUnique: jest.fn().mockResolvedValue(null) },
    capability: { findUnique: jest.fn().mockResolvedValue({ id: 'cap-1', name: 'Skill', description: '', status: 'APPROVED' }) },
    skillVersionAdoption: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const defaults = { get: jest.fn().mockResolvedValue(null) };
  const context = { resolve: jest.fn().mockResolvedValue({ ...ctx, role }) };
  const service = new SkillVersionService(prisma as never, context as never, defaults as never);
  const detail = (userId = 'user-1', id = root.id) => service.getSubmissionDetail(userId, 'cap-1', id);
  return { prisma, defaults, service, root, detail };
}

describe('enterprise submission detail read contract', () => {
  it('registers the capability-scoped read route under JwtAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, EnterpriseSkillVersionController)).toContain(JwtAuthGuard);
    const method = (EnterpriseSkillVersionController.prototype as unknown as Record<string, unknown>).getSubmissionDetail;
    expect(method).toBeDefined();
    expect(Reflect.getMetadata(PATH_METADATA, method as object)).toBe('capabilities/:capabilityId/submissions/:id');
  });

  it('preserves the body and review state, aggregates root/snapshot ENTERPRISE reviews with revisions', async () => {
    const { root, detail, defaults } = build();
    Object.assign(root, { status: 'PERSONAL_ACTIVE', updatedAt: date(5), submittedAt: null,
      reviews: [review('root-review', root.id, 3), review('platform-secret', root.id, 7, 'PLATFORM')],
      reviewSnapshots: [
        { ...personal('snapshot-new'), workingCopyId: root.id, workingCopyUpdatedAt: date(5),
          status: 'ENTERPRISE_APPROVED', createdAt: date(6), enterpriseReviewedAt: date(6),
          adoptedInto: [{ targetVersionId: published.id, adoptedAt: date(6) }],
          reviews: [review('snapshot-review', 'snapshot-new', 6)] },
        { ...personal('snapshot-old'), workingCopyId: root.id, workingCopyUpdatedAt: date(2),
          status: 'ENTERPRISE_REJECTED', createdAt: date(4), enterpriseReviewedAt: date(4),
          reviews: [review('old-review', 'snapshot-old', 4)] },
      ] });
    defaults.get.mockResolvedValue({ versionId: published.id, selectedAt: date(6), version: published });
    const result = await detail();
    expect(result.item).toMatchObject({ id: root.id, version: root.version, content: root.content,
      reviewStatus: 'ENTERPRISE_APPROVED', pending: false, publishedVersionId: published.id,
      publishedVersion: { id: published.id, scope: 'ENTERPRISE', version: '1.1.0', isCurrent: true } });
    expect(result.source).toEqual({ id: platform.id, scope: 'PLATFORM', version: '1.0.0', content: platform.content });
    expect(result.sourceState).toBe('AVAILABLE');
    expect(result.currentBaseline).toEqual({ id: published.id, scope: 'ENTERPRISE', version: '1.1.0', content: published.content });
    expect(result.currentBaselineState).toBe('EXPLICIT');
    expect(result.reviews.map((row: any) => [row.id, row.versionId, row.workingCopyUpdatedAt])).toEqual([
      ['root-review', root.id, null], ['old-review', 'snapshot-old', date(2)], ['snapshot-review', 'snapshot-new', date(5)],
    ]);
    expect(result.reviews.map((row) => [row.version, row.changeSummary, row.publishedVersion])).toEqual([
      [root.version, root.changeSummary, null], [root.version, root.changeSummary, null],
      [root.version, root.changeSummary, { id: published.id, scope: 'ENTERPRISE', version: published.version, isCurrent: true }],
    ]);
    expect(JSON.stringify(result)).not.toContain('platform-secret');
  });

  it.each(['MEMBER', 'DEPT_MANAGER', 'ENTERPRISE_ADMIN'])('scopes root lookup for %s without accepting snapshot ids', async (role) => {
    const { prisma, detail } = build(role);
    await detail();
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: 'submission', capabilityId: 'cap-1', enterpriseId: 'ent-1', scope: 'PERSONAL', workingCopyId: null,
      ...(role === 'ENTERPRISE_ADMIN' ? {} : { ownerId: 'user-1' }),
    }) }));
    expect(prisma.subscription.findFirst).toHaveBeenCalled();
  });

  it('returns not-found for a foreign/missing/snapshot root before reading any private body', async () => {
    const { prisma, detail } = build('MEMBER');
    prisma.skillVersion.findFirst.mockResolvedValue(null);
    await expect(detail('user-1', 'foreign-id')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.skillVersionAdoption.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { enterpriseId: 'foreign-enterprise' }, { capabilityId: 'foreign-capability' },
    { ownerId: 'other-user' }, { workingCopyId: 'root' }, { scope: 'ENTERPRISE' }, { status: 'DRAFT' },
  ])('rejects an out-of-scope object deep link before resolving source/history: %j', async (overrides) => {
    const { prisma, detail } = build('MEMBER');
    const candidate = personal('foreign', overrides);
    prisma.skillVersion.findFirst.mockImplementation(async ({ where }) => {
      const exactFields = ['id', 'enterpriseId', 'capabilityId', 'ownerId', 'scope', 'workingCopyId'];
      return exactFields.every((key) => where[key] === candidate[key as keyof typeof candidate])
        && where.status.in.includes(candidate.status) ? candidate : null;
    });
    await expect(detail('user-1', candidate.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
    expect(prisma.subscription.findMany).not.toHaveBeenCalled();
  });

  it('stops before the submission lookup if neither a granted subscription nor retained skill permits reading', async () => {
    const { prisma, detail } = build('MEMBER');
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.skillVersion.findFirst.mockResolvedValue(null);
    await expect(detail()).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.skillVersion.findFirst.mock.calls[0][0].select).toEqual({ id: true });
    expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
  });

  it('distinguishes unauthorized source from absent source, keeping parent metadata but not its body', async () => {
    const { prisma, root, detail } = build('MEMBER');
    root.parentVersionId = 'private-source';
    root.parentVersion = { id: 'private-source', scope: 'PERSONAL', version: 'private-revision' };
    const result = await detail();
    expect(result.item.basedOn).toEqual(root.parentVersion);
    expect(result.source).toBeNull();
    expect(result.sourceState).toBe('UNREADABLE');
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: 'private-source', capabilityId: 'cap-1', OR: expect.arrayContaining([
        expect.objectContaining({ scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1' }),
      ]),
    }) }));
    Object.assign(root, { parentVersionId: null, parentVersion: null });
    expect((await detail()).sourceState).toBe('NONE');
  });

  it('does not expose snapshot reviews for another owner/tenant/capability', async () => {
    const { root, detail } = build();
    root.reviewSnapshots = [
      { ...personal('foreign'), enterpriseId: 'ent-2', workingCopyId: root.id,
        reviews: [review('secret', 'foreign', 4)] },
    ] as never;
    expect((await detail()).reviews).toEqual([]);
  });

  it('keeps every real snapshot revision and its own readable Adoption result, without borrowing the latest publication', async () => {
    const { prisma, root, detail, defaults } = build();
    const oldPublication = { ...published, id: 'old-publication', version: '1.0.1' };
    Object.assign(root, { status: 'PERSONAL_ACTIVE', updatedAt: date(8), reviewSnapshots: [
      { ...personal('snapshot-new'), version: 'revision-new', changeSummary: 'New change',
        workingCopyId: root.id, workingCopyUpdatedAt: date(8), status: 'ENTERPRISE_APPROVED', createdAt: date(9),
        adoptedInto: [{ targetVersionId: published.id, adoptedAt: date(9) }],
        reviews: [review('new-approval', 'snapshot-new', 9)] },
      { ...personal('snapshot-hidden'), version: 'revision-hidden', workingCopyId: root.id,
        status: 'ENTERPRISE_APPROVED', createdAt: date(7),
        adoptedInto: [{ targetVersionId: 'foreign-publication', adoptedAt: date(7) }],
        reviews: [review('hidden-approval', 'snapshot-hidden', 7)] },
      { ...personal('snapshot-old'), version: 'revision-old', changeSummary: 'Old change', workingCopyId: root.id,
        status: 'ENTERPRISE_APPROVED', createdAt: date(4),
        adoptedInto: [{ targetVersionId: oldPublication.id, adoptedAt: date(4) }],
        reviews: [review('old-approval', 'snapshot-old', 4), review('wrong-version', root.id, 5)] },
    ] });
    prisma.skillVersion.findMany.mockImplementation(async ({ where }) => where.scope === 'ENTERPRISE'
      ? [oldPublication, published] : [root]);
    defaults.get.mockResolvedValue({ versionId: published.id, selectedAt: date(9), version: published });
    const result = await detail();
    expect(result.reviews.map((row) => [row.versionId, row.version, row.changeSummary, row.publishedVersion?.id ?? null,
      row.publishedVersion?.isCurrent ?? null])).toEqual([
      ['snapshot-old', 'revision-old', 'Old change', 'old-publication', false],
      ['snapshot-hidden', 'revision-hidden', 'Change', null, null],
      ['snapshot-new', 'revision-new', 'New change', published.id, true],
    ]);
    const query = prisma.skillVersion.findFirst.mock.calls.find(([args]) => args.where.id === root.id)![0];
    expect(query.select.reviewSnapshots).not.toHaveProperty('take');
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      enterpriseId: 'ent-1', capabilityId: 'cap-1', scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED',
      id: { in: expect.arrayContaining([oldPublication.id, published.id, 'foreign-publication']) },
    }) }));
  });

  it('keeps the authorized source body stable across enterprise default changes', async () => {
    const { detail, defaults } = build();
    const before = await detail();
    defaults.get.mockResolvedValue({ versionId: published.id, selectedAt: date(6), version: published });
    const after = await detail();
    expect(after.source).toEqual(before.source);
    expect(after.currentBaseline?.id).not.toBe(before.currentBaseline?.id);
  });

  it('uses the real execution fallback instead of latest retained enterprise release', async () => {
    const { service, detail } = build();
    const result = await detail();
    expect(result.currentBaseline?.id).toBe(platform.id);
    expect(result.currentBaselineState).toBe('AUTOMATIC');
    expect((await service.listVersionTimeline('user-1', 'cap-1')).selectedAt).toBeNull();
  });

  it('does not select a shared baseline when subscriptions actually resolve to different versions', async () => {
    const { prisma, service, detail } = build();
    prisma.subscription.findMany.mockResolvedValue([
      { id: 'sub-1', employee: { id: 'e1', name: 'E1' }, skillVersionSelections: [], grants: [] },
      { id: 'sub-2', employee: { id: 'e2', name: 'E2' }, skillVersionSelections: [], grants: [] },
    ]);
    jest.spyOn(service, 'resolveEffectiveVersion').mockImplementation(async (id) => (id === 'sub-1' ? platform : published) as never);
    const result = await detail();
    expect(result.currentBaseline).toBeNull();
    expect(result.currentBaselineState).toBe('MIXED');
  });
});

describe('personal diffs summary and global ordering', () => {
  it('sorts pending globally before paging, then submittedAt/updatedAt descending with a stable id tie-break', async () => {
    const { prisma, defaults, service } = build();
    const rows = [
      personal('rejected', { status: 'ENTERPRISE_REJECTED', submittedAt: date(9), updatedAt: date(9) }),
      personal('pending-old', { submittedAt: date(2), updatedAt: date(8) }),
      personal('pending-new', { submittedAt: date(7), updatedAt: date(7) }),
      personal('legacy', { status: 'ENTERPRISE_APPROVED', submittedAt: date(4), updatedAt: date(4) }),
      personal('approved', { status: 'ENTERPRISE_APPROVED', submittedAt: date(5), updatedAt: date(5),
        adoptedInto: [{ targetVersionId: published.id, adoptedAt: date(6) }] }),
    ];
    prisma.skillVersion.findMany.mockImplementation(async ({ where }) => where.scope === 'ENTERPRISE' ? [published] : where.id?.in
      ? rows.filter((row) => where.id.in.includes(row.id))
      : where.scope === 'PERSONAL' ? rows : [published]);
    defaults.get.mockResolvedValue({ versionId: published.id, version: published, selectedAt: date(6) });
    const result = await service.listPersonalDiffs('user-1', 'cap-1', 1, 2) as any;
    expect(result.pendingTotal).toBe(3);
    expect(result.total).toBe(5);
    expect(result.items.map((row: any) => row.id)).toEqual(['pending-new', 'legacy']);
    const approved = await service.listPersonalDiffs('user-1', 'cap-1', 1, 20, 'ENTERPRISE_APPROVED') as any;
    expect(approved.pendingTotal).toBe(3);
    expect(approved.items.find((row: any) => row.id === 'approved').publishedVersion).toEqual({
      id: published.id, scope: 'ENTERPRISE', version: '1.1.0', isCurrent: true,
    });
  });

  it('applies the time and id tie-break across the whole status group before paginating', async () => {
    const { prisma, service } = build();
    const rows = [personal('a', { submittedAt: date(3), updatedAt: date(4) }),
      personal('c', { submittedAt: date(3), updatedAt: date(6) }),
      personal('b', { submittedAt: date(3), updatedAt: date(6) })];
    prisma.skillVersion.findMany.mockImplementation(async ({ where }) => where.id?.in
      ? rows.filter((row) => where.id.in.includes(row.id)) : rows);
    const result = await service.listPersonalDiffs('user-1', 'cap-1', 2, 1) as any;
    expect(result.items.map((row: any) => row.id)).toEqual(['b']);
    expect(result.pendingTotal).toBe(3);
  });

  it('keeps a reviewed outcome but clears isCurrent after an explicit rollback', async () => {
    const { root, service, defaults } = build();
    Object.assign(root, { status: 'ENTERPRISE_APPROVED',
      adoptedInto: [{ targetVersionId: published.id, adoptedAt: date(6) }] });
    defaults.get.mockResolvedValue({ versionId: platform.id, version: platform, selectedAt: date(8) });
    const result = await service.listPersonalDiffs('user-1', 'cap-1') as any;
    expect(result.items[0]).toMatchObject({ reviewStatus: 'ENTERPRISE_APPROVED', pending: false,
      publishedVersion: { id: published.id, isCurrent: false } });
  });

  it('counts only the visible root submissions and excludes review snapshots', async () => {
    const { prisma, service } = build('MEMBER');
    const result = await service.listPersonalDiffs('user-1', 'cap-1') as any;
    expect(result.pendingTotal).toBe(1);
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      enterpriseId: 'ent-1', capabilityId: 'cap-1', workingCopyId: null, ownerId: 'user-1',
    }) }));
  });

  it.each(['MEMBER', 'DEPT_MANAGER', 'ENTERPRISE_ADMIN'])('uses the same root/review-state/visibility rules for list and timeline pending totals (%s)', async (role) => {
    const { prisma, service } = build(role);
    const rows = [personal('own-pending'), personal('other-pending', { ownerId: 'other-user' }),
      personal('legacy-unpublished', { status: 'ENTERPRISE_APPROVED' }),
      personal('reviewed-copy', { status: 'PERSONAL_ACTIVE', updatedAt: date(4), reviewSnapshots: [{
        ...personal('review-snapshot'), workingCopyId: 'reviewed-copy', workingCopyUpdatedAt: date(4),
        status: 'ENTERPRISE_REJECTED', createdAt: date(5),
      }] }), personal('snapshot', { workingCopyId: 'own-pending' })];
    prisma.skillVersion.findMany.mockImplementation(async ({ where }) => {
      if (where.scope !== 'PERSONAL') return where.scope === 'ENTERPRISE' ? [published] : [platform];
      return rows.filter((row) => row.workingCopyId === null && (!where.ownerId || row.ownerId === where.ownerId)
        && (!where.id?.in || where.id.in.includes(row.id)));
    });
    const list = await service.listPersonalDiffs('user-1', 'cap-1', 1, 1, 'ENTERPRISE_REJECTED');
    const timeline = await service.listVersionTimeline('user-1', 'cap-1');
    expect(list.total).toBe(1);
    expect(list.pendingTotal).toBe(role === 'ENTERPRISE_ADMIN' ? 3 : 2);
    expect(timeline.pendingTotal).toBe(list.pendingTotal);
  });

  it('uses execution fallback as the list baseline and does not invent one for MIXED subscriptions', async () => {
    const { service, prisma } = build();
    expect((await service.listPersonalDiffs('user-1', 'cap-1')).baseline?.id).toBe(platform.id);
    prisma.subscription.findMany.mockResolvedValue([
      { id: 'sub-1', employee: { id: 'e1', name: 'E1' }, skillVersionSelections: [], grants: [] },
      { id: 'sub-2', employee: { id: 'e2', name: 'E2' }, skillVersionSelections: [], grants: [] },
    ]);
    jest.spyOn(service, 'resolveEffectiveVersion').mockImplementation(async (id) => (id === 'sub-1' ? platform : published) as never);
    expect((await service.listPersonalDiffs('user-1', 'cap-1')).baseline).toBeNull();
  });
});

describe('timeline read additions', () => {
  it('keeps the old collection and annotates a real automatic version without a fabricated enable date', async () => {
    const { service } = build();
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.effectiveVersionState).toBe('AUTOMATIC');
    expect(result.effectiveVersion).toEqual({ id: platform.id, scope: 'PLATFORM', version: '1.0.0' });
    expect(result.currentVersionId).toBe(platform.id);
    expect(result.selectedAt).toBeNull();
    expect(result.pendingTotal).toBe(1);
    expect(result.versions.map((row: any) => row.id)).toEqual([platform.id, published.id]);
  });

  it('reports mixed rather than promoting the first subscription selection to company default', async () => {
    const { prisma, service } = build();
    prisma.subscription.findMany.mockResolvedValue([
      { id: 'sub-1', employee: { id: 'e1', name: 'E1' }, skillVersionSelections: [{ versionId: platform.id, selectedAt: date(3) }], grants: [] },
      { id: 'sub-2', employee: { id: 'e2', name: 'E2' }, skillVersionSelections: [], grants: [] },
    ]);
    jest.spyOn(service, 'resolveEffectiveVersion').mockImplementation(async (id) => (id === 'sub-1' ? platform : published) as never);
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.effectiveVersionState).toBe('MIXED');
    expect(result.effectiveVersion).toBeNull();
    expect(result.currentVersionId).toBeNull();
    expect(result.selectedAt).toBeNull();
    expect(result.subscriptions[0].selectedAt).toBe(date(3).toISOString());
    expect(result.subscriptions[1].selectedAt).toBeNull();
  });

  it('uses persisted enterprise selection timestamps, including retained releases without subscriptions', async () => {
    const { prisma, defaults, service } = build();
    prisma.subscription.findMany.mockResolvedValue([]);
    defaults.get.mockResolvedValue({ versionId: published.id, version: published, selectedAt: date(6) });
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.effectiveVersionState).toBe('EXPLICIT');
    expect(result.effectiveVersion?.id).toBe(published.id);
    expect(result.selectedAt).toBe(date(6).toISOString());
  });

  it('reports NONE when there is no approved default or execution fallback', async () => {
    const { prisma, service } = build();
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.skillVersion.findFirst.mockResolvedValue(null);
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.effectiveVersionState).toBe('NONE');
    expect(result.effectiveVersion).toBeNull();
    expect(result.currentVersionId).toBeNull();
  });

  it.each([
    { ...published, enterpriseId: 'other-enterprise' },
    { ...published, capabilityId: 'other-capability' },
    { ...published, status: 'ENTERPRISE_REJECTED' },
    { ...published, scope: 'PERSONAL' },
  ])('rejects an invalid enterprise default and does not reuse its selection date: %j', async (version) => {
    const { defaults, service } = build();
    defaults.get.mockResolvedValue({ versionId: version.id, version, selectedAt: date(9) });
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.effectiveVersionState).toBe('AUTOMATIC');
    expect(result.effectiveVersion?.id).toBe(platform.id);
    expect(result.selectedAt).toBeNull();
    expect(result.subscriptions[0].selectedAt).toBeNull();
  });

  it('recognizes approved legacy subscription selections without losing their real timestamps', async () => {
    const { prisma, service } = build();
    prisma.subscription.findMany.mockResolvedValue([
      { id: 'sub-1', employee: { id: 'e1', name: 'E1' },
        skillVersionSelections: [{ versionId: published.id, selectedAt: date(3) }], grants: [] },
      { id: 'sub-2', employee: { id: 'e2', name: 'E2' },
        skillVersionSelections: [{ versionId: published.id, selectedAt: date(5) }], grants: [] },
    ]);
    prisma.subscriptionSkillVersion.findUnique.mockResolvedValue({ version: published });
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.effectiveVersionState).toBe('EXPLICIT');
    expect(result.effectiveVersion?.id).toBe(published.id);
    expect(result.selectedAt).toBeNull();
    expect(result.subscriptions.map((row: any) => row.selectedAt)).toEqual([date(3).toISOString(), date(5).toISOString()]);
  });

  it('ignores invalid selection dates when execution uses an automatic template fallback', async () => {
    const { prisma, service } = build();
    prisma.subscription.findMany.mockResolvedValue([{ id: 'sub-1', employee: { id: 'e1', name: 'E1' },
      skillVersionSelections: [{ versionId: 'invalid', selectedAt: date(9) }], grants: [] }]);
    prisma.subscriptionSkillVersion.findUnique.mockResolvedValue({ version: { ...published, id: 'invalid', status: 'ENTERPRISE_REJECTED' } });
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.effectiveVersionState).toBe('AUTOMATIC');
    expect(result.subscriptions[0].selectedAt).toBeNull();
  });

  it('does not pick one canonical submission from a legacy multi-source adoption', async () => {
    const { prisma, service } = build();
    prisma.skillVersionAdoption.findMany.mockResolvedValue([
      { targetVersionId: published.id, sourceVersion: personal('one') },
      { targetVersionId: published.id, sourceVersion: personal('two') },
    ]);
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.versions.find((row: any) => row.id === published.id).sourceSubmissionId).toBeNull();
  });

  it('does not turn a member-visible subset of a multi-source adoption into a canonical source', async () => {
    const { prisma, service } = build('MEMBER');
    prisma.skillVersionAdoption.findMany.mockResolvedValue([
      { targetVersionId: published.id, sourceVersion: personal('own-source') },
      { targetVersionId: published.id, sourceVersion: personal('private-source', { ownerId: 'other-user' }) },
    ]);
    const result = await service.listVersionTimeline('user-1', 'cap-1');
    expect(result.versions.find((row) => row.id === published.id)?.sourceSubmissionId).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-source');
    expect(prisma.skillVersionAdoption.findMany.mock.calls[0][0].where.sourceVersion).not.toHaveProperty('ownerId');
  });

  it.each(['MEMBER', 'ENTERPRISE_ADMIN'])('maps Adoption snapshot to root with privacy-aware lookup (%s)', async (role) => {
    const { prisma, service } = build(role);
    prisma.skillVersionAdoption.findMany.mockResolvedValue([{ targetVersionId: published.id, sourceVersion: {
      ...personal('snapshot'), workingCopyId: 'submission', workingCopy: personal(),
    } }]);
    const result = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(result.versions.find((row: any) => row.id === published.id).sourceSubmissionId).toBe('submission');
    expect(prisma.skillVersionAdoption.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      sourceVersion: expect.objectContaining({ enterpriseId: 'ent-1', capabilityId: 'cap-1', scope: 'PERSONAL',
      }),
    }) }));
    prisma.skillVersionAdoption.findMany.mockResolvedValue([{ targetVersionId: published.id, sourceVersion: {
      ...personal('other'), ownerId: 'other-user', workingCopyId: null,
    } }]);
    const next = await service.listVersionTimeline('user-1', 'cap-1') as any;
    expect(next.versions.find((row: any) => row.id === published.id).sourceSubmissionId)
      .toBe(role === 'MEMBER' ? null : 'other');
  });
});
