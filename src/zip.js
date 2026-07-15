// Minimal ZIP writer using the browser's CompressionStream.
// Counterpart to unzip.js; produces valid ZIP archives with
// DEFLATE compression and no external dependencies.

const te = new TextEncoder();

// CRC-32 lookup table (IEEE polynomial)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(data) {
  const cs = new CompressionStream('deflate-raw');
  const blob = new Blob([data]);
  blob.stream().pipeTo(cs.writable);
  const reader = cs.readable.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function put16(view, offset, val) {
  view.setUint16(offset, val, true);
}

function put32(view, offset, val) {
  view.setUint32(offset, val, true);
}

// build a ZIP archive from a list of { name, data } entries
// where data is a Uint8Array; returns a Uint8Array
export async function zipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const { name, data } of entries) {
    const nameBytes = te.encode(name);
    const crc = crc32(data);
    const compressed = await deflateRaw(data);

    // use STORE if deflate didn't shrink the data
    const useStore = compressed.length >= data.length;
    const method = useStore ? 0 : 8;
    const stored = useStore ? data : compressed;

    // local file header (30 + name + data)
    const local = new Uint8Array(
      30 + nameBytes.length + stored.length);
    const lv = new DataView(local.buffer);
    put32(lv, 0, 0x04034B50);   // signature
    put16(lv, 4, 20);           // version needed
    put16(lv, 8, method);       // compression method
    put32(lv, 14, crc);
    put32(lv, 18, stored.length);     // compressed size
    put32(lv, 22, data.length);       // uncompressed size
    put16(lv, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(stored, 30 + nameBytes.length);

    // central directory file header (46 + name)
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    put32(cv, 0, 0x02014B50);   // signature
    put16(cv, 4, 20);           // version made by
    put16(cv, 6, 20);           // version needed
    put16(cv, 10, method);
    put32(cv, 16, crc);
    put32(cv, 20, stored.length);
    put32(cv, 24, data.length);
    put16(cv, 28, nameBytes.length);
    put32(cv, 42, localOffset);
    central.set(nameBytes, 46);

    localParts.push(local);
    centralParts.push(central);
    localOffset += local.length;
  }

  // end of central directory record
  let cdSize = 0;
  for (const c of centralParts) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  put32(ev, 0, 0x06054B50);
  put16(ev, 8, entries.length);
  put16(ev, 10, entries.length);
  put32(ev, 12, cdSize);
  put32(ev, 16, localOffset);

  // concatenate all parts
  const total = localOffset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}
