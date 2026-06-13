// Happy-dom render tests for the Program section. Drives the same
// `program.Header` / `program.Body` slots the SectionFrame mounts in
// production, with a real Solid store backed by an in-memory backend
// and a stub bus that mirrors the real Bus64k surface the store needs.
//
// Behaviors that require a real browser (the real `<input type="file">`
// dialog, blur-driven focus changes, CSS resolution) live in
// `program.browser.test.tsx`.

import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryBackend } from "../../storage/memory.ts";
import {
  createAppStore,
  type Store,
  StoreProvider,
} from "../../store/index.ts";
import { makeStubBus, type StubBus } from "../../store/testStubBus.ts";
import { makeStubDbg } from "../../store/testStubDbg.ts";
import { makeStubLoop } from "../../store/testStubLoop.ts";
import { STR } from "../../style/strings.ts";
import { __testing, defaultPickFile, program } from "./index.tsx";

interface Harness {
  store: Store;
  bus: StubBus;
  container: HTMLElement;
  dispose: () => void;
}

async function mount(opts: { folded?: boolean } = {}): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const bus = makeStubBus();
  const store = await createAppStore({
    backend: new MemoryBackend(),
    loop: makeStubLoop(),
    bus,
    dbg: makeStubDbg(),
  });
  const ui = opts.folded
    ? () => (
        <StoreProvider value={store}>
          <program.Header />
          {program.FoldedSummary && <program.FoldedSummary />}
        </StoreProvider>
      )
    : () => (
        <StoreProvider value={store}>
          <program.Header />
          <program.Body />
        </StoreProvider>
      );
  const dispose = render(ui, container);
  return {
    store,
    bus,
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

// Flush microtasks so persistence + signal propagation settle.
const flush = () => new Promise<void>((r) => queueMicrotask(r));

// Tiny helper to narrow query results — keeps the tests free of `!`
// assertions Biome's `noNonNullAssertion` rule rejects. A missing node
// is itself a test failure, not something to silently `?.` past.
function req<T>(x: T | null | undefined, name: string): T {
  if (x == null) throw new Error(`expected element: ${name}`);
  return x;
}

function getStubRow(container: HTMLElement): HTMLElement {
  return req(
    container.querySelector<HTMLElement>(".program-add-stub"),
    "add-stub row",
  );
}

function getStubAddr(container: HTMLElement): HTMLInputElement {
  return req(
    getStubRow(container).querySelector<HTMLInputElement>(".program-file-addr"),
    "stub addr input",
  );
}

function getStubAddBtn(container: HTMLElement): HTMLButtonElement {
  return req(
    getStubRow(container).querySelector<HTMLButtonElement>("button"),
    "stub Add button",
  );
}

function getStubAutoload(container: HTMLElement): HTMLInputElement {
  return req(
    getStubRow(container).querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    ),
    "stub autoload checkbox",
  );
}

let harness: Harness;

afterEach(() => {
  harness?.dispose();
  __testing.setPickFile(null);
});

