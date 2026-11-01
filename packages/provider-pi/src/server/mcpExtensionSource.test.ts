// @effect-diagnostics nodeBuiltinImport:off -- Pi extensions run outside Effect; these tests exercise their native filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

interface SkillCommand {
  readonly name: string;
  readonly source: string;
  readonly sourceInfo: { readonly path: string };
}

type InputHook = (
  event: { text: string; images?: ReadonlyArray<unknown> },
  ctx: { ui: { notify: (message: string, level: string) => void } },
) => Promise<{ action: string; text: string; images?: ReadonlyArray<unknown> } | undefined>;

async function loadHooks(
  commands: ReadonlyArray<SkillCommand> = [],
  argv: ReadonlyArray<string> = [],
) {
  const handlers = new Map<string, unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {}, argv },
    NodeFSP,
    NodePath,
    stripFrontmatter: (content: string) => content,
    pi: {
      on: (name: string, handler: unknown) => handlers.set(name, handler),
      getCommands: () => commands,
    },
  });
  return handlers;
}

describe("Pi orchestration prompt section", () => {
  it.each([
    {
      name: "on Pi builds without prompt sections",
      events: [
        { systemPrompt: "base" },
        { systemPrompt: "base", systemPromptOptions: {} },
        { systemPrompt: "base", systemPromptOptions: { sections: null } },
      ],
    },
    {
      name: "when an earlier extension forces the system prompt",
      events: [
        {
          systemPrompt: "forced",
          systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" },
        },
      ],
    },
  ])("appends guidance $name", async ({ events }) => {
    const bridge = await loadMcpBridge();
    const hook = bridge.handlers.get("before_agent_start")!;
    for (const event of events) {
      const result = await hook(event, { ui: { notify: assert.fail } });
      assert.isDefined(result);
      assert.isTrue(result!.systemPrompt.startsWith(`${event.systemPrompt}\n\n`));
      assert.include(result!.systemPrompt, "orchestrator_capabilities");
    }
  });
});

describe("Pi project trust", () => {
  it.each([
    { name: "a trusted folder", trusted: true, argv: [], notices: 0 },
    { name: "an untrusted folder", trusted: false, argv: [], notices: 1 },
    { name: "--no-approve", trusted: false, argv: ["--approve", "-na"], notices: 0 },
  ])("sends $notices trust notice per session for $name", async ({ trusted, argv, notices }) => {
    const sent: string[] = [];
    const ctx = {
      cwd: "/repo",
      isProjectTrusted: () => trusted,
      ui: { notify: (message: string) => sent.push(message) },
    };
    // Pi reruns extension factories on session replacement without asking about trust again.
    for (const _session of [1, 2]) {
      const handlers = (await loadHooks([], ["node", "pi", ...argv])) as Map<
        string,
        (event: unknown, ctx: unknown) => unknown
      >;
      for (const _turn of [1, 2]) await handlers.get("before_agent_start")!({}, ctx);
    }
    assert.equal(sent.length, notices * 2);
    for (const message of sent)
      assert.include(message, "for /repo because the folder is not trusted");
  });
});

