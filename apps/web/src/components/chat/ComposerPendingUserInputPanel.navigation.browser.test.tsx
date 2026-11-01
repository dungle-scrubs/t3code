import {
  EnvironmentId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { makeThreadRequestsResolvedAnnouncer } from "@t3tools/client-runtime/state/thread-requests";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import type { ChatComposerHandle } from "./ChatComposer";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

const blockingCapability = {
  type: "live" as const,
  providerSessionId: ProviderSessionId.make("provider-session"),
};

function questionProjection(
  threadId: ThreadId,
  requestIds = ["first", "second"],
  responseCapability: { readonly type: "message" } | typeof blockingCapability = {
    type: "message" as const,
  },
  responseMode?: "message",
) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability,
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      ...(responseMode === undefined ? {} : { responseMode }),
      questions: prompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

interface ProbeProps {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
  promptRef?: { current: string };
  composer?: Pick<ChatComposerHandle, "resetCursorState">;
  setComposerDraftPrompt?: Parameters<typeof usePendingThreadRequests>[0]["setComposerDraftPrompt"];
}

function useProbeRequests({
  environmentId,
  projection,
  loading = false,
  promptRef: sharedPromptRef,
  composer,
  setComposerDraftPrompt = () => {},
}: ProbeProps) {
  const ownPromptRef = useRef("");
  const composerRef = useRef((composer ?? null) as ChatComposerHandle | null);
  return usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt,
    promptRef: sharedPromptRef ?? ownPromptRef,
    composerRef,
    setThreadError: () => {},
  });
}

let requests: ReturnType<typeof usePendingThreadRequests>;

function PendingRequestsProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  useLayoutEffect(() => {
    requests = state;
  });
  return null;
}

it("retains answers, selections and question position after leaving chat, including while the projection reloads", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("remount-environment");
  const projection = questionProjection(threadRef.threadId);
  const probe = (loading = false) => (
    <PendingRequestsProbe environmentId={environmentId} projection={projection} loading={loading} />
  );
  await using screen = await render(probe());
  await act(() =>
    requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Keep my text"),
  );
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onSelectActivePendingUserInputOption("question-1", "Incremental"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  const expected = {
    activePendingQuestionIndex: 2,
    activePendingDraftAnswers: {
      "question-0": { customAnswer: "Keep my text" },
      "question-1": { selectedOptionValues: ["Incremental"] },
    },
  };
  expect(requests).toMatchObject(expected);

  // New thread and Settings both unmount the chat that owns this hook.
  await screen.rerender(null);
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);

  await screen.rerender(null);
  await screen.rerender(probe(true));
  expect(requests.activePendingUserInput).toBeNull();
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);
});

function QuestionPositionProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  return (
    <>
      <output>Question {state.activePendingQuestionIndex + 1}</output>
      <button
        type="button"
        onClick={() => state.onSelectActivePendingUserInputOption("question-0", "Incremental")}
      >
        Choose Incremental
      </button>
      <button type="button" onClick={() => state.onAdvanceActivePendingUserInput()}>
        Submit
      </button>
    </>
  );
}

it("stays on an unanswered question when the composer submits", async () => {
  await using screen = await render(
    <QuestionPositionProbe
      environmentId={EnvironmentId.make("unanswered-environment")}
      projection={questionProjection(threadRef.threadId)}
    />,
  );
  const submit = screen.getByRole("button", { name: "Submit" });
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 1");

  await userEvent.click(screen.getByRole("button", { name: "Choose Incremental" }));
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 2");
});

it("isolates drafts by environment, thread and request and discards only resolved requests", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("scope-environment");
  const projection = questionProjection(threadRef.threadId);
  const scopes = [
    { environmentId, projection },
    { environmentId: EnvironmentId.make("other-environment"), projection },
    { environmentId, projection: questionProjection(ThreadId.make("other-thread")) },
    { environmentId, projection: questionProjection(threadRef.threadId, ["second", "first"]) },
  ];
  await using screen = await render(null);
  const show = (scope: ComponentProps<typeof PendingRequestsProbe>) =>
    screen.rerender(<PendingRequestsProbe {...scope} />);
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(0);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBeUndefined();
    await act(() =>
      requests.onChangeActivePendingUserInputCustomAnswer("question-0", `Answer ${index}`),
    );
    await act(() => requests.onAdvanceActivePendingUserInput());
  }

  // "first" was answered on another device.
  await show({
    environmentId,
    projection: {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) =>
        request.id === "first"
          ? { ...request, status: "resolved", resolvedAt: projection.updatedAt }
          : request,
      ),
    },
  });
  expect(requests.activePendingUserInput?.requestId).toBe("second");
  await act(() =>
    makeThreadRequestsResolvedAnnouncer(
      environmentId,
      threadRef.threadId,
    )([RuntimeRequestId.make("second")]),
  );
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});

