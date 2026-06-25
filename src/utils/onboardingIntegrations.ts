export type OnboardingPluginFlags = Record<string, boolean>;

export function getOnboardingIntegrationIds(
  plugins: OnboardingPluginFlags,
  options?: {
    githubRepos?: string[];
  }
): string[] {
  const integrations: string[] = [];

  if (plugins.slack) integrations.push("slack");
  if (plugins.email) integrations.push("email_read");
  if (plugins.calendar) integrations.push("calendar_read");
  if (plugins.imessage) integrations.push("imessage");
  if (plugins.github) integrations.push("github");
  if (plugins.telegram) integrations.push("telegram");
  if (plugins.discord) integrations.push("discord");
  if (plugins.twilio) integrations.push("twilio");
  if (plugins.photos) integrations.push("apple_photos");

  if (plugins.github) {
    for (const repo of options?.githubRepos || []) {
      const integrationId = `github_repo_${repo}`;
      if (repo && !integrations.includes(integrationId)) {
        integrations.push(integrationId);
      }
    }
  }

  return integrations;
}
