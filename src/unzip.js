// ZIP reader ported from the Spaces project (lib/unzip.js),
// converted to ESM. Reads entries into memory using the
// browser's DecompressionStream for deflate.

const TD = new TextDecoder();

export const SIGNATURE = {
  LOCAL_FILE_HEADER: 0x04034b50,
  DATA_DESCRIPTOR: 0x08074b50,
  CENTRAL_DIRECTORY_FILE_HEADER: 0x02014b50,
  END_OF_CENTRAL_DIRECTORY_RECORD: 0x06054b50,
};

export default class Unzip {
  constructor({ buffer }) {
    this.offset = 0;
    this.buffer = buffer;
    this._dataDescriptor = false;
  }
  next() {
    if (this.offset === this.buffer.length) return null;
    if (this._dataDescriptor) {
      throw new Error(
        'archive with data descriptor not yet supported');
    }
    let sig = this.peekSignature();
    if (sig === SIGNATURE.LOCAL_FILE_HEADER) {
      let header = this.readLocalFileHeader();
      if (header.bitflag & 0x08) {
        this._dataDescriptor = true;
      } else {
        this.offset += header.compressedSize;
      }
      return header;
    } else if (sig === SIGNATURE.CENTRAL_DIRECTORY_FILE_HEADER) {
      return this.readCentralDirectoryFileHeader();
    } else if (sig === SIGNATURE.END_OF_CENTRAL_DIRECTORY_RECORD) {
      return this.readEndOfCentralDirectoryRecord();
    } else {
      throw new Error('unexpected signature: 0x'
        + sig.toString(16).padStart(8, '0'));
    }
  }
  async readFile({ start, end, method }) {
    if (method === 0) {
      return this.buffer.slice(start, end);
    } else if (method === 0x08) {
      let deflate = new DecompressionStream('deflate-raw');
      let blob = new Blob([this.buffer.slice(start, end)]);
      blob.stream().pipeTo(deflate.writable);
      let reader = deflate.readable.getReader();
      let chunks = [], size = 0;
      for (;;) {
        let { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
      }
      if (chunks.length === 1) return chunks[0];
      let out = new Uint8Array(size);
      let offset = 0;
      for (let chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    }
    throw new Error(`unsupported compression method ${method}`);
  }
  peekSignature() {
    if (this.offset + 4 > this.buffer.length) {
      throw new Error(
        'unexpected end of file while decoding signature');
    }
    return this.u32(0);
  }
  readLocalFileHeader() {
    let n = this.u16(26);
    let m = this.u16(28);
    let compressedSize = this.u32(18);
    let header = {
      signature: SIGNATURE.LOCAL_FILE_HEADER,
      version: this.u16(4),
      bitflag: this.u16(6),
      method: this.u16(8),
      lastTime: this.u16(10),
      lastDate: this.u16(12),
      crc32: this.u32(14),
      compressedSize,
      uncompressedSize: this.u32(22),
      filename: TD.decode(this.buffer.slice(
        this.offset + 30, this.offset + 30 + n)),
      extra: this.buffer.slice(
        this.offset + 30 + n, this.offset + 30 + n + m),
      start: this.offset + 30 + n + m,
      end: this.offset + 30 + n + m + compressedSize,
    };
    this.offset += 30 + n + m;
    return header;
  }
  readCentralDirectoryFileHeader() {
    let compressedSize = this.u32(20);
    let n = this.u16(28);
    let m = this.u16(30);
    let k = this.u16(32);
    let header = {
      signature: SIGNATURE.CENTRAL_DIRECTORY_FILE_HEADER,
      madeByVersion: this.u16(4),
      extractVersion: this.u16(6),
      bitflag: this.u16(8),
      method: this.u16(10),
      lastTime: this.u16(12),
      lastDate: this.u16(14),
      crc32: this.u32(16),
      compressedSize,
      uncompressedSize: this.u32(24),
      disk: this.u16(34),
      internal: this.u16(36),
      external: this.u32(38),
      offset: this.u32(42),
      filename: TD.decode(this.buffer.slice(
        this.offset + 46, this.offset + 46 + n)),
      extra: this.buffer.slice(
        this.offset + 46 + n, this.offset + 46 + n + m),
      comment: this.buffer.slice(
        this.offset + 46 + n + m,
        this.offset + 46 + n + m + k),
    };
    this.offset += 46 + n + m + k;
    return header;
  }
  readEndOfCentralDirectoryRecord() {
    let n = this.u16(20);
    let header = {
      signature: SIGNATURE.END_OF_CENTRAL_DIRECTORY_RECORD,
      disk: this.u16(4),
      cdDisk: this.u16(6),
      cdDiskCount: this.u16(8),
      cdTotalCount: this.u16(10),
      cdSize: this.u32(12),
      cdOffset: this.u32(16),
      comment: this.buffer.slice(
        this.offset + 22, this.offset + 22 + n),
    };
    this.offset += 22 + n;
    return header;
  }
  u16(offset = 0) {
    let b = this.buffer, i = this.offset + offset;
    return b[i] | (b[i + 1] << 8);
  }
  u32(offset = 0) {
    let b = this.buffer, i = this.offset + offset;
    return b[i] + b[i + 1] * 0x100 + b[i + 2] * 0x10000
      + (b[i + 3] * 0x1000000);
  }
}

// read all regular file entries of a ZIP buffer into a
// Map of filename -> Uint8Array
export async function unzipToMap(buffer) {
  const unzip = new Unzip({ buffer });
  const files = new Map();
  let entry;
  while ((entry = unzip.next()) !== null) {
    if (entry.signature === SIGNATURE.LOCAL_FILE_HEADER
        && !entry.filename.endsWith('/')) {
      files.set(entry.filename, await unzip.readFile(entry));
    }
  }
  return files;
}
