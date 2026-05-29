import { describe, expect, it, vi } from "vitest";
import { createHotkeyRegistry, normalizeKey } from "./registry.ts";

describe("createHotkeyRegistry", () => {
  it("returns registered bindings in registration order", () => {
    const r = createHotkeyRegistry();
    r.register({
      key: "a",
      scope: "global",
      action: () => {},
      description: "A",
    });
    r.register({
      key: "b",
      scope: "global",
      action: () => {},
      description: "B",
    });
    expect(r.list().map((b) => b.description)).toEqual(["A", "B"]);
  });

  it("warns and replaces on conflicting (key,scope,mods) tuple", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = createHotkeyRegistry();
    r.register({
      key: "x",
      scope: "global",
      action: () => {},
      description: "first",
    });
    r.register({
      key: "x",
      scope: "global",
      action: () => {},
      description: "second",
    });
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0].description).toBe("second");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("treats modifier differences as distinct triggers", () => {
    const r = createHotkeyRegistry();
    r.register({
      key: "r",
      scope: "global",
      action: () => {},
      description: "plain R",
    });
    r.register({
      key: "r",
      shift: true,
      scope: "global",
      action: () => {},
      description: "Shift R",
    });
    expect(r.list()).toHaveLength(2);
  });

  it("treats scope as part of the trigger identity", () => {
    const r = createHotkeyRegistry();
    r.register({
      key: "escape",
      scope: "global",
      action: () => {},
      description: "global esc",
    });
    r.register({
      key: "escape",
      scope: "modal",
      action: () => {},
      description: "modal esc",
    });
    expect(r.list()).toHaveLength(2);
  });

  it("unsubscribe removes the binding", () => {
    const r = createHotkeyRegistry();
    const off = r.register({
      key: "q",
      scope: "global",
      action: () => {},
      description: "Q",
    });
    expect(r.list()).toHaveLength(1);
    off();
    expect(r.list()).toHaveLength(0);
  });

  it("normalizes 'space' to ' '", () => {
    expect(normalizeKey("Space")).toBe(" ");
    expect(normalizeKey(" ")).toBe(" ");
    expect(normalizeKey("Escape")).toBe("escape");
  });
});