describe("Program section — happy-dom", () => {
  beforeEach(async () => {
    harness = await mount();
  });

  it("renders only the add-stub row when no files are loaded; no empty hint", () => {
    const rows = harness.container.querySelectorAll(".program-file-row");
    expect(rows.length).toBe(1);
    expect(rows[0].classList.contains("program-add-stub")).toBe(true);
    // Reload All button disabled when there are no files.
    const buttons = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>(
        ".program-controls button",
      ),
    );
    const reloadBtn = buttons.find(
      (b) => b.textContent === STR.program.reloadAll,
    );
    expect(reloadBtn?.disabled).toBe(true);
    // The Header no longer carries its own "Add file" button — the stub
    // row's Add is the only entry point.
    expect(buttons.some((b) => b.textContent === STR.program.addFile)).toBe(
      false,
    );
  });

  it("add-stub stays at the bottom even after real files are added", async () => {
    harness.store.addFile({
      name: "rom.bin",
      bytes: new Uint8Array([0]),
      loadAddr: 0,
    });
    harness.store.addFile({
      name: "data.bin",
      bytes: new Uint8Array([0]),
      loadAddr: 0x4000,
    });
    await flush();
    const rows = harness.container.querySelectorAll(".program-file-row");
    expect(rows.length).toBe(3);
    expect(rows[0].querySelector(".program-file-name")?.textContent).toBe(
      "rom.bin",
    );
    expect(rows[1].querySelector(".program-file-name")?.textContent).toBe(
      "data.bin",
    );
    expect(rows[2].classList.contains("program-add-stub")).toBe(true);
  });

  it("stub Add → picker → file added, written to mem, stub reset", async () => {
    __testing.setPickFile(async () => ({
      name: "mixer.bin",
      bytes: new Uint8Array([0x12, 0x34, 0x56]),
    }));
    const addr = getStubAddr(harness.container);
    const autoload = getStubAutoload(harness.container);
    // Type in addr + tick autoload before clicking Add.
    addr.value = "8000";
    addr.dispatchEvent(new Event("input", { bubbles: true }));
    autoload.click();
    expect(autoload.checked).toBe(true);
    // Click Add — picker resolves → file appended, written, stub reset.
    getStubAddBtn(harness.container).click();
    await flush();
    // Need a second microtask flush because pickFile is async and the
    // store mutation lands in the continuation.
    await flush();
    expect(harness.store.files.length).toBe(1);
    expect(harness.store.files[0].name).toBe("mixer.bin");
    expect(harness.store.files[0].loadAddr).toBe(0x8000);
    expect(harness.store.files[0].autoload).toBe(true);
    // Bytes wrote through to mem.
    expect(harness.bus.mem[0x8000]).toBe(0x12);
    expect(harness.bus.mem[0x8001]).toBe(0x34);
    expect(harness.bus.mem[0x8002]).toBe(0x56);
    // Stub reset: addr=0000, autoload off.
    const addr2 = getStubAddr(harness.container);
    expect(addr2.value).toBe("0000");
    expect(getStubAutoload(harness.container).checked).toBe(false);
    // New file row sits ABOVE the stub.
    const rows = harness.container.querySelectorAll(".program-file-row");
    expect(rows.length).toBe(2);
    expect(rows[0].classList.contains("program-add-stub")).toBe(false);
    expect(rows[1].classList.contains("program-add-stub")).toBe(true);
  });

  it("invalid hex in stub addr blocks the picker and flags the input", async () => {
    let pickerCalls = 0;
    __testing.setPickFile(async () => {
      pickerCalls++;
      return null;
    });
    const addr = getStubAddr(harness.container);
    addr.value = "zzzz";
    addr.dispatchEvent(new Event("input", { bubbles: true }));
    getStubAddBtn(harness.container).click();
    await flush();
    expect(pickerCalls).toBe(0);
    expect(addr.classList.contains("is-invalid")).toBe(true);
    expect(harness.store.files.length).toBe(0);
  });

  it("cancelled picker leaves the stub fields untouched", async () => {
    __testing.setPickFile(async () => null);
    const addr = getStubAddr(harness.container);
    addr.value = "1234";
    addr.dispatchEvent(new Event("input", { bubbles: true }));
    getStubAutoload(harness.container).click();
    getStubAddBtn(harness.container).click();
    await flush();
    await flush();
    expect(harness.store.files.length).toBe(0);
    const addr2 = getStubAddr(harness.container);
    expect(addr2.value).toBe("1234");
    expect(getStubAutoload(harness.container).checked).toBe(true);
  });

  it("renders one file row per file with name, addr, autoload, delete", async () => {
    harness.store.addFile({
      name: "rom.bin",
      bytes: new Uint8Array([1, 2, 3]),
      loadAddr: 0x8000,
    });
    harness.store.addFile({
      name: "data.bin",
      bytes: new Uint8Array([0xff]),
      loadAddr: 0xc000,
      autoload: true,
    });
    await flush();
    const fileRows = Array.from(
      harness.container.querySelectorAll(".program-file-row"),
    ).filter((r) => !r.classList.contains("program-add-stub"));
    expect(fileRows.length).toBe(2);
    // First row: rom.bin @ 8000, autoload off.
    expect(fileRows[0].querySelector(".program-file-name")?.textContent).toBe(
      "rom.bin",
    );
    const addr0 =
      fileRows[0].querySelector<HTMLInputElement>(".program-file-addr");
    expect(addr0?.value).toBe("8000");
    const autoload0 = fileRows[0].querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(autoload0?.checked).toBe(false);
    // Second row: data.bin @ C000, autoload on.
    const addr1 =
      fileRows[1].querySelector<HTMLInputElement>(".program-file-addr");
    expect(addr1?.value).toBe("C000");
    const autoload1 = fileRows[1].querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(autoload1?.checked).toBe(true);
  });

  it("Load button writes the file's bytes into bus.mem and marks the session loaded", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0xaa, 0xbb, 0xcc]),
      loadAddr: 0x100,
    });
    await flush();
    const id = harness.store.files[0].id;
    expect(harness.store.fileSessions[id]?.lastLoadedAddr).toBeNull();
    const loadBtn = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>(
        ".program-file-row button",
      ),
    ).find((b) => b.textContent === STR.program.fileLoadButton);
    loadBtn?.click();
    expect(harness.bus.mem[0x100]).toBe(0xaa);
    expect(harness.bus.mem[0x101]).toBe(0xbb);
    expect(harness.bus.mem[0x102]).toBe(0xcc);
    expect(harness.store.fileSessions[id]?.lastLoadedAddr).toBe(0x100);
  });

  it("autoload checkbox on a real row toggles the file's autoload flag", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0]),
      loadAddr: 0,
    });
    await flush();
    const realRow = req(
      Array.from(harness.container.querySelectorAll(".program-file-row")).find(
        (r) => !r.classList.contains("program-add-stub"),
      ),
      "file row",
    );
    const cb = req(
      realRow.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      "autoload checkbox",
    );
    expect(harness.store.files[0].autoload).toBe(false);
    cb.click();
    expect(harness.store.files[0].autoload).toBe(true);
  });

  it("delete button removes the file", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0]),
      loadAddr: 0,
    });
    await flush();
    const fileRows = Array.from(
      harness.container.querySelectorAll(".program-file-row"),
    ).filter((r) => !r.classList.contains("program-add-stub"));
    expect(fileRows.length).toBe(1);
    const del = req(
      harness.container.querySelector<HTMLButtonElement>(
        ".program-file-delete",
      ),
      "delete button",
    );
    del.click();
    expect(harness.store.files.length).toBe(0);
    const after = Array.from(
      harness.container.querySelectorAll(".program-file-row"),
    ).filter((r) => !r.classList.contains("program-add-stub"));
    expect(after.length).toBe(0);
  });

  it("real-row addr Enter commits the parsed hex value to the store", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0]),
      loadAddr: 0,
    });
    await flush();
    const realRow = req(
      Array.from(harness.container.querySelectorAll(".program-file-row")).find(
        (r) => !r.classList.contains("program-add-stub"),
      ),
      "file row",
    );
    const addr = req(
      realRow.querySelector<HTMLInputElement>(".program-file-addr"),
      "addr input",
    );
    addr.value = "$8000";
    addr.dispatchEvent(new Event("input", { bubbles: true }));
    addr.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(harness.store.files[0].loadAddr).toBe(0x8000);
    expect(addr.value).toBe("8000");
  });

  it("real-row addr Escape reverts the input to the stored value", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0]),
      loadAddr: 0x4000,
    });
    await flush();
    const realRow = req(
      Array.from(harness.container.querySelectorAll(".program-file-row")).find(
        (r) => !r.classList.contains("program-add-stub"),
      ),
      "file row",
    );
    const addr = req(
      realRow.querySelector<HTMLInputElement>(".program-file-addr"),
      "addr input",
    );
    addr.value = "garbage";
    addr.dispatchEvent(new Event("input", { bubbles: true }));
    addr.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(addr.value).toBe("4000");
    expect(harness.store.files[0].loadAddr).toBe(0x4000);
  });

  it("real-row addr Enter on invalid hex flags the input and does not change the store", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0]),
      loadAddr: 0x100,
    });
    await flush();
    const realRow = req(
      Array.from(harness.container.querySelectorAll(".program-file-row")).find(
        (r) => !r.classList.contains("program-add-stub"),
      ),
      "file row",
    );
    const addr = req(
      realRow.querySelector<HTMLInputElement>(".program-file-addr"),
      "addr input",
    );
    addr.value = "zzzz";
    addr.dispatchEvent(new Event("input", { bubbles: true }));
    addr.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(harness.store.files[0].loadAddr).toBe(0x100);
    expect(addr.classList.contains("is-invalid")).toBe(true);
  });

  it("dirty highlight applies after addr edit but before reload", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0]),
      loadAddr: 0x100,
    });
    await flush();
    const loadBtn = req(
      Array.from(
        harness.container.querySelectorAll<HTMLButtonElement>(
          ".program-file-row button",
        ),
      ).find((b) => b.textContent === STR.program.fileLoadButton),
      "row Load button",
    );
    loadBtn.click();
    const realRow = req(
      Array.from(harness.container.querySelectorAll(".program-file-row")).find(
        (r) => !r.classList.contains("program-add-stub"),
      ),
      "file row",
    );
    const addr = req(
      realRow.querySelector<HTMLInputElement>(".program-file-addr"),
      "addr input",
    );
    addr.value = "200";
    addr.dispatchEvent(new Event("input", { bubbles: true }));
    addr.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(realRow.classList.contains("is-dirty")).toBe(true);
    loadBtn.click();
    expect(realRow.classList.contains("is-dirty")).toBe(false);
  });

  it("Reload All writes every file's bytes regardless of autoload flag", async () => {
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0xaa]),
      loadAddr: 0x100,
      autoload: true,
    });
    harness.store.addFile({
      name: "b",
      bytes: new Uint8Array([0xbb]),
      loadAddr: 0x200,
      autoload: false,
    });
    await flush();
    harness.bus.mem.fill(0);
    const reload = req(
      Array.from(
        harness.container.querySelectorAll<HTMLButtonElement>(
          ".program-controls button",
        ),
      ).find((b) => b.textContent === STR.program.reloadAll),
      "Reload all button",
    );
    reload.click();
    expect(harness.bus.mem[0x100]).toBe(0xaa);
    expect(harness.bus.mem[0x200]).toBe(0xbb);
  });
});

