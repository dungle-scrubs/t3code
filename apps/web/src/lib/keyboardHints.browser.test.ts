import { EnvironmentId, ThreadId, type RepositoryIdentity } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createElement, Fragment } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { ActiveProjectTarget } from "../hooks/useActiveProjectTarget";

const hintCommands = vi.hoisted(() => ({
  target: null as ActiveProjectTarget | null,
  openLink: vi.fn(async (_url: string, _options?: unknown) => undefined),
  pullRequestsSupported: false,
  preferences: {
    involvement: "all" as "all" | "reviewing" | "authored",
    state: "open" as "all" | "open" | "closed" | "merged",
  },
}));

function setup() {
  hintCommands.target = null;
  hintCommands.openLink = vi.fn(async () => undefined);
  hintCommands.pullRequestsSupported = false;
  hintCommands.preferences = { involvement: "all", state: "open" };
}

vi.mock("../hooks/useActiveProjectTarget", () => ({
  useActiveProjectTarget: () => hintCommands.target,
}));

vi.mock("../browser/useOpenLink", () => ({
  useOpenLink: () => hintCommands.openLink,
}));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePullRequestsSupported: () => hintCommands.pullRequestsSupported,
}));

vi.mock(import("../components/pullRequest/pullRequestListPreferences"), async (original) => ({
  ...(await original()),
  readPullRequestListPreferences: () => hintCommands.preferences,
}));

import { act, render } from "../../test/render";
import "../index.css";
import { KeyboardHints } from "../components/KeyboardHints";
import { Popover, PopoverTrigger, PopoverPopup } from "../components/ui/popover";
import {
  collectHintTargets,
  createKeyboardHintsController,
  KEYBOARD_HINT_ISSUES_KEY,
  KEYBOARD_HINT_PULL_REQUESTS_KEY,
  type KeyboardHintsState,
} from "./keyboardHints";

function setupFixture(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return {
    root,
    element: <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!,
    [Symbol.dispose]() {
      root.remove();
    },
  };
}

type HintFixture = ReturnType<typeof setupFixture>;

function setupController(
  onChange: (state: KeyboardHintsState) => void = () => {},
  options?: Parameters<typeof createKeyboardHintsController>[2],
) {
  const controller = createKeyboardHintsController(document, onChange, options);
  return Object.assign(controller, { [Symbol.dispose]: () => controller.dispose() });
}

function visibleButtonGrid(count: number) {
  const columns = 26;
  const buttons = Array.from(
    { length: count },
    (_, index) =>
      `<button id="hint-grid-${index}" style="width:10px;height:10px;padding:0;border:0;margin:0"></button>`,
  ).join("");
  return `<div style="position:fixed;top:0;left:0;display:grid;grid-template-columns:repeat(${columns},12px);width:${columns * 12}px">${buttons}</div>`;
}

function projectTarget(projectName: string, canonicalKey: string): ActiveProjectTarget {
  const environmentId = EnvironmentId.make("env");
  const repositoryIdentity: RepositoryIdentity = {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://user:secret@github.com/from/locator.git",
    },
  };
  return {
    environmentId,
    cwd: "/repo",
    projectName,
    threadRef: scopeThreadRef(environmentId, ThreadId.make(projectName)),
    repositoryIdentity,
  };
}

