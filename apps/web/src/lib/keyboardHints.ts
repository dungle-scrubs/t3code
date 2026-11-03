/**
 * Vimium-style keyboard hints for the web client.
 *
 * The controller labels the eligible targets once per invocation, filters them
 * while the user types, and activates the one target the typed label names.
 */

import { observeResize } from "./observeResize";

/** Home-row-first alphabet: the first labels are the easiest keys to reach. */
export const KEYBOARD_HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

export const KEYBOARD_HINT_ISSUES_KEY = "i" as const;

export const KEYBOARD_HINT_PULL_REQUESTS_KEY = "p" as const;

export type KeyboardHintCommandKey =
  | typeof KEYBOARD_HINT_ISSUES_KEY
  | typeof KEYBOARD_HINT_PULL_REQUESTS_KEY;

/** First letters omit the command keys, so no click label starts with i or p. */
const KEYBOARD_HINT_INITIAL_ALPHABET = KEYBOARD_HINT_ALPHABET.replaceAll(
  KEYBOARD_HINT_ISSUES_KEY,
  "",
).replaceAll(KEYBOARD_HINT_PULL_REQUESTS_KEY, "");

/** Two letters cover 24 first letters times 26 second letters. More targets than that cannot be hinted. */
export const MAX_KEYBOARD_HINT_TARGETS =
  KEYBOARD_HINT_INITIAL_ALPHABET.length * KEYBOARD_HINT_ALPHABET.length;

/**
 * Where a badge sits, derived from the rendered target: over its leading icon, at the start of
 * its text, centred on a target with no content, or beside a control that shows only on hover.
 */
export type KeyboardHintPlacement = "center" | "text-start" | "below" | "above" | "left";
export type KeyboardHintSize = "default" | "compact";

export interface KeyboardHintTarget {
  readonly label: string;
  readonly element: HTMLElement;
  readonly left: number;
  readonly top: number;
  readonly placement: KeyboardHintPlacement;
  readonly size: KeyboardHintSize;
}

/** A labelled target of the current invocation. */
interface KeyboardHintPoolEntry {
  readonly element: HTMLElement;
  readonly label: string;
}

export interface KeyboardHintsState {
  readonly active: boolean;
  readonly prefix: string;
  readonly targets: readonly KeyboardHintTarget[];
  readonly commandGuidePosition?: { readonly bottom: number; readonly right: number };
}

export interface KeyboardHintsController {
  readonly state: KeyboardHintsState;
  /** Returns true when the event belonged to the hint mode and was consumed. */
  handleKeyDown(event: KeyboardEvent): boolean;
  dismiss(): void;
  dispose(): void;
}

const HINT_ACTION_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='treeitem']",
].join(",");
const HINT_TARGET_SELECTOR = `${HINT_ACTION_SELECTOR},[tabindex]`;

const HINT_POPUP_SELECTOR = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="sheet-popup"]',
].join(",");

const HINT_MODAL_SELECTOR = '[aria-modal="true"]';

const HINT_HIDDEN_SELECTOR = "[hidden], [inert], [aria-hidden='true'], [data-closed]";

const HINT_TERMINAL_SELECTOR = ".xterm, .xterm-helper-textarea, [data-thread-terminal-drawer]";

const HINT_OVERLAY_SELECTOR = "[data-keyboard-hints-overlay]";

const HINT_CAPTURE_SELECTOR = "[data-keybinding-capture]";

// The form, not its workspace region: on a new thread that region fills the viewport.
const HINT_COMPOSER_SELECTOR = "[data-chat-composer-form]";

const COMMAND_GUIDE_COMPOSER_GAP = 8;

const COMMAND_GUIDE_VIEWPORT_MARGIN = 16;

const HINT_SIZE_ATTRIBUTE = "data-keyboard-hint-size";

const HINT_SKIP_ATTRIBUTE = "data-keyboard-hint-skip";

const HINT_ANCHOR_ID_ATTRIBUTE = "data-keyboard-hint-anchor-id";

const HINT_HOVER_SIDE_ATTRIBUTE = "data-keyboard-hint-hover-side";

const HINT_FOCUS_SCOPE_ID_ATTRIBUTE = "data-keyboard-hint-focus-scope-id";

/** Set on the document element while hints show; index.css reveals the opted-in hover rows. */
const HINT_ACTIVE_ATTRIBUTE = "data-keyboard-hints-active";

