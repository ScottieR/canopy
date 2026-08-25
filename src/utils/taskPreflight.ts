// Task preflight — cheap, deterministic capability matching run BEFORE a task
// executes (issue #60, 2026-08-24 CUJ test). In that test the user only learned
// twelve minutes in — by interrogating the agent — that the Veracross login,
// email sending, and a working browser were never available. The preflight's
// job is to turn that into a ten-second heads-up at send time.
//
// Deliberately keyword-based, not an LLM call: it must be instant, free, and
// predictable. It warns and links; it never blocks the send — false positives
// cost one dismissible banner, false negatives cost nothing that wasn't already
// broken.

export interface PreflightAgentView {
  capabilities?: { browser?: boolean } & Record<string, unknown>;
  integrations?: string[];
  browser_status?: { is_running: boolean } | null;
}

export interface PreflightGap {
  key: string;
  label: string;
  detail: string;
  /** Which tab resolves this gap. */
  cta: "connections" | "diagnostics";
}

const EMAIL_HINT = /\b(email|e-mail|inbox|gmail|mail(?:box)?)\b/i;
// Send-direction verbs near an email mention — "email them the forms",
// "send an email", "reply to", "forward the".
const EMAIL_SEND_HINT = /\b(send|write|reply|respond|forward|email)\b[^.!?\n]{0,60}\b(email|e-mail|mail|message|them|him|her|office|doctor|pediatrician|teacher|school)\b|\bemail\s+(it|them|him|her|the|my|our)\b/i;
const BROWSE_HINT = /\b(browse|log\s?in(?:to)?|log into|sign in|website|web\s?site|portal|download|navigate|open the site|https?:\/\/|\.(com|org|net|edu|gov)\b)/i;
const SLACK_HINT = /\bslack\b/i;
const CALENDAR_HINT = /\b(calendar|schedule (?:a |the )?(?:meeting|call|appointment)|invite)\b/i;

export function detectTaskPreflightGaps(
  message: string,
  agent: PreflightAgentView
): PreflightGap[] {
  const gaps: PreflightGap[] = [];
  const text = message || "";
  if (!text.trim()) return gaps;
  const integrations = agent.integrations || [];

  if (EMAIL_HINT.test(text)) {
    if (!integrations.includes("email_read") && !integrations.includes("email_write")) {
      gaps.push({
        key: "email_read",
        label: "Email access",
        detail: "This task mentions email, but email isn't connected for this agent.",
        cta: "connections",
      });
    } else if (EMAIL_SEND_HINT.test(text) && !integrations.includes("email_write")) {
      gaps.push({
        key: "email_write",
        label: "Email sending",
        detail: "This task looks like it needs to SEND email, but this agent can only read email right now.",
        cta: "connections",
      });
    }
  }

  if (BROWSE_HINT.test(text)) {
    if (!agent.capabilities?.browser) {
      gaps.push({
        key: "browser",
        label: "Web browsing",
        detail: "This task involves a website or portal, but web browsing isn't enabled for this agent.",
        cta: "connections",
      });
    } else if (agent.browser_status && agent.browser_status.is_running === false) {
      gaps.push({
        key: "browser_down",
        label: "Browser not running",
        detail: "This task involves a website or portal, and this agent's browser process isn't running right now.",
        cta: "diagnostics",
      });
    }
  }

  if (SLACK_HINT.test(text) && !integrations.includes("slack")) {
    gaps.push({
      key: "slack",
      label: "Slack",
      detail: "This task mentions Slack, but Slack isn't connected for this agent.",
      cta: "connections",
    });
  }

  if (CALENDAR_HINT.test(text) && !integrations.some(i => i.startsWith("calendar"))) {
    gaps.push({
      key: "calendar",
      label: "Calendar",
      detail: "This task mentions scheduling, but calendar access isn't connected for this agent.",
      cta: "connections",
    });
  }

  return gaps;
}
