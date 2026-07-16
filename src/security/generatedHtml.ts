export const GENERATED_HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "navigate-to 'none'",
].join("; ");

const MAX_GENERATED_HTML_LENGTH = 1_000_000;

/**
 * Adds a restrictive policy before untrusted, agent-generated markup is parsed.
 * The iframe sandbox remains the primary boundary; this policy additionally blocks
 * network exfiltration, nested frames, forms, and plugin content from inside it.
 */
export function isolateGeneratedHtml(html: unknown): string {
  const source = typeof html === "string" ? html : "";
  if (source.length > MAX_GENERATED_HTML_LENGTH) {
    return "<!doctype html><meta charset=\"utf-8\"><p>Generated app is too large to preview safely.</p>";
  }

  const policy = `<meta http-equiv="Content-Security-Policy" content="${GENERATED_HTML_CSP}"><meta name="referrer" content="no-referrer">`;
  if (/<head(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`);
  }
  const doctype = source.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) {
    return source.replace(doctype[0], `${doctype[0]}${policy}`);
  }
  return `${policy}${source}`;
}
