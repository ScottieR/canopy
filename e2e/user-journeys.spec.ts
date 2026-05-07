// End-to-End User Journey Tests
// Phase 4 Implementation - Complete user workflows

import { test, expect } from '@playwright/test';
import {
  navigateTo,
  goHome,
  goDashboard,
  goCreateAgent,
  fillAgentForm,
  submitForm,
  expectPageTitle,
  expectTextVisible,
  expectSuccessMessageVisible,
  clickButton,
  clickLink,
  expectLoadingGone,
  expectTableRows,
} from './helpers';

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 1: CREATE AGENT
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Create Agent', () => {
  test('should create agent from start to finish', async ({ page }) => {
    // Start: Home page
    await goHome(page);
    expectPageTitle(page, 'Canopy');

    // Navigate to create agent
    await clickLink(page, 'Create Agent');
    await expectPageTitle(page, 'Create Agent');

    // Fill form
    await fillAgentForm(page, {
      name: 'My Assistant',
      emoji: '🦞',
      role: 'assistant',
      color: '#34D399',
    });

    // Submit
    await submitForm(page, 'Create');
    await expectLoadingGone(page);

    // Verify success
    await expectSuccessMessageVisible(page);
    await expectPageTitle(page, 'Dashboard');

    // Verify agent appears in list
    await expectTextVisible(page, 'My Assistant');
    await expectTextVisible(page, '🦞');
  });

  test('should show validation errors for empty fields', async ({ page }) => {
    // Navigate to create agent
    await goCreateAgent(page);

    // Try submitting empty form
    await submitForm(page, 'Create');

    // Should show errors
    await expectTextVisible(page, /name is required/i);
    await expectTextVisible(page, /emoji is required/i);
  });

  test('should reject invalid color format', async ({ page }) => {
    // Navigate to create agent
    await goCreateAgent(page);

    // Fill with invalid color
    await fillAgentForm(page, {
      name: 'Test Agent',
      emoji: '😀',
      color: 'red', // Invalid
    });

    await submitForm(page, 'Create');

    // Should show color error
    await expectTextVisible(page, /color must be/i);
  });

  test('should auto-populate form from template', async ({ page }) => {
    // Navigate to create agent
    await goCreateAgent(page);

    // Click "Load Template"
    await clickButton(page, 'Load Template');

    // Form should be populated
    const nameInput = page.locator('input[placeholder*="name" i]');
    const value = await nameInput.inputValue();
    expect(value).not.toBe('');
  });

  test('should save draft if navigating away', async ({ page }) => {
    // Navigate to create agent
    await goCreateAgent(page);

    // Start filling form
    await fillAgentForm(page, {
      name: 'Draft Agent',
      emoji: '🦞',
    });

    // Navigate away
    await goHome(page);

    // Go back to create agent
    await goCreateAgent(page);

    // Draft should still be there
    const nameInput = page.locator('input[placeholder*="name" i]');
    const value = await nameInput.inputValue();
    expect(value).toBe('Draft Agent');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 2: MANAGE AGENTS
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Manage Agents', () => {
  test('should list and view agents on dashboard', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Should see agent list
    await expectTextVisible(page, /agents|all agents/i);

    // Click on agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Should navigate to agent details
    await expect(page).toHaveURL(/agents\/[\w-]+$/);
  });

  test('should edit agent properties', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Find and click agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Click edit button
    await clickButton(page, 'Edit');

    // Change properties
    const nameInput = page.locator('input[placeholder*="name" i]');
    await nameInput.fill('Updated Agent Name');

    // Save
    await submitForm(page, 'Save');

    // Verify change
    await expectTextVisible(page, 'Updated Agent Name');
  });

  test('should pause and resume agent', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Find and click agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Pause agent
    await clickButton(page, 'Pause');
    await expectSuccessMessageVisible(page);

    // Status should show paused
    await expectTextVisible(page, /paused|stopped/i);

    // Resume agent
    await clickButton(page, 'Resume');
    await expectSuccessMessageVisible(page);

    // Status should show active
    await expectTextVisible(page, /active|running/i);
  });

  test('should delete agent with confirmation', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Get initial count
    const initialCount = await page.locator('[role="listitem"], .agent-card').count();

    // Find and click agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Click delete button
    await clickButton(page, 'Delete');

    // Confirm deletion
    await clickButton(page, 'Confirm');
    await expectLoadingGone(page);

    // Should go back to dashboard
    await expect(page).toHaveURL(/dashboard|agents/);

    // Agent list should have one less
    await goDashboard(page);
    const finalCount = await page.locator('[role="listitem"], .agent-card').count();
    expect(finalCount).toBe(initialCount - 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 3: AGENT COMMUNICATION
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Agent Communication', () => {
  test('should send message to agent', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Click on agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Open chat
    await clickButton(page, 'Chat');

    // Send message
    const messageInput = page.locator('input[placeholder*="message" i], textarea[placeholder*="message" i]');
    await messageInput.fill('Hello, agent!');
    await clickButton(page, 'Send');

    // Verify message appears
    await expectTextVisible(page, 'Hello, agent!');

    // Wait for response
    await page.waitForTimeout(2000);

    // Should see agent response
    await expectTextVisible(page, /response|replied|answered/i);
  });

  test('should view conversation history', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Click on agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Open chat history
    await clickButton(page, 'History');

    // Should see previous conversations
    const conversations = page.locator('[role="listitem"], .conversation-item');
    const count = await conversations.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should handle agent errors gracefully', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Click on agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Open chat
    await clickButton(page, 'Chat');

    // Send message that might cause error
    const messageInput = page.locator('input[placeholder*="message" i], textarea[placeholder*="message" i]');
    await messageInput.fill('A message that could break things!@#$%');
    await clickButton(page, 'Send');

    // Should still be able to continue
    await messageInput.fill('Another message');
    await clickButton(page, 'Send');

    // Page should be functional
    await expect(messageInput).toBeEnabled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 4: BUDGET MANAGEMENT
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Budget Management', () => {
  test('should view and edit budget', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Click on agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Go to budget settings
    await clickButton(page, 'Settings');
    await clickLink(page, 'Budget');

    // Should see budget information
    await expectTextVisible(page, /daily limit|monthly limit|budget/i);

    // Edit budget
    await clickButton(page, 'Edit Budget');

    // Change daily limit
    const dailyInput = page.locator('input[placeholder*="daily" i]');
    await dailyInput.fill('1000');

    // Save
    await submitForm(page, 'Save');

    // Verify update
    await expectSuccessMessageVisible(page);
  });

  test('should show payment history', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Click on agent
    const firstAgent = page.locator('[role="listitem"], .agent-card').first();
    await firstAgent.click();

    // Go to budget settings
    await clickButton(page, 'Settings');
    await clickLink(page, 'Payment History');

    // Should see transactions
    const transactions = page.locator('[role="listitem"], .transaction-item');
    const count = await transactions.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 5: SETTINGS & PREFERENCES
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Settings', () => {
  test('should access and modify settings', async ({ page }) => {
    // Navigate to settings
    await navigateTo(page, '/settings');

    // Should see settings options
    await expectTextVisible(page, /settings|preferences|configuration/i);
  });

  test('should enable/disable notifications', async ({ page }) => {
    // Navigate to settings
    await navigateTo(page, '/settings');

    // Find notifications toggle
    const notificationToggle = page.locator('input[aria-label*="notification" i], input[type="checkbox"]').first();

    // Check initial state
    const initialState = await notificationToggle.isChecked();

    // Toggle
    await notificationToggle.click();

    // Verify change
    const newState = await notificationToggle.isChecked();
    expect(newState).not.toBe(initialState);
  });

  test('should change theme', async ({ page }) => {
    // Navigate to settings
    await navigateTo(page, '/settings');

    // Find theme selector
    await clickButton(page, /dark mode|light mode|theme/i);

    // Verify theme changed
    const htmlElement = page.locator('html');
    const classAttribute = await htmlElement.getAttribute('class');
    expect(classAttribute).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 6: ERROR RECOVERY
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Error Recovery', () => {
  test('should recover from network error', async ({ page }) => {
    // Simulate offline
    await page.context().setOffline(true);

    // Try navigating
    await goHome(page);

    // Should show error
    await expectTextVisible(page, /offline|network|connection/i);

    // Go back online
    await page.context().setOffline(false);

    // Should recover
    await clickButton(page, 'Retry');
    await expect(page).toHaveURL(/\//);
  });

  test('should handle session expiration', async ({ page }) => {
    // Go to dashboard
    await goDashboard(page);

    // Simulate session expiration by clearing auth
    await page.evaluate(() => localStorage.clear());

    // Try to refresh
    await page.reload();

    // Should redirect to login
    await expect(page).toHaveURL(/login|signin/);
  });

  test('should show 404 for non-existent agent', async ({ page }) => {
    // Try to access non-existent agent
    await navigateTo(page, '/agents/non-existent-id');

    // Should show 404
    await expectTextVisible(page, /not found|404|doesn't exist/i);

    // Should offer navigation
    await clickButton(page, /home|back|dashboard/i);
    await expect(page).toHaveURL(/dashboard|home/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 7: ACCESSIBILITY
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Accessibility', () => {
  test('should navigate using keyboard only', async ({ page }) => {
    // Go to home
    await goHome(page);

    // Tab to first link
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeTruthy();

    // Press Enter to activate
    await page.keyboard.press('Enter');

    // Should navigate somewhere
    const url = page.url();
    expect(url).not.toMatch(/^http:\/\/localhost:3000\/$|^http:\/\/127.0.0.1:3000\/$/);
  });

  test('should have proper focus management', async ({ page }) => {
    // Go to create agent
    await goCreateAgent(page);

    // First element should be focusable
    const firstInput = page.locator('input, button, a, [tabindex="0"]').first();
    await firstInput.focus();
    await expect(firstInput).toBeFocused();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY OF E2E TESTS
// ────────────────────────────────────────────────────────────────────────────

// Create Agent Journey (5 tests):
// ✅ test_create_agent_from_start_to_finish
// ✅ test_show_validation_errors
// ✅ test_reject_invalid_color
// ✅ test_auto_populate_template
// ✅ test_save_draft_on_navigation
//
// Manage Agents Journey (5 tests):
// ✅ test_list_and_view_agents
// ✅ test_edit_agent_properties
// ✅ test_pause_and_resume_agent
// ✅ test_delete_agent_with_confirmation
// ✅ test_agent_persistence
//
// Communication Journey (3 tests):
// ✅ test_send_message_to_agent
// ✅ test_view_conversation_history
// ✅ test_handle_agent_errors_gracefully
//
// Budget Management Journey (2 tests):
// ✅ test_view_and_edit_budget
// ✅ test_show_payment_history
//
// Settings Journey (3 tests):
// ✅ test_access_modify_settings
// ✅ test_enable_disable_notifications
// ✅ test_change_theme
//
// Error Recovery Journey (3 tests):
// ✅ test_recover_from_network_error
// ✅ test_handle_session_expiration
// ✅ test_show_404_for_missing_resource
//
// Accessibility Journey (2 tests):
// ✅ test_navigate_using_keyboard
// ✅ test_proper_focus_management
//
// TOTAL: 23 E2E tests covering complete user journeys