function keydown(key: string, options: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

const TRIGGER = { key: " ", code: "Space", ctrlKey: true, shiftKey: true };

// No transition here: its first frame would still read opaque after the reveal ends.
const HOVER_ROW = `<div id="row" data-keyboard-hint-reveal="" class="opacity-0 group-hover:opacity-100">
  <button id="hover-action">Copy</button>
</div>`;

const opacity = (element: HTMLElement) => getComputedStyle(element).opacity;

// The label text starts 6px into this button, where its hint badge starts.
const TEXT_BUTTON = "padding:0 6px;border:0";

describe("keyboard hint targets", () => {
  it("labels the visible controls and skips the hidden, disabled and inert ones", () => {
    using fixture = setupFixture(`
      <button id="one">One</button>
      <button id="two" disabled>Two</button>
      <div id="menu-action" role="menuitem" tabindex="-1">Menu action</div>
      <div id="container" tabindex="-1">Layout container</div>
      <div inert><button id="three">Three</button></div>
      <button id="four" style="display: none">Four</button>
      <div aria-hidden="true"><button id="five">Five</button></div>
      <button id="six" style="opacity: 0">Six</button>
      <div style="opacity: 0"><button id="seven">Seven</button></div>
      <button id="skipped" data-keyboard-hint-skip="">Skipped</button>
      <button id="draggable" draggable="true">Draggable</button>
      <div id="skipped-parent" role="button" tabindex="0" data-keyboard-hint-skip="">
        <span id="nested-action" role="button" tabindex="0">Nested</span>
      </div>
    `);

    const targets = collectHintTargets(document).filter((target) => fixture.root.contains(target));

    expect(targets.map((target) => target.id)).toEqual([
      "one",
      "menu-action",
      "draggable",
      "nested-action",
    ]);
  });

  it("keeps the hints inside the modal that is open", () => {
    using fixture = setupFixture(`
      <button id="outside">Outside</button>
      <div role="dialog" aria-modal="true"><button id="inside">Inside</button></div>
    `);

    const targets = collectHintTargets(document).filter((target) => fixture.root.contains(target));

    expect(targets.map((target) => target.id)).toEqual(["inside"]);
  });

  it("skips a control that another element covers", () => {
    using fixture = setupFixture(`
      <button id="under">Under</button>
      <div style="position: fixed; inset: 0; background: white"></div>
    `);

    const targets = collectHintTargets(document).filter((target) => fixture.root.contains(target));

    expect(targets.map((target) => target.id)).toEqual([]);
  });

  it("omits the scoped action only while focus is inside that scope", () => {
    using fixture = setupFixture(`
      <div id="panel" tabindex="-1">
        <button id="selected" data-keyboard-hint-focus-scope-id="panel">Selected</button>
        <button id="inactive">Inactive</button>
        <button id="close">Close</button>
        <input id="inside" style="width:80px;height:24px" />
      </div>
      <input id="outside" style="width:80px;height:24px" />
      <button id="missing" data-keyboard-hint-focus-scope-id="missing-scope">Missing</button>
      <button id="empty" data-keyboard-hint-focus-scope-id="">Empty</button>
    `);
    const ids = () =>
      collectHintTargets(document)
        .filter((target) => fixture.root.contains(target))
        .map((target) => target.id);

    expect(ids()).toEqual(
      expect.arrayContaining([
        "selected",
        "inactive",
        "close",
        "inside",
        "outside",
        "missing",
        "empty",
      ]),
    );

    fixture.element("inside").focus();
    const internal = ids();
    expect(internal).not.toContain("selected");
    expect(internal).toEqual(expect.arrayContaining(["inactive", "close", "missing", "empty"]));

    fixture.element("panel").focus();
    expect(document.activeElement).toBe(fixture.element("panel"));
    const panelFocused = ids();
    expect(panelFocused).not.toContain("selected");
    expect(panelFocused).toEqual(
      expect.arrayContaining(["inactive", "close", "inside", "outside", "missing", "empty"]),
    );

    fixture.element("outside").focus();
    const external = ids();
    expect(external).toContain("selected");
    expect(external).toEqual(
      expect.arrayContaining(["inactive", "close", "inside", "missing", "empty"]),
    );
  });
});

// Every target sits in a 40px row at (40, 40) with 10px start padding, so a 16px icon spans
// x 50..66 and y 52..68, and the first text line starts at x 50 and centres on y 60.
const PLACEMENT_ROW =
  "display:flex;align-items:center;height:40px;padding:0 10px;border:0;margin:0";
const ICON = `<svg aria-hidden="true" width="16" height="16" style="display:block;flex:none"></svg>`;
const placed = (markup: string) => `<div style="position:fixed;left:40px;top:40px">${markup}</div>`;

describe("keyboard hint placement", () => {
  it.each([
    [
      "covers a persistent icon",
      placed(`<button id="one" style="${PLACEMENT_ROW}">${ICON}</button>`),
      { placement: "center", left: 58, top: 60 },
    ],
    [
      "covers the icon before a persistent label",
      placed(`<button id="one" style="${PLACEMENT_ROW}">${ICON}Settle</button>`),
      { placement: "center", left: 58, top: 60 },
    ],
    [
      "starts at the text before a trailing caret",
      placed(`<button id="one" style="${PLACEMENT_ROW}"><span>Title</span>${ICON}</button>`),
      { placement: "text-start", left: 50, top: 60 },
    ],
    [
      "starts at plain text",
      placed(`<button id="one" style="${PLACEMENT_ROW}">Text</button>`),
      { placement: "text-start", left: 50, top: 60 },
    ],
    [
      "starts at the text inside a padded field",
      placed(
        `<input id="one" placeholder="Search" style="box-sizing:border-box;width:120px;height:40px;padding:0 12px;border:2px solid;margin:0" />`,
      ),
      { placement: "text-start", left: 54, top: 60 },
    ],
    [
      "sits below a hover-only icon",
      placed(
        `<div data-keyboard-hint-reveal="" class="opacity-0"><button id="one" style="${PLACEMENT_ROW}">${ICON}</button></div>`,
      ),
      { placement: "below", left: 58, top: 72 },
    ],
  ] as const)("%s", (_case, markup, expected) => {
    using _fixture = setupFixture(markup);
    using controller = setupController();
    controller.handleKeyDown(keydown(" ", TRIGGER));

    const target = controller.state.targets.find((candidate) => candidate.element.id === "one")!;
    expect(target.placement).toBe(expected.placement);
    expect(target.left).toBeCloseTo(expected.left, 0);
    expect(target.top).toBeCloseTo(expected.top, 0);
  });

  it("puts a hover-only hint above when the viewport has no room below", () => {
    using _fixture = setupFixture(
      `<div style="position:fixed;left:40px;bottom:0" data-keyboard-hint-reveal="" class="opacity-0"><button id="one" style="${PLACEMENT_ROW}">${ICON}</button></div>`,
    );
    using controller = setupController();
    controller.handleKeyDown(keydown(" ", TRIGGER));

    const target = controller.state.targets.find((candidate) => candidate.element.id === "one")!;
    // The icon spans innerHeight-28..innerHeight-12; 4px below it leaves no 16px badge plus 4px margin.
    expect(target.placement).toBe("above");
    expect(target.left).toBeCloseTo(58, 0);
    expect(target.top).toBeCloseTo(window.innerHeight - 28 - 4 - 16, 0);
  });

  it.each([false, true])(
    "keeps the command guide clear of the composer and heading (hero: %s)",
    (hero) => {
      using _fixture = setupFixture(`
      <div data-workspace-area="composer" style="position:fixed;inset:0">
        <div data-chat-composer-stack style="position:absolute;left:100px;top:200px;width:280px">
          ${hero ? '<div data-chat-composer-heading style="position:absolute;bottom:100%;width:280px;height:50px">Heading</div>' : ""}
          <form data-chat-composer-form="true" style="width:280px;height:80px"></form>
        </div>
      </div>
    `);
      using controller = setupController();
      controller.handleKeyDown(keydown(" ", TRIGGER));

      expect(controller.state.commandGuidePosition).toEqual({
        bottom: window.innerHeight - (hero ? 150 : 200) + 8,
        right: window.innerWidth - 380,
      });
    },
  );
});

describe("keyboard hint mode", () => {
  it("opens on the trigger chord and activates the labelled target", () => {
    using fixture = setupFixture(`
      ${HOVER_ROW}
      <div data-keyboard-hint-reveal="" class="opacity-0" inert><button id="inert-action">Inert</button></div>
    `);
    const row = fixture.element("row");
    const opacityAtClick: string[] = [];
    fixture
      .element("hover-action")
      .addEventListener("click", () => opacityAtClick.push(opacity(row)));
    const states: KeyboardHintsState[] = [];
    using controller = setupController((state) => states.push(state));
    expect(opacity(row)).toBe("0");

    expect(controller.handleKeyDown(keydown(" ", TRIGGER))).toBe(true);
    expect(controller.state.active).toBe(true);
    expect(opacity(row)).toBe("1");
    const ids = controller.state.targets.map((target) => target.element.id);
    expect(ids).toContain("hover-action");
    expect(ids).not.toContain("inert-action");
    const label = controller.state.targets.find(
      (target) => target.element.id === "hover-action",
    )!.label;

    expect(controller.handleKeyDown(keydown(label))).toBe(true);

    expect(opacityAtClick).toEqual(["1"]);
    expect(controller.state.active).toBe(false);
    expect(states.at(-1)?.active).toBe(false);
    expect(opacity(row)).toBe("0");

    controller.handleKeyDown(keydown(" ", TRIGGER));
    const reopenedLabel = controller.state.targets.find(
      (target) => target.element.id === "hover-action",
    )!.label;
    // Synchronous: the skip marker lands before the mutation observer can deliver it.
    fixture.element("hover-action").setAttribute("data-keyboard-hint-skip", "");
    controller.handleKeyDown(keydown(reopenedLabel));

    expect(opacityAtClick).toEqual(["1"]);
    expect(controller.state.active).toBe(false);
  });

  it.each([
    ["input", `<input id="field" style="width:80px;height:24px" />`, false],
    ["textarea", `<textarea id="field" style="width:80px;height:24px"></textarea>`, false],
    [
      "contenteditable=true",
      `<div id="field" contenteditable="true" style="width:80px;height:24px"><span id="nested" role="button" tabindex="0" contenteditable="false" style="display:inline-block;width:10px;height:10px"></span></div>`,
      true,
    ],
    [
      "plaintext-only",
      `<div id="field" contenteditable="plaintext-only" style="width:80px;height:24px"></div>`,
      false,
    ],
  ] as const)("focuses a text field without typing into it (%s)", (_variant, markup, nested) => {
    using fixture = setupFixture(`${markup}<button id="attach">Attach</button>`);
    const field = fixture.element("field");
    const clicks = vi.fn();
    field.addEventListener("click", clicks);
    const idsIn = (elements: readonly HTMLElement[]) =>
      elements.filter((target) => fixture.root.contains(target)).map((target) => target.id);

    const unfocused = idsIn(collectHintTargets(document));
    expect(unfocused).toContain("field");
    expect(unfocused).toContain("attach");
    if (nested) expect(unfocused).not.toContain("nested");

    using controller = setupController();
    controller.handleKeyDown(keydown(" ", TRIGGER));
    const label = controller.state.targets.find((target) => target.element.id === "field")?.label;
    expect(label).toBeTruthy();
    controller.handleKeyDown(keydown(label!));

    expect(document.activeElement).toBe(field);
    expect(
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.value
        : field.textContent,
    ).toBe("");
    expect(clicks).not.toHaveBeenCalled();

    const focused = idsIn(collectHintTargets(document));
    expect(focused).not.toContain("field");
    expect(focused).toContain("attach");
    if (nested) expect(focused).toContain("nested");

    fixture.element("attach").focus();
    const returned = idsIn(collectHintTargets(document));
    expect(returned).toContain("field");
    expect(returned).toContain("attach");
    if (nested) expect(returned).not.toContain("nested");
  });

  it("cancels on Escape without activating anything", () => {
    using fixture = setupFixture(`<button id="one">One</button>${HOVER_ROW}`);
    const clicks = vi.fn();
    fixture.element("one").addEventListener("click", clicks);
    using controller = setupController();

    controller.handleKeyDown(keydown(" ", TRIGGER));
    expect(opacity(fixture.element("row"))).toBe("1");
    expect(controller.handleKeyDown(keydown("Escape"))).toBe(true);

    expect(controller.state.active).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(opacity(fixture.element("row"))).toBe("0");
  });

  it("exits and swallows a key that matches no target", () => {
    using _fixture = setupFixture(`<button id="one">One</button>`);
    using controller = setupController();

    controller.handleKeyDown(keydown(" ", TRIGGER));
    expect(controller.handleKeyDown(keydown("z"))).toBe(true);

    expect(controller.state.active).toBe(false);
  });

  it("leaves modified shortcuts alone instead of activating their hint letter", () => {
    using fixture = setupFixture(`<button id="one">One</button>`);
    const clicks = vi.fn();
    fixture.element("one").addEventListener("click", clicks);
    using controller = setupController();
    controller.handleKeyDown(keydown(" ", TRIGGER));
    const label = controller.state.targets.find((target) => target.element.id === "one")!.label;

    expect(controller.handleKeyDown(keydown(label, { ctrlKey: true }))).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(controller.state.active).toBe(false);
    controller.dispose();
  });

  it("keeps a modifier release open", () => {
    using _fixture = setupFixture(`<button id="one">One</button>`);
    using controller = setupController();

    controller.handleKeyDown(keydown(" ", TRIGGER));
    expect(controller.handleKeyDown(keydown("Shift", { shiftKey: true }))).toBe(false);

    expect(controller.state.active).toBe(true);
  });

  it("removes the typed prefix on Backspace", () => {
    const buttons = Array.from(
      { length: 30 },
      (_, index) => `<button id="b${index}">B${index}</button>`,
    ).join("");
    using _fixture = setupFixture(
      `<div style="display: flex; flex-wrap: wrap; width: 380px">${buttons}</div>`,
    );
    using controller = setupController();

    controller.handleKeyDown(keydown(" ", TRIGGER));
    const target = controller.state.targets[0]!;
    expect(target.label).toHaveLength(2);

    controller.handleKeyDown(keydown(target.label[0]!));
    expect(controller.state.prefix).toBe(target.label[0]);

    controller.handleKeyDown(keydown("Backspace"));
    expect(controller.state.prefix).toBe("");
    expect(controller.state.active).toBe(true);

    expect(controller.handleKeyDown(keydown("Backspace"))).toBe(true);
    expect(controller.state.active).toBe(false);
  });

  const LAYOUT_CASES: readonly [string, string, (fixture: HintFixture) => void][] = [
    [
      "scroll",
      `<div id="container" style="position:fixed;left:40px;top:40px">
        <button id="one" style="${TEXT_BUTTON}">One</button>
      </div>`,
      (fixture) => {
        fixture.element("container").style.left = "100px";
        window.dispatchEvent(new Event("scroll"));
      },
    ],
    [
      "resize",
      `<div id="container" style="position:fixed;left:40px;top:40px">
        <button id="one" style="${TEXT_BUTTON}">One</button>
      </div>`,
      (fixture) => {
        fixture.element("container").style.left = "100px";
        window.dispatchEvent(new Event("resize"));
      },
    ],
    [
      "ancestor layout",
      `<div id="container" style="position:fixed;left:40px;top:40px">
        <button id="one" style="${TEXT_BUTTON}">One</button>
      </div>`,
      (fixture) => {
        fixture.element("container").style.left = "100px";
      },
    ],
    [
      "target update",
      `<div id="container" style="position:fixed;left:40px;top:40px">
        <button id="one" style="${TEXT_BUTTON}">One</button>
      </div>`,
      (fixture) => {
        fixture.element("one").classList.add("updated");
      },
    ],
    [
      "target text",
      `<div id="container" style="position:fixed;left:40px;top:40px">
        <button id="one" style="${TEXT_BUTTON}">One</button>
      </div>`,
      (fixture) => {
        fixture.element("one").textContent = "One updated";
      },
    ],
    [
      "sibling resize",
      `<div id="container" style="position:fixed;left:40px;top:40px;display:flex">
        <div id="spacer" style="width:10px;height:10px"></div>
        <button id="one" style="${TEXT_BUTTON}">One</button>
      </div>`,
      (fixture) => {
        fixture.element("spacer").style.width = "40px";
      },
    ],
    [
      "nested scroll",
      `<div id="scroller" style="position:fixed;left:40px;top:40px;width:120px;height:80px;overflow:auto">
        <div style="width:400px;height:400px"><button id="one" style="${TEXT_BUTTON}">One</button></div>
      </div>`,
      (fixture) => {
        fixture.element("scroller").scrollLeft = 20;
      },
    ],
  ];

  it.each(LAYOUT_CASES)("keeps labels attached after %s", async (_change, markup, apply) => {
    using fixture = setupFixture(markup);
    using controller = setupController();
    controller.handleKeyDown(keydown(" ", TRIGGER));
    const original = controller.state.targets.find((target) => target.element.id === "one")!;
    expect(original).toBeDefined();

    apply(fixture);
    // Let the mutation observer deliver the change before the assertions.
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(controller.state.active).toBe(true);
      const current = controller.state.targets.find((target) => target.element.id === "one")!;
      expect(current.label).toBe(original.label);
      expect(current.left).toBe(fixture.element("one").getBoundingClientRect().left + 6);
    });
  });

  it("follows the positioning anchor when it moves", async () => {
    using fixture = setupFixture(`
      <div id="anchor" style="position:fixed;left:40px;top:40px;width:20px;height:20px"></div>
      <button id="one" data-keyboard-hint-anchor-id="anchor" style="position:fixed;left:200px;top:200px">
        One
      </button>
    `);
    using controller = setupController();
    controller.handleKeyDown(keydown(" ", TRIGGER));
    const original = controller.state.targets.find((target) => target.element.id === "one")!;
    expect(original.left).toBe(50);

    fixture.element("anchor").style.left = "140px";

    await vi.waitFor(() => {
      expect(controller.state.active).toBe(true);
      const current = controller.state.targets.find((target) => target.element.id === "one")!;
      expect(current.label).toBe(original.label);
      expect(current.left).toBe(fixture.element("anchor").getBoundingClientRect().left + 10);
    });
  });

  it.each(["before", "during"] as const)(
    "follows a target when hint mode opens %s a CSS transition",
    async (timing) => {
      using fixture = setupFixture(`
        <div id="mover" style="position:fixed;left:40px;top:40px;transition:left 100s linear">
          <button id="one" style="${TEXT_BUTTON}">One</button>
        </div>
      `);
      using controller = setupController();
      const mover = fixture.element("mover");
      if (timing === "before") controller.handleKeyDown(keydown(" ", TRIGGER));
      expect(mover.getBoundingClientRect().left).toBe(40);
      mover.style.left = "140px";
      await vi.waitFor(() => {
        expect(mover.getBoundingClientRect().left).toBeGreaterThan(40);
      });
      const transition = mover.getAnimations()[0]!;
      expect(transition).toBeDefined();
      try {
        if (timing === "during") controller.handleKeyDown(keydown(" ", TRIGGER));
        const original = controller.state.targets.find((target) => target.element.id === "one")!;
        transition.currentTime = 50_000;

        await vi.waitFor(() => {
          expect(controller.state.active).toBe(true);
          const current = controller.state.targets.find((target) => target.element.id === "one")!;
          expect(current.label).toBe(original.label);
          expect(current.left).toBeGreaterThan(90);
          expect(current.left).toBeLessThan(110);
          expect(current.left).toBeCloseTo(
            fixture.element("one").getBoundingClientRect().left + 6,
            0,
          );
        });
        transition.finish();
        await vi.waitFor(() => {
          expect(controller.state.targets.find((target) => target.element.id === "one")!.left).toBe(
            146,
          );
        });
      } finally {
        transition.cancel();
      }
    },
  );

  it.each([
    ["removal", (element: HTMLElement) => element.remove()],
    ["hidden", (element: HTMLElement) => element.setAttribute("hidden", "")],
    ["disabled", (element: HTMLElement) => element.setAttribute("disabled", "")],
  ] as const)(
    "keeps the other labels and the prefix when a target is lost by %s",
    async (_case, loseTarget) => {
      using fixture = setupFixture(visibleButtonGrid(30));
      using controller = setupController();
      controller.handleKeyDown(keydown(" ", TRIGGER));
      const labels = new Map(
        controller.state.targets.map((target) => [target.element.id, target.label]),
      );

      expect(controller.handleKeyDown(keydown("a"))).toBe(true);
      expect(controller.state.prefix).toBe("a");

      loseTarget(fixture.element("hint-grid-0"));

      await vi.waitFor(() => {
        expect(controller.state.active).toBe(true);
        expect(controller.state.prefix).toBe("a");
        expect(controller.state.targets.map((target) => target.element.id)).not.toContain(
          "hint-grid-0",
        );
      });
      for (const target of controller.state.targets) {
        expect(target.label).toBe(labels.get(target.element.id));
      }
    },
  );

  it("labels the current controls again after a dismissal", () => {
    using fixture = setupFixture(visibleButtonGrid(30));
    using controller = setupController();
    controller.handleKeyDown(keydown(" ", TRIGGER));
    expect(controller.handleKeyDown(keydown("a"))).toBe(true);
    expect(controller.state.prefix).toBe("a");

    controller.dismiss();
    fixture.element("hint-grid-0").remove();
    const added = document.createElement("button");
    added.id = "hint-grid-new";
    added.textContent = "New";
    added.style.position = "fixed";
    added.style.left = "400px";
    added.style.top = "300px";
    added.style.width = "40px";
    added.style.height = "20px";
    fixture.root.append(added);

    controller.handleKeyDown(keydown(" ", TRIGGER));

    expect(controller.state.prefix).toBe("");
    const ids = controller.state.targets.map((target) => target.element.id);
    expect(ids).not.toContain("hint-grid-0");
    expect(ids).toContain("hint-grid-new");
  });

  it("stops answering after dispose", async () => {
    using fixture = setupFixture(`<button id="one">One</button>${HOVER_ROW}`);
    const changes = vi.fn();
    using controller = setupController(changes);

    controller.handleKeyDown(keydown(" ", TRIGGER));
    expect(opacity(fixture.element("row"))).toBe("1");
    controller.dispose();
    const afterDispose = changes.mock.calls.length;

    expect(opacity(fixture.element("row"))).toBe("0");
    expect(controller.handleKeyDown(keydown(" ", TRIGGER))).toBe(false);
    expect(controller.state.active).toBe(false);

    fixture.element("one").textContent = "One updated";
    window.dispatchEvent(new Event("resize"));
    await Promise.resolve();

    expect(changes).toHaveBeenCalledTimes(afterDispose);
  });
});

