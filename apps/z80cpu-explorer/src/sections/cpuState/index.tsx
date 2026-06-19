import type { CpuState, RegBank } from "@dcorp80/z80cpu";
import { type Component, createMemo, For, Show } from "solid-js";
import { useStore } from "../../store/index.ts";
import { STR } from "../../style/strings.ts";
import { formatHex } from "../../util/hex.ts";
import type { SectionModule } from "../types.ts";

// 16-bit synthetic regs built from byte pairs. We don't store them in
// CpuState because they're derived; reading off `main`/`alt` keeps a
// single source of truth and avoids syncing two representations.
const af = (b: RegBank) => (b.a << 8) | b.f;
const bc = (b: RegBank) => (b.b << 8) | b.c;
const de = (b: RegBank) => (b.d << 8) | b.e;
const hl = (b: RegBank) => (b.h << 8) | b.l;

// Decode `F` into 8 named bits, MSB first. Label order:
// (S Z Y5 H X3 P/V N C). We don't depend on the dbg's `decodeFlags()`
// helper here because the order it returns is fixed; we want explicit
// MSB→LSB iteration for the bit grid.
function flagBits(f: number): boolean[] {
  return [
    (f & 0x80) !== 0,
    (f & 0x40) !== 0,
    (f & 0x20) !== 0,
    (f & 0x10) !== 0,
    (f & 0x08) !== 0,
    (f & 0x04) !== 0,
    (f & 0x02) !== 0,
    (f & 0x01) !== 0,
  ];
}

// "Did this register change since the diff baseline?" — feeds the
// .is-changed class. Computed on every cpuState/prev change per
// Cells always carry .is-changed when diff differs.
// `prevCpuStateAtBoundary` is advanced ONLY at boundary pauses, so
// mid-instruction states naturally inherit the most recent boundary's
// highlight set. The body wrapper's .is-mid-instruction rule suppresses
// the highlight visually without changing the DOM.
function diffKeys(curr: CpuState, prev: CpuState): Set<string> {
  const s = new Set<string>();
  if (curr.pc !== prev.pc) s.add("pc");
  if (curr.sp !== prev.sp) s.add("sp");
  if (curr.ix !== prev.ix) s.add("ix");
  if (curr.iy !== prev.iy) s.add("iy");
  if (curr.i !== prev.i) s.add("i");
  if (curr.r !== prev.r) s.add("r");
  // Main bank — combined and split (so AF, A, and F all light up when F changes).
  if (curr.main.a !== prev.main.a) {
    s.add("a");
    s.add("af");
  }
  if (curr.main.f !== prev.main.f) {
    s.add("f");
    s.add("af");
  }
  if (curr.main.b !== prev.main.b) {
    s.add("b");
    s.add("bc");
  }
  if (curr.main.c !== prev.main.c) {
    s.add("c");
    s.add("bc");
  }
  if (curr.main.d !== prev.main.d) {
    s.add("d");
    s.add("de");
  }
  if (curr.main.e !== prev.main.e) {
    s.add("e");
    s.add("de");
  }
  if (curr.main.h !== prev.main.h) {
    s.add("h");
    s.add("hl");
  }
  if (curr.main.l !== prev.main.l) {
    s.add("l");
    s.add("hl");
  }
  // IX/IY split halves
  if (curr.ix >> 8 !== prev.ix >> 8) s.add("ixh");
  if ((curr.ix & 0xff) !== (prev.ix & 0xff)) s.add("ixl");
  if (curr.iy >> 8 !== prev.iy >> 8) s.add("iyh");
  if ((curr.iy & 0xff) !== (prev.iy & 0xff)) s.add("iyl");
  // Shadow regs — single key per pair (we render them combined only).
  if (af(curr.alt) !== af(prev.alt)) s.add("af'");
  if (bc(curr.alt) !== bc(prev.alt)) s.add("bc'");
  if (de(curr.alt) !== de(prev.alt)) s.add("de'");
  if (hl(curr.alt) !== hl(prev.alt)) s.add("hl'");
  // Interrupt state
  if (curr.iff1 !== prev.iff1) s.add("iff1");
  if (curr.iff2 !== prev.iff2) s.add("iff2");
  if (curr.im !== prev.im) s.add("im");
  return s;
}

const Header: Component = () => null;

const FoldedSummary = () => {
  const store = useStore();
  const s = () => store.cpuState();
  return (
    <span class="cpuState-folded">
      <Cell label="AF" value={af(s().main)} width={4} />
      <Cell label="BC" value={bc(s().main)} width={4} />
      <Cell label="DE" value={de(s().main)} width={4} />
      <Cell label="HL" value={hl(s().main)} width={4} />
      <Cell label="PC" value={s().pc} width={4} />
      <Cell label="SP" value={s().sp} width={4} />
    </span>
  );
};

interface CellProps {
  label: string;
  value: number;
  width: number;
  changed?: boolean;
  dataKey?: string;
}
// One labeled register: `LABEL=HEXHEX`. `changed` flips on a CSS class
// that the parent's .is-mid-instruction rule visually overrides, so the
// same markup applies at boundary (bright) and mid-instruction (dim).
const Cell = (props: CellProps) => (
  <span
    class="cpuState-cell"
    classList={{ "is-changed": props.changed === true }}
    data-key={props.dataKey ?? props.label.toLowerCase()}
  >
    <span class="cpuState-label">{props.label}</span>
    <span class="cpuState-value">{formatHex(props.value, props.width)}</span>
  </span>
);

