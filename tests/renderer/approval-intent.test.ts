import { describe, expect, it } from "vitest";
import { classifyApprovalIntent } from "../../src/renderer/src/lib/approval-intent";

// xqc.1: conversational approval — map a natural-language reply made while a
// gated tool is paused to approve / decline / unclear.
describe("classifyApprovalIntent (xqc.1)", () => {
  it("reads affirmative replies as approve", () => {
    for (const t of [
      "yes",
      "Yes please",
      "yeah go ahead",
      "sure, do it",
      "ok",
      "approve",
      "proceed",
      "send it",
      "deploy it",
      "lgtm",
      "looks good, ship it",
    ]) {
      expect(classifyApprovalIntent(t)).toBe("approve");
    }
  });

  it("reads negative replies as decline", () => {
    for (const t of [
      "no",
      "nope",
      "don't",
      "do not deploy that",
      "stop",
      "cancel",
      "abort",
      "not now",
      "hold on",
      "wait",
    ]) {
      expect(classifyApprovalIntent(t)).toBe("decline");
    }
  });

  it("lets decline win when both signals appear (explicit no beats incidental yes)", () => {
    expect(classifyApprovalIntent("ok actually no, cancel that")).toBe("decline");
    expect(classifyApprovalIntent("yeah no don't")).toBe("decline");
  });

  it("returns unclear for replies it can't confidently read", () => {
    for (const t of ["", "   ", "what does this command do?", "show me the file first", "hmm"]) {
      expect(classifyApprovalIntent(t)).toBe("unclear");
    }
  });
});
