import { test, expect } from '@playwright/test';

test('parallel first-use tabs retain one task owner', async ({ context }) => {
  const one = await context.newPage(), two = await context.newPage();
  await Promise.all([one.goto('/'), two.goto('/')]);
  await Promise.all([expect(one.locator('#serverStatus')).toContainText('服务器计算'), expect(two.locator('#serverStatus')).toContainText('服务器计算')]);
  const firstCookie = (await context.cookies()).find(cookie => cookie.name === 'sim_session');
  expect(firstCookie).toBeTruthy();
  await Promise.all([one.locator('#serverConnect').click(), two.locator('#serverConnect').click()]);
  await Promise.all([expect(one.locator('#serverStatus')).toContainText('服务器计算'), expect(two.locator('#serverStatus')).toContainText('服务器计算')]);
  const secondCookie = (await context.cookies()).find(cookie => cookie.name === 'sim_session');
  expect(secondCookie.value.split('.')[0]).toBe(firstCookie.value.split('.')[0]);
});
