/**
 * Régénère le base64 des rangs void-cluster 32×32 (Ulichney 1993) pour app.js.
 * Run: node scripts/dump-void-cluster-b64.mjs
 */
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateVoidClusterBlueNoise2D, validateRankTable } from './verify-void-cluster.mjs';

const t = generateVoidClusterBlueNoise2D(32, 32, 1.5, 0.1, 0xc0ffee42);
if (!validateRankTable(t)) {
  console.error('invalid rank table');
  process.exit(1);
}
const b64 = Buffer.from(t.buffer, t.byteOffset, t.byteLength).toString('base64');
const dir = dirname(fileURLToPath(import.meta.url));
const outPath = join(dir, '..', 'void-cluster-ranks-32.b64.txt');
writeFileSync(outPath, b64, 'utf8');
console.log('wrote', outPath, 'chars', b64.length);
