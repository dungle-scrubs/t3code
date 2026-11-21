// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off extendsNativeError:off - An unattended host job that drives git, ssh and codesign directly.
// Nightly fork sync, run by fleetq on the mini: merge upstream/main into
// production, typecheck, build, sign with the Developer ID, push, and install
// on every machine. A merge conflict or failed check changes no machine and
// hands off to graybox, which reports to the Owner on Telegram.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const HOME = NodeOS.homedir();
const STATE_DIR = NodePath.join(HOME, ".local/state/t3code-fork-sync");
const STATE_FILE = NodePath.join(STATE_DIR, "state.json");
const APP_NAME = "T3 Code (Beta).app";
const IDENTITY = "Developer ID Application: Kevin Frilot (LBA643YFCL)";
const GRAYBOX = NodePath.join(HOME, "dev/graybox/bin/graybox");
// Failures a code change can fix: graybox resolves, verifies and pushes these itself.
const PUSH_STEPS = new Set(["merge", "deps", "typecheck", "build"]);
const LOCAL_MACHINE = process.env.FORK_SYNC_LOCAL ?? "mini";
const MACHINES = (process.env.FORK_SYNC_MACHINES ?? "air,pro,mini").split(",").map((m) => m.trim());
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_INSTALL = process.argv.includes("--skip-install");
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
];
const MINUTE = 60_000;

// The upstream signed build needs a passkey provisioning profile we do not
// have; these are its entitlements minus the profile-bound ones.
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
    <key>com.apple.security.cs.disable-library-validation</key><true/>
    <key>com.apple.security.device.camera</key><true/>
    <key>com.apple.security.device.audio-input</key><true/>
  </dict>
