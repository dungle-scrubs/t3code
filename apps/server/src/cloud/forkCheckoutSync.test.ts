import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { forkCheckoutCandidate, syncForkCheckout } from "./forkCheckoutSync.ts";
import * as ProcessRunner from "../processRunner.ts";

const path = {
  resolve: (value: string) => (value.startsWith("/") ? value : `/${value}`),
  dirname: (value: string) => value.split("/").slice(0, -1).join("/") || "/",
  join: (left: string, ...parts: ReadonlyArray<string>) =>
    [left, ...parts].join("/").replaceAll(/\/{2,}/g, "/"),
};

const output = (stdout: string, code: number = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it("uses T3_FORK_CHECKOUT when that directory is a git checkout", () => {
  const exists = (path: string) => path === "/work/t3code/.git";
  expect(
    forkCheckoutCandidate(
      {
        envCheckout: "/work/t3code",
        moduleDir: "/elsewhere",
        exists,
      },
      path,
    ),
  ).toBe("/work/t3code");
  expect(
    forkCheckoutCandidate(
      {
        envCheckout: "/work/missing",
        moduleDir: "/work/t3code/apps/server/dist",
        exists,
      },
      path,
    ),
  ).toBeNull();
});

it("walks from the server module to the checkout root", () => {
  const exists = (path: string) => path === "/work/t3code/.git";
  expect(
    forkCheckoutCandidate(
      {
        envCheckout: undefined,
        moduleDir: "/work/t3code/apps/server/dist",
        exists,
      },
      path,
    ),
  ).toBe("/work/t3code");
});

it.effect("pulls origin/main and rebuilds when HEAD moves", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-sync-" });
    const vp = path.join(checkout, "node_modules", ".bin", "vp");
    yield* fs.makeDirectory(path.dirname(vp), { recursive: true });
    yield* fs.writeFileString(vp, "");
    const heads = ["aaa", "bbb"];
    const commands: Array<ReadonlyArray<string>> = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push([input.command, ...input.args]);
          if (input.args[0] === "remote") {
            return output("git@github.com:dungle-scrubs/t3code.git\n");
          }
          if (input.args[0] === "rev-parse") return output(`${heads.shift()}\n`);
          return output("");
        }),
    });

    const result = yield* syncForkCheckout(checkout).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );

    expect(result).toEqual({ before: "aaa", after: "bbb", built: true });
    expect(commands.map((command) => command.slice(1))).toEqual([
      ["remote", "get-url", "origin"],
      ["rev-parse", "HEAD"],
      ["pull", "--ff-only", "origin", "main"],
      ["rev-parse", "HEAD"],
      ["run", "build:desktop"],
    ]);
    expect(commands[4]?.[0]).toBe(vp);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("skips the rebuild when origin/main is already checked out", () =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push(input.args[0] ?? input.command);
          if (input.args[0] === "remote")
            return output("https://github.com/dungle-scrubs/t3code\n");
          if (input.args[0] === "rev-parse") return output("abc\n");
          return output("");
        }),
    });

    const result = yield* syncForkCheckout("/tmp/t3code").pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );

    expect(result.built).toBe(false);
    expect(commands).toEqual(["remote", "rev-parse", "pull", "rev-parse"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not pull a checkout whose origin is upstream", () =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push(input.args.join(" "));
          return output("git@github.com:pingdotgg/t3code.git\n");
        }),
    });

    const error = yield* syncForkCheckout("/tmp/t3code").pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.flip,
    );

    expect(error.reason).toContain("dungle-scrubs/t3code");
    expect(commands).toEqual(["remote get-url origin"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("stops when the fast-forward pull fails", () =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push(input.args[0] ?? "");
          if (input.args[0] === "remote")
            return output("git@github.com:dungle-scrubs/t3code.git\n");
          if (input.args[0] === "rev-parse") return output("abc\n");
          return {
            ...output(""),
            code: ChildProcessSpawner.ExitCode(1),
            stderr: "Not possible to fast-forward",
          };
        }),
    });

    const error = yield* syncForkCheckout("/tmp/t3code").pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.flip,
    );

    expect(error.reason).toContain("fast-forward");
    expect(commands).toEqual(["remote", "rev-parse", "pull"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
