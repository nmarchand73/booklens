import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
const b64 = readFileSync(join(dir, '..', 'void-cluster-ranks-32.b64.txt'), 'utf8').trim();
if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new Error('invalid b64');
const out = `/**
 * Trame void-and-cluster 32×32 (rangs 0..1023) — R. Ulichney,
 * « The void-and-cluster method for dither array generation », SPIE 1993
 * (design/1993-void-cluster.pdf). Génération : scripts/dump-void-cluster-b64.mjs
 * (logique GetVoidAndClusterBlueNoise, C. Peters / BlueNoise.py, CC0).
 */
const VOID_CLUSTER_DIM = 32;
const VOID_CLUSTER_AREA = VOID_CLUSTER_DIM * VOID_CLUSTER_DIM;
const VOID_CLUSTER_RANK_B64 =
  '${b64}';

let __voidClusterRanks = null;
function getVoidClusterRanks() {
  if (!__voidClusterRanks) {
    const bin = atob(VOID_CLUSTER_RANK_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    __voidClusterRanks = new Uint16Array(bytes.buffer);
  }
  return __voidClusterRanks;
}
`;
writeFileSync(join(dir, 'void-cluster-embed-block.js.txt'), out, 'utf8');
console.log('wrote void-cluster-embed-block.js.txt', out.length);
