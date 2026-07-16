import { describe, expect, it } from "vitest";
import { GENERATED_HTML_CSP, isolateGeneratedHtml } from "./generatedHtml";

describe("isolateGeneratedHtml", () => {
  it("injects the platform policy before generated markup", () => {
    const isolated = isolateGeneratedHtml("<html><head><title>App</title></head><body>ok</body></html>");
    expect(isolated.indexOf("Content-Security-Policy")).toBeLessThan(isolated.indexOf("<title>"));
    expect(isolated).toContain(GENERATED_HTML_CSP);
    expect(isolated).toContain("connect-src 'none'");
    expect(isolated).toContain("form-action 'none'");
  });

  it("does not trust a generated document's own permissive policy", () => {
    const isolated = isolateGeneratedHtml(
      '<meta http-equiv="Content-Security-Policy" content="default-src *"><script>1</script>',
    );
    expect(isolated.indexOf(GENERATED_HTML_CSP)).toBeLessThan(isolated.indexOf("default-src *"));
  });

  it("refuses oversized generated documents", () => {
    const isolated = isolateGeneratedHtml("x".repeat(1_000_001));
    expect(isolated).toContain("too large to preview safely");
    expect(isolated).not.toContain("x".repeat(100));
  });
});
