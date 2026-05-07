// E2E Test Helpers and Utilities
// Provides reusable functions for end-to-end testing

import { Page, expect } from '@playwright/test';

// ────────────────────────────────────────────────────────────────────────────
// NAVIGATION HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function navigateTo(page: Page, path: string) {
  await page.goto(`http://localhost:3000${path}`);
  await page.waitForLoadState('networkidle');
}

export async function goHome(page: Page) {
  await navigateTo(page, '/');
}

export async function goDashboard(page: Page) {
  await navigateTo(page, '/dashboard');
}

export async function goCreateAgent(page: Page) {
  await navigateTo(page, '/create-agent');
}

export async function goAgentSettings(page: Page, agentId: string) {
  await navigateTo(page, `/agents/${agentId}/settings`);
}

// ────────────────────────────────────────────────────────────────────────────
// FORM FILLING HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function fillAgentForm(
  page: Page,
  data: {
    name: string;
    emoji: string;
    role?: string;
    color?: string;
  }
) {
  // Fill name
  await page.fill('input[placeholder*="name" i], input[aria-label*="name" i]', data.name);

  // Fill emoji
  await page.fill('input[placeholder*="emoji" i], input[aria-label*="emoji" i]', data.emoji);

  // Select role if provided
  if (data.role) {
    await page.selectOption('select[aria-label*="role" i], select[name="role"]', data.role);
  }

  // Fill color if provided
  if (data.color) {
    await page.fill('input[placeholder*="color" i], input[aria-label*="color" i]', data.color);
  }
}

export async function submitForm(page: Page, buttonText = 'Create') {
  await page.click(`button:has-text("${buttonText}")`);
  await page.waitForLoadState('networkidle');
}

export async function fillLoginForm(page: Page, email: string, password: string) {
  await page.fill('input[type="email"], input[placeholder*="email" i]', email);
  await page.fill('input[type="password"], input[placeholder*="password" i]', password);
}

// ────────────────────────────────────────────────────────────────────────────
// ASSERTION HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function expectPageTitle(page: Page, title: string) {
  await expect(page).toHaveTitle(new RegExp(title, 'i'));
}

export async function expectUrlContains(page: Page, path: string) {
  await expect(page).toHaveURL(new RegExp(path));
}

export async function expectTextVisible(page: Page, text: string) {
  await expect(page.locator(`text="${text}"`).first()).toBeVisible();
}

export async function expectTextNotVisible(page: Page, text: string) {
  await expect(page.locator(`text="${text}"`).first()).not.toBeVisible();
}

export async function expectErrorMessageVisible(page: Page, errorText: string) {
  await expect(page.locator('[role="alert"], .error, .error-message').first()).toContainText(
    errorText,
    { ignoreCase: true }
  );
}

export async function expectSuccessMessageVisible(page: Page, successText = 'success') {
  await expect(
    page.locator('[role="status"], .success, .success-message').first()
  ).toContainText(successText, { ignoreCase: true });
}

export async function expectElementCount(page: Page, selector: string, count: number) {
  const elements = await page.locator(selector).count();
  expect(elements).toBe(count);
}

// ────────────────────────────────────────────────────────────────────────────
// INTERACTION HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function clickButton(page: Page, buttonText: string) {
  await page.click(`button:has-text("${buttonText}")`);
}

export async function clickLink(page: Page, linkText: string) {
  await page.click(`a:has-text("${linkText}")`);
}

export async function hoverElement(page: Page, selector: string) {
  await page.hover(selector);
}

export async function focusElement(page: Page, selector: string) {
  await page.focus(selector);
}

