/**
 * Money is stored and reasoned about as INTEGER pence everywhere — never floats —
 * so the budget guardrails (balance never exceeded, £3 drift tolerance) stay exact.
 * Convert to/from pounds only at the UI edge.
 */

export function poundsToPence(pounds: number): number {
  return Math.round(pounds * 100);
}

export function penceToPounds(pence: number): number {
  return pence / 100;
}

/** Format pence as a GBP string for display, e.g. 2999 -> "£29.99". */
export function formatGBP(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  return `${sign}£${(abs / 100).toFixed(2)}`;
}
