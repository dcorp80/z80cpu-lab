// Page-nav button row shared by Memory and IO. All four buttons are
// always rendered; the ones at the current boundary are disabled
// rather than hidden, so the layout doesn't shift as the user pages
// and `<<` / `>>` stay where the muscle memory expects them.

import { type Accessor, type Component, createMemo } from "solid-js";
import { STR } from "../style/strings.ts";
import { formatHex } from "../util/hex.ts";
import {
  lastPageBase,
  nextPageBase,
  pageBoundaryFlags,
  prevPageBase,
} from "./paging.ts";

export interface PageNavRowProps {
  /** Address whose page drives the nav — typically `viewPageBase`,
   *  the page currently shown in the section body. */
  addr: Accessor<number>;
  /** One of `PAGE_SIZE_OPTIONS`. */
  pageSize: Accessor<number>;
  /** Click handler — receives the destination page's base address.
   *  Caller decides whether to bump jump-version, re-scroll, etc. */
  setAddr: (addr: number) => void;
}

export const PageNavRow: Component<PageNavRowProps> = (props) => {
  const flags = createMemo(() =>
    pageBoundaryFlags(props.addr(), props.pageSize()),
  );
  const prev = createMemo(() => prevPageBase(props.addr(), props.pageSize()));
  const next = createMemo(() => nextPageBase(props.addr(), props.pageSize()));
  const last = createMemo(() => lastPageBase(props.pageSize()));

  // Disabled-button labels still need a displayed base address —
  // `prev()` is null at page 0, `next()` is null at last page.
  // Fall back to the current page's base in those cases; the button
  // is disabled so the label is purely informational.
  const prevLabelBase = createMemo(() => {
    const p = prev();
    return p === null ? 0 : p;
  });
  const nextLabelBase = createMemo(() => {
    const n = next();
    return n === null ? last() : n;
  });

  return (
    <div class="page-nav-row" role="toolbar" aria-label={STR.pageNav.ariaLabel}>
      <button
        type="button"
        class="btn page-nav-first"
        disabled={flags().atFirst}
        title={STR.pageNav.firstTooltip}
        onClick={() => props.setAddr(0)}
      >
        {STR.pageNav.first}
      </button>
      <button
        type="button"
        class="btn page-nav-prev"
        disabled={flags().atFirst}
        title={STR.pageNav.prevTooltip}
        onClick={() => {
          const p = prev();
          if (p !== null) props.setAddr(p);
        }}
      >
        {STR.pageNav.prev(formatHex(prevLabelBase(), 4))}
      </button>
      <button
        type="button"
        class="btn page-nav-next"
        disabled={flags().atLast}
        title={STR.pageNav.nextTooltip}
        onClick={() => {
          const n = next();
          if (n !== null) props.setAddr(n);
        }}
      >
        {STR.pageNav.next(formatHex(nextLabelBase(), 4))}
      </button>
      <button
        type="button"
        class="btn page-nav-last"
        disabled={flags().atLast}
        title={STR.pageNav.lastTooltip}
        onClick={() => props.setAddr(last())}
      >
        {STR.pageNav.last}
      </button>
    </div>
  );
};
