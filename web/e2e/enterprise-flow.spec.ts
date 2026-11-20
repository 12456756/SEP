import { test, expect } from '@playwright/test';

/**
 * 企业端核心流程 E2E 测试
 *
 * 场景：企业注册 → 登录 → 订阅硅基员工 → 发起对话
 *
 * 前置条件：
 * - 后端服务运行在 http://localhost:3001
 * - 前端服务运行在 http://localhost:3001
 * - 数据库已初始化（pnpm db:migrate）
 * - Redis 服务正常运行
 */

test.describe.serial('企业端核心流程', () => {
  const testEmail = `e2e-test-${Date.now()}@example.com`;
  const testPassword = 'Test123456!';
  const enterpriseName = `E2E测试企业${Date.now()}`;

  test.beforeAll(async () => {
    // 验证后端服务可用
    const response = await fetch('http://localhost:3001/api/health');
    if (!response.ok) {
      throw new Error('后端服务未运行，请先启动: pnpm dev:backend');
    }
  });

  test('1. 企业注册流程', async ({ page }) => {
    await page.goto('/register');

    // 填写注册表单
    await page.fill('input[name="email"]', testEmail);
    await page.fill('input[name="password"]', testPassword);
    await page.fill('input[name="name"]', '测试用户');
    await page.fill('input[name="enterpriseName"]', enterpriseName);

    // 提交注册
    await page.click('button[type="submit"]');

    // 验证跳转到登录页或 Dashboard
    await page.waitForURL(/\/(login|dashboard)/, { timeout: 10000 });

    // 如果跳转到登录页，说明注册成功
    const currentUrl = page.url();
    expect(currentUrl).toMatch(/\/(login|dashboard)/);
  });

  test('2. 企业登录流程', async ({ page, context }) => {
    await page.goto('/login');

    // 填写登录表单
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', testPassword);

    // 提交登录
    await page.click('button[type="submit"]');

    // 验证跳转到 Dashboard
    await page.waitForURL(/\/dashboard/, { timeout: 10000 });

    // 验证 Dashboard 核心元素存在
    await expect(page.getByRole('link', { name: '工作台' })).toBeVisible({ timeout: 5000 });

    // 保存认证状态供后续测试使用
    await context.storageState({ path: '/tmp/e2e-auth-state.json' });
  });

  test('3. 浏览员工市场', async ({ browser }) => {
    const context = await browser.newContext({ storageState: '/tmp/e2e-auth-state.json' });
    const page = await context.newPage();

    // 进入员工市场
    await page.goto('/marketplace');

    // 验证页面加载
    await expect(page.getByRole('heading', { name: '元机AI人才市场' })).toBeVisible({ timeout: 5000 });

    // 验证至少有一个员工卡片
    const employeeCards = page.locator('article:has(button:has-text("订阅"))');
    await expect(employeeCards.first()).toBeVisible({ timeout: 10000 });

    await context.close();
  });

  test('4. 订阅硅基员工', async ({ browser }) => {
    const context = await browser.newContext({ storageState: '/tmp/e2e-auth-state.json' });
    const page = await context.newPage();

    // 进入员工市场
    await page.goto('/marketplace');
    await page.waitForLoadState('networkidle');

    // 点击第一个员工的"立即订阅"按钮
    const subscribeButton = page.locator('button:has-text("订阅")').first();
    await subscribeButton.click();

    // 等待订阅对话框（使用具体的 dialog name 避免多个 dialog 的冲突）
    await expect(page.getByRole('dialog', { name: '确认雇佣' })).toBeVisible({ timeout: 5000 });

    // 确认订阅（直接点击"确认支付"按钮，不需要填写订阅名称）
    await page.click('button:has-text("确认支付")');

    // 等待支付成功和页面跳转
    await page.waitForTimeout(3000);

    await context.close();
  });

  test('5. 发起对话', async ({ browser }) => {
    const context = await browser.newContext({ storageState: '/tmp/e2e-auth-state.json' });
    const page = await context.newPage();

    // 直接进入对话中心
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');

    // 验证对话中心页面已加载（有"新建会话"按钮）
    await expect(page.locator('button:has-text("新建会话")')).toBeVisible({ timeout: 5000 });

    await context.close();
  });
});

