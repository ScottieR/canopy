export const getInitialOnboardingStep = (
  draftStep: number | undefined,
  hasCompletedInitialSetup: boolean,
): number => {
  if (draftStep !== undefined && draftStep !== -1) return draftStep;
  return hasCompletedInitialSetup ? 1 : -1;
};