/** Hover-only controls: inside a revealed row, or a file-tab close whose X shows on hover. */
const HINT_HOVER_ONLY_SELECTOR = "[data-keyboard-hint-reveal]";

const HINT_HOVER_ONLY_CONTENT_SELECTOR = "[data-keyboard-hint-close-icon]";

const HINT_ICON_SELECTOR = "svg, img, [role='img']";

/** Matches the badge's h-[16px] in KeyboardHints.tsx. */
const HINT_BADGE_HEIGHT = 16;

const HINT_BADGE_GAP = 4;

const HINT_VIEWPORT_MARGIN = 4;

const TRIGGER_CODE = "Space";

/** Props a control spreads to change how large its hint is, or to opt out of hints. */
export function keyboardHintProps(options: {
  readonly size?: KeyboardHintSize;
  readonly skip?: boolean;
  /** Id of an element outside the control whose content the badge labels; the control stays the activation target. */
  readonly anchorId?: string;
  /** Drop this candidate while the element with this id contains document focus. */
  readonly focusScopeId?: string;
  /** Dense hover columns whose badge would cover the next row sit left of the control instead. */
  readonly hoverSide?: "left";
}): Partial<
  Record<
    | typeof HINT_SIZE_ATTRIBUTE
    | typeof HINT_SKIP_ATTRIBUTE
    | typeof HINT_ANCHOR_ID_ATTRIBUTE
    | typeof HINT_FOCUS_SCOPE_ID_ATTRIBUTE
    | typeof HINT_HOVER_SIDE_ATTRIBUTE,
    string
  >
> {
  return {
    ...(options.size ? { [HINT_SIZE_ATTRIBUTE]: options.size } : {}),
    ...(options.skip ? { [HINT_SKIP_ATTRIBUTE]: "" } : {}),
    ...(options.anchorId ? { [HINT_ANCHOR_ID_ATTRIBUTE]: options.anchorId } : {}),
    ...(options.focusScopeId ? { [HINT_FOCUS_SCOPE_ID_ATTRIBUTE]: options.focusScopeId } : {}),
    ...(options.hoverSide ? { [HINT_HOVER_SIDE_ATTRIBUTE]: options.hoverSide } : {}),
  };
}

function hintSize(element: HTMLElement): KeyboardHintSize {
  return element.getAttribute(HINT_SIZE_ATTRIBUTE) === "compact" ? "compact" : "default";
}

/** What a badge labels: the first rendered icon or text line, else the whole box. */
interface HintAnchor {
  readonly kind: "icon" | "text" | "empty";
  /** The element whose size changes move the badge. */
  readonly element: Element;
  readonly rect: DOMRect;
}

function hasArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function textLineAnchor(text: Text): HintAnchor | undefined {
  const start = text.data.search(/\S/);
  const parent = text.parentElement;
  if (start < 0 || !parent) return undefined;
  const range = text.ownerDocument.createRange();
  range.setStart(text, start);
  range.setEnd(text, text.data.length);
  const rect = Array.from(range.getClientRects()).find(hasArea);
  return rect ? { kind: "text", element: parent, rect } : undefined;
}

/** A field draws its value or placeholder inside its padding, with no text node to measure. */
function fieldTextAnchor(field: HTMLElement): HintAnchor {
  const rect = field.getBoundingClientRect();
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  const px = (value: string | undefined) => Number.parseFloat(value ?? "") || 0;
  const left = rect.left + px(style?.borderLeftWidth) + px(style?.paddingLeft);
  const right = rect.right - px(style?.borderRightWidth) - px(style?.paddingRight);
  const top = rect.top + px(style?.borderTopWidth) + px(style?.paddingTop);
  const bottom = rect.bottom - px(style?.borderBottomWidth) - px(style?.paddingBottom);
  const lineHeight = px(style?.lineHeight) || px(style?.fontSize) * 1.2;
  // A single-line control centres its line; a multi-line one starts at the top.
  const lineTop =
    field.tagName === "INPUT" || field.tagName === "SELECT" ? (top + bottom - lineHeight) / 2 : top;
  return {
    kind: "text",
    element: field,
    rect: new DOMRect(left, lineTop, Math.max(0, right - left), lineHeight),
  };
}

