import { createMemo, createSignal, For, Show } from "solid-js";
import { MEM_SIZE } from "../../runloop/bus.ts";
import { MAX_FILE_BYTES, type ProgramFile } from "../../storage/types.ts";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { parseAddr16 } from "../../util/hex.ts";
import { HexAddrInput } from "../hexAddrInput.tsx";
import type { SectionModule } from "../types.ts";

export type PickFile = () => Promise<{
  name: string;
  bytes: Uint8Array;
} | null>;

/**
 * Opens a system file picker and resolves with the chosen file's bytes,
 * or `null` if the user cancels. Held behind a module-level injectable
 * so tests can substitute a deterministic source (`__testing.setPickFile`)
 * — the browser-side picker race (cancel vs change ordering) is one we
 * lost once already; isolating the implementation here lets us pin it
 * down with a dedicated test.
 */
export const defaultPickFile: PickFile = () =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const settle = (v: { name: string; bytes: Uint8Array } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener("change", async () => {
      try {
        const f = input.files?.[0];
        if (!f) {
          settle(null);
          return;
        }
        const buf = await f.arrayBuffer();
        // `new Uint8Array(buf)` is a VIEW over the FileReader buffer;
        // `.slice(0, MAX_FILE_BYTES)` materialises a fresh Uint8Array
        // with its own ArrayBuffer (detached from the File's storage)
        // AND caps to REQ §6.1's 128KB per-file storage limit in one
        // pass. Oversized picks are truncated (the prefix that fits)
        // and warned — the user explicitly chose this file, dropping
        // it entirely would feel like a silent picker failure.
        if (buf.byteLength > MAX_FILE_BYTES) {
          console.warn(
            `[program] "${f.name}" (${buf.byteLength} B) exceeds ` +
              `${MAX_FILE_BYTES}-byte cap; truncating`,
          );
        }
        const bytes = new Uint8Array(buf).slice(0, MAX_FILE_BYTES);
        settle({ name: f.name, bytes });
      } catch (err) {
        // arrayBuffer() can reject if the file became unreadable mid-pick
        // (USB unplug, quota error, etc.). Without this catch the async
        // listener's rejection would escape unhandled and `settle` would
        // never fire, leaving the outer Promise pending forever and the
        // Add stub permanently stuck with `busy === true`.
        console.warn("[program] file read failed; treating as cancel", err);
        settle(null);
      }
    });
    // Standardized cancel event (Chrome 113+, Firefox 91+, Safari 16.4+).
    // Fires when the user closes the picker without choosing a file.
    // Older browsers just leave the promise pending until the next add —
    // a minor leak. The previous "window focus + microtask" workaround
    // raced against `change` and silently turned successful picks into
    // null (the symptom that hit on first real-browser use).
    //
    // Guard: some browsers fire `cancel` alongside `change` when the
    // dialog tears down with a file selected; treating that as a real
    // cancel would race the in-flight `arrayBuffer()` and silently drop
    // the pick. Only honor cancel when there's nothing in `input.files`.
    input.addEventListener("cancel", () => {
      if (!input.files?.length) settle(null);
    });
    input.click();
  });

let pickFileImpl: PickFile = defaultPickFile;
const pickFile = (): ReturnType<PickFile> => pickFileImpl();

const Header = () => {
  const store = useStore();
  return (
    <div class="program-controls">
      <button
        type="button"
        class="btn"
        onClick={() => store.reloadAllFiles()}
        title={STR.program.reloadAllTooltip}
        disabled={store.files.length === 0}
      >
        {STR.program.reloadAll}
      </button>
    </div>
  );
};

const FoldedSummary = () => {
  const store = useStore();
  return (
    <Show
      when={store.files.length > 0}
      fallback={<span class="muted">{STR.program.foldedEmpty}</span>}
    >
      <span class="muted">
        {STR.program.foldedSummaryCount(store.files.length)}
      </span>
    </Show>
  );
};

interface FileRowProps {
  file: ProgramFile;
}

