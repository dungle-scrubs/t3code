import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useOpenLink } from "../browser/useOpenLink";
import { useActiveProjectTarget } from "../hooks/useActiveProjectTarget";
import { githubIssuesUrl } from "../lib/keyboardHintCommands";
import {
  createKeyboardHintsController,
  KEYBOARD_HINT_ISSUES_KEY,
  KEYBOARD_HINT_PULL_REQUESTS_KEY,
  type KeyboardHintCommandKey,
  type KeyboardHintsController,
  type KeyboardHintsState,
} from "../lib/keyboardHints";
import { cn } from "../lib/utils";
import { registerCommands } from "../shortcuts/dispatcher";
import { usePullRequestsSupported } from "../state/environments";
import { readPullRequestListPreferences } from "./pullRequest/pullRequestListPreferences";
import { Kbd } from "./ui/kbd";
import { toastManager } from "./ui/toast";

const ISSUES_UNAVAILABLE = "No GitHub repository";

const IDLE_STATE: KeyboardHintsState = { active: false, prefix: "", targets: [] };

// Install the dispatcher before component effects attach other window listeners.
registerCommands({})();

/**
 * Draws the hint labels over the current surface and owns the hint mode.
 *
 * The mode lives in a controller rather than in React state so that a key
 * press is answered in the same tick, before any surface can act on it.
 */
export function KeyboardHints() {
  const [state, setState] = useState<KeyboardHintsState>(IDLE_STATE);
  const controllerRef = useRef<KeyboardHintsController | undefined>(undefined);
  const router = useRouter();
  const target = useActiveProjectTarget();
  const openLink = useOpenLink(target?.threadRef);
  const pullRequestsSupported = usePullRequestsSupported();
  const resolveHintCommand = useEffectEvent((key: KeyboardHintCommandKey) => {
    if (key === KEYBOARD_HINT_ISSUES_KEY) {
      const url = githubIssuesUrl(target?.repositoryIdentity);
      if (!target || !url) return undefined;
      const threadRef = target.threadRef;
      return () => {
        void openLink(url, { target: "app", threadRef }).catch(() => {
          toastManager.add({ type: "error", title: "Unable to open GitHub issues" });
        });
      };
    }
    if (!pullRequestsSupported) return undefined;
    return () => {
      void router
        .navigate({
          to: "/pull-requests",
          search: readPullRequestListPreferences(),
        })
        .catch(() => {
          toastManager.add({ type: "error", title: "Unable to open pull requests" });
        });
    };
  });
  const commandDetail =
    target && githubIssuesUrl(target.repositoryIdentity) ? target.projectName : ISSUES_UNAVAILABLE;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the hint controller registered with the shortcut dispatcher for as long as the component is mounted
  useEffect(() => {
    const controller = createKeyboardHintsController(document, setState, {
      resolveCommand: (key) => resolveHintCommand(key),
    });
    controllerRef.current = controller;
    const unregister = registerCommands(
      {},
      {
        capture: true,
        onKeyDown: (event) => controller.handleKeyDown(event),
      },
    );
    return () => {
      unregister();
      controllerRef.current = undefined;
      controller.dispose();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the hint overlay on navigation, because the labels belong to the page the route just left
  useEffect(() => {
    return router.subscribe("onResolved", () => {
      controllerRef.current?.dismiss();
    });
  }, [router]);

  if (!state.active) return null;
  return createPortal(
    <HintOverlay
      commandDetail={commandDetail}
      pullRequestsSupported={pullRequestsSupported}
      state={state}
    />,
    document.body,
  );
}

function HintCommandGuide({
  detail,
  pullRequestsSupported,
}: {
  readonly detail: string;
  readonly pullRequestsSupported: boolean;
}) {
  return (
    <aside
      aria-label="Hint commands"
      className="fixed right-4 bottom-4 flex w-max max-w-64 flex-col gap-2 rounded-lg border border-border bg-popover px-2.5 py-2 text-popover-foreground text-xs shadow-md"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Kbd>{KEYBOARD_HINT_ISSUES_KEY}</Kbd>
        <span>GitHub issues</span>
        <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Kbd>{KEYBOARD_HINT_PULL_REQUESTS_KEY}</Kbd>
        <span>Pull requests</span>
        {pullRequestsSupported ? null : (
          <span className="min-w-0 truncate text-muted-foreground">Unavailable</span>
        )}
      </div>
    </aside>
  );
}

function HintOverlay({
  commandDetail,
  pullRequestsSupported,
  state,
}: {
  readonly commandDetail: string;
  readonly pullRequestsSupported: boolean;
  readonly state: KeyboardHintsState;
}) {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[2147483000]"
      data-keyboard-hints-overlay=""
    >
      <div aria-hidden="true" className="contents">
        {state.targets
          .filter((target) => target.label.startsWith(state.prefix))
          .map((target) => (
            <span
              key={target.label}
              data-keyboard-hint-target={target.element.id || undefined}
              dir="ltr"
              className={cn(
                "absolute inline-flex h-[16px] items-center gap-px overflow-hidden rounded-sm border border-foreground bg-foreground bg-no-repeat font-mono font-semibold text-2xs leading-none text-background shadow-sm",
                target.placement === "inline" && "-translate-y-1/2",
                target.placement === "text-start" && "-translate-y-1/2",
                target.placement === "above" && "-translate-x-1/2 -translate-y-full",
                target.placement === "below" && "-translate-x-1/2",
                target.placement === "before" && "-translate-x-full -translate-y-1/2",
                target.placement === "after" && "-translate-y-1/2",
                target.placement === "center" && "-translate-1/2",
              )}
              style={{
                left: Math.max(4, target.left),
                top: Math.max(4, target.top),
                paddingInline: target.size === "compact" ? 2 : 3,
                backgroundImage: state.prefix
                  ? "linear-gradient(var(--primary), var(--primary))"
                  : undefined,
                backgroundSize: `${(state.prefix.length / target.label.length) * 100}% 100%`,
              }}
            >
              {target.label.split("").map((character, index) => {
                const matched = index < state.prefix.length;
                return (
                  <span
                    key={target.label.slice(0, index + 1)}
                    data-keyboard-hint-prefix={matched ? "" : undefined}
                    className={cn("flex h-full items-center", matched && "text-primary-foreground")}
                  >
                    {character}
                  </span>
                );
              })}
            </span>
          ))}
      </div>
      {state.prefix === "" ? (
        <HintCommandGuide detail={commandDetail} pullRequestsSupported={pullRequestsSupported} />
      ) : null}
    </div>
  );
}
