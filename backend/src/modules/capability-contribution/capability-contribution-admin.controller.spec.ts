import {
  CapabilityContributionAdminController,
  CapabilityReviewAdminController,
} from './capability-contribution-admin.controller';

describe('CapabilityContributionAdminController creation routes', () => {
  it('creates an RPA platform submission with the admin identity', async () => {
    const service = { createPlatformRpaSubmission: jest.fn() };
    const controller = new CapabilityContributionAdminController(service as never);
    const dto = {
      name: '发票归档 RPA',
      description: '自动下载并归档发票文件',
      type: 'rpa' as const,
      industry: [],
      position: [],
      rpaConfig: {
        platform: 'yingdao' as const,
        executionMode: 'download' as const,
        packageSha256: 'a'.repeat(64),
        packageFilename: 'invoice.zip',
        configDoc: '使用前请配置发票目录和影刀客户端环境',
      },
    };
    const expected = { id: 'cap-rpa', platformReviewStatus: 'PENDING_REVIEW' };
    service.createPlatformRpaSubmission.mockResolvedValue(expected);

    const result = await controller.createRpa(
      { user: { id: 'platform-admin-1' } },
      dto,
    );

    expect(result).toBe(expected);
    expect(service.createPlatformRpaSubmission).toHaveBeenCalledWith(
      'platform-admin-1',
      expect.objectContaining({ type: 'rpa', name: '发票归档 RPA' }),
    );
  });
});

describe('CapabilityReviewAdminController version routes', () => {
  function makeController() {
    const service = {
      getVersionDiff: jest.fn(),
      reviewPlatformVersion: jest.fn(),
    };
    const controller = new CapabilityReviewAdminController(service as never);
    return { controller, service };
  }

  it('forwards the admin identity and fixed ADMIN scope for the version diff', async () => {
    const { controller, service } = makeController();
    const expected = { changed: false, reviews: [] };
    service.getVersionDiff.mockResolvedValue(expected);

    const result = await controller.versionDiff(
      { user: { id: 'platform-admin-1' } },
      'version-3',
    );

    expect(result).toBe(expected);
    expect(service.getVersionDiff).toHaveBeenCalledWith(
      'platform-admin-1',
      'version-3',
      'ADMIN',
    );
  });

  it('parses and forwards the platform review decision with the admin identity', async () => {
    const { controller, service } = makeController();
    const body = {
      decision: 'APPROVE',
      comment: '安全扫描和内容审核通过',
    };
    const expected = { status: 'APPROVED' };
    service.reviewPlatformVersion.mockResolvedValue(expected);

    const result = await controller.reviewVersion(
      { user: { id: 'platform-admin-1' } },
      'version-3',
      body,
    );

    expect(result).toBe(expected);
    expect(service.reviewPlatformVersion).toHaveBeenCalledWith(
      'platform-admin-1',
      'version-3',
      body,
    );
  });
});
