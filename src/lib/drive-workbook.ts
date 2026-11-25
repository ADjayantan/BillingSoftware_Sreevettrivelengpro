import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DRIVE_API, DRIVE_UPLOAD_API, ensureVaultFolderPath, getDriveAccessToken, getVaultPeriodFolders, type DriveCredentials } from '@/lib/drive-backup';

/* One month's workbook in Company_Billing_Vault: one file, one id, written over and over. */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FIELDS = 'id,name,trashed,webViewLink,appProperties';
/** Every call is cut off long before the lease on the month ends (month-books.ts). */
const CALL_MS = 15_000;
export const UPLOAD_MS = 45_000;

export class DriveProblem extends Error {
  override name = 'DriveProblem';
  constructor(
    message: string,
    /** It may have been done all the same. */
    readonly unknownOutcome = false,
    /** Drive has no file under this id, and never will. */
    readonly idIsGone = false,
  ) {
    super(message);
  }
}

const file = z.object({
  id: z.string().min(1),
  name: z.string(),
  trashed: z.boolean().default(false),
  webViewLink: z.string().optional(),
  appProperties: z.record(z.string(), z.string()).default({}),
});
export interface Workbook {
  id: string;
  /** As Drive keeps it. Null: not made yet. */
  revision: string | null;
}

const bookName = (month: string): string => `Billing_${month.slice(0, 7)}.xlsx`;
const limited = (fetchImpl: typeof fetch, ms: number): typeof fetch => (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) });

export interface Vault {
  file: (id: string) => Promise<Workbook | null>;
  /** The month's own workbook if it is there under its name, e.g. after the database was restored. */
  find: (month: string) => Promise<Workbook | null>;
  newId: () => Promise<string>;
  /** Makes it, or writes it over; out of the bin and under its own name. Gives its link. */
  put: (month: string, target: Workbook, bytes: Uint8Array, revision: number, sha256: string) => Promise<string>;
}

export async function openVault(creds: DriveCredentials, fetchImpl: typeof fetch): Promise<Vault> {
  const quick = limited(fetchImpl, CALL_MS);
  const token = await getDriveAccessToken(creds, quick);
  const headers = { authorization: `Bearer ${token}` };
  const get = (url: string): Promise<Response> => quick(url, { method: 'GET', headers });
  const answered = (response: Response): Response => {
    if (!response.ok) throw new DriveProblem(response.status >= 500 || response.status === 429 ? 'Google Drive did not answer' : `Google Drive refused (HTTP ${response.status})`);
    return response;
  };
  const folderOf = async (month: string): Promise<string> => {
    const { fyFolder, monthFolder } = getVaultPeriodFolders(month);
    return (await ensureVaultFolderPath([fyFolder, monthFolder], creds, token, quick)).folderId;
  };
  const workbook = (found: z.output<typeof file>): Workbook => ({ id: found.id, revision: found.appProperties.revision ?? '' });

  return {
    async file(id) {
      const response = await get(`${DRIVE_API}/${id}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: 'true' }).toString()}`);
      return response.status === 404 ? null : workbook(file.parse(await answered(response).json()));
    },

    async find(month) {
      const params = new URLSearchParams({
        q: `name = '${bookName(month)}' and '${await folderOf(month)}' in parents and trashed = false`,
        fields: `files(${FIELDS})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '50',
        ...(creds.sharedDriveId ? { corpora: 'drive', driveId: creds.sharedDriveId } : {}),
      });
      const { files } = z.object({ files: z.array(file) }).parse(await answered(await get(`${DRIVE_API}?${params.toString()}`)).json());
      // Only one this app made: a file somebody put there under the same name is theirs.
      const ours = files.find((found) => found.appProperties.studflowBook === month.slice(0, 7));
      return ours ? workbook(ours) : null;
    },

    async newId() {
      const response = await get(`${DRIVE_API}/generateIds?${new URLSearchParams({ count: '1', space: 'drive', type: 'files' }).toString()}`);
      const { ids } = z.object({ ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)).min(1) }).parse(await answered(response).json());
      return ids[0] ?? '';
    },

    async put(month, target, bytes, revision, sha256) {
      const properties = { name: bookName(month), appProperties: { studflowBook: month.slice(0, 7), revision: String(revision), sha256 } };
      const send = async (create: boolean): Promise<Response> => {
        const meta = create ? { ...properties, id: target.id, mimeType: XLSX_MIME, parents: [await folderOf(month)] } : { ...properties, trashed: false };
        const boundary = `studflow_book_${createHash('sha256').update(sha256).digest('hex').slice(0, 24)}`;
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`, 'utf8'),
          Buffer.from(bytes),
          Buffer.from(`\r\n--${boundary}--`, 'utf8'),
        ]);
        const query = new URLSearchParams({ uploadType: 'multipart', supportsAllDrives: 'true', fields: FIELDS }).toString();
        try {
          return await limited(fetchImpl, UPLOAD_MS)(`${DRIVE_UPLOAD_API}${create ? '' : `/${target.id}`}?${query}`, {
            method: create ? 'POST' : 'PATCH',
            headers: { ...headers, 'content-type': `multipart/related; boundary=${boundary}` },
            body,
          });
        } catch {
          throw new DriveProblem(UNKNOWN, true);
        }
      };
      let response = await send(target.revision === null);
      // Our own file, made by an upload whose answer was lost.
      if (target.revision === null && response.status === 409) response = await send(false);
      if (response.status >= 500) throw new DriveProblem(UNKNOWN, true);
      if (!response.ok) throw new DriveProblem(`Google Drive refused the workbook (HTTP ${response.status})`, false, response.status === 404);
      const made = file.safeParse(await response.json().catch(() => null));
      return (made.success ? made.data.webViewLink : undefined) ?? `https://drive.google.com/file/d/${target.id}/view`;
    },
  };
}

const UNKNOWN = 'Google Drive did not say whether the workbook arrived';
