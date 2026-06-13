// Shared test-DOM helpers. Section tests grew their own copies of these
// before the count justified a util module; consolidating now so adding
// a new section's tests doesn't add another 20-line preamble.

/** Throw if `x` is null/undefined; `name` is included in the message so
 *  the failure points at the missing element instead of generic NPE. */
export function req<T>(x: T | null | undefined, name: string): T {
  if (x == null) throw new Error(`expected element: ${name}`);
  return x;
}

/** Find a button by exact textContent. Throws with the button's label
 *  in the error so the test report says which one. */
export function buttonByText(
  root: HTMLElement,
  text: string,
): HTMLButtonElement {
  return req(
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === text,
    ),
    `button "${text}"`,
  );
}

/** Wait one microtask — enough to let Solid flush a synchronous signal
 *  update through to its dependent effects. */
export const flush = (): Promise<void> =>
  new Promise<void>((r) => queueMicrotask(r));
