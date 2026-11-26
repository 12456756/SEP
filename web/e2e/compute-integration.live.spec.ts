import { test, expect } from '@playwright/test';
import path from 'node:path';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: 'off' });
test.skip(process.env.COMPUTE_LOCAL_PREVIEW !== '1', 'Requires the explicitly isolated compute preview');

test('local administrator can inspect actual backend preparation records', async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:3010');
  await expect.poll(async () => {
    try { return (await page.request.get('http://127.0.0.1:3012/health')).status(); }
    catch { return 0; }
  }, { timeout: 20000 }).toBe(200);
  const response = await page.request.post('/api/auth/login', { data: {
    email: 'compute-preview@example.test', password: 'SepPreview_20261120!',
  } });
  expect(response.ok()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/compute-integrations');
  await expect(page.getByRole('heading', { name: '企业算力连接' })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索企业' }).fill('本地算力验证');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const detail = page.getByRole('button', { name: /查看本地算力验证.*连接详情/ }).first();
  await expect(detail).toBeVisible();
  await page.screenshot({ path: path.resolve(__dirname, '../../outputs/compute-integration/live-platform.png'), fullPage: true });
  await detail.click();
  await expect(page.getByRole('dialog').getByText('算力平台接口尚未接通').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^重试reg_/ }).first()).toBeDisabled();
  await page.getByRole('dialog').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.resolve(__dirname, '../../outputs/compute-integration/live-platform-detail.png'), fullPage: true });
});
