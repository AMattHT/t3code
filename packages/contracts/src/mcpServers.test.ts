import { describe, expect, it } from "@effect/vitest";

import { parseMcpServerUrl } from "./mcpServers.ts";

describe("parseMcpServerUrl", () => {
  it("accepts https anywhere and plain http only on this machine", () => {
    expect(parseMcpServerUrl(" https://mcp.higgsfield.ai/mcp ")).toBe(
      "https://mcp.higgsfield.ai/mcp",
    );
    expect(parseMcpServerUrl("http://localhost:3000/mcp")).toBe("http://localhost:3000/mcp");
    expect(parseMcpServerUrl("http://127.0.0.1:8080/mcp#x")).toBe("http://127.0.0.1:8080/mcp");
  });

  it("rejects remote http, embedded credentials, and non-URLs", () => {
    for (const input of [
      "http://mcp.example.com/mcp",
      "https://user:pass@mcp.example.com/mcp",
      "mcp.example.com",
      "ftp://mcp.example.com",
      "",
    ]) {
      expect(parseMcpServerUrl(input)).toBeNull();
    }
  });
});
