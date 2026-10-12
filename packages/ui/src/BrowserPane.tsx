/**
 * The browser pane of the workbench (PC-BROWSER-001): tab strip, back/forward/reload, address bar,
 * the "agent operating" badge with Take over / Resume agent, and an empty placeholder element.
 * The page itself is a native view that main draws over the placeholder; this component reports the
 * placeholder's bounding rectangle with `setBounds` and shows or hides the native view with
 * `setVisible`. It holds no page state: everything it shows comes from the projection.
 *
 * The projection and command types below mirror `BrowserPaneProjection` / `BrowserPaneCommand`
 * of apps/desktop/src/main/browser-pane.ts (WP-B moves them into @guild/contracts with the same
 * shape; swap these local definitions for the contract import then).
 */

import { ArrowClockwiseIcon as ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowLeftIcon as ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { HandPalmIcon as HandPalm } from "@phosphor-icons/react/HandPalm";
import { PlayIcon as Play } from "@phosphor-icons/react/Play";
import { PlusIcon as Plus } from "@phosphor-icons/react/Plus";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { StopIcon as Stop } from "@phosphor-icons/react/Stop";
import { XIcon as X } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { GuildMessages } from "./locales.js";

export type BrowserPaneBounds = Readonly<{ x: number; y: number; width: number; height: number }>;
export type BrowserPaneAgentControl = "idle" | "operating" | "paused";

export type BrowserPaneTabProjection = Readonly<{
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}>;

export type BrowserPaneProjection = Readonly<{
  tabs: readonly BrowserPaneTabProjection[];
  activeTabId: string | null;
  agentControl: BrowserPaneAgentControl;
}>;

export type BrowserPaneCommand =
  | Readonly<{ type: "navigate"; url: string }>
  | Readonly<{ type: "back" }>
  | Readonly<{ type: "forward" }>
  | Readonly<{ type: "reload" }>
  | Readonly<{ type: "stop" }>
  | Readonly<{ type: "newTab"; url?: string }>
  | Readonly<{ type: "closeTab"; tabId: string }>
  | Readonly<{ type: "selectTab"; tabId: string }>
  | Readonly<{ type: "setBounds"; bounds: BrowserPaneBounds }>
  | Readonly<{ type: "setVisible"; visible: boolean }>
  | Readonly<{ type: "takeOver" }>
  | Readonly<{ type: "resumeAgent" }>;

export type BrowserPaneMessageKey = Extract<keyof GuildMessages, `browserPane${string}`>;

export const BROWSER_PANE_MAX_TABS = 5;

export type BrowserPaneProps = Readonly<{
  projection: BrowserPaneProjection;
  onCommand: (command: BrowserPaneCommand) => void;
  t: (key: BrowserPaneMessageKey) => string;
  /** True while something drawn by the page (a menu, a dialog) must not sit under the native view. */
  hidden?: boolean;
}>;

// ---------------------------------------------------------------------------------------------
// Address normalisation
// ---------------------------------------------------------------------------------------------

export type BrowserAddress = Readonly<{ ok: true; url: string }> | Readonly<{ ok: false }>;

function authorityOf(text: string): string {
  const afterScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const authority = afterScheme.split(/[/?#]/u, 1)[0] ?? "";
  return authority.slice(authority.lastIndexOf("@") + 1);
}

function hostOf(authority: string): string {
  if (authority.startsWith("[")) return authority.slice(0, authority.indexOf("]") + 1);
  const colon = authority.lastIndexOf(":");
  return (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * What the address bar sends to main: a full http(s) URL. Plain words and sentences are never turned
 * into searches. A missing scheme becomes `https://` (`http://` for localhost and loopback addresses,
 * which do not serve TLS). Main validates again; this only keeps obvious non-addresses from being sent.
 */
export function normalizeBrowserAddress(input: string): BrowserAddress {
  const text = input.trim();
  if (text === "" || /\s/u.test(text)) return { ok: false };
  if (text.toLowerCase() === "about:blank") return { ok: true, url: "about:blank" };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text);
  const host = hostOf(authorityOf(text));
  // A bare word ("hello") or number ("1234") is not an address; a name needs a dot, localhost or an IPv6 literal.
  if (!(host.includes(".") || host === "localhost" || host.startsWith("["))) return { ok: false };
  const candidate = hasScheme ? text : `${isLoopbackHost(host) ? "http" : "https"}://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return { ok: false };
  return { ok: true, url: url.href };
}

// ---------------------------------------------------------------------------------------------
// Reporting the placeholder to main
// ---------------------------------------------------------------------------------------------

/**
 * Keeps main's native view over the returned element. Reports on mount and whenever the element or
 * the document is resized, the window resizes, or a layout transition ends (a moved sidebar changes
 * the element's position without changing its size). Unmounting hides the native view.
 */
function useNativeViewBounds(onCommand: (command: BrowserPaneCommand) => void, hidden: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const send = useRef(onCommand);
  useEffect(() => {
    send.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    let last = "";
    const report = () => {
      const rect = element.getBoundingClientRect();
      const bounds = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === last) return;
      last = key;
      send.current({ type: "setBounds", bounds });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    observer.observe(document.documentElement);
    window.addEventListener("resize", report);
    document.addEventListener("transitionend", report, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      document.removeEventListener("transitionend", report, true);
    };
  }, []);

  useEffect(() => {
    send.current({ type: "setVisible", visible: !hidden });
    return () => send.current({ type: "setVisible", visible: false });
  }, [hidden]);

  return ref;
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

function displayUrl(url: string | undefined): string {
  return url === undefined || url === "about:blank" ? "" : url;
}

export function BrowserPane({ projection, onCommand, t, hidden = false }: BrowserPaneProps) {
  const { tabs, activeTabId, agentControl } = projection;
  const active = tabs.find((tab) => tab.id === activeTabId);
  const viewport = useNativeViewBounds(onCommand, hidden);
  const [draft, setDraft] = useState<{ tabId: string | null; text: string } | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const address = draft !== undefined && draft.tabId === activeTabId ? draft.text : displayUrl(active?.url);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = normalizeBrowserAddress(address);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(undefined);
    onCommand({ type: "navigate", url: parsed.url });
  };

  const agentLabel = agentControl === "operating" ? t("browserPaneAgentOperating") : agentControl === "paused" ? t("browserPaneAgentPaused") : t("browserPaneAgentIdle");

  return (
    <section className="guild-browser" aria-label={t("browserPaneTitle")}>
      <div className="guild-browser-tabs" role="tablist" aria-label={t("browserPaneTabs")}>
        {tabs.map((tab) => (
          <div key={tab.id} className={`guild-browser-tab${tab.id === activeTabId ? " selected" : ""}`}>
            <button
              type="button"
              role="tab"
              className="guild-browser-tab-main"
              aria-selected={tab.id === activeTabId}
              title={tab.title !== "" ? tab.title : displayUrl(tab.url)}
              onClick={() => onCommand({ type: "selectTab", tabId: tab.id })}
            >
              {tab.loading && <SpinnerGap size={12} className="guild-spin" aria-hidden="true" />}
              <span>{tab.title !== "" ? tab.title : displayUrl(tab.url) !== "" ? displayUrl(tab.url) : t("browserPaneUntitledTab")}</span>
            </button>
            <button
              type="button"
              className="guild-browser-tab-close"
              aria-label={t("browserPaneCloseTab")}
              title={t("browserPaneCloseTab")}
              onClick={() => onCommand({ type: "closeTab", tabId: tab.id })}
            ><X size={11} /></button>
          </div>
        ))}
        <button
          type="button"
          className="guild-browser-newtab"
          aria-label={t("browserPaneNewTab")}
          title={tabs.length >= BROWSER_PANE_MAX_TABS ? t("browserPaneTabLimit") : t("browserPaneNewTab")}
          disabled={tabs.length >= BROWSER_PANE_MAX_TABS}
          onClick={() => onCommand({ type: "newTab" })}
        ><Plus size={13} /></button>
      </div>

      <form className="guild-browser-toolbar" onSubmit={submit}>
        <button type="button" aria-label={t("browserPaneBack")} title={t("browserPaneBack")} disabled={!(active?.canGoBack ?? false)} onClick={() => onCommand({ type: "back" })}><ArrowLeft size={15} /></button>
        <button type="button" aria-label={t("browserPaneForward")} title={t("browserPaneForward")} disabled={!(active?.canGoForward ?? false)} onClick={() => onCommand({ type: "forward" })}><ArrowRight size={15} /></button>
        {active?.loading === true ? (
          <button type="button" aria-label={t("browserPaneStop")} title={t("browserPaneStop")} onClick={() => onCommand({ type: "stop" })}><Stop size={14} weight="fill" /></button>
        ) : (
          <button type="button" aria-label={t("browserPaneReload")} title={t("browserPaneReload")} disabled={active === undefined} onClick={() => onCommand({ type: "reload" })}><ArrowClockwise size={15} /></button>
        )}
        <input
          className="guild-browser-address"
          type="text"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={t("browserPaneAddress")}
          aria-invalid={invalid || undefined}
          placeholder={t("browserPaneAddressPlaceholder")}
          value={address}
          onChange={(event) => {
            setInvalid(false);
            setDraft({ tabId: activeTabId, text: event.currentTarget.value });
          }}
          onBlur={() => {
            setInvalid(false);
            setDraft(undefined);
          }}
        />
      </form>

      <div className={`guild-browser-agent ${agentControl}`}>
        <span className="guild-browser-agent-pip" aria-hidden="true" />
        {invalid ? (
          // Shown in place of the status so the placeholder, which the native view covers, never changes size.
          <span className="guild-browser-agent-label error" role="alert">{t("browserPaneInvalidAddress")}</span>
        ) : (
          <span className="guild-browser-agent-label" role="status" aria-live="polite">{agentLabel}</span>
        )}
        {agentControl === "paused" ? (
          <button type="button" onClick={() => onCommand({ type: "resumeAgent" })}><Play size={12} weight="fill" />{t("browserPaneResume")}</button>
        ) : (
          <button type="button" onClick={() => onCommand({ type: "takeOver" })}><HandPalm size={13} />{t("browserPaneTakeOver")}</button>
        )}
      </div>


      <div className="guild-browser-viewport" ref={viewport}>
        {tabs.length === 0 && <p>{t("browserPaneEmpty")}</p>}
      </div>
    </section>
  );
}