</plist>
`;

interface State {
  lastHandoffKey?: string;
}

interface Refs {
  originMain: string;
  upstreamMain: string;
}

type Outcome =
  | { kind: "up-to-date" }
  | { kind: "installed"; commit: string; results: Record<string, string> }
  | { kind: "handoff"; reason: string };

class StepFailed extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

const runId = new Date().toISOString().replaceAll(":", "").replace(/\..+/, "");
NodeFS.mkdirSync(NodePath.join(STATE_DIR, "runs"), { recursive: true });
const logPath = NodePath.join(STATE_DIR, "runs", `${runId}.log`);
const logFd = NodeFS.openSync(logPath, "a");

function say(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  NodeFS.writeSync(logFd, `${stamped}\n`);
}

function run(
  step: string,
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    allowFail?: boolean;
    timeoutMs?: number;
  } = {},
): { status: number; stdout: string } {
  NodeFS.writeSync(logFd, `$ ${command} ${args.join(" ")}\n`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? 10 * MINUTE,
    killSignal: "SIGKILL",
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  NodeFS.writeSync(logFd, out);
  if (result.error) NodeFS.writeSync(logFd, `${String(result.error)}\n`);
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFail) {
    const why = result.error ? String(result.error) : `exited ${String(status)}`;
    throw new StepFailed(step, `${command} ${args.join(" ")}: ${why}`);
  }
  return { status, stdout: (result.stdout ?? "").trim() };
}

const git = (step: string, ...args: string[]) => run(step, "git", args).stdout;

function logTail(lines: number): string {
  NodeFS.fsyncSync(logFd);
  return NodeFS.readFileSync(logPath, "utf8").split("\n").slice(-lines).join("\n");
}

function readState(): State {
  try {
    return JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

function writeState(state: State) {
  NodeFS.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function fetchRefs(): Refs {
  git("fetch", "fetch", "--quiet", "origin", "main");
  git("fetch", "fetch", "--quiet", "upstream", "main");
  return {
    originMain: git("fetch", "rev-parse", "origin/main"),
    upstreamMain: git("fetch", "rev-parse", "upstream/main"),
  };
}

/** Leaves production at origin/main and returns that commit, or throws without touching it. */
function prepareCheckout(originMain: string): string {
  if (git("checkout", "status", "--porcelain").length > 0) {
    throw new StepFailed("checkout", `${REPO} has uncommitted changes`);
  }
  if (git("checkout", "rev-parse", "--abbrev-ref", "HEAD") !== "production") {
    throw new StepFailed("checkout", `${REPO} is not on the production branch`);
  }
  const head = git("checkout", "rev-parse", "HEAD");
  if (head !== originMain) {
    const behind = run("checkout", "git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
      allowFail: true,
    });
    if (behind.status !== 0) {
      throw new StepFailed("checkout", "local production has commits origin/main does not");
    }
    git("checkout", "merge", "--ff-only", "--quiet", "origin/main");
  }
  return originMain;
}

function mergeUpstream(): boolean {
  const merged = run("merge", "git", ["merge-base", "--is-ancestor", "upstream/main", "HEAD"], {
    allowFail: true,
  });
  if (merged.status === 0) return false;
  const result = run("merge", "git", ["merge", "--no-edit", "upstream/main"], { allowFail: true });
  if (result.status !== 0) {
    const conflicts = git("merge", "diff", "--name-only", "--diff-filter=U");
    run("merge", "git", ["merge", "--abort"], { allowFail: true });
    throw new StepFailed("merge", `merging upstream/main conflicts in:\n${conflicts}`);
  }
  return true;
}

function buildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Either variable bakes an update feed into the app, and the updater would
  // then replace this build with an official release.
  delete env.GITHUB_REPOSITORY;
  delete env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
  delete env.T3CODE_DESKTOP_SIGNED;
  return env;
}

function vp(step: string, ...args: string[]) {
  const bin = NodePath.join(REPO, "node_modules/.bin/vp");
  if (!NodeFS.existsSync(bin)) {
    run(step, "pnpm", ["install", "--frozen-lockfile"], {
      env: buildEnv(),
      timeoutMs: 20 * MINUTE,
    });
  }
  run(step, bin, args, { env: buildEnv(), timeoutMs: 30 * MINUTE });
}

function findApp(dir: string): string | undefined {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory() && entry.name === APP_NAME) return full;
    if (entry.isDirectory() && !entry.name.endsWith(".app")) {
      const found = findApp(full);
      if (found) return found;
    }
  }
  return undefined;
}

async function buildSigned(commit: string): Promise<string> {
  const buildDir = NodePath.join(STATE_DIR, "builds", commit);
  const zipPath = NodePath.join(buildDir, `${commit}.zip`);
  if (NodeFS.existsSync(zipPath)) return zipPath;
  NodeFS.rmSync(buildDir, { recursive: true, force: true });
  const outDir = NodePath.join(buildDir, "out");
  NodeFS.mkdirSync(outDir, { recursive: true });

  say("installing dependencies");
  vp("deps", "i");
  say("typechecking");
  vp("typecheck", "run", "typecheck");
  say("building the desktop app");
  run(
    "build",
    "node",
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "zip",
      "--arch",
      "arm64",
      "--output-dir",
      outDir,
    ],
    { env: buildEnv(), timeoutMs: 45 * MINUTE },
  );

  let app = findApp(outDir);
  if (!app) {
    const zip = NodeFS.readdirSync(outDir).find((name) => name.endsWith("-arm64.zip"));
    if (!zip) throw new StepFailed("build", `no ${APP_NAME} or zip in ${outDir}`);
    const unpacked = NodePath.join(buildDir, "unpacked");
    run("build", "ditto", ["-x", "-k", NodePath.join(outDir, zip), unpacked]);
    app = findApp(unpacked);
    if (!app) throw new StepFailed("build", `${zip} holds no ${APP_NAME}`);
  }

  say("signing with the Developer ID");
  const entitlements = NodePath.join(buildDir, "entitlements.plist");
  NodeFS.writeFileSync(entitlements, ENTITLEMENTS);
  const signDir = NodeFS.readdirSync(NodePath.join(REPO, "node_modules/.pnpm")).find((name) =>
    name.startsWith("@electron+osx-sign@2."),
  );
  if (!signDir) throw new StepFailed("sign", "@electron/osx-sign 2.x is not installed");
  const osxSign = (await import(
    NodePath.join(
      REPO,
      "node_modules/.pnpm",
      signDir,
      "node_modules/@electron/osx-sign/dist/index.js",
    )
  )) as { sign: (options: Record<string, unknown>) => Promise<void> };
  try {
    await osxSign.sign({
      app,
      identity: IDENTITY,
      platform: "darwin",
      preAutoEntitlements: false,
      batchCodesignCalls: true,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
    });
  } catch (error) {
    throw new StepFailed("sign", String(error));
  }
  run("sign", "codesign", ["--verify", "--deep", "--strict", app], { timeoutMs: 20 * MINUTE });
  const details = NodeChildProcess.spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr;
  if (!details.includes(`Authority=${IDENTITY}`)) {
    throw new StepFailed("sign", `${APP_NAME} is not signed by ${IDENTITY}`);
  }
  run("sign", "ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zipPath]);
  NodeFS.rmSync(outDir, { recursive: true, force: true });
  NodeFS.rmSync(NodePath.join(buildDir, "unpacked"), { recursive: true, force: true });
  pruneBuilds(commit);
  return zipPath;
}

function pruneBuilds(keep: string) {
  const builds = NodePath.join(STATE_DIR, "builds");
  for (const entry of NodeFS.readdirSync(builds)) {
    if (entry !== keep)
      NodeFS.rmSync(NodePath.join(builds, entry), { recursive: true, force: true });
  }
}

// Runs on the target Mac. Matches processes by the literal bundle path: the
// parentheses in the app name are special in a regex.
const INSTALL_SCRIPT = String.raw`
set -u
commit="$1"; zip="$2"; identity="$3"
app="/Applications/T3 Code (Beta).app"
root="$HOME/.local/share/t3-updates"
staged="$root/$commit/staged"
previous="$root/previous"
marker="$root/installed-commit"
# Pro ran the app from the production worktree before installs moved to /Applications.
legacy="$HOME/.local/share/worktrees/t3code/production/release/mac-arm64/T3 Code (Beta).app"
running_at() { ps -axo comm= | grep -F -- "$1/Contents/" >/dev/null; }
running() { running_at "$app" || running_at "$legacy"; }
main_running() { ps -axo comm= | grep -F -x -- "$app/Contents/MacOS/T3 Code (Beta)" >/dev/null; }

