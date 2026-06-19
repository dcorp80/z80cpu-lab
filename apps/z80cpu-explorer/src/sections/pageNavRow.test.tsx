// Headless render test for the page-nav row. Verifies boundary
// disable rules, click → setAddr destinations, and label composition.
// Pure component (no store dependency) so we drive it with plain
// signals.

import { fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { PageNavRow } from "./pageNavRow.tsx";

let container: HTMLDivElement;
let dispose: () => void = () => {};

function mount(initialAddr: number, initialPageSize: number) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const [addr, setAddr] = createSignal(initialAddr);
  const [pageSize] = createSignal(initialPageSize);
  const setCalls: number[] = [];
  const setAddrTracked = (n: number) => {
    setCalls.push(n);
    setAddr(n);
  };
  dispose = render(
    () => (
      <PageNavRow addr={addr} pageSize={pageSize} setAddr={setAddrTracked} />
    ),
    container,
  );
  return { setCalls };
}

afterEach(() => {
  dispose();
  container?.remove();
});

const btn = (cls: string) =>
  container.querySelector<HTMLButtonElement>(`.${cls}`);

describe("PageNavRow", () => {
  it("disables << and < at page 0; enables > and >>", () => {
    mount(0x0000, 16384);
    expect(btn("page-nav-first")?.disabled).toBe(true);
    expect(btn("page-nav-prev")?.disabled).toBe(true);
    expect(btn("page-nav-next")?.disabled).toBe(false);
    expect(btn("page-nav-last")?.disabled).toBe(false);
  });

  it("disables > and >> at the last page; enables << and <", () => {
    mount(0xc000, 16384);
    expect(btn("page-nav-first")?.disabled).toBe(false);
    expect(btn("page-nav-prev")?.disabled).toBe(false);
    expect(btn("page-nav-next")?.disabled).toBe(true);
    expect(btn("page-nav-last")?.disabled).toBe(true);
  });

  it("enables all four in the middle of the address space", () => {
    mount(0x4000, 16384);
    expect(btn("page-nav-first")?.disabled).toBe(false);
    expect(btn("page-nav-prev")?.disabled).toBe(false);
    expect(btn("page-nav-next")?.disabled).toBe(false);
    expect(btn("page-nav-last")?.disabled).toBe(false);
  });

  it("clicking << jumps to 0x0000", () => {
    const { setCalls } = mount(0xc000, 16384);
    fireEvent.click(btn("page-nav-first") as HTMLButtonElement);
    expect(setCalls).toEqual([0]);
  });

  it("clicking >> jumps to the last page base", () => {
    const { setCalls } = mount(0x0000, 16384);
    fireEvent.click(btn("page-nav-last") as HTMLButtonElement);
    expect(setCalls).toEqual([0xc000]);
  });

  it("clicking < / > steps by one page", () => {
    const { setCalls } = mount(0x4000, 16384);
    fireEvent.click(btn("page-nav-next") as HTMLButtonElement);
    fireEvent.click(btn("page-nav-next") as HTMLButtonElement);
    fireEvent.click(btn("page-nav-prev") as HTMLButtonElement);
    expect(setCalls).toEqual([0x8000, 0xc000, 0x8000]);
  });

  it("displays the destination page base in the prev/next labels", () => {
    mount(0x4321, 16384);
    expect(btn("page-nav-prev")?.textContent).toBe("< 0000");
    expect(btn("page-nav-next")?.textContent).toBe("8000 >");
  });

  it("falls back to current page base in the disabled-button labels", () => {
    mount(0x0000, 16384);
    // At page 0, prev() returns null — label shows 0000 (this page),
    // button is disabled.
    expect(btn("page-nav-prev")?.textContent).toBe("< 0000");
    expect(btn("page-nav-prev")?.disabled).toBe(true);
  });

  it("adapts disable rules to smaller page sizes", () => {
    mount(0xfc00, 1024);
    // 0xFC00 is the last 1 KB page base (lastPageBase(1024) = 0xFC00).
    expect(btn("page-nav-first")?.disabled).toBe(false);
    expect(btn("page-nav-last")?.disabled).toBe(true);
    expect(btn("page-nav-next")?.disabled).toBe(true);
  });
});
