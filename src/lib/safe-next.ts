/**
 * Only our own pages after sign-in: '//evil.example' and 'https:' leave the site, and URL
 * parsers drop tabs and newlines, so a slash, tab, slash would too.
 */
export const safeNext = (next: string): string => (/^\/(?![/\\])[^\\\s]*$/.test(next) ? next : '/home');
