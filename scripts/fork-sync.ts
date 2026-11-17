// Nightly fork sync, run by fleetq on the mini: merge upstream/main into
// production, typecheck, build, sign with the Developer ID, push, and install
// on every machine. A merge conflict or failed check changes no machine and
// opens a T3 thread for an agent.
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
const T3_CLI = NodePath.join(HOME, ".t3/bin/t3");
const LOCAL_MACHINE = process.env.FORK_SYNC_LOCAL ?? "mini";
const MACHINES = (process.env.FORK_SYNC_MACHINES ?? "air,pro,mini").split(",").map((m) => m.trim());
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_INSTALL = process.argv.includes("--skip-install");

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
  lastHandoff?: { reason: string; originMain: string; upstreamMain: string };
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; allowFail?: boolean } = {},
): { status: number; stdout: string } {
  NodeFS.writeSync(logFd, `$ ${command} ${args.join(" ")}\n`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  NodeFS.writeSync(logFd, out);
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFail) {
    throw new StepFailed(step, `${command} ${args.join(" ")} exited ${String(status)}`);
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

function prepareCheckout(): { originMain: string; upstreamMain: string } {
  git("fetch", "fetch", "--quiet", "origin", "main");
  git("fetch", "fetch", "--quiet", "upstream", "main");
  if (git("checkout", "status", "--porcelain").length > 0) {
    throw new StepFailed("checkout", `${REPO} has uncommitted changes`);
  }
  if (git("checkout", "rev-parse", "--abbrev-ref", "HEAD") !== "production") {
    throw new StepFailed("checkout", `${REPO} is not on the production branch`);
  }
  const originMain = git("checkout", "rev-parse", "origin/main");
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
  return { originMain, upstreamMain: git("checkout", "rev-parse", "upstream/main") };
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
  if (!NodeFS.existsSync(bin))
    run(step, "pnpm", ["install", "--frozen-lockfile"], { env: buildEnv() });
  run(step, bin, args, { env: buildEnv() });
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
  vp("install", "i");
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
    { env: buildEnv() },
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
  const signDir = fs
    .readdirSync(NodePath.join(REPO, "node_modules/.pnpm"))
    .find((name) => name.startsWith("@electron+osx-sign@2."));
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
      optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
    });
  } catch (error) {
    throw new StepFailed("sign", String(error));
  }
  run("sign", "codesign", ["--verify", "--deep", "--strict", app]);
  const details = NodeChildProcess.spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr;
  if (!details.includes(`Authority=${IDENTITY}`)) {
    throw new StepFailed("sign", `${APP_NAME} is not signed by ${IDENTITY}`);
  }
  run("sign", "ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zipPath]);
  NodeFS.rmSync(outDir, { recursive: true, force: true });
  NodeFS.rmSync(NodePath.join(buildDir, "unpacked"), { recursive: true, force: true });
  return zipPath;
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
running() { ps -axo comm= | grep -F -- "$app/Contents/" >/dev/null; }
main_running() { ps -axo comm= | grep -F -x -- "$app/Contents/MacOS/T3 Code (Beta)" >/dev/null; }

if [ "$(cat "$marker" 2>/dev/null)" = "$commit" ]; then echo "INSTALL_RESULT already"; exit 0; fi
rm -rf "$staged"; mkdir -p "$staged" "$previous"
ditto -x -k "$zip" "$staged" || { echo "INSTALL_RESULT unpack-failed"; exit 1; }
new="$staged/T3 Code (Beta).app"
codesign --verify --deep --strict "$new" || { echo "INSTALL_RESULT signature-invalid"; exit 1; }
codesign -dv "$new" 2>&1 | grep -F -- "Authority=$identity" >/dev/null || { echo "INSTALL_RESULT wrong-signer"; exit 1; }

if running; then
  osascript -e "tell application (POSIX file \"$app\" as text) to quit" >/dev/null 2>&1
  for _ in $(seq 1 120); do running || break; sleep 1; done
  if running; then echo "INSTALL_RESULT old-app-still-running"; exit 1; fi
fi

rm -rf "$previous/T3 Code (Beta).app"
if [ -e "$app" ]; then mv "$app" "$previous/" || { echo "INSTALL_RESULT move-old-failed"; exit 1; }; fi
mv "$new" "$app" || { mv "$previous/T3 Code (Beta).app" "$app"; open "$app"; echo "INSTALL_RESULT move-new-failed"; exit 1; }
open "$app"
for _ in $(seq 1 60); do main_running && break; sleep 1; done
sleep 15
if ! main_running; then
  rm -rf "$root/$commit/failed.app"; mv "$app" "$root/$commit/failed.app"
  mv "$previous/T3 Code (Beta).app" "$app"; open "$app"
  echo "INSTALL_RESULT new-app-did-not-start-rolled-back"; exit 1
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
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        machine,
        "mkdir -p ~/.local/share/t3-updates",
      ],
      {
        allowFail: true,
      },
    );
    if (reach.status !== 0) return "unreachable";
    zip = `.local/share/t3-updates/${commit}.zip`;
    const copied = run(
      "install",
      "scp",
      ["-q", "-o", "BatchMode=yes", zipPath, `${machine}:${zip}`],
      {
        allowFail: true,
      },
    );
    if (copied.status !== 0) return "copy-failed";
    zip = `$HOME/${zip}`;
  }
  const args = ["-s", "--", commit, zip, IDENTITY];
  const result = local
    ? run("install", "bash", args, { input: INSTALL_SCRIPT, allowFail: true })
    : run(
        "install",
        "ssh",
        ["-o", "BatchMode=yes", machine, `bash -s -- ${commit} "${zip}" '${IDENTITY}'`],
        { input: INSTALL_SCRIPT, allowFail: true },
      );
  const marker = result.stdout.split("\n").find((line) => line.startsWith("INSTALL_RESULT "));
  if (!local)
    run("install", "ssh", ["-o", "BatchMode=yes", machine, `rm -f "${zip}"`], { allowFail: true });
  return marker
    ? marker.slice("INSTALL_RESULT ".length)
    : `no-result (exit ${String(result.status)})`;
}

