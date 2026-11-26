import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: 'off' });

const sentence = 'English words should have clear spaces between them.';
const content = `${sentence}\n\nSecond paragraph with **bold English words** and a [long link](https://example.test/${'long-link-'.repeat(20)}).\n\n- First English item\n- Second English item\n\n\`\`\`javascript\nconst greeting = "Hello world";\nconsole.log(greeting);\n\`\`\``;
const employee = { id: 'employee-spacing', name: '排版测试员工', status: 'PUBLISHED', avatar: null };
const session = { id: 'english-spacing', title: '英文排版验证', source: 'CHAT', modelId: null, employee,
  createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', _count: { messages: 1 } };

async function mockApi(page: Page) {
  let sent = false;
  let releaseHistory: (() => void) | undefined;
  const historyReleased = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/api/auth/refresh') return route.fulfill({ json: { token: 'spacing-ui-fixture',
      user: { id: 'spacing-user', email: 'spacing@local.test', name: '测试用户', avatar: null, role: 'USER' },
      enterprise: { id: 'spacing-company', name: '排版测试企业' }, roleInEnterprise: 'ENTERPRISE_ADMIN' } });
    if (pathname === '/api/conversations') return route.fulfill({ json: [session] });
    if (pathname === '/api/conversations/english-spacing') {
      if (sent) await historyReleased;
      return route.fulfill({ json: { ...session, messages: [
      { id: 'history', role: 'ASSISTANT', content, createdAt: session.createdAt },
      ...(sent ? [{ id: 'sent-user', role: 'USER', content: 'Test English spacing', createdAt: session.createdAt },
        { id: 'completed', role: 'ASSISTANT', content, createdAt: session.createdAt }] : []),
      ] } });
    }
    if (pathname === '/api/conversations/english-spacing/messages') {
      sent = true;
      const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      return route.fulfill({ contentType: 'text/event-stream', body: frame('text_delta', content) + frame('done', { messageId: 'completed' }) });
    }
    if (pathname === '/api/subscriptions') return route.fulfill({ json: [{ employee }] });
    if (pathname.endsWith('/model-config')) return route.fulfill({ json: { allowedChatModels: [], allowUserSwitchModel: false } });
    if (pathname.endsWith('/unread-count')) return route.fulfill({ json: { count: 0 } });
    if (pathname === '/api/cart') return route.fulfill({ json: { items: [], total: 0 } });
    return route.fulfill({ json: [] });
  });
  return () => releaseHistory?.();
}

async function checkParagraph(page: Page) {
  const paragraph = page.locator('[role="log"] .md-body p').filter({ hasText: sentence }).last();
  await expect(paragraph).toHaveText(sentence);
  const spacing = await paragraph.evaluate(element => {
    const text = element.firstChild!;
    const left = document.createRange(), right = document.createRange();
    left.setStart(text, 0); left.setEnd(text, 7);
    right.setStart(text, 8); right.setEnd(text, 13);
    const first = left.getBoundingClientRect(), second = right.getBoundingClientRect();
    return { gap: second.left - first.right, sameLine: Math.abs(first.top - second.top) < 1 };
  });
  expect(spacing.sameLine).toBe(true);
  expect(spacing.gap).toBeGreaterThan(1);
  await expect(page.locator('[role="log"] .md-body pre code').last()).toContainText('"Hello world"');
  await expect(page.locator('[role="log"] .md-body').last().locator('li')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

for (const width of [1440, 390]) {
  test(`English spacing survives completion and reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const releaseHistory = await mockApi(page);
    await page.goto('/chat');
    await checkParagraph(page);
    if (width < 768) {
      await page.getByRole('button', { name: '会话列表', exact: true }).click();
      await expect(page.locator('#chat-sessions')).toBeVisible();
      await page.locator('#chat-sessions').getByText('英文排版验证', { exact: true }).click();
      await expect(page.locator('#chat-sessions')).toBeHidden();
    }
    await page.getByRole('textbox').fill('Test English spacing');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('[role="log"] .md-body').filter({ hasText: sentence })).toHaveCount(2);
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
    await checkParagraph(page);
    await page.locator('[role="log"] .md-body').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve(__dirname, `../../outputs/chat-english-spacing-live-${width}.png`), fullPage: true });
    releaseHistory();
    await expect(page.locator('[role="log"] .md-body').filter({ hasText: sentence })).toHaveCount(2);
    await page.reload();
    await checkParagraph(page);
    await page.locator('[role="log"] .md-body').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve(__dirname, `../../outputs/chat-english-spacing-${width}.png`), fullPage: true });
  });
}