it.each([
  {
    mode: "message-mode",
    capability: { type: "message" as const },
    responseMode: undefined,
    promptAfterEdit: "Normal draft",
    promptAfterSelect: "Normal draft",
    carriedPrompt: null,
  },
  {
    mode: "Pi async",
    capability: blockingCapability,
    responseMode: "message" as const,
    promptAfterEdit: "Normal draft",
    promptAfterSelect: "Normal draft",
    carriedPrompt: null,
  },
  {
    mode: "blocking",
    capability: blockingCapability,
    responseMode: undefined,
    promptAfterEdit: "Typed answer",
    promptAfterSelect: "",
    carriedPrompt: "Typed answer",
  },
])(
  "answering a $mode question keeps or takes over the normal draft",
  async ({ capability, responseMode, promptAfterEdit, promptAfterSelect, carriedPrompt }) => {
    using _timers = fakeTimers();
    const environmentId = EnvironmentId.make(`draft-${capability.type}`);
    const promptRef = { current: "Normal draft" };
    const resetCursorState = vi.fn();
    const setComposerDraftPrompt = vi.fn();
    await using _screen = await render(
      <PendingRequestsProbe
        environmentId={environmentId}
        projection={questionProjection(threadRef.threadId, ["first"], capability, responseMode)}
        promptRef={promptRef}
        composer={{ resetCursorState }}
        setComposerDraftPrompt={setComposerDraftPrompt}
      />,
    );

    await act(() =>
      requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Typed answer"),
    );
    expect(promptRef.current).toBe(promptAfterEdit);
    await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
    expect(requests.activePendingDraftAnswers["question-0"]).toMatchObject({
      selectedOptionValues: ["Incremental"],
    });
    expect(promptRef.current).toBe(promptAfterSelect);
    if (carriedPrompt === null) {
      expect(setComposerDraftPrompt).not.toHaveBeenCalled();
      expect(resetCursorState).not.toHaveBeenCalled();
    } else {
      expect(setComposerDraftPrompt).toHaveBeenCalledWith(
        { environmentId, threadId: threadRef.threadId },
        carriedPrompt,
      );
      expect(resetCursorState).toHaveBeenCalledWith({ cursor: 0 });
    }
  },
);

function QuestionCardProbe(props: ProbeProps & { onComposerSubmit: () => void }) {
  const { onComposerSubmit, ...probeProps } = props;
  const state = useProbeRequests(probeProps);
  useLayoutEffect(() => {
    requests = state;
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onComposerSubmit();
      }}
    >
      <ComposerPendingUserInputPanel
        pendingUserInputs={state.pendingUserInputs}
        cwd={undefined}
        threadRef={threadRef}
        respondingRequestIds={state.respondingRequestIds}
        answers={state.activePendingDraftAnswers}
        questionIndex={state.activePendingQuestionIndex}
        onToggleOption={state.onSelectActivePendingUserInputOption}
        onChangeCustomAnswer={state.onChangeActivePendingUserInputCustomAnswer}
        onPrevious={state.onPreviousActivePendingUserInputQuestion}
        onAdvance={state.onAdvanceActivePendingUserInput}
        onDismiss={() => {}}
      />
      <button type="submit">Send message</button>
    </form>
  );
}

it("opens a message-mode question expanded and answers it in its own card", async () => {
  const promptRef = { current: "Normal draft" };
  const onComposerSubmit = vi.fn();
  await using screen = await render(
    <QuestionCardProbe
      environmentId={EnvironmentId.make("card-answer-environment")}
      projection={questionProjection(threadRef.threadId, ["first"], blockingCapability, "message")}
      promptRef={promptRef}
      onComposerSubmit={onComposerSubmit}
    />,
  );
  const toggle = screen.getByTitle("Hide the question and its options");
  await expect.element(toggle).toHaveAttribute("data-pending-user-input-toggle", "expanded");
  await expect.element(screen.getByText("Choose for question 1")).toBeVisible();
  await userEvent.click(toggle);
  await expect
    .element(screen.getByTitle("Show the question and its options"))
    .toHaveAttribute("data-pending-user-input-toggle", "collapsed");
  await userEvent.click(screen.getByTitle("Show the question and its options"));

  const answer = screen.getByRole("textbox", { name: "Your answer" });
  await userEvent.type(answer, "Keep my text");
  await expect.element(answer).toHaveValue("Keep my text");
  expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe("Keep my text");
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("Choose for question 2")).toBeVisible();
  expect(onComposerSubmit).not.toHaveBeenCalled();
  expect(promptRef.current).toBe("Normal draft");

  await userEvent.click(screen.getByRole("button", { name: "Previous" }));
  await expect.element(screen.getByText("Choose for question 1")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Next question" }));
  await expect.element(screen.getByText("Choose for question 2")).toBeVisible();
  expect(onComposerSubmit).not.toHaveBeenCalled();
});

it("leaves a blocking question's answer to the composer", async () => {
  await using screen = await render(
    <QuestionCardProbe
      environmentId={EnvironmentId.make("card-blocking-environment")}
      projection={questionProjection(threadRef.threadId, ["first"], blockingCapability)}
      onComposerSubmit={() => {}}
    />,
  );
  await expect.element(screen.getByText("Choose for question 1")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Your answer" }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Next question" }).query()).toBeNull();
});
