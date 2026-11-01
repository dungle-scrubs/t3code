import { ForkCheckoutSyncError, type ForkCheckoutSyncResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

/** This build syncs only the personal fork. An upstream checkout keeps the release updater. */
const FORK_REMOTE = "dungle-scrubs/t3code";
const BUILD_TIMEOUT = Duration.minutes(20);

interface CheckoutPath {
  readonly resolve: (path: string) => string;
  readonly dirname: (path: string) => string;
  readonly join: (left: string, ...parts: ReadonlyArray<string>) => string;
}

export function forkCheckoutCandidate(
  input: {
    readonly envCheckout: string | undefined;
    readonly moduleDir: string | undefined;
    readonly exists: (path: string) => boolean;
  },
  path: CheckoutPath,
): string | null {
  const envCheckout = input.envCheckout?.trim();
  if (envCheckout !== undefined && envCheckout !== "") {
    const root = path.resolve(envCheckout);
    return input.exists(path.join(root, ".git")) ? root : null;
  }
  if (input.moduleDir === undefined) return null;
  let current = path.resolve(input.moduleDir);
  for (let depth = 0; depth < 12; depth++) {
    if (input.exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

const failed = (reason: string, cause?: unknown) =>
  cause === undefined
    ? new ForkCheckoutSyncError({ reason })
    : new ForkCheckoutSyncError({ reason, cause });

/** The checkout named by T3_FORK_CHECKOUT, or the git root that contains this server. */
const locateForkCheckout = Effect.fn("cloud.forkCheckoutSync.locate")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const envCheckout = process.env.T3_FORK_CHECKOUT?.trim();
  if (envCheckout !== undefined && envCheckout !== "") {
    const root = path.resolve(envCheckout);
    return (yield* fs.exists(path.join(root, ".git")).pipe(Effect.orElseSucceed(() => false)))
      ? root
      : null;
  }
  const moduleDir = import.meta.dirname;
  if (moduleDir === undefined) return null;
  let current = path.resolve(moduleDir);
  for (let depth = 0; depth < 12; depth++) {
    const found = yield* fs
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (found) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
});

/** True when this process is running from the personal fork checkout. */
export const forkCheckoutSyncAvailable = Effect.fn("cloud.forkCheckoutSync.available")(
  function* () {
    const checkout = yield* locateForkCheckout();
    if (checkout === null) return false;
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner
      .run({
        command: "git",
        args: ["remote", "get-url", "origin"],
        cwd: checkout,
        timeout: Duration.seconds(5),
      })
      .pipe(Effect.orElseSucceed(() => null));
    return result !== null && result.code === 0 && result.stdout.includes(FORK_REMOTE);
  },
);

/** The first line that names an error, or else the end of the output; build stacks bury the cause. */
const failureDetail = (text: string) => {
  const trimmed = text.trim();
  const errorLine = trimmed
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^\w*Error\b/.test(line));
  if (errorLine !== undefined) return errorLine.slice(0, 500);
  return trimmed.length <= 500 ? trimmed : trimmed.slice(trimmed.length - 500);
};

/** Pulls `origin/main` in the fork checkout and rebuilds the desktop app when HEAD moves. */
export const syncForkCheckout = Effect.fn("cloud.forkCheckoutSync")(function* (checkout: string) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const run = (command: string, args: ReadonlyArray<string>, timeout?: Duration.Duration) =>
    runner
      .run({
        command,
        args,
        cwd: checkout,
        ...(timeout === undefined ? {} : { timeout }),
      })
      .pipe(Effect.mapError((cause) => failed(`Could not run ${command}.`, cause)));

  const finished = (result: ProcessRunner.ProcessRunOutput, command: string) => {
    if (result.timedOut) return Effect.fail(failed(`${command} timed out.`));
    if (result.code !== 0) {
      const detail = failureDetail(result.stderr || result.stdout);
      return Effect.fail(
        failed(detail === "" ? `${command} failed.` : `${command} failed: ${detail}`),
      );
    }
    return Effect.succeed(result.stdout.trim());
  };

  const origin = yield* finished(
    yield* run("git", ["remote", "get-url", "origin"]),
    "git remote get-url origin",
  );
  if (!origin.includes(FORK_REMOTE)) {
    return yield* failed(`This checkout's origin is not ${FORK_REMOTE}.`);
  }

  const before = yield* finished(yield* run("git", ["rev-parse", "HEAD"]), "git rev-parse HEAD");
  yield* finished(
    yield* run("git", ["pull", "--ff-only", "origin", "main"]),
    "git pull --ff-only origin main",
  );
  const after = yield* finished(yield* run("git", ["rev-parse", "HEAD"]), "git rev-parse HEAD");
  if (before === after) {
    return { before, after, built: false } satisfies ForkCheckoutSyncResult;
  }

  const platform = yield* HostProcess.Platform;
  const vp = path.join(checkout, "node_modules", ".bin", platform === "win32" ? "vp.cmd" : "vp");
  const vpExists = yield* fs
    .exists(vp)
    .pipe(Effect.mapError((cause) => failed("Could not check for vp.", cause)));
  if (!vpExists) {
    return yield* failed(`vp is missing in ${checkout}. Run vp i there first.`);
  }
  // A pull that brings upstream changes often changes dependencies too.
  yield* finished(yield* run(vp, ["i"], BUILD_TIMEOUT), "vp i");
  yield* finished(yield* run(vp, ["run", "build:desktop"], BUILD_TIMEOUT), "vp run build:desktop");
  return { before, after, built: true } satisfies ForkCheckoutSyncResult;
});

export const syncThisForkCheckout = Effect.fn("cloud.forkCheckoutSync.this")(function* () {
  const checkout = yield* locateForkCheckout();
  if (checkout === null) {
    return yield* failed(
      "No fork checkout was found. Set T3_FORK_CHECKOUT to the checkout root, or start the server from it.",
    );
  }
  return yield* syncForkCheckout(checkout);
});