describe("keyboard hint commands", () => {
  it.each([KEYBOARD_HINT_ISSUES_KEY, KEYBOARD_HINT_PULL_REQUESTS_KEY])(
    "runs %s at the empty prefix with no targets and only after hint mode is dismissed",
    (command) => {
      using fixture = setupFixture(`<div id="empty"></div>`);
      let activeDuringAction = true;
      let preventedDuringAction = false;
      const event = keydown(command.toUpperCase());
      const resolveCommand = vi.fn(() => () => {
        activeDuringAction = controller.state.active;
        preventedDuringAction = event.defaultPrevented;
      });
      using controller = setupController(() => {}, { resolveCommand });

      controller.handleKeyDown(keydown(" ", TRIGGER));
      expect(
        controller.state.targets.filter((target) => fixture.root.contains(target.element)),
      ).toEqual([]);
      expect(controller.state.active).toBe(true);

      expect(controller.handleKeyDown(event)).toBe(true);

      expect(resolveCommand).toHaveBeenCalledWith(command);
      expect(activeDuringAction).toBe(false);
      expect(preventedDuringAction).toBe(true);
      expect(controller.state.active).toBe(false);
      const typed = keydown("x");
      expect(controller.handleKeyDown(typed)).toBe(false);
      expect(typed.defaultPrevented).toBe(false);
      const outside = keydown(command);
      expect(controller.handleKeyDown(outside)).toBe(false);
      expect(outside.defaultPrevented).toBe(false);
    },
  );

  it.each([KEYBOARD_HINT_ISSUES_KEY, KEYBOARD_HINT_PULL_REQUESTS_KEY])(
    "consumes an unavailable %s command and stays at the empty prefix",
    (command) => {
      using _fixture = setupFixture(`<button id="one">One</button>`);
      const resolveCommand = vi.fn(() => undefined);
      using controller = setupController(() => {}, { resolveCommand });

      controller.handleKeyDown(keydown(" ", TRIGGER));
      const event = keydown(command);
      expect(controller.handleKeyDown(event)).toBe(true);

      expect(resolveCommand).toHaveBeenCalledWith(command);
      expect(event.defaultPrevented).toBe(true);
      expect(controller.state.active).toBe(true);
      expect(controller.state.prefix).toBe("");
    },
  );

  it.each([KEYBOARD_HINT_ISSUES_KEY, KEYBOARD_HINT_PULL_REQUESTS_KEY])(
    "treats a%s as a target label",
    (command) => {
      using fixture = setupFixture(visibleButtonGrid(624));
      const clicks = vi.fn();
      const resolveCommand = vi.fn(() => undefined);
      using controller = setupController(() => {}, { resolveCommand });

      controller.handleKeyDown(keydown(" ", TRIGGER));
      const labels = controller.state.targets.map((target) => target.label);
      expect(
        labels.some(
          (label) =>
            label.startsWith(KEYBOARD_HINT_ISSUES_KEY) ||
            label.startsWith(KEYBOARD_HINT_PULL_REQUESTS_KEY),
        ),
      ).toBe(false);
      const match = controller.state.targets.find((target) => target.label === `a${command}`);
      expect(match?.element.id.startsWith("hint-grid-")).toBe(true);
      expect(fixture.root.contains(match!.element)).toBe(true);
      match!.element.addEventListener("click", clicks);

      expect(controller.handleKeyDown(keydown("a"))).toBe(true);
      expect(controller.state.prefix).toBe("a");
      expect(controller.state.active).toBe(true);
      expect(controller.handleKeyDown(keydown(command))).toBe(true);

      expect(resolveCommand).not.toHaveBeenCalled();
      expect(clicks).toHaveBeenCalledOnce();
      expect(controller.state.active).toBe(false);
    },
  );
});

