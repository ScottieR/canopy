// End-to-End Edge Case and Error Scenario Tests
//
// Refreshed 2026-08-06 alongside user-journeys.spec.ts. The previous version
// of this file was entirely built on the same fictional "Create Agent" form
// (goCreateAgent/fillAgentForm targeting name/emoji/color inputs that don't
// exist) plus routes and browser-history semantics that don't apply to this
// app (no /create-agent or /dashboard routes to navigate back/forward
// between). See user-journeys.spec.ts for the full explanation.
//
// This file keeps the *intent* of the original boundary-value, rapid-
// interaction, data-validation, and responsive-design checks, but retargets
// them at the one real always-available input surface: the "What should
// Eddie call you?" name field and the Custom-role discovery textarea in
// beat 1 of onboarding (src/pages/OnboardingWizard.tsx).
//
// Dropped entirely rather than patched (no equivalent exists without
// building substantial new coverage, out of scope for a stale-test
// refresh):
//   - Navigation History: relied on browser back/forward between
//     /create-agent and /dashboard routes that don't exist.
//   - Tab Switching / Concurrent Operations: relied on actually creating
//     agents, which requires the Tauri runtime (list_agents/create_agent
//     invoke calls reject outright when not running inside Tauri — see
//     App.tsx's `invoke` shim) and is out of scope here.
//   - State Consistency: the "network slowness" case submitted the
//     fictional create-agent form; the "refresh preserves URL" case doesn't
//     say anything meaningful for a single-route app.
//   - Emoji-with-skin-tone-modifier validation: there is no emoji field
//     anymore.

import { test, expect } from '@playwright/test';
import {
  resetOnboardingState,
  expectOnboardingVisible,
  getEddieNameInput,
  selectCustomRole,
  getDiscoveryTextarea,
  getDraftButton,
} from './helpers';

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: BOUNDARY VALUES
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Boundary Values', () => {
  test.beforeEach(async ({ page }) => {
    await resetOnboardingState(page);
  });

  test('should handle a very long name (200 chars)', async ({ page }) => {
    const longName = 'A'.repeat(200);
    await getEddieNameInput(page).fill(longName);
    await expect(getEddieNameInput(page)).toHaveValue(longName);

    await selectCustomRole(page);
    await getDiscoveryTextarea(page).fill('anything');
    await expect(getDraftButton(page)).toBeEnabled();
  });

  test('should handle unicode in the name field', async ({ page }) => {
    const unicodeName = 'Agent 🦞 Lobster 🌊 Sea';
    await getEddieNameInput(page).fill(unicodeName);
    await expect(getEddieNameInput(page)).toHaveValue(unicodeName);

    await selectCustomRole(page);
    await getDiscoveryTextarea(page).fill('anything');
    await expect(getDraftButton(page)).toBeEnabled();
  });

  test('should accept a minimum valid name (1 char)', async ({ page }) => {
    await getEddieNameInput(page).fill('A');
    await selectCustomRole(page);
    await getDiscoveryTextarea(page).fill('anything');
    await expect(getDraftButton(page)).toBeEnabled();
  });

  test('should handle special characters in the name field', async ({ page }) => {
    const specialName = 'Agent-123_test@version!2.0';
    await getEddieNameInput(page).fill(specialName);
    await expect(getEddieNameInput(page)).toHaveValue(specialName);

    await selectCustomRole(page);
    await getDiscoveryTextarea(page).fill('anything');
    await expect(getDraftButton(page)).toBeEnabled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: RAPID INTERACTIONS
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Rapid Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await resetOnboardingState(page);
  });

  test('should handle rapid field changes', async ({ page }) => {
    const nameInput = getEddieNameInput(page);

    for (let i = 0; i < 10; i++) {
      await nameInput.type('A');
      await nameInput.press('Backspace');
    }
    await nameInput.type('Final Agent');

    await expect(nameInput).toHaveValue('Final Agent');
  });

  test('should handle keyboard spam', async ({ page }) => {
    const nameInput = getEddieNameInput(page);
    await nameInput.focus();

    for (let i = 0; i < 50; i++) {
      await nameInput.press('ArrowLeft');
      await nameInput.press('ArrowRight');
      await nameInput.press('Home');
      await nameInput.press('End');
    }

    await nameInput.type('Test');
    await expect(nameInput).toHaveValue(/Test/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: DATA VALIDATION
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Data Validation', () => {
  test.beforeEach(async ({ page }) => {
    await resetOnboardingState(page);
  });

  test('should not treat a whitespace-only name as valid', async ({ page }) => {
    await getEddieNameInput(page).fill('   ');
    await selectCustomRole(page);
    await getDiscoveryTextarea(page).fill('anything');

    // userName.trim() gates the CTA (OnboardingWizard.tsx) — spaces alone
    // must not enable it.
    await expect(getDraftButton(page)).toBeDisabled();
  });

  test('should accept a name with incidental leading/trailing whitespace', async ({ page }) => {
    await getEddieNameInput(page).fill('  Scottie  ');
    await selectCustomRole(page);
    await getDiscoveryTextarea(page).fill('anything');

    await expect(getDraftButton(page)).toBeEnabled();
  });

  test('should not treat whitespace-only discovery text as a described need', async ({ page }) => {
    await getEddieNameInput(page).fill('Scottie');
    await selectCustomRole(page);
    await getDiscoveryTextarea(page).fill('   ');

    await expect(getDraftButton(page)).toBeDisabled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASE: RESPONSIVE DESIGN
// ────────────────────────────────────────────────────────────────────────────

test.describe('Edge Cases: Responsive Design', () => {
  test.beforeEach(async ({ page }) => {
    await resetOnboardingState(page);
  });

  test('should stay usable across a mobile-to-desktop viewport resize', async ({ page }) => {
    // OnboardingWizard.tsx has explicit isVeryNarrowWindow/isNarrowWindow/
    // isCompactWindow breakpoints driving this layout — this exercises them
    // directly rather than testing a fictional generic form.
    await page.setViewportSize({ width: 375, height: 667 });
    await expectOnboardingVisible(page);
    await expect(getEddieNameInput(page)).toBeVisible();

    await getEddieNameInput(page).fill('Mobile Agent');
    await expect(getEddieNameInput(page)).toHaveValue('Mobile Agent');

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(getEddieNameInput(page)).toBeVisible();
    await expect(getEddieNameInput(page)).toHaveValue('Mobile Agent');
  });

  test('should keep the primary CTA touch-friendly on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await expectOnboardingVisible(page);

    const draftButton = getDraftButton(page);
    await expect(draftButton).toBeVisible();
    const box = await draftButton.boundingBox();

    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(36);
  });
});
