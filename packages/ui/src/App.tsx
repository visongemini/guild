import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/ArrowUpRight";
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
import { FileTextIcon as FileText } from "@phosphor-icons/react/FileText";
import { FilesIcon as Files } from "@phosphor-icons/react/Files";
import { GitDiffIcon as GitDiff } from "@phosphor-icons/react/GitDiff";
import { GitForkIcon as GitFork } from "@phosphor-icons/react/GitFork";
import { DownloadSimpleIcon as DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { GearSixIcon as GearSix } from "@phosphor-icons/react/GearSix";
import { GlobeIcon as Globe } from "@phosphor-icons/react/Globe";
import { HandPalmIcon as HandPalm } from "@phosphor-icons/react/HandPalm";
import { HourglassMediumIcon as HourglassMedium } from "@phosphor-icons/react/HourglassMedium";
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
import { StopIcon as Stop } from "@phosphor-icons/react/Stop";
import { TerminalWindowIcon as TerminalWindow } from "@phosphor-icons/react/TerminalWindow";
import { TrashIcon as Trash } from "@phosphor-icons/react/Trash";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/Wrench";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { XIcon as X } from "@phosphor-icons/react/X";
import { XCircleIcon as XCircle } from "@phosphor-icons/react/XCircle";
import type {
  GuildGrokModel,
  GuildGrokPermissionMode,
  GuildGrokReasoningEffort,
  GuildGrokStartupSettings,
  DesktopBootstrapProjection,
  GuildLocale,
  GuildNewTaskWorkspaceMode,
  GuildRendererApi,
  AcpToolKind,
  ConversationSearchResult,
  RuntimeCommand,
  PromptAttachment,
  TaskViewProjection,
  TaskSummaryProjection,
  TimelineItemProjection,
  WorkspaceProjection,
} from "@guild/contracts";
import {
  canonicalGuildExternalUrl,
  nicknameInitial,
  parseGuildNickname,
  supportsGuildGrokReasoningEffort,
} from "@guild/contracts/desktop-ipc";
import {
  memo,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import remarkGfm from "remark-gfm";
import {
  BANNY_DRAG_MIME,
  bannyPlacementFromDrop,
  readBannyPlacement,
  resolveBannySeatTaskId,
  writeBannyPlacement,
  type BannyPlacement,
} from "./banny-seat.js";
import { resolveContextMenuSeed, type ContextMenuSeed } from "./context-menu.js";
import { slashCommandStatus, type SlashCommandStatus } from "./command-status.js";
import { observeExternalComposerInput } from "./composer-external-input.js";
import { contextWindowView } from "./context-window.js";
import {
  isConversationPinnedToBottom,
  mergeTimelineWindows,
  retainTimelineWindow,
  scrollTopAfterPrepend,
  shouldLoadEarlierConversation,
} from "./conversation-scroll.js";
import { messagesFor } from "./locales.js";
import { continuousFooter } from "./continuous-display.js";
import { ContinuousRoundRecord, ContinuousTaskCard, ContinuousCompletionRecord } from "./ContinuousTask.js";
import { GrokControlCenter } from "./GrokControlCenter.js";
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
import { sidebarTaskStatus, workspaceTaskStatus, type SidebarTaskStatus } from "./task-status.js";
import {
  matchingSlashCommands,
  slashCommandCatalogue,
  slashCommandQuery,
  slashCommandText,
} from "./slash-commands.js";
import {
  activityGroupState,
  activityToolKinds,
  groupTimeline,
  isBareSymbolReply,
  streamingActivity,
} from "./timeline.js";
import { promptAttachmentsEqual, shouldClearSubmittedAttachments } from "./composer-submission.js";

const BANNY_ASSET_URL = new URL("./assets/banny.png", import.meta.url).href;
const WORKBENCH_WIDTH_STORAGE_KEY = "guild:v1:workbench-width";
const WORKBENCH_MIN_WIDTH = 280;
const WORKBENCH_MAX_WIDTH = 480;

export type GuildAppProps = {
  readonly api: GuildRendererApi;
};

type ContextMenu =
  | { readonly type: "workspace"; readonly workspace: WorkspaceProjection; readonly x: number; readonly y: number }
  | { readonly type: "task"; readonly task: TaskSummaryProjection; readonly x: number; readonly y: number };

type UiError = "bootstrap" | "message" | "operation" | "recovery" | "runtime" | "workspace";
type SettingsTab = "general" | "grok" | "privacy" | "about";
const SETTINGS_TABS: readonly SettingsTab[] = Object.freeze(["general", "grok", "privacy", "about"]);
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
  const [projection, setProjection] = useState<DesktopBootstrapProjection>();
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
  const [workbenchTab, setWorkbenchTab] = useState<"files" | "review">("files");
  const [workbenchWidth, setWorkbenchWidth] = useState(() => readWorkbenchWidth(window.localStorage));
  const [contextMenu, setContextMenu] = useState<ContextMenu>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renamingTask, setRenamingTask] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState(false);
  const [contextUsageOpen, setContextUsageOpen] = useState(false);
  const [bannyPlacement, setBannyPlacement] = useState<BannyPlacement>(
    () => readBannyPlacement(window.localStorage),
  );
  const [bannyDragging, setBannyDragging] = useState(false);
  const [bannyDropTargetId, setBannyDropTargetId] = useState<string>();
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
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const autoScrollPinned = useRef(true);
  const autoScrollTaskId = useRef<string | undefined>(undefined);
  const seenWorkspaceIds = useRef<Set<string>>(new Set());
  const activeTaskIdRef = useRef<string | undefined>(undefined);
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
  const bannySeatTaskId = useMemo(
    () => resolveBannySeatTaskId(projection?.workspaces ?? [], bannyPlacement),
    [projection?.workspaces, bannyPlacement],
  );

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
    if (projection === undefined || bannyPlacement.kind !== "task" || bannySeatTaskId !== undefined) return;
    const home = Object.freeze({ kind: "home" }) as BannyPlacement;
    setBannyPlacement(home);
    writeBannyPlacement(window.localStorage, home);
  }, [projection, bannyPlacement, bannySeatTaskId]);

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
    let projectionFlushQueued = false;
    let latestProjection: DesktopBootstrapProjection | undefined;
    const unsubscribe = api.onProjectionChanged((next) => {
      latestProjection = next;
      if (projectionFlushQueued) return;
      projectionFlushQueued = true;
      queueMicrotask(() => {
        projectionFlushQueued = false;
        if (!active) return;
        const queued = latestProjection;
        latestProjection = undefined;
        if (queued === undefined) return;
        startTransition(() => {
          setProjection(queued);
          const nextTaskId = queued.activeTask?.task.taskId;
          if (activeTaskIdRef.current !== nextTaskId) {
            activeTaskIdRef.current = nextTaskId;
            setDraft(queued.activeTask?.draft ?? "");
          }
        });
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
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

  useEffect(() => {
    const element = conversation.current;
    const task = projection?.activeTask;
    if (
      element !== null &&
      task !== undefined &&
      shouldLoadEarlierConversation(
        task.hasEarlierTimeline,
        element.scrollTop,
        element.clientHeight,
        element.scrollHeight,
      )
    ) {
      void loadEarlierTimeline();
    }
  }, [projection?.activeTask?.task.taskId, activeTimeline, projection?.activeTask?.hasEarlierTimeline]);

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

  const messages = messagesFor(projection.locale);
  const activeTask = projection.activeTask;
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
  const activeWorkspaces = projection.workspaces
    .filter((workspace) => !workspace.archived)
    .map((workspace) => Object.freeze({
      ...workspace,
      tasks: Object.freeze(workspace.tasks.filter((task) => !task.archived)),
    }));
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
      );
  const contextManagementBlocked = resolvedContextMenu !== undefined && (
    resolvedContextMenu.type === "task"
      ? isTaskManagementBlocked(resolvedContextMenu.task) ||
        pendingSends.has(resolvedContextMenu.task.taskId)
      : resolvedContextMenu.workspace.tasks.some(
          (task) => isTaskManagementBlocked(task) || pendingSends.has(task.taskId),
        )
  );
  const pendingTaskIds = new Set(pendingSends.keys());
  const latestAssistant = [...activeTimeline].reverse().find(
    (item) => item.kind === "assistant" && item.status === "completed",
  );
  const latestAssistantAnnouncement = running
    ? messages.activeActivity(activeTask?.task.activeActivity ?? "working")
    : latestAssistant?.kind === "assistant"
      ? continuousFooter(latestAssistant.text)?.body ?? latestAssistant.text : "";
  const contextWindow = contextWindowView(activeTask?.contextWindow, projection.locale);
  const selectedModel = projection.runtimeSettings.availableModels.find(
    (model) => model.id === projection.runtimeSettings.model,
  ) ?? projection.runtimeSettings.availableModels[0];
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
  const bannyUsesEmptyTaskSlot = bannyPlacement.kind === "home" &&
    activeTask !== undefined &&
    activeTimeline.length === 0 &&
    pendingSendForActive === undefined;
  const bannyFloatsInWindow = bannyPlacement.kind === "free";
  const visibleSlashCommands = slashCommandCatalogue(
    activeTask?.availableCommands ?? Object.freeze([]),
    projection.locale,
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
      id: "navigation-settings-grok",
      group: "navigation",
      label: `${messages.settings} · ${messages.settingsGrok}`,
      run: () => { closeCommandPalette(); openSettings("grok"); },
    },
    {
      id: "navigation-settings-privacy",
      group: "navigation",
      label: `${messages.settings} · ${messages.settingsPrivacy}`,
      run: () => { closeCommandPalette(); openSettings("privacy"); },
    },
    {
      id: "navigation-grok-center",
      group: "navigation",
      label: messages.manageGrokBuild,
      detail: messages.officialSessionCapabilities,
      run: () => { closeCommandPalette(); openGrokControlCenter(); },
    },
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
  const attentionTasks = projection.workspaces
    .flatMap((workspace) => workspace.tasks)
    .filter((task) => !task.archived && (
      isLiveRunState(task.activeRunState) ||
      (task.queuedTurnCount ?? 0) > 0 ||
      task.activeRunState === "failed" ||
      task.activeRunState === "interrupted"
    ))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, 4);

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

  async function createTask(workspaceId?: string) {
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
      const task = await api.createTask({ workspaceId: target as WorkspaceProjection["workspaceId"] });
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

  async function sendComposerText(sourceText: string) {
    const text = sourceText.trim();
    if (
      busy ||
      text.length === 0 ||
      activeTask === undefined ||
      pendingSends.has(activeTask.task.taskId) ||
      !activeTask.canSend ||
      (running && promptAttachments.length > 0)
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
      await api.sendMessage({
        taskId,
        text,
        ...(submittedAttachments.length === 0 ? {} : { attachments: submittedAttachments }),
        ...(submittedContinuousMode ? { mode: "continuous" as const } : {}),
      });
      const emptyAttachments = Object.freeze([]) as readonly PromptAttachment[];
      if (activeTaskIdRef.current === taskId) {
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

  async function setSessionConfigOption(configId: string, value: string | boolean) {
    const taskId = projection?.activeTask?.task.taskId;
    if (taskId === undefined) return;
    await run(async () => {
      const task = await api.setSessionConfigOption({ taskId, configId, value });
      setProjection((current) => current === undefined ? current : { ...current, activeTask: task });
    });
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
    model: GuildGrokModel,
    reasoningEffort: GuildGrokReasoningEffort,
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

  function beginBannyDrag(event: ReactDragEvent<HTMLElement>) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(BANNY_DRAG_MIME, "banny");
    setBannyDragging(true);
    setBannyDropTargetId(undefined);
  }

  function endBannyDrag() {
    setBannyDragging(false);
    setBannyDropTargetId(undefined);
  }

  function seatBanny(taskId: TaskSummaryProjection["taskId"]) {
    const placement = Object.freeze({ kind: "task", taskId }) as BannyPlacement;
    setBannyPlacement(placement);
    writeBannyPlacement(window.localStorage, placement);
    endBannyDrag();
  }

  function dropBannyInWindow(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(BANNY_DRAG_MIME)) return;
    event.preventDefault();
    const homeRegion = conversation.current?.getBoundingClientRect();
    if (homeRegion === undefined) return;
    const placement = bannyPlacementFromDrop(
      event.currentTarget.getBoundingClientRect(),
      homeRegion,
      event.clientX,
      event.clientY,
    );
    setBannyPlacement(placement);
    writeBannyPlacement(window.localStorage, placement);
    endBannyDrag();
  }

  const effectiveWorkbenchWidth = viewport.width <= 1000 ? WORKBENCH_MIN_WIDTH : workbenchWidth;

  return (
    <div
      className={`guild-shell ${workbenchOpen && activeTask !== undefined ? "workbench-open" : ""} ${bannyDragging ? "banny-dragging" : ""}`}
      style={{
        "--sidebar-width": `${projection.sidebarWidth}px`,
        "--workbench-width": `${effectiveWorkbenchWidth}px`,
      } as React.CSSProperties}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(BANNY_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={dropBannyInWindow}
    >
      {bannyDragging && <span className="guild-banny-home-target" aria-hidden="true" />}
      {bannyFloatsInWindow && (
        <img
          className={`guild-banny-floating ${bannyPlacement.kind} ${bannyDragging ? "dragging" : ""}`}
          src={BANNY_ASSET_URL}
          alt={messages.bannyDragHint}
          title={messages.bannyDragHint}
          draggable
          onDragStart={beginBannyDrag}
          onDragEnd={endBannyDrag}
          style={bannyPlacement.kind === "free" ? {
            left: `${bannyPlacement.x * 100}%`,
            top: `${bannyPlacement.y * 100}%`,
          } : undefined}
        />
      )}
      <aside className="guild-sidebar" aria-label={messages.projects} inert={workbenchOpen && viewport.width <= 1000}>
        <div className="guild-sidebar-drag" />
        <div className="guild-wordmark"><img src={BANNY_ASSET_URL} alt="" /><span>{messages.appName}</span></div>
        <button className="guild-brand" type="button" aria-expanded={workspacePickerOpen} aria-label={messages.chooseWorkspace}
          onPointerDown={(event) => event.stopPropagation()} onClick={() => {
            setAccountOpen(false); setWorkspacePickerOpen((value) => !value);
          }}>
          <FolderOpen size={18} /><span>{activeTask === undefined ? messages.chooseWorkspace
            : workspaceName(projection.workspaces, activeTask.task.workspaceId, messages.workspaceFallback)}</span><CaretDown size={14} />
        </button>
        <div className="guild-new-row">
          <button className="guild-new-task" type="button" disabled={busy} onClick={() => void createTask()}>
            <Plus size={18} /><span>{messages.newTask}</span>
          </button>
        </div>
        <button className={`guild-search-trigger ${searchOpen ? "active" : ""}`} type="button" aria-expanded={searchOpen}
          onClick={() => {
            setWorkspacePickerOpen(false); setSearchOpen((value) => !value);
            if (searchOpen) setSearchQuery("");
          }}><MagnifyingGlass size={17} /><span>{messages.search}</span></button>
        {searchOpen && (
          <div className="guild-search-box">
            <MagnifyingGlass size={15} />
            <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} placeholder={messages.searchPlaceholder} aria-label={messages.searchPlaceholder} />
            {searchQuery.length > 0 && <button type="button" aria-label={messages.clearSearch} onClick={() => setSearchQuery("")}><X size={13} /></button>}
          </div>
        )}

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



        <div className="guild-project-section">
          <div className="guild-section-label">{messages.projectAndChats}</div>
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
              bannySeatTaskId={bannySeatTaskId}
              bannyDragging={bannyDragging}
              bannyDropTargetId={bannyDropTargetId}
              pendingTaskIds={pendingTaskIds}
              locale={projection.locale}
              onToggle={() => setExpandedWorkspaces((current) => toggleSet(current, workspace.workspaceId))}
              onOpenTask={(taskId) => void openTask(taskId)}
              onNewTask={() => void createTask(workspace.workspaceId)}
              onBannyDragStart={beginBannyDrag}
              onBannyDragEnd={endBannyDrag}
              onBannyDropTarget={setBannyDropTargetId}
              onBannyDrop={seatBanny}
              onPinTask={(task) => void updateTaskFromSidebar(task, task.pinned ? "unpin" : "pin")}
              onArchiveTask={(task) => void updateTaskFromSidebar(task, "archive")}
              onContextMenu={(event, menu) => {
                setConfirmDelete(false);
                setRenamingTask(false);
                setRenameError(false);
                openContextMenu(event, menu, setContextMenu);
              }}
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

        <div className="guild-sidebar-utilities">
          <button type="button" onClick={openGrokControlCenter}><Wrench size={17} />{messages.tools}</button>
          <button type="button" onClick={() => openSettings()}><GearSix size={17} />{messages.settings}</button>
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
              <div className="guild-account-meta"><span>{messages.version}</span><span>{projection.appVersion}</span></div>
              <p className="guild-independent">{messages.independentNotice}</p>
            </div>
          )}
          <button ref={profileTriggerRef} className="guild-profile" type="button" aria-haspopup="dialog" aria-expanded={accountOpen} aria-controls={accountOpen ? "guild-account-popover" : undefined} onPointerDown={(event) => event.stopPropagation()} onClick={() => {
            setSettingsOpen(false);
            setWorkspacePickerOpen(false);
            const next = !accountOpen;
            setAccountOpen(next);
            if (next) {
              void refreshUsage();
            }
          }}>
            <AvatarMark nickname={projection.profile.nickname} grantUrl={projection.profile.avatarGrantUrl} />
            <strong>{projection.profile.nickname}</strong>
          </button>

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
            <ChatCircleDots size={17} />
            <span>{activeTask?.task.title ?? messages.newTask}</span>
            {activeTask !== undefined && <span className="guild-workspace-chip">{workspaceName(projection.workspaces, activeTask.task.workspaceId, messages.workspaceFallback)}</span>}
          </div>
          <div className="guild-top-actions">
            <button
              ref={workbenchTrigger}
              className={`guild-workbench-trigger ${workbenchOpen ? "active" : ""}`}
              type="button"
              aria-label={messages.workbench}
              disabled={activeTask === undefined}
              onClick={() => setWorkbenchOpen((value) => !value)}
            ><SidebarSimple size={18} /><span>{messages.workbench}</span></button>
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
            }}><DotsThree size={20} /></button>
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
                className={task.taskId === activeTask?.task.taskId ? "active" : undefined}
                onClick={() => void openTask(task.taskId)}
              >
                <span className={`guild-task-state ${sidebarTaskStatus(task)}`} aria-hidden="true">
                  <TaskStatusGlyph status={sidebarTaskStatus(task)} />
                </span>
                <strong>{task.title}</strong>
                <small>{isLiveRunState(task.activeRunState)
                  ? messages.activeActivity(task.activeActivity ?? "working")
                  : (task.queuedTurnCount ?? 0) > 0
                    ? messages.queuedNext
                    : task.activeRunState === "failed"
                      ? messages.commandFailed
                      : messages.commandInterrupted}</small>
              </button>
            ))}
          </nav>
        )}

        <span className="guild-sr-only" role="status" aria-live="polite">{latestAssistantAnnouncement}</span>
        <section className="guild-conversation" ref={conversation} onScroll={(event) => {
          const element = event.currentTarget;
          autoScrollPinned.current = isConversationPinnedToBottom(
            element.scrollTop,
            element.clientHeight,
            element.scrollHeight,
          );
          const task = projection.activeTask;
          if (
            task !== undefined &&
            shouldLoadEarlierConversation(
              task.hasEarlierTimeline,
              element.scrollTop,
              element.clientHeight,
              element.scrollHeight,
            )
          ) void loadEarlierTimeline();
        }}>
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
              {bannyUsesEmptyTaskSlot && (
                <img
                  className={`guild-banny ${bannyDragging ? "dragging" : ""}`}
                  src={BANNY_ASSET_URL}
                  alt={messages.bannyDragHint}
                  title={messages.bannyDragHint}
                  draggable
                  onDragStart={beginBannyDrag}
                  onDragEnd={endBannyDrag}
                />
              )}
              <h1>{messages.starterTitle}</h1><p>{messages.starterHelp}</p>
              <div className="guild-starters">{([
                [messages.starterReview, messages.starterReviewDraft, <MagnifyingGlass size={19} />],
                [messages.starterBuild, messages.starterBuildDraft, <Code size={19} />],
                [messages.starterExplain, messages.starterExplainDraft, <ChatCircleDots size={19} />],
              ] as const).map(([label, text, icon]) => <button type="button" key={label} disabled={draft.trim().length > 0}
                onClick={() => { setDraft(text); composerInput.current?.focus(); }}>{icon}<span>{label}</span><ArrowUpRight size={15} /></button>)}</div>
            </div>
          ) : (
            <Timeline
              items={activeTimeline}
              pendingUserText={pendingSendForActive?.text}
              runStatus={commandStatus === undefined ? runStatus : undefined}
              locale={projection.locale}
              recentResult={activeTask.recentResult}
              continuousTask={activeTask.continuousTask}
              highlightedSequence={searchNavigation?.results[searchNavigation.index]?.taskId === activeTask.task.taskId
                ? searchNavigation.results[searchNavigation.index]?.sequence : undefined}
              onOpenExternal={(url) => void openExternal(url)}
              onPermissionDecision={decidePermission}
              onBranch={branchFromMessage}
              onRetryToDraft={retryMessageToDraft}
              onOpenRuntimeDiagnostics={() => void api.openRuntimeDiagnostics({})}
            />
          )}
          {commandStatus !== undefined && <CommandStatusLine status={commandStatus} locale={projection.locale} />}
          {activeTask?.recentResult !== undefined && !restoredNoticeCoversLatestResult &&
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
                : error === "recovery"
                  ? messages.sessionRecoveryContextRequired
                : error === "workspace"
                  ? messages.workspaceFolderMissing
                  : error === "message"
                    ? messages.messageTooLong
                    : messages.operationFailed}
            </div>
          )}
        </section>

        <form className="guild-composer-wrap" onSubmit={(event) => void submit(event)}>
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
              running={running}
              busy={busy}
              onAction={(action) => void setContinuousTask(action)}
            />
          )}
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
                      <button
                        type="button"
                        className="guild-queue-priority"
                        disabled={busy}
                        aria-label={`${messages.preemptQueued}: ${queued.text}`}
                        onClick={() => void preemptQueuedTurn(queued.queueId)}
                      >
                        <ArrowUp size={12} />
                        {messages.preemptQueued}
                      </button>
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
            <button
              className="guild-attach"
              type="button"
              disabled={activeTask === undefined || running || busy || continuousMode || promptAttachments.length >= 8}
              aria-label={messages.addWorkspaceFiles}
              title={running ? messages.attachmentsCannotQueue : messages.addWorkspaceFiles}
              onClick={() => void choosePromptFiles()}
            ><Paperclip size={17} /></button>
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
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={activeTask === undefined ? messages.selectWorkspaceFirst : pendingSendForActive !== undefined ? messages.connectingRuntime : running ? messages.queuePlaceholder : messages.composerPlaceholder}
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
            {running ? (
              <button className="guild-send guild-stop" type="button" disabled={busy || activeTask?.task.activeRunState === "cancel_requested"} onClick={() => void cancelActiveRun()} aria-label={messages.stop}><Stop size={13} weight="fill" /></button>
            ) : (
              <button className="guild-send" type="submit" disabled={draft.trim().length === 0 || activeTask === undefined || !activeTask.canSend || busy || activePendingSend !== undefined || (running && promptAttachments.length > 0)} aria-label={messages.send}>
                {busy || pendingSendForActive !== undefined ? <SpinnerGap size={17} className="guild-spin" /> : <ArrowUp size={17} weight="bold" />}
              </button>
            )}
          </div>
          <div className="guild-composer-meta">
            <span><FolderOpen size={14} />{activeTask === undefined ? messages.chooseWorkspace : workspaceName(projection.workspaces, activeTask.task.workspaceId, messages.workspaceFallback)}</span>
            <button type="button" title={messages.permissionHelp} onClick={() => openSettings("grok")}>{messages.permissionModeName(projection.runtimeSettings.permissionMode)}</button>
            <button
              type="button"
              className={`guild-continuous-toggle ${continuousMode ? "selected" : ""}`}
              disabled={activeTask === undefined || running || busy || promptAttachments.length > 0 ||
                activeTask?.continuousTask?.status === "active" || activeTask?.continuousTask?.status === "paused"}
              aria-pressed={continuousMode}
              title={messages.continuousModeHelp}
              onClick={() => setContinuousMode((value) => !value)}
            >
              <ArrowsClockwise size={13} />
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
              <span>{!contextWindow.available
                ? "—"
                : contextWindow.hasSize
                  ? `${contextWindow.percent}%`
                  : "—"}</span>
              {contextUsageOpen && <span className="guild-context-usage-detail" role="status">{!contextWindow.available
                ? messages.contextUsageUnavailableCompact
                : contextWindow.hasSize
                  ? messages.contextUsageCompact(contextWindow.usedLabel, contextWindow.sizeLabel, contextWindow.percent)
                  : messages.contextUsageUsedOnly(contextWindow.usedLabel)}</span>}
            </button>
            <button
              className="guild-runtime-summary"
              type="button"
              title={projection.runtimeVersion}
              onClick={() => openSettings("grok")}
            >
              {(selectedModel?.name ?? projection.runtimeSettings.model)} · {messages.reasoningEffortName(projection.runtimeSettings.reasoningEffort)}
            </button>
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
          </div>
          <div className="guild-workbench-body">
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
            selectedModel?.name ?? projection.runtimeSettings.model,
            messages.reasoningEffortName(projection.runtimeSettings.reasoningEffort),
          ])).join(" · ")}
          onClose={closeGrokControlCenter}
          onOpenSessionSettings={() => {
            setGrokControlOpen(false);
            openSettings("grok");
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
          <div className="guild-dialog" role="dialog" aria-modal="true" aria-label={messages.settings} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => handleDialogKeyDown(event, () => setSettingsOpen(false))}>
            <div className="guild-dialog-header">
              <strong>{messages.settings}</strong>
              <button autoFocus type="button" className="guild-soft-button" onClick={() => setSettingsOpen(false)}>{messages.closeDialog}</button>
            </div>
            <div className="guild-dialog-body">
              <div className="guild-dialog-tabs" role="tablist">
                {([
                  ["general", messages.settingsGeneral],
                  ["grok", messages.settingsGrok],
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
              {settingsTab === "grok" && (
                <div id="guild-settings-panel-grok" role="tabpanel" aria-labelledby="guild-settings-tab-grok" className="guild-settings-panel">
                  <p className="guild-setting-scope"><Info size={13} />{messages.currentTaskScope}</p>
                  <label className="guild-setting-field">
                    <span className="guild-setting-label">{messages.model}</span>
                    <select
                      value={projection.runtimeSettings.model}
                      disabled={busy || !projection.runtimeSettings.canChange}
                      onChange={(event) => {
                        const model = projection.runtimeSettings.availableModels.find(
                          (candidate) => candidate.id === event.currentTarget.value,
                        );
                        if (model === undefined) return;
                        const currentEffort = projection.runtimeSettings.reasoningEffort;
                        const reasoningEffort = supportsGuildGrokReasoningEffort(
                          model.id,
                          currentEffort,
                        ) ? currentEffort : model.defaultReasoningEffort;
                        void setRuntimeSettings(
                          model.id,
                          reasoningEffort,
                          projection.runtimeSettings.permissionMode,
                        );
                      }}
                    >
                      {projection.runtimeSettings.availableModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="guild-setting-field">
                    <span className="guild-setting-label">{messages.reasoningEffort}</span>
                    <select
                      value={projection.runtimeSettings.reasoningEffort}
                      disabled={busy || !projection.runtimeSettings.canChange}
                      onChange={(event) => void setRuntimeSettings(
                        projection.runtimeSettings.model,
                        event.currentTarget.value as GuildGrokReasoningEffort,
                        projection.runtimeSettings.permissionMode,
                      )}
                    >
                      {(selectedModel?.reasoningEfforts ?? []).map((effort) => (
                        <option key={effort} value={effort}>{messages.reasoningEffortName(effort)}</option>
                      ))}
                    </select>
                  </label>
                  <div className="guild-settings-section">
                    <div className="guild-setting-label">{messages.permissionMode}</div>
                    <p className="guild-setting-help">{messages.permissionHelp}</p>
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
                    <button type="button" className="guild-soft-button guild-open-control-center" onClick={openGrokControlCenter}>{messages.manageGrokBuild}</button>
                  </div>
                </div>
              )}
              {settingsTab === "privacy" && (
                <div id="guild-settings-panel-privacy" role="tabpanel" aria-labelledby="guild-settings-tab-privacy" className="guild-settings-panel">

                  <p className="guild-setting-help">{messages.privacyBrowserSyncOff}</p>
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
                  <p>{messages.aboutRole}</p>
                  <p>{messages.aboutCopyright}</p>
                  <p className="guild-independent">{messages.independentNotice}</p>
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

function isLiveRunState(state: TaskSummaryProjection["activeRunState"] | undefined): boolean {
  return state !== undefined && !["completed", "failed", "cancelled", "interrupted"].includes(state);
}

function isTaskManagementBlocked(task: TaskSummaryProjection): boolean {
  return isLiveRunState(task.activeRunState) || (task.queuedTurnCount ?? 0) > 0;
}

function WorkspaceTree({ workspace, expanded, activeTaskId, bannySeatTaskId, bannyDragging, bannyDropTargetId, pendingTaskIds, locale, onToggle, onOpenTask, onNewTask, onBannyDragStart, onBannyDragEnd, onBannyDropTarget, onBannyDrop, onPinTask, onArchiveTask, onContextMenu }: {
  readonly workspace: WorkspaceProjection;
  readonly expanded: boolean;
  readonly activeTaskId?: string;
  readonly bannySeatTaskId?: TaskSummaryProjection["taskId"];
  readonly bannyDragging: boolean;
  readonly bannyDropTargetId?: string;
  readonly pendingTaskIds: ReadonlySet<string>;
  readonly locale: GuildLocale;
  readonly onToggle: () => void;
  readonly onOpenTask: (taskId: TaskSummaryProjection["taskId"]) => void;
  readonly onNewTask: () => void;
  readonly onBannyDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onBannyDragEnd: () => void;
  readonly onBannyDropTarget: (taskId: string | undefined) => void;
  readonly onBannyDrop: (taskId: TaskSummaryProjection["taskId"]) => void;
  readonly onPinTask: (task: TaskSummaryProjection) => void;
  readonly onArchiveTask: (task: TaskSummaryProjection) => void;
  readonly onContextMenu: (event: ReactMouseEvent, menu: ContextMenuSeed) => void;
}) {
  const messages = messagesFor(locale);
  const collapsedStatus = expanded ? "idle" : workspaceTaskStatus(workspace.tasks);
  return (
    <div className="guild-workspace-tree">
      <div className="guild-workspace-row" onContextMenu={(event) => onContextMenu(event, { type: "workspace", workspace })}>
        <button className="guild-workspace-main" type="button" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
          <span>{workspace.name}</span>
          <small>
            {collapsedStatus !== "idle" && (
              <span className={`guild-task-state ${collapsedStatus}`} aria-hidden="true">
                <TaskStatusGlyph status={collapsedStatus} />
              </span>
            )}
            {workspace.tasks.length}
          </small>
        </button>
        <button className="guild-row-add" type="button" aria-label={messagesFor(locale).newTask} onClick={onNewTask}><Plus size={14} /></button>
      </div>
      {expanded && (
        <div className="guild-task-list">
          {workspace.tasks.map((task) => {
            const status = sidebarTaskStatus(task);
            const managementBlocked = isTaskManagementBlocked(task) || pendingTaskIds.has(task.taskId);
            return (
            <div
              key={task.taskId}
              className={`guild-task-row-wrap ${task.taskId === activeTaskId ? "active" : ""}`}
              onDragEnter={(event) => {
                if (!bannyDragging) return;
                event.preventDefault();
                onBannyDropTarget(task.taskId);
              }}
              onDragOver={(event) => {
                if (!bannyDragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                if (bannyDropTargetId === task.taskId) onBannyDropTarget(undefined);
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes(BANNY_DRAG_MIME)) return;
                event.preventDefault();
                event.stopPropagation();
                onBannyDrop(task.taskId);
              }}
              onContextMenu={(event) => onContextMenu(event, { type: "task", task })}
            >
              <button
                className={`guild-task-row ${task.taskId === activeTaskId ? "active" : ""} ${task.taskId === bannySeatTaskId ? "banny-seated" : ""} ${task.taskId === bannyDropTargetId ? "banny-drop-target" : ""}`}
                type="button"
                onClick={() => onOpenTask(task.taskId)}
              >
                <span className={`guild-task-state ${status}`} title={taskStatusTitle(status, task, messages)}>
                  <TaskStatusGlyph status={status} />
                </span>
                <span className="guild-task-title">{task.title}</span>
                <span className="guild-task-trailing">
                  {task.taskId === bannySeatTaskId && (
                    <span className="guild-task-banny-slot">
                    <img
                      className={`guild-task-banny ${bannyDragging ? "dragging" : ""}`}
                      src={BANNY_ASSET_URL}
                      alt={messages.bannySeated}
                      title={messages.bannyDragHint}
                      draggable
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onDragStart={onBannyDragStart}
                      onDragEnd={onBannyDragEnd}
                    />
                    </span>
                  )}
                  {task.pinned && (
                    <span className="guild-task-pin" title={messages.pinned}>
                      <PushPinSimple size={11} weight="fill" />
                    </span>
                  )}
                  {status === "running" && task.activeActivity !== undefined
                    ? <span className="guild-task-live-label">{messages.activeActivity(task.activeActivity)}</span>
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
}

function TaskStatusGlyph({ status }: { readonly status: SidebarTaskStatus }) {
  return status === "running" ? <SpinnerGap size={13} />
    : status === "queued" ? <HourglassMedium size={14} />
      : status === "permission" ? <HandPalm size={14} weight="fill" />
        : status === "failed" ? <WarningCircle size={14} weight="fill" />
          : status === "interrupted" ? <WarningCircle size={14} />
            : status === "cancelled" ? <XCircle size={14} />
              : <ChatCircleDots size={15} />;
}

function taskStatusTitle(
  status: SidebarTaskStatus,
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
    <div className="guild-welcome">
      <div className="guild-welcome-mark"><Code size={30} weight="light" /></div>
      <h1>{hasWorkspace ? messages.welcomeTitle : messages.noWorkspaceTitle}</h1>
      <p>{hasWorkspace ? messages.welcomeBody : messages.noWorkspaceBody}</p>
      <button type="button" onClick={hasWorkspace ? onCreate : onChoose}><FolderOpen size={17} />{hasWorkspace ? messages.newTask : messages.chooseWorkspace}</button>
    </div>
  );
}

function Timeline({ items, pendingUserText, runStatus, locale, recentResult, continuousTask, highlightedSequence, onOpenExternal, onPermissionDecision, onBranch, onRetryToDraft, onOpenRuntimeDiagnostics }: {
  readonly items: readonly TimelineItemProjection[];
  readonly pendingUserText?: string;
  readonly runStatus?: VisibleRunStatus;
  readonly locale: GuildLocale;
  readonly recentResult?: TaskViewProjection["recentResult"];
  readonly continuousTask?: TaskViewProjection["continuousTask"];
  readonly highlightedSequence?: number;
  readonly onOpenExternal: (url: string) => void;
  readonly onPermissionDecision: (
    item: Extract<TimelineItemProjection, { readonly kind: "permission" }>,
    decision: { readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string },
  ) => Promise<void>;
  readonly onBranch: (item: TimelineItemProjection) => Promise<void>;
  readonly onRetryToDraft: (item: TimelineItemProjection) => void;
  readonly onOpenRuntimeDiagnostics: () => void;
}) {
  const messages = messagesFor(locale);
  const groups = useMemo(() => groupTimeline(items), [items]);
  const completionSequence = continuousTask?.lastRunId !== undefined &&
    ["completed", "stopped"].includes(continuousTask.status)
    ? items.findLast((item) => item.runId === continuousTask.lastRunId)?.sequence : undefined;
  const renderGroup = (group: (typeof groups)[number], index: number) => {
    if (group.type === "activity") {
      const thoughts = group.items.filter((item): item is Extract<TimelineItemProjection, { readonly kind: "thought" }> => item.kind === "thought");
      const tools = group.items.filter((item): item is Extract<TimelineItemProjection, { readonly kind: "tool" }> => item.kind === "tool");
      const elapsed = Math.max(0, ...thoughts.map((item) => item.elapsedMs));
      const state = activityGroupState(group.items);
      const streaming = state === "streaming";
      const toolKinds = activityToolKinds(group.items);
      const summary = streaming
        ? elapsed > 0
          ? messages.activeActivityFor(streamingActivity(group.items), Math.max(1, Math.round(elapsed / 1000)))
          : messages.activeActivity(streamingActivity(group.items))
        : [
            state === "cancelled" ? messages.cancelledActivity
              : state === "interrupted" ? messages.interruptedActivity
                : state === "failed" ? messages.failedActivity
                  : "",
            thoughts.length > 0 ? messages.thoughtFor(Math.max(1, Math.round(elapsed / 1000))) : "",
            tools.length > 0 ? messages.usedTools(tools.length) : "",
          ].filter(Boolean).join(" · ");
      return <details className="guild-disclosure guild-activity" key={`activity-${group.items[0]?.entryId ?? index}`}>
        <summary>{streaming
          ? <SpinnerGap size={14} className="guild-spin" />
          : state === "completed"
            ? <Check size={14} />
            : state === "failed"
              ? <WarningCircle size={14} />
              : <Stop size={12} weight="fill" />}<span className="guild-activity-summary">{summary}</span>{toolKinds.length > 0 && <span className="guild-activity-tool-icons" aria-label={toolKinds.map((kind) => messages.toolKindLabel(kind)).join(", ")}>{toolKinds.map((kind) => <span title={messages.toolKindLabel(kind)} key={kind}><ToolKindIcon kind={kind} size={12} /></span>)}</span>}<CaretRight size={13} /></summary>
        <div>
          {thoughts.length > 0 && <p className="guild-thought-copy">{thoughts.map((item) => item.text).join(" ")}</p>}
          <div className="guild-tool-list">{tools.map((item) => <ToolRow item={item} locale={locale} key={item.entryId} />)}</div>
        </div>
      </details>;
    }
    return <TimelineItem
      item={group.item}
      locale={locale}
      onOpenExternal={onOpenExternal}
      onPermissionDecision={onPermissionDecision}
      onBranch={onBranch}
      onRetryToDraft={onRetryToDraft}
      onOpenRuntimeDiagnostics={onOpenRuntimeDiagnostics}
      interruptedUser={group.item.kind === "notice" && group.item.noticeType === "session_restored"
        ? [...items].reverse().find((item) =>
            item.sequence < group.item.sequence && item.kind === "user" && item.status === "interrupted")
        : undefined}
      canRetry={
        group.item.kind === "user" &&
        group.item.runId !== undefined &&
        recentResult !== undefined &&
        group.item.runId === recentResult?.runId &&
        recentResult.state !== "completed"
      }
      key={group.item.entryId}
    />;
  };
  return <div className="guild-timeline">{groups.map((group, index) => {
    const entries = group.type === "activity" ? group.items : [group.item];
    const sequence = entries[0]!.sequence;
    return <div key={entries[0]!.entryId} className={highlightedSequence === sequence ? "guild-timeline-group search-highlight" : "guild-timeline-group"}
      data-sequence={sequence} tabIndex={-1}>
      {renderGroup(group, index)}
      {continuousTask !== undefined && completionSequence !== undefined && entries.some((item) => item.sequence === completionSequence) &&
        <ContinuousCompletionRecord task={continuousTask} locale={locale} />}
    </div>;
  })}{pendingUserText !== undefined && (
    <article className="guild-message guild-message-user guild-message-pending" aria-busy="true">
      <div className="guild-message-body"><MarkdownText text={pendingUserText} locale={locale} onOpenExternal={onOpenExternal} /></div>
      <SpinnerGap size={12} className="guild-spin" aria-label={messages.connectingRuntime} />
    </article>
  )}{runStatus !== undefined && <RunStatusLine status={runStatus} locale={locale} />}</div>;
}

function RunStatusLine({ status, locale }: {
  readonly status: VisibleRunStatus;
  readonly locale: GuildLocale;
}) {
  const messages = messagesFor(locale);
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
    <SpinnerGap size={14} className="guild-spin" aria-hidden="true" />
    <span role="status" aria-live="polite">{label}</span>
    <time aria-hidden="true">{messages.runElapsed(elapsedSeconds)}</time>
  </div>;
}

function CommandStatusLine({ status, locale }: {
  readonly status: SlashCommandStatus;
  readonly locale: GuildLocale;
}) {
  const messages = messagesFor(locale);
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

export function ToolRow({ item, locale }: {
  readonly item: Extract<TimelineItemProjection, { readonly kind: "tool" }>;
  readonly locale: GuildLocale;
}) {
  const messages = messagesFor(locale);
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
  return <div className={`guild-tool-row ${item.toolStatus}`}>
    <div className="guild-tool-heading">
      <span>{item.toolStatus === "completed" ? <Check size={14} /> : item.toolStatus === "failed" ? <Stop size={12} weight="fill" /> : <SpinnerGap size={14} className="guild-spin" />}{item.title}</span>
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
        <small>{messages.toolKindLabel(item.toolKind)}</small>
      </span>
    </div>
    {previewedImage !== undefined && <figure ref={previewRef} className="guild-tool-image-preview">
      <ViewableImage src={previewedImage.grantUrl} alt={previewedImage.alt} locale={locale} variant="preview" />
      {previewedImage.alt.trim().length > 0 && <figcaption>{previewedImage.alt}</figcaption>}
    </figure>}
    {details.length > 0 && <details className="guild-tool-content">
      <summary>{messages.toolDetails}<CaretRight size={12} /></summary>
      <div>{details.map((content, index) => {
        if (content.type === "text") return <pre key={index}>{content.text}</pre>;
        if (content.type === "diff") return <section className="guild-tool-diff" key={index}>
          <strong>{messages.fileChange}: {content.path}</strong>
          {content.oldText !== undefined && content.oldText !== null && <><small>{messages.beforeChange}</small><pre>{content.oldText}</pre></>}
          <small>{messages.afterChange}</small><pre>{content.newText}</pre>
        </section>;
        if (content.type === "terminal") return <p key={index}>{messages.terminalOutputUnavailable}</p>;
        return <p key={index}>{messages.unsupportedToolContent(content.contentType)}</p>;
      })}</div>
    </details>}
  </div>;
}

function TimelineItem({ item, locale, onOpenExternal, onPermissionDecision, onBranch, onRetryToDraft, onOpenRuntimeDiagnostics, interruptedUser, canRetry }: {
  readonly item: TimelineItemProjection;
  readonly locale: GuildLocale;
  readonly canRetry: boolean;
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
  const messages = messagesFor(locale);
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
  const footer = item.kind === "assistant" && item.status === "completed"
    ? continuousFooter(item.text)
    : undefined;
  const body = footer?.body ?? item.text;
  return <article className={`guild-message guild-message-${item.kind}`}>
    {body.length > 0 && <div className="guild-message-body"><MarkdownText text={body} locale={locale} onOpenExternal={onOpenExternal} /></div>}
    {footer !== undefined && <ContinuousRoundRecord footer={footer} locale={locale} />}
    {(item.kind === "user" || item.kind === "assistant") && (
      <MessageActions
        item={item}
        messages={messages}
        canRetry={canRetry}
        onBranch={onBranch}
        onRetryToDraft={onRetryToDraft}
      />
    )}
  </article>;
}

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
    }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
    <button type="button" title={messages.branchMessageHelp} aria-label={messages.branchFromMessage} onClick={() => void onBranch(item)}><GitFork size={13} /></button>
    {canRetry && item.kind === "user" && (
      <button type="button" title={messages.retryToDraftHelp} aria-label={messages.retryToDraft} onClick={() => onRetryToDraft(item)}><ArrowsClockwise size={13} /></button>
    )}
  </div>;
}

const MarkdownText = memo(function MarkdownText({ text, locale, onOpenExternal }: {
  readonly text: string;
  readonly locale: GuildLocale;
  readonly onOpenExternal: (url: string) => void;
}) {
  return renderText(text, onOpenExternal, locale);
}, (previous, next) => previous.text === next.text && previous.locale === next.locale);

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
  return <div className="guild-permission" aria-busy={submitting}>
    <strong>{messages.permissionNeeded}</strong>
    <span>{item.title}</span>
    <div>
      {item.options.map((option) => <button disabled={submitting} type="button" key={option.optionId} onClick={() => void decide({ type: "selected", optionId: option.optionId })}>{option.name}</button>)}
      <button disabled={submitting} type="button" onClick={() => void decide({ type: "cancelled" })}>{messages.cancel}</button>
    </div>
  </div>;
}

export function renderText(
  text: string,
  onOpenExternal: (url: string) => void,
  locale: GuildLocale = "en-US",
) {
  if (isBareSymbolReply(text)) return <p>{text}</p>;
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