function handoff(reason: string, step: string, refs: { originMain: string; upstreamMain: string }) {
  const state = readState();
  const last = state.lastHandoff;
  if (last && last.reason === step && last.originMain === refs.originMain) {
    say(`origin/main has not moved since the last ${step} handoff; not opening another thread`);
    return;
  }
  const message = `The nightly fork sync stopped at the ${step} step and changed no machine.

${reason}

Checkout: ${REPO} (branch production, tracks origin/main on dungle-scrubs/t3code).
origin/main: ${refs.originMain}
upstream/main: ${refs.upstreamMain}
Full log: ${logPath}

Merge upstream/main into production in that checkout and fix what stopped the sync. Keep every fork commit's behavior; upstream wins only where the fork has no intent of its own. Then run \`vp run typecheck\`, commit, and push with \`git push origin production:main\`. Do not build or install the app: the next nightly run does that.

Last log lines:
\`\`\`
${logTail(60)}
\`\`\``;
  if (DRY_RUN) {
    say(`dry run: would open a handoff thread:\n${message}`);
    return;
  }
  const result = run(
    "handoff",
    T3_CLI,
    ["thread", "start", "--title", `Fork sync stopped: ${step}`, REPO, "-"],
    {
      input: message,
      allowFail: true,
    },
  );
  if (result.status !== 0) {
    say(`could not open the handoff thread (exit ${String(result.status)}); see ${logPath}`);
    return;
  }
  say(`opened handoff thread ${result.stdout}`);
  writeState({ ...state, lastHandoff: { reason: step, ...refs } });
}

async function main(): Promise<Outcome> {
  say(`fork sync ${runId} in ${REPO}${DRY_RUN ? " (dry run)" : ""}`);
  const refs = prepareCheckout();
  const commitBefore = git("checkout", "rev-parse", "HEAD");
  try {
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
    return { kind: "installed", commit, results };
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    say(`${error.step} failed: ${error.message}`);
    const head = git("checkout", "rev-parse", "HEAD");
    let reason = error.message;
    if (head !== commitBefore) {
      const branch = `fork-sync/failed-${runId}`;
      git("checkout", "branch", "--force", branch, head);
      git("checkout", "reset", "--hard", "--quiet", commitBefore);
      reason += `\n\nThe merged state that failed is on local branch ${branch}.`;
    }
    handoff(reason, error.step, refs);
    return { kind: "handoff", reason: error.step };
  }
}

const outcome = await main();
const installFailed =
  outcome.kind === "installed" &&
  Object.values(outcome.results).some((r) => !["installed", "already", "unreachable"].includes(r));
if (outcome.kind === "installed" && installFailed) {
  handoff(`Installing ${outcome.commit} failed: ${JSON.stringify(outcome.results)}`, "install", {
    originMain: outcome.commit,
    upstreamMain: git("checkout", "rev-parse", "upstream/main"),
  });
}
say(`done: ${JSON.stringify(outcome)} log ${logPath}`);
process.exit(outcome.kind === "handoff" || installFailed ? 1 : 0);
