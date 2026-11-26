import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import type { ComputeIntegrationView } from 'shared/compute-integration.dto';
import type { ComputeCredentialRotationView } from 'shared/compute-credential-rotation.dto';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: 'off' });
const endpoint = '/api/enterprise/compute-integration/credential-rotations';
async function fixture(page: Page, options: { blocked?: boolean; listError?: boolean; member?: boolean; lostResponse?: boolean } = {}) {
  let rows: ComputeCredentialRotationView[] = options.blocked ? [{ id: 'row-test', operationId: 'original-operation', kind: 'chat', expectedVersion: 1,
    status: 'BLOCKED', lastErrorCode: 'COMPUTE_CONTRACT_INVALID', lastErrorMessage: '回执归属不一致，等待核对', createdAt: new Date().toISOString() }] : [];
  const requests: any[] = []; const retries: string[] = [];
  let current: ComputeIntegrationView = { enterpriseId: 'enterprise-test', enterpriseName: '凭证验证企业', remoteAccountId: '123', mode: 'ENTERPRISE', status: 'READY',
    connected: true, credentials: (['chat', 'image', 'video'] as const).map(kind => ({ kind, configured: true, maskedKey: 'sk-****1234', version: 1 })),
    lastErrorCode: null, lastErrorMessage: null, lastSyncedAt: null, ledgerCursor: null, pendingJobs: 0, lastReconciliation: null };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/auth/refresh') return route.fulfill({ json: { token: 'mock-token',
      user: { id: 'admin-test', email: 'admin@example.test', name: '管理员', avatar: null, role: 'USER' },
      enterprise: { id: current.enterpriseId, name: current.enterpriseName }, roleInEnterprise: options.member ? 'MEMBER' : 'ENTERPRISE_ADMIN' } });
    if (url.pathname === endpoint) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); requests.push(body);
        if (options.lostResponse && requests.length === 1) return route.abort('failed');
        rows = [{ id: 'row-test', ...body, status: 'PENDING', lastErrorCode: null, lastErrorMessage: null, createdAt: new Date().toISOString() }];
        return route.fulfill({ status: 202, json: rows[0] });
      }
      if (options.listError) return route.fulfill({ status: 503, json: { message: '暂时无法查询更换状态' } });
      return route.fulfill({ json: rows });
    }
    if (url.pathname.endsWith('/retry')) {
      retries.push(url.pathname); rows = rows.map(row => ({ ...row, status: 'PENDING', lastErrorCode: null, lastErrorMessage: null }));
      return route.fulfill({ status: 202, json: rows[0] });
    }
    if (url.pathname === '/api/enterprise/compute-integration') return route.fulfill({ json: current });
    if (url.pathname.endsWith('/unread-count')) return route.fulfill({ json: { count: 0 } });
    if (url.pathname === '/api/cart') return route.fulfill({ json: { items: [], total: 0 } });
    if (url.pathname.includes('/enterprise')) return route.fulfill({ json: { id: current.enterpriseId, name: current.enterpriseName, metadata: {} } });
    return route.fulfill({ json: [] });
  });
  return { requests, retries, complete: () => {
    rows = rows.map(row => ({ ...row, status: 'COMPLETED' }));
    current = { ...current, credentials: current.credentials.map(key => key.kind === 'chat' ? { ...key, version: 2, maskedKey: 'sk-****5678' } : key) };
  } };
}
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`one click rotation prevents duplicate submits and refreshes versions at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); const state = await fixture(page);
    await page.goto('/settings/compute-connection');
    const panel = page.getByRole('region', { name: '凭证更换' });
    const button = page.getByRole('button', { name: '一键更换对话 Key', exact: true });
    await expect(button).toBeEnabled();
    await button.dblclick();
    await expect(panel.getByRole('status')).toHaveText('正在更换');
    expect(state.requests).toHaveLength(1); await expect(button).toBeDisabled();
    await expect(page.getByRole('button', { name: '一键更换图片 Key', exact: true })).toBeEnabled();
    state.complete();
    await expect(panel.getByRole('status')).toHaveText('更换完成', { timeout: 15000 });
    await expect(panel).toContainText('v2'); await expect(button).toBeEnabled();
    await page.screenshot({ path: path.resolve(__dirname, '../../outputs/compute-integration', `credential-rotation-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator('body')).not.toContainText('encrypted_key');
  });
}
test('restores the original blocked operation', async ({ page }) => {
  const state = await fixture(page, { blocked: true }); await page.goto('/settings/compute-connection');
  await expect(page.getByText('回执归属不一致，等待核对')).toBeVisible();
  await expect(page.getByRole('button', { name: '一键更换对话 Key', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '恢复原操作' }).click();
  await expect(page.getByRole('region', { name: '凭证更换' }).getByRole('status')).toHaveText('正在更换');
  expect(state.retries).toEqual([`${endpoint}/original-operation/retry`]); expect(state.requests).toHaveLength(0);
});
test('reuses the same operation when the create response is lost', async ({ page }) => {
  const state = await fixture(page, { lostResponse: true }); await page.goto('/settings/compute-connection');
  const button = page.getByRole('button', { name: '一键更换对话 Key', exact: true });
  await button.click(); await expect(page.getByRole('region', { name: '凭证更换' }).getByRole('alert')).toBeVisible();
  await expect(button).toBeEnabled(); await button.click();
  await expect(page.getByRole('region', { name: '凭证更换' }).getByRole('status')).toHaveText('正在更换');
  expect(state.requests).toHaveLength(2); expect(state.requests[0]).toEqual(state.requests[1]);
});
test('disables rotation if operation status cannot be queried', async ({ page }) => {
  await fixture(page, { listError: true }); await page.goto('/settings/compute-connection');
  await expect(page.getByRole('region', { name: '凭证更换' }).getByRole('alert')).toHaveText('暂时无法查询更换状态', { timeout: 20000 });
  await expect(page.getByRole('button', { name: '一键更换对话 Key', exact: true })).toBeDisabled();
});
test('ordinary members cannot access rotation controls', async ({ page }) => {
  const state = await fixture(page, { member: true }); await page.goto('/settings/compute-connection');
  await expect(page.getByText('仅企业管理员可查看', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '一键更换对话 Key', exact: true })).toHaveCount(0);
  expect(state.requests).toHaveLength(0);
});