export async function typeSlowly(page: Page, selector: string, text: string, delay = 50) {
  await page.fill(selector, '');
  for (const char of text) {
    await page.type(selector, char);
    await page.waitForTimeout(delay);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TABLE & LIST HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function getTableRows(page: Page, selector = 'table tbody tr') {
  return await page.locator(selector).count();
}

export async function getTableCell(page: Page, row: number, column: number) {
  return await page.locator(`table tbody tr:nth-child(${row}) td:nth-child(${column})`).textContent();
}

export async function getListItems(page: Page, selector = '[role="listitem"], .list-item') {
  const items: string[] = [];
  const count = await page.locator(selector).count();

  for (let i = 0; i < count; i++) {
    const text = await page.locator(selector).nth(i).textContent();
    if (text) items.push(text.trim());
  }

  return items;
}

// ────────────────────────────────────────────────────────────────────────────
// MODAL & DIALOG HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function expectModalVisible(page: Page, title?: string) {
  const modal = page.locator('[role="dialog"], .modal');
  await expect(modal).toBeVisible();

  if (title) {
    await expect(modal.locator(`text="${title}"`)).toBeVisible();
  }
}

export async function closeModal(page: Page) {
  // Try close button first
  const closeButton = page.locator('[role="dialog"] button:has-text("Close"), .modal-close');
  if (await closeButton.isVisible()) {
    await closeButton.click();
  } else {
    // Try Escape key
    await page.keyboard.press('Escape');
  }
}

export async function expectConfirmDialog(page: Page, message?: string) {
  const dialog = page.locator('[role="alertdialog"]');
  await expect(dialog).toBeVisible();

  if (message) {
    await expect(dialog.locator(`text="${message}"`)).toBeVisible();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// LOADING STATE HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function expectLoadingSpinner(page: Page) {
  await expect(page.locator('[role="status"], .spinner, .loading')).toBeVisible();
}

export async function expectLoadingGone(page: Page) {
  await expect(page.locator('[role="status"], .spinner, .loading')).not.toBeVisible({
    timeout: 10000,
  });
}

export async function waitForLoadingToFinish(page: Page) {
  // Wait for loading indicator to appear then disappear
  try {
    await page.waitForSelector('[role="status"], .loading', { timeout: 1000 });
    await page.waitForSelector('[role="status"], .loading', { state: 'hidden', timeout: 10000 });
  } catch {
    // If no loading indicator, it's already done
  }
}

// ────────────────────────────────────────────────────────────────────────────
// NETWORK & INTERCEPTOR HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function interceptApiCall(
  page: Page,
  pattern: string,
  responseData: any = { success: true }
) {
  await page.route(pattern, route => {
    route.abort();
  });
}

export async function mockApiResponse(page: Page, pattern: string, responseData: any) {
  await page.route(pattern, route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseData),
    });
  });
}

export async function waitForApiCall(page: Page, pattern: string) {
  return await page.waitForResponse(response => {
    return response.url().includes(pattern);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ────────────────────────────────────────────────────────────────────────────

export async function pressKey(page: Page, key: string) {
  await page.keyboard.press(key);
}

export async function typeWithModifier(
  page: Page,
  text: string,
  modifier: 'Control' | 'Shift' | 'Alt' | 'Meta'
) {
  await page.keyboard.down(modifier);
  await page.keyboard.type(text);
  await page.keyboard.up(modifier);
}

// ────────────────────────────────────────────────────────────────────────────
// SCREENSHOT & DEBUG HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function takeScreenshot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/screenshots/${name}.png` });
}

export async function dumpPageContent(page: Page) {
  const content = await page.content();
  console.log('Page HTML:', content);
}

export async function dumpAccessibilityTree(page: Page) {
  const snapshot = await page.accessibility.snapshot();
  console.log('Accessibility Tree:', JSON.stringify(snapshot, null, 2));
}

// ────────────────────────────────────────────────────────────────────────────
// PERFORMANCE HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function getPageLoadTime(page: Page) {
  const metrics = await page.metrics();
  return metrics.JSHeapUsedSize; // Simplified metric
}

export async function waitForPageToLoad(page: Page, timeout = 30000) {
  await page.waitForLoadState('networkidle', { timeout });
}

// ────────────────────────────────────────────────────────────────────────────
// VALIDATION HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function expectFormError(page: Page, fieldLabel: string, errorText: string) {
  const field = page.locator(`[aria-label*="${fieldLabel}" i], [placeholder*="${fieldLabel}" i]`);
  const errorMessage = field.locator(`. ~ [role="alert"], . ~ .error`);
  await expect(errorMessage).toContainText(errorText);
}

export async function expectFormValid(page: Page) {
  const form = page.locator('form');
  await expect(form.locator('[role="alert"], .error')).not.toBeVisible();
}

// ────────────────────────────────────────────────────────────────────────────
// COOKIE & STORAGE HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function setLocalStorage(page: Page, key: string, value: string) {
  await page.evaluateHandle(({ key, value }) => {
    localStorage.setItem(key, value);
  }, { key, value });
}

export async function getLocalStorage(page: Page, key: string) {
  return await page.evaluateHandle(({ key }) => {
    return localStorage.getItem(key);
  }, { key });
}

export async function clearLocalStorage(page: Page) {
  await page.evaluateHandle(() => {
    localStorage.clear();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION HELPERS
// ────────────────────────────────────────────────────────────────────────────

export async function login(page: Page, email: string, password: string) {
  await navigateTo(page, '/login');
  await fillLoginForm(page, email, password);
  await clickButton(page, 'Sign In');
  await page.waitForNavigation();
}

export async function logout(page: Page) {
  await clickButton(page, 'Logout');
  await page.waitForNavigation();
}

// ────────────────────────────────────────────────────────────────────────────
// RETRY LOGIC
// ────────────────────────────────────────────────────────────────────────────

export async function retryUntil(
  fn: () => Promise<boolean>,
  maxAttempts = 5,
  delayMs = 500
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (await fn()) {
        return true;
      }
    } catch (e) {
      // Continue to retry
    }

    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

export async function expectWithRetry(
  fn: () => Promise<void>,
  maxAttempts = 5,
  delayMs = 500
) {
  let lastError: any;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      lastError = e;
      if (i < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}
