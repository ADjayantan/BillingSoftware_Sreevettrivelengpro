// Google Drive as far as this app uses it: OAuth, folders, files with ids made beforehand, the
// bin, app properties, multipart create and update. Anything else throws.

export interface DriveNode {
  id: string;
  name: string;
  mimeType: string;
  parentId: string;
  trashed: boolean;
  appProperties: Record<string, string>;
  bytes: Buffer;
}

export interface DriveCall {
  /** token · ids · list · get · folder · meta · create · update */
  kind: string;
  url: URL;
  id: string | null;
  signal: AbortSignal | null;
}

/** What happens to a call: it works, it never arrives, it is refused, or its answer is lost after it was done. */
export type Fate = 'ok' | 'down' | 'lose-reply' | number;

const FOLDER = 'application/vnd.google-apps.folder';

export class FakeDrive {
  readonly nodes = new Map<string, DriveNode>();
  readonly calls: DriveCall[] = [];
  /** Asked before every call; may wait, to hold a worker up. */
  fate: (call: DriveCall) => Fate | Promise<Fate> = () => 'ok';
  readonly rootId: string;
  private seq = 0;

  constructor(rootId: string) {
    this.rootId = rootId;
  }

  reset(): void {
    this.nodes.clear();
    this.calls.length = 0;
    this.fate = () => 'ok';
  }

  kinds(): string[] {
    return this.calls.map((call) => call.kind);
  }

  add(node: Partial<DriveNode> & { name: string; parentId: string }): DriveNode {
    const made: DriveNode = { id: `node_${String(++this.seq).padStart(8, '0')}`, mimeType: 'application/octet-stream', trashed: false, appProperties: {}, bytes: Buffer.alloc(0), ...node };
    this.nodes.set(made.id, made);
    return made;
  }

  pathOf(node: DriveNode): string {
    const parent = this.nodes.get(node.parentId);
    return `${parent ? this.pathOf(parent) : node.parentId === this.rootId ? 'Company_Billing_Vault' : '?'}/${node.name}`;
  }

  files(): DriveNode[] {
    return [...this.nodes.values()].filter((node) => node.mimeType !== FOLDER);
  }

  private view(node: DriveNode): Record<string, unknown> {
    return { id: node.id, name: node.name, parents: [node.parentId], trashed: node.trashed, appProperties: node.appProperties, webViewLink: `https://drive.google.com/file/d/${node.id}/view` };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const upload = url.href.startsWith('https://www.googleapis.com/upload/drive/v3/files');
    const api = url.href.startsWith('https://www.googleapis.com/drive/v3/files');
    const id = /\/files\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1] ?? null;
    const kind =
      url.hostname === 'oauth2.googleapis.com' ? 'token'
      : id === 'generateIds' ? 'ids'
      : upload && method === 'POST' ? 'create'
      : upload && method === 'PATCH' && id ? 'update'
      : api && method === 'GET' ? (id ? 'get' : 'list')
      : api && method === 'POST' ? 'folder'
      : api && method === 'PATCH' && id ? 'meta'
      : null;
    if (kind === null) throw new Error(`unexpected Google call ${method} ${url.href}`);
    const call: DriveCall = { kind, url, id, signal: init?.signal ?? null };
    this.calls.push(call);
    const fate = await this.fate(call);
    if (call.signal?.aborted) throw call.signal.reason;
    if (fate === 'down') throw new TypeError('fetch failed');
    if (typeof fate === 'number') return new Response(JSON.stringify({ error: { code: fate } }), { status: fate });
    const reply = this.answer(kind, url, id, init);
    if (fate === 'lose-reply') throw new TypeError('fetch failed'); // after it was done
    return reply;
  };

  private answer(kind: string, url: URL, id: string | null, init: RequestInit | undefined): Response {
    const missing = (): Response => Response.json({ error: { code: 404, message: 'File not found' } }, { status: 404 });
    if (kind === 'token') return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    if (new Headers(init?.headers).get('authorization') !== 'Bearer fake-token') return Response.json({ error: { code: 401 } }, { status: 401 });
    if (kind === 'ids') return Response.json({ ids: Array.from({ length: Number(url.searchParams.get('count') ?? 10) }, () => `generated_${String(++this.seq).padStart(6, '0')}`) });
    if (kind === 'list') {
      const q = url.searchParams.get('q') ?? '';
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const found = [...this.nodes.values()].filter((node) => node.name === name && node.parentId === parent && !(node.trashed && q.includes('trashed = false')) && (!q.includes(FOLDER) || node.mimeType === FOLDER));
      return Response.json({ files: found.slice(0, Number(url.searchParams.get('pageSize') ?? 100)).map((node) => this.view(node)) });
    }
    if (kind === 'get') {
      const node = this.nodes.get(id ?? '');
      return node ? Response.json(this.view(node)) : missing();
    }
    if (kind === 'folder') {
      const meta = JSON.parse(String(init?.body)) as { name: string; mimeType: string; parents: string[] };
      return Response.json(this.view(this.add({ name: meta.name, mimeType: meta.mimeType, parentId: meta.parents[0]! })));
    }
    if (kind === 'meta') {
      const node = this.nodes.get(id ?? '');
      if (!node) return missing();
      const { name, trashed, appProperties } = JSON.parse(String(init?.body)) as Partial<DriveNode>;
      Object.assign(node, name === undefined ? {} : { name }, trashed === undefined ? {} : { trashed }, { appProperties: { ...node.appProperties, ...appProperties } });
      return Response.json(this.view(node));
    }
    const { meta, bytes } = multipart(init);
    if (kind === 'create') {
      if (meta.id !== undefined && this.nodes.has(meta.id)) return Response.json({ error: { code: 409, message: 'A file already exists with the provided ID.' } }, { status: 409 });
      return Response.json(this.view(this.add({ ...(meta.id === undefined ? {} : { id: meta.id }), name: meta.name!, parentId: meta.parents?.[0] ?? this.rootId, appProperties: meta.appProperties ?? {}, bytes })));
    }
    const node = this.nodes.get(id ?? '');
    if (!node) return missing();
    Object.assign(node, meta.name === undefined ? {} : { name: meta.name }, meta.trashed === undefined ? {} : { trashed: meta.trashed }, { appProperties: { ...node.appProperties, ...meta.appProperties }, bytes });
    return Response.json(this.view(node));
  }
}

interface Meta {
  id?: string;
  name?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

function multipart(init: RequestInit | undefined): { meta: Meta; bytes: Buffer } {
  const boundary = /boundary=([^\s;]+)/.exec(new Headers(init?.headers).get('content-type') ?? '')?.[1];
  if (!boundary) throw new Error('not multipart');
  const body = Buffer.from(init?.body as Uint8Array);
  const separator = Buffer.from(`--${boundary}`);
  const first = body.indexOf(separator);
  const second = body.indexOf(separator, first + separator.length);
  const last = body.lastIndexOf(separator);
  const part = (from: number, to: number): Buffer => {
    const piece = body.subarray(from + separator.length + 2, to - 2);
    return piece.subarray(piece.indexOf('\r\n\r\n') + 4);
  };
  return { meta: JSON.parse(part(first, second).toString('utf8')) as Meta, bytes: Buffer.from(part(second, last)) };
}
