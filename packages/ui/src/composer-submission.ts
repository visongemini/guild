import type { PromptAttachment } from "@guild/contracts";

export function promptAttachmentsEqual(
  left: readonly PromptAttachment[],
  right: readonly PromptAttachment[],
): boolean {
  return left.length === right.length && left.every((attachment, index) => {
    const other = right[index];
    return other !== undefined &&
      attachment.relativePath === other.relativePath &&
      attachment.name === other.name &&
      attachment.size === other.size &&
      attachment.mimeType === other.mimeType;
  });
}

export function shouldClearSubmittedAttachments(input: Readonly<{
  activeTaskId: string | undefined;
  submittedTaskId: string;
  currentAttachments: readonly PromptAttachment[];
  submittedAttachments: readonly PromptAttachment[];
}>): boolean {
  return input.activeTaskId === input.submittedTaskId &&
    promptAttachmentsEqual(input.currentAttachments, input.submittedAttachments);
}