describe("Program section — folded summary", () => {
  afterEach(() => {
    harness?.dispose();
  });

  it("shows the empty hint with no files", async () => {
    harness = await mount({ folded: true });
    expect(harness.container.textContent).toContain(STR.program.foldedEmpty);
  });

  it("shows a file count when files are present", async () => {
    harness = await mount({ folded: true });
    harness.store.addFile({
      name: "a",
      bytes: new Uint8Array([0]),
      loadAddr: 0,
    });
    await flush();
    expect(harness.container.textContent).toContain(
      STR.program.foldedSummaryCount(1),
    );
  });
});

// Regression tests for `defaultPickFile` — the file-picker primitive
// that lives in the section module. The previous implementation used a
// `window` focus listener + microtask check that raced the `change`
// event and silently turned successful picks into `null`. These tests
// pin down the contract: a change event with a non-empty `files` always
// resolves with the file's bytes, regardless of what `focus`/`blur` the
// browser dispatches around the picker.
describe("defaultPickFile", () => {
  function getLastFileInput(): HTMLInputElement {
    const inputs =
      document.body.querySelectorAll<HTMLInputElement>('input[type="file"]');
    if (inputs.length === 0) throw new Error("no file input in DOM");
    return inputs[inputs.length - 1];
  }

  function makeFile(name: string, bytes: number[]): File {
    return new File([new Uint8Array(bytes)], name, {
      type: "application/octet-stream",
    });
  }

  async function fireChange(
    input: HTMLInputElement,
    file: File,
  ): Promise<void> {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Give the change handler's `await f.arrayBuffer()` a turn.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  it("resolves with the chosen file's bytes when change fires", async () => {
    const promise = defaultPickFile();
    const input = getLastFileInput();
    await fireChange(input, makeFile("rom.bin", [0x12, 0x34]));
    const result = await promise;
    expect(result?.name).toBe("rom.bin");
    expect(Array.from(result?.bytes ?? [])).toEqual([0x12, 0x34]);
    expect(document.body.contains(input)).toBe(false);
  });

  it("resolves with null when cancel event fires (no file chosen)", async () => {
    const promise = defaultPickFile();
    const input = getLastFileInput();
    input.dispatchEvent(new Event("cancel", { bubbles: false }));
    const result = await promise;
    expect(result).toBeNull();
    expect(document.body.contains(input)).toBe(false);
  });

  it("ignores a window focus event before change — the picked file still wins", async () => {
    const promise = defaultPickFile();
    const input = getLastFileInput();
    window.dispatchEvent(new Event("focus"));
    await new Promise<void>((r) => queueMicrotask(r));
    await fireChange(input, makeFile("late.bin", [0xaa, 0xbb]));
    const result = await promise;
    expect(result?.name).toBe("late.bin");
    expect(Array.from(result?.bytes ?? [])).toEqual([0xaa, 0xbb]);
  });

  it("ignores a window focus event after change — the picked file still wins", async () => {
    const promise = defaultPickFile();
    const input = getLastFileInput();
    await fireChange(input, makeFile("early.bin", [0x99]));
    window.dispatchEvent(new Event("focus"));
    await new Promise<void>((r) => queueMicrotask(r));
    const result = await promise;
    expect(result?.name).toBe("early.bin");
  });

  it("a change event with an empty files list resolves with null", async () => {
    const promise = defaultPickFile();
    const input = getLastFileInput();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(await promise).toBeNull();
  });
});
