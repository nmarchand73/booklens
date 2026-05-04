/**
 * Smoke test for void-cluster generator (same logic as app.js).
 * Run: node scripts/verify-void-cluster.mjs
 */
import { fileURLToPath } from 'url';

function gaussianConvMinorityPeriodic(bp, M, N, sigma, out) {
  const R = Math.ceil(3 * sigma) + 2;
  const inv2sig = 1 / (2 * sigma * sigma);
  const len = M * N;
  let ones = 0;
  for (let i = 0; i < len; i++) ones += bp[i];
  const flip = ones * 2 >= len;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      let s = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const w = Math.exp(-(dx * dx + dy * dy) * inv2sig);
          const nx = (((x + dx) % M) + M) % M;
          const ny = (((y + dy) % N) + N) % N;
          const v = bp[ny * M + nx];
          const mv = flip ? (v ? 0 : 1) : v;
          s += w * mv;
        }
      }
      out[y * M + x] = s;
    }
  }
  return flip;
}

function findTightestCluster2D(bp, M, N, sigma, filt) {
  const flip = gaussianConvMinorityPeriodic(bp, M, N, sigma, filt);
  let best = -1;
  let bestV = -Infinity;
  for (let i = 0; i < bp.length; i++) {
    const isMinority = flip ? bp[i] === 0 : bp[i] === 1;
    if (!isMinority) continue;
    const v = filt[i];
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

function findLargestVoid2D(bp, M, N, sigma, filt) {
  const flip = gaussianConvMinorityPeriodic(bp, M, N, sigma, filt);
  let best = -1;
  let bestV = Infinity;
  for (let i = 0; i < bp.length; i++) {
    const isMajority = flip ? bp[i] === 1 : bp[i] === 0;
    if (!isMajority) continue;
    const v = filt[i];
    if (v < bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

function generateVoidClusterBlueNoise2D(width, height, sigma, initialSeedFraction, seed) {
  const M = width;
  const N = height;
  const nRank = M * N;
  const nInitialOne = Math.max(1, Math.min((nRank - 1) >> 1, (nRank * initialSeedFraction) | 0));

  const InitialBinaryPattern = new Uint8Array(nRank);
  const perm = new Uint32Array(nRank);
  for (let i = 0; i < nRank; i++) perm[i] = i;
  let s = seed >>> 0;
  for (let i = nRank - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let k = 0; k < nInitialOne; k++) InitialBinaryPattern[perm[k]] = 1;

  const filt = new Float64Array(nRank);
  for (;;) {
    const iTC = findTightestCluster2D(InitialBinaryPattern, M, N, sigma, filt);
    InitialBinaryPattern[iTC] = 0;
    const iLV = findLargestVoid2D(InitialBinaryPattern, M, N, sigma, filt);
    if (iLV === iTC) {
      InitialBinaryPattern[iTC] = 1;
      break;
    }
    InitialBinaryPattern[iLV] = 1;
  }

  const DitherArray = new Uint16Array(nRank);
  const scratch = new Uint8Array(nRank);

  for (let i = 0; i < nRank; i++) scratch[i] = InitialBinaryPattern[i];
  for (let Rank = nInitialOne - 1; Rank >= 0; Rank--) {
    const idx = findTightestCluster2D(scratch, M, N, sigma, filt);
    scratch[idx] = 0;
    DitherArray[idx] = Rank;
  }

  for (let i = 0; i < nRank; i++) scratch[i] = InitialBinaryPattern[i];
  const half = ((nRank + 1) / 2) | 0;
  for (let Rank = nInitialOne; Rank < half; Rank++) {
    const idx = findLargestVoid2D(scratch, M, N, sigma, filt);
    scratch[idx] = 1;
    DitherArray[idx] = Rank;
  }

  for (let Rank = half; Rank < nRank; Rank++) {
    const idx = findTightestCluster2D(scratch, M, N, sigma, filt);
    scratch[idx] = 1;
    DitherArray[idx] = Rank;
  }

  return DitherArray;
}

export function validateRankTable(arr) {
  const n = arr.length;
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = arr[i];
    if (r < 0 || r >= n || seen[r]) return false;
    seen[r] = 1;
  }
  return true;
}

export { generateVoidClusterBlueNoise2D };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t = generateVoidClusterBlueNoise2D(32, 32, 1.5, 0.1, 0xc0ffee42);
  console.log('len', t.length, 'valid permutation', validateRankTable(t));
  console.log('sample', t[0], t[512], t[1023]);
}
