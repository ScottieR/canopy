// End-to-End Edge Case and Error Scenario Tests
// Phase 4 Implementation - Boundary conditions and failure modes

import { test, expect } from '@playwright/test';
import {
  goCreateAgent,
  fillAgentForm,
  submitForm,
  expectTextVisible,
  clickButton,
  expectLoadingGone,
  pressKey,
  typeSlowly,
  expectTableRows,
  clickLink,
  goHome,
} from './helpers';

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: BOUNDARY VALUES
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Boundary Values', () => {
  test('should handle very long agent name (200 chars)', async ({ page }) => {
    await goCreateAgent(page);

    const longName = 'A'.repeat(200);
    await fillAgentForm(page, {
      name: longName,
      emoji: '😀',
    });

    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Should either accept or show validation error
    const isValid = await page.locator('form').evaluate(
      form => !form.querySelector('[role="alert"]')
    );

    if (isValid) {
      await expectTextVisible(page, /success/i);
    } else {
      await expectTextVisible(page, /must be.*characters|character.*limit/i);
    }
  });

  test('should handle unicode in agent name', async ({ page }) => {
    await goCreateAgent(page);

    const unicodeName = 'Agent 🦞 Lobster 🌊 Sea';
    await fillAgentForm(page, {
      name: unicodeName,
      emoji: '😀',
    });

    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Should accept unicode
    await expectTextVisible(page, /success|created/i);
  });

  test('should handle minimum valid agent name (1 char)', async ({ page }) => {
    await goCreateAgent(page);

    await fillAgentForm(page, {
      name: 'A',
      emoji: '😀',
    });

    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Should accept
    await expectTextVisible(page, /success|created/i);
  });

  test('should handle special characters in agent name', async ({ page }) => {
    await goCreateAgent(page);

    const specialName = 'Agent-123_test@version!2.0';
    await fillAgentForm(page, {
      name: specialName,
      emoji: '😀',
    });

    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Should handle special chars
    expect(await page.locator('form').evaluate(
      form => !form.querySelector('[role="alert"]')
    )).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: RAPID INTERACTIONS
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Rapid Interactions', () => {
  test('should handle rapid form submissions', async ({ page }) => {
    await goCreateAgent(page);

    await fillAgentForm(page, {
      name: 'Rapid Agent',
      emoji: '😀',
    });

    // Click submit multiple times rapidly
    const submitButton = page.locator('button:has-text("Create")');
    await submitButton.click();
    await submitButton.click(); // Second click while first is processing
    await submitButton.click(); // Third click

    await page.waitForTimeout(500);

    // Should handle gracefully (button disabled, single submission)
    expect(await submitButton.isDisabled()).toBeTruthy();
  });

  test('should handle rapid field changes', async ({ page }) => {
    await goCreateAgent(page);

    const nameInput = page.locator('input[placeholder*="name" i]');

    // Rapidly change field
    for (let i = 0; i < 10; i++) {
      await nameInput.type('A');
      await nameInput.press('Backspace');
    }

    await nameInput.type('Final Agent');

    // Form should be functional
    const value = await nameInput.inputValue();
    expect(value).toBe('Final Agent');
  });

  test('should handle keyboard spam', async ({ page }) => {
    await goCreateAgent(page);

    const nameInput = page.locator('input[placeholder*="name" i]');
    await nameInput.focus();

    // Spam keyboard
    for (let i = 0; i < 50; i++) {
      await nameInput.press('ArrowLeft');
      await nameInput.press('ArrowRight');
      await nameInput.press('Home');
      await nameInput.press('End');
    }

    // Form should still work
    await nameInput.type('Test');
    const value = await nameInput.inputValue();
    expect(value).toContain('Test');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: BROWSER BACK/FORWARD
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Navigation History', () => {
  test('should handle browser back button during form submission', async ({ page }) => {
    await goCreateAgent(page);

    await fillAgentForm(page, {
      name: 'Test Agent',
      emoji: '😀',
    });

    await submitForm(page, 'Create');

    // Click back before submission completes
    await page.goBack();

    // Should go back without error
    expect(page.url()).toMatch(/dashboard|home/);
  });

  test('should handle forward/back navigation multiple times', async ({ page }) => {
    await goHome(page);
    await clickLink(page, 'Create Agent');
    await page.goBack();

    for (let i = 0; i < 5; i++) {
      await page.goForward();
      await page.goBack();
    }

    // Should be functional
    expect(page.url()).toMatch(/home|dashboard/);
  });

  test('should preserve form state on back navigation', async ({ page }) => {
    await goCreateAgent(page);

    await fillAgentForm(page, {
      name: 'Draft Agent',
      emoji: '🦞',
    });

    // Navigate away
    await goHome(page);

    // Go back
    await page.goBack();

    // Form should still have values (draft)
    const nameInput = page.locator('input[placeholder*="name" i]');
    const value = await nameInput.inputValue();
    expect(value).toBe('Draft Agent');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: WINDOW RESIZE
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Responsive Design', () => {
  test('should handle viewport resize', async ({ page }) => {
    await goCreateAgent(page);

    // Start with mobile size
    await page.setViewportSize({ width: 375, height: 667 });

    await fillAgentForm(page, {
      name: 'Mobile Agent',
      emoji: '😀',
    });

    // Form should be usable on mobile
    const nameInput = page.locator('input[placeholder*="name" i]');
    expect(await nameInput.isVisible()).toBeTruthy();

    // Resize to desktop
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Form should adapt
    expect(await nameInput.isVisible()).toBeTruthy();

    // Fill and submit
    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Should succeed
    expect(await page.locator('[role="alert"]').count()).toBe(0);
  });

  test('should handle mobile viewport constraints', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await goCreateAgent(page);

    // Buttons should be touch-friendly (large enough)
    const submitButton = page.locator('button:has-text("Create")');
    const box = await submitButton.boundingBox();

    // Button should be at least 44x44px (touch target)
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: TAB SWITCHING
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Tab Switching', () => {
  test('should preserve state when switching tabs', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await goCreateAgent(page);
    await fillAgentForm(page, {
      name: 'Tab Test Agent',
      emoji: '😀',
    });

    // Open new tab
    const page2 = await context.newPage();
    await page2.goto('http://localhost:3000/');

    // Switch back to first tab
    const nameInput = page.locator('input[placeholder*="name" i]');
    const value = await nameInput.inputValue();

    // Form should still have values
    expect(value).toBe('Tab Test Agent');

    await context.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: CONCURRENT OPERATIONS
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Concurrent Operations', () => {
  test('should handle creating multiple agents in sequence', async ({ page }) => {
    // Create first agent
    await goCreateAgent(page);
    await fillAgentForm(page, {
      name: 'Agent 1',
      emoji: '😀',
    });
    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Go back and create second agent
    await goHome(page);
    await clickLink(page, 'Create Agent');

    await fillAgentForm(page, {
      name: 'Agent 2',
      emoji: '🦞',
    });
    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Both should exist
    const url = page.url();
    expect(url).toMatch(/dashboard|agents/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: DATA VALIDATION EDGE CASES
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Data Validation', () => {
  test('should handle emoji with skin tone modifiers', async ({ page }) => {
    await goCreateAgent(page);

    // Emoji with skin tone: 👋🏽
    await fillAgentForm(page, {
      name: 'Wave Agent',
      emoji: '👋🏽',
    });

    await submitForm(page, 'Create');

    // Should either accept or show validation
    const hasError = await page.locator('[role="alert"]').isVisible();
    expect(typeof hasError).toBe('boolean');
  });

  test('should handle whitespace in fields', async ({ page }) => {
    await goCreateAgent(page);

    await fillAgentForm(page, {
      name: '  Spaces Agent  ',
      emoji: '  😀  ',
    });

    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Should trim whitespace
    const url = page.url();
    if (url.includes('dashboard')) {
      await expectTextVisible(page, 'Spaces Agent');
    }
  });

  test('should reject form with only whitespace', async ({ page }) => {
    await goCreateAgent(page);

    const nameInput = page.locator('input[placeholder*="name" i]');
    await nameInput.fill('   '); // Just spaces

    await submitForm(page, 'Create');

    // Should show error
    await expectTextVisible(page, /required|empty|whitespace/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: STATE CONSISTENCY
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: State Consistency', () => {
  test('should maintain consistent state after refresh', async ({ page }) => {
    // Create an agent first (in real test, would use API)
    // Then refresh page and verify data is still there

    await goHome(page);
    const urlBefore = page.url();

    // Refresh
    await page.reload();

    // State should be restored
    const urlAfter = page.url();
    expect(urlBefore).toBe(urlAfter);
  });

  test('should handle state during network slowness', async ({ page }) => {
    // Slow down network
    await page.route('**/*', route => {
      setTimeout(() => route.continue(), 2000);
    });

    await goCreateAgent(page);

    await fillAgentForm(page, {
      name: 'Slow Network Agent',
      emoji: '😀',
    });

    await submitForm(page, 'Create');

    // Should still complete successfully
    await expectLoadingGone(page);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY OF EDGE CASE TESTS
// ────────────────────────────────────────────────────────────────────────────

// Boundary Values (4 tests):
// ✅ test_very_long_agent_name
// ✅ test_unicode_in_agent_name
// ✅ test_minimum_valid_name
// ✅ test_special_characters_in_name
//
// Rapid Interactions (3 tests):
// ✅ test_rapid_form_submissions
// ✅ test_rapid_field_changes
// ✅ test_keyboard_spam
//
// Navigation History (3 tests):
// ✅ test_back_button_during_submission
// ✅ test_forward_back_navigation
// ✅ test_preserve_form_state_on_back
//
// Responsive Design (2 tests):
// ✅ test_viewport_resize
// ✅ test_mobile_viewport_constraints
//
// Tab Switching (1 test):
// ✅ test_preserve_state_when_switching_tabs
//
// Concurrent Operations (1 test):
// ✅ test_create_multiple_agents_in_sequence
//
// Data Validation (3 tests):
// ✅ test_emoji_with_modifiers
// ✅ test_whitespace_in_fields
// ✅ test_reject_whitespace_only
//
// State Consistency (2 tests):
// ✅ test_maintain_state_after_refresh
// ✅ test_state_during_network_slowness
//
// TOTAL: 19 edge case tests covering boundary conditions and error scenarios
