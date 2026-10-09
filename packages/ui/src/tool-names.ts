/*
 * The runtime names its tools in its own vocabulary (read_file, run_terminal_command, grep, ...).
 * The phase line shows what the tool does in plain words instead. A name that is not recognised
 * stays generic, and the caller keeps the raw name for a tooltip.
 */
export type ToolActionKind = "read" | "execute" | "edit" | "search" | "fetch";

const TOOL_ACTIONS: Readonly<Record<string, ToolActionKind>> = Object.freeze({
  read: "read", readfile: "read", readmanyfiles: "read", readtextfile: "read", view: "read", viewfile: "read",
  notebookread: "read", cat: "read", openfile: "read",
  bash: "execute", shell: "execute", runterminalcommand: "execute", runcommand: "execute", runshellcommand: "execute",
  terminal: "execute", execute: "execute", exec: "execute", command: "execute", powershell: "execute", bashoutput: "execute",
  edit: "edit", write: "edit", writefile: "edit", editfile: "edit", multiedit: "edit", strreplace: "edit",
  strreplaceeditor: "edit", strreplacebasededittool: "edit", applypatch: "edit", patch: "edit", notebookedit: "edit",
  createfile: "edit", replace: "edit", replaceinfile: "edit",
  search: "search", grep: "search", glob: "search", find: "search", ripgrep: "search", rg: "search",
  codebasesearch: "search", filesearch: "search", searchfiles: "search", grepsearch: "search", websearch: "search",
  fetch: "fetch", webfetch: "fetch", fetchurl: "fetch",
});

/** `Run-Terminal.Command` and `run_terminal_command` are the same tool. */
function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function classifyToolName(name: string | undefined): ToolActionKind | undefined {
  if (name === undefined) return undefined;
  const key = normalizedToolName(name);
  return Object.hasOwn(TOOL_ACTIONS, key) ? TOOL_ACTIONS[key] : undefined;
}

export const ZH_TOOL_ACTION: Readonly<Record<ToolActionKind, string>> = Object.freeze({
  read: "读取", execute: "运行命令", edit: "修改", search: "搜索", fetch: "联网获取",
});