function isScreenReaderOnly(style: CSSStyleDeclaration, rect: DOMRect): boolean {
  return style.position === "absolute" && rect.width <= 1 && rect.height <= 1;
}

/**
 * The first icon or text line rendered inside `element`, in document order, so an icon before a
 * label wins and a label before a trailing caret wins. Nested controls own their content.
 */
function firstRenderedContent(element: Element): HintAnchor | undefined {
  const view = element.ownerDocument.defaultView;
  for (const node of Array.from(element.childNodes)) {
    if (node instanceof Text) {
      const text = textLineAnchor(node);
      if (text) return text;
      continue;
    }
    if (!(node instanceof Element)) continue;
    if (node.matches(HINT_ACTION_SELECTOR)) continue;
    if (node instanceof HTMLElement && node.tabIndex >= 0) continue;
    const style = view?.getComputedStyle(node);
    if (style) {
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (Number(style.opacity) === 0) continue;
    }
    const rect = node.getBoundingClientRect();
    if (style && isScreenReaderOnly(style, rect)) continue;
    if (node.matches(HINT_ICON_SELECTOR)) {
      if (hasArea(rect)) return { kind: "icon", element: node, rect };
      continue;
    }
    const nested = firstRenderedContent(node);
    if (nested) return nested;
  }
  return undefined;
}

function contentAnchor(element: Element): HintAnchor | undefined {
  if (element instanceof HTMLInputElement) {
    return isTextEntry(element) ? fieldTextAnchor(element) : undefined;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return fieldTextAnchor(element);
  }
  if (element.matches(HINT_ICON_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    return hasArea(rect) ? { kind: "icon", element, rect } : undefined;
  }
  const content = firstRenderedContent(element);
  if (content) return content;
  return element instanceof HTMLElement && isTextEntry(element)
    ? fieldTextAnchor(element)
    : undefined;
}

/** An explicit anchor names where the content sits; the control is the fallback. */
function resolveHintAnchor(element: HTMLElement): HintAnchor {
  const anchorId = element.getAttribute(HINT_ANCHOR_ID_ATTRIBUTE);
  const explicit = anchorId ? element.ownerDocument.getElementById(anchorId) : null;
  if (explicit) {
    const content = contentAnchor(explicit);
    if (content) return content;
    const rect = explicit.getBoundingClientRect();
    if (hasArea(rect)) return { kind: "empty", element: explicit, rect };
  }
  return (
    contentAnchor(element) ?? {
      kind: "empty",
      element,
      rect: element.getBoundingClientRect(),
    }
  );
}

function isHoverOnly(element: HTMLElement): boolean {
  return (
    element.closest(HINT_HOVER_ONLY_SELECTOR) !== null ||
    element.querySelector(HINT_HOVER_ONLY_CONTENT_SELECTOR) !== null
  );
}

/**
 * A badge covers the icon or text start the eye already rests on. A hover-only control stays
 * readable, so its badge sits 4px below it, or above it when the viewport has no room below.
 */
function hintPosition(
  element: HTMLElement,
  anchor: HintAnchor,
): Pick<KeyboardHintTarget, "placement" | "left" | "top"> {
  const rect = anchor.rect;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  if (isHoverOnly(element)) {
    if (element.getAttribute(HINT_HOVER_SIDE_ATTRIBUTE) === "left") {
      return { placement: "left", left: rect.left - HINT_BADGE_GAP, top: centerY };
    }
    const viewportHeight = element.ownerDocument.defaultView?.innerHeight ?? 0;
    const below = rect.bottom + HINT_BADGE_GAP;
    if (viewportHeight <= 0 || below + HINT_BADGE_HEIGHT <= viewportHeight - HINT_VIEWPORT_MARGIN) {
      return { placement: "below", left: centerX, top: below };
    }
    return {
      placement: "above",
      left: centerX,
      top: rect.top - HINT_BADGE_GAP - HINT_BADGE_HEIGHT,
    };
  }
  if (anchor.kind === "text") return { placement: "text-start", left: rect.left, top: centerY };
  return { placement: "center", left: centerX, top: centerY };
}

function measureHint(
  label: string,
  element: HTMLElement,
): { readonly target: KeyboardHintTarget; readonly anchor: Element } {
  const anchor = resolveHintAnchor(element);
  return {
    target: { label, element, ...hintPosition(element, anchor), size: hintSize(element) },
    anchor: anchor.element,
  };
}

/**
 * Deterministic, prefix-free labels for `count` targets.
 *
 * Up to 24 targets get one letter from the alphabet without the command keys.
 * Above that, every label is two letters: that shorter first letter, then a
 * letter from the full alphabet, so a typed prefix never names two targets.
 */
export function assignHintLabels(count: number): string[] {
  const total = Math.min(Math.max(Math.floor(count), 0), MAX_KEYBOARD_HINT_TARGETS);
  if (total <= 0) return [];
  if (total <= KEYBOARD_HINT_INITIAL_ALPHABET.length) {
    return KEYBOARD_HINT_INITIAL_ALPHABET.slice(0, total).split("");
  }
  const perFirstLetter = Math.ceil(total / KEYBOARD_HINT_INITIAL_ALPHABET.length);
  const labels: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const first = KEYBOARD_HINT_INITIAL_ALPHABET.charAt(Math.floor(index / perFirstLetter));
    const second = KEYBOARD_HINT_ALPHABET.charAt(index % perFirstLetter);
    labels.push(first + second);
  }
  return labels;
}

