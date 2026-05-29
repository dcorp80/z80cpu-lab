import { describe, expect, it, vi } from "vitest";
import { findMatch } from "./dispatch.ts";
import { createHotkeyRegistry, type HotkeyBinding } from "./registry.ts";

function bind(over: Partial<HotkeyBinding>): HotkeyBinding {
  return {
    key: "a",
    scope: "global",
    action: () => {},
    description: "test",
    ...over,
  };
}

function fakeEvent(
  key: string,
  mods: Partial<
    Pick<KeyboardEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey">
  > = {},
): KeyboardEvent {
  return {
    key,
    shiftKey: !!mods.shiftKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
  } as KeyboardEvent;
}

describe("findMatch", () => {
  it("matches a simple global binding", () => {
    const b = bind({ key: "s", description: "step" });
    const m = findMatch([b], fakeEvent("s"), false);
    expect(m?.description).toBe("step");
  });

  it("requires modifier presence to match exactly", () => {
    const plain = bind({ key: "r", description: "plain" });
    const shifted = bind({ key: "r", shift: true, description: "shift" });
    expect(
      findMatch([plain, shifted], fakeEvent("r"), false)?.description,
    ).toBe("plain");
    expect(
      findMatch([plain, shifted], fakeEvent("R", { shiftKey: true }), false)
        ?.description,
    ).toBe("shift");
  });

  it("skips global bindings when a modal is open", () => {
    const g = bind({ key: "x", scope: "global" });
    const m = bind({ key: "x", scope: "modal", description: "modal" });
    expect(findMatch([g, m], fakeEvent("x"), true)?.description).toBe("modal");
  });

  it("skips modal bindings when no modal is open", () => {
    const g = bind({ key: "x", scope: "global", description: "global" });
    const m = bind({ key: "x", scope: "modal", description: "modal" });
    expect(findMatch([g, m], fakeEvent("x"), false)?.description).toBe(
      "global",
    );
  });

  it("matches space via both 'space' alias and ' '", () => {
    const r = createHotkeyRegistry();
    let fired = 0;
    r.register({
      key: "space",
      scope: "global",
      action: () => fired++,
      description: "run/pause",
    });
    const m1 = findMatch(r.list(), fakeEvent(" "), false);
    expect(m1).toBeDefined();
    m1?.action();
    expect(fired).toBe(1);
  });

  it("later-registered wins on tied trigger", () => {
    const r = createHotkeyRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    r.register({
      key: "a",
      scope: "global",
      action: () => {},
      description: "first",
    });
    r.register({
      key: "a",
      scope: "global",
      action: () => {},
      description: "second",
    });
    const m = findMatch(r.list(), fakeEvent("a"), false);
    expect(m?.description).toBe("second");
    warn.mockRestore();
  });
});
