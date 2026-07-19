export const getInitialOnboardingStep = (
  draftStep: number | undefined,
  hasCompletedInitialSetup: boolean,
): number => {
  if (draftStep !== undefined && draftStep !== -1) return draftStep;
  // Workstream A: first-run no longer blocks on the engine gate (step -1).
  // Engine provisioning runs as a background job started on wizard mount;
  // the Deploy step gates on it only if it hasn't finished by then.
  return hasCompletedInitialSetup ? 1 : 0;
};
