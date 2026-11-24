import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3020';
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }, video: 'off' });
const evidence = resolve(process.cwd(), '../output/video-reference-ui');
const profile = { profileId: 'seedance-video-profile', kind: 'video', displayName: 'Seedance 参考视频',
  modelId: 'seedance-2.0-fast', configVersion: 'cfg_synthetic', operations: ['text-to-video', 'image-to-video', 'video-to-video'],
  executionMode: 'async-query', enabled: true, verified: true, capabilities: {
    supportsTextToVideo: true, supportsImageToVideo: true, supportsVideoToVideo: true, supportsAudio: true,
    durationRange: { minimum: 4, maximum: 15 }, durationsSeconds: [4, 15], aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'], frameRates: [24, 30], maxInputBytes: 10485760, maxReferenceCount: 9,
    maxVideoReferenceCount: 3, maxVideoReferenceBytes: 94371840, videoReferenceMimeTypes: ['video/mp4', 'video/quicktime'],
    outputFormats: ['video/mp4'], supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 86400,
  } };
const policy = { enabledProfileIds: [profile.profileId], defaultProfileId: profile.profileId };

for (const width of [1440, 390]) {
  test(`video reference administration and enterprise display at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = {};
      if (path === '/api/auth/refresh') body = { token: 'synthetic-ui-only', user: { id: 'synthetic-admin', email: 'ui@example.invalid', name: 'UI 验证', avatar: null,
        role: new URL(page.url()).pathname.startsWith('/admin') ? 'ADMIN' : 'USER' },
        enterprise: { id: 'synthetic-enterprise', name: '测试企业' }, roleInEnterprise: 'ENTERPRISE_ADMIN' };
      else if (path === '/api/admin/media/video/connection') body = { configured: true, apiKeyConfigured: true, source: 'database', baseUrl: 'https://synthetic.invalid/v1' };
      else if (path === '/api/admin/media/video/profiles') body = [profile];
      else if (path === '/api/admin/media/video/profiles/' + profile.profileId) {
        const input = route.request().postDataJSON();
        expect(input.capabilities.maxVideoReferenceCount).toBe(2);
        expect(input.capabilities.maxVideoReferenceBytes).toBe(80 * 1024 * 1024);
        body = { ...profile, configVersion: 'cfg_next', enabled: false, verified: false, capabilities: { ...profile.capabilities, ...input.capabilities } };
      } else if (path === '/api/enterprise/media-config/video/available-profiles') {
        const { modelId: _modelId, ...available } = profile; body = [available];
      } else if (path === '/api/enterprise/media-config/video') body = { policy, configured: true, canEdit: true, mock: false, executionTested: false };
      else if (path === '/api/enterprise/media-config/available-profiles') body = [];
      else if (path === '/api/enterprise/media-config') body = { policy: { enabledProfileIds: [], defaultProfileId: null }, configured: true, canEdit: true, mock: false, executionTested: false };
      else if (path.includes('notifications')) body = { items: [], unreadCount: 0, total: 0 };
      else if (path.includes('announcements')) body = [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`${baseURL}/admin/settings?tab=models&modelTab=video`);
    await page.getByRole('button', { name: '编辑能力配置' }).click();
    await expect(page.getByLabel('视频生视频', { exact: true })).toBeChecked();
    await expect(page.getByLabel('最多参考视频数量')).toHaveValue('3');
    await expect(page.getByLabel('单个参考视频上限（MiB）')).toHaveValue('90');
    await expect(page.getByLabel('MOV', { exact: true })).toBeChecked();
    await page.getByLabel('最多参考视频数量').fill('2');
    await page.getByLabel('单个参考视频上限（MiB）').fill('80');
    await page.getByLabel('最多参考视频数量').scrollIntoViewIfNeeded();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, `admin-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/media/video/profiles/' + profile.profileId) && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存能力配置' }).click();
    await saved;
    await page.goto(`${baseURL}/settings/media`);
    const panel = page.locator('section[aria-labelledby="video-policy-title"]');
    await expect(panel.getByText('参考视频：最多 3 个，每个 90 MiB；video/mp4 / video/quicktime', { exact: true })).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(evidence, `enterprise-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