const FlagsRow = (props: { f: number; changed: boolean }) => {
  const bits = createMemo(() => flagBits(props.f));
  return (
    <div class="cpuState-flags-row">
      <span class="cpuState-label">{STR.cpuState.flagsLabel}</span>
      <div
        class="cpuState-flags-grid"
        classList={{ "is-changed": props.changed }}
      >
        <For each={STR.cpuState.flagBits}>
          {(label, i) => (
            <span
              class="cpuState-flag-cell"
              classList={{ "is-set": bits()[i()] }}
              data-flag={label}
            >
              <span class="cpuState-flag-label">{label}</span>
              <span class="cpuState-flag-bit">{bits()[i()] ? "1" : "0"}</span>
            </span>
          )}
        </For>
      </div>
    </div>
  );
};

const Body = () => {
  const store = useStore();
  // No per-cell or per-memo boundary gate ("CSS owns the
  // gating"). The store advances `prevCpuStateAtBoundary` only at
  // boundary pauses, so the diff is naturally boundary-to-current;
  // mid-instruction states inherit the most recent boundary's
  // highlight set, and the parent .is-mid-instruction CSS rule
  // visually suppresses it.
  const changed = createMemo(() =>
    diffKeys(store.cpuState(), store.prevCpuStateAtBoundary()),
  );
  const has = (k: string): boolean => changed().has(k);
  const s = () => store.cpuState();
  const mid = () => !store.atInstructionBoundary();

  return (
    <div
      class="cpuState-body"
      classList={{ "is-mid-instruction": mid() }}
      title={mid() ? STR.cpuState.midInstructionTitle : undefined}
    >
      <div class="cpuState-grid">
        <div class="cpuState-row">
          <Cell label="AF" value={af(s().main)} width={4} changed={has("af")} />
          <Cell label="A" value={s().main.a} width={2} changed={has("a")} />
          <Cell label="F" value={s().main.f} width={2} changed={has("f")} />
        </div>
        <div class="cpuState-row">
          <Cell label="BC" value={bc(s().main)} width={4} changed={has("bc")} />
          <Cell label="B" value={s().main.b} width={2} changed={has("b")} />
          <Cell label="C" value={s().main.c} width={2} changed={has("c")} />
        </div>
        <div class="cpuState-row">
          <Cell label="DE" value={de(s().main)} width={4} changed={has("de")} />
          <Cell label="D" value={s().main.d} width={2} changed={has("d")} />
          <Cell label="E" value={s().main.e} width={2} changed={has("e")} />
        </div>
        <div class="cpuState-row">
          <Cell label="HL" value={hl(s().main)} width={4} changed={has("hl")} />
          <Cell label="H" value={s().main.h} width={2} changed={has("h")} />
          <Cell label="L" value={s().main.l} width={2} changed={has("l")} />
        </div>
        <div class="cpuState-row">
          <Cell label="IX" value={s().ix} width={4} changed={has("ix")} />
          <Cell
            label="IXH"
            value={s().ix >> 8}
            width={2}
            changed={has("ixh")}
          />
          <Cell
            label="IXL"
            value={s().ix & 0xff}
            width={2}
            changed={has("ixl")}
          />
        </div>
        <div class="cpuState-row">
          <Cell label="IY" value={s().iy} width={4} changed={has("iy")} />
          <Cell
            label="IYH"
            value={s().iy >> 8}
            width={2}
            changed={has("iyh")}
          />
          <Cell
            label="IYL"
            value={s().iy & 0xff}
            width={2}
            changed={has("iyl")}
          />
        </div>
        <div class="cpuState-row">
          <Cell label="PC" value={s().pc} width={4} changed={has("pc")} />
          <Cell label="SP" value={s().sp} width={4} changed={has("sp")} />
          <Cell label="I" value={s().i} width={2} changed={has("i")} />
          <Cell label="R" value={s().r} width={2} changed={has("r")} />
        </div>
      </div>

      {/* Shadow bank — always visible, no fold. */}
      <div class="cpuState-shadow">
        <Cell
          label={`AF${STR.cpuState.shadowMark}`}
          value={af(s().alt)}
          width={4}
          changed={has("af'")}
          dataKey="af-shadow"
        />
        <Cell
          label={`BC${STR.cpuState.shadowMark}`}
          value={bc(s().alt)}
          width={4}
          changed={has("bc'")}
          dataKey="bc-shadow"
        />
        <Cell
          label={`DE${STR.cpuState.shadowMark}`}
          value={de(s().alt)}
          width={4}
          changed={has("de'")}
          dataKey="de-shadow"
        />
        <Cell
          label={`HL${STR.cpuState.shadowMark}`}
          value={hl(s().alt)}
          width={4}
          changed={has("hl'")}
          dataKey="hl-shadow"
        />
      </div>

      <FlagsRow f={s().main.f} changed={has("f")} />

      <div class="cpuState-irq">
        <span
          class="cpuState-cell"
          classList={{ "is-changed": has("iff1") }}
          data-key="iff1"
        >
          <span class="cpuState-label">{STR.cpuState.iff1}</span>
          <span class="cpuState-value">{s().iff1 ? "1" : "0"}</span>
        </span>
        <span
          class="cpuState-cell"
          classList={{ "is-changed": has("iff2") }}
          data-key="iff2"
        >
          <span class="cpuState-label">{STR.cpuState.iff2}</span>
          <span class="cpuState-value">{s().iff2 ? "1" : "0"}</span>
        </span>
        <span
          class="cpuState-cell"
          classList={{ "is-changed": has("im") }}
          data-key="im"
        >
          <span class="cpuState-label">{STR.cpuState.im}</span>
          <span class="cpuState-value">{s().im}</span>
        </span>
        <Show when={s().nmiPending}>
          <span class="cpuState-nmi-pending">NMI pending</span>
        </Show>
      </div>
    </div>
  );
};

export const cpuState: SectionModule = {
  id: "cpuState",
  title: STR.cpuState.title,
  Header,
  FoldedSummary,
  Body,
};
