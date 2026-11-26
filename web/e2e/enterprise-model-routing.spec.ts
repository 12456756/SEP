import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { MediaVideoPolicySchema } from 'shared/media-video-config.dto';
import videoFixture from '../../backend/src/shared/fixtures/media-video-v1.json';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: 'off' });

const policy = { enabledProfileIds: ['image-company', 'image-revoked'], defaultProfileId: 'image-company' };
const videoPolicy = MediaVideoPolicySchema.parse({ enabledProfileIds: ['video-company'], defaultProfileId: 'video-company' });
const model = (modelId: string) => ({ modelId, label: modelId, displayName: modelId, isFree: false,
  billingMultiplier: null, discountLabel: '费用由算力平台确认', vendor: null, category: 'chat', contextLength: null,
  maxOutputTokens: null, pricingInputPer1M: null, pricingOutputPer1M: null, supportedFeatures: null, description: null });

async function mockEnterprise(page: Page, ready = true) {
  let saved: unknown;
  let config = { id: 'config-company', enterpriseId: 'company', defaultChatModel: 'company-chat',
    allowedChatModels: ['company-chat', 'company-revoked'], allowUserSwitchModel: true,
    employeeModelPolicy: 'FOLLOW_TEMPLATE', employeeDefaultModel: null, plannerModel: null,
    createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z' };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = (value: unknown) => route.fulfill({ json: value });
    if (url.pathname === '/api/auth/refresh') return json({ token: 'ui-fixture-only',
      user: { id: 'company-admin', email: 'company@example.test', name: '企业管理员', avatar: null, role: 'USER' },
      enterprise: { id: 'company', name: '企业目录验证' }, roleInEnterprise: 'ENTERPRISE_ADMIN' });
    if (url.pathname === '/api/enterprise/model-config/available-models') {
      return ready ? json(['company-chat', 'company-reasoning'].map(model))
        : route.fulfill({ status: 503, json: { message: '企业 chat 算力凭证尚未就绪', code: 'COMPUTE_CREDENTIAL_NOT_READY' } });
    }
    if (url.pathname === '/api/enterprise/model-config') {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        config = { ...config, ...saved as object, updatedAt: '2026-11-20T01:00:00.000Z' };
      }
      return json(config);
    }
    if (url.pathname === '/api/enterprise/media-config') return json({ configured: ready, canEdit: true, policy });
    if (url.pathname === '/api/enterprise/media-config/available-profiles') return json(ready ? [{
      profileId: 'image-company', kind: 'image', displayName: '企业图片配置', configVersion: 'cfg_1',
      operations: ['generate'], executionMode: 'sync-response', enabled: true, verified: true,
      capabilities: { sizes: ['1024x1024'], maxOutputs: 1 },
    }] : []);
    if (url.pathname === '/api/enterprise/media-config/video') return json({ configured: ready, canEdit: true,
      policy: videoPolicy, mock: false, executionTested: false });
    if (url.pathname === '/api/enterprise/media-config/video/available-profiles') {
      const { modelId: _modelId, ...profile } = videoFixture.profile;
      return json(ready ? [{ ...profile, profileId: 'video-company', displayName: '企业视频配置', enabled: true, verified: true }] : []);
    }
    if (url.pathname.endsWith('/unread-count')) return json({ count: 0 });
    if (url.pathname === '/api/cart') return json({ items: [], total: 0 });
    if (url.pathname.includes('/enterprise')) return json({ id: 'company', name: '企业目录验证', metadata: {} });
    return json([]);
  });
  return () => saved;
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: path.resolve(__dirname, '../../outputs/compute-integration', name), fullPage: true, animations: 'disabled' });
}

for (const width of [1440, 390]) {
  test(`enterprise catalog and planner save at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const saved = await mockEnterprise(page);
    await page.goto('/settings/models');
    await expect(page.getByRole('heading', { name: '模型偏好' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'company-revoked' })).toBeVisible();
    await page.getByRole('combobox').click();
    await expect(page.getByRole('option', { name: 'company-reasoning' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'public-model' })).toHaveCount(0);
    await page.getByRole('option', { name: 'company-reasoning' }).click();
    await page.getByRole('button', { name: '清空', exact: true }).click();
    await page.getByRole('tab', { name: '编排模型' }).click();
    await expect(page.getByRole('combobox')).toHaveText('跟随企业默认');
    await page.getByRole('button', { name: '保存配置' }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    if (width < 768) {
      const bounds = await page.getByRole('button', { name: '保存配置' }).boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThan(804);
    }
    await screenshot(page, `model-routing-${width}.png`);
    await page.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(saved).toMatchObject({ defaultChatModel: 'company-reasoning', allowedChatModels: [], plannerModel: null });
    await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  });

  test(`enterprise media permissions and missing key at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockEnterprise(page);
    await page.goto('/settings/media');
    await expect(page.getByText('企业图片配置', { exact: true })).toBeVisible();
    await expect(page.locator('span').filter({ hasText: /^image-revoked$/ })).toBeVisible();
    await expect(page.getByText('当前不可用', { exact: true })).toBeVisible();
    await expect(page.locator('span').filter({ hasText: /^企业视频配置$/ })).toBeVisible();
    await screenshot(page, `media-routing-${width}.png`);
    await page.unroute('**/api/**'); await mockEnterprise(page, false); await page.reload();
    await expect(page.getByText('本企业图片 Key 尚未就绪。', { exact: true })).toBeVisible();
    await expect(page.getByText('本企业视频 Key 尚未就绪。', { exact: true })).toBeVisible();
    await page.goto('/settings/models');
    await expect(page.getByText('企业 chat 算力凭证尚未就绪', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存配置' })).toHaveCount(0);
  });

  test(`administrator calibration credential at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/refresh') return route.fulfill({ json: { token: 'admin-ui-fixture-only',
        user: { id: 'platform-admin', email: 'platform@example.test', name: '平台管理员', avatar: null, role: 'ADMIN' },
        enterprise: null, roleInEnterprise: null } });
      if (url.pathname.endsWith('/connection')) return route.fulfill({ json: {
        configured: true, apiKeyConfigured: true, baseUrl: 'https://compute.example.test/v1', source: 'database',
      } });
      if (url.pathname.endsWith('/unread-count')) return route.fulfill({ json: { count: 0 } });
      return route.fulfill({ json: [] });
    });
    for (const kind of ['image', 'video']) {
      await page.goto(`/admin/settings?tab=models&modelTab=${kind}`);
      await expect(page.getByLabel(/管理员校验 API Key/)).toBeVisible();
      await expect(page.getByLabel(/管理员校验 API Key/)).toHaveValue('');
      await expect(page.getByLabel('Base URL')).toHaveValue('https://compute.example.test/v1');
      await screenshot(page, `admin-calibration-${kind}-${width}.png`);
    }
  });
}
