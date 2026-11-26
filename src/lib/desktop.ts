/**
 * The PC app (desktop/, specs/desktop-app.md) puts a small bridge on the page: two calls that
 * print straight to the printer kept for the page's paper. A browser has none. Pure and
 * hand-checked, so the client bundle carries no Zod.
 */

/** The reasons of desktop/src/policy.ts PRINT_REASONS (tests/desktop-bridge.test.ts holds them together). */
export type PrintReason = 'cancelled' | 'failed' | 'refused' | 'no-printer';
export type PrintAnswer = { ok: true; printer: string } | { ok: false; reason: PrintReason };

export interface DesktopBridge {
  print(): Promise<unknown>;
  choosePrinter(): Promise<unknown>;
}

const REASONS: readonly PrintReason[] = ['cancelled', 'failed', 'refused', 'no-printer'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The bridge when this page runs inside the PC app, else null (a browser, or the server). */
export function desktopBridge(from: unknown = (globalThis as { window?: unknown }).window): DesktopBridge | null {
  const bridge = isRecord(from) ? from.studflowDesktop : undefined;
  // The same object every time, so React can watch it without re-rendering.
  return isRecord(bridge) && typeof bridge.print === 'function' && typeof bridge.choosePrinter === 'function'
    ? (bridge as unknown as DesktopBridge)
    : null;
}

const notPrinted = (): PrintAnswer => ({ ok: false, reason: 'failed' });

/** Whatever came back, read as one of the answers the program gives; anything else is "not printed". */
export function readPrintAnswer(value: unknown): PrintAnswer {
  if (!isRecord(value)) return notPrinted();
  if (value.ok === true) {
    const { printer } = value;
    return typeof printer === 'string' && printer.length > 0 && printer.length <= 256 ? { ok: true, printer } : notPrinted();
  }
  const reason = value.ok === false ? REASONS.find((known) => known === value.reason) : undefined;
  return reason === undefined ? notPrinted() : { ok: false, reason };
}

const NOT_PRINTED: Record<PrintReason, string> = {
  cancelled: 'Not printed. No printer was chosen.',
  failed: 'Not printed. Check that the printer is on, then try again.',
  refused: 'Not printed. Open this page again from the bill.',
  'no-printer': 'Not printed. This PC has no printer. Add one in Windows settings.',
};

export function printAnswerText(answer: PrintAnswer): string {
  return answer.ok ? `Sent to ${answer.printer}.` : NOT_PRINTED[answer.reason];
}

/** The PC app has no speech service of its own; the phone and Chrome do. */
export const VOICE_IN_PC_APP = 'Voice works in Chrome or on the phone. Type it here.';
export const VOICE_FAILED = 'Could not listen. Try again, or type it here.';
