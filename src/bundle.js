// Pure guest-app bundling: turns an unzipped webxdc archive
// into a self-contained HTML document with all assets as
// blob: URLs, no service worker required. The packaged
// webxdc.js is replaced by the vault bridge shim (prefixed
// with an info/files prelude and a fetch/XHR patch for
// runtime requests). URL creation is injected via the
// `createUrl` parameter so all of this is testable with
// plain functions -- no mocks.

const te = new TextEncoder();
const td = new TextDecoder();

export const MIME = new Map(Object.entries({
  html: 'text/html',
  htm: 'text/html',
  js: 'application/javascript',
  mjs: 'application/javascript',
  css: 'text/css',
  txt: 'text/plain',
  json: 'application/json',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mpeg: 'video/mpeg',
  webm: 'video/webm',
  ogv: 'video/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
}));

export function mimeFor(path) {
  const m = /\.([\w-]+)$/.exec(path);
  return (m && MIME.get(m[1].toLowerCase()))
    ?? 'application/octet-stream';
}

// refs with a scheme (https:, data:, blob:, mailto:, ...) or
// pure fragments are left alone
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

// resolve a reference against a base directory inside the
// archive; absolute refs (/assets/x) resolve from the root
export function normalizePath(baseDir, ref) {
  const clean = ref.split(/[?#]/)[0];
  const path = clean.startsWith('/')
    ? clean.slice(1)
    : (baseDir ? baseDir + '/' : '') + clean;
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// rewrite src=/href= attributes; resolveRef returns a URL or
// null to leave the reference untouched
export function rewriteHtml(html, resolveRef) {
  return html.replace(
    /(src|href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (m, attr, _q, dq, sq) => {
      const ref = dq ?? sq;
      if (ref === '' || EXTERNAL.test(ref)) return m;
      const url = resolveRef(ref, '');
      return url ? `${attr}="${url}"` : m;
    });
}

// rewrite url(...) references in a stylesheet, relative to
// the stylesheet's own directory
export function rewriteCss(css, baseDir, resolveRef) {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (m, _q, ref) => {
      if (EXTERNAL.test(ref)) return m;
      const url = resolveRef(ref, baseDir);
      return url ? `url("${url}")` : m;
    });
}

// forward uncaught guest errors to the vault so they become
// visible outside the iframe (whose devtools console can be
// hard to reach, especially on mobile)
const ERROR_HOOKS = `
window.addEventListener('error', (ev) => {
  window.parent.postMessage({ type: 'vault-guest-error',
    error: String(ev.error || ev.message)
      + (ev.filename
        ? ' @' + ev.filename + ':' + ev.lineno : ''),
  }, '*');
});
window.addEventListener('unhandledrejection', (ev) => {
  window.parent.postMessage({ type: 'vault-guest-error',
    error: 'unhandled rejection: ' + String(ev.reason),
  }, '*');
});
`;

// keep room plaintext off the disk: guests share the vault's
// origin, so real web storage would persist unencrypted.
// Replace localStorage/sessionStorage with ephemeral
// in-memory stand-ins and hide indexedDB so apps take their
// feature-detection fallback. This is hygiene for honest
// apps, not a security boundary (same-origin guests could
// undo it); durable room state belongs in webxdc updates.
const STORAGE_PATCH = `
const makeStorage = () => {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) =>
      m.has(String(k)) ? m.get(String(k)) : null,
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => { m.clear(); },
  };
};
for (const name of ['localStorage', 'sessionStorage']) {
  Object.defineProperty(window, name,
    { value: makeStorage() });
}
Object.defineProperty(window, 'indexedDB',
  { value: undefined });
`;

// runtime patch so guest fetch()/XHR calls and relative
// URL construction for archive paths resolve to blob URLs
const FETCH_PATCH = `
(() => {
  if (window.__vaultPatched) return;
  window.__vaultPatched = true;
  ${ERROR_HOOKS}
  ${STORAGE_PATCH}
  // srcdoc documents forbid history URL rewriting; make
  // hash/URL-based routing fail soft instead of throwing
  // (state-only navigation still works with a null URL)
  for (const fn of ['pushState', 'replaceState']) {
    const orig = History.prototype[fn];
    History.prototype[fn] = function (state, title, url) {
      try {
        return orig.call(this, state, title, url);
      } catch {
        return orig.call(this, state, title, null);
      }
    };
  }
  const files = window.__vaultFiles;
  const byUrl = {};
  for (const [p, u] of Object.entries(files)) byUrl[u] = p;
  const norm = (dir, ref) => {
    const clean = String(ref).split(/[?#]/)[0];
    const path = clean.startsWith('/') ? clean.slice(1)
      : (dir ? dir + '/' : '') + clean;
    const parts = [];
    for (const seg of path.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  };
  const resolve = (url, dir = '') => {
    try { url = String(url); } catch { return null; }
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url)) return null;
    return files[norm(dir, url)] ?? null;
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = (input && typeof input.url === 'string')
      ? input.url : String(input);
    const mapped = resolve(u);
    return origFetch(mapped ?? input, init);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open =
    function (method, url, ...rest) {
      return origOpen.call(
        this, method, resolve(url) ?? url, ...rest);
    };
  // support new URL('./asset', import.meta.url): blob URLs
  // are not hierarchical, so resolve relative refs against
  // the archive path the base blob URL was created from
  const OrigURL = window.URL;
  window.URL = new Proxy(OrigURL, {
    construct(target, args) {
      try {
        return new target(...args);
      } catch (err) {
        const [ref, base] = args;
        const baseStr = String(base);
        const basePath = baseStr.startsWith('about:srcdoc')
          ? '' : byUrl[baseStr.split(/[?#]/)[0]];
        if (basePath !== undefined) {
          const dir =
            basePath.split('/').slice(0, -1).join('/');
          const mapped = resolve(ref, dir);
          if (mapped) return new target(mapped);
        }
        throw err;
      }
    },
  });
})();
`;

function jsEscape(obj) {
  // \u003c-escape so user-controlled strings (selfName!)
  // cannot break out of the inline <script>
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// build a self-contained HTML document for the guest app.
//   files      : Map filename -> Uint8Array (from unzipToMap)
//   shimSource : source of the webxdc bridge shim
//   info       : { selfAddr, selfName, hasRealtime }
//   createUrl  : (bytes, mimeType) => url string
// returns { html, urls } -- urls for later revocation
export function buildGuestHtml(
  { files, shimSource, info, createUrl }) {
  if (!files.has('index.html')) {
    throw new Error('app archive has no index.html');
  }
  const urls = new Map();
  const isCss = p => /\.css$/i.test(p);

  // pass 1: plain assets
  for (const [path, bytes] of files) {
    if (path === 'index.html' || path === 'webxdc.js'
        || isCss(path)) continue;
    urls.set(path, createUrl(bytes, mimeFor(path)));
  }

  const resolveRef = (ref, baseDir) =>
    urls.get(normalizePath(baseDir, ref)) ?? null;

  // pass 2: stylesheets (may reference pass-1 assets)
  for (const [path, bytes] of files) {
    if (!isCss(path)) continue;
    const baseDir = path.split('/').slice(0, -1).join('/');
    const css =
      rewriteCss(td.decode(bytes), baseDir, resolveRef);
    urls.set(path, createUrl(te.encode(css), 'text/css'));
  }

  // pass 3: the bridge shim replaces the packaged webxdc.js;
  // the prelude must precede the shim and the app's code
  const prelude = 'window.__vaultInfo = '
    + jsEscape(info) + ';\n'
    + 'window.__vaultFiles = '
    + jsEscape(Object.fromEntries(urls)) + ';\n'
    + FETCH_PATCH;
  urls.set('webxdc.js', createUrl(
    te.encode(prelude + '\n' + shimSource),
    'application/javascript'));

  const html = rewriteHtml(
    td.decode(files.get('index.html')), resolveRef);
  return { html, urls: [...urls.values()] };
}
