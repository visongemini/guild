import assert from "node:assert/strict";
import test from "node:test";
import type { PromptAttachment } from "@guild/contracts";
import { promptAttachmentsEqual, shouldClearSubmittedAttachments } from "./composer-submission.js";

const a = Object.freeze({ relativePath: "a.txt", name: "a.txt", size: 1 }) satisfies PromptAttachment;
const b = Object.freeze({ relativePath: "b.txt", name: "b.txt", size: 2 }) satisfies PromptAttachment;

test("a delayed send cannot clear another task's attachments", () => {
  assert.equal(shouldClearSubmittedAttachments({
    activeTaskId: "task-b",
    submittedTaskId: "task-a",
    currentAttachments: [b],
    submittedAttachments: [a],
  }), false);
});

test("a delayed send preserves attachments added while it was pending", () => {
  assert.equal(shouldClearSubmittedAttachments({
    activeTaskId: "task-a",
    submittedTaskId: "task-a",
    currentAttachments: [a, b],
    submittedAttachments: [a],
  }), false);
  assert.equal(promptAttachmentsEqual([a], [{ ...a }]), true);
  assert.equal(shouldClearSubmittedAttachments({
    activeTaskId: "task-a",
    submittedTaskId: "task-a",
    currentAttachments: [a],
    submittedAttachments: [a],
  }), true);
});
