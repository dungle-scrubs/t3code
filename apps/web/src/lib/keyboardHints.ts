/**
 * Vimium-style keyboard hints for the web client.
 *
 * The controller labels the eligible targets once per invocation, filters them
 * while the user types, and activates the one target the typed label names.
 */

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

export type KeyboardHintPlacement =
  | "inset"
  | "inline"
  | "above"
  | "below"
  | "before"
  | "after"
  | "center"
  | "text-start";
export type KeyboardHintSize = "default" | "compact";

export interface KeyboardHintTarget {
  readonly label: string;
  readonly element: HTMLElement;
  readonly left: number;
  readonly top: number;
  readonly placement: KeyboardHintPlacement;
  readonly size: KeyboardHintSize;
}

export interface KeyboardHintsState {
  readonly active: boolean;
  readonly prefix: string;
  readonly targets: readonly KeyboardHintTarget[];
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

const HINT_PLACEMENT_ATTRIBUTE = "data-keyboard-hint-placement";

const HINT_SIZE_ATTRIBUTE = "data-keyboard-hint-size";

const HINT_SKIP_ATTRIBUTE = "data-keyboard-hint-skip";

const HINT_ANCHOR_ID_ATTRIBUTE = "data-keyboard-hint-anchor-id";

const HINT_FOCUS_SCOPE_ID_ATTRIBUTE = "data-keyboard-hint-focus-scope-id";

const HINT_PLACEMENTS: ReadonlySet<string> = new Set<KeyboardHintPlacement>([
  "inset",
  "inline",
  "above",
  "below",
  "before",
  "after",
  "center",
  "text-start",
]);

/** Set on the document element while hints show; index.css reveals the opted-in hover rows. */
const HINT_ACTIVE_ATTRIBUTE = "data-keyboard-hints-active";

const TRIGGER_CODE = "Space";

/** Props a control spreads to change where its hint sits or how large it is, or to opt out of hints. */
export function keyboardHintProps(options: {
  readonly placement?: KeyboardHintPlacement;
  readonly size?: KeyboardHintSize;
  readonly skip?: boolean;
  /** Id of the hint's positioning element; the control stays the activation target. */
  readonly anchorId?: string;
  /** Drop this candidate while the element with this id contains document focus. */
  readonly focusScopeId?: string;
}): Partial<
  Record<
    | typeof HINT_PLACEMENT_ATTRIBUTE
    | typeof HINT_SIZE_ATTRIBUTE
    | typeof HINT_SKIP_ATTRIBUTE
    | typeof HINT_ANCHOR_ID_ATTRIBUTE
    | typeof HINT_FOCUS_SCOPE_ID_ATTRIBUTE,
    string
  >
> {
  return {
    ...(options.placement ? { [HINT_PLACEMENT_ATTRIBUTE]: options.placement } : {}),
    ...(options.size ? { [HINT_SIZE_ATTRIBUTE]: options.size } : {}),
    ...(options.skip ? { [HINT_SKIP_ATTRIBUTE]: "" } : {}),
    ...(options.anchorId ? { [HINT_ANCHOR_ID_ATTRIBUTE]: options.anchorId } : {}),
    ...(options.focusScopeId ? { [HINT_FOCUS_SCOPE_ID_ATTRIBUTE]: options.focusScopeId } : {}),
  };
}

function isHintPlacement(value: string | null): value is KeyboardHintPlacement {
  return value !== null && HINT_PLACEMENTS.has(value);
}

function hintPlacement(element: HTMLElement): KeyboardHintPlacement {
  const placement = element.getAttribute(HINT_PLACEMENT_ATTRIBUTE);
  return isHintPlacement(placement) ? placement : "inset";
}

function hintSize(element: HTMLElement): KeyboardHintSize {
  return element.getAttribute(HINT_SIZE_ATTRIBUTE) === "compact" ? "compact" : "default";
}

function hintRect(element: HTMLElement): DOMRect {
  const anchorId = element.getAttribute(HINT_ANCHOR_ID_ATTRIBUTE);
  const anchorRect = anchorId
    ? element.ownerDocument.getElementById(anchorId)?.getBoundingClientRect()
    : undefined;
  return anchorRect && anchorRect.width > 0 && anchorRect.height > 0
    ? anchorRect
    : element.getBoundingClientRect();
}

function hintPosition(
  rect: DOMRect,
  placement: KeyboardHintPlacement,
): { readonly left: number; readonly top: number } {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  switch (placement) {
    case "above":
      return { left: centerX, top: rect.top - 4 };
    case "below":
      return { left: centerX, top: rect.bottom + 4 };
    case "before":
      return { left: rect.left - 4, top: centerY };
    case "after":
      return { left: rect.right + 4, top: centerY };
    case "center":
      return { left: centerX, top: centerY };
    case "inset":
      return { left: rect.left + 7, top: rect.top + 6 };
    case "inline":
      return { left: rect.left + 7, top: centerY };
    case "text-start":
      return { left: rect.left, top: centerY };
  }
}

function hintTarget(label: string, element: HTMLElement): KeyboardHintTarget {
  const placement = hintPlacement(element);
  const { left, top } = hintPosition(hintRect(element), placement);
  return { label, element, left, top, placement, size: hintSize(element) };
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

/**
 * The hint mode: a trigger chord opens it, typed letters narrow the labels,
 * and the label that survives activates its target.
 */
export function createKeyboardHintsController(
  doc: Document,
  onChange: (state: KeyboardHintsState) => void,
  options?: {
    readonly resolveCommand?: (key: KeyboardHintCommandKey) => (() => void) | undefined;
  },
): KeyboardHintsController {
  let state: KeyboardHintsState = { active: false, prefix: "", targets: [] };
  let observer: MutationObserver | undefined;
  let revealed = false;
  let disposed = false;

  const emit = () => onChange(state);

  function stopWatching() {
    observer?.disconnect();
    observer = undefined;
    const view = doc.defaultView;
    view?.removeEventListener("scroll", onScroll, true);
    view?.removeEventListener("resize", onResize);
    view?.removeEventListener("pointerdown", onPointerDown, true);
    view?.removeEventListener("blur", onBlur);
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
    state = { active: false, prefix: "", targets: [] };
    emit();
  }

  function onScroll() {
    dismiss();
  }

  function onResize() {
    dismiss();
  }

  function onPointerDown() {
    dismiss();
  }

  function onBlur() {
    dismiss();
  }

  function onMutations(records: MutationRecord[]) {
    for (const record of records) {
      if (isOverlayMutation(record)) continue;
      const target = record.target;
      for (const hinted of state.targets) {
        if (!hinted.element.isConnected) {
          dismiss();
          return;
        }
        if (
          target instanceof Node &&
          (hinted.element === target || hinted.element.contains(target))
        ) {
          dismiss();
          return;
        }
      }
    }
  }

  function startWatching() {
    const view = doc.defaultView;
    view?.addEventListener("scroll", onScroll, { capture: true, passive: true });
    view?.addEventListener("resize", onResize);
    view?.addEventListener("pointerdown", onPointerDown, true);
    view?.addEventListener("blur", onBlur);
    observer = new MutationObserver(onMutations);
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "inert",
        "aria-hidden",
        "aria-disabled",
        "disabled",
        HINT_SKIP_ATTRIBUTE,
        HINT_FOCUS_SCOPE_ID_ATTRIBUTE,
      ],
    });
  }

  function open() {
    // Hover-only rows must be opaque before collection, which skips transparent controls.
    reveal();
    let targets: KeyboardHintTarget[];
    try {
      const elements = collectHintTargets(doc);
      const labels = assignHintLabels(elements.length);
      targets = elements.flatMap((element, index) => {
        const label = labels[index];
        return label === undefined ? [] : [hintTarget(label, element)];
      });
    } catch (error) {
      conceal();
      throw error;
    }
    state = { active: true, prefix: "", targets };
    startWatching();
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
      state = { active: false, prefix: "", targets: [] };
    },
  };
}
