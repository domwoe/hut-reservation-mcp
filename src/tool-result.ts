import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function okResult(output: unknown): CallToolResult {
  const structuredContent = toStructuredContent(output);
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent
  };
}

export function errorResult(error: unknown): CallToolResult {
  const output = {
    error: error instanceof Error ? error.message : String(error)
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output
  };
}

function toStructuredContent(output: unknown): Record<string, unknown> {
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return { value: output };
}
