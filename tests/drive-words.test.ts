import { describe, expect, it } from 'vitest';
import { DRIVE_WORDS, disconnectedWord, driveStateLine, driveWord } from '@/lib/drive-words';

// What the Company page says about Google Drive (specs/drive-button.md), in easy English, in one place.

describe('the word Google Drive sends back', () => {
  it('is one of a few, or nothing', () => {
    expect(driveWord('connected')).toBe('connected');
    expect(driveWord('not-ready')).toBe('not-ready');
    for (const odd of [undefined, '', 'CONNECTED', 'connected ', '<script>', ['connected', 'failed']]) expect(driveWord(odd)).toBeNull();
  });

  it('has a sentence for each, good only when it worked', () => {
    expect(Object.keys(DRIVE_WORDS).sort()).toEqual(['connected', 'denied', 'expired', 'failed', 'forbidden', 'not-ready']);
    expect(DRIVE_WORDS.connected).toEqual({ text: 'Google Drive is connected. New bills go there now.', good: true });
    expect(Object.entries(DRIVE_WORDS).filter(([, said]) => said.good).map(([word]) => word)).toEqual(['connected']);
  });
});

describe('where Drive stands', () => {
  it('names the account and the day of the button, else what there is', () => {
    expect(driveStateLine('button', 'owner@example.com', '2026-11-26T05:00:00+00:00')).toBe('Connected to owner@example.com since 26 Nov 2026');
    expect(driveStateLine('button', null, '2026-11-26T20:00:00+00:00')).toBe('Connected since 27 Nov 2026'); // a date in India
    expect(driveStateLine('button', null, null)).toBe('Connected');
    expect(driveStateLine('settings', null, null)).toBe('Connected. It was set up when StudFlow was put in.');
    expect(driveStateLine('off', null, null)).toBe('Not connected. Bills and Excel books wait until it is.');
  });

  it('says what is left after Disconnect', () => {
    expect(disconnectedWord('off')).toBe('Disconnected. New bills wait until Google Drive is connected again.');
    expect(disconnectedWord('settings')).toBe('Disconnected. Copies go to the Drive set up when StudFlow was put in.');
  });
});
