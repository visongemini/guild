import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLiveDesktopService } from "../apps/desktop/dist/main/live-service.js";

const root = await mkdtemp(join(tmpdir(), "guild-live-runtime-"));
const workspacePath = process.argv[2] ?? process.cwd();
const prompt = process.argv[3]
  ?? "只读评审当前工作区里的 bananafit 项目。最多使用 12 次工具，只检查入口、数据保存和一个核心页面；列出 3 个最值得改进的问题，总回复不超过 500 字。不要修改任何文件。";
const timeoutMs = Number.parseInt(process.env.GUILD_DIAGNOSTIC_TIMEOUT_MS ?? "420000", 10);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("diagnostic_timeout_invalid");
}

const service = createLiveDesktopService({
  appVersion: "2.0.11-diagnostic",
  databasePath: join(root, "guild.sqlite3"),
  stagingRoot: join(root, "staging"),
  chooseWorkspace: async () => workspacePath,
});

let lastSummary = "";
const decidedPermissions = new Set();
let phase = 1;

try {
  const selected = await service.chooseWorkspace();
  const workspace = selected.workspaces.find((item) => item.name === "Cowork")
    ?? selected.workspaces[0];
  if (workspace === undefined) throw new Error("diagnostic_workspace_not_created");
  const created = await service.createTask(workspace.workspaceId);
  const sent = await service.sendMessage(created.task.taskId, prompt);
  console.log("guild_diagnostic_started", JSON.stringify({ root, sent }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const projection = await service.bootstrap();
    const active = projection.activeTask;
    const summary = JSON.stringify({
      state: active?.task.activeRunState,
      counts: active?.timeline.reduce((counts, item) => ({
        ...counts,
        [item.kind]: (counts[item.kind] ?? 0) + 1,
      }), {}),
      lastAssistant: active?.timeline.findLast((item) => item.kind === "assistant")?.text.slice(-240),
    });
    if (summary !== lastSummary) {
      console.log("guild_diagnostic_projection", summary);
      lastSummary = summary;
    }
    const permission = active?.timeline.find((item) =>
      item.kind === "permission" && !decidedPermissions.has(item.permissionId));
    if (permission?.kind === "permission" && permission.runId !== undefined) {
      const option = permission.options.find((item) => item.kind === "allow_always")
        ?? permission.options.find((item) => item.kind === "allow_once");
      if (option === undefined) throw new Error("diagnostic_permission_has_no_allow_option");
      decidedPermissions.add(permission.permissionId);
      console.log("guild_diagnostic_permission", JSON.stringify({
        title: permission.title,
        option: option.kind,
        optionId: option.optionId,
      }));
      await service.decidePermission({
        taskId: permission.taskId,
        runId: permission.runId,
        permissionId: permission.permissionId,
        decision: { type: "selected", optionId: option.optionId },
      });
    }
    if (active?.task.activeRunState === "completed" && phase === 1) {
      phase = 2;
      const followUp = await service.sendMessage(
        created.task.taskId,
        "这是同一会话的第二轮。不要使用工具，只回复：GUILD-LIVE-CONTINUATION-OK。",
      );
      console.log("guild_diagnostic_follow_up", JSON.stringify(followUp));
      continue;
    }
    if (["completed", "interrupted", "cancelled", "failed"].includes(active?.task.activeRunState ?? "")) {
      process.exitCode = active?.task.activeRunState === "completed" && phase === 2 ? 0 : 2;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (Date.now() >= deadline) {
    process.exitCode = 3;
    console.error("guild_diagnostic_timeout", root);
  }
} finally {
  await service.close();
}
