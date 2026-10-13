import type { GuildLocale } from "@guild/contracts";
import type { HostConfirmationPrompt } from "./model-source-messages.js";

// Paired native-dialog copy for the confirmation that binds an engine's API key to its host (PC-ENG-004). Same
// convention as model-source-messages.ts; the renderer's own copy lives in the UI locale catalog.

const DISPLAY_MAX = 160;

/** Long paths are shortened in the middle so the host and variable stay readable. */
function shortened(text: string): string {
  if (text.length <= DISPLAY_MAX) return text;
  const head = Math.ceil((DISPLAY_MAX - 3) / 2);
  return `${text.slice(0, head)}...${text.slice(text.length - (DISPLAY_MAX - 3 - head))}`;
}

export function engineKeyConfirmationPrompt(input: {
  readonly locale: GuildLocale;
  /** The engine as the user knows it ("Gemini"). */
  readonly engineName: string;
  readonly host: string;
  readonly keyVariable: string;
  /** The file the key is read from (the default key file when none is named). */
  readonly keyFile: string;
}): HostConfirmationPrompt {
  const keyFile = shortened(input.keyFile);
  const { engineName, host, keyVariable } = input;
  if (input.locale === "zh-CN") {
    return {
      message: `允许 Guild 把 ${keyFile} 中的 ${keyVariable} 发送到 ${host} 吗？`,
      detail: `这是 ${engineName} 的 API 密钥，按用量计费，费用记在你自己的账户上。密钥只保存在 Guild 的内存里，只会发送到 ${host}，不会写入数据库、界面或日志。${engineName} 任务的对话内容也会发送到同一个地址。`,
      cancelLabel: "取消",
      allowLabel: "允许",
    };
  }
  return {
    message: `Allow Guild to send ${keyVariable} from ${keyFile} to ${host}?`,
    detail: `This is the API key of ${engineName}, billed per use on your own account. The key stays in memory and is only sent to ${host}. It is never saved by Guild or written to logs. The conversation of ${engineName} tasks goes to the same address.`,
    cancelLabel: "Cancel",
    allowLabel: "Allow",
  };
}
