"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that reflects its server action's in-flight state (issue: Approve had no loading
 * feedback and could be double-tapped). `useFormStatus` reads the pending state of the enclosing
 * `<form>`'s action, so this must be rendered *inside* the form whose action it submits. While
 * pending it disables itself (no double-submit — important when the action is a real-money buy that
 * blocks for the whole checkout) and swaps to `pendingLabel`. When the action resolves and the page
 * revalidates, the order moves on (e.g. PROPOSED → ORDERED) and this button re-renders away with it.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  /** Label shown while the action is in flight (e.g. "Approving…"). Falls back to `children`. */
  pendingLabel?: React.ReactNode;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={className}
      data-pending={pending ? "" : undefined}
    >
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}
