export const getInitialOnboardingStep = (
  draftStep: number | undefined,
  hasCompletedInitialSetup: boolean,
): number => {
  if (draftStep !== undefined && draftStep !== -1) {
    if (draftStep === 2.5) return 2;
    if (draftStep === 4 || draftStep === 5) return 3;
    return draftStep;
  }
  // Workstream A: first-run no longer blocks on the engine gate (step -1).
  // Engine provisioning runs as a background job started on wizard mount;
  // the Deploy step gates on it only if it hasn't finished by then.
  return hasCompletedInitialSetup ? 1 : 0;
};
