import { describe, expect, it } from "vite-plus/test";

import {
  assignHintLabels,
  KEYBOARD_HINT_ALPHABET,
  KEYBOARD_HINT_ISSUES_KEY,
  KEYBOARD_HINT_PULL_REQUESTS_KEY,
  MAX_KEYBOARD_HINT_TARGETS,
} from "./keyboardHints";

const COMMAND_KEYS = [KEYBOARD_HINT_ISSUES_KEY, KEYBOARD_HINT_PULL_REQUESTS_KEY] as const;

const INITIAL_ALPHABET = KEYBOARD_HINT_ALPHABET.replaceAll(KEYBOARD_HINT_ISSUES_KEY, "").replaceAll(
  KEYBOARD_HINT_PULL_REQUESTS_KEY,
  "",
);

function expectPrefixFree(labels: string[]) {
  expect(new Set(labels).size).toBe(labels.length);
  for (const label of labels) {
    for (const other of labels) {
      if (label === other) continue;
      expect(other.startsWith(label)).toBe(false);
    }
  }
}

describe("keyboard hint labels", () => {
  it("gives no label to no target", () => {
    expect(assignHintLabels(0)).toEqual([]);
    expect(assignHintLabels(-3)).toEqual([]);
  });

  it("gives one letter to a single target", () => {
    expect(assignHintLabels(1)).toEqual(["a"]);
  });

  it("uses the home row first for up to 24 targets", () => {
    const labels = assignHintLabels(24);
    expect(KEYBOARD_HINT_PULL_REQUESTS_KEY).toBe("p");
    expect(INITIAL_ALPHABET).toHaveLength(24);
    expect(labels).toHaveLength(24);
    expect(labels).toEqual(INITIAL_ALPHABET.split(""));
    for (const key of COMMAND_KEYS) {
      expect(labels).not.toContain(key);
    }
    expectPrefixFree(labels);
  });

  it("switches to two letters above 24 targets", () => {
    const labels = assignHintLabels(25);
    expect(labels).toHaveLength(25);
    expect(labels.every((label) => label.length === 2)).toBe(true);
    for (const key of COMMAND_KEYS) {
      expect(labels.some((label) => label.startsWith(key))).toBe(false);
    }
    expectPrefixFree(labels);
  });

  it("keeps two-letter labels prefix free at the boundary", () => {
    expect(MAX_KEYBOARD_HINT_TARGETS).toBe(24 * KEYBOARD_HINT_ALPHABET.length);
    const labels = assignHintLabels(MAX_KEYBOARD_HINT_TARGETS);
    expect(labels).toHaveLength(624);
    expect(labels.every((label) => label.length === 2)).toBe(true);
    for (const key of COMMAND_KEYS) {
      expect(labels.some((label) => label.startsWith(key))).toBe(false);
    }
    expect(labels).toContain(`a${KEYBOARD_HINT_ISSUES_KEY}`);
    expect(labels).toContain(`a${KEYBOARD_HINT_PULL_REQUESTS_KEY}`);
    expectPrefixFree(labels);
  });

  it("caps the labels at the two-letter capacity", () => {
    const labels = assignHintLabels(MAX_KEYBOARD_HINT_TARGETS + 500);
    expect(labels).toHaveLength(MAX_KEYBOARD_HINT_TARGETS);
    expectPrefixFree(labels);
  });

  it("spreads the labels over the alphabet instead of filling one letter first", () => {
    const labels = assignHintLabels(26);
    const firstLetters = new Set(labels.map((label) => label[0]));
    expect(firstLetters.size).toBeGreaterThan(1);
    expect(labels[0]).toBe("aa");
    expect(labels[1]).toBe(`a${KEYBOARD_HINT_ALPHABET[1]}`);
    expect(labels[2]).toBe(`${KEYBOARD_HINT_ALPHABET[1]}a`);
  });

  it("is deterministic", () => {
    expect(assignHintLabels(40)).toEqual(assignHintLabels(40));
  });
});