describe("Pi MCP tool results", () => {
  it("returns mixed screenshot blocks and typed script output without repeating structured text", async () => {
    const content = [
      { type: "text", text: "Browser screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/png", _meta: { private: true } },
      { type: "text", text: "Screenshot captured" },
    ] as const;
    const result = { content, structuredContent: { count: 2 }, _meta: { private: true } };
    const bridge = await loadMcpBridge({ modern: true, result });
    const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!;
    const output = await tool.execute("snapshot", {});
    assert.deepEqual(output.content, [
      content[0],
      { type: "image", data: "AAAA", mimeType: "image/png" },
      content[2],
    ]);
    assert.deepEqual(output.structuredContent, { content, structuredContent: { count: 2 } });
    assert.deepEqual(tool.outputSchema, {
      type: "object",
      properties: {
        content: { type: "array", items: { type: "object" } },
        structuredContent: { type: "object", properties: { count: { type: "number" } } },
        isError: { type: "boolean" },
        _meta: { type: "object" },
      },
      required: ["content"],
    });
  });

  it.each([false, true])(
    "preserves image-only results and error status, isError=%s",
    async (isError) => {
      const image = { type: "image", data: "AAAA", mimeType: "image/png" };
      const result = { content: [image], isError };
      const bridge = await loadMcpBridge({ result });
      const output = await bridge.tools[0]!.execute("image", {});
      assert.deepEqual(output.content[0], image);
      assert.equal(output.content.length, isError ? 2 : 1);
      if (isError) assert.include(output.content[1]?.text ?? "", "returned an error");
      assert.equal(output.isError, isError ? true : undefined);
      assert.deepEqual(output.structuredContent, result);
    },
  );

  it("uses structured output as model text when content is empty", async () => {
    const result = { content: [], structuredContent: { count: 2 } };
    const bridge = await loadMcpBridge({ result });
    const output = await bridge.tools[0]!.execute("structured", {});
    assert.deepEqual(output.content, [{ type: "text", text: '{"count":2}' }]);
    assert.deepEqual(output.structuredContent, result);
  });
});

describe("Pi MCP tool exposure", () => {
  const discoveryContext = {
    model: { api: "anthropic-messages" },
    ui: { notify: () => undefined },
  };

  it("keeps orchestration direct and optional bridge tools discoverable on modern Pi", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    const start = bridge.handlers.get("before_agent_start");
    assert.isDefined(start);
    const prompt = await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
    assert.include(prompt?.systemPrompt ?? "", "orchestrator_capabilities");
    assert.equal(bridge.servers.length, 0);
    assert.equal(bridge.tools.length, 8);
    assert.deepEqual(bridge.getActiveTools(), ["read", "tool_search"]);
    assert.deepEqual(
      bridge.tools
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => [tool.name, tool.exposure]),
      [
        ["mcp__t3-code__orchestrator_capabilities", "direct"],
        ["mcp__t3-code__delegate_task", "direct"],
        ["mcp__t3-code__task_status", "direct"],
        ["mcp__t3-code__preview_snapshot", "deferred"],
      ],
    );
    assert.deepEqual(
      bridge.tools.filter((tool) => tool.exposure === "hidden").map((tool) => tool.name),
      [
        "mcp__t3_code__orchestrator_capabilities",
        "mcp__t3_code__delegate_task",
        "mcp__t3_code__task_status",
        "mcp__t3_code__preview_snapshot",
      ],
    );
    const result = await bridge.tools
      .find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!
      .execute("call-1", { depth: 2 });
    assert.equal(result.content[0]?.text, "browser snapshot");
    assert.equal(bridge.requests.at(-1)?.method, "tools/call");
  });

  it("appends AGENTS.local.md from the project root", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-local-"));
    const child = NodePath.join(root, "pkg");
    await NodeFSP.mkdir(child);
    await NodeFSP.writeFile(NodePath.join(root, ".git"), "gitdir: /tmp/unused\n");
    await NodeFSP.writeFile(NodePath.join(root, "AGENTS.local.md"), "Fork only rule\n");
    try {
      const bridge = await loadMcpBridge({ modern: true });
      const start = bridge.handlers.get("before_agent_start");
      assert.isDefined(start);
      const prompt = await start!(
        { systemPrompt: "Pi system prompt" },
        { ...discoveryContext, cwd: child },
      );
      assert.include(prompt?.systemPrompt ?? "", "Fork only rule");
    } finally {
      await NodeFSP.rm(root, { recursive: true });
    }
  });

  it("restores gateway declarations after model switches and older tree loadouts without excluded tools", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsTool: (name) => name !== "mcp__t3-code__delegate_task",
    });
    const event = { systemPrompt: "" };
    await bridge.handlers.get("session_start")!(event, discoveryContext);
    const gatewayContext = { model: { api: "openai-completions" }, ui: { notify: assert.fail } };
    await bridge.handlers.get("model_select")!(event, gatewayContext);
    bridge.restoreActiveTools(["read", "mcp__t3-code__task_status"]);
    await bridge.handlers.get("session_tree")!(event, gatewayContext);
    assert.deepEqual(bridge.getActiveTools(), [
      "read",
      "mcp__t3-code__task_status",
      "tool_search",
      "mcp__t3-code__orchestrator_capabilities",
      "mcp__t3-code__preview_snapshot",
    ]);
    await bridge.handlers.get("model_select")!(event, discoveryContext);
    assert.equal(
      bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot")?.exposure,
      "deferred",
    );
    assert.include(bridge.getActiveTools(), "mcp__t3-code__preview_snapshot");
  });

  it.each(["legacy Pi", "disabled tool search"])(
    "keeps tool execution available with %s",
    async (mode) => {
      const bridge = await loadMcpBridge({
        modern: mode !== "legacy Pi",
        toolSearchAvailable: mode === "disabled tool search",
        toolSearchDisabled: mode === "disabled tool search",
      });
      if (mode !== "legacy Pi") {
        const start = bridge.handlers.get("session_start");
        await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
      }
      assert.equal(bridge.tools.filter((tool) => tool.exposure !== "hidden").length, 4);
      assert.isTrue(
        bridge.tools
          .filter((tool) => tool.exposure !== "hidden")
          .every((tool) => tool.exposure === undefined || tool.exposure === "direct"),
      );
      const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot");
      assert.isDefined(tool);
      const controller = new AbortController();
      const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.strictEqual(bridge.transports.at(-1)?.signal, controller.signal);
      assert.equal(bridge.transports.at(-1)?.url, "http://fixture.invalid/mcp");
      assert.equal(bridge.transports.at(-1)?.authorization, "Bearer fixture-token");
      assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1))), {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { depth: 2 } },
      });
      assert.isUndefined(tool?.promptSnippet);
      assert.isUndefined(tool?.promptGuidelines);
    },
  );
});