const FileRow = (props: FileRowProps) => {
  const store = useStore();
  const session = createMemo(() => store.fileSessions[props.file.id]);
  // "Dirty" iff loaded once already at a different addr (DESIGN §3.4).
  const dirty = createMemo(() => {
    const s = session();
    if (!s || s.lastLoadedAddr === null) return false;
    return s.lastLoadedAddr !== props.file.loadAddr;
  });
  const truncated = createMemo(() => {
    const overflow = props.file.bytes.length - (MEM_SIZE - props.file.loadAddr);
    return overflow > 0 ? overflow : 0;
  });

  return (
    <div class="program-file-row" classList={{ "is-dirty": dirty() }}>
      <span class="program-file-name" title={STR.program.fileNameLabel}>
        {props.file.name}
      </span>
      <HexAddrInput
        class="program-file-addr"
        committed={() => props.file.loadAddr}
        commit={(v) => {
          if (v !== props.file.loadAddr) {
            store.setFileLoadAddr(props.file.id, v);
          }
        }}
        size={5}
        ariaLabel={STR.program.fileAddrLabel}
        title={dirty() ? STR.program.fileDirtyTooltip : undefined}
      />
      <button
        type="button"
        onClick={() => store.writeFileToMemory(props.file.id)}
        title={
          truncated() > 0
            ? STR.program.fileTruncatedTooltip(truncated())
            : STR.program.fileLoadTooltip
        }
      >
        {STR.program.fileLoadButton}
      </button>
      <label class="program-file-autoload">
        <input
          type="checkbox"
          checked={props.file.autoload}
          aria-label={STR.program.fileAutoloadLabel}
          onChange={(e) =>
            store.setFileAutoload(props.file.id, e.currentTarget.checked)
          }
        />
        <span>{STR.program.fileAutoloadLabel}</span>
      </label>
      <button
        type="button"
        class="program-file-delete"
        onClick={() => store.removeFile(props.file.id)}
        title={STR.program.fileDeleteTooltip}
        aria-label={STR.program.fileDeleteButton}
      >
        ×
      </button>
    </div>
  );
};

// Persistent "new file" stub at the bottom of the file list.
//
// The user types an address + ticks autoload, then clicks Add; the OS
// picker opens, and on success the file is added to the list at the
// typed address and written to memory immediately. The stub's address
// resets to 0000 and autoload to false after each successful add.
//
// `busy` blocks re-entry while a picker is open so a second click can't
// race a slow OS dialog.
const AddStubRow = () => {
  const store = useStore();
  // `addr` is the committed value HexAddrInput renders when unfocused.
  // `onAdd` reads the input's live DOM `.value` rather than this signal
  // so a user can type + click Add without an intermediate Enter/blur:
  // some browsers (Safari, mobile) don't move focus to a button on
  // click, so the input never blurs and the signal stays at its prior
  // committed value. The DOM value always reflects what's on screen.
  const [addr, setAddr] = createSignal(0);
  const [autoload, setAutoload] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [addrInvalid, setAddrInvalid] = createSignal(false);
  // Bumped on successful Add — HexAddrInput's resetSignal effect clears
  // its in-flight text so the placeholder/committed value re-shows.
  const [addrResetVersion, setAddrResetVersion] = createSignal(0);
  let addrInputRef: HTMLInputElement | undefined;

  const reset = () => {
    setAddr(0);
    setAutoload(false);
    setAddrInvalid(false);
    setAddrResetVersion((v) => v + 1);
  };

  const onAdd = async () => {
    if (busy()) return;
    const liveText = addrInputRef?.value ?? "";
    const parsed = parseAddr16(liveText);
    if (parsed === null) {
      setAddrInvalid(true);
      return;
    }
    setAddrInvalid(false);
    setBusy(true);
    try {
      const picked = await pickFile();
      if (!picked) return; // cancelled — leave stub fields untouched
      store.addFile({
        name: picked.name,
        bytes: picked.bytes,
        loadAddr: parsed,
        autoload: autoload(),
      });
      const justAdded = store.files[store.files.length - 1];
      if (justAdded) store.writeFileToMemory(justAdded.id);
      reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="program-file-row program-add-stub">
      <span class="program-file-name program-add-stub-name muted">—</span>
      <HexAddrInput
        class="program-file-addr"
        classList={{ "is-invalid": addrInvalid() }}
        committed={addr}
        commit={(v) => {
          setAddr(v);
          setAddrInvalid(false);
        }}
        resetSignal={addrResetVersion}
        size={5}
        ariaLabel={STR.program.fileAddrLabel}
        disabled={busy()}
        ref={(el) => {
          addrInputRef = el;
        }}
      />
      <button
        type="button"
        class="btn"
        onClick={onAdd}
        disabled={busy()}
        title={STR.program.addFileTooltip}
      >
        {STR.program.addFile}
      </button>
      <label class="program-file-autoload">
        <input
          type="checkbox"
          checked={autoload()}
          disabled={busy()}
          aria-label={STR.program.fileAutoloadLabel}
          onChange={(e) => setAutoload(e.currentTarget.checked)}
        />
        <span>{STR.program.fileAutoloadLabel}</span>
      </label>
    </div>
  );
};

const Body = () => {
  const store = useStore();
  return (
    <div class="program-body">
      <div class="program-file-list">
        <For each={store.files}>{(f) => <FileRow file={f} />}</For>
        <AddStubRow />
      </div>
    </div>
  );
};

export const program: SectionModule = {
  id: "program",
  title: STR.program.title,
  Header,
  FoldedSummary,
  Body,
};

export const __testing = {
  /** Replace the file-picker implementation; pass `null` to restore. */
  setPickFile: (fn: PickFile | null) => {
    pickFileImpl = fn ?? defaultPickFile;
  },
};
