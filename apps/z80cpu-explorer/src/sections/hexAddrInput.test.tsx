// Focused unit tests for the shared HexAddrInput. Cover the
// clear-on-focus pattern + placeholder behavior, blur/Enter/Escape
// flows, parse-invalid + commit-rejection flashing, and the external
// reset signal. Section-level integration (Memory, Program, BP)
// continues to be tested in the section test files.

import { fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HexAddrInput } from "./hexAddrInput.tsx";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

interface MountOpts {
  initial?: number;
  padTo?: number;
  maxValue?: number;
  commit?: (v: number) => boolean | undefined;
  onJumpAfterEnter?: () => void;
  resetSignal?: () => number;
}

function mount(opts: MountOpts = {}): {
  input: HTMLInputElement;
  committed: () => number;
  setCommitted: (n: number) => void;
} {
  const [committed, setCommitted] = createSignal(opts.initial ?? 0);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(
    () => (
      <HexAddrInput
        committed={committed}
        padTo={opts.padTo}
        maxValue={opts.maxValue}
        commit={
          opts.commit ??
          ((v) => {
            setCommitted(v);
          })
        }
        onJumpAfterEnter={opts.onJumpAfterEnter}
        resetSignal={opts.resetSignal}
      />
    ),
    container,
  );
  cleanup = () => {
    dispose();
    container.remove();
  };
  const input = container.querySelector("input") as HTMLInputElement;
  return { input, committed, setCommitted };
}

describe("HexAddrInput — display", () => {
  it("renders the committed value as bare uppercase hex padded to padTo", () => {
    const { input } = mount({ initial: 0x42, padTo: 4 });
    expect(input.value).toBe("0042");
  });

  it("respects custom padTo (byte-sized field)", () => {
    const { input } = mount({ initial: 0xa, padTo: 2 });
    expect(input.value).toBe("0A");
  });

  it("updates when the committed accessor changes externally", () => {
    const { input, setCommitted } = mount({ initial: 0 });
    setCommitted(0x1234);
    expect(input.value).toBe("1234");
  });
});

describe("HexAddrInput — focus / placeholder", () => {
  it("clears the input value on focus and shows the committed value as placeholder", () => {
    const { input } = mount({ initial: 0x8000 });
    expect(input.value).toBe("8000");
    fireEvent.focus(input);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("8000");
  });

  it("blur with no typing reverts the display to the committed value", () => {
    const { input } = mount({ initial: 0x8000 });
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(input.value).toBe("8000");
    expect(input.placeholder).toBe("");
  });
});

describe("HexAddrInput — commit on Enter", () => {
  it("commits a valid hex value and clears local edit text", () => {
    const commit = vi.fn();
    const { input } = mount({ initial: 0, commit });
    fireEvent.input(input, { target: { value: "$8000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).toHaveBeenCalledWith(0x8000);
  });

  it("Enter on parse-invalid input flashes invalid and KEEPS focus", () => {
    const commit = vi.fn();
    const { input } = mount({ initial: 0x100, commit });
    fireEvent.input(input, { target: { value: "zzzz" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).not.toHaveBeenCalled();
    expect(input.classList.contains("is-invalid")).toBe(true);
    // Text reverted to empty (placeholder shows committed). Cell not closed.
    expect(input.value).toBe("");
  });

  it("fires onJumpAfterEnter only on a successful Enter commit", () => {
    const onJump = vi.fn();
    const { input } = mount({ initial: 0, onJumpAfterEnter: onJump });
    fireEvent.input(input, { target: { value: "4020" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledTimes(1);
    // Now try an invalid Enter — no jump.
    fireEvent.input(input, { target: { value: "garbage" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("commit() returning false (cross-field rejection) flashes invalid and KEEPS focus", () => {
    const commit = vi.fn(() => false as const);
    const { input } = mount({ initial: 0x100, commit });
    fireEvent.input(input, { target: { value: "2000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).toHaveBeenCalledWith(0x2000);
    expect(input.classList.contains("is-invalid")).toBe(true);
  });

  it("over-range values are rejected without calling commit", () => {
    const commit = vi.fn();
    const { input } = mount({ initial: 0, maxValue: 0xff, commit });
    fireEvent.input(input, { target: { value: "100" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).not.toHaveBeenCalled();
    expect(input.classList.contains("is-invalid")).toBe(true);
  });
});

describe("HexAddrInput — commit on blur", () => {
  it("commits a valid value on blur", () => {
    const commit = vi.fn();
    const { input } = mount({ initial: 0, commit });
    fireEvent.input(input, { target: { value: "4020" } });
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith(0x4020);
  });

  it("blur with parse-invalid flashes is-invalid AND reverts the display", () => {
    const commit = vi.fn();
    const { input } = mount({ initial: 0x4020, commit });
    fireEvent.input(input, { target: { value: "zzzz" } });
    fireEvent.blur(input);
    expect(commit).not.toHaveBeenCalled();
    expect(input.classList.contains("is-invalid")).toBe(true);
    expect(input.value).toBe("4020");
  });

  it("blur with commit-rejected flashes is-invalid AND reverts the display", () => {
    const commit = vi.fn(() => false as const);
    const { input } = mount({ initial: 0x100, commit });
    fireEvent.input(input, { target: { value: "2000" } });
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith(0x2000);
    expect(input.classList.contains("is-invalid")).toBe(true);
    expect(input.value).toBe("0100");
  });
});

describe("HexAddrInput — Escape", () => {
  it("Escape reverts local edit and does not commit", () => {
    const commit = vi.fn();
    const { input } = mount({ initial: 0x4020, commit });
    fireEvent.input(input, { target: { value: "9999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("4020");
  });
});

describe("HexAddrInput — resetSignal", () => {
  it("bumping resetSignal clears in-flight text and re-shows committed value", () => {
    const [reset, setReset] = createSignal(0);
    const { input } = mount({ initial: 0, resetSignal: reset });
    fireEvent.input(input, { target: { value: "8000" } });
    expect(input.value).toBe("8000");
    setReset(1);
    expect(input.value).toBe("0000");
    expect(input.placeholder).toBe("");
  });
});
