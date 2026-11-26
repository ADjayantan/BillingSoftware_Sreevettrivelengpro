import { formatDate, istDate } from '@/lib/india';

/**
 * What the Company page says about Google Drive (specs/drive-button.md). One place for each
 * wording; pure, so the page and its buttons share it.
 */

/** The Drive sign-in in force: the Company page's button, the server settings, or none. */
export type DriveState = 'button' | 'settings' | 'off';

/** The one word /api/drive/* sends back to the Company page. */
export type DriveWord = 'connected' | 'denied' | 'expired' | 'failed' | 'forbidden' | 'not-ready';

export const DRIVE_WORDS: Readonly<Record<DriveWord, { text: string; good: boolean }>> = {
  connected: { text: 'Google Drive is connected. New bills go there now.', good: true },
  denied: { text: 'Not connected: Google was told no. Press Connect Google Drive to try again.', good: false },
  expired: { text: 'That took too long, or came from another tab. Press Connect Google Drive again.', good: false },
  failed: { text: 'Google did not answer as it should. Try again in a minute.', good: false },
  forbidden: { text: 'Only the owner can connect Google Drive.', good: false },
  'not-ready': { text: 'This server is not ready for it yet: a setting is missing. Tell the person who set up StudFlow.', good: false },
};

/** The word in the address, when it is one of ours; anything else says nothing. */
export function driveWord(value: string | string[] | undefined): DriveWord | null {
  return typeof value === 'string' && Object.hasOwn(DRIVE_WORDS, value) ? (value as DriveWord) : null;
}

export function driveStateLine(state: DriveState, accountEmail: string | null, connectedAt: string | null): string {
  if (state === 'settings') return 'Connected. It was set up when StudFlow was put in.';
  if (state === 'off') return 'Not connected. Bills and Excel books wait until it is.';
  const since = connectedAt && !Number.isNaN(Date.parse(connectedAt)) ? ` since ${formatDate(istDate(new Date(connectedAt)))}` : '';
  return `Connected${accountEmail ? ` to ${accountEmail}` : ''}${since}`;
}

export function disconnectedWord(left: DriveState): string {
  return left === 'off'
    ? 'Disconnected. New bills wait until Google Drive is connected again.'
    : 'Disconnected. Copies go to the Drive set up when StudFlow was put in.';
}

/** Before migration 009 is on the database: the settings still work, the button does not yet. */
export const DRIVE_NOT_HERE_YET = 'Connecting Google Drive from this page is not ready yet.';

export const DRIVE_DISCONNECT_ASK = 'Disconnect Google Drive? New bills and Excel books wait until it is connected again.';

/** Google's sign-in opens in the normal browser, never inside the PC app (desktop/src/policy.ts). */
export const DRIVE_IN_PC_APP = 'To connect Google Drive, open StudFlow in Chrome or Edge, then Company. Google signs in there, not in this window.';
