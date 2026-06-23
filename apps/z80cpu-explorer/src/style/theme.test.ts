import { afterEach, describe, expect, it } from "vitest";
import {
  applyThemeAttribute,
  DEFAULT_THEME,
  sanitizeTheme,
  THEME_STORAGE_KEY,
} from "./theme.ts";

afterEach(() => {
  // applyThemeAttribute writes onto <html> AND localStorage; leaking
  // either across tests would let one test's state poison the next.
  document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // No localStorage in this runner; nothing to clean.
  }
});

describe("sanitizeTheme", () => {
  it("accepts the three valid values", () => {
    expect(sanitizeTheme("light")).toBe("light");
    expect(sanitizeTheme("dark")).toBe("dark");
    expect(sanitizeTheme("system")).toBe("system");
  });

  it("collapses null / undefined / garbage to the default", () => {
    expect(sanitizeTheme(null)).toBe(DEFAULT_THEME);
    expect(sanitizeTheme(undefined)).toBe(DEFAULT_THEME);
    expect(sanitizeTheme("solarized")).toBe(DEFAULT_THEME);
    expect(sanitizeTheme(42)).toBe(DEFAULT_THEME);
    expect(sanitizeTheme({})).toBe(DEFAULT_THEME);
  });
});

describe("applyThemeAttribute", () => {
  it("writes data-theme on the document element", () => {
    applyThemeAttribute("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyThemeAttribute("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyThemeAttribute("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
  });

  it("mirrors the value into localStorage so the pre-paint boot script can read it", () => {
    applyThemeAttribute("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    applyThemeAttribute("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    applyThemeAttribute("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });
});