if [ "$(cat "$marker" 2>/dev/null)" = "$commit" ]; then echo "INSTALL_RESULT already"; exit 0; fi
rm -rf "$staged"; mkdir -p "$staged" "$previous"
ditto -x -k "$zip" "$staged" || { echo "INSTALL_RESULT unpack-failed"; exit 1; }
new="$staged/T3 Code (Beta).app"
codesign --verify --deep --strict "$new" || { echo "INSTALL_RESULT signature-invalid"; exit 1; }
codesign -dv "$new" 2>&1 | grep -F -- "Authority=$identity" >/dev/null || { echo "INSTALL_RESULT wrong-signer"; exit 1; }

was_running=0
legacy_was_running=0
if running_at "$legacy"; then legacy_was_running=1; fi
if running; then
  was_running=1
  # Telling an app that is not running to quit would launch it first.
  for path in "$app" "$legacy"; do
    if running_at "$path"; then
      osascript -e "tell application (POSIX file \"$path\" as text) to quit" >/dev/null 2>&1
    fi
  done
  for _ in $(seq 1 120); do running || break; sleep 1; done
  if running; then echo "INSTALL_RESULT old-app-still-running"; exit 1; fi
fi

# Puts the old app back, and reopens it only if it was running before.
restore() {
  if [ -e "$previous/T3 Code (Beta).app" ]; then
    mv "$previous/T3 Code (Beta).app" "$app" || return 1
    if [ "$was_running" = 1 ]; then open "$app"; fi
  elif [ "$legacy_was_running" = 1 ]; then
    open "$legacy"
  fi
  rm -rf "$staged"
}

rm -rf "$previous/T3 Code (Beta).app"
if [ -e "$app" ]; then mv "$app" "$previous/" || { echo "INSTALL_RESULT move-old-failed"; exit 1; }; fi
mv "$new" "$app" || { restore; echo "INSTALL_RESULT move-new-failed"; exit 1; }
open "$app"
for _ in $(seq 1 60); do main_running && break; sleep 1; done
sleep 15
if ! main_running; then
  rm -rf "$root/$commit/failed.app"; mv "$app" "$root/$commit/failed.app"
  if restore; then echo "INSTALL_RESULT new-app-did-not-start-rolled-back"; else echo "INSTALL_RESULT new-app-did-not-start-restore-failed"; fi
  exit 1
