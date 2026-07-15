// Tests for the pure bundling logic (src/bundle.js). Per the
// iron rule nothing is mocked: real strings, real Maps, and a
// real createUrl function that produces deterministic URLs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePath, rewriteHtml, rewriteCss,
  buildGuestHtml, buildBootHtml, mimeFor,
} from '../src/bundle.js';

const te = new TextEncoder();

// a real URL factory recording what it was asked to create
function makeUrlFactory() {
  const created = [];
  const createUrl = (bytes, type) => {
    const url = `test-blob:${created.length}`;
    created.push({ url, bytes, type });
    return url;
  };
  return { created, createUrl };
}

test('normalizePath resolves relative and absolute refs',
  () => {
    assert.equal(normalizePath('', 'a.js'), 'a.js');
    assert.equal(normalizePath('', './a.js'), 'a.js');
    assert.equal(normalizePath('', '/assets/a.js'),
      'assets/a.js');
    assert.equal(normalizePath('assets', 'a.js'),
      'assets/a.js');
    assert.equal(normalizePath('assets', '../a.js'), 'a.js');
    assert.equal(normalizePath('a/b', './../c/x.png'),
      'a/c/x.png');
    assert.equal(normalizePath('', 'a.js?v=1#frag'), 'a.js');
  });

test('mimeFor maps known and unknown extensions', () => {
  assert.equal(mimeFor('assets/app.js'),
    'application/javascript');
  assert.equal(mimeFor('style.CSS'), 'text/css');
  assert.equal(mimeFor('data.bin'),
    'application/octet-stream');
});

test('rewriteHtml rewrites archive refs, leaves others',
  () => {
    const urls = new Map([
      ['assets/app.js', 'test-blob:0'],
      ['style.css', 'test-blob:1'],
    ]);
    const resolveRef = (ref, baseDir) =>
      urls.get(normalizePath(baseDir, ref)) ?? null;
    const html = rewriteHtml(
      '<script src="/assets/app.js"></script>'
      + '<link href=\'./style.css\' rel="stylesheet">'
      + '<a href="https://example.org">x</a>'
      + '<a href="#top">y</a>'
      + '<img src="data:image/png;base64,AA==">'
      + '<img src="missing.png">',
      resolveRef);
    assert.ok(html.includes('src="test-blob:0"'));
    assert.ok(html.includes('href="test-blob:1"'));
    assert.ok(html.includes('href="https://example.org"'));
    assert.ok(html.includes('href="#top"'));
    assert.ok(html.includes('src="data:image/png;base64,AA=="'));
    assert.ok(html.includes('src="missing.png"'));
  });

test('rewriteCss resolves url() relative to stylesheet dir',
  () => {
    const urls = new Map([
      ['assets/font.woff2', 'test-blob:0'],
      ['img/bg.png', 'test-blob:1'],
    ]);
    const resolveRef = (ref, baseDir) =>
      urls.get(normalizePath(baseDir, ref)) ?? null;
    const css = rewriteCss(
      '@font-face{src:url("./font.woff2")}'
      + 'body{background:url(../img/bg.png)}'
      + 'a{cursor:url(data:image/png;base64,AA==)}',
      'assets', resolveRef);
    assert.equal(css,
      '@font-face{src:url("test-blob:0")}'
      + 'body{background:url("test-blob:1")}'
      + 'a{cursor:url(data:image/png;base64,AA==)}');
  });

function sampleFiles() {
  return new Map([
    ['index.html', te.encode(
      '<html><head>'
      + '<script src="webxdc.js"></script>'
      + '<link rel="stylesheet" href="/assets/style.css">'
      + '</head><body>'
      + '<script src="./assets/app.js"></script>'
      + '</body></html>')],
    ['webxdc.js', te.encode('/* packaged stub */')],
    ['assets/app.js', te.encode('console.log("app")')],
    ['assets/style.css',
      te.encode('body{background:url(bg.png)}')],
    ['assets/bg.png', new Uint8Array([1, 2, 3])],
  ]);
}

