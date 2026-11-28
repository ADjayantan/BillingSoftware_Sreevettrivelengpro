import { describe, expect, it } from 'vitest';
import { PRINT_REASONS } from '../desktop/src/policy';
import { DESKTOP_INSTALLER_URL, VOICE_FAILED, VOICE_IN_PC_APP, desktopBridge, printAnswerText, readPrintAnswer } from '@/lib/desktop';

// The page side of the PC app (specs/desktop-app.md, "Printing" and "Voice"): it finds the
// bridge, reads what a print call answered without trusting it, and says it in easy English.

describe('the bridge of the PC app', () => {
  const print = async (): Promise<unknown> => ({ ok: true, printer: 'HP' });
  const choosePrinter = async (): Promise<unknown> => ({ ok: true, printer: 'HP' });

  it('is found only with both calls', () => {
    const bridge = { print, choosePrinter };
    expect(desktopBridge({ studflowDesktop: bridge })).toBe(bridge);
    expect(desktopBridge(undefined)).toBeNull();
    expect(desktopBridge(null)).toBeNull();
    expect(desktopBridge({})).toBeNull();
    expect(desktopBridge({ studflowDesktop: 'x' })).toBeNull();
    expect(desktopBridge({ studflowDesktop: { print } })).toBeNull();
    expect(desktopBridge({ studflowDesktop: { print, choosePrinter: 'x' } })).toBeNull();
  });

  it('is not there without a window (the server)', () => {
    expect(desktopBridge()).toBeNull();
  });
});

describe('what a print call answered', () => {
  it('reads a good answer', () => {
    expect(readPrintAnswer({ ok: true, printer: 'HP LaserJet' })).toEqual({ ok: true, printer: 'HP LaserJet' });
  });

  it('reads every reason the program can give, unchanged', () => {
    for (const reason of PRINT_REASONS) expect(readPrintAnswer({ ok: false, reason })).toEqual({ ok: false, reason });
  });

  it.each([
    null,
    undefined,
    'ok',
    5,
    {},
    { ok: true },
    { ok: true, printer: '' },
    { ok: true, printer: 'P'.repeat(257) },
    { ok: true, printer: 7 },
    { ok: false },
    { ok: false, reason: 'weird' },
    { ok: 'yes', printer: 'HP' },
  ])('reads %j as not printed', (value) => {
    expect(readPrintAnswer(value)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('the words', () => {
  it('say what happened', () => {
    expect(printAnswerText({ ok: true, printer: 'HP LaserJet' })).toBe('Sent to HP LaserJet.');
    expect(printAnswerText({ ok: false, reason: 'cancelled' })).toBe('Not printed. No printer was chosen.');
    expect(printAnswerText({ ok: false, reason: 'failed' })).toBe('Not printed. Check that the printer is on, then try again.');
    expect(printAnswerText({ ok: false, reason: 'refused' })).toBe('Not printed. Open this page again from the bill.');
    expect(printAnswerText({ ok: false, reason: 'no-printer' })).toBe('Not printed. This PC has no printer. Add one in Windows settings.');
    expect(VOICE_IN_PC_APP).toBe('Voice works in Chrome or on the phone. Type it here.');
    expect(VOICE_FAILED).toBe('Could not listen. Try again, or type it here.');
    expect(DESKTOP_INSTALLER_URL).toBe(
      'https://github.com/ADjayantan/BillingSoftware_Sreevettrivelengpro/releases/download/v1.0.0/StudFlow-Setup.exe',
    );
  });
});
