import { assert, describe, it } from "@effect/vitest";

import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";

describe("Pi replay fixtures", () => {
  itRunsReplayFixtures("pi", (input) =>
    runReplayFixture({ ...input, harness: PiOrchestratorReplayHarness }),
  );

  it.effect("keeps an async question answerable after the full provider turn completes", () => {
    const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === "simple")!;
    const driver = fixture.providers.find((entry) => entry.driver === "pi")!;
    return runReplayFixture({
      fixtureName: fixture.name,
      buildInput: fixture.buildInput,
      harness: PiOrchestratorReplayHarness,
      driver: {
        ...driver,
        assertOutput(result) {
          const projection = [...result.projections.values()][0]!;
          assert.equal(projection.runs[0]?.status, "completed");
          assert.isTrue(
            projection.messages.some(
              (message) => message.role === "assistant" && message.text === "fixture simple ok",
            ),
          );
          assert.lengthOf(projection.runtimeRequests, 1);
          const request = projection.runtimeRequests[0]!;
          assert.equal(request.status, "pending");
          assert.equal(request.responseCapability.type, "live");
          assert.equal(
            projection.nodes.find((node) => node.id === request.nodeId)?.status,
            "waiting",
          );
          const card = projection.turnItems.find(
            (item) => item.type === "user_input_request" && item.requestId === request.id,
          );
          assert.equal(card?.status, "waiting");
        },
      },
      transformTranscript(transcript) {
        return {
          ...transcript,
          entries: transcript.entries.flatMap((entry) =>
            entry.type === "emit_inbound" && entry.label === "agent_settled"
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "async-question",
                    frame: {
                      type: "extension_ui_request",
                      id: "async-native-request",
                      method: "select",
                      title:
                        "[async-user-question:11111111-1111-4111-8111-111111111111] Which option?",
                      options: ["1. First", "2. Second", "3. Other", "4. Let's talk about this"],
                    },
                  },
                  entry,
                ]
              : [entry],
          ),
        };
      },
    });
  });
});