describe("keyboard hints in the app", () => {
  it("filters displayed labels and opens a real popup through its hint", async () => {
    setup();
    using _fixture = setupFixture(
      `<div style="display:flex;flex-wrap:wrap;width:380px">${Array.from(
        { length: 30 },
        (_, index) => `<button>Target ${index}</button>`,
      ).join("")}</div>`,
    );
    await using _screen = await render(
      createElement(
        Fragment,
        null,
        createElement(KeyboardHints),
        createElement(
          "div",
          {
            id: "hint-popup-row",
            "data-keyboard-hint-reveal": "",
            className: "opacity-0 transition-opacity duration-200",
          },
          createElement(
            Popover,
            null,
            createElement(PopoverTrigger, { id: "hint-popup-trigger" }, "Open popup"),
            createElement(PopoverPopup, null, createElement("button", null, "Inside popup")),
          ),
        ),
      ),
      { router: "/" },
    );
    await act(async () => {
      window.dispatchEvent(keydown(" ", TRIGGER));
    });
    const overlay = document.querySelector("[data-keyboard-hints-overlay]")!;
    const label = overlay.querySelector(
      '[data-keyboard-hint-target="hint-popup-trigger"]',
    )!.textContent!;
    expect(label).toHaveLength(2);
    await act(async () => {
      window.dispatchEvent(keydown(label[0]!));
    });
    const remaining = Array.from(
      document.querySelectorAll("[data-keyboard-hints-overlay] span[style]"),
    );
    expect(remaining.length).toBeLessThan(30);
    expect(remaining.every((badge) => badge.textContent!.startsWith(label[0]!))).toBe(true);
    expect(
      remaining.every(
        (badge) => badge.querySelector("[data-keyboard-hint-prefix]")?.textContent === label[0],
      ),
    ).toBe(true);
    expect(opacity(document.getElementById("hint-popup-row")!)).toBe("1");
    await act(async () => {
      window.dispatchEvent(keydown(label[1]!));
    });
    await expect.element(page.getByRole("button", { name: "Inside popup" })).toBeVisible();
    expect(document.querySelector("[data-keyboard-hints-overlay]")).toBeNull();
  });

  it("takes the hint keys before the surfaces below them", async () => {
    setup();
    using fixture = setupFixture(`<button id="one">One</button>`);
    const clicks = vi.fn();
    fixture.element("one").addEventListener("click", clicks);
    await using _screen = await render(createElement(KeyboardHints), { router: "/" });
    const laterListener = vi.fn();
    window.addEventListener("keydown", laterListener);

    try {
      await act(async () => {
        window.dispatchEvent(keydown(" ", TRIGGER));
      });

      expect(laterListener).not.toHaveBeenCalled();
      const overlay = document.querySelector("[data-keyboard-hints-overlay]");
      expect(overlay).not.toBeNull();
      const badge = overlay!.querySelector('[data-keyboard-hint-target="one"]');
      expect(badge?.textContent).toBeTruthy();

      await act(async () => {
        window.dispatchEvent(keydown(badge!.textContent!));
      });

      expect(laterListener).not.toHaveBeenCalled();
      expect(clicks).toHaveBeenCalledOnce();
      expect(document.querySelector("[data-keyboard-hints-overlay]")).toBeNull();
    } finally {
      window.removeEventListener("keydown", laterListener);
    }
  });

  it("opens GitHub issues for the current project and then leaves typing alone", async () => {
    setup();
    const alpha = projectTarget("Alpha", "github.com/acme/alpha");
    const beta = projectTarget("Beta", "github.com/acme/beta");
    hintCommands.target = alpha;
    let hintsActiveDuringOpen = true;
    hintCommands.openLink.mockImplementation(() => {
      hintsActiveDuringOpen = document.documentElement.hasAttribute("data-keyboard-hints-active");
      return Promise.resolve(undefined);
    });
    using _fixture = setupFixture(visibleButtonGrid(30));
    await using screen = await render(createElement(KeyboardHints), { router: "/" });
    const guide = () => document.querySelector("[aria-label='Hint commands']");

    await act(async () => {
      window.dispatchEvent(keydown(" ", TRIGGER));
    });
    expect(guide()?.textContent ?? "").toContain("Alpha");

    hintCommands.target = beta;
    await screen.rerender(createElement(KeyboardHints));
    expect(guide()?.textContent ?? "").toContain("Beta");
    expect(guide()?.textContent ?? "").not.toContain("Alpha");

    const label = document.querySelector("[data-keyboard-hints-overlay] span[style]")!.textContent!;
    expect(label).toHaveLength(2);
    await act(async () => {
      window.dispatchEvent(keydown(label[0]!));
    });
    expect(guide()).toBeNull();
    expect(document.querySelector("[data-keyboard-hints-overlay]")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(keydown("Backspace"));
    });
    expect(guide()?.textContent ?? "").toContain("Beta");

    const later = vi.fn();
    window.addEventListener("keydown", later);
    try {
      await act(async () => {
        window.dispatchEvent(keydown("i"));
      });
      expect(later).not.toHaveBeenCalled();
      expect(hintsActiveDuringOpen).toBe(false);
      expect(hintCommands.openLink).toHaveBeenCalledTimes(1);
      expect(hintCommands.openLink).toHaveBeenCalledWith("https://github.com/acme/beta/issues", {
        target: "app",
        threadRef: beta.threadRef,
      });
      expect(document.querySelector("[data-keyboard-hints-overlay]")).toBeNull();

      const typed = keydown("x");
      await act(async () => {
        window.dispatchEvent(typed);
      });
      expect(later).toHaveBeenCalledOnce();
      expect(typed.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", later);
    }
  });

  it.each([
    {
      supported: true,
      detail: "opens saved pull request filters with no active project",
    },
    {
      supported: false,
      detail: "stays open without navigating when pull requests are unsupported",
    },
  ])("p $detail", async ({ supported }) => {
    setup();
    hintCommands.pullRequestsSupported = supported;
    await using screen = await render(createElement(KeyboardHints), { router: "/" });
    let hintsActiveDuringNavigate = true;
    using navigate = vi.spyOn(screen.router!, "navigate").mockImplementation(() => {
      hintsActiveDuringNavigate = document.documentElement.hasAttribute(
        "data-keyboard-hints-active",
      );
      return Promise.resolve();
    });
    const guide = () => document.querySelector("[aria-label='Hint commands']");

    await act(async () => {
      window.dispatchEvent(keydown(" ", TRIGGER));
    });
    expect(guide()?.textContent ?? "").toContain("Pull requests");
    if (supported) {
      expect(guide()?.textContent ?? "").not.toContain("Unavailable");
    } else {
      expect(guide()?.textContent ?? "").toContain("Unavailable");
    }
    hintCommands.preferences = { involvement: "authored", state: "merged" };

    await act(async () => {
      window.dispatchEvent(keydown("p"));
    });

    expect(hintCommands.openLink).not.toHaveBeenCalled();
    if (supported) {
      expect(hintsActiveDuringNavigate).toBe(false);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith({
        to: "/pull-requests",
        search: { involvement: "authored", state: "merged" },
      });
      expect(document.querySelector("[data-keyboard-hints-overlay]")).toBeNull();
    } else {
      expect(navigate).not.toHaveBeenCalled();
      expect(hintsActiveDuringNavigate).toBe(true);
      expect(document.documentElement.hasAttribute("data-keyboard-hints-active")).toBe(true);
      expect(document.querySelector("[data-keyboard-hints-overlay]")).not.toBeNull();
      expect(guide()?.textContent ?? "").toContain("Pull requests");
    }
  });
});