test('buildGuestHtml produces self-contained document', () => {
  const { created, createUrl } = makeUrlFactory();
  const info = {
    selfAddr: 'addr@example', selfName: 'me',
    hasRealtime: true,
  };
  const { html, urls } = buildGuestHtml({
    files: sampleFiles(), shimSource: 'SHIM_MARKER;',
    info, createUrl,
  });

  // all non-index files got URLs, incl. the replaced webxdc.js
  assert.equal(urls.length, 4);
  assert.equal(created.length, 4);

  // html references only created URLs, no archive paths left
  const byType = t => created.filter(c => c.type === t);
  const jsUrls = byType('application/javascript')
    .map(c => c.url);
  for (const u of jsUrls) assert.ok(html.includes(`"${u}"`));
  assert.ok(!html.includes('webxdc.js"'));
  assert.ok(!html.includes('assets/app.js'));
  assert.ok(!html.includes('assets/style.css'));

  // css got rewritten before being turned into a URL
  const css = new TextDecoder().decode(
    byType('text/css')[0].bytes);
  const pngUrl = byType('image/png')[0].url;
  assert.equal(css, `body{background:url("${pngUrl}")}`);

  // the webxdc.js replacement carries prelude + shim, with
  // the prelude (info, files map, fetch patch) first
  const shimBundle = new TextDecoder().decode(
    created.at(-1).bytes);
  assert.ok(shimBundle.includes('SHIM_MARKER;'));
  assert.ok(shimBundle.includes(
    '"selfAddr":"addr@example"'));
  assert.ok(shimBundle.includes('"selfName":"me"'));
  assert.ok(shimBundle.includes('"hasRealtime":true'));
  assert.ok(shimBundle.includes('window.__vaultFiles'));
  assert.ok(shimBundle.includes('window.fetch'));
  assert.ok(shimBundle.includes('XMLHttpRequest'));
  assert.ok(shimBundle.includes('makeStorage'));
  assert.ok(shimBundle.includes('indexedDB'));
  assert.ok(shimBundle.indexOf('window.__vaultInfo')
    < shimBundle.indexOf('SHIM_MARKER;'));
  // packaged webxdc.js stub was discarded
  assert.ok(!shimBundle.includes('packaged stub'));
  // files map lets the fetch patch resolve runtime requests
  assert.ok(shimBundle.includes('"assets/app.js"'));
});

test('buildGuestHtml escapes </script> in user strings',
  () => {
    const { createUrl, created } = makeUrlFactory();
    buildGuestHtml({
      files: sampleFiles(), shimSource: '',
      info: { selfAddr: 'a', selfName: '</script><b>',
        hasRealtime: false },
      createUrl,
    });
    const bundle = new TextDecoder().decode(
      created.at(-1).bytes);
    assert.ok(!bundle.includes('</script>'));
    assert.ok(bundle.includes('\\u003c/script>'));
  });

test('buildGuestHtml requires index.html', () => {
  const { createUrl } = makeUrlFactory();
  assert.throws(() => buildGuestHtml({
    files: new Map([['a.js', new Uint8Array()]]),
    shimSource: '', info: {}, createUrl,
  }), /index\.html/);
});

test('buildBootHtml round-trips the archive files', () => {
  const files = sampleFiles();
  const boot = buildBootHtml({
    files, shimSource: 'SHIM_MARKER;',
    info: { selfAddr: 'a@x', selfName: 'me',
      hasRealtime: false },
    bundleSource: 'BUNDLE_MARKER;',
  });
  const m = /const DATA = (\{.*?\});\n/s.exec(boot);
  assert.ok(m, 'boot embeds a DATA object');
  const data = JSON.parse(m[1]);
  assert.deepEqual(
    Object.keys(data).sort(), [...files.keys()].sort());
  for (const [path, bytes] of files) {
    const decoded = Uint8Array.from(
      atob(data[path]), c => c.charCodeAt(0));
    assert.deepEqual(decoded, bytes, path);
  }
});

test('buildBootHtml embeds sources, info and boot logic',
  () => {
    const boot = buildBootHtml({
      files: sampleFiles(), shimSource: 'SHIM_MARKER;',
      info: { selfAddr: 'a@x', selfName: 'me',
        hasRealtime: true },
      bundleSource: 'BUNDLE_MARKER;',
    });
    assert.ok(boot.includes('"SHIM_MARKER;"'));
    assert.ok(boot.includes('"BUNDLE_MARKER;"'));
    assert.ok(boot.includes('"selfAddr":"a@x"'));
    assert.ok(boot.includes('"hasRealtime":true'));
    // the boot script bundles inside the sandbox itself
    assert.ok(boot.includes('mod.buildGuestHtml'));
    assert.ok(boot.includes('URL.createObjectURL'));
    assert.ok(boot.includes('document.write'));
    assert.ok(boot.includes('type="module"'));
  });

test('buildBootHtml keeps hostile strings inside the script',
  () => {
    const boot = buildBootHtml({
      files: sampleFiles(),
      shimSource: '</script><script>alert(1)</script>',
      info: { selfName: '</script>' },
      bundleSource: 'x = "</script>";',
    });
    // the only literal closing tag is the boot's own
    assert.equal(boot.split('</script>').length - 1, 1);
    assert.ok(boot.endsWith('</script></body></html>'));
    assert.ok(boot.includes('\\u003c/script>'));
  });

test('buildBootHtml requires index.html', () => {
  assert.throws(() => buildBootHtml({
    files: new Map([['a.js', new Uint8Array()]]),
    shimSource: '', info: {}, bundleSource: '',
  }), /index\.html/);
});

test('rewriteHtml drops app-supplied CSP meta tags', () => {
  const html = '<head><meta http-equiv="Content-Security-Policy"'
    + ' content="style-src \'self\'"><meta charset="utf-8">'
    + '</head><img src="a.png">';
  const out = rewriteHtml(html, () => 'test-blob:0');
  assert.ok(!out.toLowerCase().includes('content-security-policy'));
  assert.ok(out.includes('<meta charset="utf-8">'));
  assert.ok(out.includes('src="test-blob:0"'));
});
