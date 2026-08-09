import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedTool } from "../src/roles.js";

test("the navigator gets only file inspection and pair tools", () => {
  for (const tool of ["read", "grep", "ls", "find", "interject", "stay_quiet", "pair_note", "request_drive"]) {
    assert.equal(isAllowedTool(tool, []), true, tool);
  }

  // Shells, known writers, and unknown tools all fail closed.
  for (const tool of ["bash", "write", "edit", "apply_patch", "mcp__github__create_pr", "some_future_tool"]) {
    assert.equal(isAllowedTool(tool, []), false, tool);
  }
});

test("the driver can name extra read-only tools", () => {
  assert.equal(isAllowedTool("mcp__sentry__get_issue", ["mcp__sentry__get_issue"]), true);
  assert.equal(isAllowedTool("mcp__sentry__resolve", ["mcp__sentry__get_issue"]), false);
});
