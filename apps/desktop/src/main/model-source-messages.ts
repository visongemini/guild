import type { GuildLocale, ModelSourceKind } from "@guild/contracts";

// Paired native-dialog copy for the model source confirmation (same convention as restore-messages.ts;
// the renderer's own copy lives in the UI locale catalog).

/** What the native confirmation dialog shows. */
export type HostConfirmationPrompt = Readonly<{
  message: string;
  detail: string;
  cancelLabel: string;
  allowLabel: string;
}>;

const DISPLAY_MAX = 160;

/** Long paths and labels are shortened in the middle so the host and variable stay readable. */
function shortened(text: string): string {
  if (text.length <= DISPLAY_MAX) return text;
  const head = Math.ceil((DISPLAY_MAX - 3) / 2);
  return `${text.slice(0, head)}...${text.slice(text.length - (DISPLAY_MAX - 3 - head))}`;
}

export function hostConfirmationPrompt(input: {
  readonly locale: GuildLocale;
  /** An Online source sends its key and the conversation to a vendor; a Local one stays on this computer or the user's network. */
  readonly kind: ModelSourceKind;
  readonly label: string;
  readonly host: string;
  /** Null for a source that needs no key; the contract allows that for a Local source only. */
  readonly keyVariable: string | null;
  /** The file the key is read from (the default key file when the source names none). */
  readonly keyFile: string;
}): HostConfirmationPrompt {
  const label = shortened(input.label);
  const keyFile = shortened(input.keyFile);
  const { host, keyVariable } = input;
  const online = input.kind === "online" && keyVariable !== null;
  if (input.locale === "zh-CN") {
    if (keyVariable === null) {
      return {
        message: `允许 Guild 把 Claude 任务的对话发送到 ${host} 吗？`,
        detail: `来源「${label}」不需要密钥。使用它的模型时，对话内容只会发送到这个地址；该地址必须在本机或你的 Tailscale 网络内，否则 Guild 会拒绝。`,
        cancelLabel: "取消",
        allowLabel: "允许",
      };
    }
    return {
      message: online
        ? `允许 Guild 把 ${keyFile} 中的 ${keyVariable} 和 Claude 任务的对话发送到 ${host} 吗？`
        : `允许 Guild 把 ${keyFile} 中的 ${keyVariable} 发送到 ${host} 吗？`,
      detail: `密钥只保存在 Guild 的内存里，只会发送到 ${host}，不会写入数据库、界面或日志。使用来源「${label}」的模型时，对话内容也会发送到同一个地址。`,
      cancelLabel: "取消",
      allowLabel: "允许",
    };
  }
  if (keyVariable === null) {
    return {
      message: `Allow Guild to send Claude task conversations to ${host}?`,
      detail: `The source "${label}" needs no key. When a task uses its models, the conversation goes to this address only, and Guild refuses it unless it is on this computer or your Tailscale network.`,
      cancelLabel: "Cancel",
      allowLabel: "Allow",
    };
  }
  return {
    message: online
      ? `Allow Guild to send ${keyVariable} from ${keyFile} and Claude task conversations to ${host}?`
      : `Allow Guild to send ${keyVariable} from ${keyFile} to ${host}?`,
    detail: `The key stays in memory and is only sent to ${host}. It is never saved by Guild or written to logs. When a task uses models from "${label}", the conversation goes to the same address.`,
    cancelLabel: "Cancel",
    allowLabel: "Allow",
  };
}
