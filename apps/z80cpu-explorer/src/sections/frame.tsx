import { type Component, createSignal, Show } from "solid-js";
import { useStore } from "../store/index.ts";
import { STR } from "../style/strings.ts";
import { getSectionModule } from "./sectionRegistry.ts";

const DRAG_MIME = "application/x-z80cpu-explorer-section";

type DropEdge = "above" | "below" | null;

export interface SectionFrameProps {
  id: string;
  folded: boolean;
}

export const SectionFrame: Component<SectionFrameProps> = (props) => {
  const store = useStore();
  const mod = getSectionModule(props.id);
  if (!mod) return null;

  // Drag source = the handle button. Drop target = the section frame.
  // Putting `draggable` on the handle (not the section) means dragstart
  // only ever fires when the user grabs the handle — no need for an
  // explicit "armed" filter, and Playwright's synthetic drag works
  // without first synthesizing pointerdown on the handle.
  let sectionEl: HTMLElement;
  const [dragging, setDragging] = createSignal(false);
  const [dropEdge, setDropEdge] = createSignal<DropEdge>(null);

  const onDragStart = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(DRAG_MIME, props.id);
    e.dataTransfer.effectAllowed = "move";
    // Use the section element as the drag image so the visual ghost
    // matches what the user is moving, not the small handle.
    if (sectionEl) e.dataTransfer.setDragImage(sectionEl, 12, 12);
    setDragging(true);
  };

  const onDragEnd = () => {
    setDragging(false);
    setDropEdge(null);
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropEdge(e.clientY < midY ? "above" : "below");
  };

  const onDragLeave = (e: DragEvent) => {
    // Only clear when leaving the section itself, not on child boundaries.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    ) {
      setDropEdge(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    const sourceId = e.dataTransfer?.getData(DRAG_MIME);
    const edge = dropEdge();
    setDropEdge(null);
    if (!sourceId || sourceId === props.id || !edge) return;
    e.preventDefault();
    const order = store.sections
      .map((s) => s.id)
      .filter((id) => id !== sourceId);
    const targetIdx = order.indexOf(props.id);
    if (targetIdx < 0) return;
    const insertAt = edge === "above" ? targetIdx : targetIdx + 1;
    order.splice(insertAt, 0, sourceId);
    store.reorderSections(order);
  };

  const FoldedSummary = mod.FoldedSummary;

  // Sections opt in to a fold-lock (App-shell pattern) by exporting an
  // `isCollapseLocked` accessor. The lock blocks *collapse only* —
  // unfolding a locked section stays allowed so a user who somehow
  // ended up with a locked-and-folded section (e.g. async persist
  // failure right after Save) can still reach the body's Save / Discard.
  const foldLocked = () => mod.isCollapseLocked?.(store) === true;
  const chevronDisabled = () => foldLocked() && !props.folded;

  return (
    <section
      ref={(el) => {
        sectionEl = el;
      }}
      class="section-frame"
      classList={{
        "is-dragging": dragging(),
        "drop-above": dropEdge() === "above",
        "drop-below": dropEdge() === "below",
        "is-folded": props.folded,
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-labelledby={`section-${mod.id}-title`}
    >
      <header class="section-header">
        <button
          type="button"
          class="fold-chevron"
          aria-label={STR.frame.foldLabel(props.folded)}
          aria-expanded={!props.folded}
          disabled={chevronDisabled()}
          title={chevronDisabled() ? STR.frame.foldLockedTooltip : undefined}
          onClick={() => {
            if (chevronDisabled()) return;
            store.toggleSectionFold(props.id);
          }}
        >
          {props.folded ? "▶" : "▼"}
        </button>
        <button
          type="button"
          class="drag-handle"
          aria-label={STR.frame.dragLabel}
          title={STR.frame.dragTooltip}
          draggable={true}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          ⋮⋮
        </button>
        <h2 id={`section-${mod.id}-title`} class="section-title">
          {mod.title}
        </h2>
        {FoldedSummary && (
          <Show when={props.folded}>
            <div class="folded-summary">
              <FoldedSummary />
            </div>
          </Show>
        )}
        <div class="section-header-controls">
          <mod.Header />
        </div>
      </header>
      <Show when={!props.folded}>
        <div class="section-body">
          <mod.Body />
        </div>
      </Show>
    </section>
  );
};
