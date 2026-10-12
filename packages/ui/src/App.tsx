import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/ArrowUpRight";
import { ArrowUUpLeftIcon as ArrowUUpLeft } from "@phosphor-icons/react/ArrowUUpLeft";
import { AppearanceSettings, useAppearance } from "./appearance.js";
import { CaretLeftIcon as CaretLeft } from "@phosphor-icons/react/CaretLeft";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/Archive";
import { ArrowsClockwiseIcon as ArrowsClockwise } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowsLeftRightIcon as ArrowsLeftRight } from "@phosphor-icons/react/ArrowsLeftRight";
import { ArrowUpIcon as ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { BrainIcon as Brain } from "@phosphor-icons/react/Brain";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/CaretRight";
import { ChatCircleDotsIcon as ChatCircleDots } from "@phosphor-icons/react/ChatCircleDots";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { CodeIcon as Code } from "@phosphor-icons/react/Code";
import { CommandIcon as Command } from "@phosphor-icons/react/Command";
import { CopyIcon as Copy } from "@phosphor-icons/react/Copy";
import { DotsThreeIcon as DotsThree } from "@phosphor-icons/react/DotsThree";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { FolderSimpleIcon as FolderSimple } from "@phosphor-icons/react/FolderSimple";
import { FolderSimplePlusIcon as FolderSimplePlus } from "@phosphor-icons/react/FolderSimplePlus";
import { FileTextIcon as FileText } from "@phosphor-icons/react/FileText";
import { FilesIcon as Files } from "@phosphor-icons/react/Files";
import { GitDiffIcon as GitDiff } from "@phosphor-icons/react/GitDiff";
import { GitForkIcon as GitFork } from "@phosphor-icons/react/GitFork";
import { GitMergeIcon as GitMerge } from "@phosphor-icons/react/GitMerge";
import { DownloadSimpleIcon as DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { GearSixIcon as GearSix } from "@phosphor-icons/react/GearSix";
import { GlobeIcon as Globe } from "@phosphor-icons/react/Globe";
import { InfoIcon as Info } from "@phosphor-icons/react/Info";
import { ImageSquareIcon as ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { PencilSimpleIcon as PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { PencilLineIcon as PencilLine } from "@phosphor-icons/react/PencilLine";
import { PaperclipIcon as Paperclip } from "@phosphor-icons/react/Paperclip";
import { PlusIcon as Plus } from "@phosphor-icons/react/Plus";
import { PushPinSimpleIcon as PushPinSimple } from "@phosphor-icons/react/PushPinSimple";
import { PushPinSimpleSlashIcon as PushPinSimpleSlash } from "@phosphor-icons/react/PushPinSimpleSlash";
import { SlidersHorizontalIcon as SlidersHorizontal } from "@phosphor-icons/react/SlidersHorizontal";
import { SidebarSimpleIcon as SidebarSimple } from "@phosphor-icons/react/SidebarSimple";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { ShieldWarningIcon as ShieldWarning } from "@phosphor-icons/react/ShieldWarning";
import { StopIcon as Stop } from "@phosphor-icons/react/Stop";
import { TerminalWindowIcon as TerminalWindow } from "@phosphor-icons/react/TerminalWindow";
import { TrashIcon as Trash } from "@phosphor-icons/react/Trash";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/Wrench";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { XIcon as X } from "@phosphor-icons/react/X";
import type {
  BrowserCommand,
  BrowserPaneProjection,
  GuildClaudePermissionMode,
  GuildEngine,
  GuildGrokModel,
  GuildGrokPermissionMode,
  GuildGrokReasoningEffort,
  GuildGrokStartupSettings,
  DesktopBootstrapProjection,
  GuildLocale,
  GuildNewTaskWorkspaceMode,
  GuildRendererApi,
  AcpToolKind,
  GuildSteerFallbackReason,
  LoadRunFileDiffResponse,
  RewindAvailabilityProjection,
  RunCheckpointProjection,
  RunId,
  RunModelProjection,
  ConversationSearchResult,
  ModelSourceProjection,
  RuntimeCommand,
  PromptAttachment,
  RunPhaseProjection,
  SetTaskRuntimeSettingsResponse,
  TaskViewProjection,
  TaskSummaryProjection,
  TimelineItemProjection,
  WorkspaceProjection,
} from "@guild/contracts";
import {
  canonicalGuildExternalUrl,
  nicknameInitial,
  parseGuildNickname,
} from "@guild/contracts/desktop-ipc";
import { modelGroupOf } from "@guild/contracts/grok-models";
import {
  createContext,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  type SyntheticEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import remarkGfm from "remark-gfm";
import { removeLegacyBannyPlacement } from "./banny-legacy.js";
import { resolveContextMenuSeed, type ContextMenuSeed } from "./context-menu.js";
import { WorktreeGlyph, useWorktreeUi } from "./Worktree.js";
import { worktreeMessagesFor } from "./worktree-messages.js";
import { slashCommandStatus, type SlashCommandStatus } from "./command-status.js";
import { observeExternalComposerInput } from "./composer-external-input.js";
import { contextWindowView } from "./context-window.js";
import {
  mergeTimelineWindows,
  retainTimelineWindow,
  scrollTopAfterPrepend,
} from "./conversation-scroll.js";
import { messagesFor } from "./locales.js";
import { continuousFooter } from "./continuous-display.js";
import { ContinuousRoundRecord, ContinuousTaskCard, ContinuousCompletionRecord } from "./ContinuousTask.js";
import { GrokControlCenter } from "./GrokControlCenter.js";
import { BrowserPane } from "./BrowserPane.js";
import {
  EMPTY_BROWSER_PANE,
  browserPaneHidden,
  revealsBrowserTab,
  useModalOverlayPresent,
  type WorkbenchTab,
} from "./browser-pane-view.js";
import { applyModelSelectionChange } from "./apply-model-change.js";
import { claudeDefaultsView, claudePermissionModeOf, claudeStatusOf, claudeStatusText } from "./claude-engine.js";
import { ModelPicker } from "./ModelPicker.js";
import { ModelSourcesSettings } from "./ModelSourcesSettings.js";
import { OnlineReminderDialog } from "./OnlineReminderDialog.js";
import { OnlineReminderSetting } from "./OnlineReminderSetting.js";
import {
  agreedSourcesOf,
  createOnlineConsentLedger,
  onlineReminderNeeded,
  onlineSourceKey,
  vendorLabelFor,
} from "./online-reminder.js";
import { hasMixedEngines, taskEngineFixed, taskEngineOf } from "./task-engine.js";
import { RewindDialog } from "./RewindDialog.js";
import { RunChangesCard, type RunCardData } from "./RunChangesCard.js";
import { RunDiffView } from "./RunDiffView.js";
import { RolledBackBlock } from "./RolledBackBlock.js";
import { RunPhaseLine } from "./RunPhaseLine.js";
import { groupEntries, segmentTimeline, type TimelineRow } from "./rolled-back.js";
import { attentionStripTasks } from "./attention-tasks.js";
import type { RolledBackResult } from "./rewind-flow.js";
import { GuildHero } from "./GuildHero.js";
import { permissionOptionView } from "./permission-options.js";
import { cardAnchors, latestChangedRun, resultSummaryRepeatsChangeCard } from "./run-changes.js";
import { composerEnterAction, steerButtonState } from "./steer.js";
import { noTaskComposerPlaceholder } from "./welcome.js";
import {
  MODEL_PICKER_SEPARATOR,
  globalDefaultView,
  modelCatalogsOf,
  modelPickerView,
  noticeText,
  selectionAfterModelChange,
  type ModelSelectionChange,
} from "./model-picker.js";
import {
  groupOfModel,
  modelSwitchLine,
  modelSwitchRunning,
  switchRestartsEngine,
  switchTargetName,
  type ModelSwitchState,
} from "./model-switch.js";
import { clampContextMenuPosition } from "./popover-bounds.js";
import { visibleRunStatus, type VisibleRunStatus } from "./run-status.js";
import {
  isAllowedMessageImageUrl,
  isAllowedTimelineMediaUrl,
} from "./message-image.js";
import {
  clearPendingSendForTask,
  claimSendInFlight,
  releaseSendInFlight,
  setPendingSendForTask,
  type PendingSendState,
} from "./pending-send.js";
import { classifyComposerSendFailure, isComposerTextTooLong } from "./send-failure.js";
import {
  nextUnreadTaskIds,
  sidebarTaskStatus,
  taskStatusSnapshot,
  workspaceTaskStatus,
  type SidebarTaskStatus,
} from "./task-status.js";
import {
  matchingSlashCommands,
  slashCommandCatalogue,
  slashCommandQuery,
  slashCommandText,
} from "./slash-commands.js";
import {
  activityDurationMs,
  activityGroupState,
  activityStepTotal,
  activityToolCounts,
  estimateTimelineGroupHeight,
  groupTimeline,
  isBareSymbolReply,
  itemDurationMs,
  streamingActivity,
  turnDurationsByRun,
} from "./timeline.js";
import { promptAttachmentsEqual, shouldClearSubmittedAttachments } from "./composer-submission.js";
import { createFrameScheduler } from "./frame-scheduler.js";
import { mergeStreamText, StreamOverlayStore, type StreamOverlayRecord } from "./stream-overlay.js";
import { StreamingMarkdownSplitter } from "./streaming-markdown.js";
import { replaceEqualDeep } from "./structural-sharing.js";

const WORKBENCH_WIDTH_STORAGE_KEY = "guild:v1:workbench-width";
const WORKBENCH_MIN_WIDTH = 280;
const WORKBENCH_MAX_WIDTH = 480;
const UNREAD_TASKS_STORAGE_KEY = "guild:v1:unread-tasks";

export type GuildAppProps = {
  readonly api: GuildRendererApi;
};

type ContextMenu =
  | { readonly type: "workspace"; readonly workspace: WorkspaceProjection; readonly x: number; readonly y: number }
  | { readonly type: "task"; readonly task: TaskSummaryProjection; readonly x: number; readonly y: number };

type UiError = "bootstrap" | "claude_start" | "message" | "operation" | "recovery" | "runtime" | "workspace";
type SettingsTab = "general" | "engines" | "sources" | "privacy" | "about";
const SETTINGS_TABS: readonly SettingsTab[] = Object.freeze(["general", "engines", "sources", "privacy", "about"]);
type OnlineReminderRequest = Readonly<{ vendorLabel: string }>;
type OnlineReminderAnswer = Readonly<{ confirmed: boolean; dontRemindAgain: boolean }>;
const MODEL_SWITCH_FAILURE_MS = 12_000;
type ProfileAvatarDraft =
  | { readonly type: "keep" }
  | { readonly type: "reset" }
  | { readonly type: "preview"; readonly previewToken: string; readonly grantUrl: string };
type CommandPaletteItem = Readonly<{
  id: string;
  group: "navigation" | "tasks" | "commands";
  label: string;
  detail?: string;
  run: () => void | Promise<void>;
}>;

export function GuildApp({ api }: GuildAppProps) {
  const [appearance, setAppearance] = useAppearance();
  const [projection, setProjectionState] = useState<DesktopBootstrapProjection>();
  // Every projection, pushed or returned by a command, is merged into the previous one so
  // unchanged tasks, rows and workbench data keep their identity and memoized children skip.
  const setProjection = useCallback((update: SetStateAction<DesktopBootstrapProjection | undefined>) => {
    setProjectionState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return current === undefined || next === undefined ? next : replaceEqualDeep(current, next);
    });
  }, []);
  const [draft, setDraft] = useState("");
  const [promptAttachments, setPromptAttachments] = useState<readonly PromptAttachment[]>([]);
  const [continuousMode, setContinuousMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingSends, setPendingSends] = useState<ReadonlyMap<string, PendingSendState>>(
    () => new Map(),
  );
  const [accountOpen, setAccountOpen] = useState(false);
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const accountFirstActionRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [grokControlOpen, setGrokControlOpen] = useState(false);
  const grokControlTriggerRef = useRef<HTMLElement | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileNickname, setProfileNickname] = useState("");
  const [profileAvatar, setProfileAvatar] = useState<ProfileAvatarDraft>({ type: "keep" });
  const [profileError, setProfileError] = useState<string>();
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchNavigation, setSearchNavigation] = useState<{
    query: string; results: readonly ConversationSearchResult[]; index: number;
  }>();
  const searchAnchor = useRef<{ taskId: string; sequence: number } | undefined>(undefined);
  const [workbenchScope, setWorkbenchScope] = useState<"loaded" | "latest">("loaded");
  const [searchQuery, setSearchQuery] = useState("");
  const [conversationSearchResults, setConversationSearchResults] = useState<readonly ConversationSearchResult[]>([]);
  const [conversationSearchPending, setConversationSearchPending] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [restoreStatus, setRestoreStatus] = useState<"idle" | "restoring" | "restarting" | "failed">("idle");
  const [backupStatus, setBackupStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const commandPaletteReturnFocus = useRef<HTMLElement | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const workbenchTrigger = useRef<HTMLButtonElement>(null);
  const workbenchPanel = useRef<HTMLElement>(null);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("files");
  // The browser pane's state lives in main; this is the last snapshot it pushed (PC-BROWSER-001).
  const [browserPane, setBrowserPane] = useState<BrowserPaneProjection>(EMPTY_BROWSER_PANE);
  const previousAgentControl = useRef(EMPTY_BROWSER_PANE.agentControl);
  const [workbenchWidth, setWorkbenchWidth] = useState(() => readWorkbenchWidth(window.localStorage));
  const [contextMenu, setContextMenu] = useState<ContextMenu>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renamingTask, setRenamingTask] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState(false);
  const [contextUsageOpen, setContextUsageOpen] = useState(false);
  // The Online-model reminder (PC-PRIV-001): the open dialog, the way to answer it, and the vendors each task agreed to in this window.
  const [onlineReminder, setOnlineReminder] = useState<OnlineReminderRequest>();
  const onlineReminderAnswer = useRef<((answer: OnlineReminderAnswer) => void) | undefined>(undefined);
  const onlineConsent = useRef(createOnlineConsentLedger());
  // A switch between a Claude model and an Online / Local one restarts the engine and takes a while (D-062).
  const [modelSwitch, setModelSwitch] = useState<ModelSwitchState>();
  const [claudeSettingsFailed, setClaudeSettingsFailed] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<{ readonly runId: RunId }>();
  const rewindReturnFocus = useRef<HTMLElement | null>(null);
  const [runDiff, setRunDiff] = useState<{ readonly runId: RunId; readonly path: string | undefined }>();
  const [steerNotice, setSteerNotice] = useState<string>();
  const [unreadTaskIds, setUnreadTaskIds] = useState<ReadonlySet<string>>(() => readUnreadTasks(window.localStorage));
  const unreadTaskIdsRef = useRef(unreadTaskIds);
  unreadTaskIdsRef.current = unreadTaskIds;
  const lastTaskStatuses = useRef<ReadonlyMap<string, SidebarTaskStatus>>(new Map());
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<UiError>();
  const [loadingEarlierTimeline, setLoadingEarlierTimeline] = useState(false);
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState<string>();
  const conversation = useRef<HTMLElement>(null);
  const timelineTopSentinel = useRef<HTMLDivElement>(null);
  const timelineBottomSentinel = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const autoScrollPinned = useRef(true);
  const autoScrollTaskId = useRef<string | undefined>(undefined);
  const seenWorkspaceIds = useRef<Set<string>>(new Set());
  const activeTaskIdRef = useRef<string | undefined>(undefined);
  const streamOverlay = useMemo(() => new StreamOverlayStore(() => activeTaskIdRef.current), []);
  const sendInFlightRef = useRef<ReadonlySet<string>>(new Set());
  const operationInFlightRef = useRef(false);
  const loadingEarlierTimelineRef = useRef(false);
  const slashCommandRequests = useRef<Set<string>>(new Set());
  const retainedTimelines = useRef<Map<string, readonly TimelineItemProjection[]>>(new Map());
  const pendingHistoryAnchor = useRef<{
    readonly taskId: string;
    readonly scrollTop: number;
    readonly scrollHeight: number;
  } | undefined>(undefined);
  const activeTimeline = useMemo(() => {
    const task = projection?.activeTask;
    if (task === undefined) return Object.freeze([]) as readonly TimelineItemProjection[];
    const retained = retainedTimelines.current.get(task.task.taskId) ?? Object.freeze([]);
    const merged = mergeTimelineWindows(retained, task.timeline);
    retainTimelineWindow(retainedTimelines.current, task.task.taskId, merged);
    return merged;
  }, [projection?.activeTask?.task.taskId, projection?.activeTask?.timeline]);
  useLayoutEffect(() => {
    streamOverlay.reconcile(activeTimeline);
  }, [streamOverlay, activeTimeline]);
  // Stable callbacks for memoized children. They always call the closures of the latest
  // render, so row components do not re-render when unrelated state changes.
  const latestHandlers = useRef<{
    readonly openExternal: (url: string) => Promise<void>;
    readonly decidePermission: (
      item: Extract<TimelineItemProjection, { readonly kind: "permission" }>,
      decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
    ) => Promise<void>;
    readonly branchFromMessage: (item: TimelineItemProjection) => Promise<void>;
    readonly retryMessageToDraft: (item: TimelineItemProjection) => void;
    readonly openRuntimeDiagnostics: () => void;
    readonly loadEarlierTimeline: () => Promise<void>;
    readonly openTask: (taskId: TaskSummaryProjection["taskId"]) => Promise<void>;
    readonly createTask: (workspaceId: string) => Promise<void>;
    readonly createNewTask: () => Promise<void>;
    readonly toggleWorkspace: (workspaceId: string) => void;
    readonly pinTask: (task: TaskSummaryProjection) => void;
    readonly archiveTask: (task: TaskSummaryProjection) => void;
    readonly openContextMenu: (event: ReactMouseEvent, menu: ContextMenuSeed) => void;
    readonly viewRunDiff: (runId: RunId, path?: string) => void;
    readonly openRewind: (runId: RunId, trigger: HTMLElement) => void;
  }>(undefined as never);
  latestHandlers.current = {
    openExternal,
    decidePermission,
    branchFromMessage,
    retryMessageToDraft,
    openRuntimeDiagnostics: () => void api.openRuntimeDiagnostics({}),
    loadEarlierTimeline,
    openTask: (taskId) => openTask(taskId),
    createTask: (workspaceId) => createTask(workspaceId),
    createNewTask: () => (busy || projection === undefined ? Promise.resolve() : createTask()),
    toggleWorkspace: (workspaceId) => setExpandedWorkspaces((current) => toggleSet(current, workspaceId)),
    pinTask: (task) => void updateTaskFromSidebar(task, task.pinned ? "unpin" : "pin"),
    archiveTask: (task) => void updateTaskFromSidebar(task, "archive"),
    openContextMenu: (event, menu) => {
      setConfirmDelete(false);
      setRenamingTask(false);
      setRenameError(false);
      openContextMenu(event, menu, setContextMenu);
    },
    viewRunDiff,
    openRewind: openRewindDialog,
  };
  const stableHandlers = useMemo(() => Object.freeze({
    onOpenExternal: (url: string) => void latestHandlers.current.openExternal(url),
    onPermissionDecision: (
      item: Extract<TimelineItemProjection, { readonly kind: "permission" }>,
      decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
    ) => latestHandlers.current.decidePermission(item, decision),
    onBranch: (item: TimelineItemProjection) => latestHandlers.current.branchFromMessage(item),
    onRetryToDraft: (item: TimelineItemProjection) => latestHandlers.current.retryMessageToDraft(item),
    onOpenRuntimeDiagnostics: () => latestHandlers.current.openRuntimeDiagnostics(),
    onToggleWorkspace: (workspaceId: string) => latestHandlers.current.toggleWorkspace(workspaceId),
    onOpenTask: (taskId: TaskSummaryProjection["taskId"]) => void latestHandlers.current.openTask(taskId),
    onNewTask: (workspaceId: string) => void latestHandlers.current.createTask(workspaceId),
    onPinTask: (task: TaskSummaryProjection) => latestHandlers.current.pinTask(task),
    onArchiveTask: (task: TaskSummaryProjection) => latestHandlers.current.archiveTask(task),
    onContextMenu: (event: ReactMouseEvent, menu: ContextMenuSeed) =>
      latestHandlers.current.openContextMenu(event, menu),
    onViewRunDiff: (runId: RunId, path?: string) => latestHandlers.current.viewRunDiff(runId, path),
    onRewind: (runId: RunId, trigger: HTMLElement) => latestHandlers.current.openRewind(runId, trigger),
  }), []);
  const activeWorkspaceCache = useRef(new WeakMap<WorkspaceProjection, WorkspaceProjection>());
  const activeWorkspaces = useMemo(() => (projection?.workspaces ?? [])
    .filter((workspace) => !workspace.archived)
    .map((workspace) => {
      const cached = activeWorkspaceCache.current.get(workspace);
      if (cached !== undefined) return cached;
      const derived = Object.freeze({
        ...workspace,
        tasks: Object.freeze(workspace.tasks.filter((task) => !task.archived)),
      });
      activeWorkspaceCache.current.set(workspace, derived);
      return derived;
    }), [projection?.workspaces]);
  const pendingTaskIds = useMemo(() => new Set(pendingSends.keys()), [pendingSends]);
  // F3: the per-task git worktree (new-task option, topbar chip and menu, dialogs).
  const worktreeLocale = projection?.locale ?? "en-US";
  const worktreeUi = useWorktreeUi({
    api,
    locale: worktreeLocale,
    workspaces: activeWorkspaces,
    setProjection,
    storage: typeof window === "undefined" ? undefined : window.localStorage,
    viewport,
    cancelLabel: messagesFor(worktreeLocale).cancel,
    closeLabel: messagesFor(worktreeLocale).closeDialog,
  });

  // Banny used to be draggable; the saved placement is ignored now, so drop the stale keys once.
  useEffect(() => removeLegacyBannyPlacement(window.localStorage), []);

  // The failure of a model switch stays on the composer for a while, then goes (the picker keeps its own notice).
  useEffect(() => {
    if (modelSwitch?.kind !== "failed") return;
    const timer = window.setTimeout(() => setModelSwitch(undefined), MODEL_SWITCH_FAILURE_MS);
    return () => window.clearTimeout(timer);
  }, [modelSwitch]);

  // "New result" marks come from watching the projection: a task that stops working quietly while
  // another task is open has something to read. The marks survive a reload through localStorage.
  useEffect(() => {
    if (projection === undefined) return;
    const tasks = projection.workspaces.flatMap((workspace) => workspace.archived ? [] : workspace.tasks.filter((task) => !task.archived));
    const next = nextUnreadTaskIds(lastTaskStatuses.current, tasks, projection.activeTask?.task.taskId, unreadTaskIdsRef.current);
    lastTaskStatuses.current = taskStatusSnapshot(tasks);
    if (next !== unreadTaskIdsRef.current) {
      writeUnreadTasks(window.localStorage, next);
      setUnreadTaskIds(next);
    }
  }, [projection?.workspaces, projection?.activeTask?.task.taskId]);

  // A11Y-COMPOSER-001: mirror value writes that bypass React (accessibility
  // clients, UI automation) into the draft. Intentionally has no dependency
  // array: the composer node is re-resolved after every render, so the listener
  // can never be left attached to a stale textarea across a remount.
  useEffect(() => observeExternalComposerInput(composerInput.current, {
    readDraft: () => draftRef.current,
    onExternalInput: (value) => {
      setDraft(value);
      setDismissedSlashDraft(undefined);
      setSlashCommandIndex(0);
    },
  }));

  useEffect(() => {
    const query = searchQuery.trim();
    if (!searchOpen || query.length < 2) {
      setConversationSearchResults([]);
      setConversationSearchPending(false);
      return;
    }
    let active = true;
    setConversationSearchPending(true);
    const timeout = window.setTimeout(() => {
      void api.searchConversations({ query }).then((response) => {
        if (active) setConversationSearchResults(response.results);
      }).catch(() => {
        if (active) setConversationSearchResults([]);
      }).finally(() => {
        if (active) setConversationSearchPending(false);
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [api, searchOpen, searchQuery]);

  useEffect(() => {
    let active = true;
    void api.bootstrap().then((next) => {
      if (!active) return;
      setProjection(next);
      setError(undefined);
      setExpandedWorkspaces(new Set(next.workspaces.map((workspace) => workspace.workspaceId)));
      activeTaskIdRef.current = next.activeTask?.task.taskId;
      setDraft(next.activeTask?.draft ?? "");
    }).catch(() => active && setError("bootstrap"));
    let latestProjection: DesktopBootstrapProjection | undefined;
    // Projections apply once per frame, but never wait on a frame alone: a hidden window
    // pauses requestAnimationFrame, so the scheduler also carries a timer fallback.
    const projectionScheduler = createFrameScheduler(() => {
      const queued = latestProjection;
      latestProjection = undefined;
      if (!active || queued === undefined) return;
      startTransition(() => {
        setProjection(queued);
        const nextTaskId = queued.activeTask?.task.taskId;
        if (activeTaskIdRef.current !== nextTaskId) {
          activeTaskIdRef.current = nextTaskId;
          setDraft(queued.activeTask?.draft ?? "");
        }
      });
    });
    const unsubscribe = api.onProjectionChanged((next) => {
      latestProjection = next;
      projectionScheduler.schedule();
    });
    const overlayScheduler = createFrameScheduler(() => streamOverlay.flush());
    const unsubscribeDelta = api.onStreamDelta((delta) => {
      if (active && streamOverlay.apply(delta)) overlayScheduler.schedule();
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeDelta();
      projectionScheduler.cancel();
      overlayScheduler.cancel();
    };
  }, [api, setProjection, streamOverlay]);

  // Snapshots of the browser pane arrive whether or not its tab is on screen: an agent may start
  // operating it while the person reads something else.
  useEffect(() => api.onBrowserPaneChanged((next) => {
    setBrowserPane((current) => replaceEqualDeep(current, next));
  }), [api]);

  // The pane's rendering tools refuse while it is hidden, so an agent that takes it over brings the tab forward, once.
  useEffect(() => {
    const previous = previousAgentControl.current;
    previousAgentControl.current = browserPane.agentControl;
    if (!revealsBrowserTab(previous, browserPane.agentControl)) return;
    setWorkbenchTab("browser");
    setWorkbenchOpen(true);
  }, [browserPane.agentControl]);

  // Every command answers with the new snapshot, which is also how the pane gets its first one.
  const sendBrowserCommand = useCallback((command: BrowserCommand) => {
    void api.browserCommand(command).then(
      (next) => setBrowserPane((current) => replaceEqualDeep(current, next)),
      () => undefined,
    );
  }, [api]);

  useEffect(() => {
    const taskId = projection?.activeTask?.task.taskId;
    setPromptAttachments(taskId === undefined
      ? Object.freeze([])
      : readPromptAttachments(window.localStorage, taskId));
  }, [projection?.activeTask?.task.taskId]);

  useEffect(() => {
    const panel = workbenchPanel.current;
    if (workbenchOpen && viewport.width <= 1000 && panel !== null && !panel.contains(document.activeElement)) {
      panel.querySelector<HTMLButtonElement>(".guild-workbench-head button")?.focus();
    }
  }, [workbenchOpen, viewport.width]);

  useLayoutEffect(() => {
    const anchor = searchAnchor.current;
    if (anchor === undefined || anchor.taskId !== projection?.activeTask?.task.taskId) return;
    const element = conversation.current?.querySelector<HTMLElement>(`[data-sequence="${anchor.sequence}"]`);
    if (element === null || element === undefined) return;
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
    searchAnchor.current = undefined;
  }, [activeTimeline, projection?.activeTask?.task.taskId]);

  useLayoutEffect(() => {
    const anchor = pendingHistoryAnchor.current;
    const element = conversation.current;
    const taskId = projection?.activeTask?.task.taskId;
    if (anchor === undefined || element === null) return;
    if (anchor.taskId !== taskId) {
      pendingHistoryAnchor.current = undefined;
      return;
    }
    element.scrollTop = scrollTopAfterPrepend(
      anchor.scrollTop,
      anchor.scrollHeight,
      element.scrollHeight,
    );
    pendingHistoryAnchor.current = undefined;
  }, [projection?.activeTask?.task.taskId, activeTimeline]);

  // Stick to the bottom: one scroll write per frame, and only while the reader is pinned.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = conversation.current;
      const taskId = projection?.activeTask?.task.taskId;
      const taskChanged = autoScrollTaskId.current !== taskId;
      autoScrollTaskId.current = taskId;
      if (taskChanged) autoScrollPinned.current = true;
      if (element !== null && autoScrollPinned.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    projection?.activeTask?.task.taskId,
    activeTimeline,
    pendingSends,
    error,
  ]);

  const conversationMounted = projection !== undefined;
  const timelineKey = `${projection?.activeTask?.task.taskId ?? ""}:${activeTimeline.length === 0 ? "empty" : "full"}:${pendingSends.size}`;
  // Streamed text grows the timeline without re-rendering this component, so content growth is
  // observed after layout instead of being measured after every commit.
  useEffect(() => {
    const scroller = conversation.current;
    const content = scroller?.querySelector<HTMLElement>(".guild-timeline");
    if (scroller === null || scroller === undefined || content === null || content === undefined) return;
    const observer = new ResizeObserver(() => {
      if (autoScrollPinned.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationMounted, timelineKey]);

  // Pinned state and "load earlier" come from sentinels, so no scroll or layout measurement
  // happens in JavaScript while the reader scrolls or while text streams.
  useEffect(() => {
    const scroller = conversation.current;
    const sentinel = timelineBottomSentinel.current;
    if (scroller === null || sentinel === null) return;
    const observer = new IntersectionObserver((entries) => {
      const latest = entries.at(-1);
      if (latest !== undefined) autoScrollPinned.current = latest.isIntersecting;
    }, { root: scroller, rootMargin: "0px 0px 72px 0px", threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversationMounted]);

  const hasEarlierTimeline = projection?.activeTask?.hasEarlierTimeline === true;
  useEffect(() => {
    const scroller = conversation.current;
    const sentinel = timelineTopSentinel.current;
    if (scroller === null || sentinel === null || !hasEarlierTimeline) return;
    // Observing again reports the current state, so a page that still leaves the top in
    // view (or fits without scrolling) keeps loading until the pane is filled.
    const observer = new IntersectionObserver((entries) => {
      if (entries.at(-1)?.isIntersecting === true) void latestHandlers.current.loadEarlierTimeline();
    }, { root: scroller, rootMargin: "72px 0px 0px 0px", threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    projection?.activeTask?.task.taskId,
    hasEarlierTimeline,
    activeTimeline.length,
    loadingEarlierTimeline,
  ]);

  useEffect(() => {
    if (projection !== undefined) document.documentElement.lang = projection.locale;
  }, [projection?.locale]);

  useEffect(() => {
    const task = projection?.activeTask;
    const query = slashCommandQuery(draft);
    if (task === undefined || query === undefined) {
      if (task !== undefined) slashCommandRequests.current.delete(task.task.taskId);
      return;
    }
    const taskId = task.task.taskId;
    if (task.availableCommands.length > 0 || slashCommandRequests.current.has(taskId)) return;
    slashCommandRequests.current.add(taskId);
    void api.loadSlashCommands({ taskId }).then((loaded) => {
      setProjection((current) => current === undefined || current.activeTask?.task.taskId !== taskId
        ? current
        : { ...current, activeTask: loaded });
    }).catch(() => {
      // The versioned bundled catalogue remains usable. Runtime discovery is a
      // silent freshness check, not a user-blocking operation.
    });
  }, [api, draft, projection?.activeTask?.availableCommands, projection?.activeTask?.task.taskId]);

  useEffect(() => {
    const taskId = projection?.activeTask?.task.taskId;
    const preservingSubmittedDraft = taskId !== undefined &&
      pendingSends.has(taskId) &&
      draft.length === 0;
    if (isComposerTextTooLong(draft)) {
      setError("message");
      return;
    }
    setError((current) => current === "message" ? undefined : current);
    if (
      busy ||
      preservingSubmittedDraft ||
      taskId === undefined ||
      draft === projection?.activeTask?.draft
    ) return;
    const timeout = window.setTimeout(() => {
      void api.setDraft({ taskId, text: draft }).catch(() => setError("operation"));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [api, busy, draft, pendingSends, projection?.activeTask?.draft, projection?.activeTask?.task.taskId]);

  useEffect(() => {
    const workspaceIds = projection?.workspaces.map((workspace) => workspace.workspaceId) ?? [];
    const additions = workspaceIds.filter((workspaceId) => !seenWorkspaceIds.current.has(workspaceId));
    for (const workspaceId of workspaceIds) seenWorkspaceIds.current.add(workspaceId);
    if (additions.length === 0) return;
    setExpandedWorkspaces((current) => new Set([...current, ...additions]));
  }, [projection?.workspaces]);

  useEffect(() => {
    if (accountOpen) accountFirstActionRef.current?.focus();
  }, [accountOpen]);

  useEffect(() => {
    const onCommandShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      if (commandPaletteOpen) {
        setCommandPaletteOpen(false);
        commandPaletteReturnFocus.current?.focus();
        return;
      }
      commandPaletteReturnFocus.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setCommandPaletteQuery("");
      setCommandPaletteIndex(0);
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", onCommandShortcut);
    return () => window.removeEventListener("keydown", onCommandShortcut);
  }, [commandPaletteOpen]);

  // The new-task button advertises Cmd+N; the shortcut does exactly what the button does.
  useEffect(() => {
    const onNewTaskShortcut = (event: KeyboardEvent) => {
      // The app is macOS-only; Ctrl+N is cursor movement in a macOS text field.
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLocaleLowerCase() !== "n") return;
      if (event.repeat || event.defaultPrevented || event.isComposing) return;
      // Behind a modal dialog the shortcut would act on a page the user cannot see.
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      void latestHandlers.current.createNewTask();
    };
    window.addEventListener("keydown", onNewTaskShortcut);
    return () => window.removeEventListener("keydown", onNewTaskShortcut);
  }, []);

  useEffect(() => {
    const close = () => {
      setAccountOpen(false);
      setContextMenu(undefined);
      setConfirmDelete(false);
      setRenamingTask(false);
      setRenameError(false);
      setWorkspacePickerOpen(false);
      setContextUsageOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Per-task UI that must not leak into another task: an open rewind, a shown run diff, a Steer notice.
  const openTaskIdForReset = projection?.activeTask?.task.taskId;
  useEffect(() => {
    setRewindTarget(undefined);
    setRunDiff(undefined);
    setSteerNotice(undefined);
  }, [openTaskIdForReset]);
  useEffect(() => {
    if (steerNotice === undefined) return;
    const timeout = window.setTimeout(() => setSteerNotice(undefined), 8_000);
    return () => window.clearTimeout(timeout);
  }, [steerNotice]);
  const loadRunDiff = useCallback((runId: RunId, path: string): Promise<LoadRunFileDiffResponse> =>
    openTaskIdForReset === undefined
      ? Promise.reject(new Error("no_active_task"))
      : api.loadRunFileDiff({ taskId: openTaskIdForReset, runId, path }), [api, openTaskIdForReset]);

  // Dialogs and menus owned by other components (worktree, the fullscreen image viewer) are found in the DOM, but only
  // while the Browser tab is on screen: that is the only time a native view needs protecting from them.
  const domOverlayOpen = useModalOverlayPresent(
    workbenchOpen && projection?.activeTask !== undefined && workbenchTab === "browser",
  );

  if (projection === undefined) {
    const loadingMessages = messagesFor(
      navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US",
    );
    if (error === "bootstrap") {
      return (
        <div className="guild-startup-error" role="alert">
          <strong>{loadingMessages.startupUnavailable}</strong>
          <button type="button" onClick={() => void retryBootstrap()}>{loadingMessages.retry}</button>
        </div>
      );
    }
    return <div className="guild-loading" aria-label={loadingMessages.loading}><SpinnerGap size={22} className="guild-spin" /></div>;
  }

  const activeTask = projection.activeTask;
  // PC-ENG-001: the conversation speaks of the engine the task runs on; settings and tools keep the Grok wording.
  const activeEngine = taskEngineOf(activeTask?.task);
  const baseMessages = messagesFor(projection.locale);
  const messages = messagesFor(projection.locale, activeEngine);
  const visibleWorkbench = workbenchScope === "latest" ? activeTask?.recentResult?.workbench : activeTask?.workbench;
  const latestInterruptedUserSequence = [...activeTimeline].reverse().find((item) =>
    item.kind === "user" && item.status === "interrupted")?.sequence;
  const restoredNoticeCoversLatestResult = activeTask?.recentResult?.state === "interrupted" &&
    latestInterruptedUserSequence !== undefined &&
    activeTimeline.some((item) =>
      item.kind === "notice" &&
      item.noticeType === "session_restored" &&
      item.sequence > latestInterruptedUserSequence);
  const running = isLiveRunState(activeTask?.task.activeRunState);
  // The strip under the conversation is left out where the finished turn's own changed-files card says the same.
  const resultSummaryRepeatsCard = !running &&
    resultSummaryRepeatsChangeCard(activeTask?.recentResult, activeTimeline, activeTask?.runCheckpoints);
  const archivedWorkspaces = projection.workspaces.filter((workspace) => workspace.archived);
  const archivedTasks = projection.workspaces
    .filter((workspace) => !workspace.archived)
    .flatMap((workspace) => workspace.tasks
      .filter((task) => task.archived)
      .map((task) => Object.freeze({ workspace, task })));
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase(projection.locale);
  const visibleWorkspaces = normalizedSearch.length === 0
    ? activeWorkspaces
    : activeWorkspaces
        .map((workspace) => {
          const workspaceMatches = workspace.name.toLocaleLowerCase(projection.locale).includes(normalizedSearch);
          const tasks = workspaceMatches
            ? workspace.tasks
            : workspace.tasks.filter((task) =>
                task.title.toLocaleLowerCase(projection.locale).includes(normalizedSearch));
          return Object.freeze({ ...workspace, tasks: Object.freeze(tasks) });
        })
        .filter((workspace) => workspace.tasks.length > 0);
  const resolvedContextMenu = contextMenu === undefined
    ? undefined
    : Object.freeze({
        ...resolveContextMenuSeed(projection.workspaces, contextMenu),
        x: contextMenu.x,
        y: contextMenu.y,
      }) as ContextMenu;
  const contextMenuBox = resolvedContextMenu === undefined
    ? undefined
    : clampContextMenuPosition(
        resolvedContextMenu.x,
        resolvedContextMenu.y,
        viewport.width,
        viewport.height,
        confirmDelete || renamingTask,
        resolvedContextMenu.type === "task" && resolvedContextMenu.task.worktreeStatus !== undefined ? 64 : 0,
      );
  const contextManagementBlocked = resolvedContextMenu !== undefined && (
    resolvedContextMenu.type === "task"
      ? isTaskManagementBlocked(resolvedContextMenu.task) ||
        pendingSends.has(resolvedContextMenu.task.taskId)
      : resolvedContextMenu.workspace.tasks.some(
          (task) => isTaskManagementBlocked(task) || pendingSends.has(task.taskId),
        )
  );
  const latestAssistant = [...activeTimeline].reverse().find(
    (item) => item.kind === "assistant" && item.status === "completed",
  );
  const latestAssistantAnnouncement = running
    ? messages.activeActivity(activeTask?.task.activeActivity ?? "working")
    : latestAssistant?.kind === "assistant"
      ? continuousFooter(latestAssistant.text)?.body ?? latestAssistant.text : "";
  const contextWindow = contextWindowView(activeTask?.contextWindow, projection.locale);
  const modelCatalogs = modelCatalogsOf(projection.runtimeSettings);
  const modelCatalog = modelCatalogs.grok;
  const claudeStatus = claudeStatusOf(projection.runtimeSettings.claude);
  const claudeDefaults = claudeDefaultsView({
    catalog: modelCatalogs.claude,
    model: projection.runtimeSettings.claude?.model ?? null,
    reasoningEffort: projection.runtimeSettings.claude?.reasoningEffort ?? null,
  });
  const engineFixed = taskEngineFixed(activeTask, activeTask !== undefined && pendingSends.has(activeTask.task.taskId));
  const switchLine = modelSwitchLine(modelSwitch, activeTask?.task.taskId, baseMessages);
  const engineMarkers = hasMixedEngines(activeWorkspaces);
  // The wordmark names the engine of the open task: the Grok runtime's version, or Claude Code's when the main process reports it.
  const engineVersionLabel = activeEngine === "claude"
    ? claudeStatus?.version === undefined ? undefined : `Claude Code ${claudeStatus.version}`
    : projection.runtimeVersion;
  const claudeMode = claudePermissionModeOf(activeTask?.sessionModes, projection.runtimeSettings.claude?.permissionMode);
  // The native browser view paints above the DOM: hidden under anything the page draws over it, and off its tab.
  const browserHidden = browserPaneHidden({
    workbenchOpen,
    hasTask: activeTask !== undefined,
    tab: workbenchTab,
    overlayOpen: domOverlayOpen || accountOpen || settingsOpen || profileOpen || workspacePickerOpen ||
      commandPaletteOpen || grokControlOpen || contextMenu !== undefined || rewindTarget !== undefined ||
      onlineReminder !== undefined || discardConfirm || contextUsageOpen,
  });
  const permissionPill = activeEngine === "claude"
    ? claudeMode === undefined
      ? undefined
      : { warn: claudeMode === "bypassPermissions", label: messages.claudePermissionModeName(claudeMode) }
    : {
        warn: projection.runtimeSettings.permissionMode === "bypassPermissions",
        label: messages.permissionModeName(projection.runtimeSettings.permissionMode),
      };
  // The names the active task will use next (a Grok task; the Control Center is Grok's); the global default when no Grok task is open.
  const runtimeModelView = modelPickerView({
    messages: baseMessages,
    catalog: modelCatalog,
    selection: (activeEngine === "grok" ? activeTask?.modelSelection : undefined) ?? Object.freeze({
      modelId: projection.runtimeSettings.model,
      reasoningEffort: projection.runtimeSettings.reasoningEffort,
      source: projection.runtimeSettings.model === null ? "runtime" : "global",
      canChange: false,
    }),
  });
  const globalDefault = globalDefaultView({
    catalog: modelCatalog,
    model: projection.runtimeSettings.model,
    reasoningEffort: projection.runtimeSettings.reasoningEffort,
  });
  const activePendingSend = activeTask === undefined
    ? undefined
    : pendingSends.get(activeTask.task.taskId);
  const pendingSendForActive = activeTask !== undefined &&
    activePendingSend !== undefined &&
    !activeTimeline.some(
      (item) => item.kind === "user" &&
        item.text === activePendingSend.text &&
        item.createdAtMs >= activePendingSend.submittedAtMs - 1_000,
    )
    ? activePendingSend
    : undefined;
  const visibleSlashCommands = slashCommandCatalogue(
    activeTask?.availableCommands ?? Object.freeze([]),
    projection.locale,
    activeEngine,
  );
  const commandNeedle = commandPaletteQuery.trim().toLocaleLowerCase(projection.locale);
  const commandPaletteItems: readonly CommandPaletteItem[] = ([
    {
      id: "navigation-new-task",
      group: "navigation",
      label: messages.newTask,
      detail: messages.chooseWorkspace,
      run: async () => { closeCommandPalette(); await createTask(); },
    },
    {
      id: "navigation-search",
      group: "navigation",
      label: messages.search,
      detail: messages.searchPlaceholder,
      run: () => { closeCommandPalette(); setSearchOpen(true); },
    },
    {
      id: "navigation-settings-general",
      group: "navigation",
      label: `${messages.settings} · ${messages.settingsGeneral}`,
      run: () => { closeCommandPalette(); openSettings("general"); },
    },
    {
      id: "navigation-settings-engines",
      group: "navigation",
      label: `${messages.settings} · ${messages.settingsEngines}`,
      run: () => { closeCommandPalette(); openSettings("engines"); },
    },
    {
      id: "navigation-settings-sources",
      group: "navigation",
      label: `${messages.settings} · ${messages.settingsModelSources}`,
      run: () => { closeCommandPalette(); openSettings("sources"); },
    },
    {
      id: "navigation-settings-privacy",
      group: "navigation",
      label: `${messages.settings} · ${messages.settingsPrivacy}`,
      run: () => { closeCommandPalette(); openSettings("privacy"); },
    },
    // The Grok Control Center administers the Grok runtime: offered for Grok conversations only.
    ...(activeEngine === "grok" ? [{
      id: "navigation-grok-center",
      group: "navigation" as const,
      label: baseMessages.manageGrokBuild,
      detail: baseMessages.officialSessionCapabilities,
      run: () => { closeCommandPalette(); openGrokControlCenter(); },
    }] : []),
    ...activeWorkspaces.flatMap((workspace) => workspace.tasks
      .filter((task) => !task.archived)
      .map((task): CommandPaletteItem => ({
        id: `task-${task.taskId}`,
        group: "tasks",
        label: task.title,
        detail: workspace.name,
        run: async () => { closeCommandPalette(); await openTask(task.taskId); },
      }))),
    ...visibleSlashCommands.map((command): CommandPaletteItem => ({
      id: `command-${command.name}`,
      group: "commands",
      label: `/${command.name}`,
      detail: command.description,
      run: () => {
        setDraft(slashCommandText(command));
        closeCommandPalette();
        window.queueMicrotask(() => composerInput.current?.focus());
      },
    })),
  ] satisfies readonly CommandPaletteItem[]).filter((item) => commandNeedle.length === 0 ||
    `${item.label} ${item.detail ?? ""}`.toLocaleLowerCase(projection.locale).includes(commandNeedle))
    .slice(0, 24);
  const selectedCommandPaletteIndex = commandPaletteItems.length === 0
    ? 0
    : Math.min(commandPaletteIndex, commandPaletteItems.length - 1);
  const filteredSlashCommands = matchingSlashCommands(visibleSlashCommands, draft);
  const slashMenuOpen = activeTask !== undefined &&
    slashCommandQuery(draft) !== undefined &&
    dismissedSlashDraft !== draft;
  const selectedSlashCommandIndex = filteredSlashCommands.length === 0
    ? 0
    : Math.min(slashCommandIndex, filteredSlashCommands.length - 1);
  const commandStatus = slashCommandStatus(
    activeTimeline,
    activeTask?.task.activeRunState,
    activeTask?.auxiliaryActivity,
  );
  const runStatus = visibleRunStatus(
    activeTask?.task.activeRunState,
    activeTimeline,
    activeTask?.queuedTurns ?? Object.freeze([]),
  );
  // Only other tasks that are working or waiting for the user: nothing failed, interrupted or cancelled, and never the open task.
  const attentionTasks = attentionStripTasks(
    projection.workspaces.flatMap((workspace) => workspace.tasks),
    activeTask?.task.taskId,
  );
  const steerAvailable = running && activeTask?.steer?.available === true;
  const steerButton = steerButtonState({
    running,
    steerAvailable,
    draft,
    busy,
    sendPending: activePendingSend !== undefined,
    hasAttachments: promptAttachments.length > 0,
  });
  const changedRun = latestChangedRun(activeTask?.runCheckpoints);
  const runDiffCheckpoint = runDiff === undefined
    ? undefined
    : activeTask?.runCheckpoints?.find((checkpoint) => checkpoint.runId === runDiff.runId);

  async function retryBootstrap() {
    setError(undefined);
    try {
      const next = await api.bootstrap();
      setProjection(next);
      setExpandedWorkspaces(new Set(next.workspaces.map((workspace) => workspace.workspaceId)));
      activeTaskIdRef.current = next.activeTask?.task.taskId;
      setDraft(next.activeTask?.draft ?? "");
    } catch {
      setError("bootstrap");
    }
  }

  async function chooseWorkspace(): Promise<DesktopBootstrapProjection | undefined> {
    let selected: DesktopBootstrapProjection | undefined;
    await run(async () => {
      setWorkspacePickerOpen(false);
      selected = await api.chooseWorkspace();
      setProjection(selected);
    });
    return selected;
  }

  /** `isolated` is the user's choice on the new-task option; without it the remembered choice applies. */
  async function createTask(workspaceId?: string, isolated?: boolean) {
    let target = workspaceId;
    if (target === undefined) {
      const lastWorkspaceId = projection?.generalSettings.lastWorkspaceId;
      if (
        projection?.generalSettings.newTaskWorkspaceMode === "last" &&
        lastWorkspaceId !== undefined &&
        activeWorkspaces.some((workspace) => workspace.workspaceId === lastWorkspaceId)
      ) {
        target = lastWorkspaceId;
      } else if (activeWorkspaces.length > 1) {
        setWorkspacePickerOpen(true);
        return;
      } else {
        target = activeWorkspaces[0]?.workspaceId;
      }
    }
    if (target === undefined) {
      const selected = await chooseWorkspace();
      target = selected?.generalSettings.lastWorkspaceId ?? selected?.workspaces.find((workspace) => !workspace.archived)?.workspaceId;
      if (target === undefined) return;
    }
    await run(async () => {
      await persistCurrentDraft();
      setWorkspacePickerOpen(false);
      setExpandedWorkspaces((current) => new Set([...current, target!]));
      const task = await worktreeUi.createTask(target, isolated);
      activeTaskIdRef.current = task.task.taskId;
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
      setDraft("");
    });
  }

  async function openTask(taskId: TaskSummaryProjection["taskId"], sequence?: number, navigation?: typeof searchNavigation) {
    await run(async () => {
      await persistCurrentDraft();
      if (sequence !== undefined) { autoScrollTaskId.current = taskId; autoScrollPinned.current = false; }
      const task = await api.openTask({ taskId, ...(sequence === undefined ? {} : { sequence }) });
      if (sequence !== undefined) {
        setSearchNavigation(navigation);
        searchAnchor.current = { taskId, sequence };
        autoScrollTaskId.current = taskId;
        autoScrollPinned.current = false;
      }
      if (sequence === undefined) setSearchNavigation(undefined);
      activeTaskIdRef.current = task.task.taskId;
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
      setDraft(task.draft);
    });
  }

  async function choosePromptFiles() {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined || running) return;
    try {
      const result = await api.choosePromptFiles({ taskId });
      if (result.status === "cancelled") return;
      const next = [...promptAttachments];
      const seen = new Set(next.map((attachment) => attachment.relativePath));
      for (const attachment of result.attachments) {
        if (seen.has(attachment.relativePath)) continue;
        seen.add(attachment.relativePath);
        next.push(attachment);
      }
      if (next.length > 8) {
        setError("operation");
        return;
      }
      const frozen = Object.freeze(next);
      setPromptAttachments(frozen);
      writePromptAttachments(window.localStorage, taskId, frozen);
      window.requestAnimationFrame(() => composerInput.current?.focus());
    } catch {
      setError("operation");
    }
  }

  function removePromptAttachment(relativePath: string) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    const next = Object.freeze(promptAttachments.filter(
      (attachment) => attachment.relativePath !== relativePath,
    ));
    setPromptAttachments(next);
    writePromptAttachments(window.localStorage, taskId, next);
  }

  async function loadEarlierTimeline() {
    const task = projection?.activeTask;
    const element = conversation.current;
    if (
      task === undefined ||
      element === null ||
      !task.hasEarlierTimeline ||
      loadingEarlierTimelineRef.current
    ) return;
    loadingEarlierTimelineRef.current = true;
    setLoadingEarlierTimeline(true);
    autoScrollPinned.current = false;
    pendingHistoryAnchor.current = {
      taskId: task.task.taskId,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    };
    try {
      const loaded = await api.loadEarlierTimeline({ taskId: task.task.taskId });
      if (activeTaskIdRef.current !== loaded.task.taskId) {
        pendingHistoryAnchor.current = undefined;
        return;
      }
      setProjection((current) => current === undefined
        ? current
        : { ...current, activeTask: loaded });
    } catch {
      pendingHistoryAnchor.current = undefined;
      setError("operation");
    } finally {
      loadingEarlierTimelineRef.current = false;
      setLoadingEarlierTimeline(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await sendComposerText(draft);
  }

  /** "send" queues while a turn runs (Enter); "steer" puts the message into the running turn (Option+Enter). */
  async function sendComposerText(sourceText: string, mode: "send" | "steer" = "send") {
    const text = sourceText.trim();
    if (
      busy ||
      text.length === 0 ||
      activeTask === undefined ||
      pendingSends.has(activeTask.task.taskId) ||
      !activeTask.canSend ||
      (running && promptAttachments.length > 0) ||
      (mode === "steer" && !steerAvailable)
    ) return;
    if (isComposerTextTooLong(sourceText)) {
      setError("message");
      return;
    }
    const taskId = activeTask.task.taskId;
    const claimed = claimSendInFlight(sendInFlightRef.current, taskId);
    if (claimed === undefined) return;
    sendInFlightRef.current = claimed;
    const submittedDraft = sourceText;
    const submittedAttachments = promptAttachments;
    const submittedContinuousMode = continuousMode;
    setDraft("");
    setError(undefined);
    const submittedAtMs = Date.now();
    setPendingSends((current) => setPendingSendForTask(
      current,
      Object.freeze({ taskId, text, submittedAtMs }),
    ));
    try {
      await api.setDraft({ taskId, text: submittedDraft });
      if (mode === "steer") {
        const steered = await api.steerMessage({ taskId, text });
        // The runtime could not take it mid-turn: the message was queued or sent instead, and the person is told.
        if (steered.status !== "steered" && activeTaskIdRef.current === taskId) {
          setSteerNotice(messages.steerNotice(steered.status, steered.reason));
        }
      } else {
        await api.sendMessage({
          taskId,
          text,
          ...(submittedAttachments.length === 0 ? {} : { attachments: submittedAttachments }),
          ...(submittedContinuousMode ? { mode: "continuous" as const } : {}),
        });
      }
      const emptyAttachments = Object.freeze([]) as readonly PromptAttachment[];
      if (activeTaskIdRef.current === taskId && mode === "send") {
        if (submittedContinuousMode) setContinuousMode(false);
        setPromptAttachments((current) => shouldClearSubmittedAttachments({
          activeTaskId: activeTaskIdRef.current,
          submittedTaskId: taskId,
          currentAttachments: current,
          submittedAttachments,
        }) ? emptyAttachments : current);
      }
      const persistedAttachments = readPromptAttachments(window.localStorage, taskId);
      if (promptAttachmentsEqual(persistedAttachments, submittedAttachments)) {
        writePromptAttachments(window.localStorage, taskId, emptyAttachments);
      }
    } catch (cause: unknown) {
      if (activeTaskIdRef.current === taskId) {
        setDraft((current) => current.length === 0 ? submittedDraft : current);
        setError(classifyComposerSendFailure(cause));
      }
    } finally {
      sendInFlightRef.current = releaseSendInFlight(sendInFlightRef.current, taskId);
      setPendingSends((current) => clearPendingSendForTask(current, taskId, submittedAtMs));
    }
  }

  async function setContinuousTask(action: "pause" | "resume" | "stop") {
    if (activeTask === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.setContinuousTask({
        taskId: activeTask.task.taskId,
        action,
      });
      setProjection((current) => current === undefined
        ? current
        : { ...current, activeTask: updated });
    } catch {
      setError("operation");
    } finally {
      setBusy(false);
    }
  }

  async function chooseSlashCommand(command: RuntimeCommand) {
    const text = slashCommandText(command);
    setSlashCommandIndex(0);
    if (command.inputHint !== undefined) {
      setDraft(text);
      window.requestAnimationFrame(() => composerInput.current?.focus());
      return;
    }
    await sendComposerText(text);
  }

  function insertSlashCommand(command: RuntimeCommand) {
    const text = slashCommandText(command);
    setDraft(text);
    setDismissedSlashDraft(text);
    setSlashCommandIndex(0);
    window.requestAnimationFrame(() => composerInput.current?.focus());
  }

  async function cancelActiveRun() {
    const task = projection?.activeTask?.task;
    const item = [...(projection?.activeTask?.timeline ?? [])].reverse().find((candidate) => candidate.runId !== undefined);
    if (task === undefined || item?.runId === undefined) return;
    await run(async () => {
      await api.cancelRun({ taskId: task.taskId, runId: item.runId! });
    });
  }

  async function persistCurrentDraft() {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    if (isComposerTextTooLong(draft)) return;
    if (draft.length === 0 && pendingSends.has(taskId)) return;
    if (draft === projection?.activeTask?.draft) return;
    await api.setDraft({ taskId, text: draft });
  }

  async function cancelQueuedTurn(queueId: string) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    await run(async () => {
      await api.cancelQueuedTurn({ taskId, queueId });
    });
  }

  async function preemptQueuedTurn(queueId: string) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    await run(async () => {
      await api.preemptQueuedTurn({ taskId, queueId });
    });
  }

  // Tells the running turn about a queued message now instead of waiting for the turn to end.
  async function convertQueuedToSteer(queueId: string) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    await run(async () => {
      const response = await api.convertQueuedTurnToSteer({ taskId, queueId });
      if (response.status === "unchanged") setSteerNotice(messages.steerNotice("unchanged", response.reason));
    });
  }

  function viewRunDiff(runId: RunId, path?: string) {
    setRunDiff({ runId, path });
    setWorkbenchTab("review");
    setWorkbenchOpen(true);
  }

  function scrollToRunCard(runId: RunId) {
    const card = conversation.current?.querySelector<HTMLElement>(`[data-run-card="${runId}"]`);
    if (card === null || card === undefined) return;
    // Scrolling away from the bottom must not be undone by the stick-to-bottom logic.
    autoScrollPinned.current = false;
    card.scrollIntoView({ block: "center" });
    // A short highlight shows which card the button meant; the class is a plain transition, not a looping animation.
    card.classList.add("flash");
    window.setTimeout(() => card.classList.remove("flash"), 1_400);
  }

  function openRewindDialog(runId: RunId, trigger: HTMLElement) {
    rewindReturnFocus.current = trigger;
    setRewindTarget({ runId });
  }

  function closeRewindDialog(rewound: boolean) {
    setRewindTarget(undefined);
    const trigger = rewindReturnFocus.current;
    rewindReturnFocus.current = null;
    queueMicrotask(() => {
      if (rewound) {
        const input = composerInput.current;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      } else {
        trigger?.focus();
      }
    });
  }

  // The unsent text is saved first so the restored prompt is merged with it, never over it.
  async function executeRewind(request: Parameters<GuildRendererApi["executeRewind"]>[0]) {
    await persistCurrentDraft();
    return api.executeRewind(request);
  }

  // The main process put the undone prompt into the task draft; read it back into the composer.
  async function adoptRewoundTask(_result: RolledBackResult) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    try {
      const task = await api.openTask({ taskId });
      if (activeTaskIdRef.current !== task.task.taskId) return;
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
      setDraft(task.draft);
    } catch {
      setError("operation");
    }
  }

  async function authorizeSessionReplacement() {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    await run(async () => {
      const task = await api.authorizeSessionReplacement({ taskId });
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
    });
  }

  async function updateContext(action: "archive" | "restore" | "delete") {
    const menu = resolvedContextMenu;
    setContextMenu(undefined);
    setConfirmDelete(false);
    if (menu === undefined) return;
    await run(async () => {
      const next = menu.type === "workspace"
        ? await api.updateWorkspace({ workspaceId: menu.workspace.workspaceId, action })
        : await api.updateTask({ taskId: menu.task.taskId, action });
      setProjection(next);
    });
  }

  async function updateTaskContext(action: "pin" | "unpin") {
    const menu = resolvedContextMenu;
    setContextMenu(undefined);
    if (menu?.type !== "task") return;
    await run(async () => {
      setProjection(await api.updateTask({ taskId: menu.task.taskId, action }));
    });
  }

  async function updateTaskFromSidebar(
    task: TaskSummaryProjection,
    action: "pin" | "unpin" | "archive",
  ) {
    if (isTaskManagementBlocked(task) || pendingSends.has(task.taskId)) return;
    await run(async () => {
      setProjection(await api.updateTask({ taskId: task.taskId, action }));
    });
  }

  async function forkTaskContext() {
    const menu = resolvedContextMenu;
    setContextMenu(undefined);
    if (menu?.type !== "task") return;
    await run(async () => {
      const task = await api.forkTask({ taskId: menu.task.taskId });
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
    });
  }

  async function exportTaskContext(format: "markdown" | "json") {
    const menu = resolvedContextMenu;
    setContextMenu(undefined);
    if (menu?.type !== "task") return;
    await run(async () => {
      await api.exportTask({ taskId: menu.task.taskId, format });
    });
  }

  async function openTaskResource(action: "terminal" | "folder" | "file", path?: string) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    try {
      await api.openTaskResource(action === "file"
        ? { taskId, action, path: path ?? "" }
        : { taskId, action });
    } catch {
      setError("operation");
    }
  }

  // Deliberately outside run(): the picker shows its own pending state and inline notice, and a
  // model switch must not block the rest of the window or raise the global error banner.
  async function applyTaskRuntimeSettings(change: ModelSelectionChange): Promise<SetTaskRuntimeSettingsResponse | undefined> {
    const task = projection?.activeTask;
    if (task === undefined) throw new Error("no_active_task");
    const taskId = task.task.taskId;
    // PC-PRIV-001: the first switch to an Online model in this conversation says what goes to the vendor.
    if ((change.group === "online" || change.group === "local") && !(await confirmModelSwitch(task, change))) return undefined;
    // D-062: a switch between a Claude model and an Online / Local one restarts the engine; say so while it runs.
    const restarts = switchRestartsEngine({
      taskEngine: taskEngineOf(task.task),
      engineFixed: taskEngineFixed(task, pendingSends.has(taskId)),
      currentGroup: groupOfModel(modelCatalogs.claude, task.modelSelection.modelId),
      targetGroup: change.group,
    });
    if (restarts) {
      setModelSwitch(Object.freeze({
        kind: "switching" as const,
        taskId,
        modelName: switchTargetName(messages, modelCatalogs.claude, change.model),
      }));
    }
    // PC-ENG-001: a task that has not run yet may still choose its engine; the first turn fixes it.
    let response: SetTaskRuntimeSettingsResponse;
    try {
      response = await applyModelSelectionChange(api, {
        taskId,
        taskEngine: taskEngineOf(task.task),
        change,
        onEngineMoved: (moved) => setProjection((current) => current === undefined || current.activeTask?.task.taskId !== taskId
          ? current
          : withTaskSummary({ ...current, activeTask: moved }, moved.task)),
      });
    } catch (cause: unknown) {
      if (restarts) {
        setModelSwitch(Object.freeze({ kind: "failed" as const, taskId, message: noticeText(messages, { kind: "failed" }) }));
      }
      throw cause;
    }
    if (restarts) {
      setModelSwitch(response.status === "refused"
        ? Object.freeze({
            kind: "failed" as const,
            taskId,
            message: noticeText(messages, { kind: "refused", reason: response.reason }),
          })
        : undefined);
    }
    // A refusal still returns the task with its previous selection, so it is always safe to adopt.
    setProjection((current) => current === undefined || current.activeTask?.task.taskId !== response.task.task.taskId
      ? current
      : { ...current, activeTask: response.task });
    return response;
  }

  /**
   * True when the switch to an Online or Local model may go ahead: nothing is due, or the user accepted the
   * reminder (and maybe silenced it). The agreement is per task and per vendor, so a second vendor in the same
   * conversation asks again (PC-PRIV-001). A Local model never asks, and neither does a switch back to Claude.
   */
  async function confirmModelSwitch(task: TaskViewProjection, change: ModelSelectionChange): Promise<boolean> {
    const taskId = task.task.taskId;
    const modelId = change.model;
    const currentModel = (taskEngineOf(task.task) === "claude" ? modelCatalogs.claude : modelCatalogs.grok)
      .models.find((model) => model.id === task.modelSelection.modelId);
    const target = modelCatalogs.claude.models.find((model) => model.id === modelId);
    let sources: readonly ModelSourceProjection[] = [];
    try {
      sources = (await api.listModelSources()).sources;
    } catch {
      // Without the list the model itself is the vendor key and its own name stands in for the vendor.
    }
    const targetSource = onlineSourceKey(modelId ?? "", sources);
    const agreedSources = agreedSourcesOf({
      ledger: onlineConsent.current,
      taskId,
      currentModelId: task.modelSelection.modelId,
      currentGroup: currentModel === undefined ? undefined : modelGroupOf(currentModel),
      sources,
    });
    let dismissed = false;
    if (change.group === "online" && !agreedSources.has(targetSource)) {
      try {
        dismissed = (await api.getWorkspacePrefs({ workspaceId: task.task.workspaceId })).onlineReminderDismissed;
      } catch {
        // Unknown means not silenced: ask.
      }
    }
    const reminderNeeded = onlineReminderNeeded({ targetGroup: change.group, targetSource, agreedSources, dismissedForWorkspace: dismissed });
    if (!reminderNeeded) {
      if (change.group === "online") onlineConsent.current.agree(taskId, targetSource);
      return true;
    }
    const vendorLabel = vendorLabelFor(modelId ?? "", sources, target?.name);
    const answer = await new Promise<OnlineReminderAnswer>((resolve) => {
      onlineReminderAnswer.current = resolve;
      setOnlineReminder(Object.freeze({ vendorLabel }));
    });
    setOnlineReminder(undefined);
    onlineReminderAnswer.current = undefined;
    window.queueMicrotask(() => document.querySelector<HTMLElement>(".guild-model-picker-trigger")?.focus());
    if (!answer.confirmed) return false;
    if (change.group === "online") onlineConsent.current.agree(taskId, targetSource);
    if (reminderNeeded && answer.dontRemindAgain) {
      try {
        await api.setWorkspacePrefs({ workspaceId: task.task.workspaceId, onlineReminderDismissed: true });
      } catch {
        // The switch itself was confirmed; the reminder will simply ask again next time.
      }
    }
    return true;
  }

  async function setSessionConfigOption(configId: string, value: string | boolean) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    await run(async () => {
      const task = await api.setSessionConfigOption({ taskId, configId, value });
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
    });
  }

  async function setClaudeSettings(
    model: string | null,
    reasoningEffort: string | null,
    permissionMode: GuildClaudePermissionMode,
  ) {
    setClaudeSettingsFailed(false);
    await run(async () => {
      try {
        setProjection(await api.setClaudeSettings({ model, reasoningEffort, permissionMode }));
      } catch {
        setClaudeSettingsFailed(true);
      }
    });
  }

  /** The Claude catalog depends on the model sources; re-read the settings after they change. */
  async function refreshRuntimeSettings() {
    try {
      const next = await api.bootstrap();
      setProjection((current) => current === undefined
        ? current
        : { ...current, runtimeSettings: next.runtimeSettings });
    } catch {
      // The next pushed projection carries the catalog.
    }
  }

  function beginRenameTask() {
    if (resolvedContextMenu?.type !== "task") return;
    setRenameDraft(resolvedContextMenu.task.title);
    setRenameError(false);
    setRenamingTask(true);
  }

  async function commitTaskRename() {
    const menu = resolvedContextMenu;
    const title = renameDraft.trim();
    if (menu?.type !== "task") return;
    if (title.length === 0 || title.length > 512 || /[\r\n]/u.test(title)) {
      setRenameError(true);
      return;
    }
    setContextMenu(undefined);
    setRenamingTask(false);
    await run(async () => {
      setProjection(await api.updateTask({ taskId: menu.task.taskId, action: "rename", title }));
    });
  }

  async function restoreWorkspace(workspaceId: WorkspaceProjection["workspaceId"]) {
    await run(async () => {
      setProjection(await api.updateWorkspace({ workspaceId, action: "restore" }));
      setWorkspacePickerOpen(false);
    });
  }

  async function restoreTask(taskId: TaskSummaryProjection["taskId"]) {
    await run(async () => {
      setProjection(await api.updateTask({ taskId, action: "restore" }));
      setWorkspacePickerOpen(false);
    });
  }

  async function setLocale(locale: GuildLocale) {
    await run(async () => setProjection(await api.setLocale({ locale })));
  }

  async function setRuntimeSettings(
    model: GuildGrokModel | null,
    reasoningEffort: GuildGrokReasoningEffort | null,
    permissionMode: GuildGrokPermissionMode,
    startup?: GuildGrokStartupSettings,
  ) {
    const effectiveStartup = startup ?? projection?.runtimeSettings.startup;
    if (effectiveStartup === undefined) return;
    await run(async () => setProjection(await api.setRuntimeSettings({
      model,
      reasoningEffort,
      permissionMode,
      startup: effectiveStartup,
    })));
  }

  function openSettings(tab: SettingsTab = "general") {
    setAccountOpen(false);
    setProfileOpen(false);
    setWorkspacePickerOpen(false);
    setGrokControlOpen(false);
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  function closeCommandPalette() {
    setCommandPaletteOpen(false);
    const trigger = commandPaletteReturnFocus.current;
    commandPaletteReturnFocus.current = null;
    window.queueMicrotask(() => trigger?.focus());
  }

  async function branchFromMessage(item: TimelineItemProjection) {
    const taskId = activeTask?.task.taskId;
    if (taskId === undefined || (item.kind !== "user" && item.kind !== "assistant")) return;
    await run(async () => {
      const task = await api.forkTask({ taskId, throughSequence: item.sequence });
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
    });
  }

  function retryMessageToDraft(item: TimelineItemProjection) {
    if (item.kind !== "user") return;
    setDraft(item.text);
    window.queueMicrotask(() => {
      composerInput.current?.focus();
      composerInput.current?.setSelectionRange(item.text.length, item.text.length);
    });
  }

  async function backupUserData() {
    if (backupStatus === "saving") return;
    setBackupStatus("saving");
    try {
      const result = await api.backupUserData({});
      setBackupStatus(result.status === "saved" ? "saved" : "idle");
    } catch {
      setBackupStatus("failed");
    }
  }

  function openGrokControlCenter() {
    grokControlTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setAccountOpen(false);
    setSettingsOpen(false);
    setWorkspacePickerOpen(false);
    setGrokControlOpen(true);
    const taskId = projection?.activeTask?.task.taskId;
    if (
      taskId === undefined ||
      (projection?.activeTask?.availableCommands.length ?? 0) > 0 ||
      slashCommandRequests.current.has(taskId)
    ) return;
    slashCommandRequests.current.add(taskId);
    void api.loadSlashCommands({ taskId }).then((loaded) => {
      setProjection((current) => current === undefined || current.activeTask?.task.taskId !== taskId
        ? current
        : { ...current, activeTask: loaded });
    }).catch(() => {
      // The complete bundled core catalogue remains immediately available.
    });
  }

  function closeGrokControlCenter() {
    setGrokControlOpen(false);
    const trigger = grokControlTriggerRef.current;
    grokControlTriggerRef.current = null;
    queueMicrotask(() => trigger?.focus());
  }

  function openProfileEditor() {
    if (projection === undefined) return;
    setAccountOpen(false);
    setSettingsOpen(false);
    setProfileNickname(projection.profile.nickname);
    setProfileAvatar({ type: "keep" });
    setProfileError(undefined);
    setDiscardConfirm(false);
    setProfileOpen(true);
  }

  function profileIsDirty() {
    return projection !== undefined &&
      (profileNickname.trim() !== projection.profile.nickname ||
        profileAvatar.type !== "keep");
  }

  function requestCloseProfile() {
    if (profileIsDirty()) {
      setDiscardConfirm(true);
      return;
    }
    setProfileOpen(false);
  }

  async function saveProfile() {
    let nickname: string;
    try {
      nickname = parseGuildNickname(profileNickname);
    } catch {
      setProfileError(messages.nicknameInvalid);
      return;
    }
    await run(async () => {
      setProjection(await api.saveProfile({
        nickname,
        avatar: profileAvatar.type === "preview"
          ? { previewToken: profileAvatar.previewToken }
          : profileAvatar.type,
      }));
      setProfileOpen(false);
      setDiscardConfirm(false);
      setProfileError(undefined);
    });
  }

  async function chooseAvatar() {
    setProfileError(undefined);
    const result = await api.chooseAvatar({});
    if (result.status === "cancelled") return;
    if (result.status === "rejected") {
      setProfileError(
        result.reason === "too_large"
          ? messages.avatarTooLarge
          : result.reason === "unsupported_type"
            ? messages.avatarUnsupported
            : messages.avatarInvalid,
      );
      return;
    }
    setProfileAvatar({
      type: "preview",
      previewToken: result.previewToken,
      grantUrl: result.grantUrl,
    });
  }

  async function setGeneralSettings(
    restoreLastTask: boolean,
    newTaskWorkspaceMode: GuildNewTaskWorkspaceMode,
    browserSyncEnabled = projection?.browserSyncEnabled ?? false,
    taskNotificationsEnabled = projection?.generalSettings.taskNotificationsEnabled ?? true,
  ) {
    await run(async () => setProjection(await api.setGeneralSettings({
      restoreLastTask,
      newTaskWorkspaceMode,
      browserSyncEnabled,
      taskNotificationsEnabled,
    })));
  }

  async function refreshUsage() {
    setError(undefined);
    try {
      setProjection(await api.refreshUsage({}));
    } catch {
      setError("operation");
    }
  }

  async function openExternal(url: string) {
    try {
      await api.openExternal({ url });
    } catch {
      setError("operation");
    }
  }

  async function decidePermission(
    item: Extract<TimelineItemProjection, { readonly kind: "permission" }>,
    decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
  ) {
    if (item.runId === undefined) return;
    // The card's last button stops the turn. It goes down the same path as the composer's stop button, which
    // answers the pending request with ACP's cancelled outcome while the Run is cancelling. Sending that
    // outcome mid-turn instead broke the Grok transport and only aborted the one tool call under Claude.
    if (decision.type === "cancelled") {
      await run(async () => {
        await api.cancelRun({ taskId: item.taskId, runId: item.runId! });
      });
      return;
    }
    await run(async () => {
      await api.decidePermission({
        taskId: item.taskId,
        runId: item.runId!,
        permissionId: item.permissionId,
        decision,
      });
    });
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 680) return;
    event.preventDefault();
    const resizer = event.currentTarget;
    const pointerId = event.pointerId;
    resizer.setPointerCapture(pointerId);
    let finalWidth = projection!.sidebarWidth;
    let resizeFrame: number | undefined;
    const shell = resizer.closest<HTMLElement>(".guild-shell");
    const paint = () => {
      resizeFrame = undefined;
      shell?.style.setProperty("--sidebar-width", `${finalWidth}px`);
    };
    const move = (moveEvent: PointerEvent) => {
      finalWidth = Math.max(220, Math.min(480, Math.round(moveEvent.clientX)));
      if (resizeFrame === undefined) resizeFrame = window.requestAnimationFrame(paint);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      paint();
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      setProjection((current) => current === undefined
        ? current
        : { ...current, sidebarWidth: finalWidth });
      void api.setSidebarWidth({ width: finalWidth }).catch(() => setError("operation"));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    window.addEventListener("blur", end, { once: true });
  }

  function resizeSidebarFromKeyboard(width: number) {
    const finalWidth = Math.max(220, Math.min(480, Math.round(width)));
    setProjection((current) => current === undefined ? current : { ...current, sidebarWidth: finalWidth });
    void api.setSidebarWidth({ width: finalWidth }).catch(() => setError("operation"));
  }

  function beginWorkbenchResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 1000) return;
    event.preventDefault();
    const resizer = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = workbenchWidth;
    resizer.setPointerCapture(pointerId);
    let finalWidth = startWidth;
    let resizeFrame: number | undefined;
    const shell = resizer.closest<HTMLElement>(".guild-shell");
    const paint = () => {
      resizeFrame = undefined;
      shell?.style.setProperty("--workbench-width", `${finalWidth}px`);
    };
    const move = (moveEvent: PointerEvent) => {
      finalWidth = clampWorkbenchWidth(startWidth + startX - moveEvent.clientX);
      if (resizeFrame === undefined) resizeFrame = window.requestAnimationFrame(paint);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      paint();
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      setWorkbenchWidth(finalWidth);
      writeWorkbenchWidth(window.localStorage, finalWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    window.addEventListener("blur", end, { once: true });
  }

  function resizeWorkbenchFromKeyboard(width: number) {
    if (window.innerWidth <= 1000) return;
    const finalWidth = clampWorkbenchWidth(width);
    setWorkbenchWidth(finalWidth);
    writeWorkbenchWidth(window.localStorage, finalWidth);
  }

  async function run(
    operation: () => Promise<void>,
    rollback?: () => void,
    failure: Exclude<UiError, "bootstrap"> = "operation",
  ) {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch {
      rollback?.();
      setError(failure);
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }

  const effectiveWorkbenchWidth = viewport.width <= 1000 ? WORKBENCH_MIN_WIDTH : workbenchWidth;

  return (
    <StreamOverlayContext.Provider value={streamOverlay}>
    <div
      className={`guild-shell ${workbenchOpen && activeTask !== undefined ? "workbench-open" : ""}`}
      style={{
        "--sidebar-width": `${projection.sidebarWidth}px`,
        "--workbench-width": `${effectiveWorkbenchWidth}px`,
      } as React.CSSProperties}
    >
      <aside className="guild-sidebar" aria-label={messages.projects} inert={workbenchOpen && viewport.width <= 1000}>
        <div className="guild-sidebar-drag" />
        <div className="guild-wordmark">
          <span className="guild-wordmark-name">{messages.appName}</span>
          {engineVersionLabel !== undefined && <small title={engineVersionLabel}>{engineVersionLabel}</small>}
        </div>
        <div className="guild-new-row">
          <button className="guild-new-task" type="button" disabled={busy} aria-keyshortcuts="Meta+N" onClick={() => void createTask()}>
            <Plus size={16} /><span>{messages.newTask}</span><kbd aria-hidden="true">{messages.newTaskShortcut}</kbd>
          </button>
        </div>
        <button className={`guild-search-trigger ${searchOpen ? "active" : ""}`} type="button" aria-expanded={searchOpen} aria-keyshortcuts="Meta+K"
          onClick={() => {
            setWorkspacePickerOpen(false); setSearchOpen((value) => !value);
            if (searchOpen) setSearchQuery("");
          }}><MagnifyingGlass size={16} /><span>{messages.search}</span><kbd aria-hidden="true">{messages.searchShortcut}</kbd></button>
        {searchOpen && (
          <div className="guild-search-box">
            <MagnifyingGlass size={14} />
            <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} placeholder={messages.searchPlaceholder} aria-label={messages.searchPlaceholder} />
            {searchQuery.length > 0 && <button type="button" aria-label={messages.clearSearch} onClick={() => setSearchQuery("")}><X size={13} /></button>}
          </div>
        )}

        <div className="guild-section-head">
          <span className="guild-section-label">{messages.projectAndChats}</span>
          <button className={`guild-icon-button guild-section-action ${workspacePickerOpen ? "active" : ""}`} type="button"
            aria-expanded={workspacePickerOpen} aria-haspopup="dialog" aria-label={messages.chooseWorkspace} title={messages.chooseWorkspace}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => {
              setAccountOpen(false); setWorkspacePickerOpen((value) => !value);
            }}><FolderSimplePlus size={16} /></button>
        {workspacePickerOpen && (
          <div className="guild-workspace-picker" role="dialog" aria-label={messages.chooseWorkspace} onPointerDown={(event) => event.stopPropagation()}>
            <strong>{messages.chooseWorkspace}</strong>
            {activeWorkspaces.map((workspace, index) => (
              <button key={workspace.workspaceId} autoFocus={index === 0} type="button" disabled={busy} onClick={() => {
                setWorkspacePickerOpen(false);
                const recent = workspace.tasks[0];
                if (recent !== undefined) void openTask(recent.taskId);
                else void createTask(workspace.workspaceId);
              }}>
                <FolderOpen size={16} /><span>{workspace.name}</span>
              </button>
            ))}
            <button autoFocus={activeWorkspaces.length === 0} type="button" onClick={() => void chooseWorkspace()}><Plus size={16} /><span>{messages.chooseWorkspace}</span></button>
            {(archivedWorkspaces.length > 0 || archivedTasks.length > 0) && (
              <>
                <div className="guild-picker-divider" />
                <strong>{messages.archived}</strong>
                {archivedWorkspaces.map((workspace) => (
                  <button key={`archived-${workspace.workspaceId}`} type="button" onClick={() => void restoreWorkspace(workspace.workspaceId)}>
                    <Archive size={16} /><span>{messages.restoreNamed(workspace.name)}</span>
                  </button>
                ))}
                {archivedTasks.map(({ workspace, task }) => (
                  <button key={`archived-${task.taskId}`} type="button" onClick={() => void restoreTask(task.taskId)}>
                    <Archive size={16} /><span>{messages.restoreTaskNamed(task.title, workspace.name)}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        </div>

        <div className="guild-project-section">
          {activeWorkspaces.length === 0 ? (
            <button className="guild-empty-workspace" type="button" onClick={() => void chooseWorkspace()}>
              <FolderOpen size={17} />
              <span>{messages.chooseWorkspace}</span>
            </button>
          ) : visibleWorkspaces.length === 0 && conversationSearchResults.length === 0 && !conversationSearchPending ? (
            <div className="guild-search-empty">{messages.noSearchResults}</div>
          ) : <>
          {visibleWorkspaces.map((workspace) => (
            <WorkspaceTree
              key={workspace.workspaceId}
              workspace={workspace}
              expanded={normalizedSearch.length > 0 || expandedWorkspaces.has(workspace.workspaceId)}
              activeTaskId={activeTask?.task.taskId}
              pendingTaskIds={pendingTaskIds}
              unreadTaskIds={unreadTaskIds}
              engineMarkers={engineMarkers}
              locale={projection.locale}
              onToggle={stableHandlers.onToggleWorkspace}
              onOpenTask={stableHandlers.onOpenTask}
              onNewTask={stableHandlers.onNewTask}
              onPinTask={stableHandlers.onPinTask}
              onArchiveTask={stableHandlers.onArchiveTask}
              onContextMenu={stableHandlers.onContextMenu}
            />
          ))}
          {conversationSearchPending && <div className="guild-search-progress"><SpinnerGap size={13} className="guild-spin" />{messages.searchingConversation}</div>}
          {conversationSearchResults.length > 0 && (
            <div className="guild-transcript-results">
              <div className="guild-section-label">{messages.inConversation}</div>
              {conversationSearchResults.map((result, index) => (
                <button key={`${result.taskId}-${result.sequence}`} type="button" disabled={busy} onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                  void openTask(result.taskId, result.sequence, { query: searchQuery, results: conversationSearchResults, index });
                }}>
                  <ChatCircleDots size={14} />
                  <span><strong>{result.taskTitle}</strong><small>{result.snippet}</small></span>
                </button>
              ))}
            </div>
          )}
          </>}
        </div>

        <div className="guild-profile-bar">
          {accountOpen && (
            <div
              className="guild-account-popover"
              id="guild-account-popover"
              role="dialog"
              aria-label={messages.usage}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setAccountOpen(false);
                queueMicrotask(() => profileTriggerRef.current?.focus());
              }}
            >
              <div className="guild-account-head">
                <AvatarMark nickname={projection.profile.nickname} grantUrl={projection.profile.avatarGrantUrl} />
                <div>
                  <strong>{projection.profile.nickname}</strong>
                  <span>{messages.localProfile}</span>
                </div>
              </div>
              <div className="guild-account-actions">
                <button ref={accountFirstActionRef} type="button" onClick={() => openProfileEditor()}><PencilSimple size={16} />{messages.editProfile}</button>
              </div>
              {activeEngine === "claude" ? (
                <div className="guild-usage-card guild-usage-card-claude">
                  <span>{messages.usageClaudeHeading}</span>
                  {claudeStatus?.accountLabel === undefined
                    ? <p>{messages.usageClaudeAccountUnknown}</p>
                    : <div className="guild-usage-values"><strong>{claudeStatus.accountLabel}</strong></div>}
                  <p>{!contextWindow.available
                    ? messages.contextUsageUnavailableCompact
                    : contextWindow.hasSize
                      ? messages.contextUsageLabel(contextWindow.usedLabel, contextWindow.sizeLabel, contextWindow.percent)
                      : messages.contextUsageUsedOnly(contextWindow.usedLabel)}</p>
                  <p>{messages.usageClaudeQuota}</p>
                </div>
              ) : (
                <div className="guild-usage-card">
                  <span>{messages.usage}</span>
                  {projection.usage.status === "loading" ? (
                    <p className="guild-usage-loading"><SpinnerGap size={13} className="guild-spin" />{messages.usageLoading}</p>
                  ) : projection.usage.status === "unavailable" ? (
                    <p>{messages.usageUnavailable}</p>
                  ) : (
                    <div className="guild-usage-values">
                      <strong>{projection.usage.usedLabel}</strong>
                      {projection.usage.limitLabel !== undefined && <span>{projection.usage.limitLabel}</span>}
                      {projection.usage.resetsAtIso !== undefined && (
                        <span>{messages.usageResetsAt(formatUsageDate(projection.usage.resetsAtIso, projection.locale))}</span>
                      )}
                    </div>
                  )}
                  <button className="guild-usage-link" type="button" onClick={() => void openExternal("https://grok.com/?_s=usage")}>{messages.viewOfficialUsage}</button>
                </div>
              )}
              <div className="guild-account-meta"><span>{messages.version}</span><span>{projection.appVersion}</span></div>
              <p className="guild-independent">{messages.independentNotice}</p>
            </div>
          )}
          <button ref={profileTriggerRef} className="guild-profile" type="button" aria-haspopup="dialog" aria-expanded={accountOpen} aria-controls={accountOpen ? "guild-account-popover" : undefined} onPointerDown={(event) => event.stopPropagation()} onClick={() => {
            setSettingsOpen(false);
            setWorkspacePickerOpen(false);
            const next = !accountOpen;
            setAccountOpen(next);
            // The quota read goes through the Grok runtime; a Claude conversation's quota is Claude Code's own.
            if (next && activeEngine === "grok") {
              void refreshUsage();
            }
          }}>
            <AvatarMark nickname={projection.profile.nickname} grantUrl={projection.profile.avatarGrantUrl} />
            <span className="guild-profile-text">
              <strong>{projection.profile.nickname}</strong>
              {activeEngine === "grok" && projection.usage.status === "available" && <small>{projection.usage.usedLabel}</small>}
            </span>
          </button>
          <div className="guild-sidebar-utilities">
            <button
              className="guild-icon-button"
              type="button"
              title={activeEngine === "grok" ? messages.tools : messages.grokToolsGrokOnly}
              aria-label={messages.tools}
              disabled={activeEngine !== "grok"}
              onClick={openGrokControlCenter}
            ><Wrench size={16} /></button>
            <button className="guild-icon-button guild-profile-settings" type="button" title={messages.settings} aria-label={messages.settings} onClick={() => openSettings()}><GearSix size={16} /></button>
          </div>
        </div>
      </aside>

      <div
        className="guild-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={messages.resizeSidebar}
        aria-valuemin={220}
        aria-valuemax={480}
        aria-valuenow={projection.sidebarWidth}
        tabIndex={workbenchOpen && viewport.width <= 1000 ? -1 : 0}
        onPointerDown={beginSidebarResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            resizeSidebarFromKeyboard(projection.sidebarWidth - 8);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            resizeSidebarFromKeyboard(projection.sidebarWidth + 8);
          } else if (event.key === "Home") {
            event.preventDefault();
            resizeSidebarFromKeyboard(220);
          } else if (event.key === "End") {
            event.preventDefault();
            resizeSidebarFromKeyboard(480);
          }
        }}
      />

      <main className="guild-main" inert={workbenchOpen && viewport.width <= 1000}>
        <header className="guild-topbar">
          <div className="guild-task-heading">
            <span className="guild-task-heading-title">{activeTask?.task.title ?? messages.newTask}</span>
            {activeTask !== undefined && (
              <span className="guild-workspace-chip">
                <FolderSimple size={12} aria-hidden="true" />
                <span>{workspaceName(projection.workspaces, activeTask.task.workspaceId, messages.workspaceFallback)}</span>
              </span>
            )}
            {worktreeUi.renderChip(activeTask)}
          </div>
          <div className="guild-top-actions">
            {changedRun !== undefined && (
              <button
                className="guild-ghost-button guild-changes-summary"
                type="button"
                title={messages.changesSummaryTitle(changedRun.filesChanged)}
                onClick={() => scrollToRunCard(changedRun.runId)}
              >
                <FileText size={14} aria-hidden="true" />{messages.changesSummaryLabel}
                <span className="n">{changedRun.filesChanged}</span>
                <span className="a">+{changedRun.adds}</span><span className="d">{"\u2212"}{changedRun.dels}</span>
              </button>
            )}
            <button
              ref={workbenchTrigger}
              className={`guild-icon-button guild-workbench-trigger ${workbenchOpen ? "active" : ""}`}
              type="button"
              aria-label={messages.workbench}
              aria-expanded={workbenchOpen && activeTask !== undefined}
              title={messages.workbench}
              disabled={activeTask === undefined}
              onClick={() => setWorkbenchOpen((value) => !value)}
            ><SidebarSimple size={16} mirrored /></button>
            <button className="guild-icon-button" type="button" aria-label={messages.openMenu} disabled={activeTask === undefined} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
              event.stopPropagation();
              if (activeTask === undefined) return;
              if (contextMenu?.type === "task" && contextMenu.task.taskId === activeTask.task.taskId) {
                setContextMenu(undefined);
                setConfirmDelete(false);
                setRenamingTask(false);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setConfirmDelete(false);
              setRenamingTask(false);
              setRenameError(false);
              setContextMenu({
                type: "task",
                task: activeTask.task,
                ...clampContextMenuPosition(
                  rect.right - 200,
                  rect.bottom + 4,
                  viewport.width,
                  viewport.height,
                ),
              });
            }}><DotsThree size={18} /></button>
          </div>
        </header>

        {searchNavigation !== undefined && (
          <nav className="guild-search-navigation" aria-label={messages.inConversation}>
            <MagnifyingGlass size={15} /><strong>{searchNavigation.query}</strong>
            <span>{messages.searchPosition(searchNavigation.index + 1, searchNavigation.results.length)}</span>
            {([-1, 1] as const).map((direction) => <button key={direction} type="button" disabled={busy ||
              searchNavigation.index + direction < 0 || searchNavigation.index + direction >= searchNavigation.results.length}
              aria-label={direction < 0 ? messages.previousMatch : messages.nextMatch} onClick={() => {
                const index = searchNavigation.index + direction;
                const result = searchNavigation.results[index]!;
                void openTask(result.taskId, result.sequence, { ...searchNavigation, index });
              }}>{direction < 0 ? <CaretLeft size={16} /> : <CaretRight size={16} />}</button>)}
            <button type="button" aria-label={messages.closeMatches} onClick={() => setSearchNavigation(undefined)}><X size={15} /></button>
          </nav>
        )}

        {projection.recoveredAfterUncleanShutdown && (
          <div className="guild-recovery-banner"><Check size={15} />{messages.recovered}</div>
        )}

        {attentionTasks.length > 0 && (
          <nav className="guild-attention-rail" aria-label={messages.currentAttention}>
            <span>{messages.currentAttention}</span>
            {attentionTasks.map((task) => (
              <button
                key={task.taskId}
                type="button"
                onClick={() => void openTask(task.taskId)}
              >
                <span className={`guild-task-state ${sidebarTaskStatus(task)}`} aria-hidden="true">
                  <TaskStatusGlyph status={sidebarTaskStatus(task)} />
                </span>
                <strong>{task.title}</strong>
                <small className={sidebarTaskStatus(task) === "permission" ? "wait" : undefined}>
                  {sidebarTaskStatus(task) === "permission"
                    ? messages.taskMetaPermission
                    : messages.activeActivity(task.activeActivity ?? "working")}
                </small>
              </button>
            ))}
          </nav>
        )}

        <span className="guild-sr-only" role="status" aria-live="polite">{latestAssistantAnnouncement}</span>
        <section className="guild-conversation" ref={conversation}>
          <div className="guild-scroll-sentinel" ref={timelineTopSentinel} aria-hidden="true" />
          {loadingEarlierTimeline && (
            <div className="guild-history-loading" aria-label={messages.loadingEarlierHistory}>
              <SpinnerGap size={13} className="guild-spin" />
              <span>{messages.loadingEarlierHistory}</span>
            </div>
          )}
          {activeTask === undefined ? (
            <Welcome messages={messages} hasWorkspace={activeWorkspaces.length > 0} onChoose={() => void chooseWorkspace()} onCreate={() => void createTask()} />
          ) : activeTimeline.length === 0 && pendingSendForActive === undefined ? (
            <div className="guild-empty-task">
              <GuildHero messages={messages} help={messages.starterHelp} />
              <div className="guild-starters">{([
                [messages.starterReview, messages.starterReviewDraft, <MagnifyingGlass size={19} />],
                [messages.starterBuild, messages.starterBuildDraft, <Code size={19} />],
                [messages.starterExplain, messages.starterExplainDraft, <ChatCircleDots size={19} />],
              ] as const).map(([label, text, icon]) => <button type="button" key={label} disabled={draft.trim().length > 0}
                onClick={() => { setDraft(text); composerInput.current?.focus(); }}>{icon}<span>{label}</span><ArrowUpRight size={15} /></button>)}</div>
              {worktreeUi.renderStartOption(activeTask, true, busy, (checked) => void createTask(activeTask.task.workspaceId, checked))}
            </div>
          ) : (
            <Timeline
              items={activeTimeline}
              pendingUserText={pendingSendForActive?.text}
              runStatus={commandStatus === undefined ? runStatus : undefined}
              runPhase={commandStatus === undefined ? activeTask.runPhase : undefined}
              locale={projection.locale}
              engine={activeEngine}
              recentResult={activeTask.recentResult}
              continuousTask={activeTask.continuousTask}
              runCheckpoints={activeTask.runCheckpoints}
              runModels={activeTask.runModels}
              rewind={activeTask.rewind}
              running={running}
              highlightedSequence={searchNavigation?.results[searchNavigation.index]?.taskId === activeTask.task.taskId
                ? searchNavigation.results[searchNavigation.index]?.sequence : undefined}
              onOpenExternal={stableHandlers.onOpenExternal}
              onPermissionDecision={stableHandlers.onPermissionDecision}
              onBranch={stableHandlers.onBranch}
              onRetryToDraft={stableHandlers.onRetryToDraft}
              onOpenRuntimeDiagnostics={stableHandlers.onOpenRuntimeDiagnostics}
              onViewRunDiff={stableHandlers.onViewRunDiff}
              onRewind={stableHandlers.onRewind}
            />
          )}
          {commandStatus !== undefined && <CommandStatusLine status={commandStatus} locale={projection.locale} engine={activeEngine} />}
          {activeTask?.recentResult !== undefined && !restoredNoticeCoversLatestResult && !resultSummaryRepeatsCard &&
            (activeTask.recentResult.state !== "completed" || activeTask.recentResult.workbench.files.length > 0 ||
              activeTask.recentResult.workbench.diffs.length > 0) && (
            <section className={`guild-result-summary ${activeTask.recentResult.state}`} aria-label={messages.latestResult}>
              <div>
                {activeTask.recentResult.state === "completed"
                  ? <Check size={14} />
                  : activeTask.recentResult.state === "cancelled"
                    ? <Stop size={12} weight="fill" />
                    : <WarningCircle size={14} />}
                <span>
                  <strong>{activeTask.recentResult.state === "interrupted"
                    ? messages.interruptedResult
                    : activeTask.recentResult.state === "failed"
                      ? messages.failedResult
                      : activeTask.recentResult.state === "cancelled"
                        ? messages.cancelledResult
                        : messages.latestResult}</strong>
                  <small>{activeTask.recentResult.workbench.files.length === 0 && activeTask.recentResult.workbench.diffs.length === 0
                    ? activeTask.recentResult.state === "interrupted"
                      ? messages.interruptedResultUnconfirmed
                      : messages.latestResultNoChanges
                    : messages.latestResultCounts(
                        activeTask.recentResult.workbench.files.length,
                        activeTask.recentResult.workbench.diffs.length,
                      )}</small>
                </span>
              </div>
              {activeTask.recentResult.state === "interrupted" &&
              activeTask.recentResult.workbench.files.length === 0 &&
              activeTask.recentResult.workbench.diffs.length === 0
                ? <button type="button" onClick={() => void api.openRuntimeDiagnostics({})}>{messages.openRuntimeDiagnostics}</button>
                : <button type="button" onClick={() => {
                    setWorkbenchTab(activeTask.recentResult!.workbench.diffs.length > 0 ? "review" : "files");
                    setWorkbenchOpen(true);
                  }}>{messages.viewResult}</button>}
            </section>
          )}
          {error !== undefined && (
            <div className="guild-inline-error" role="alert">
              {error === "runtime"
                ? messages.runtimeUnavailable
                : error === "claude_start"
                  ? messages.claudeStartTimeout
                : error === "recovery"
                  ? messages.sessionRecoveryContextRequired
                : error === "workspace"
                  ? messages.workspaceFolderMissing
                  : error === "message"
                    ? messages.messageTooLong
                    : messages.operationFailed}
            </div>
          )}
          <div className="guild-scroll-sentinel" ref={timelineBottomSentinel} aria-hidden="true" />
        </section>

        <form className="guild-composer-wrap" onSubmit={(event) => void submit(event)}>
          {worktreeUi.renderBanner(activeTask)}
          {activeTask?.sessionRecovery === "replacement_required" && (
            <div className="guild-session-recovery" role="alert">
              <div>
                <strong>{messages.sessionReplacementTitle}</strong>
                <span>{messages.sessionReplacementBody}</span>
              </div>
              <button type="button" disabled={busy} onClick={() => void authorizeSessionReplacement()}>
                {messages.sessionReplacementAction}
              </button>
            </div>
          )}
          {activeTask?.continuousTask !== undefined && !["completed", "stopped"].includes(activeTask.continuousTask.status) && (
            <ContinuousTaskCard
              key={activeTask.task.taskId}
              task={activeTask.continuousTask}
              locale={projection.locale}
              engine={activeEngine}
              running={running}
              busy={busy}
              onAction={(action) => void setContinuousTask(action)}
            />
          )}
          {slashMenuOpen && (
            <div className="guild-slash-menu" id="guild-slash-menu" role="listbox" aria-label={messages.slashCommands}>
              <div className="guild-slash-heading">{messages.slashCommands}</div>
              {filteredSlashCommands.length === 0 ? (
                <div className="guild-slash-status">{messages.slashCommandsEmpty}</div>
              ) : filteredSlashCommands.map((command, index) => (
                <button
                  id={`guild-slash-command-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === selectedSlashCommandIndex}
                  className={index === selectedSlashCommandIndex ? "selected" : undefined}
                  key={command.name}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void chooseSlashCommand(command)}
                >
                  <code>/{command.name}</code>
                  <span>{command.description}</span>
                  {command.inputHint !== undefined && <small>{command.inputHint}</small>}
                </button>
              ))}
            </div>
          )}
          <div className={`guild-composer ${running ? "running" : ""}`}>
            {activeTask !== undefined && activeTask.queuedTurns.length > 0 && (
              <div className="guild-queued-turns" aria-label={messages.queuedNext}>
                <span className="guild-queued-label">{messages.queuedNext}</span>
                {activeTask.queuedTurns.map((queued, index) => {
                  const preempting = index === 0 && activeTask.task.activeRunState === "cancel_requested";
                  return (
                    <div className="guild-queued-turn" key={queued.queueId}>
                      <span className="guild-queued-text">{queued.text}</span>
                      {preempting ? (
                        <span className="guild-queued-next-badge preempting">
                          <SpinnerGap size={10} className="guild-spin" />
                          {messages.preemptingQueued}
                        </span>
                      ) : isLiveRunState(activeTask.task.activeRunState) ? (
                        <>
                          {steerAvailable && (
                            <button
                              type="button"
                              className="guild-queue-steer"
                              disabled={busy}
                              title={messages.convertToSteerHelp}
                              aria-label={`${messages.convertToSteer}: ${queued.text}`}
                              onClick={() => void convertQueuedToSteer(queued.queueId)}
                            >{messages.convertToSteer}</button>
                          )}
                          <button
                            type="button"
                            className="guild-queue-priority"
                            disabled={busy}
                            title={messages.preemptQueuedHelp}
                            aria-label={`${messages.preemptQueued}: ${queued.text}`}
                            onClick={() => void preemptQueuedTurn(queued.queueId)}
                          >
                            <ArrowUp size={12} />
                            {messages.preemptQueued}
                          </button>
                        </>
                      ) : index === 0 ? (
                        <span className="guild-queued-next-badge">{messages.queuedFirst}</span>
                      ) : null}
                      <button className="guild-queue-cancel" type="button" disabled={busy} aria-label={messages.cancelQueued} onClick={() => void cancelQueuedTurn(queued.queueId)}>
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {steerNotice !== undefined && <p className="guild-steer-notice" role="status">{steerNotice}</p>}
            {promptAttachments.length > 0 && (
              <div className="guild-prompt-attachments" aria-label={messages.attachedFiles}>
                {promptAttachments.map((attachment) => (
                  <span className="guild-prompt-attachment" key={attachment.relativePath} title={attachment.relativePath}>
                    <FileText size={13} />
                    <span>{attachment.name}</span>
                    <small>{formatAttachmentSize(attachment.size)}</small>
                    <button type="button" aria-label={messages.removeAttachment(attachment.name)} onClick={() => removePromptAttachment(attachment.relativePath)}><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={composerInput}
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setDismissedSlashDraft(undefined);
                setSlashCommandIndex(0);
              }}
              onKeyDown={(event) => {
                if (slashMenuOpen && filteredSlashCommands.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashCommandIndex((current) => (current + 1) % filteredSlashCommands.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashCommandIndex((current) =>
                      (current - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
                    return;
                  }
                  if (event.key === "Tab") {
                    event.preventDefault();
                    insertSlashCommand(filteredSlashCommands[selectedSlashCommandIndex]!);
                    return;
                  }
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.preventDefault();
                    void chooseSlashCommand(filteredSlashCommands[selectedSlashCommandIndex]!);
                    return;
                  }
                }
                if (slashMenuOpen && event.key === "Escape") {
                  event.preventDefault();
                  setDismissedSlashDraft(draft);
                  return;
                }
                const enter = composerEnterAction({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                }, { steerAvailable });
                if (enter === "none") return;
                event.preventDefault();
                // Enter queues behind the running turn as it always has; Option+Enter steers it.
                if (enter === "steer") void sendComposerText(draft, "steer");
                else event.currentTarget.form?.requestSubmit();
              }}
              placeholder={activeTask === undefined ? noTaskComposerPlaceholder(messages, activeWorkspaces.length > 0) : pendingSendForActive !== undefined ? messages.connectingRuntime : running ? (steerAvailable ? messages.queueSteerPlaceholder : messages.queuePlaceholder) : messages.composerPlaceholder}
              aria-label={messages.composerPlaceholder}
              aria-controls={slashMenuOpen ? "guild-slash-menu" : undefined}
              aria-expanded={slashMenuOpen}
              aria-activedescendant={slashMenuOpen && filteredSlashCommands.length > 0
                ? `guild-slash-command-${selectedSlashCommandIndex}`
                : undefined}
              aria-busy={busy || pendingSendForActive !== undefined}
              disabled={activeTask === undefined}
              readOnly={busy}
              rows={1}
            />
            <div className="guild-composer-tools">
              <button
                className="guild-icon-button guild-attach"
                type="button"
                disabled={activeTask === undefined || running || busy || continuousMode || promptAttachments.length >= 8}
                aria-label={messages.addWorkspaceFiles}
                title={running ? messages.attachmentsCannotQueue : messages.addWorkspaceFiles}
                onClick={() => void choosePromptFiles()}
              ><Paperclip size={16} /></button>
              <span className="guild-pill guild-workspace-pill">
                <FolderSimple size={14} aria-hidden="true" />
                <span>{activeTask === undefined ? messages.chooseWorkspace : workspaceName(projection.workspaces, activeTask.task.workspaceId, messages.workspaceFallback)}</span>
              </span>
              {permissionPill !== undefined && (
                <button
                  type="button"
                  className={`guild-pill guild-permission-pill ${permissionPill.warn ? "warn" : ""}`}
                  title={messages.permissionHelp}
                  onClick={() => openSettings("engines")}
                >
                  {permissionPill.warn
                    ? <ShieldWarning size={14} aria-hidden="true" />
                    : <ShieldCheck size={14} aria-hidden="true" />}
                  {permissionPill.label}
                </button>
              )}
              <button
                type="button"
                className={`guild-pill guild-continuous-toggle ${continuousMode ? "selected" : ""}`}
                disabled={activeTask === undefined || running || busy || promptAttachments.length > 0 ||
                  activeTask?.continuousTask?.status === "active" || activeTask?.continuousTask?.status === "paused"}
                aria-pressed={continuousMode}
                title={messages.continuousModeHelp}
                onClick={() => setContinuousMode((value) => !value)}
              >
                <ArrowsClockwise size={14} aria-hidden="true" />
                {messages.continuousMode}
              </button>
              {running && draft.trim().length > 0 && <span className="guild-queue-hint">{messages.queueReady}</span>}
              <span className="guild-meta-spacer" />
              <button
                type="button"
                className={`guild-context-usage ${contextWindow.available ? "available" : "unavailable"} ${contextWindow.hasSize ? "measured" : "used-only"} ${contextWindow.hasSize && contextWindow.percent >= 80 ? "high" : ""}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setContextUsageOpen((open) => !open)}
                title={!contextWindow.available
                  ? messages.contextUsageUnavailable
                  : contextWindow.hasSize
                    ? messages.contextUsageLabel(contextWindow.usedLabel, contextWindow.sizeLabel, contextWindow.percent)
                    : messages.contextUsageUsedOnly(contextWindow.usedLabel)}
                aria-label={!contextWindow.available
                  ? messages.contextUsageUnavailable
                  : contextWindow.hasSize
                    ? messages.contextUsageLabel(contextWindow.usedLabel, contextWindow.sizeLabel, contextWindow.percent)
                    : messages.contextUsageUsedOnly(contextWindow.usedLabel)}
              >
                <span
                  className="guild-context-ring"
                  aria-hidden="true"
                  style={{ "--guild-context-percent": `${contextWindow.percent}%` } as React.CSSProperties}
                />
                {contextWindow.available && contextWindow.hasSize && (
                  <span className="guild-context-percent">{contextWindow.percent}%</span>
                )}
                {contextUsageOpen && <span className="guild-context-usage-detail" role="status">{!contextWindow.available
                  ? messages.contextUsageUnavailableCompact
                  : contextWindow.hasSize
                    ? messages.contextUsageCompact(contextWindow.usedLabel, contextWindow.sizeLabel, contextWindow.percent)
                    : messages.contextUsageUsedOnly(contextWindow.usedLabel)}</span>}
              </button>
              <ModelPicker
                key={activeTask?.task.taskId ?? "no-task"}
                messages={messages}
                catalogs={modelCatalogs}
                selection={activeTask?.modelSelection}
                taskEngine={activeEngine}
                engineFixed={engineFixed}
                switching={modelSwitchRunning(modelSwitch, activeTask?.task.taskId)}
                modalOpen={onlineReminder !== undefined}
                {...(claudeStatus === undefined ? {} : { claudeState: claudeStatus.state })}
                onApply={applyTaskRuntimeSettings}
                onOpenModelSources={() => openSettings("sources")}
              />
              {steerButton.visible && (
                <button
                  type="button"
                  className="guild-steer"
                  disabled={steerButton.disabled}
                  aria-keyshortcuts="Alt+Enter"
                  title={steerButton.needsText ? messages.steerNeedsText : messages.steerHelp}
                  onClick={() => void sendComposerText(draft, "steer")}
                >{messages.steerAction}<kbd aria-hidden="true">{messages.steerShortcut}</kbd></button>
              )}
              {running ? (
                <button className="guild-send guild-stop" type="button" disabled={busy || activeTask?.task.activeRunState === "cancel_requested"} onClick={() => void cancelActiveRun()} aria-label={messages.stop} title={messages.stop}><Stop size={12} weight="fill" /></button>
              ) : (
                <button className="guild-send" type="submit" disabled={draft.trim().length === 0 || activeTask === undefined || !activeTask.canSend || busy || activePendingSend !== undefined || (running && promptAttachments.length > 0)} aria-label={messages.send} title={messages.send}>
                  {busy || pendingSendForActive !== undefined ? <SpinnerGap size={16} className="guild-spin" /> : <ArrowUp size={16} weight="bold" />}
                </button>
              )}
            </div>
          </div>
          {switchLine !== undefined && (
            <div className={`guild-composer-switch ${switchLine.kind}`} role={switchLine.kind === "failed" ? "alert" : "status"}>
              {switchLine.kind === "switching" && <SpinnerGap size={12} className="guild-spin" aria-hidden="true" />}
              <span>{switchLine.text}</span>
            </div>
          )}
          <div className="guild-composer-hints">
            <span><b>↩</b> {running ? messages.hintQueue : messages.hintSend}</span>
            <span><b>⇧↩</b> {messages.hintNewline}</span>
            {steerAvailable && <span><b>{messages.steerShortcut}</b> {messages.hintSteer}</span>}
            <span><b>/</b> {messages.hintCommands}</span>
          </div>
        </form>
      </main>

      {workbenchOpen && activeTask !== undefined && (
        <aside ref={workbenchPanel} className="guild-workbench" aria-label={messages.workbench}
          role={viewport.width <= 1000 ? "dialog" : undefined} aria-modal={viewport.width <= 1000 || undefined}
          onKeyDown={(event) => {
            if (viewport.width <= 1000) handleDialogKeyDown(event, () => {
              setWorkbenchOpen(false); requestAnimationFrame(() => workbenchTrigger.current?.focus());
            });
            else if (event.key === "Escape") setWorkbenchOpen(false);
          }}>
          <div
            className={`guild-workbench-resizer ${viewport.width <= 1000 ? "locked" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={messages.resizeSidebar}
            aria-valuemin={WORKBENCH_MIN_WIDTH}
            aria-valuemax={WORKBENCH_MAX_WIDTH}
            aria-valuenow={effectiveWorkbenchWidth}
            aria-disabled={viewport.width <= 1000}
            tabIndex={viewport.width <= 1000 ? -1 : 0}
            onPointerDown={beginWorkbenchResize}
            onKeyDown={(event) => {
              if (viewport.width <= 1000) return;
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                resizeWorkbenchFromKeyboard(workbenchWidth + 8);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                resizeWorkbenchFromKeyboard(workbenchWidth - 8);
              } else if (event.key === "Home") {
                event.preventDefault();
                resizeWorkbenchFromKeyboard(WORKBENCH_MIN_WIDTH);
              } else if (event.key === "End") {
                event.preventDefault();
                resizeWorkbenchFromKeyboard(WORKBENCH_MAX_WIDTH);
              }
            }}
          />
          <div className="guild-workbench-head">
            <strong>{messages.workbench}</strong>
            <button autoFocus={viewport.width <= 1000} type="button" aria-label={messages.closeDialog} onClick={() => {
              setWorkbenchOpen(false); requestAnimationFrame(() => workbenchTrigger.current?.focus());
            }}><X size={15} /></button>
          </div>
          <div className="guild-workbench-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={workbenchTab === "files"} className={workbenchTab === "files" ? "selected" : ""} onClick={() => setWorkbenchTab("files")}><Files size={15} />{messages.files}</button>
            <button type="button" role="tab" aria-selected={workbenchTab === "review"} className={workbenchTab === "review" ? "selected" : ""} onClick={() => setWorkbenchTab("review")}><GitDiff size={15} />{messages.review}<span>{visibleWorkbench?.diffs.length ?? 0}</span></button>
            <button type="button" role="tab" aria-selected={workbenchTab === "browser"} className={workbenchTab === "browser" ? "selected" : ""} onClick={() => setWorkbenchTab("browser")}><Globe size={15} />{messages.browserPaneWorkbenchTab}</button>
          </div>
          {workbenchTab === "browser" ? (
            <div className="guild-workbench-body guild-workbench-browser">
              <BrowserPane
                projection={browserPane}
                onCommand={sendBrowserCommand}
                t={(key) => messages[key]}
                hidden={browserHidden}
              />
            </div>
          ) : (
          <div className="guild-workbench-body">
            {workbenchTab === "review" && runDiff !== undefined && runDiffCheckpoint !== undefined && (
              <RunDiffView
                key={runDiff.runId}
                messages={messages}
                checkpoint={runDiffCheckpoint}
                path={runDiff.path}
                onSelect={(path) => setRunDiff({ runId: runDiff.runId, path })}
                onClose={() => setRunDiff(undefined)}
                load={loadRunDiff}
              />
            )}
            <label className="guild-workbench-scope">{messages.evidenceScope}<select value={workbenchScope}
              onChange={(event) => setWorkbenchScope(event.currentTarget.value as "loaded" | "latest")}>
              <option value="loaded">{messages.loadedHistory}</option><option value="latest">{messages.latestRound}</option>
            </select></label>
            <p className="guild-workbench-evidence-help">{messages.evidenceHelp}</p>
            <button className="guild-workbench-terminal" type="button" onClick={() => void openTaskResource("folder")}>
              <FolderOpen size={17} /><span>{messages.workspaceFiles}</span></button>
            {workbenchTab === "files" ? (
              <>
                <button className="guild-workbench-terminal" type="button" onClick={() => void openTaskResource("terminal")}><TerminalWindow size={16} /><span><strong>{messages.openTerminal}</strong><small>{messages.openTerminalHelp}</small></span></button>
                <div className="guild-workbench-label">{messages.filesTouched}</div>
                {(visibleWorkbench?.files ?? []).length === 0 ? <p className="guild-workbench-empty">{messages.noFilesYet}<br />{messages.noEvidenceAction}</p> : (visibleWorkbench?.files ?? []).map((file) => (
                  <button className="guild-workbench-file" key={file.path} type="button" onClick={() => void openTaskResource("file", file.path)}>
                    <FileText size={15} /><span>{file.displayPath}</span>{file.line !== undefined && <small>:{file.line}</small>}
                  </button>
                ))}
              </>
            ) : (visibleWorkbench?.diffs ?? []).length === 0 ? (
              <div className="guild-workbench-empty"><p>{messages.noChangesYet}</p><p>{messages.noEvidenceAction}</p>
                <button className="guild-soft-button" type="button" disabled={draft.trim().length > 0 || running} onClick={() => {
                  setDraft(messages.inspectChangesDraft); setWorkbenchOpen(false); composerInput.current?.focus();
                }}>{messages.inspectChanges}</button></div>
            ) : (visibleWorkbench?.diffs ?? []).map((diff) => (
              <details className="guild-review-item" key={diff.path}>
                <summary><GitDiff size={14} /><span>{diff.displayPath}</span></summary>
                {diff.oldText !== undefined && <><small>{messages.beforeChange}</small><pre className="before">{diff.oldText || messages.emptyFile}</pre></>}
                <small>{messages.afterChange}</small><pre className="after">{diff.newText || messages.emptyFile}</pre>
              </details>
            ))}
          </div>
          )}
        </aside>
      )}

      {resolvedContextMenu !== undefined && contextMenuBox !== undefined && (
        <div
          className={`guild-context-menu ${confirmDelete ? "confirming" : renamingTask ? "editing" : ""}`}
          role={confirmDelete ? "alertdialog" : "dialog"}
          aria-modal={confirmDelete || undefined}
          aria-label={confirmDelete ? messages.confirmDelete : messages.openMenu}
          style={{ left: contextMenuBox.x, top: contextMenuBox.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {confirmDelete ? (
            <>
              <p>{resolvedContextMenu.type === "workspace"
                ? messages.confirmDeleteWorkspace(resolvedContextMenu.workspace.name, resolvedContextMenu.workspace.tasks.length)
                : messages.confirmDeleteTask(resolvedContextMenu.task.title)}</p>
              <div className="guild-context-confirm-actions">
                <button type="button" autoFocus onClick={() => {
                  setConfirmDelete(false);
                  setContextMenu(undefined);
                }}>{messages.cancel}</button>
                <button type="button" className="danger" onClick={() => void updateContext("delete")}><Trash size={15} />{messages.confirmDelete}</button>
              </div>
            </>
          ) : renamingTask && resolvedContextMenu.type === "task" ? (
            <form onSubmit={(event) => {
              event.preventDefault();
              void commitTaskRename();
            }}>
              <label htmlFor="guild-task-rename">{messages.renameTask}</label>
              <input
                id="guild-task-rename"
                autoFocus
                value={renameDraft}
                aria-invalid={renameError || undefined}
                aria-label={messages.taskTitle}
                onChange={(event) => {
                  setRenameDraft(event.currentTarget.value);
                  setRenameError(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setRenamingTask(false);
                  }
                }}
              />
              {renameError && <p className="guild-context-error">{messages.taskTitleInvalid}</p>}
              <div className="guild-context-confirm-actions">
                <button type="button" onClick={() => setRenamingTask(false)}>{messages.cancel}</button>
                <button type="submit">{messages.save}</button>
              </div>
            </form>
          ) : (
            <>
              {resolvedContextMenu.type === "task" && (
                <>
                  <button autoFocus type="button" onClick={() => void updateTaskContext(resolvedContextMenu.task.pinned ? "unpin" : "pin")}>
                    {resolvedContextMenu.task.pinned ? <PushPinSimpleSlash size={16} /> : <PushPinSimple size={16} />}
                    {resolvedContextMenu.task.pinned ? messages.unpin : messages.pin}
                  </button>
                  <button type="button" onClick={beginRenameTask}><PencilSimple size={16} />{messages.rename}</button>
                  <button type="button" onClick={() => void forkTaskContext()}><GitFork size={16} />{messages.forkFromHere}</button>
                  <button type="button" onClick={() => void exportTaskContext("markdown")}><DownloadSimple size={16} />{messages.exportMarkdown}</button>
                  <button type="button" onClick={() => void exportTaskContext("json")}><DownloadSimple size={16} />{messages.exportJson}</button>
                  {(resolvedContextMenu.task.worktreeStatus === "active" || resolvedContextMenu.task.worktreeStatus === "applied") && (
                    <button type="button" disabled={contextManagementBlocked} onClick={() => {
                      const target = resolvedContextMenu.task;
                      setContextMenu(undefined);
                      worktreeUi.openApply(target.taskId, target.taskId === activeTask?.task.taskId ? activeTask?.worktree : undefined);
                    }}><GitMerge size={16} />{worktreeUi.messages.taskMenuMerge}</button>
                  )}
                  {resolvedContextMenu.task.worktreeStatus !== undefined && resolvedContextMenu.task.worktreeStatus !== "discarded" && (
                    <button type="button" className="danger" disabled={contextManagementBlocked} onClick={() => {
                      const target = resolvedContextMenu.task;
                      setContextMenu(undefined);
                      worktreeUi.openDiscard(target.taskId, target.taskId === activeTask?.task.taskId ? activeTask?.worktree : undefined);
                    }}><Trash size={16} />{worktreeUi.messages.taskMenuDiscard}</button>
                  )}
                  <div className="guild-context-divider" />
                </>
              )}
              {contextManagementBlocked ? (
                <p className="guild-context-blocked">{messages.stopTaskBeforeManage}</p>
              ) : (<>
              <button autoFocus={resolvedContextMenu.type === "workspace"} type="button" onClick={() => void updateContext(resolvedContextMenu.type === "workspace" ? (resolvedContextMenu.workspace.archived ? "restore" : "archive") : (resolvedContextMenu.task.archived ? "restore" : "archive"))}>
                <Archive size={16} />{resolvedContextMenu.type === "workspace" ? (resolvedContextMenu.workspace.archived ? messages.restore : messages.archive) : (resolvedContextMenu.task.archived ? messages.restore : messages.archive)}
              </button>
              <button type="button" className="danger" onClick={() => setConfirmDelete(true)}><Trash size={16} />{messages.delete}</button>
              </>)}
            </>
          )}
        </div>
      )}

      {worktreeUi.renderOverlays(activeTask, running)}

      {commandPaletteOpen && (
        <div className="guild-command-backdrop" role="presentation" onPointerDown={closeCommandPalette}>
          <div
            className="guild-command-palette"
            role="dialog"
            aria-modal="true"
            aria-label={messages.commandPalette}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeCommandPalette();
              } else if (event.key === "ArrowDown" && commandPaletteItems.length > 0) {
                event.preventDefault();
                setCommandPaletteIndex((current) => (current + 1) % commandPaletteItems.length);
              } else if (event.key === "ArrowUp" && commandPaletteItems.length > 0) {
                event.preventDefault();
                setCommandPaletteIndex((current) =>
                  (current - 1 + commandPaletteItems.length) % commandPaletteItems.length);
              } else if (event.key === "Enter" && commandPaletteItems.length > 0) {
                event.preventDefault();
                void commandPaletteItems[selectedCommandPaletteIndex]!.run();
              } else if (event.key === "Tab") {
                handleDialogKeyDown(event, closeCommandPalette);
              }
            }}
          >
            <div className="guild-command-search">
              <MagnifyingGlass size={17} />
              <input
                autoFocus
                value={commandPaletteQuery}
                placeholder={messages.commandPalettePlaceholder}
                aria-label={messages.commandPalettePlaceholder}
                onChange={(event) => {
                  setCommandPaletteQuery(event.currentTarget.value);
                  setCommandPaletteIndex(0);
                }}
              />
              <kbd>⌘K</kbd>
            </div>
            <div className="guild-command-results" role="listbox">
              {commandPaletteItems.length === 0 ? (
                <p>{messages.commandPaletteEmpty}</p>
              ) : commandPaletteItems.map((item, index) => (
                <div key={item.id}>
                  {(index === 0 || commandPaletteItems[index - 1]!.group !== item.group) && (
                    <div className="guild-command-group">{messages.commandPaletteGroup(item.group)}</div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedCommandPaletteIndex}
                    className={index === selectedCommandPaletteIndex ? "selected" : undefined}
                    onMouseEnter={() => setCommandPaletteIndex(index)}
                    onClick={() => void item.run()}
                  >
                    <Command size={15} />
                    <span><strong>{item.label}</strong>{item.detail !== undefined && <small>{item.detail}</small>}</span>
                  </button>
                </div>
              ))}
            </div>
            <footer>{messages.commandPaletteHint}</footer>
          </div>
        </div>
      )}

      {grokControlOpen && (
        <GrokControlCenter
          api={api}
          messages={messages}
          activeTaskId={activeTask?.task.taskId}
          commands={visibleSlashCommands}
          managementAvailable={projection.runtimeSettings.canChange}
          managementProgress={projection.grokManagementProgress}
          diagnostics={projection.runtimeDiagnostics}
          runtimeSummary={Array.from(new Set([
            projection.runtimeVersion ?? "Grok Build",
            runtimeModelView.modelName,
            ...(runtimeModelView.effortLabel === undefined ? [] : [runtimeModelView.effortLabel]),
          ])).join(" · ")}
          onClose={closeGrokControlCenter}
          onOpenSessionSettings={() => {
            setGrokControlOpen(false);
            openSettings("engines");
          }}
          onRunCommand={async (command, input) => {
            const text = `/${command.name}${input.trim().length === 0 ? "" : ` ${input.trim()}`}`;
            await sendComposerText(text);
            setGrokControlOpen(false);
          }}
        />
      )}

      {settingsOpen && (
        <div className="guild-dialog-backdrop" role="presentation" onPointerDown={() => setSettingsOpen(false)}>
          <div className="guild-dialog guild-dialog-settings" role="dialog" aria-modal="true" aria-label={messages.settings} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => handleDialogKeyDown(event, () => setSettingsOpen(false))}>
            <div className="guild-dialog-header">
              <strong>{messages.settings}</strong>
              <button autoFocus type="button" className="guild-soft-button" onClick={() => setSettingsOpen(false)}>{messages.closeDialog}</button>
            </div>
            <div className="guild-dialog-body">
              <div className="guild-dialog-tabs" role="tablist">
                {([
                  ["general", messages.settingsGeneral],
                  ["engines", messages.settingsEngines],
                  ["sources", messages.settingsModelSources],
                  ["privacy", messages.settingsPrivacy],
                  ["about", messages.settingsAbout],
                ] as const).map(([tab, label]) => (
                  <button
                    key={tab}
                    id={`guild-settings-tab-${tab}`}
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === tab}
                    aria-controls={`guild-settings-panel-${tab}`}
                    tabIndex={settingsTab === tab ? 0 : -1}
                    className={settingsTab === tab ? "selected" : ""}
                    onClick={() => setSettingsTab(tab)}
                    onKeyDown={(event) => moveSettingsTabFocus(event, tab, setSettingsTab)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {settingsTab === "general" && (
                <div id="guild-settings-panel-general" role="tabpanel" aria-labelledby="guild-settings-tab-general" className="guild-settings-panel">
                  <p className="guild-setting-scope"><Info size={13} />{messages.localSettingScope}</p>
                  <AppearanceSettings value={appearance} onChange={setAppearance} messages={messages} />
                  <div className="guild-setting-label">{messages.language}</div>
                  <div className="guild-segmented">
                    <button className={projection.locale === "zh-CN" ? "selected" : ""} onClick={() => void setLocale("zh-CN")} type="button">简体中文</button>
                    <button className={projection.locale === "en-US" ? "selected" : ""} onClick={() => void setLocale("en-US")} type="button">English</button>
                  </div>
                  <label className="guild-setting-toggle">
                    <span>
                      <strong>{messages.restoreLastTask}</strong>
                      <small className="guild-setting-help">{messages.restoreLastTaskHelp}</small>
                    </span>
                    <button
                      type="button"
                      className={`guild-switch ${projection.generalSettings.restoreLastTask ? "on" : ""}`}
                      aria-label={messages.restoreLastTask} aria-pressed={projection.generalSettings.restoreLastTask}
                      onClick={() => void setGeneralSettings(
                        !projection.generalSettings.restoreLastTask,
                        projection.generalSettings.newTaskWorkspaceMode,
                      )}
                    />
                  </label>
                  <label className="guild-setting-toggle">
                    <span>
                      <strong>{messages.taskNotifications}</strong>
                      <small className="guild-setting-help">{messages.taskNotificationsHelp}</small>
                    </span>
                    <button
                      type="button"
                      className={`guild-switch ${projection.generalSettings.taskNotificationsEnabled ? "on" : ""}`}
                      aria-label={messages.taskNotifications} aria-pressed={projection.generalSettings.taskNotificationsEnabled}
                      onClick={() => void setGeneralSettings(
                        projection.generalSettings.restoreLastTask,
                        projection.generalSettings.newTaskWorkspaceMode,
                        projection.browserSyncEnabled,
                        !projection.generalSettings.taskNotificationsEnabled,
                      )}
                    />
                  </label>
                  <div className="guild-setting-label">{messages.newTaskWorkspace}</div>
                  <div className="guild-segmented">
                    <button
                      type="button"
                      className={projection.generalSettings.newTaskWorkspaceMode === "ask" ? "selected" : ""}
                      onClick={() => void setGeneralSettings(projection.generalSettings.restoreLastTask, "ask")}
                    >
                      {messages.newTaskWorkspaceAsk}
                    </button>
                    <button
                      type="button"
                      className={projection.generalSettings.newTaskWorkspaceMode === "last" ? "selected" : ""}
                      onClick={() => void setGeneralSettings(projection.generalSettings.restoreLastTask, "last")}
                    >
                      {messages.newTaskWorkspaceLast}
                    </button>
                  </div>
                </div>
              )}
              {settingsTab === "engines" && (
                <div id="guild-settings-panel-engines" role="tabpanel" aria-labelledby="guild-settings-tab-engines" className="guild-settings-panel">
                  <h3 className="guild-engine-heading">{baseMessages.settingsGrok}</h3>
                  <p className="guild-setting-scope"><Info size={13} />{messages.currentTaskScope}</p>
                  <label className="guild-setting-field">
                    <span className="guild-setting-label">{messages.model}</span>
                    <select
                      value={projection.runtimeSettings.model ?? ""}
                      disabled={busy}
                      onChange={(event) => {
                        const modelId = event.currentTarget.value;
                        if (modelId === "") {
                          void setRuntimeSettings(null, null, projection.runtimeSettings.permissionMode);
                          return;
                        }
                        const change = selectionAfterModelChange(
                          modelCatalog,
                          modelId,
                          projection.runtimeSettings.reasoningEffort,
                        );
                        void setRuntimeSettings(
                          change.model,
                          change.reasoningEffort,
                          projection.runtimeSettings.permissionMode,
                        );
                      }}
                    >
                      <option value="">{messages.runtimeDefaultOption}</option>
                      {globalDefault.unlistedModelId !== undefined && (
                        <option value={globalDefault.unlistedModelId}>{globalDefault.unlistedModelId}</option>
                      )}
                      {modelCatalog.models.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="guild-setting-field">
                    <span className="guild-setting-label">{messages.reasoningEffort}</span>
                    <select
                      value={globalDefault.effortId ?? ""}
                      disabled={busy || globalDefault.efforts.length === 0}
                      onChange={(event) => void setRuntimeSettings(
                        projection.runtimeSettings.model,
                        event.currentTarget.value,
                        projection.runtimeSettings.permissionMode,
                      )}
                    >
                      {globalDefault.efforts.length === 0 && (
                        <option value="">{messages.reasoningFollowsRuntimeDefault}</option>
                      )}
                      {globalDefault.efforts.map((effort) => (
                        <option key={effort.id} value={effort.id}>
                          {messages.reasoningEffortName(effort.id, effort.label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="guild-settings-section">
                    <div className="guild-setting-label">{messages.permissionMode}</div>
                    <p className="guild-setting-help">{baseMessages.permissionHelp}</p>
                    <div className="guild-segmented guild-permission-grid">
                      {projection.runtimeSettings.availablePermissionModes.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={projection.runtimeSettings.permissionMode === mode ? "selected" : ""}
                          disabled={busy || !projection.runtimeSettings.canChange}
                          onClick={() => void setRuntimeSettings(
                            projection.runtimeSettings.model,
                            projection.runtimeSettings.reasoningEffort,
                            mode,
                          )}
                        >
                          {messages.permissionModeName(mode)}
                        </button>
                      ))}
                    </div>
                    <p className="guild-setting-help">{messages.permissionFullAccessHelp}</p>
                  </div>
                  <p className={`guild-setting-help ${projection.runtimeSettings.canChange ? "" : "blocked"}`}>
                    {projection.runtimeSettings.canChange
                      ? messages.runtimeSettingsHelp
                      : messages.runtimeSettingsBusy}
                  </p>
                  <div className="guild-setting-label">{messages.startupBehavior}</div>
                  {([
                    ["webSearchEnabled", messages.webSearch, messages.webSearchHelp],
                    ["planEnabled", messages.planMode, messages.planModeHelp],
                    ["subagentsEnabled", messages.subagents, messages.subagentsHelp],
                  ] as const).map(([key, label, help]) => (
                    <label className="guild-setting-toggle" key={key}>
                      <span><strong>{label}</strong><small className="guild-setting-help">{help}</small></span>
                      <button
                        type="button"
                        className={`guild-switch ${projection.runtimeSettings.startup[key] ? "on" : ""}`}
                        aria-pressed={projection.runtimeSettings.startup[key]}
                        disabled={busy || !projection.runtimeSettings.canChange}
                        onClick={() => void setRuntimeSettings(
                          projection.runtimeSettings.model,
                          projection.runtimeSettings.reasoningEffort,
                          projection.runtimeSettings.permissionMode,
                          Object.freeze({
                            ...projection.runtimeSettings.startup,
                            [key]: !projection.runtimeSettings.startup[key],
                          }),
                        )}
                      />
                    </label>
                  ))}
                  <label className="guild-setting-field">
                    <span className="guild-setting-label">{messages.maxTurns}</span>
                    <select
                      value={projection.runtimeSettings.startup.maxTurns ?? ""}
                      disabled={busy || !projection.runtimeSettings.canChange}
                      onChange={(event) => void setRuntimeSettings(
                        projection.runtimeSettings.model,
                        projection.runtimeSettings.reasoningEffort,
                        projection.runtimeSettings.permissionMode,
                        Object.freeze({
                          ...projection.runtimeSettings.startup,
                          maxTurns: event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
                        }),
                      )}
                    >
                      <option value="">{messages.unlimited}</option>
                      {[32, 64, 128, 256, 512, 1_000].map((turns) => <option key={turns} value={turns}>{turns}</option>)}
                    </select>
                  </label>
                  <div className="guild-runtime-capabilities">
                    <div className="guild-setting-label">{messages.officialSessionCapabilities}</div>
                    {activeTask === undefined ? (
                      <p className="guild-setting-help">{messages.startTaskForCapabilities}</p>
                    ) : activeEngine !== "grok" ? (
                      <p className="guild-setting-help">{messages.grokToolsGrokOnly}</p>
                    ) : (
                      <>
                        {activeTask.sessionModes !== null && (
                          <div className="guild-capability-row"><span>{messages.sessionModes}</span><strong>{activeTask.sessionModes.availableModes.map((mode) => mode.name).join(" · ")}</strong></div>
                        )}
                        {activeTask.sessionConfigOptions
                          .filter((option) => option.category !== "model" && option.category !== "thought_level")
                          .map((option) => (
                            <label className="guild-capability-row" key={option.id}>
                              <span>{option.name}{option.description !== undefined && option.description !== null && <small>{option.description}</small>}</span>
                              {option.type === "boolean" ? (
                                <button
                                  type="button"
                                  className={`guild-switch ${option.currentValue ? "on" : ""}`}
                                  aria-label={option.name} aria-pressed={option.currentValue}
                                  disabled={busy || running}
                                  onClick={() => void setSessionConfigOption(option.id, !option.currentValue)}
                                />
                              ) : (
                                <select value={option.currentValue} disabled={busy || running} onChange={(event) => void setSessionConfigOption(option.id, event.currentTarget.value)}>
                                  {(option.choices.form === "flat" ? option.choices.options : option.choices.groups.flatMap((group) => group.options)).map((choice) => (
                                    <option key={choice.value} value={choice.value}>{choice.name}</option>
                                  ))}
                                </select>
                              )}
                            </label>
                          ))}
                      </>
                    )}
                    <button type="button" className="guild-soft-button guild-open-control-center" disabled={activeEngine !== "grok"} onClick={openGrokControlCenter}>{messages.manageGrokBuild}</button>
                  </div>
                  <div className="guild-settings-section guild-engine-claude">
                    <h3 className="guild-engine-heading" id="guild-engine-claude-heading">{baseMessages.settingsClaude}</h3>
                    <p className="guild-setting-help">{baseMessages.enginesClaudeIntro}</p>
                    {claudeStatus !== undefined && (
                      <p className={`guild-engine-status ${claudeStatus.state}`} role="status">
                        <span>{baseMessages.claudeStatusLabel}</span>
                        <strong>{claudeStatusText(baseMessages, claudeStatus)}</strong>
                      </p>
                    )}
                    {projection.runtimeSettings.claude !== undefined && (() => {
                      const claude = projection.runtimeSettings.claude;
                      return (
                        <>
                          <label className="guild-setting-field">
                            <span className="guild-setting-label">{baseMessages.model}</span>
                            <select
                              value={claude.model ?? ""}
                              disabled={busy}
                              onChange={(event) => {
                                const modelId = event.currentTarget.value;
                                if (modelId === "") {
                                  void setClaudeSettings(null, null, claude.permissionMode);
                                  return;
                                }
                                const change = selectionAfterModelChange(claudeDefaults.catalog, modelId, claude.reasoningEffort);
                                void setClaudeSettings(change.model, change.reasoningEffort, claude.permissionMode);
                              }}
                            >
                              <option value="">{baseMessages.claudeDefaultModelOption}</option>
                              {claudeDefaults.unlistedModelId !== undefined && (
                                <option value={claudeDefaults.unlistedModelId}>{claudeDefaults.unlistedModelId}</option>
                              )}
                              {claudeDefaults.models.map((model) => (
                                <option key={model.id} value={model.id}>{model.name}</option>
                              ))}
                            </select>
                          </label>
                          <label className="guild-setting-field">
                            <span className="guild-setting-label">{baseMessages.reasoningEffort}</span>
                            <select
                              value={claudeDefaults.effortId ?? ""}
                              disabled={busy || claudeDefaults.efforts.length === 0}
                              onChange={(event) => void setClaudeSettings(claude.model, event.currentTarget.value, claude.permissionMode)}
                            >
                              {claudeDefaults.efforts.length === 0 && (
                                <option value="">{baseMessages.reasoningFollowsRuntimeDefault}</option>
                              )}
                              {claudeDefaults.efforts.map((effort) => (
                                <option key={effort.id} value={effort.id}>
                                  {baseMessages.reasoningEffortName(effort.id, effort.label)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="guild-settings-section">
                            <div className="guild-setting-label" id="guild-claude-mode-label">{baseMessages.permissionMode}</div>
                            <div className="guild-claude-modes" role="radiogroup" aria-labelledby="guild-claude-mode-label">
                              {claude.availablePermissionModes.map((mode) => (
                                <button
                                  key={mode}
                                  type="button"
                                  role="radio"
                                  aria-checked={claude.permissionMode === mode}
                                  className={`guild-claude-mode${claude.permissionMode === mode ? " selected" : ""}${mode === "bypassPermissions" ? " warn" : ""}`}
                                  disabled={busy}
                                  onClick={() => void setClaudeSettings(claude.model, claude.reasoningEffort, mode)}
                                >
                                  <strong>{baseMessages.claudePermissionModeName(mode)}</strong>
                                  <small>{baseMessages.claudePermissionModeHelp(mode)}</small>
                                </button>
                              ))}
                            </div>
                          </div>
                          <p className="guild-setting-help">{baseMessages.claudeSettingsHelp}</p>
                          {claudeSettingsFailed && <p className="guild-setting-help blocked" role="alert">{baseMessages.claudeSettingsFailed}</p>}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
              {settingsTab === "sources" && (
                <div id="guild-settings-panel-sources" role="tabpanel" aria-labelledby="guild-settings-tab-sources" className="guild-settings-panel">
                  <ModelSourcesSettings messages={baseMessages} api={api} onChanged={() => void refreshRuntimeSettings()} />
                </div>
              )}
              {settingsTab === "privacy" && (
                <div id="guild-settings-panel-privacy" role="tabpanel" aria-labelledby="guild-settings-tab-privacy" className="guild-settings-panel">

                  <p className="guild-setting-help">{messages.privacyBrowserSyncOff}</p>
                  <OnlineReminderSetting messages={baseMessages} api={api} workspaceId={activeTask?.task.workspaceId} />
                  <div className="guild-settings-section guild-local-data-controls">
                    <div>
                      <strong>{messages.localData}</strong>
                      <p className="guild-setting-help">{messages.localDataHelp}</p>
                    </div>
                    <button type="button" className="guild-soft-button" onClick={() => void api.openUserData({})}>{messages.openDataDirectory}</button>
                    <button type="button" className="guild-soft-button" disabled={backupStatus === "saving"} onClick={() => void backupUserData()}>
                      {backupStatus === "saving" ? messages.backupSaving : messages.backupData}
                    </button>
                    <p className="guild-setting-help">{messages.backupRestoreHelp}</p>
                    <button type="button" className="guild-soft-button" disabled={busy || backupStatus === "saving" ||
                      restoreStatus === "restoring" || restoreStatus === "restarting"} onClick={() => {
                        setRestoreStatus("restoring");
                        void persistCurrentDraft().then(() => api.restoreUserData({})).then((result) => {
                          setRestoreStatus(result.status === "cancelled" ? "idle" : "restarting");
                        }, () => setRestoreStatus("failed"));
                      }}>{restoreStatus === "restoring" ? messages.backupRestoring : messages.backupRestore}</button>
                    {restoreStatus === "failed" && <p className="guild-setting-help blocked" role="alert">{messages.backupRestoreFailed}</p>}
                    {restoreStatus === "restarting" && <p className="guild-setting-help" role="status">{messages.backupRestored}</p>}
                    {backupStatus === "saved" && <p className="guild-setting-help success">{messages.backupSaved}</p>}
                    {backupStatus === "failed" && <p className="guild-setting-help blocked">{messages.backupFailed}</p>}
                    <button type="button" className="guild-soft-button" onClick={() => void api.openRuntimeDiagnostics({})}>{messages.openRuntimeDiagnostics}</button>
                  </div>
                </div>
              )}
              {settingsTab === "about" && (
                <div id="guild-settings-panel-about" role="tabpanel" aria-labelledby="guild-settings-tab-about" className="guild-settings-panel guild-about-block">
                  <strong>{messages.appName}</strong>
                  <div className="guild-account-meta"><span>{messages.version}</span><span>{projection.appVersion}</span></div>
                  {projection.runtimeVersion !== undefined && (
                    <div className="guild-account-meta"><span>Grok</span><span>{projection.runtimeVersion}</span></div>
                  )}
                  {claudeStatus?.version !== undefined && (
                    <div className="guild-account-meta"><span>Claude Code</span><span>{claudeStatus.version}</span></div>
                  )}
                  <p>{baseMessages.aboutRole}</p>
                  <p>{baseMessages.aboutCopyright}</p>
                  <p className="guild-independent">{baseMessages.independentNotice}</p>
                  <button type="button" className="guild-soft-button" onClick={() => void api.openUserData({})}>{messages.openDataDirectory}</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {profileOpen && (
        <div className="guild-dialog-backdrop" role="presentation" onPointerDown={() => requestCloseProfile()}>
          <div className="guild-dialog guild-dialog-account" role="dialog" aria-modal="true" aria-label={messages.editProfile} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => handleDialogKeyDown(event, requestCloseProfile)}>
            <div className="guild-dialog-header">
              <strong>{messages.editProfile}</strong>
              <button type="button" className="guild-soft-button" onClick={() => requestCloseProfile()}>{messages.closeDialog}</button>
            </div>
            <div className="guild-dialog-body">
              <div className="guild-profile-editor">
                <AvatarMark
                  className="guild-avatar-preview"
                  nickname={profileNickname || projection.profile.nickname}
                  grantUrl={
                    profileAvatar.type === "preview"
                      ? profileAvatar.grantUrl
                      : profileAvatar.type === "reset"
                        ? undefined
                        : projection.profile.avatarGrantUrl
                  }
                />
                <div className="guild-avatar-actions">
                  <button type="button" onClick={() => void chooseAvatar()}>{messages.changeAvatar}</button>
                  <button type="button" onClick={() => setProfileAvatar({ type: "reset" })}>{messages.resetAvatar}</button>
                </div>
                <label className="guild-setting-field">
                  <span className="guild-setting-label">{messages.nickname}</span>
                  <input
                    autoFocus
                    className="guild-nickname-field"
                    value={profileNickname}
                    maxLength={64}
                    onChange={(event) => {
                      setProfileNickname(event.currentTarget.value);
                      setProfileError(undefined);
                    }}
                  />
                  <small className="guild-setting-help">{messages.nicknameHelp}</small>
                </label>
                {profileError !== undefined && <p className="guild-field-error">{profileError}</p>}
              </div>
            </div>
            <div className="guild-dialog-footer">
              <button type="button" onClick={() => requestCloseProfile()}>{messages.cancel}</button>
              <button type="button" className="primary" disabled={busy} onClick={() => void saveProfile()}>{messages.save}</button>
            </div>
          </div>
        </div>
      )}

      {onlineReminder !== undefined && (
        <OnlineReminderDialog
          messages={baseMessages}
          vendorLabel={onlineReminder.vendorLabel}
          onCancel={() => onlineReminderAnswer.current?.({ confirmed: false, dontRemindAgain: false })}
          onSwitch={(dontRemindAgain) => onlineReminderAnswer.current?.({ confirmed: true, dontRemindAgain })}
          onDialogKeyDown={handleDialogKeyDown}
        />
      )}

      {rewindTarget !== undefined && activeTask !== undefined && (
        <RewindDialog
          key={`${activeTask.task.taskId}:${rewindTarget.runId}`}
          taskId={activeTask.task.taskId}
          runId={rewindTarget.runId}
          messages={messages}
          preview={() => api.previewRewind({ taskId: activeTask.task.taskId, runId: rewindTarget.runId })}
          execute={executeRewind}
          onRolledBack={(result) => void adoptRewoundTask(result)}
          onClose={closeRewindDialog}
          onDialogKeyDown={handleDialogKeyDown}
        />
      )}

      {discardConfirm && (
        <div className="guild-dialog-backdrop" role="presentation" onPointerDown={() => setDiscardConfirm(false)}>
          <div className="guild-confirm-card" role="alertdialog" aria-modal="true" aria-label={messages.discardChanges} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => handleDialogKeyDown(event, () => setDiscardConfirm(false))}>
            <strong>{messages.discardChanges}</strong>
            <p>{messages.discardChangesBody}</p>
            <div className="guild-confirm-actions">
              <button autoFocus type="button" onClick={() => setDiscardConfirm(false)}>{messages.keepEditing}</button>
              <button type="button" className="primary" onClick={() => {
                setDiscardConfirm(false);
                setProfileOpen(false);
              }}>{messages.discard}</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </StreamOverlayContext.Provider>
  );
}

function AvatarMark({
  nickname,
  grantUrl,
  className,
}: {
  readonly nickname: string;
  readonly grantUrl?: string;
  readonly className?: string;
}) {
  const classes = className === undefined ? "guild-avatar" : `guild-avatar ${className}`;
  if (isAllowedTimelineMediaUrl(grantUrl)) {
    return <span className={classes}><img src={grantUrl} alt="" /></span>;
  }
  return <span className={classes} aria-hidden="true">{nicknameInitial(nickname)}</span>;
}

const PROMPT_ATTACHMENTS_STORAGE_PREFIX = "guild.prompt-attachments.v1.";

function readPromptAttachments(storage: Storage, taskId: string): readonly PromptAttachment[] {
  try {
    const raw = storage.getItem(`${PROMPT_ATTACHMENTS_STORAGE_PREFIX}${taskId}`);
    if (raw === null) return Object.freeze([]);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return Object.freeze([]);
    const attachments = parsed.slice(0, 8).flatMap((value): PromptAttachment[] => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      if (
        typeof record["relativePath"] !== "string" ||
        typeof record["name"] !== "string" ||
        typeof record["size"] !== "number" ||
        !Number.isSafeInteger(record["size"]) ||
        record["size"] < 0 ||
        record["size"] > 10 * 1024 * 1024
      ) return [];
      const mimeType = typeof record["mimeType"] === "string" ? record["mimeType"] : undefined;
      return [Object.freeze({
        relativePath: record["relativePath"],
        name: record["name"],
        size: record["size"],
        ...(mimeType === undefined ? {} : { mimeType }),
      })];
    });
    return Object.freeze(attachments);
  } catch {
    return Object.freeze([]);
  }
}

function writePromptAttachments(
  storage: Storage,
  taskId: string,
  attachments: readonly PromptAttachment[],
): void {
  const key = `${PROMPT_ATTACHMENTS_STORAGE_PREFIX}${taskId}`;
  if (attachments.length === 0) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(attachments));
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>, onEscape: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onEscape();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0 && element.closest("[inert]") === null);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function moveSettingsTabFocus(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  currentTab: SettingsTab,
  selectTab: (tab: SettingsTab) => void,
) {
  let nextIndex: number | undefined;
  const currentIndex = SETTINGS_TABS.indexOf(currentTab);
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = SETTINGS_TABS.length - 1;
  }
  if (nextIndex === undefined) return;
  event.preventDefault();
  const nextTab = SETTINGS_TABS[nextIndex]!;
  selectTab(nextTab);
  queueMicrotask(() => document.getElementById(`guild-settings-tab-${nextTab}`)?.focus());
}

/** The sidebar row follows a task whose own summary changed (for example its engine) without waiting for the next pushed projection. */
function withTaskSummary(projection: DesktopBootstrapProjection, summary: TaskSummaryProjection): DesktopBootstrapProjection {
  return {
    ...projection,
    workspaces: projection.workspaces.map((workspace) => workspace.workspaceId !== summary.workspaceId
      ? workspace
      : { ...workspace, tasks: workspace.tasks.map((task) => task.taskId === summary.taskId ? summary : task) }),
  };
}

function isLiveRunState(state: TaskSummaryProjection["activeRunState"] | undefined): boolean {
  return state !== undefined && !["completed", "failed", "cancelled", "interrupted"].includes(state);
}

function isTaskManagementBlocked(task: TaskSummaryProjection): boolean {
  return isLiveRunState(task.activeRunState) || (task.queuedTurnCount ?? 0) > 0;
}

export const WorkspaceTree = memo(function WorkspaceTree({ workspace, expanded, activeTaskId, pendingTaskIds, unreadTaskIds, engineMarkers = false, locale, onToggle, onOpenTask, onNewTask, onPinTask, onArchiveTask, onContextMenu }: {
  readonly workspace: WorkspaceProjection;
  readonly expanded: boolean;
  readonly activeTaskId?: string;
  readonly pendingTaskIds: ReadonlySet<string>;
  readonly unreadTaskIds: ReadonlySet<string>;
  /** True while both engines are in use: every row then carries its engine's monogram. */
  readonly engineMarkers?: boolean;
  readonly locale: GuildLocale;
  readonly onToggle: (workspaceId: WorkspaceProjection["workspaceId"]) => void;
  readonly onOpenTask: (taskId: TaskSummaryProjection["taskId"]) => void;
  readonly onNewTask: (workspaceId: WorkspaceProjection["workspaceId"]) => void;
  readonly onPinTask: (task: TaskSummaryProjection) => void;
  readonly onArchiveTask: (task: TaskSummaryProjection) => void;
  readonly onContextMenu: (event: ReactMouseEvent, menu: ContextMenuSeed) => void;
}) {
  const messages = messagesFor(locale);
  const collapsedStatus = expanded
    ? "idle"
    : workspaceTaskStatus(workspace.tasks) === "idle" && workspace.tasks.some((task) => unreadTaskIds.has(task.taskId))
      ? "fresh"
      : workspaceTaskStatus(workspace.tasks);
  return (
    <div className="guild-workspace-tree">
      <div className="guild-workspace-row" onContextMenu={(event) => onContextMenu(event, { type: "workspace", workspace })}>
        <button className="guild-workspace-main" type="button" onClick={() => onToggle(workspace.workspaceId)} aria-expanded={expanded}>
          <CaretDown size={12} className="guild-workspace-chev" aria-hidden="true" />
          <FolderSimple size={16} className="guild-workspace-icon" aria-hidden="true" />
          <span className="guild-workspace-name">{workspace.name}</span>
          <small className="guild-workspace-count">
            {collapsedStatus !== "idle" && (
              <span className={`guild-task-state ${collapsedStatus}`} aria-hidden="true">
                <TaskStatusGlyph status={collapsedStatus} />
              </span>
            )}
            {workspace.tasks.length}
          </small>
        </button>
        <button className="guild-row-add" type="button" aria-label={messagesFor(locale).newTask} title={messagesFor(locale).newTask} onClick={() => onNewTask(workspace.workspaceId)}><Plus size={14} /></button>
      </div>
      {expanded && (
        <div className="guild-task-list">
          {workspace.tasks.map((task) => {
            const baseStatus = sidebarTaskStatus(task);
            const status = baseStatus === "idle" && unreadTaskIds.has(task.taskId) ? "fresh" : baseStatus;
            const managementBlocked = isTaskManagementBlocked(task) || pendingTaskIds.has(task.taskId);
            return (
            <div
              key={task.taskId}
              className={`guild-task-row-wrap ${task.taskId === activeTaskId ? "active" : ""}`}
              onContextMenu={(event) => onContextMenu(event, { type: "task", task })}
            >
              <button
                className={`guild-task-row ${task.taskId === activeTaskId ? "active" : ""}`}
                type="button"
                onClick={() => onOpenTask(task.taskId)}
              >
                <span className={`guild-task-state ${status}`} title={status === "idle" && task.worktreeStatus !== undefined ? worktreeMessagesFor(locale).sidebarTitle(task.worktreeStatus) : taskStatusTitle(status, task, messages)}>
                  {status === "idle" && task.worktreeStatus !== undefined
                    ? <WorktreeGlyph status={task.worktreeStatus} messages={worktreeMessagesFor(locale)} />
                    : <TaskStatusGlyph status={status} />}
                  {status !== "idle" && <span className="guild-sr-only">{taskStatusTitle(status, task, messages)}</span>}
                </span>
                <span className="guild-task-title">{task.title}</span>
                <span className="guild-task-trailing">
                  {task.pinned && (
                    <span className="guild-task-pin" title={messages.pinned}>
                      <PushPinSimple size={11} weight="fill" />
                    </span>
                  )}
                  {engineMarkers && (
                    <span className={`guild-task-engine ${taskEngineOf(task)}`} title={messages.taskEngineMarkerTitle(taskEngineOf(task))}>
                      <span aria-hidden="true">{messages.taskEngineName(taskEngineOf(task)).charAt(0)}</span>
                      <span className="guild-sr-only">{messages.taskEngineMarkerTitle(taskEngineOf(task))}</span>
                    </span>
                  )}
                  {status === "running"
                    ? <span className="guild-task-live-label run">{task.activeRunState === "cancel_requested"
                        ? messages.commandStopping
                        : task.activeRunState === "queued" ? messages.runPhaseQueued(undefined) : messages.taskStatusRunning}</span>
                    : status === "permission"
                      ? <span className="guild-task-live-label wait">{messages.taskMetaPermission}</span>
                      : status === "queued"
                        ? <span className="guild-task-live-label">{messages.taskStatusQueued(task.queuedTurnCount ?? 1)}</span>
                        : <time>{shortTime(task.updatedAtMs, locale)}</time>}
                </span>
              </button>
              <span className="guild-task-hover-actions" aria-label={messages.conversation}>
                <button
                  className="guild-task-hover-action"
                  type="button"
                  disabled={managementBlocked}
                  aria-label={task.pinned ? messages.unpin : messages.pin}
                  title={task.pinned ? messages.unpin : messages.pin}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPinTask(task);
                  }}
                >
                  {task.pinned
                    ? <PushPinSimpleSlash size={14} />
                    : <PushPinSimple size={14} />}
                </button>
                <button
                  className="guild-task-hover-action"
                  type="button"
                  disabled={managementBlocked}
                  aria-label={messages.archive}
                  title={messages.archive}
                  onClick={(event) => {
                    event.stopPropagation();
                    onArchiveTask(task);
                  }}
                >
                  <Archive size={14} />
                </button>
              </span>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

/**
 * One small mark per task state, drawn by CSS from the parent's status class: a spinning ring
 * while running, an amber dot when it waits for the user, a red dot after a failure or
 * interruption, and a neutral dot otherwise. The blue "new result" dot is `.fresh`; the
 * projection carries no unread flag yet, so nothing renders it today.
 */
function TaskStatusGlyph({ status }: { readonly status: SidebarTaskStatus | "fresh" }) {
  return <i className={`guild-status-mark ${status}`} aria-hidden="true" />;
}

function taskStatusTitle(
  status: SidebarTaskStatus | "fresh",
  task: TaskSummaryProjection,
  messages: ReturnType<typeof messagesFor>,
): string {
  const base = status === "running"
    ? task.activeActivity === undefined ? messages.taskStatusRunning : messages.activeActivity(task.activeActivity)
    : status === "queued" ? messages.taskStatusQueued(task.queuedTurnCount ?? 1)
      : status === "permission" ? messages.taskStatusPermission
        : status === "failed" ? messages.taskStatusFailed
          : status === "interrupted" ? messages.taskStatusInterrupted
            : status === "cancelled" ? messages.taskStatusCancelled
              : status === "fresh" ? messages.taskMetaUnread
                : messages.conversation;
  if (status === "queued" || (task.queuedTurnCount ?? 0) === 0) return base;
  return `${base} · ${messages.taskStatusQueued(task.queuedTurnCount ?? 0)}`;
}

function Welcome({ messages, hasWorkspace, onChoose, onCreate }: {
  readonly messages: ReturnType<typeof messagesFor>;
  readonly hasWorkspace: boolean;
  readonly onChoose: () => void;
  readonly onCreate: () => void;
}) {
  return (
    <div className="guild-empty-task">
      <GuildHero messages={messages} help={hasWorkspace ? messages.welcomeBody : messages.noWorkspaceBody} />
      <button type="button" className="guild-welcome-action" onClick={hasWorkspace ? onCreate : onChoose}><FolderOpen size={17} />{hasWorkspace ? messages.newTask : messages.chooseWorkspace}</button>
    </div>
  );
}

type TimelineHandlers = Readonly<{
  onOpenExternal: (url: string) => void;
  onPermissionDecision: (
    item: Extract<TimelineItemProjection, { readonly kind: "permission" }>,
    decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
  ) => Promise<void>;
  onBranch: (item: TimelineItemProjection) => Promise<void>;
  onRetryToDraft: (item: TimelineItemProjection) => void;
  onOpenRuntimeDiagnostics: () => void;
  /** Opens the workbench diff of a run, on one file when a path is given (F2). */
  onViewRunDiff?: (runId: RunId, path?: string) => void;
  /** Opens the rewind dialog for a run; `trigger` gets focus back when it is cancelled (F2). */
  onRewind?: (runId: RunId, trigger: HTMLElement) => void;
}>;

type TimelineProps = {
  readonly items: readonly TimelineItemProjection[];
  readonly pendingUserText?: string;
  readonly runStatus?: VisibleRunStatus;
  /** Phase of the running turn; replaces the legacy status line while present. */
  readonly runPhase?: RunPhaseProjection;
  readonly locale: GuildLocale;
  /** Engine of the task: the connecting and waiting lines name it. Grok when absent. */
  readonly engine?: GuildEngine;
  readonly recentResult?: TaskViewProjection["recentResult"];
  readonly continuousTask?: TaskViewProjection["continuousTask"];
  /** Changed-file summaries of the runs in the loaded window; each finished run with changes gets a card. */
  readonly runCheckpoints?: readonly RunCheckpointProjection[];
  readonly rewind?: RewindAvailabilityProjection;
  /** The model each run of the window started on, by display name; a run without a record is absent. */
  readonly runModels?: readonly RunModelProjection[];
  readonly highlightedSequence?: number;
  /** A run is live: its turn is not finished, so it shows no duration yet. */
  readonly running: boolean;
} & TimelineHandlers;

/** The newest groups always render fully so growth and scrolling at the bottom stay exact. */
const LIVE_TAIL_GROUPS = 3;

export const Timeline = memo(function Timeline({ items, pendingUserText, runStatus, runPhase, locale, engine = "grok", recentResult, continuousTask, runCheckpoints, rewind, runModels, highlightedSequence, running, onOpenExternal, onPermissionDecision, onBranch, onRetryToDraft, onOpenRuntimeDiagnostics, onViewRunDiff, onRewind }: TimelineProps) {
  const messages = messagesFor(locale, engine);
  const groups = useMemo(() => groupTimeline(items), [items]);
  const handlers = useMemo(() => Object.freeze({
    onOpenExternal, onPermissionDecision, onBranch, onRetryToDraft, onOpenRuntimeDiagnostics, onViewRunDiff, onRewind,
  }), [onOpenExternal, onPermissionDecision, onBranch, onRetryToDraft, onOpenRuntimeDiagnostics, onViewRunDiff, onRewind]);
  // A finished run's card hangs under its last answer. The data objects keep their identity while their
  // inputs do, so streaming into a later run does not re-render the cards above it.
  const cardCache = useRef(new Map<string, RunCardData>());
  const liveRunId = running ? items.findLast((item) => item.runId !== undefined)?.runId : undefined;
  const cards = useMemo(() => {
    const next = new Map<string, RunCardData>();
    for (const [entryId, checkpoint] of cardAnchors(items, runCheckpoints)) {
      if (checkpoint.runId === liveRunId) continue;
      const cached = cardCache.current.get(checkpoint.runId);
      const data = cached !== undefined && cached.checkpoint === checkpoint && cached.rewind === rewind
        ? cached
        : Object.freeze({ checkpoint, rewind });
      cardCache.current.set(checkpoint.runId, data);
      next.set(entryId, data);
    }
    return next;
  }, [items, runCheckpoints, rewind, liveRunId]);
  const completionSequence = continuousTask?.lastRunId !== undefined &&
    ["completed", "stopped"].includes(continuousTask.status)
    ? items.findLast((item) => item.runId === continuousTask.lastRunId)?.sequence : undefined;
  const settledBefore = groups.length - LIVE_TAIL_GROUPS;
  // "Took 4 min" belongs under the last answer of a finished turn; the newest answer keeps its footer visible.
  const turnTook = useMemo(() => {
    const durations = new Map(turnDurationsByRun(items));
    // While a run is live its turn is unfinished, whatever the item flags say.
    if (running) {
      const liveRunId = items.findLast((item) => item.runId !== undefined)?.runId;
      if (liveRunId !== undefined) durations.delete(liveRunId);
    }
    const lastAnswerOfRun = new Map<string, string>();
    for (const item of items) {
      if (item.kind === "assistant" && item.runId !== undefined) lastAnswerOfRun.set(item.runId, item.entryId);
    }
    const labels = new Map<string, string>();
    for (const [runId, entryId] of lastAnswerOfRun) {
      const milliseconds = durations.get(runId);
      if (milliseconds !== undefined) {
        labels.set(entryId, messages.turnTook(messages.runDuration(Math.round(milliseconds / 1000))));
      }
    }
    return labels;
  }, [items, messages, running]);
  // The model that answered goes in the same footer, for a finished turn only (the live one is still being answered).
  const modelOfRun = useMemo(() => new Map((runModels ?? []).map((entry) => [entry.runId as string, entry.label])), [runModels]);
  const turnModel = useMemo(() => {
    const lastAnswerOfRun = new Map<string, string>();
    for (const item of items) {
      if (item.kind === "assistant" && item.runId !== undefined) lastAnswerOfRun.set(item.runId, item.entryId);
    }
    const labels = new Map<string, string>();
    for (const [runId, entryId] of lastAnswerOfRun) {
      const label = runId === liveRunId ? undefined : modelOfRun.get(runId);
      if (label !== undefined) labels.set(entryId, label);
    }
    return labels;
  }, [items, modelOfRun, liveRunId]);
  const lastAnswerEntryId = useMemo(() => items.findLast((item) => item.kind === "assistant")?.entryId, [items]);
  const segments = useMemo(() => segmentTimeline(groups), [groups]);
  const renderRow = ({ group, index }: TimelineRow) => {
    const entries = groupEntries(group);
    const first = entries[0]!;
    const sequence = first.sequence;
    const single = group.type === "single" ? group.item : undefined;
    return <TimelineGroupRow
      key={first.entryId}
      group={group}
      sequence={sequence}
      highlighted={highlightedSequence === sequence}
      settled={index < settledBefore && entries.every(isSettledTimelineItem)}
      locale={locale}
      engine={engine}
      handlers={handlers}
      lastTurn={single !== undefined && single.entryId === lastAnswerEntryId}
      turnMeta={single === undefined ? undefined : turnTook.get(single.entryId)}
      turnModel={single === undefined ? undefined : turnModel.get(single.entryId)}
      interruptedUser={single?.kind === "notice" && single.noticeType === "session_restored"
        ? [...items].reverse().find((item) =>
            item.sequence < single.sequence && item.kind === "user" && item.status === "interrupted")
        : undefined}
      canRetry={
        single?.kind === "user" &&
        single.runId !== undefined &&
        recentResult !== undefined &&
        single.runId === recentResult?.runId &&
        recentResult.state !== "completed"
      }
      completionTask={continuousTask !== undefined && completionSequence !== undefined &&
        entries.some((item) => item.sequence === completionSequence) ? continuousTask : undefined}
      card={entries.map((entry) => cards.get(entry.entryId)).find((card) => card !== undefined)}
    />;
  };
  return <div className="guild-timeline">{segments.map((segment) => segment.type === "row"
    ? renderRow(segment.row)
    : <RolledBackBlock
        key={`rolled-${segment.firstSequence}`}
        segment={segment}
        messages={messages}
        containsHighlight={segment.rows.some((row) => groupEntries(row.group).some((entry) => entry.sequence === highlightedSequence))}
      >{() => segment.rows.map(renderRow)}</RolledBackBlock>)}{pendingUserText !== undefined && (
    <article className="guild-message guild-message-user guild-message-pending" aria-busy="true">
      <div className="guild-message-body"><MarkdownText text={pendingUserText} locale={locale} onOpenExternal={onOpenExternal} /></div>
      <SpinnerGap size={12} className="guild-spin" aria-label={messages.connectingRuntime} />
    </article>
  )}{runPhase !== undefined
    ? <RunPhaseLine projection={runPhase} locale={locale} engine={engine} />
    : runStatus !== undefined && <RunStatusLine status={runStatus} locale={locale} engine={engine} />}</div>;
}, (previous, next) =>
  previous.items === next.items &&
  previous.pendingUserText === next.pendingUserText &&
  previous.locale === next.locale &&
  previous.engine === next.engine &&
  previous.recentResult === next.recentResult &&
  previous.continuousTask === next.continuousTask &&
  previous.runCheckpoints === next.runCheckpoints &&
  previous.rewind === next.rewind &&
  previous.runModels === next.runModels &&
  previous.highlightedSequence === next.highlightedSequence &&
  previous.running === next.running &&
  previous.onOpenExternal === next.onOpenExternal &&
  previous.onPermissionDecision === next.onPermissionDecision &&
  previous.onBranch === next.onBranch &&
  previous.onRetryToDraft === next.onRetryToDraft &&
  previous.onOpenRuntimeDiagnostics === next.onOpenRuntimeDiagnostics &&
  previous.onViewRunDiff === next.onViewRunDiff &&
  previous.onRewind === next.onRewind &&
  previous.runStatus?.stage === next.runStatus?.stage &&
  previous.runStatus?.startedAtMs === next.runStatus?.startedAtMs &&
  previous.runPhase === next.runPhase);

/** Finished rows can skip layout and paint while off screen (content-visibility: auto). */
function isSettledTimelineItem(item: TimelineItemProjection): boolean {
  if (item.status === "streaming" || item.status === "waiting") return false;
  return !(item.kind === "tool" && (item.toolStatus === "pending" || item.toolStatus === "in_progress"));
}

type TimelineGroupRowProps = {
  readonly group: ReturnType<typeof groupTimeline>[number];
  readonly sequence: number;
  readonly highlighted: boolean;
  readonly settled: boolean;
  readonly locale: GuildLocale;
  readonly engine: GuildEngine;
  readonly handlers: TimelineHandlers;
  /** The newest answer: its footer stays visible instead of waiting for hover. */
  readonly lastTurn: boolean;
  /** Right-aligned footer text for the last answer of a finished turn, such as "Took 4 min 12 s". */
  readonly turnMeta: string | undefined;
  /** Display name of the model that answered that turn, shown before the time. */
  readonly turnModel: string | undefined;
  readonly interruptedUser: TimelineItemProjection | undefined;
  readonly canRetry: boolean;
  readonly completionTask: TaskViewProjection["continuousTask"];
  /** The changed-files card of the run that ends in this row (F2). */
  readonly card: RunCardData | undefined;
};

const TimelineGroupRow = memo(function TimelineGroupRow({ group, sequence, highlighted, settled, locale, engine, handlers, lastTurn, turnMeta, turnModel, interruptedUser, canRetry, completionTask, card }: TimelineGroupRowProps) {
  const className = [
    highlighted ? "guild-timeline-group search-highlight" : "guild-timeline-group",
    settled ? "settled" : "",
  ].filter(Boolean).join(" ");
  return <div
    className={className}
    data-sequence={sequence}
    tabIndex={-1}
    style={settled ? { containIntrinsicBlockSize: `auto ${estimateTimelineGroupHeight(group)}px` } : undefined}
  >
    {group.type === "activity"
      ? <>
          <ActivityGroupView items={group.items} locale={locale} engine={engine} />
          {card !== undefined && <div className="guild-turn-slot"><RunCardView card={card} locale={locale} engine={engine} onViewRunDiff={handlers.onViewRunDiff} onRewind={handlers.onRewind} /></div>}
        </>
      : <TimelineItem
          item={group.item}
          locale={locale}
          engine={engine}
          onOpenExternal={handlers.onOpenExternal}
          onPermissionDecision={handlers.onPermissionDecision}
          onBranch={handlers.onBranch}
          onRetryToDraft={handlers.onRetryToDraft}
          onOpenRuntimeDiagnostics={handlers.onOpenRuntimeDiagnostics}
          interruptedUser={interruptedUser}
          canRetry={canRetry}
          lastTurn={lastTurn}
          turnMeta={turnMeta}
          turnModel={turnModel}
          card={card}
          onViewRunDiff={handlers.onViewRunDiff}
          onRewind={handlers.onRewind}
        />}
    {completionTask !== undefined && <ContinuousCompletionRecord task={completionTask} locale={locale} />}
  </div>;
}, (previous, next) =>
  previous.sequence === next.sequence &&
  previous.highlighted === next.highlighted &&
  previous.settled === next.settled &&
  previous.locale === next.locale &&
  previous.engine === next.engine &&
  previous.handlers === next.handlers &&
  previous.lastTurn === next.lastTurn &&
  previous.turnMeta === next.turnMeta &&
  previous.turnModel === next.turnModel &&
  previous.interruptedUser === next.interruptedUser &&
  previous.canRetry === next.canRetry &&
  previous.completionTask === next.completionTask &&
  previous.card === next.card &&
  sameTimelineGroup(previous.group, next.group));

function sameTimelineGroup(
  previous: TimelineGroupRowProps["group"],
  next: TimelineGroupRowProps["group"],
): boolean {
  if (previous === next) return true;
  if (previous.type === "single" || next.type === "single") {
    return previous.type === "single" && next.type === "single" && previous.item === next.item;
  }
  return previous.items.length === next.items.length &&
    previous.items.every((item, index) => item === next.items[index]);
}

type ThoughtItem = Extract<TimelineItemProjection, { readonly kind: "thought" }>;
type ToolItem = Extract<TimelineItemProjection, { readonly kind: "tool" }>;

/** At most this many tool kinds get their own count in the summary line; the rest are summed. */
const ACTIVITY_STAT_LIMIT = 4;

export const ActivityGroupView = memo(function ActivityGroupView({ items, locale, engine = "grok" }: {
  readonly items: readonly TimelineItemProjection[];
  readonly locale: GuildLocale;
  /** Engine of the task: the tool output notes name its runtime. Grok when absent. */
  readonly engine?: GuildEngine;
}) {
  const messages = messagesFor(locale, engine);
  // Collapsed groups hold no thought text or tool output in the DOM; the body mounts on open.
  const [open, setOpen] = useState(false);
  const thoughts = items.filter((item): item is ThoughtItem => item.kind === "thought");
  const tools = items.filter((item): item is ToolItem => item.kind === "tool");
  // Thought items run one after another, so their times add up.
  const thoughtMs = thoughts.reduce((total, item) => total + Math.max(0, item.elapsedMs), 0);
  const elapsedSeconds = Math.max(1, Math.round(thoughtMs / 1000));
  const state = activityGroupState(items);
  const streaming = state === "streaming";
  const steps = activityStepTotal(items);
  const stateLabel = state === "cancelled" ? messages.cancelledActivity
    : state === "interrupted" ? messages.interruptedActivity
      : state === "failed" ? messages.failedActivity
        : "";
  const title = streaming
    ? steps > 0
      ? messages.activityRunning(steps)
      : thoughtMs > 0
        ? messages.activeActivityFor(streamingActivity(items), elapsedSeconds)
        : messages.activeActivity(streamingActivity(items))
    : state === "completed"
      ? steps > 0 ? messages.activityDone(steps) : messages.thoughtFor(elapsedSeconds)
      : [stateLabel, steps > 0 ? messages.activityStepCount(steps) : ""].filter(Boolean).join(" · ");
  const failedSteps = tools.filter((item) => item.toolStatus === "failed").length;
  const counts = activityToolCounts(items);
  const shown = counts.slice(0, ACTIVITY_STAT_LIMIT);
  const hidden = counts.slice(ACTIVITY_STAT_LIMIT).reduce((total, entry) => total + entry.count, 0);
  // A thought-only group already says how long it thought; the span only adds to a group with steps.
  const durationMs = streaming || steps === 0 ? undefined : activityDurationMs(items);
  return <details
    className={`guild-activity ${state}`}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary onClick={(event) => setOpen(!(event.currentTarget.parentElement as HTMLDetailsElement).open)}>
      <span className="guild-activity-state" aria-hidden="true">{streaming
        ? <span className="guild-mini-spin" />
        : state === "completed"
          ? <Check size={14} weight="bold" />
          : state === "failed"
            ? <WarningCircle size={14} />
            : <Stop size={11} weight="fill" />}</span>
      <b className="guild-activity-title">{title}</b>
      {steps > 0 && (
        <span className="guild-activity-stats">
          {thoughts.length > 0 && <span>{messages.activityKindShort("think")} <b>{messages.runDuration(elapsedSeconds)}</b></span>}
          {shown.map((entry) => <span key={entry.kind}>{messages.activityKindShort(entry.kind)} <b>{entry.count}</b></span>)}
          {hidden > 0 && <span>{messages.activityOtherCount(hidden)}</span>}
          {failedSteps > 0 && <span className="guild-activity-failed">{messages.stepFailed} <b>{failedSteps}</b></span>}
        </span>
      )}
      {durationMs !== undefined && <span className="guild-activity-dur">{messages.runDuration(Math.round(durationMs / 1000))}</span>}
      <CaretRight size={14} className="guild-activity-caret" aria-hidden="true" />
    </summary>
    {open && <div className="guild-activity-body">
      {thoughts.length > 0 && <ThoughtCopy thoughts={thoughts} />}
      {tools.length > 0 && <div className="guild-tool-list">{tools.map((item) => <ToolRow item={item} locale={locale} engine={engine} key={item.entryId} />)}</div>}
    </div>}
  </details>;
}, (previous, next) =>
  previous.locale === next.locale &&
  previous.engine === next.engine &&
  previous.items.length === next.items.length &&
  previous.items.every((item, index) => item === next.items[index]));

function ThoughtCopy({ thoughts }: { readonly thoughts: readonly ThoughtItem[] }) {
  const store = useContext(StreamOverlayContext);
  const subscribe = useCallback(
    (listener: () => void) => store === null ? () => undefined : store.subscribe(listener),
    [store],
  );
  useSyncExternalStore(subscribe, () => store?.getVersion() ?? 0, () => 0);
  const text = thoughts.map((item) => item.status === "streaming"
    ? mergeStreamText(item.text, store?.get(item.entryId))
    : item.text).join(" ");
  return <p className="guild-thought-copy">{text}</p>;
}

function RunStatusLine({ status, locale, engine }: {
  readonly status: VisibleRunStatus;
  readonly locale: GuildLocale;
  readonly engine: GuildEngine;
}) {
  const messages = messagesFor(locale, engine);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [status.stage, status.startedAtMs]);
  const elapsedSeconds = status.startedAtMs <= 0
    ? 0
    : Math.max(0, Math.floor((nowMs - status.startedAtMs) / 1_000));
  const label = status.stage === "queued" ? messages.runQueued
    : status.stage === "preparing" ? messages.runPreparing
      : status.stage === "waiting_for_grok" ? messages.runWaitingForGrok
        : status.stage === "completing" ? messages.commandCompleting
          : status.stage === "awaiting_permission" ? messages.commandAwaitingPermission
            : messages.commandStopping;
  return <div className={`guild-run-status ${status.stage}`}>
    <span className="guild-run-pip" aria-hidden="true" />
    <span className="guild-run-now"><span className="guild-run-label" role="status" aria-live="polite">{label}</span></span>
    <time aria-hidden="true">{messages.runElapsed(elapsedSeconds)}</time>
  </div>;
}

function CommandStatusLine({ status, locale, engine }: {
  readonly status: SlashCommandStatus;
  readonly locale: GuildLocale;
  readonly engine: GuildEngine;
}) {
  const messages = messagesFor(locale, engine);
  const detail = commandStatusText(status, messages);
  const active = !["completed", "failed", "cancelled", "interrupted"].includes(status.runState);
  return <div className={`guild-command-status ${active ? "active" : status.runState}`} role="status" aria-live="polite">
    {active ? <SpinnerGap size={13} className="guild-spin" /> : status.runState === "completed" ? <Check size={13} /> : <Stop size={11} weight="fill" />}
    <code>/{status.commandName}</code>
    <span>{detail}</span>
    {(status.liveToolKinds?.length ?? 0) > 0 && (
      <span className="guild-command-tool-icons" aria-label={status.liveToolKinds!.map(messages.toolKindLabel).join("、")}>
        {status.liveToolKinds!.map((kind) => <ToolKindIcon key={kind} kind={kind} size={13} />)}
      </span>
    )}
  </div>;
}

function commandStatusText(status: SlashCommandStatus, messages: ReturnType<typeof messagesFor>): string {
  switch (status.runState) {
    case "queued":
    case "starting":
      return messages.commandSending;
    case "running":
      if (status.latestToolTitle !== undefined) return messages.commandRunningTool(status.latestToolTitle);
      if (status.liveActivity !== undefined) {
        const activity = messages.activeActivity(status.liveActivity);
        return status.workerCount !== undefined && status.workerCount > 1
          ? messages.auxiliaryWorkers(status.workerCount, activity)
          : activity;
      }
      return status.commandName.toLocaleLowerCase() === "goal" && !status.hasRuntimeActivity
        ? messages.goalPreparing
        : status.hasRuntimeActivity
          ? messages.commandRunning
          : messages.commandWaiting;
    case "awaiting_permission": return messages.commandAwaitingPermission;
    case "completing": return messages.commandCompleting;
    case "cancel_requested": return messages.commandStopping;
    case "completed": return messages.commandCompleted;
    case "failed": return messages.commandFailed;
    case "cancelled": return messages.commandCancelled;
    case "interrupted": return messages.commandInterrupted;
  }
}

function ToolKindIcon({ kind, size }: { readonly kind: AcpToolKind; readonly size: number }) {
  switch (kind) {
    case "read": return <FileText size={size} />;
    case "edit": return <PencilLine size={size} />;
    case "delete": return <Trash size={size} />;
    case "move": return <ArrowsLeftRight size={size} />;
    case "search": return <MagnifyingGlass size={size} />;
    case "execute": return <TerminalWindow size={size} />;
    case "think": return <Brain size={size} />;
    case "fetch": return <Globe size={size} />;
    case "switch_mode": return <ArrowsClockwise size={size} />;
    case "other": return <Wrench size={size} />;
  }
}

export const ToolRow = memo(function ToolRow({ item, locale, engine = "grok" }: {
  readonly item: Extract<TimelineItemProjection, { readonly kind: "tool" }>;
  readonly locale: GuildLocale;
  /** Engine of the task: the terminal-output note names its session. Grok when absent. */
  readonly engine?: GuildEngine;
}) {
  const messages = messagesFor(locale, engine);
  // Tool output can be large; its text is mounted only while the details are open.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const images = item.content.filter(
    (content): content is Extract<(typeof item.content)[number], { readonly type: "media" }> =>
      content.type === "media" && content.mediaType === "image" && isAllowedTimelineMediaUrl(content.grantUrl),
  );
  const details = item.content.filter((content) => content.type !== "media");
  const [previewKey, setPreviewKey] = useState<string>();
  const previewRef = useRef<HTMLElement>(null);
  const previewedImage = images.find((image) => `${image.mediaSha256}:${image.grantUrl}` === previewKey);
  useLayoutEffect(() => {
    if (previewedImage === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      previewRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [previewedImage]);
  const live = item.toolStatus === "pending" || item.toolStatus === "in_progress";
  const durationMs = live ? undefined : itemDurationMs(item);
  const meta = live
    ? item.toolStatus === "pending" ? messages.stepPending : messages.stepRunning
    : item.toolStatus === "failed"
      ? messages.stepFailed
      : durationMs === undefined ? undefined : messages.runDuration(Math.round(durationMs / 1000));
  return <div className={`guild-tool-row ${item.toolStatus}`}>
    <div className="guild-tool-heading">
      <span className="guild-tool-state" aria-hidden="true">{item.toolStatus === "completed"
        ? <Check size={14} weight="bold" />
        : item.toolStatus === "failed"
          ? <X size={13} weight="bold" />
          : <span className="guild-mini-spin" />}</span>
      <span className="guild-tool-kind" title={messages.toolKindLabel(item.toolKind)}>{messages.activityKindShort(item.toolKind)}</span>
      <span className="guild-tool-title" title={item.title}>{item.title}</span>
      <span className="guild-tool-heading-actions">
        {images.map((image) => {
          const key = `${image.mediaSha256}:${image.grantUrl}`;
          return <button
            key={key}
            type="button"
            className="guild-tool-image-button"
            aria-expanded={previewKey === key}
            aria-label={image.alt.trim().length > 0 ? `${messages.viewImage}: ${image.alt}` : messages.viewImage}
            title={image.alt.trim().length > 0 ? `${messages.viewImage}: ${image.alt}` : messages.viewImage}
            onClick={() => setPreviewKey((current) => current === key ? undefined : key)}
          ><ImageSquare size={13} />{messages.viewImage}</button>;
        })}
        {meta !== undefined && <small className="guild-tool-meta">{meta}</small>}
      </span>
    </div>
    {previewedImage !== undefined && <figure ref={previewRef} className="guild-tool-image-preview">
      <ViewableImage src={previewedImage.grantUrl} alt={previewedImage.alt} locale={locale} variant="preview" />
      {previewedImage.alt.trim().length > 0 && <figcaption>{previewedImage.alt}</figcaption>}
    </figure>}
    {details.length > 0 && <details
      className="guild-tool-content"
      onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
    >
      <summary onClick={(event) => setDetailsOpen(!(event.currentTarget.parentElement as HTMLDetailsElement).open)}>{messages.toolDetails}<CaretRight size={12} /></summary>
      {detailsOpen && <div>{details.map((content, index) => {
        if (content.type === "text") return <pre key={index}>{content.text}</pre>;
        if (content.type === "diff") return <section className="guild-tool-diff" key={index}>
          <strong>{messages.fileChange}: {content.path}</strong>
          {content.oldText !== undefined && content.oldText !== null && <><small>{messages.beforeChange}</small><pre>{content.oldText}</pre></>}
          <small>{messages.afterChange}</small><pre>{content.newText}</pre>
        </section>;
        if (content.type === "terminal") return <p key={index}>{messages.terminalOutputUnavailable}</p>;
        return <p key={index}>{messages.unsupportedToolContent(content.contentType)}</p>;
      })}</div>}
    </details>}
  </div>;
});

/** Exported for tests. */
export const TimelineItem = memo(function TimelineItem({ item, locale, engine = "grok", onOpenExternal, onPermissionDecision, onBranch, onRetryToDraft, onOpenRuntimeDiagnostics, interruptedUser, canRetry, lastTurn = false, turnMeta, turnModel, card, onViewRunDiff, onRewind }: {
  readonly item: TimelineItemProjection;
  readonly locale: GuildLocale;
  /** Engine of the task: recovery and Steer notices name its runtime. Grok when absent. */
  readonly engine?: GuildEngine;
  readonly canRetry: boolean;
  readonly lastTurn?: boolean;
  readonly turnMeta?: string;
  /** The model that answered this turn (display name), shown in its footer before the time. */
  readonly turnModel?: string;
  /** The changed-files card to show in this answer's footer when it is its run's last answer (F2). */
  readonly card?: RunCardData;
  readonly onViewRunDiff?: (runId: RunId, path?: string) => void;
  readonly onRewind?: (runId: RunId, trigger: HTMLElement) => void;
  readonly onOpenExternal: (url: string) => void;
  readonly onPermissionDecision: (
    item: Extract<TimelineItemProjection, { readonly kind: "permission" }>,
    decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
  ) => Promise<void>;
  readonly onBranch: (item: TimelineItemProjection) => Promise<void>;
  readonly onRetryToDraft: (item: TimelineItemProjection) => void;
  readonly onOpenRuntimeDiagnostics: () => void;
  readonly interruptedUser?: TimelineItemProjection;
}) {
  const messages = messagesFor(locale, engine);
  if (item.kind === "permission") {
    return <PermissionCard item={item} messages={messages} onDecision={onPermissionDecision} />;
  }
  if (item.kind === "media") {
    if (!isAllowedTimelineMediaUrl(item.grantUrl)) return <span>{item.alt}</span>;
    if (item.mediaType === "image") return <figure className="guild-media"><ViewableImage src={item.grantUrl} alt={item.alt} locale={locale} variant="inline" /><figcaption>{item.alt}</figcaption></figure>;
    if (item.mediaType === "audio") return <audio className="guild-media-player" controls src={item.grantUrl} />;
    if (item.mediaType === "video") return <video className="guild-media-player" controls src={item.grantUrl} />;
    return <a className="guild-document" href={item.grantUrl}>{item.alt}</a>;
  }
  if (item.kind === "tool" || item.kind === "thought") return null;
  if (item.kind === "notice" && item.noticeType === "session_restored") {
    return <article className="guild-runtime-recovery-card" role="alert">
      <WarningCircle size={17} aria-hidden="true" />
      <div className="guild-runtime-recovery-copy">
        <strong>{messages.recoveryNoticeTitle}</strong>
        <span>{messages.recoveryNoticeBody}</span>
        <small><Check size={12} aria-hidden="true" />{messages.recoveryNoticeRestored}</small>
      </div>
      <div className="guild-runtime-recovery-actions">
        {interruptedUser?.kind === "user" && (
          <button type="button" onClick={() => onRetryToDraft(interruptedUser)}>{messages.recoveryRetryAction}</button>
        )}
        <button type="button" onClick={onOpenRuntimeDiagnostics}>{messages.openRuntimeDiagnostics}</button>
      </div>
    </article>;
  }
  // A Steer that the runtime could not take: say so plainly instead of the stored sentence.
  if (item.kind === "notice" && item.interjection?.state === "fallen_back") {
    return <article className="guild-message guild-message-notice guild-message-interjection-notice" role="status">
      <span className="guild-interjection-tag">{messages.interjectionTag}</span>
      <span className="guild-interjection-state fallen_back">{messages.interjectionState("fallen_back")}</span>
      {item.interjection.reason !== undefined
        ? <span>{messages.interjectionReason(item.interjection.reason)}</span>
        : <span>{item.text}</span>}
    </article>;
  }
  const footer = item.kind === "assistant" && item.status === "completed"
    ? continuousFooter(item.text)
    : undefined;
  const body = footer?.body ?? item.text;
  // A streaming answer may already have text in the overlay while its projection is still empty.
  const streamingAssistant = item.kind === "assistant" && item.status === "streaming";
  const interjection = item.kind === "user" ? item.interjection : undefined;
  return <article className={`guild-message guild-message-${item.kind}${interjection === undefined ? "" : " guild-message-interjection"}`}>
    {(body.length > 0 || streamingAssistant) && <div className="guild-message-body"><MessageBody entryId={item.entryId} text={body} streaming={streamingAssistant} locale={locale} onOpenExternal={onOpenExternal} /></div>}
    {interjection !== undefined && <div className="guild-interjection-meta">
      <span className="guild-interjection-tag">{messages.interjectionTag}</span>
      <span className={`guild-interjection-state ${interjection.state}`}>
        {interjection.state === "pending" && <span className="guild-mini-spin" aria-hidden="true" />}
        {messages.interjectionState(interjection.state)}
      </span>
    </div>}
    {footer !== undefined && <ContinuousRoundRecord footer={footer} locale={locale} />}
    {item.kind === "user" && (
      <MessageActions
        item={item}
        messages={messages}
        canRetry={canRetry}
        onBranch={onBranch}
        onRetryToDraft={onRetryToDraft}
      />
    )}
    {item.kind === "assistant" && !streamingAssistant && (
      <TurnFooter
        item={item}
        messages={messages}
        lastTurn={lastTurn}
        meta={turnMeta}
        model={turnModel}
        onBranch={onBranch}
        slot={card === undefined ? undefined : <RunCardView card={card} locale={locale} engine={engine} onViewRunDiff={onViewRunDiff} onRewind={onRewind} />}
      />
    )}
  </article>;
});

/** Hover actions beside a user bubble: copy, branch, and (after a failed turn) put the text back in the draft. */
function MessageActions({ item, messages, canRetry, onBranch, onRetryToDraft }: {
  readonly item: TimelineItemProjection;
  readonly messages: ReturnType<typeof messagesFor>;
  readonly canRetry: boolean;
  readonly onBranch: (item: TimelineItemProjection) => Promise<void>;
  readonly onRetryToDraft: (item: TimelineItemProjection) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (item.kind !== "user" && item.kind !== "assistant") return null;
  return <div className="guild-message-actions" aria-label={messages.messageActions}>
    <button type="button" title={messages.copyMessage} aria-label={messages.copyMessage} onClick={() => {
      void navigator.clipboard.writeText(item.text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      }).catch(() => undefined);
    }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    <button type="button" title={messages.branchMessageHelp} aria-label={messages.branchFromMessage} onClick={() => void onBranch(item)}><GitFork size={14} /></button>
    {canRetry && item.kind === "user" && (
      <button type="button" title={messages.retryToDraftHelp} aria-label={messages.retryToDraft} onClick={() => onRetryToDraft(item)}><ArrowsClockwise size={14} /></button>
    )}
  </div>;
}

const NO_RUN_DIFF = () => undefined;

/** The changed-files card of a run, wired to the timeline's handlers. */
function RunCardView({ card, locale, engine, onViewRunDiff, onRewind }: {
  readonly card: RunCardData;
  readonly locale: GuildLocale;
  /** Engine of the task: the Rewind note names its runtime. */
  readonly engine: GuildEngine;
  readonly onViewRunDiff?: ((runId: RunId, path?: string) => void) | undefined;
  readonly onRewind?: ((runId: RunId, trigger: HTMLElement) => void) | undefined;
}) {
  return <RunChangesCard
    data={card}
    messages={messagesFor(locale, engine)}
    onViewDiff={onViewRunDiff ?? NO_RUN_DIFF}
    onRewind={onRewind ?? NO_RUN_DIFF}
  />;
}

/**
 * The row under a finished answer: copy and branch as labelled ghost buttons (visible on hover and
 * focus, always for the newest answer) with the turn's duration on the right. `slot` holds the
 * per-turn changed-files card (with "rewind to before this turn"); nothing renders there for a
 * turn without file changes, so no placeholder is shown.
 */
function TurnFooter({ item, messages, lastTurn, meta, model, onBranch, slot }: {
  readonly item: TimelineItemProjection;
  readonly messages: ReturnType<typeof messagesFor>;
  readonly lastTurn: boolean;
  readonly meta?: string | undefined;
  /** Display name of the model that answered; one muted line with the time, truncated before the time is. */
  readonly model?: string | undefined;
  readonly onBranch: (item: TimelineItemProjection) => Promise<void>;
  readonly slot?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  if (item.kind !== "assistant") return null;
  return <div className={`guild-turn-footer${lastTurn ? " last" : ""}`}>
    {slot !== undefined && slot !== null && <div className="guild-turn-slot">{slot}</div>}
    <div className="guild-turn-actions" aria-label={messages.messageActions}>
      <button type="button" className="guild-ghost-button" title={messages.copyMessage} onClick={() => {
        void navigator.clipboard.writeText(item.text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }).catch(() => undefined);
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? messages.copiedShort : messages.copyShort}</button>
      <button type="button" className="guild-ghost-button" title={messages.branchMessageHelp} onClick={() => void onBranch(item)}><GitFork size={14} />{messages.branchShort}</button>
      {model === undefined
        ? meta !== undefined && <span className="guild-turn-meta">{meta}</span>
        : <span className="guild-turn-meta">
            <span className="guild-turn-model" title={model}>{model}</span>
            {meta !== undefined && <span className="guild-turn-took">{`${MODEL_PICKER_SEPARATOR}${meta}`}</span>}
          </span>}
    </div>
  </div>;
}

const MarkdownText = memo(function MarkdownText({ text, locale, onOpenExternal }: {
  readonly text: string;
  readonly locale: GuildLocale;
  readonly onOpenExternal: (url: string) => void;
}) {
  return renderText(text, onOpenExternal, locale);
}, (previous, next) => previous.text === next.text && previous.locale === next.locale);

/** Live text overlays for entries that stream; absent in tests that render rows on their own. Exported for tests. */
export const StreamOverlayContext = createContext<StreamOverlayStore | null>(null);

function useStreamOverlayRecord(entryId: string, streaming: boolean): StreamOverlayRecord | undefined {
  const store = useContext(StreamOverlayContext);
  const subscribe = useCallback(
    (listener: () => void) => store === null ? () => undefined : store.subscribe(listener),
    [store],
  );
  const getSnapshot = useCallback(
    () => store === null || !streaming ? undefined : store.get(entryId),
    [store, entryId, streaming],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * One Markdown block of a message. A streaming message re-parses only its last block per frame
 * because earlier blocks are memoized by exact text; a finished message is one block, so its
 * final markup is identical to a single parse of the whole text.
 */
const MarkdownBlock = memo(function MarkdownBlock({ text, whole, locale, onOpenExternal }: {
  readonly text: string;
  readonly whole: boolean;
  readonly locale: GuildLocale;
  readonly onOpenExternal: (url: string) => void;
}) {
  return whole ? renderText(text, onOpenExternal, locale) : renderMarkdown(text, onOpenExternal, locale);
}, (previous, next) =>
  previous.text === next.text && previous.whole === next.whole && previous.locale === next.locale);

export function MessageBody({ entryId, text, streaming, locale, onOpenExternal }: {
  readonly entryId: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly locale: GuildLocale;
  readonly onOpenExternal: (url: string) => void;
}) {
  const overlay = useStreamOverlayRecord(entryId, streaming);
  const splitter = useRef<StreamingMarkdownSplitter>(undefined);
  const liveText = streaming ? mergeStreamText(text, overlay) : text;
  if (!streaming) {
    splitter.current = undefined;
    return <MarkdownBlock key={0} text={liveText} whole locale={locale} onOpenExternal={onOpenExternal} />;
  }
  splitter.current ??= new StreamingMarkdownSplitter();
  const blocks = splitter.current.update(liveText);
  return <>{blocks.map((block, index) => (
    <MarkdownBlock
      key={index}
      text={block}
      whole={blocks.length === 1}
      locale={locale}
      onOpenExternal={onOpenExternal}
    />
  ))}</>;
}

function PermissionCard({ item, messages, onDecision }: {
  readonly item: Extract<TimelineItemProjection, { readonly kind: "permission" }>;
  readonly messages: ReturnType<typeof messagesFor>;
  readonly onDecision: (
    item: Extract<TimelineItemProjection, { readonly kind: "permission" }>,
    decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
  ) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const decide = async (
    decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
  ) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onDecision(item, decision);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return <div className="guild-permission" role="group" aria-label={messages.permissionNeeded} aria-busy={submitting}>
    <div className="guild-permission-head">
      <ShieldWarning size={16} aria-hidden="true" />
      <strong>{messages.permissionNeeded}</strong>
    </div>
    <code className="guild-permission-title">{item.title}</code>
    <div className="guild-permission-actions">
      {item.options.map((option) => {
        const view = permissionOptionView(messages, option);
        return <button
          disabled={submitting}
          type="button"
          key={option.optionId}
          title={view.title}
          className={`${option.kind.startsWith("allow") ? "allow" : "reject"}${option.kind === "allow_once" ? " primary" : ""}`}
          onClick={() => void decide({ type: "selected", optionId: option.optionId })}
        >{view.label}</button>;
      })}
      <button
        disabled={submitting}
        type="button"
        className="dismiss"
        title={messages.permissionStopTurnHelp}
        onClick={() => void decide({ type: "cancelled" })}
      >{messages.permissionStopTurn}</button>
    </div>
  </div>;
}

export function renderText(
  text: string,
  onOpenExternal: (url: string) => void,
  locale: GuildLocale = "en-US",
) {
  if (isBareSymbolReply(text)) return <p>{text}</p>;
  return renderMarkdown(text, onOpenExternal, locale);
}

/** Markdown for one block or one whole message, without the bare-symbol shortcut. */
export function renderMarkdown(
  text: string,
  onOpenExternal: (url: string) => void,
  locale: GuildLocale = "en-US",
) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    urlTransform={(url, key, node) => {
      if (node.tagName === "img" && key === "src" && isAllowedMessageImageUrl(url)) return url;
      if (node.tagName === "a" && key === "href") {
        try {
          return canonicalGuildExternalUrl(url);
        } catch {
          return "";
        }
      }
      return "";
    }}
    components={{
      a: ({ href, children }) => {
        if (href === undefined) return <span>{children}</span>;
        let externalUrl: string;
        try {
          externalUrl = canonicalGuildExternalUrl(href);
        } catch {
          return <span>{children}</span>;
        }
        return <a href={externalUrl} onClick={(event) => {
          event.preventDefault();
          onOpenExternal(externalUrl);
        }}>{children}</a>;
      },
      img: ({ src, alt }) => isAllowedMessageImageUrl(src)
        ? <ViewableImage src={src} alt={alt ?? ""} locale={locale} variant="inline" />
        : <span>{alt ?? ""}</span>,
    }}
  >{text}</ReactMarkdown>;
}

function ViewableImage({ src, alt, locale, variant }: {
  readonly src: string;
  readonly alt: string;
  readonly locale: GuildLocale;
  readonly variant: "inline" | "preview";
}) {
  const messages = messagesFor(locale);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setFullscreenOpen(false);
    window.setTimeout(() => trigger.current?.focus(), 0);
  };
  useEffect(() => {
    if (!fullscreenOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreenOpen]);
  const label = alt.trim().length > 0 ? `${messages.viewImage}: ${alt}` : messages.viewImage;
  return <>
    <button
      ref={trigger}
      type="button"
      className={variant === "preview" ? "guild-tool-image-preview-button" : "guild-inline-image-button"}
      aria-label={label}
      title={label}
      onClick={() => setFullscreenOpen(true)}
    ><img src={src} alt={alt} loading={variant === "preview" ? "eager" : "lazy"} referrerPolicy="no-referrer" /></button>
    {fullscreenOpen && createPortal(
      <div className="guild-image-viewer-backdrop" role="presentation" onPointerDown={close}>
        <div className="guild-image-viewer" role="dialog" aria-modal="true" aria-label={messages.imagePreview} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="guild-image-viewer-close" autoFocus aria-label={messages.closeImage} title={messages.closeImage} onClick={close}><X size={17} /></button>
          <img src={src} alt={alt} referrerPolicy="no-referrer" />
          {alt.trim().length > 0 && <p>{alt}</p>}
        </div>
      </div>,
      document.body,
    )}
  </>;
}

function openContextMenu(event: ReactMouseEvent, menu: ContextMenuSeed, setter: (menu: ContextMenu) => void) {
  event.preventDefault();
  event.stopPropagation();
  setter({
    ...menu,
    ...clampContextMenuPosition(event.clientX, event.clientY, window.innerWidth, window.innerHeight),
  } as ContextMenu);
}

function toggleSet(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  next.has(value) ? next.delete(value) : next.add(value);
  return next;
}

function workspaceName(
  workspaces: readonly WorkspaceProjection[],
  workspaceId: string,
  fallback: string,
): string {
  return workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.name ?? fallback;
}

function clampWorkbenchWidth(width: number): number {
  return Math.max(WORKBENCH_MIN_WIDTH, Math.min(WORKBENCH_MAX_WIDTH, Math.round(width)));
}

function readWorkbenchWidth(storage: Storage): number {
  const raw = Number(storage.getItem(WORKBENCH_WIDTH_STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampWorkbenchWidth(raw) : 340;
}

function readUnreadTasks(storage: Storage): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(storage.getItem(UNREAD_TASKS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string").slice(0, 500))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeUnreadTasks(storage: Storage, unread: ReadonlySet<string>): void {
  try {
    storage.setItem(UNREAD_TASKS_STORAGE_KEY, JSON.stringify([...unread].slice(0, 500)));
  } catch {
    // The mark is a convenience; a full or blocked store only loses it on reload.
  }
}

function writeWorkbenchWidth(storage: Storage, width: number): void {
  storage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(clampWorkbenchWidth(width)));
}

function formatUsageDate(value: string, locale: GuildLocale): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function shortTime(timestamp: number, locale: GuildLocale): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return messagesFor(locale).yesterday;
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date);
}
