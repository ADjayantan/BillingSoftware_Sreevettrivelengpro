// Loaded into the try-out app (NODE_OPTIONS=--import): any connection that would leave this PC is refused.
import net from 'node:net';

// The pretend Google Drive of local-check.mjs, instead of the real one.
const GOOGLE = new Set(['oauth2.googleapis.com', 'www.googleapis.com']);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!GOOGLE.has(url.hostname)) return realFetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-google-host', url.hostname);
  return realFetch(`http://127.0.0.1:54322${url.pathname}${url.search}`, { ...init, headers });
};

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1']);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host =
    typeof first === 'object' && first !== null
      ? first.path
        ? 'localhost' // a pipe on this PC
        : (first.host ?? 'localhost')
      : typeof args[1] === 'string'
        ? args[1]
        : 'localhost';
  if (!LOCAL.has(host)) {
    console.error(`BLOCKED: the try-out app wanted to reach ${host}`);
    process.nextTick(() => this.destroy(new Error('blocked: this copy stays on this PC')));
    return this;
  }
  return connect.apply(this, args);
};
