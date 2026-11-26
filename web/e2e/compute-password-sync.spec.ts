import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: 'off' });

async function mockApi(page: Page, pending: boolean, authenticated = true) {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/refresh' && !authenticated) return route.fulfill({ status: 401, json: { message: '未登录' } });
    if (pathname === '/api/auth/refresh') return route.fulfill({ json: { token: 'ui-test-only',
      user: { id: 'u1', email: 'owner@example.test', name: '测试管理员', avatar: null, role: 'USER' },
      enterprise: { id: 'ent1', name: '联调企业' }, roleInEnterprise: 'ENTERPRISE_ADMIN' } });
    if (pathname === '/api/auth/password/change' || pathname === '/api/auth/password/reset') {
      expect(route.request().postDataJSON().newPassword).toBe('NewPassword123');
      return route.fulfill({ json: { computePasswordSync: pending ? 'PENDING' : 'SYNCED',
        message: pending ? 'SEP 密码已修改，算力平台密码同步中，后台将自动重试' : 'SEP 和算力平台密码已同步修改' } });
    }
    if (pathname.endsWith('/unread-count')) return route.fulfill({ json: { count: 0 } });
    if (pathname === '/api/cart') return route.fulfill({ json: { items: [], total: 0 } });
    if (pathname === '/api/auth/oauth/providers') return route.fulfill({ json: { providers: [] } });
    if (pathname.includes('/enterprise')) return route.fulfill({ json: { id: 'ent1', name: '联调企业', metadata: {} } });
    return route.fulfill({ json: [] });
  });
}

for (const width of [1440, 390]) {
  for (const pending of [false, true]) {
    test(`password change reports ${pending ? 'pending' : 'synced'} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, pending);
      await page.goto('/settings/security/password');
      await page.getByLabel('当前密码', { exact: true }).fill('OldPassword123');
      await page.getByLabel('新密码', { exact: true }).fill('NewPassword123');
      await page.getByLabel('确认新密码', { exact: true }).fill('NewPassword123');
      await page.getByRole('button', { name: '保存新密码' }).click();
      await expect(page.getByRole('status')).toContainText(pending ? '算力平台密码同步中' : 'SEP 和算力平台密码已同步修改');
      await expect(page.getByLabel('新密码', { exact: true })).toHaveValue('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.resolve(__dirname, `../../outputs/compute-integration/password-${pending ? 'pending' : 'synced'}-${width}.png`), fullPage: true });
    });
  }
}

test('forgotten-password reset keeps pending synchronization visible after redirect', async ({ page }) => {
  await mockApi(page, true, false);
  await page.goto('/reset-password?token=ui-test-token');
  await page.getByPlaceholder('新密码', { exact: true }).fill('NewPassword123');
  await page.getByPlaceholder('再次输入新密码').fill('NewPassword123');
  await page.getByRole('button', { name: '确认重置' }).click();
  await expect(page).toHaveURL(/\/login\?reset=sync-pending/);
  await expect(page.getByRole('status')).toContainText('算力平台密码同步中');
});
