import { describe, expect, it } from "vitest";
import { ELIDED_TURN_MARKER, sanitizeAssistantContent } from "./sanitize.js";

describe("sanitizeAssistantContent", () => {
  it("strips <|im_end|> and <|im_start|> chat template tokens", () => {
    const input =
      "<|im_start|>Hello, world. This is a longer legit response with enough content to survive the short-turn heuristic.<|im_end|>";
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe(
      "Hello, world. This is a longer legit response with enough content to survive the short-turn heuristic.",
    );
    expect(result.skipped).toBe(false);
  });

  it("strips <|endoftext|>, <|eot_id|>, and bos/eos markers", () => {
    const input =
      "<bos>hello<|endoftext|> world<|eot_id|><|begin_of_text|> ok <eos><|end_of_text|> and still plenty of legit content remaining to avoid the elision heuristic.";
    const result = sanitizeAssistantContent(input);
    expect(result.text).not.toContain("<|");
    expect(result.text).not.toContain("<bos>");
    expect(result.text).not.toContain("<eos>");
    expect(result.text).toContain("hello");
    expect(result.text).toContain("world");
    expect(result.text).toContain("ok");
    expect(result.skipped).toBe(false);
  });

  it("strips raw <tool_call>...</tool_call> XML blocks including multiline and multi-per-line", () => {
    const multiline = [
      "before",
      "<tool_call>",
      "<function=x>",
      "<parameter=y>",
      "z",
      "</parameter>",
      "</function>",
      "</tool_call>",
      "after",
    ].join("\n");
    const multilineResult = sanitizeAssistantContent(multiline);
    expect(multilineResult.text).toContain("before");
    expect(multilineResult.text).toContain("after");
    expect(multilineResult.text).not.toContain("<tool_call>");
    expect(multilineResult.text).not.toContain("<function=x>");

    const twoOnOneLine =
      "pre <tool_call><function=a></function></tool_call> mid <tool_call><function=b></function></tool_call> post";
    const twoResult = sanitizeAssistantContent(twoOnOneLine);
    expect(twoResult.text).toBe("pre  mid  post");
  });

  it("strips orphaned role-label-only lines", () => {
    const input = ["This is a real reply.", "assistant:", "user", "system: ", "Another line."].join(
      "\n",
    );
    const result = sanitizeAssistantContent(input);
    expect(result.text).toContain("This is a real reply.");
    expect(result.text).toContain("Another line.");
    expect(result.text).not.toMatch(/^assistant:\s*$/m);
    expect(result.text).not.toMatch(/^user\s*$/m);
    expect(result.text).not.toMatch(/^system:\s*$/m);
  });

  it("preserves legit content mentioning roles in prose", () => {
    const input = "The assistant then replied, and the user: asked another question.";
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe(input);
    expect(result.skipped).toBe(false);
  });

  it("marks a turn as skipped when cleaned content is empty", () => {
    const input = "<|im_start|><|im_end|><|endoftext|>";
    const result = sanitizeAssistantContent(input);
    expect(result.skipped).toBe(true);
  });

  it("marks a turn as skipped when cleaned content is only NO_REPLY", () => {
    expect(sanitizeAssistantContent("NO_REPLY").skipped).toBe(true);
    expect(sanitizeAssistantContent("no_reply").skipped).toBe(true);
    expect(sanitizeAssistantContent("  NO_REPLY  ").skipped).toBe(true);
    expect(sanitizeAssistantContent("<|im_end|>NO_REPLY<|im_end|>").skipped).toBe(true);
  });

  it("marks a turn as skipped when >50% was stripped and remainder is short", () => {
    const tokens = "<|im_end|>".repeat(60); // 600 chars of tokens
    const input = `${tokens}hi`;
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe("hi");
    expect(result.strippedRatio).toBeGreaterThan(0.5);
    expect(result.skipped).toBe(true);
  });

  it("does NOT mark long legit content as skipped even with a few tokens", () => {
    const paragraph = "This is a thoughtful paragraph of legitimate content. ".repeat(40); // ~2200 chars
    const input = `${paragraph}<|im_end|>`;
    const result = sanitizeAssistantContent(input);
    expect(result.skipped).toBe(false);
    expect(result.text).not.toContain("<|im_end|>");
    expect(result.text.length).toBeGreaterThan(1000);
    expect(result.text).toContain("thoughtful paragraph");
  });

  it("is a no-op on clean markdown content", () => {
    const input = [
      "# Heading",
      "",
      "Some **bold** text and a [link](https://example.com).",
      "",
      "- item 1",
      "- item 2",
    ].join("\n");
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe(input);
    expect(result.skipped).toBe(false);
    expect(result.strippedRatio).toBe(0);
  });

  it("exports the elided-turn marker for caller use", () => {
    expect(ELIDED_TURN_MARKER).toBe("[malformed turn elided]");
  });
});
