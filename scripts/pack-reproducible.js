import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';

const DIST_DIR = './dist';
const OUT_FILE = './vault.xdc';
const BUILD_DATE = new Date('2026-07-15T00:00:00Z');

function getFiles(dir) {
  const results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results.push(...getFiles(filePath));
    } else {
      results.push(filePath);
    }
  }
  return results;
}

async function main() {
  const zip = new JSZip();
  const files = getFiles(DIST_DIR);

  // Sort files alphabetically to ensure deterministic entry order
  files.sort();

  const createdFolders = new Set();

  for (const file of files) {
    const relativePath = path.relative(DIST_DIR, file).replace(/\\/g, '/');
    
    // Manually create parent folders as directory entries with BUILD_DATE
    const parts = relativePath.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join('/') + '/';
      if (!createdFolders.has(folderPath)) {
        zip.file(folderPath, null, {
          dir: true,
          date: BUILD_DATE
        });
        createdFolders.add(folderPath);
      }
    }

    const content = fs.readFileSync(file);
    zip.file(relativePath, content, {
      date: BUILD_DATE
    });
  }

  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 9
    }
  });

  fs.writeFileSync(OUT_FILE, content);
  console.log(`Packed reproducible ${OUT_FILE} (${content.length} B)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