function isNativeInteractive(element: HTMLElement): boolean {
  const tag = element.tagName;
  return (
    tag === "BUTTON" ||
    tag === "INPUT" ||
    tag === "SELECT" ||
    tag === "TEXTAREA" ||
    tag === "A" ||
    tag === "SUMMARY"
  );
}

function isDisabled(element: HTMLElement): boolean {
  return element.getAttribute("aria-disabled") === "true" || element.matches(":disabled");
}

function isHidden(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  let current: HTMLElement | null = element;
  while (current) {
    if (
      current.hasAttribute("hidden") ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true" ||
      current.hasAttribute("data-closed")
    ) {
      return true;
    }
    const style = view?.getComputedStyle(current);
    if (
      style &&
      (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function focusScopeContainsActiveElement(element: HTMLElement): boolean {
  const scopeId = element.getAttribute(HINT_FOCUS_SCOPE_ID_ATTRIBUTE);
  if (!scopeId) return false;
  const scope = element.ownerDocument.getElementById(scopeId);
  const active = element.ownerDocument.activeElement;
  return scope !== null && active !== null && scope.contains(active);
}

function isHintCandidate(element: HTMLElement): boolean {
  if (element.hasAttribute(HINT_SKIP_ATTRIBUTE)) return false;
  if (element === element.ownerDocument.activeElement && isTextEntry(element)) return false;
  if (focusScopeContainsActiveElement(element)) return false;
  return element.matches(HINT_ACTION_SELECTOR) || element.tabIndex >= 0;
}

function representativePoints(rect: DOMRect): Array<{ x: number; y: number }> {
  const inset = Math.min(4, rect.width / 4, rect.height / 4);
  const points = [{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }];
  if (inset > 0) {
    points.push(
      { x: rect.left + inset, y: rect.top + inset },
      { x: rect.right - inset, y: rect.top + inset },
      { x: rect.left + inset, y: rect.bottom - inset },
      { x: rect.right - inset, y: rect.bottom - inset },
    );
  }
  return points;
}

/**
 * A target counts as visible when a point of it is really on screen.
 *
 * The centre alone is not enough: a control clipped by a scroller or covered
 * by a sticky header still has a centre, while a partly exposed control has a
 * corner that answers a hit test.
 */
function isExposed(element: HTMLElement, doc: Document): boolean {
  const view = doc.defaultView;
  const viewportWidth = view?.innerWidth ?? 0;
  const viewportHeight = view?.innerHeight ?? 0;
  for (const rect of Array.from(element.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      viewportWidth > 0 &&
      (rect.right <= 0 ||
        rect.left >= viewportWidth ||
        rect.bottom <= 0 ||
        rect.top >= viewportHeight)
    ) {
      continue;
    }
    for (const point of representativePoints(rect)) {
      if (point.x < 0 || point.y < 0) continue;
      if (viewportWidth > 0 && point.x > viewportWidth) continue;
      if (viewportHeight > 0 && point.y > viewportHeight) continue;
      const hit = doc.elementFromPoint(point.x, point.y);
      if (hit && (hit === element || element.contains(hit))) return true;
    }
  }
  return false;
}

function isVisibleScope(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (isHidden(element)) return false;
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * The surface the hints belong to: the popup that holds the focus, else the
 * topmost modal, else the whole document.
 */
function resolveHintScope(doc: Document): Element {
  const active = doc.activeElement;
  if (active instanceof HTMLElement) {
    const popup = active.closest(HINT_POPUP_SELECTOR);
    if (popup && isVisibleScope(popup)) return popup;
  }
  const modals = Array.from(doc.querySelectorAll(HINT_MODAL_SELECTOR)).filter((modal) =>
    isVisibleScope(modal),
  );
  return modals.at(-1) ?? doc.body ?? doc.documentElement;
}

/**
 * A nested control that is not a real control of its own labels the same click
 * target as the control around it, so it gets no label of its own. Native
 * controls stay: a button inside a sidebar row is a control of its own.
 */
function hasDuplicateAncestor(element: HTMLElement, candidates: Set<HTMLElement>): boolean {
  if (isNativeInteractive(element)) return false;
  let parent = element.parentElement;
  while (parent) {
    if (candidates.has(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function findVisibleComposer(doc: Document): HTMLElement | undefined {
  return Array.from(doc.querySelectorAll<HTMLElement>(HINT_COMPOSER_SELECTOR)).find(isVisibleScope);
}

function commandGuidePosition(
  composer: HTMLElement,
  heading: HTMLElement | undefined,
  doc: Document,
): KeyboardHintsState["commandGuidePosition"] {
  const view = doc.defaultView;
  if (!view || view.innerHeight <= 0) return undefined;
  const rect = composer.getBoundingClientRect();
  const top = heading ? Math.min(rect.top, heading.getBoundingClientRect().top) : rect.top;
  return {
    bottom: Math.max(
      COMMAND_GUIDE_VIEWPORT_MARGIN,
      view.innerHeight - top + COMMAND_GUIDE_COMPOSER_GAP,
    ),
    right: Math.max(COMMAND_GUIDE_VIEWPORT_MARGIN, view.innerWidth - rect.right),
  };
}

/** The visible, reachable targets the hints can label, in document order. */
export function collectHintTargets(doc: Document): HTMLElement[] {
  const scope = resolveHintScope(doc);
  const elements = Array.from(scope.querySelectorAll<HTMLElement>(HINT_TARGET_SELECTOR));
  if (scope instanceof HTMLElement && scope.matches(HINT_TARGET_SELECTOR)) {
    elements.unshift(scope);
  }
  const candidates = new Set(elements.filter(isHintCandidate));
  const targets: HTMLElement[] = [];
  for (const element of candidates) {
    if (targets.length >= MAX_KEYBOARD_HINT_TARGETS) break;
    if (element.closest(HINT_OVERLAY_SELECTOR)) continue;
    if (element.closest(HINT_TERMINAL_SELECTOR)) continue;
    if (element.closest(HINT_HIDDEN_SELECTOR)) continue;
    if (isHidden(element)) continue;
    if (isDisabled(element)) continue;
    if (!isExposed(element, doc)) continue;
    if (hasDuplicateAncestor(element, candidates)) continue;
    targets.push(element);
  }
  return targets;
}

function isTextEntry(element: HTMLElement): boolean {
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type.toLowerCase();
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(type);
  }
  const editable = element.getAttribute("contenteditable");
  return editable === "true" || editable === "plaintext-only";
}

/**
 * Replays a click the way a pointer would: the pointer and mouse events the
 * browser pairs with a real click, then the click itself.
 *
 * Base UI triggers open on the mouse press, so the press has to come first.
 */
function dispatchClick(element: HTMLElement, doc: Document, x: number, y: number): void {
  const view = doc.defaultView;
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    detail: 1,
    view,
  } as const;
  element.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  element.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
  element.dispatchEvent(new MouseEvent("click", init));
}

function activateTarget(target: KeyboardHintTarget, doc: Document): void {
  const element = target.element;
  if (!element.isConnected || !isHintCandidate(element)) return;
  if (isDisabled(element) || isHidden(element) || !isExposed(element, doc)) return;
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  element.focus({ preventScroll: true });
  if (isTextEntry(element)) return;
  dispatchClick(element, doc, x, y);
}

function isTriggerChord(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.code === TRIGGER_CODE || event.key === " ")
  );
}

function isModifierKey(key: string): boolean {
  return (
    key === "Shift" || key === "Control" || key === "Alt" || key === "Meta" || key === "CapsLock"
  );
}

function isOverlayMutation(record: MutationRecord): boolean {
  const target = record.target;
  if (target instanceof Element && target.closest(HINT_OVERLAY_SELECTOR)) return true;
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (node instanceof Element && node.matches(HINT_OVERLAY_SELECTOR)) return true;
  }
  return false;
}

/** Whether the badge of a target still sits where it was. */
function sameHintTargets(
  previous: readonly KeyboardHintTarget[],
  next: readonly KeyboardHintTarget[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before.element !== after.element) return false;
    if (before.label !== after.label) return false;
    if (before.placement !== after.placement || before.size !== after.size) return false;
    if (before.left !== after.left) return false;
    if (before.top !== after.top) return false;
  }
  return true;
}

/** The element a CSS transition animates. */
function transitionElement(animation: CSSTransition): Element | null {
  const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
  return target instanceof Element ? target : null;
}

/** Whether a CSS transition for the property still runs on the element. */
function isTransitionRunning(element: Element, property: string): boolean {
  if (typeof CSSTransition === "undefined") return false;
  return element
    .getAnimations()
    .some(
      (animation) =>
        animation instanceof CSSTransition &&
        animation.transitionProperty === property &&
        animation.playState === "running",
    );
}

/**
 * The hint mode: a trigger chord opens it, typed letters narrow the labels,
 * and the label that survives activates its target. The labelled pool is fixed
 * per invocation; later refreshes only decide which labels stay visible and
 * where their badges sit.
 */
export function createKeyboardHintsController(
  doc: Document,
  onChange: (state: KeyboardHintsState) => void,
  options?: {
    readonly resolveCommand?: (key: KeyboardHintCommandKey) => (() => void) | undefined;
  },
): KeyboardHintsController {
  let state: KeyboardHintsState = { active: false, prefix: "", targets: [] };
  let pool: readonly KeyboardHintPoolEntry[] = [];
  let scope: Element | undefined;
  let observer: MutationObserver | undefined;
  const observed = new Set<Element>();
  const resizeCleanups: (() => void)[] = [];
  let revealed = false;
  let disposed = false;
  let pendingFrame: number | undefined;
  const runningTransitions = new Map<Element, Set<string>>();

  const emit = () => onChange(state);

  function observe(elements: readonly Element[]): void {
    const fresh = elements.filter((element) => !observed.has(element));
    if (fresh.length === 0) return;
    for (const element of fresh) observed.add(element);
    resizeCleanups.push(observeResize(fresh, onResizeObserved));
  }

  function observeWithAncestors(element: Element): void {
    const elements: Element[] = [];
    let current: Element | null = element;
    while (current) {
      elements.push(current);
      if (current === doc.body || current === doc.documentElement) break;
      current = current.parentElement;
    }
    observe(elements);
  }

  function trackCommandGuidePosition() {
    const composer = findVisibleComposer(doc);
    if (!composer) return undefined;
    const heading = composer
      .closest("[data-chat-composer-stack]")
      ?.querySelector<HTMLElement>("[data-chat-composer-heading]");
    const visibleHeading = heading && isVisibleScope(heading) ? heading : undefined;
    observeWithAncestors(composer);
    if (visibleHeading) observeWithAncestors(visibleHeading);
    return commandGuidePosition(composer, visibleHeading, doc);
  }

  function stopWatching() {
    observer?.disconnect();
    observer = undefined;
    for (const stop of resizeCleanups) stop();
    resizeCleanups.length = 0;
    observed.clear();
    runningTransitions.clear();
    const view = doc.defaultView;
    if (pendingFrame !== undefined) {
      view?.cancelAnimationFrame(pendingFrame);
      pendingFrame = undefined;
    }
    view?.removeEventListener("scroll", onScroll, true);
    view?.removeEventListener("resize", onResize);
    view?.removeEventListener("pointerdown", onPointerDown, true);
    view?.removeEventListener("blur", onBlur);
    view?.removeEventListener("transitionrun", onTransitionRun, true);
    view?.removeEventListener("transitionend", onTransitionSettled, true);
    view?.removeEventListener("transitioncancel", onTransitionSettled, true);
  }

  function reveal() {
    revealed = true;
    doc.documentElement.setAttribute(HINT_ACTIVE_ATTRIBUTE, "");
  }

  function conceal() {
    if (!revealed) return;
    revealed = false;
    doc.documentElement.removeAttribute(HINT_ACTIVE_ATTRIBUTE);
  }

  function dismiss() {
    if (!state.active) return;
    stopWatching();
    conceal();
    pool = [];
    scope = undefined;
    state = { active: false, prefix: "", targets: [] };
    emit();
  }

  function onScroll() {
    scheduleRefresh();
  }

  function onResize() {
    scheduleRefresh();
  }

  function onPointerDown() {
    dismiss();
  }

  function onBlur() {
    dismiss();
  }

  function onMutations(records: MutationRecord[]) {
    if (records.some((record) => !isOverlayMutation(record))) scheduleRefresh();
  }

  function onResizeObserved() {
    scheduleRefresh();
  }

  function transitionProperty(event: Event): string {
    return (event as TransitionEvent).propertyName ?? "";
  }

  function onTransitionRun(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(HINT_OVERLAY_SELECTOR)) return;
    const properties = runningTransitions.get(target) ?? new Set<string>();
    properties.add(transitionProperty(event));
    runningTransitions.set(target, properties);
    scheduleRefresh();
  }

  function onTransitionSettled(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(HINT_OVERLAY_SELECTOR)) return;
    const properties = runningTransitions.get(target);
    if (properties) {
      properties.delete(transitionProperty(event));
      if (properties.size === 0) runningTransitions.delete(target);
    }
    // The settled value is the last one the badge has to follow, even when the
    // transition started before the mode opened.
    scheduleRefresh();
  }

  /** Drops transitions that ended without an event or that lost their element. */
  function pruneTransitions() {
    for (const [element, properties] of runningTransitions) {
      if (!element.isConnected) {
        runningTransitions.delete(element);
        continue;
      }
      for (const property of properties) {
        if (!isTransitionRunning(element, property)) properties.delete(property);
      }
      if (properties.size === 0) runningTransitions.delete(element);
    }
  }

  /** Transitions that already run when the mode opens never fired transitionrun here. */
  function seedRunningTransitions() {
    if (typeof CSSTransition === "undefined") return;
    for (const animation of doc.getAnimations()) {
      if (!(animation instanceof CSSTransition)) continue;
      if (animation.playState !== "running") continue;
      const target = transitionElement(animation);
      if (!target || target.closest(HINT_OVERLAY_SELECTOR)) continue;
      const properties = runningTransitions.get(target) ?? new Set<string>();
      properties.add(animation.transitionProperty);
      runningTransitions.set(target, properties);
    }
  }

  function scheduleRefresh() {
    if (disposed || !state.active) return;
    const view = doc.defaultView;
    if (!view || pendingFrame !== undefined) return;
    pendingFrame = view.requestAnimationFrame(() => {
      pendingFrame = undefined;
      pruneTransitions();
      refresh();
      // A running transition moves its target between notifications.
      if (runningTransitions.size > 0) scheduleRefresh();
    });
  }

  function refresh() {
    if (disposed || !state.active) return;
    if (scope && resolveHintScope(doc) !== scope) {
      // A modal or popup took over: the labels under it must not answer.
      dismiss();
      return;
    }
    const next: KeyboardHintTarget[] = [];
    for (const entry of pool) {
      const element = entry.element;
      if (!element.isConnected) continue;
      if (!isHintCandidate(element)) continue;
      if (isDisabled(element) || isHidden(element)) continue;
      if (!isExposed(element, doc)) continue;
      const { target, anchor } = measureHint(entry.label, element);
      next.push(target);
      observeWithAncestors(element);
      observeWithAncestors(anchor);
    }
    const guidePosition = trackCommandGuidePosition();
    if (
      sameHintTargets(state.targets, next) &&
      guidePosition?.bottom === state.commandGuidePosition?.bottom &&
      guidePosition?.right === state.commandGuidePosition?.right
    )
      return;
    state = {
      active: true,
      prefix: state.prefix,
      targets: next,
      ...(guidePosition === undefined ? {} : { commandGuidePosition: guidePosition }),
    };
    emit();
  }

  function startWatching(anchors: readonly Element[]) {
    const view = doc.defaultView;
    view?.addEventListener("scroll", onScroll, { capture: true, passive: true });
    view?.addEventListener("resize", onResize);
    view?.addEventListener("pointerdown", onPointerDown, true);
    view?.addEventListener("blur", onBlur);
    view?.addEventListener("transitionrun", onTransitionRun, true);
    view?.addEventListener("transitionend", onTransitionSettled, true);
    view?.addEventListener("transitioncancel", onTransitionSettled, true);
    observer = new MutationObserver(onMutations);
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "inert",
        "aria-hidden",
        "aria-disabled",
        "disabled",
        "id",
        "open",
        HINT_SKIP_ATTRIBUTE,
        HINT_FOCUS_SCOPE_ID_ATTRIBUTE,
        HINT_SIZE_ATTRIBUTE,
        HINT_ANCHOR_ID_ATTRIBUTE,
        HINT_HOVER_SIDE_ATTRIBUTE,
      ],
    });
    for (const entry of pool) observeWithAncestors(entry.element);
    for (const anchor of anchors) observeWithAncestors(anchor);
    seedRunningTransitions();
    scheduleRefresh();
  }

  function open() {
    // Hover-only rows must be opaque before collection, which skips transparent controls.
    reveal();
    let elements: HTMLElement[];
    let labels: string[];
    try {
      elements = collectHintTargets(doc);
      labels = assignHintLabels(elements.length);
    } catch (error) {
      conceal();
      throw error;
    }
    pool = elements.flatMap((element, index) => {
      const label = labels[index];
      return label === undefined ? [] : [{ element, label }];
    });
    scope = resolveHintScope(doc);
    const guidePosition = trackCommandGuidePosition();
    const measured = pool.map((entry) => measureHint(entry.label, entry.element));
    state = {
      active: true,
      prefix: "",
      targets: measured.map(({ target }) => target),
      ...(guidePosition === undefined ? {} : { commandGuidePosition: guidePosition }),
    };
    startWatching(measured.map(({ anchor }) => anchor));
    emit();
  }

  function narrow(prefix: string): KeyboardHintTarget[] {
    return state.targets.filter((target) => target.label.startsWith(prefix));
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (disposed) return false;
    if (event.isComposing || event.keyCode === 229) {
      // A composition owns the keyboard: the mode steps aside without taking the key.
      dismiss();
      return false;
    }
    if (event.target instanceof HTMLElement && event.target.closest(HINT_CAPTURE_SELECTOR)) {
      return false;
    }
    if (isTriggerChord(event)) {
      if (event.repeat) return false;
      if (state.active) {
        dismiss();
      } else {
        open();
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    if (!state.active) return false;
    if (isModifierKey(event.key)) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      dismiss();
      return false;
    }
    if (event.key === "Escape") {
      dismiss();
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    if (event.key === "Backspace") {
      if (state.prefix) {
        state = { ...state, prefix: state.prefix.slice(0, -1) };
        emit();
      } else {
        dismiss();
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    if (event.key.length === 1 && /[a-z]/i.test(event.key)) {
      const key = event.key.toLowerCase();
      // i and p are reserved at the empty prefix, including when the command cannot run.
      if (
        state.prefix === "" &&
        (key === KEYBOARD_HINT_ISSUES_KEY || key === KEYBOARD_HINT_PULL_REQUESTS_KEY)
      ) {
        const action = options?.resolveCommand?.(key);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (action) {
          dismiss();
          action();
        }
        return true;
      }
      const prefix = state.prefix + key;
      const matches = narrow(prefix);
      if (matches.length === 0) {
        // The key cannot reach the composer either: the mode owned it.
        dismiss();
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
      const match = matches[0];
      if (matches.length === 1 && match && match.label === prefix) {
        // The synthetic pointer press must not dismiss early: the target stays revealed until it ran.
        stopWatching();
        try {
          activateTarget(match, doc);
        } finally {
          dismiss();
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
      state = { ...state, prefix };
      emit();
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    // Any other key belongs to the surface underneath, so the mode steps aside.
    dismiss();
    return false;
  }

  return {
    get state() {
      return state;
    },
    handleKeyDown,
    dismiss,
    dispose: () => {
      disposed = true;
      stopWatching();
      conceal();
      pool = [];
      scope = undefined;
      state = { active: false, prefix: "", targets: [] };
    },
  };
}
