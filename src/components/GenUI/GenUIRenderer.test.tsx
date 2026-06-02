import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GenUIRenderer } from "./GenUIRenderer";

describe("GenUIRenderer", () => {
  it("renders custom HTML only inside a sandboxed iframe", () => {
    render(
      <GenUIRenderer
        app={{
          component: "Html",
          props: { html: "<script>window.parent.postMessage('x','*')</script><p>Mini app</p>" },
          target: "inline",
        }}
        onEvent={vi.fn()}
      />
    );

    const frame = screen.getByTitle("Generated mini-app");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("<p>Mini app</p>"));
    expect(screen.queryByText("Mini app")).not.toBeInTheDocument();
  });

  it("rewrites local attachment image references into data URLs", () => {
    render(
      <GenUIRenderer
        app={{
          component: "Html",
          props: { html: '<img src="chart.png" alt="chart">' },
          target: "inline",
        }}
        attachments={[
          {
            name: "chart.png",
            dataUrl: "data:image/png;base64,abc123",
            mimeType: "image/png",
          },
        ]}
        onEvent={vi.fn()}
      />
    );

    expect(screen.getByTitle("Generated mini-app")).toHaveAttribute(
      "srcdoc",
      expect.stringContaining('src="data:image/png;base64,abc123"')
    );
  });
});
