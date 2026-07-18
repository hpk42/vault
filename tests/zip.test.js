import test from 'node:test';
import assert from 'node:assert';
import { zipEntries } from '../src/zip.js';
import { unzipToMap } from '../src/unzip.js';

const te = new TextEncoder();


test('zip/unzip roundtrip with text files', async () => {
  const entries = [
    { name: 'hello.txt', data: te.encode('Hello, world!') },
    { name: 'sub/deep.txt', data: te.encode('nested file') },
  ];
  const archive = await zipEntries(entries);
  const files = await unzipToMap(archive);

  assert.strictEqual(files.size, 2);
  assert.deepStrictEqual(
    new TextDecoder().decode(files.get('hello.txt')),
    'Hello, world!');
  assert.deepStrictEqual(
    new TextDecoder().decode(files.get('sub/deep.txt')),
    'nested file');
});


test('zip/unzip roundtrip with binary data', async () => {
  const binary = crypto.getRandomValues(new Uint8Array(4096));
  const entries = [
    { name: 'random.bin', data: binary },
  ];
  const archive = await zipEntries(entries);
  const files = await unzipToMap(archive);

  assert.strictEqual(files.size, 1);
  assert.deepStrictEqual(files.get('random.bin'), binary);
});


test('zip/unzip roundtrip with empty file', async () => {
  const entries = [
    { name: 'empty.txt', data: new Uint8Array(0) },
  ];
  const archive = await zipEntries(entries);
  const files = await unzipToMap(archive);

  assert.strictEqual(files.size, 1);
  assert.strictEqual(files.get('empty.txt').length, 0);
});


test('zip/unzip roundtrip with many entries', async () => {
  const entries = [];
  for (let i = 0; i < 50; i++) {
    entries.push({
      name: `file-${i}.txt`,
      data: te.encode(`content of file ${i}`),
    });
  }
  const archive = await zipEntries(entries);
  const files = await unzipToMap(archive);

  assert.strictEqual(files.size, 50);
  for (let i = 0; i < 50; i++) {
    assert.deepStrictEqual(
      new TextDecoder().decode(files.get(`file-${i}.txt`)),
      `content of file ${i}`);
  }
});


test('zip uses STORE for incompressible data', async () => {
  // random data does not compress; zip.js should
  // fall back to STORE (method 0)
  const random = crypto.getRandomValues(new Uint8Array(256));
  const entries = [{ name: 'noise.bin', data: random }];
  const archive = await zipEntries(entries);
  const files = await unzipToMap(archive);

  assert.deepStrictEqual(files.get('noise.bin'), random);
  // STORE means compressed size == uncompressed size;
  // verify the archive is not inflated beyond overhead
  const overhead = 30 + 46 + 22 + 'noise.bin'.length * 2;
  assert.ok(archive.length <= random.length + overhead + 16,
    'STORE archive must not inflate the data');
});


test('central directory filenames match local headers',
  async () => {
    const entries = [
      { name: 'index.html', data: te.encode('<html>') },
      { name: 'assets/app.js', data: te.encode('code') },
      { name: 'manifest.toml', data: te.encode('name="X"') },
    ];
    const archive = await zipEntries(entries);

    // parse both local and central headers via Unzip,
    // collecting filenames from each section
    const { default: Unzip, SIGNATURE } = await import(
      '../src/unzip.js');
    const uz = new Unzip({ buffer: archive });
    const localNames = [];
    const centralNames = [];
    let entry;
    while ((entry = uz.next()) !== null) {
      if (entry.signature === SIGNATURE.LOCAL_FILE_HEADER) {
        localNames.push(entry.filename);
      } else if (entry.signature
          === SIGNATURE.CENTRAL_DIRECTORY_FILE_HEADER) {
        centralNames.push(entry.filename);
      }
    }
    assert.deepStrictEqual(centralNames, localNames,
      'central directory filenames must match local headers');
  });


test('zip.js output is readable by JSZip', async () => {
  const JSZip = (await import('jszip')).default;
  const entries = [
    { name: 'index.html', data: te.encode('<h1>hello</h1>') },
    { name: 'sub/style.css', data: te.encode('body{}') },
    { name: 'bin.dat',
      data: crypto.getRandomValues(new Uint8Array(512)) },
  ];
  const archive = await zipEntries(entries);
  const jsz = await JSZip.loadAsync(archive);

  for (const { name, data } of entries) {
    const file = jsz.file(name);
    assert.ok(file, `JSZip must find "${name}"`);
    const buf = await file.async('uint8array');
    assert.deepStrictEqual(buf, data,
      `"${name}" content must match`);
  }
});


test('JSZip output is readable by unzip.js', async () => {
  const JSZip = (await import('jszip')).default;
  const jsz = new JSZip();
  const content = {
    'index.html': '<p>test</p>',
    'data.json': '{"a":1}',
  };
  for (const [name, text] of Object.entries(content)) {
    jsz.file(name, text);
  }
  const buf = await jsz.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  });
  const files = await unzipToMap(buf);

  const td = new TextDecoder();
  for (const [name, text] of Object.entries(content)) {
    assert.ok(files.has(name),
      `unzipToMap must find "${name}"`);
    assert.strictEqual(td.decode(files.get(name)), text);
  }
});
