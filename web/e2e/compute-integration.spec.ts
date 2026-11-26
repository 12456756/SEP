import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import type { ComputeIntegrationView } from 'shared/compute-integration.dto';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: 'off' });

const view: ComputeIntegrationView = { enterpriseId: 'ent-preview', enterpriseName: '算力集成验证企业', remoteAccountId: null, mode: 'LEGACY', status: 'NOT_CONNECTED',
  connected: false, credentials: (['chat', 'image', 'video'] as const).map(kind => ({ kind, configured: false, maskedKey: null, version: null })),
  lastErrorCode: null, lastErrorMessage: null, lastSyncedAt: null, ledgerCursor: null, pendingJobs: 0, lastReconciliation: null };

async function mockApi(page: Page, role = 'ADMIN', error = false, initial = view, autoComplete = false) {
  let current = { ...initial };
  let listed = false;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/refresh') return route.fulfill({ json: { token: 'local-ui-mock-only',
      user: { id: 'preview-user', email: 'preview@example.test', name: '验证管理员', avatar: null, role },
      enterprise: role === 'ADMIN' ? null : { id: view.enterpriseId, name: view.enterpriseName }, roleInEnterprise: role === 'ADMIN' ? null : role === 'MEMBER' ? 'MEMBER' : 'ENTERPRISE_ADMIN' } });
    if (url.pathname.endsWith('/credential-rotations')) return route.fulfill({ json: [] });
    if (url.pathname.includes('/compute-integrations') || url.pathname === '/api/enterprise/compute-integration') {
      if (error) return route.fulfill({ status: 503, json: { message: '连接状态查询暂时失败，请稍后重试' } });
      if (url.pathname.endsWith('/prepare')) { current = { ...current, mode: 'PREPARING', pendingJobs: 1, lastErrorCode: 'REMOTE_NOT_CONNECTED', lastErrorMessage: '算力平台接口尚未接通' } as typeof current; return route.fulfill({ json: current }); }
      if (url.pathname.endsWith('/records')) return route.fulfill({ json: { jobs: current.pendingJobs ? [{ id: 'job-preview', businessId: 'reg_ent-preview', kind: 'PROVISION', status: 'BLOCKED', attempts: 0, lastErrorCode: 'REMOTE_NOT_CONNECTED' }] : [], executions: [], settlements: [], transfers: [], reconciliations: [] } });
      if (url.pathname === '/api/admin/compute-integrations') {
        if (listed && autoComplete) current = { ...current, mode: 'ENTERPRISE' };
        listed = true;
        return route.fulfill({ json: { items: [current], total: 1, page: 1, pageSize: 20 } });
      }
      return route.fulfill({ json: current });
    }
    if (url.pathname.endsWith('/unread-count')) return route.fulfill({ json: { count: 0 } });
    if (url.pathname === '/api/cart') return route.fulfill({ json: { items: [], total: 0 } });
    if (url.pathname.includes('/enterprise')) return route.fulfill({ json: { ...view, id: view.enterpriseId, name: view.enterpriseName, metadata: {} } });
    return route.fulfill({ json: [] });
  });
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.resolve(__dirname, '../../outputs/compute-integration', 'automatic-connection-20261124-' + name), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`enterprise compute totals and outstanding bills fit at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockApi(page, 'USER', false, { ...view, mode: 'ENTERPRISE', status: 'READY', connected: true, remoteAccountId: '123',
      funds: { totalBalanceCny: '12345678.123456', unallocatedCny: '2345678.123456', memberBalanceCny: '10000000.000000',
        generationPaused: true, pendingSettlementCny: '30.000000', localUnpaidCny: '2.000000', syncShortfallCny: '1.000000',
        remoteAvailableCny: '12345708.123456', remoteFrozenCny: '0.000000', sequence: '123456789012345', observedAt: null } });
    await page.goto('/settings/compute-connection');
    await expect(page.getByText('企业算力总余额', { exact: true })).toBeVisible();
    await expect(page.getByText('¥12345678.123456', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('存在未结清费用');
    await screenshot(page, `funds-sharing-${viewport.width}.png`);
  });
  test(`platform automatically reflects a completed enterprise connection at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockApi(page, 'ADMIN', false, { ...view, mode: 'PREPARING', status: 'READY', connected: true,
      remoteAccountId: '123', credentials: view.credentials.map(key => ({ ...key, configured: true, maskedKey: '****test', version: 1 })) }, true);
    await page.goto('/admin/compute-integrations');
    await page.getByRole('button', { name: `查看${view.enterpriseName}连接详情` }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('后台将自动完成');
    await screenshot(page, `activation-ready-${viewport.width}.png`);
    await expect(page.getByRole('dialog').getByText('已开通', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '启用企业连接' })).toHaveCount(0);
    await screenshot(page, `activated-${viewport.width}.png`);
  });
  test(`platform prepares a durable disconnected operation at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await mockApi(page);
    await page.goto('/admin/compute-integrations');
    await expect(page.getByRole('heading', { name: '企业算力连接' })).toBeVisible();
    await expect(page.getByText(view.enterpriseName)).toBeVisible();
    await screenshot(page, `platform-${viewport.width}.png`);
    await page.getByRole('button', { name: `查看${view.enterpriseName}连接详情` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '开通企业连接' }).click();
    await expect(page.getByText('开户任务已保存', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '启用企业连接' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试reg_ent-preview' })).toBeDisabled();
    await expect(page.getByRole('dialog').getByText('reg_ent-preview', { exact: true })).toBeVisible();
    await page.getByRole('dialog').evaluate(element => { element.scrollTop = 0; });
    await screenshot(page, `platform-detail-${viewport.width}.png`);
  });

  test(`enterprise status shows no invented keys or balance at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await mockApi(page, 'USER');
    await page.goto('/settings/compute-connection');
    await expect(page.getByRole('heading', { name: '算力连接', exact: true })).toBeVisible();
    await expect(page.getByText('尚未绑定', { exact: true })).toBeVisible();
    await expect(page.getByText('未配置', { exact: true })).toHaveCount(3);
    await expect(page.getByText('原平台连接', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('开户完成后即可调用模型');
    await screenshot(page, `enterprise-${viewport.width}.png`);
  });
}

test('normal member cannot query enterprise integration', async ({ page }) => {
  let calls = 0; page.on('request', request => { if (request.url().includes('/api/enterprise/compute-integration')) calls++; });
  await mockApi(page, 'MEMBER'); await page.goto('/settings/compute-connection');
  await expect(page.getByText('仅企业管理员可查看', { exact: true })).toBeVisible(); expect(calls).toBe(0);
});

test('platform displays the status query error', async ({ page }) => {
  await mockApi(page, 'ADMIN', true); await page.goto('/admin/compute-integrations');
  await expect(page.getByText('连接状态查询暂时失败，请稍后重试', { exact: true })).toBeVisible();
});

test('automatic initialization shows its actual failure without a manual activation switch', async ({ page }) => {
  await mockApi(page, 'ADMIN', false, { ...view, mode: 'PREPARING', status: 'READY', connected: true,
    lastErrorCode: 'COMPUTE_CONNECTION_PENDING', lastErrorMessage: '原任务尚未完成，请先核对账务' });
  await page.goto('/admin/compute-integrations');
  await page.getByRole('button', { name: `查看${view.enterpriseName}连接详情` }).click();
  await expect(page.getByText('原任务尚未完成，请先核对账务', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('连接初始化中', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '启用企业连接' })).toHaveCount(0);
});
