import { must, route } from '@/lib/api/http';
import { driveState } from '@/lib/drive-backup';
import { driveLinkKey, revokeToken, unseal } from '@/lib/drive-link';

/**
 * The owner's "Disconnect" (specs/drive-button.md): the button's link is forgotten and its
 * permission ended at Google. The database refuses anyone else. Answers what is left: the
 * server settings, or nothing.
 */
export const POST = route(async ({ supabase }) => {
  const replaced: unknown = must(await supabase.rpc('drive_link_clear'));
  const key = driveLinkKey();
  const token = typeof replaced === 'string' && key ? unseal(replaced, key, 'token') : null;
  if (token) await revokeToken(token);
  return { state: await driveState(supabase) };
});
