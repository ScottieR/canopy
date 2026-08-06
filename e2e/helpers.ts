// E2E Test Helpers and Utilities
// Provides reusable functions for end-to-end testing.
//
// Refreshed 2026-08-06: Canopy has no client-side router for top-level pages
// (only a handful of in-app views selected via Zustand state, with an
// optional `#/<view>` hash pushed for deep-linkable views once onboarding is
// done — see src/App.tsx). There is no /create-agent, /dashboard,
// /agents/:id, /settings, or /login route, so the old helpers below that
// assumed a multi-page CRUD app (goCreateAgent, goDashboard, fillAgentForm
// with name/emoji/role/color fields, login/logout) tested a UI that does not
// exist. They have been replaced with helpers for the real conversational
// onboarding flow (src/pages/OnboardingWizard.tsx, beat 1: role pick +
// draft reveal). Generic, still-accurate interaction/assertion helpers are
// kept as-is.

import { Page, expect } from '@playwright/test';

// ────────────────────────────────────────────────────────────────────────────
// NAVIGATION HELPERS
// ────────────────────────────────────────────────────────────────────────────

// Uses Playwright's configured `baseURL` (see playwright.config.ts) rather
// than a hardcoded host:port, so this doesn't drift from whatever port Vite
// is actually serving on.
export async function navigateTo(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

export async function goHome(page: Page) {
  await navigateTo(page, '/');
}

// ────────────────────────────────────────────────────────────────────────────
// ONBOARDING HELPERS (src/pages/OnboardingWizard.tsx, beat 1)
// ────────────────────────────────────────────────────────────────────────────

const ONBOARDING_STORAGE_KEYS = [
  'canopy_onboarding_draft',
  'canopy_initial_setup_complete',
  'canopy_onboarding_config',
];

/**
 * Onboarding only renders when there are zero agents (App.tsx sets
 * activeView to "onboarding" after `list_agents` returns empty, which is
 * always true here since there's no Tauri runtime under Playwright). This
 * clears the local draft/first-run markers so each test starts from a clean
 * "Meet Eddie" screen regardless of what earlier tests left behind.
 */
export async function resetOnboardingState(page: Page) {
  await goHome(page);
  await page.evaluate((keys) => {
    for (const key of keys) localStorage.removeItem(key);
  }, ONBOARDING_STORAGE_KEYS);
  await page.reload();
  await page.waitForLoadState('networkidle');
}

export async function expectOnboardingVisible(page: Page) {
  // "Meet Eddie" is the first of the three fixed progress-stage labels
  // (PROGRESS_STAGES in OnboardingWizard.tsx) and is always on screen once
  // step >= 0.
  await expect(page.getByText('Meet Eddie', { exact: true }).first()).toBeVisible();
}

export function getEddieNameInput(page: Page) {
  return page.locator('input[placeholder="e.g. Scottie"]');
}

export async function fillEddieName(page: Page, name: string) {
  await getEddieNameInput(page).fill(name);
}

/** Clicks the "Custom" role card, which is always present regardless of the
 * data-driven featured-role list, making it the most stable role to drive
 * in tests. */
export async function selectCustomRole(page: Page) {
  await page.locator('button:has-text("Custom")').first().click();
}

export function getDiscoveryTextarea(page: Page) {
  return page.locator('textarea[placeholder*="Describe the work" i], textarea[placeholder*="Describe the kind of specialist" i]');
}

export async function fillDiscoveryInput(page: Page, text: string) {
  await getDiscoveryTextarea(page).fill(text);
}

/** The primary CTA at the bottom of the role-pick step. Its label changes
 * with state ("Draft my first agent" → "Draft custom agent" once Custom is
 * selected), so match loosely on "Draft". */
export function getDraftButton(page: Page) {
  return page.getByRole('button', { name: /draft (my first agent|custom agent|this agent)/i });
}

export async function clickDraftButton(page: Page) {
  await getDraftButton(page).click();
}

/** The "Eddie's Draft" reveal panel appears the instant a role is picked
 * (hasDraftSource = !!selectedRole in OnboardingWizard.tsx) — no submit
 * required. */
export async function expectDraftPanelVisible(page: Page) {
  await expect(page.getByText("Eddie's Draft", { exact: true })).toBeVisible();
  await expect(page.getByLabel('Agent name')).toBeVisible();
}

export function getAgentNameInput(page: Page) {
  return page.getByLabel('Agent name');
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

export async function expectTextVisible(page: Page, text: string | RegExp) {
  await expect(page.getByText(text).first()).toBeVisible();
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

export async function clickButton(page: Page, buttonText: string | RegExp) {
  await page.getByRole('button', { name: buttonText }).first().click();
}

export async function clickLink(page: Page, linkText: string | RegExp) {
  await page.getByRole('link', { name: linkText }).first().click();
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
  _responseData: any = { success: true }
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