describe("Pi MCP tool schemas", () => {
  it.each([{ type: "object" }, {}])(
    "declares empty properties on object schemas that omit them: %j",
    async (inputSchema) => {
      const bridge = await loadMcpBridge({ inputSchema });
      assert.isAbove(bridge.tools.length, 0);
      for (const tool of bridge.tools) {
        assert.deepEqual(tool.parameters, { type: "object", properties: {} });
      }
    },
  );

  it("keeps declared properties and other schema keywords", async () => {
    const inputSchema = {
      type: "object",
      properties: { depth: { type: "number" } },
      required: ["depth"],
      additionalProperties: false,
    };
    const bridge = await loadMcpBridge({ inputSchema });
    for (const tool of bridge.tools) {
      assert.deepEqual(tool.parameters, inputSchema);
    }
  });
});

describe("Pi tool discovery permissions", () => {
  it.each(["approval-required", "auto-accept-edits", "auto"])(
    "allows annotated T3 reads in %s while gating mutations and replacements",
    async (runtimeMode) => {
      const bridge = await loadMcpBridge({ modern: true, runtimeMode });
      const hook = bridge.handlers.get("tool_call") as unknown as (
        event: { toolName: string; input: unknown },
        ctx: { ui: { confirm: (title: string) => Promise<boolean> } },
      ) => Promise<{ block: true; reason: string } | undefined>;
      const confirmations: string[] = [];
      const ctx = {
        ui: {
          confirm: async (title: string) => {
            confirmations.push(title);
            return false;
          },
        },
      };
      for (const prefix of ["mcp__t3-code__", "mcp__t3_code__"]) {
        assert.isUndefined(
          await hook({ toolName: prefix + "orchestrator_capabilities", input: {} }, ctx),
        );
        assert.equal(
          (await hook({ toolName: prefix + "delegate_task", input: {} }, ctx))?.block,
          true,
        );
        assert.equal(
          (await hook({ toolName: prefix + "task_status", input: {} }, ctx))?.block,
          true,
        );
      }
      assert.equal(confirmations.length, 4);
      bridge.setBridgeSourcePath("/user/extensions/replacement.ts");
      assert.equal(
        (await hook({ toolName: "mcp__t3-code__orchestrator_capabilities", input: {} }, ctx))
          ?.block,
        true,
      );
      assert.equal(
        (await hook({ toolName: "mcp__other__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(confirmations.length, 6);
    },
  );

  it("allows discovery without confirmation and still gates the discovered tool", async () => {
    type ToolCallHook = (
      event: { toolName: string; input: unknown },
      ctx: {
        signal: AbortSignal;
        ui: {
          confirm: (
            title: string,
            detail: string,
            options: { signal: AbortSignal },
          ) => Promise<boolean>;
        };
      },
    ) => Promise<{ block: true; reason: string } | undefined>;
    let toolCall: ToolCallHook | undefined;
    let searchPath = "builtin:tool-search";
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env: { T3_PI_RUNTIME_MODE: "approval-required" } },
      pi: {
        on: (name: string, handler: ToolCallHook) => {
          if (name === "tool_call") toolCall = handler;
        },
        getAllTools: () => [{ name: "tool_search", sourceInfo: { path: searchPath } }],
      },
    });
    assert.isDefined(toolCall);
    const confirmations: string[] = [];
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      ui: {
        confirm: async (title: string, _detail: string, options: { signal: AbortSignal }) => {
          assert.strictEqual(options.signal, controller.signal);
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(
      await toolCall!({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
    );
    assert.equal(confirmations.length, 0);
    const result = await toolCall!({ toolName: "mcp__t3-code__preview_snapshot", input: {} }, ctx);
    assert.equal(result?.block, true);
    assert.deepEqual(confirmations, ["Allow mcp__t3-code__preview_snapshot?"]);

    searchPath = "/extensions/custom-search.ts";
    const replaced = await toolCall!({ toolName: "tool_search", input: {} }, ctx);
    assert.equal(replaced?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");
  });
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

async function loadInputHook(commands: ReadonlyArray<SkillCommand>) {
  const handlers = await loadHooks(commands);
  const hook = handlers.get("input");
  assert.isDefined(hook);
  return hook as InputHook;
}

describe("Pi skill references", () => {
  it("loads every selected skill once while preserving inline prose, whitespace, and images", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const alpha = NodePath.join(directory, "alpha.md");
      const beta = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(alpha, "ALPHA_INSTRUCTIONS");
      await NodeFSP.writeFile(beta, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: alpha } },
        { name: "skill:beta", source: "skill", sourceInfo: { path: beta } },
      ]);
      const text =
        "Please use the $alpha philosophy, then $beta and $alpha\n```ts\n  const x = 1;\n```";
      const images = [{ type: "image", data: "fixture" }];
      const result = await hook({ text, images }, { ui: { notify: assert.fail } });
      assert.equal(result?.action, "transform");
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.equal(result?.text.split("ALPHA_INSTRUCTIONS").length, 2);
      assert.equal(result?.text.split("BETA_INSTRUCTIONS").length, 2);
      assert.include(result?.text ?? "", `References are relative to ${directory}.`);
      assert.strictEqual(result?.images, images);
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("leaves unknown references and native skill commands for Pi", async () => {
    const hook = await loadInputHook([
      { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
    ]);
    for (const text of [
      "Explain $HOME",
      "/skill:alpha use $alpha",
      "Hello",
      "$missing",
      "Use $alpha, then continue",
      "Use ($alpha)",
    ]) {
      assert.isUndefined(await hook({ text }, { ui: { notify: assert.fail } }));
    }
  });

  it("loads additional chips without duplicating a leading native skill", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(path, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
        { name: "skill:beta", source: "skill", sourceInfo: { path } },
      ]);
      const text = "/skill:alpha use $alpha and $beta";
      const result = await hook({ text }, { ui: { notify: assert.fail } });
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.notInclude(result?.text ?? "", '<skill name="alpha"');
      assert.include(result?.text ?? "", "BETA_INSTRUCTIONS");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("reports an unreadable skill without deleting its reference or other selected instructions", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "readable.md");
      await NodeFSP.writeFile(path, "READABLE_INSTRUCTIONS");
      const hook = await loadInputHook([
        {
          name: "skill:missing",
          source: "skill",
          sourceInfo: { path: NodePath.join(directory, "missing.md") },
        },
        { name: "skill:readable", source: "skill", sourceInfo: { path } },
      ]);
      const notices: string[] = [];
      const text = "Use $missing and $readable";
      const result = await hook(
        { text },
        {
          ui: {
            notify: (message) => {
              notices.push(message);
            },
          },
        },
      );
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.include(result?.text ?? "", "READABLE_INSTRUCTIONS");
      assert.equal(notices.length, 1);
      assert.include(notices[0] ?? "", "Could not load skill missing");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });
});

const BACKGROUND_TASK_SNAPSHOT = "interop.v1.background-tasks.snapshot";
const BACKGROUND_TASK_REFRESH = "interop.v1.state.request";
const BACKGROUND_TASK_WIDGET = "t3:background-tasks:v1";
const TASKS_SNAPSHOT = "interop.v1.tasks.snapshot";
const TASKS_WIDGET = "t3:tasks:v1";

describe("Pi background task transport", () => {
  const running = {
    schemaVersion: 1,
    tasks: [
      {
        id: "bg-1",
        command: "npm test",
        startTime: 1_700_000_000_000,
        status: "running",
        outputBytes: 12,
        lastOutputAt: 1_700_000_000_100,
      },
    ],
  };
  const progress = {
    schemaVersion: 1,
    tasks: [
      {
        id: "bg-1",
        command: "npm test",
        startTime: 1_700_000_000_000,
        status: "running",
        outputBytes: 128,
        lastOutputAt: 1_700_000_000_250,
        checkCount: 2,
        note: "still reading the suite",
      },
    ],
  };
  const terminal = {
    schemaVersion: 1,
    tasks: [
      {
        id: "bg-1",
        command: "npm test",
        startTime: 1_700_000_000_000,
        status: "completed",
        outputBytes: 128,
        lastOutputAt: 1_700_000_000_250,
      },
    ],
  };
  const taskBoard = {
    schemaVersion: 1,
    tasks: [{ id: "1", subject: "Build", status: "pending", owner: "strip-me" }],
  };
  const taskEdit = {
    schemaVersion: 1,
    tasks: [{ id: "1", subject: "Build", status: "in_progress", activeForm: "Building" }],
  };
  const refresh = { schemaVersion: 1, requester: "t3-code" };

  function widgetLine(snapshot: object) {
    return [BACKGROUND_TASK_WIDGET, [JSON.stringify(snapshot)]] as const;
  }

  function taskLine(snapshot: object) {
    return [TASKS_WIDGET, [JSON.stringify(snapshot)]] as const;
  }

  it("requests the current RPC snapshot and forwards later snapshots once", async () => {
    const bridge = await loadMcpBridge();
    const requests: unknown[] = [];
    let current: object = running;
    let currentTasks: object = taskBoard;
    bridge.events.on(BACKGROUND_TASK_REFRESH, (payload) => {
      requests.push(payload);
      bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, current);
      bridge.events.emit(TASKS_SNAPSHOT, currentTasks);
    });
    const start = bridge.handlers.get("session_start")!;
    const shutdown = bridge.handlers.get("session_shutdown")!;
    const open = (mode: "rpc" | "tui") => {
      const calls: Array<readonly [string, readonly string[] | undefined]> = [];
      return {
        calls,
        ctx: {
          mode,
          model: { api: "anthropic-messages" },
          ui: {
            notify: () => undefined,
            setWidget: (key: string, content: readonly string[] | undefined) => {
              calls.push([key, content]);
            },
          },
        },
      };
    };

    const first = open("rpc");
    await start({ systemPrompt: "" }, first.ctx);
    assert.deepEqual(requests, [refresh]);
    assert.deepEqual(first.calls, [widgetLine(running), taskLine(taskBoard)]);

    bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, progress);
    const circular: Record<string, unknown> = { schemaVersion: 1, tasks: [] };
    circular.self = circular;
    bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, circular);
    bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, terminal);
    bridge.events.emit(TASKS_SNAPSHOT, taskEdit);
    bridge.events.emit(TASKS_SNAPSHOT, circular);
    assert.deepEqual(first.calls, [
      widgetLine(running),
      taskLine(taskBoard),
      widgetLine(progress),
      widgetLine(terminal),
      taskLine(taskEdit),
    ]);

    current = progress;
    currentTasks = taskEdit;
    const second = open("rpc");
    await start({ systemPrompt: "" }, second.ctx);
    assert.deepEqual(requests, [refresh, refresh]);
    assert.deepEqual(first.calls, [
      widgetLine(running),
      taskLine(taskBoard),
      widgetLine(progress),
      widgetLine(terminal),
      taskLine(taskEdit),
    ]);
    assert.deepEqual(second.calls, [widgetLine(progress), taskLine(taskEdit)]);
    bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, terminal);
    bridge.events.emit(TASKS_SNAPSHOT, taskBoard);
    assert.deepEqual(second.calls, [
      widgetLine(progress),
      taskLine(taskEdit),
      widgetLine(terminal),
      taskLine(taskBoard),
    ]);
    assert.equal(first.calls.length, 5);

    await shutdown({ systemPrompt: "" }, { ui: { notify: () => undefined } });
    bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, running);
    bridge.events.emit(TASKS_SNAPSHOT, taskEdit);
    assert.equal(first.calls.length, 5);
    assert.equal(second.calls.length, 4);

    current = running;
    currentTasks = taskBoard;
    const restarted = open("rpc");
    await start({ systemPrompt: "" }, restarted.ctx);
    assert.deepEqual(requests, [refresh, refresh, refresh]);
    assert.deepEqual(restarted.calls, [widgetLine(running), taskLine(taskBoard)]);
    assert.equal(first.calls.length, 5);
    assert.equal(second.calls.length, 4);

    const interactive = open("tui");
    await start({ systemPrompt: "" }, interactive.ctx);
    bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, terminal);
    bridge.events.emit(TASKS_SNAPSHOT, taskEdit);
    assert.deepEqual(requests, [refresh, refresh, refresh]);
    assert.deepEqual(interactive.calls, []);
    assert.equal(restarted.calls.length, 2);
  });

  it.each(["tui", "print", "json"] as const)(
    "does not request or forward snapshots in %s mode",
    async (mode) => {
      const bridge = await loadMcpBridge();
      const requests: unknown[] = [];
      bridge.events.on(BACKGROUND_TASK_REFRESH, (payload) => {
        requests.push(payload);
      });
      const calls: unknown[] = [];
      await bridge.handlers.get("session_start")!(
        { systemPrompt: "" },
        {
          mode,
          ui: {
            notify: () => undefined,
            setWidget: (...args: unknown[]) => {
              calls.push(args);
            },
          },
        },
      );
      bridge.events.emit(BACKGROUND_TASK_SNAPSHOT, {
        schemaVersion: 1,
        tasks: [{ id: "bg-1", command: "npm test", startTime: 1, status: "running" }],
      });
      bridge.events.emit(TASKS_SNAPSHOT, {
        schemaVersion: 1,
        tasks: [{ id: "1", subject: "Build", status: "pending" }],
      });
      assert.deepEqual(requests, []);
      assert.deepEqual(calls, []);
    },
  );
});