fi
echo "$commit" > "$marker"
rm -rf "$root/$commit"
echo "INSTALL_RESULT installed"
`;

function installOn(machine: string, commit: string, zipPath: string): string {
  const local = machine === LOCAL_MACHINE;
  let zip = zipPath;
  if (!local) {
    const reach = run(
      "install",
      "ssh",
      [...SSH_OPTIONS, machine, "mkdir -p ~/.local/share/t3-updates"],
      {
        allowFail: true,
      },
    );
    if (reach.status !== 0) return "unreachable";
    zip = `.local/share/t3-updates/${commit}.zip`;
    const copied = run("install", "scp", ["-q", ...SSH_OPTIONS, zipPath, `${machine}:${zip}`], {
      allowFail: true,
      timeoutMs: 20 * MINUTE,
    });
    if (copied.status !== 0) return "copy-failed";
    zip = `$HOME/${zip}`;
  }
  const args = ["-s", "--", commit, zip, IDENTITY];
  const result = local
    ? run("install", "bash", args, { input: INSTALL_SCRIPT, allowFail: true })
    : run(
        "install",
        "ssh",
        [...SSH_OPTIONS, machine, `bash -s -- ${commit} "${zip}" '${IDENTITY}'`],
        { input: INSTALL_SCRIPT, allowFail: true },
      );
  const marker = result.stdout.split("\n").find((line) => line.startsWith("INSTALL_RESULT "));
  if (!local)
    run("install", "ssh", [...SSH_OPTIONS, machine, `rm -f "${zip}"`], { allowFail: true });
  return marker
    ? marker.slice("INSTALL_RESULT ".length)
    : `no-result (exit ${String(result.status)})`;
}

function handoff(step: string, reason: string, key: string, refs: Refs) {
  const state = readState();
  if (state.lastHandoffKey === key) {
    say(`same failure as the last handoff (${key}); not handing off again`);
    return;
  }
  const push = PUSH_STEPS.has(step) && refs.upstreamMain !== "unknown";
  const what =
    step === "install"
      ? "The nightly fork sync built and pushed production, but installing it failed on some machines. Machines that report installed or already are fine; a failed machine was rolled back where it could be."
      : `The nightly fork sync stopped at the ${step} step. It pushed nothing and changed no machine.`;
  const todo =
    step === "install"
      ? "Find out why the install failed on each failed machine from its INSTALL_RESULT in the log, and fix the cause. The next nightly run retries every machine that is not on the new commit."
      : push
        ? `Merge upstream/main (${refs.upstreamMain}) into origin/main (${refs.originMain}) in the Ticket's worktree and resolve every conflict, keeping each fork commit's behavior; upstream wins only where the fork has no intent of its own. If a fork-sync/failed-* branch is named above, it holds the merged state that failed later; start from it. In the worktree run \`vp i\`, then \`vp run typecheck\` (through \`mise exec node@26 --\` if the default node is refused); both must pass and belong in the Ticket's checks. Commit the result there. Do not push, build or install the app, and do not touch the checkout below: graybox pushes the verified candidate to origin/main, and the next nightly run builds and installs it.`
        : "Find out what stopped the sync from the log and fix the cause. If it is in the fork's code, specify the fix as a commit on origin/main; otherwise say what the Owner must do.";
  // graybox refuses a request over 20,000 characters; the log tail below takes up to 8,000.
  const message = `${what}

${reason.length > 6_000 ? `${reason.slice(0, 6_000)}\n[cut; the full reason is in the log]` : reason}

Checkout: ${REPO} (branch production, tracks origin/main on dungle-scrubs/t3code).
origin/main: ${refs.originMain}
upstream/main: ${refs.upstreamMain}
Full log: ${logPath}

${todo}

Last log lines:
\`\`\`
${logTail(60).slice(-8_000)}
\`\`\``;
  if (DRY_RUN) {
    say(`dry run: would hand off to graybox${push ? " with a push target" : ""}:\n${message}`);
    return;
  }
  const result = run(
    "handoff",
    GRAYBOX,
    [
      "handoff",
      "--project",
      REPO,
      "--title",
      `Fork sync stopped: ${step}`,
      ...(push ? ["--push", "origin/main", "--contains", refs.upstreamMain] : []),
    ],
    { input: message, allowFail: true, timeoutMs: MINUTE },
  );
  if (result.status === 0) {
    say(`handed off to graybox: ${result.stdout}`);
    writeState({ ...state, lastHandoffKey: key });
  } else {
    // The key stays unset, so the next night hands off again.
    say(
      `could not hand off to graybox (exit ${String(result.status)}); its output is in the log above`,
    );
  }
}

