// End-to-End User Journey Tests
//
// Refreshed 2026-08-06. The previous version of this file drove a
// standalone "Create Agent" form page (name/emoji/role/color fields, a
// "Create" submit button, a "Dashboard" page title) and several other
// journeys (Manage Agents, Agent Communication, Budget Management,
// Settings, Error Recovery incl. login/session expiry, Accessibility)
// built around fictional routes: /create-agent, /dashboard, /agents/:id,
// /agents/:id/settings, /settings, /login.
//
// None of that exists in the current app. Canopy has no client-side router
// for top-level pages (see src/App.tsx) — it's a single Zustand-state-driven
// view, and there is no authentication/login flow at all. The real "create
// an agent" journey today is the conversational onboarding wizard
// (src/pages/OnboardingWizard.tsx), which only has three beats: "Meet
// Eddie" (role pick + AI-drafted agent + interview chat), "Meet your agent"
// (the appearance studio), and "Give them power" (the connections/routines/
// deploy conversation) — see tests/browser/onboarding_test.md for the full
// prose spec.
//
// This file now covers beat 1 (role pick → draft reveal), which is the
// piece the old suite was trying (and failing) to exercise, and which is
// reachable without a live canopy-admin backend or the Tauri runtime.
// Beats 2 and 3 involve a WebGL avatar viewer and a live-agent conversation
// that depends on canopy-admin/an LLM key, and are intentionally out of
// scope for this refresh — see tests/browser/onboarding_test.md for how to
// exercise them manually.
//
// The old Manage Agents / Communication / Budget / Settings / Error
// Recovery / Accessibility journeys have been removed rather than patched:
// they assumed page routes and an auth system that don't exist in this app,
// so replacing them with equivalent coverage would mean writing substantial
// new tests against the 3D world view, chat, budget, and settings UI from
// scratch — out of scope for a stale-test refresh.

import { test, expect } from '@playwright/test';
import {
  resetOnboardingState,
  expectOnboardingVisible,
  fillEddieName,
  getEddieNameInput,
  selectCustomRole,
  fillDiscoveryInput,
  getDiscoveryTextarea,
  getDraftButton,
  clickDraftButton,
  expectDraftPanelVisible,
  getAgentNameInput,
} from './helpers';

// ────────────────────────────────────────────────────────────────────────────
// USER JOURNEY 1: ONBOARDING — MEET EDDIE, MEET YOUR DRAFT (beat 1)
// ────────────────────────────────────────────────────────────────────────────

test.describe('User Journey: Onboarding — meet your draft', () => {
  test.beforeEach(async ({ page }) => {
    await resetOnboardingState(page);
  });

  test('should draft a custom agent from a typed need', async ({ page }) => {
    await expectOnboardingVisible(page);

    // Name yourself
    await fillEddieName(page, 'Scottie');

    // The CTA starts disabled and reads the fresh-install copy until a role
    // is picked.
    await expect(getDraftButton(page)).toBeDisabled();
    await expect(getDraftButton(page)).toHaveText(/draft my first agent/i);

    // Pick Custom and describe the need — Custom is always present
    // regardless of the data-driven featured-role list, which is why it's
    // the most stable role to drive in a test.
    await selectCustomRole(page);
    await expect(getDraftButton(page)).toBeDisabled(); // still needs discovery text

    await fillDiscoveryInput(page, 'help tutor my three boys in math');
    await expect(getDraftButton(page)).toBeEnabled();
    await expect(getDraftButton(page)).toHaveText(/draft custom agent/i);

    // The draft reveal panel (name, portrait, interview chat) appears the
    // instant a role is selected — no submit needed.
    await expectDraftPanelVisible(page);
  });

  test('should keep the draft CTA disabled until name and role are provided', async ({ page }) => {
    await expectOnboardingVisible(page);

    // Nothing filled in yet.
    await expect(getDraftButton(page)).toBeDisabled();

    // Only a name — still no role.
    await fillEddieName(page, 'Scottie');
    await expect(getDraftButton(page)).toBeDisabled();

    // A whitespace-only name should not count as a name.
    await getEddieNameInput(page).fill('   ');
    await expect(getDraftButton(page)).toBeDisabled();

    // Selecting Custom without any discovery text still leaves it disabled.
    await getEddieNameInput(page).fill('Scottie');
    await selectCustomRole(page);
    await expect(getDraftButton(page)).toBeDisabled();

    // Whitespace-only discovery text also doesn't count.
    await getDiscoveryTextarea(page).fill('   ');
    await expect(getDraftButton(page)).toBeDisabled();
  });

  test('should reveal an editable agent name once a role is drafted', async ({ page }) => {
    await fillEddieName(page, 'Scottie');
    await selectCustomRole(page);
    await fillDiscoveryInput(page, 'keep the household finances organized');

    await expectDraftPanelVisible(page);

    // The agent's own name is directly editable inside the draft panel and
    // is independent of "What should Eddie call you?" above it.
    const agentNameInput = getAgentNameInput(page);
    await agentNameInput.fill('Penny');
    await expect(agentNameInput).toHaveValue('Penny');
  });

  test('should persist an in-progress draft across a reload', async ({ page }) => {
    await selectCustomRole(page);
    await fillDiscoveryInput(page, 'draft persistence check — unique marker 4f2c');

    // OnboardingWizard autosaves step/role/discoveryInput/etc. to
    // localStorage (`canopy_onboarding_draft`) on every change and restores
    // it on mount — this is a real feature, distinct from the removed
    // "Load Template" test that had no corresponding UI.
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(getDiscoveryTextarea(page)).toHaveValue(/unique marker 4f2c/);
    await expectDraftPanelVisible(page);
  });
});
