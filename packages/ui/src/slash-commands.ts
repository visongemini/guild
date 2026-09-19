import type { GuildLocale, RuntimeCommand } from "@guild/contracts";

/**
 * PC-CONV-001 / D-023: instant, versioned fallback for Grok 1.0.13 core commands.
 * The active ACP session remains authoritative and replaces this catalogue as
 * soon as it publishes available_commands_update. Personal skill commands are
 * deliberately never bundled into the application.
 */
const GROK_1_0_13_CORE_COMMANDS = Object.freeze([
  ["compact", "压缩对话历史以节省上下文", "Compress conversation history to save context", "可选：要保留的内容", "optional context about what to preserve"],
  ["always-approve", "切换免确认模式", "Toggle always-approve mode", "on|off", "on|off"],
  ["flush", "立即把对话记忆写入磁盘", "Flush conversation memory to disk now"],
  ["dream", "运行记忆整理", "Run memory consolidation"],
  ["memory", "浏览和管理记忆", "Browse and manage memories", "on|off", "on|off"],
  ["context", "查看上下文用量和会话统计", "Show context usage and session stats"],
  ["hooks-trust", "信任当前项目的 Hook", "Trust this project for hooks"],
  ["hooks-list", "查看当前会话加载的 Hook", "Show hooks loaded in this session"],
  ["hooks-add", "添加 Hook 文件或目录", "Add a hook file or directory", "Hook 路径", "hook path"],
  ["hooks-remove", "移除 Hook 文件或目录", "Remove a hook file or directory", "Hook 路径", "hook path"],
  ["hooks-untrust", "取消当前项目的 Hook 信任", "Remove hook trust for this project"],
  ["plugins", "管理插件", "Manage plugins", "list | reload | trust | add | remove", "list | reload | trust | add | remove"],
  ["reload-plugins", "重新从磁盘加载插件", "Reload plugins from disk"],
  ["session-info", "查看模型、轮次和上下文详情", "Show model, turns, and context details"],
  ["feedback", "发送当前会话的反馈", "Send feedback about this session", "反馈内容", "feedback text"],
  ["deep-research", "启动有边界的深度研究", "Start bounded deep research", "研究问题", "research query"],
  ["workflow", "启动或管理工作流", "Launch or manage a workflow", "名称或管理动作", "name or action"],
  ["goal", "设置、管理或查看自主目标", "Set, manage, or inspect an autonomous goal", "目标 | status | pause | resume | clear", "objective | status | pause | resume | clear"],
  ["loop", "按固定间隔重复运行提示词", "Run a prompt on a recurring interval", "间隔和提示词", "interval and prompt"],
] as const);

function createBundledSlashCommands(locale: GuildLocale): readonly RuntimeCommand[] {
  const chinese = locale === "zh-CN";
  return Object.freeze(GROK_1_0_13_CORE_COMMANDS.map((item) => Object.freeze({
    name: item[0],
    description: chinese ? item[1] : item[2],
    ...(item[3] === undefined ? {} : { inputHint: chinese ? item[3] : item[4] }),
  })));
}

const BUNDLED_SLASH_COMMANDS = Object.freeze({
  "zh-CN": createBundledSlashCommands("zh-CN"),
  "en-US": createBundledSlashCommands("en-US"),
});

export function bundledSlashCommands(locale: GuildLocale): readonly RuntimeCommand[] {
  return BUNDLED_SLASH_COMMANDS[locale];
}

export function slashCommandCatalogue(
  officialCommands: readonly RuntimeCommand[],
  locale: GuildLocale,
): readonly RuntimeCommand[] {
  return officialCommands.length > 0 ? officialCommands : bundledSlashCommands(locale);
}

export function slashCommandQuery(draft: string): string | undefined {
  const match = /^\/([^\s/]*)$/u.exec(draft);
  return match?.[1]?.toLocaleLowerCase();
}

export function matchingSlashCommands(
  commands: readonly RuntimeCommand[],
  draft: string,
): readonly RuntimeCommand[] {
  const query = slashCommandQuery(draft);
  if (query === undefined) return Object.freeze([]);
  return Object.freeze(
    commands.filter((command) => command.name.toLocaleLowerCase().includes(query)),
  );
}

export function slashCommandText(command: RuntimeCommand): string {
  return `/${command.name}${command.inputHint === undefined ? "" : " "}`;
}