async function main(): Promise<Outcome> {
  say(`fork sync ${runId} in ${REPO}${DRY_RUN ? " (dry run)" : ""}`);
  let refs: Refs = { originMain: "unknown", upstreamMain: "unknown" };
  let commitBefore: string | undefined;
  try {
    refs = fetchRefs();
    commitBefore = prepareCheckout(refs.originMain);
    const merged = mergeUpstream();
    const commit = git("merge", "rev-parse", "HEAD");
    say(
      merged
        ? `merged upstream/main into production as ${commit}`
        : `production ${commit} already has upstream/main`,
    );
    if (SKIP_INSTALL && !merged) return { kind: "up-to-date" };

    const zipPath = await buildSigned(commit);
    say(`signed build ${zipPath}`);

    if (merged) {
      if (DRY_RUN) {
        say("dry run: not pushing; resetting production to origin/main");
        git("checkout", "reset", "--hard", "--quiet", commitBefore);
      } else {
        git("push", "push", "--quiet", "origin", "production:main");
        say("pushed production to origin/main");
      }
    }
    if (SKIP_INSTALL || DRY_RUN) return { kind: "installed", commit, results: {} };

    const results: Record<string, string> = {};
    for (const machine of MACHINES) {
      say(`installing on ${machine}`);
      results[machine] = installOn(machine, commit, zipPath);
      say(`${machine}: ${results[machine]}`);
    }
    const failed = Object.entries(results).filter(
      ([, result]) => !["installed", "already", "unreachable"].includes(result),
    );
    if (failed.length > 0) {
      handoff(
        "install",
        `Installing ${commit} failed: ${JSON.stringify(results)}`,
        `install:${commit}:${failed.map(([machine]) => machine).join(",")}`,
        { ...refs, originMain: commit },
      );
      return { kind: "handoff", reason: "install" };
    }
    return { kind: "installed", commit, results };
  } catch (error) {
    const step = error instanceof StepFailed ? error.step : "internal";
    let reason =
      error instanceof StepFailed
        ? error.message
        : String(error instanceof Error ? (error.stack ?? error) : error);
    say(`${step} failed: ${reason}`);
    if (commitBefore !== undefined) {
      // Never leave production off origin/main: every later night would stop at the checkout.
      run("cleanup", "git", ["merge", "--abort"], { allowFail: true });
      const head = run("cleanup", "git", ["rev-parse", "HEAD"], { allowFail: true }).stdout;
      if (head !== commitBefore) {
        const branch = `fork-sync/failed-${runId}`;
        const saved = run("cleanup", "git", ["branch", "--force", branch, head], {
          allowFail: true,
        });
        if (saved.status === 0)
          reason += `\n\nThe merged state that failed is on local branch ${branch}.`;
      }
      const reset = run("cleanup", "git", ["reset", "--hard", "--quiet", commitBefore], {
        allowFail: true,
      });
      if (reset.status !== 0) reason += "\n\nResetting production to origin/main failed too.";
    }
    handoff(step, reason, `${step}:${refs.originMain}`, refs);
    return { kind: "handoff", reason: step };
  }
}

const outcome = await main();
say(`done: ${JSON.stringify(outcome)} log ${logPath}`);
process.exit(outcome.kind === "handoff" ? 1 : 0);
