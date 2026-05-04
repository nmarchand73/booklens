'use strict';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const GBOOKS_URL = 'https://www.googleapis.com/books/v1/volumes';

const IMAGE_MAX_W = { normal: 1280, fast: 900 };
const JPEG_Q      = { normal: 0.85, fast: 0.72 };
const MAX_TOKENS  = { normal: 1680, fast: 1020 };

let apiKey      = localStorage.getItem('bl_key')      || '';
let model       = localStorage.getItem('bl_model')    || 'claude-sonnet-4-6';
let fastMode    = localStorage.getItem('bl_fast') === '1';
let busy        = false;
let uploadedImg = null;
/** Dimensions de la frame réellement envoyée à Claude (canvas). */
let lastCaptureSize = { w: 0, h: 0 };
/** Dimensions natives de la photo source — repère pour object-fit: contain (RA). */
let lastSourceSize = { w: 0, h: 0 };
/** Derniers livres pour recalcul RA au resize. */
let lastBooksForAr = [];
let lastEnrichedForAr = [];
/** Dernière liste enrichie affichée — index → fiche détail. */
let cachedEnrichedBooks = [];
/** Incrémenté à chaque ouverture de fiche — ignore les réponses réseau obsolètes. */
let bookSheetLoadGen = 0;
/** Fiche ouverte depuis une suggestion (hors liste de scan). */
let sheetDetachedBook = null;
/** Pile des fiches pour « retour » (carte → autre carte, fiche → livre similaire, etc.). */
let bookSheetHistoryStack = [];

function cloneBookForSheetHistory(book) {
  if (!book || typeof book !== 'object') return book;
  try {
    if (typeof structuredClone === 'function') return structuredClone(book);
  } catch { /* fallthrough */ }
  try {
    return JSON.parse(JSON.stringify(book));
  } catch {
    return { ...book, info: book.info && typeof book.info === 'object' ? { ...book.info } : book.info };
  }
}

function captureSheetHistoryEntry() {
  const sheet = $('book-sheet');
  if (!sheet || sheet.classList.contains('hidden')) return null;
  if (sheetDetachedBook && typeof sheetDetachedBook === 'object') {
    return { kind: 'detached', book: cloneBookForSheetHistory(sheetDetachedBook) };
  }
  const idx = parseInt(sheet.dataset.sheetBookIdx ?? '', 10);
  if (Number.isFinite(idx) && cachedEnrichedBooks[idx]) return { kind: 'idx', idx };
  return null;
}

function pushSheetHistoryIfOpen() {
  const entry = captureSheetHistoryEntry();
  if (entry) bookSheetHistoryStack.push(entry);
}

function updateBookSheetBackButton() {
  const btn = $('book-sheet-back');
  if (!btn) return;
  const show = bookSheetHistoryStack.length > 0;
  btn.classList.toggle('hidden', !show);
  btn.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function popBookSheetHistory() {
  if (!bookSheetHistoryStack.length) return;
  const entry = bookSheetHistoryStack.pop();
  const sheet = $('book-sheet');
  if (!sheet || sheet.classList.contains('hidden')) return;

  bookSheetLoadGen += 1;
  const gen = bookSheetLoadGen;

  if (entry.kind === 'detached') {
    sheetDetachedBook = entry.book;
    delete sheet.dataset.sheetBookIdx;
  } else {
    sheetDetachedBook = null;
    sheet.dataset.sheetBookIdx = String(entry.idx);
  }

  const book = getSheetBook();
  if (!book) {
    updateBookSheetBackButton();
    return;
  }

  const idx = entry.kind === 'idx' ? entry.idx : null;
  const llmPending = !!(apiKey && !book._sheetLlmFetched);
  renderSheetShell(book, gen, { llmPending });
  const scrollEl = $('book-sheet-scroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  if (llmPending) runSheetLlmEnrich(book, idx, gen);
  patchSheetWishlistButton();
  updateBookSheetBackButton();
}

const WISHLIST_STORAGE_KEY = 'bl_wishlist_json';
/** v2 : entrée `book` = instantané complet pour rouvrir la fiche. */
const WISHLIST_SCHEMA_VERSION = 2;
/** Entrées persistantes (jamais d’index de session seul). */
let wishlistItems = [];

const $ = id => document.getElementById(id);
const canvas       = $('canvas');
const scanPixelLayer = $('scan-pixel-layer');
const previewEl    = $('preview');
const previewBack  = $('preview-back');
const viewportPhotoChrome = $('viewport-photo-chrome');
const viewportEmpty = $('viewport-empty');
const scanBtn      = $('scan-btn');
const uploadBtn    = $('upload-btn');
const fileInputCamera = $('file-input-camera');
const fileInputGallery = $('file-input-gallery');
const mainCaptionEl = $('main-caption');
const statusEl     = $('status');
const resultsList  = $('results-list');
const resultsLabel = $('results-label');
const clearBtn     = $('clear-btn');
const wishlistBtn = $('wishlist-btn');
const wishlistBadge = $('wishlist-badge');
const wishlistModal = $('wishlist-modal');
const wishlistBackdrop = $('wishlist-modal-backdrop');
const wishlistBody = $('wishlist-body');
const wishlistClearAll = $('wishlist-clear-all');
const settingsBtn  = $('settings-btn');
const modal        = $('settings-modal');
const backdrop     = $('modal-backdrop');
const apiKeyIn     = $('api-key-input');
const modelSel     = $('model-select');
const fastModeCheck = $('fast-mode-check');
const saveBtn      = $('save-settings-btn');
const toggleKeyBtn = $('toggle-key-btn');
const hintLine     = $('hint-line');
/** Une seule consigne au démarrage (le titre viewport dit quoi photographier). */
const STATUS_IDLE_NO_IMAGE = 'Photo, Importer ou fichier — une image, puis Envoyer.';
const resultsDrawerToggle = $('results-drawer-toggle');
const resultsPanel = $('results');
const splitRoot = $('split-root');
const splitTop = $('split-top');
const splitGutter = $('split-gutter');
const vp           = $('viewport');
const arLayer      = $('ar-layer');
const zoomRoot     = $('viewport-zoom-root');
const zoomPan      = $('viewport-zoom-pan');
const zoomScaler   = $('viewport-zoom-scaler');
const zoomControls = $('viewport-zoom-controls');
const zoomInBtn    = $('zoom-in-btn');
const zoomOutBtn   = $('zoom-out-btn');
const zoomResetBtn = $('zoom-reset-btn');

/** Zoom / pan sur la photo (roulette, boutons, glisser souris, 1 doigt tactile, pincement 2 doigts). */
const PHOTO_ZOOM_MIN = 0.92;
const PHOTO_ZOOM_MAX = 5;
const photoZoom = { s: 1, tx: 0, ty: 0 };
let photoDrag = null;
let photoPinch = null;
let photoTouchPan = null;
/**
 * Zoom léger pendant le scan (même cycle cosinus que la trame). Multiplié à `photoZoom.s`
 * sur `#viewport-zoom-scaler` ; la couche `#scan-pixel-layer` reçoit le même facteur seul.
 */
const SCAN_ZOOM_MAX_DELTA = 0.03;
let scanMicroZoom = 1;

function syncViewportHasPhoto() {
  const on = !!(uploadedImg && !previewEl.classList.contains('hidden'));
  vp.classList.toggle('has-photo', on);
  if (zoomControls) {
    zoomControls.classList.toggle('hidden', !on);
    zoomControls.setAttribute('aria-hidden', String(!on));
  }
}

function applyPhotoZoom() {
  if (!zoomPan || !zoomScaler) return;
  zoomPan.style.transform = `translate3d(${photoZoom.tx}px, ${photoZoom.ty}px, 0)`;
  zoomScaler.style.transform = `scale(${photoZoom.s * scanMicroZoom})`;
  scheduleArReflow();
}

function clampPhotoZoomPan() {
  if (!zoomRoot) return;
  const w = zoomRoot.clientWidth;
  const h = zoomRoot.clientHeight;
  if (w < 2 || h < 2) return;
  if (Math.abs(photoZoom.s - 1) < 0.02) {
    photoZoom.s = 1;
    photoZoom.tx = 0;
    photoZoom.ty = 0;
    return;
  }
  const maxX = (w * Math.abs(photoZoom.s - 1)) / 2;
  const maxY = (h * Math.abs(photoZoom.s - 1)) / 2;
  photoZoom.tx = Math.min(maxX, Math.max(-maxX, photoZoom.tx));
  photoZoom.ty = Math.min(maxY, Math.max(-maxY, photoZoom.ty));
}

function resetPhotoZoom() {
  photoZoom.s = 1;
  photoZoom.tx = 0;
  photoZoom.ty = 0;
  photoDrag = null;
  photoPinch = null;
  photoTouchPan = null;
  applyPhotoZoom();
}

function nudgePhotoZoom(factor) {
  photoZoom.s = Math.min(PHOTO_ZOOM_MAX, Math.max(PHOTO_ZOOM_MIN, photoZoom.s * factor));
  clampPhotoZoomPan();
  applyPhotoZoom();
}

function endPhotoDrag(e) {
  if (photoDrag && e.pointerId === photoDrag.pid) photoDrag = null;
}

/** Recalcule les cadres RA après resize (layout souvent stable après 2 frames). */
function scheduleArReflow() {
  if (!lastBooksForAr.length || arLayer.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    renderArMarkers(lastBooksForAr);
    if (lastEnrichedForAr.length) patchArMarkersWithCovers(lastEnrichedForAr);
    requestAnimationFrame(() => {
      renderArMarkers(lastBooksForAr);
      if (lastEnrichedForAr.length) patchArMarkersWithCovers(lastEnrichedForAr);
    });
  });
}

const SPLIT_STORAGE_KEY = 'bl_split_bottom_frac';

function clampSplitNum(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function readSplitBottomFrac() {
  const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0.12 || v > 0.88) return null;
  return v;
}

function splitMinBottomPx() {
  if (resultsPanel.classList.contains('collapsed')) return 0;
  return resultsPanel.classList.contains('has-results') ? 140 : 96;
}

function splitMinTopPx() {
  return 120;
}

function persistSplitFracFromPixels(bottomPx, avail) {
  if (avail <= 0) return;
  const f = clampSplitNum(bottomPx / avail, 0.12, 0.88);
  localStorage.setItem(SPLIT_STORAGE_KEY, String(f));
}

function applySplitLayout() {
  if (!splitRoot || !splitTop || !resultsPanel || !splitGutter) return;

  const collapsed = resultsPanel.classList.contains('collapsed');
  splitRoot.classList.toggle('split-gutter--disabled', collapsed);

  if (collapsed) {
    splitTop.style.flex = '';
    splitTop.style.height = '';
    resultsPanel.style.flex = '';
    resultsPanel.style.height = '';
    splitRoot.classList.remove('split-custom');
    splitGutter.removeAttribute('aria-valuenow');
    return;
  }

  const frac = readSplitBottomFrac();
  if (frac == null) {
    splitRoot.classList.remove('split-custom');
    splitTop.style.flex = '';
    splitTop.style.height = '';
    resultsPanel.style.flex = '';
    resultsPanel.style.height = '';
    splitGutter.removeAttribute('aria-valuenow');
    return;
  }

  splitRoot.classList.add('split-custom');
  const rootR = splitRoot.getBoundingClientRect();
  const gh = splitGutter.offsetHeight || 40;
  const avail = Math.max(1, rootR.height - gh);
  const minBot = splitMinBottomPx();
  const minTop = splitMinTopPx();
  let bottomPx = avail * frac;
  bottomPx = clampSplitNum(bottomPx, minBot, Math.max(minBot, avail - minTop));
  const topPx = avail - bottomPx;

  splitTop.style.flex = '0 0 auto';
  splitTop.style.height = `${Math.round(topPx)}px`;
  resultsPanel.style.flex = '0 0 auto';
  resultsPanel.style.height = `${Math.round(bottomPx)}px`;

  const pct = Math.round((bottomPx / avail) * 100);
  splitGutter.setAttribute('aria-valuenow', String(clampSplitNum(pct, 8, 92)));
}

function initSplitPaneResize() {
  if (!splitGutter || !splitRoot || !splitTop || !resultsPanel) return;

  let activePointer = null;

  function onMove(ev) {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    ev.preventDefault();
    const rootR = splitRoot.getBoundingClientRect();
    const gh = splitGutter.offsetHeight || 40;
    const avail = Math.max(1, rootR.height - gh);
    const minTop = splitMinTopPx();
    const minBot = splitMinBottomPx();
    const y = ev.clientY;
    let topPx = y - rootR.top - gh / 2;
    topPx = clampSplitNum(topPx, minTop, avail - minBot);
    const bottomPx = avail - topPx;
    splitRoot.classList.add('split-custom');
    splitTop.style.flex = '0 0 auto';
    splitTop.style.height = `${Math.round(topPx)}px`;
    resultsPanel.style.flex = '0 0 auto';
    resultsPanel.style.height = `${Math.round(bottomPx)}px`;
    const pct = Math.round((bottomPx / avail) * 100);
    splitGutter.setAttribute('aria-valuenow', String(clampSplitNum(pct, 8, 92)));
  }

  function endDrag(ev) {
    if (activePointer === null || (ev.pointerId != null && ev.pointerId !== activePointer)) return;
    const pid = activePointer;
    activePointer = null;
    try {
      splitGutter.releasePointerCapture(pid);
    } catch (_) { /* ignore */ }
    splitRoot.classList.remove('split-gutter-active');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    const rootR = splitRoot.getBoundingClientRect();
    const gh = splitGutter.offsetHeight || 40;
    const avail = Math.max(1, rootR.height - gh);
    const bottomPx = resultsPanel.getBoundingClientRect().height;
    persistSplitFracFromPixels(bottomPx, avail);
    applySplitLayout();
    scheduleArReflow();
  }

  splitGutter.addEventListener('pointerdown', ev => {
    if (resultsPanel.classList.contains('collapsed')) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    activePointer = ev.pointerId;
    splitRoot.classList.add('split-gutter-active');
    try {
      splitGutter.setPointerCapture(ev.pointerId);
    } catch (_) { /* ignore */ }
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    ev.preventDefault();
  });

  splitGutter.addEventListener('keydown', ev => {
    if (resultsPanel.classList.contains('collapsed')) return;
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    const step = ev.shiftKey ? 32 : 16;
    const rootR = splitRoot.getBoundingClientRect();
    const gh = splitGutter.offsetHeight || 40;
    const avail = Math.max(1, rootR.height - gh);
    const stored = readSplitBottomFrac();
    const curBottom = stored != null ? avail * stored : resultsPanel.getBoundingClientRect().height;
    /* Bas = plus d’espace pour les résultats (intuitif clavier / lecteurs d’écran). */
    const delta = ev.key === 'ArrowDown' ? step : -step;
    const newBottom = clampSplitNum(curBottom + delta, splitMinBottomPx(), avail - splitMinTopPx());
    persistSplitFracFromPixels(newBottom, avail);
    applySplitLayout();
    scheduleArReflow();
  });

  const splitRo = new ResizeObserver(() => applySplitLayout());
  splitRo.observe(splitRoot);

  requestAnimationFrame(() => {
    applySplitLayout();
    scheduleArReflow();
  });
}

function syncMainControlLabel() {
  const has = !!uploadedImg;
  if (mainCaptionEl) mainCaptionEl.textContent = has ? 'Envoyer' : 'Photo';
  if (!scanBtn) return;
  scanBtn.title = has
    ? 'Envoyer cette image à l’analyse'
    : 'Prendre une photo avec l’appareil (pas la photothèque)';
  scanBtn.setAttribute('aria-label', has ? 'Envoyer l’image à l’analyse' : 'Ouvrir l’appareil photo pour prendre une photo');
  const icoCam = scanBtn.querySelector('.main-ico--camera');
  const icoSend = scanBtn.querySelector('.main-ico--send');
  if (icoCam && icoSend) {
    if (has) {
      icoCam.classList.add('hidden');
      icoSend.classList.remove('hidden');
    } else {
      icoCam.classList.remove('hidden');
      icoSend.classList.add('hidden');
    }
  }
}

(() => {
  syncMainControlLabel();
  if (!apiKey) openSettings();
})();
wishlistReloadFromDisk();
updateWishlistHeaderBadge();

// ── Frame capture ─────────────────────────────────────────────────────────────
function captureBase64() {
  const src = uploadedImg;
  if (!src) return null;
  const sw = src.naturalWidth;
  const sh = src.naturalHeight;
  const maxW = IMAGE_MAX_W[fastMode ? 'fast' : 'normal'];
  const jpegQ = JPEG_Q[fastMode ? 'fast' : 'normal'];
  if (!sw || !sh) return null;
  lastSourceSize = { w: sw, h: sh };
  /* Même ratio que la source (RA alignée sur la photo affichée). */
  const scale = Math.min(1, maxW / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  lastCaptureSize = { w, h };
  return canvas.toDataURL('image/jpeg', jpegQ).split(',')[1];
}

/** Durée d’un cycle d’effet scan (alignée sur `--scan-sweep-duration` en CSS). */
const SCAN_PIXEL_MS = 12000;

/**
 * Trame void-and-cluster 32×32 (rangs 0..1023) — R. Ulichney,
 * « The void-and-cluster method for dither array generation », SPIE 1993
 * (design/1993-void-cluster.pdf). Génération : scripts/dump-void-cluster-b64.mjs
 * (logique GetVoidAndClusterBlueNoise, C. Peters / BlueNoise.py, CC0).
 */
const VOID_CLUSTER_DIM = 32;
const VOID_CLUSTER_AREA = VOID_CLUSTER_DIM * VOID_CLUSTER_DIM;
const VOID_CLUSTER_RANK_B64 =
  '6gF8A3wAGgFvAnQDgAEBAdoBwwJeAIMChgE0A8oAmwEbAJYCewDzAkAB8AO5AQ8CBgCEAjoD1wAwAMgDjQGmAD0AvgI4AtIDtAG/ABACsAOYAA4DsAFaAwkAYgLmAWgDPAG9A+oASwMkANgC/QCvAsIDlADZAc4CXgEgAvACOQP4A4cB0QAYAzoAmALpAiMAVgL3AyoBHgKsAwMB0wJmABsDCAKOAV4C4gGBA28BvQBMAzMBUgKnA4AAmgLhAD0BbAJqAE0DAgJgAZsDNgFJA3oB3wBEAKQCowBuAdMDOQK2AL0COQCmA54AgQJKAAADMAKQATYALAOzAZEDGQAFArYBogMhAa0CpwA8AmMAzwG1AgsClwM/A98B+wI8ALUBGAH5A2UB+QIiAaoB4gPuAXgAtwOVAssAJgFHAl8D3gL2APwCTQDFAe8DCQMKAckDqwD4Al0BaABxAtAAeQOhAjwDSgKCAPcBWwPUAMQCSgFyAw0B6AIDAsQDZAB0AaUAfwJpAUQCWAMRAIsBdwJpAyAAWwL1AMEBqAM4AR0CcgELAN4AkwOiAkMAUAIzAwwAQQKvAJoBJwAXA6UC5AHkAyIDhgCxA+AABgLXAskAFQKgATUD6QPSAi0AIQOOALwD6AHmApQB/gDVA7cBmQB+AbcCJgP2A2MCWAHsAFMDCAAKAq4BwQIwATEDcgBOAbYDVQApAZIA/QFkAUgCwgIMAU8DZQJYACsCBgMyAWsDvgMBAiABZwDcAXgDgwBCAkUBxgCSAysAfALgA9IBTgOgAgQDLgKTAlwD2wDZA0YAxgG0AO0DVgF1Ax0A7wF4AukAMgCJApgD0gDyAqIBsALQA+ECKAKCAZcAPwLwABgAdwG8ALEBlQMFAJIBQQN+Aj8BDANsALIBlwLPANwCcwATA8IBRQNwARoCIQCtAwQBRQBIAxEBbgMQA0kB3QKGA2oC+gN2AAIBywLxAYgAJQKfA6sC9QEnAxABygOTASMCVAHoA5EAzwJpAjoBKgN7AtMBqgCbAlEAqwGyA1oA3QEdARMCMAN0As0DNQH/AusAhQEPAMMAkAM3AlIANgOdA7sAPgIZAUsAxgO5APsBXABhATsCmgPwAdMAMgKxArEADQMsAFwBzgFAAEUCbQNUAOEDWALlAk8BiwB9AiwBFgCpAnYD9gLRATsDfwGDA+wC5QMoARIA2gLUAyUBUgOJAa4DpwJ/A9YARgOwAKcBugLYAQkBYQOlAfsD4wH9ApkB8gFZAGsB3QCUAgQARgKQAKgBiwItA3MBhQBuAh4ACQL8AIwANALWAnsBjgK7Az4BKwN/ABECRwCjArIAigPuANwDXQJXAxYC/AMfAcwC8QBeA9cBxwAZAncDuwH0At0DigLEATcB7ANuABQCHADIAGcCxQPUAvcAPQNsATMCcQDnAh4BogA/AAgDkQHzAcADNwAWAfMDWwDGAvQArABjAV0AjQMKABwD7QBzA/UC9gFfAS8AjwGCA1MCBwAaA8ABgAJ2AbMDcALEAJYDXwBkAvoCNQJUA5ECSwGlAxYDJgJCA8kC7AFfAooBrAIUAa8DNwOQAroA4QEtAdED3ACkAy4ALgMAAqMBsgJDATIDtwBmAX4AnAETAOsBTAI0AKEBCwGTAFEBqQOhANsBTwCtAY0AGwLxA/cChACzAv4BSAHIAoEA5wBgAxQALwK4AYgDvwLHAwEDBgHaA6AAcAOqAvQDSwJRAzUABQPmA2gCagP7AMUCTAFMAFkDlQFXAq0ASgMtAs4DKwHVAusD+AAqAPkBwQBtAkMDiAHiAkYB5ABOAL8BngIjASEC2QBTAe4CDQCgA8kBegLyAMMDOACJA80BZwGSAmIA5QGbACQDhwI0AcsBOwAnAmsAeQLVAR4DFwKFA8IAlgHAAlYDfQAHAoMBVAKfAEADHwJBAQMDnAIIASYAGQOYAXoDUQJ9AbkD6gJvA1IBqwPYAGIDAwDMA2IBegARA9gDFwDIAYgCjAMjAw4B3gMoAN8CtQCfAXkA4wNhAqMDzgDxAhsBUAAYAokAggILA+ABvAInATECuADHAnYCFQFAAq4AtQMuAUIAxQC6AbsCbQHnAaEDPQI+A/wBnQBCAQwCAgCoAo8D4wCdARUAAAGaAP0DlwECA3sDpgEpAJQD0AHrAngBygIsAqoDcgJgAGcD7wCFAg4AMQHbAr4BZQOGAv4DWQEdA0MC2wPNAkQDTwIxAJkCcADzAPoBKANbAWkAYwPmAO0BigDvAiQBDQIVA48A9QOEAYQD6ABBAAcDdQCvAagA1gFXAC8B/wGpAVoBjgMSAnkBvwNcApYA3wMOAmsCIgD/A0cDjAEBAM8DUAHKAeQCbQBVArYC1gNxAQUBOgLgAl0DcwKAA3QAywPVAA8DEgFVAz4A4wI7AaYC/wAUA2gBnwL6AFkCfQPMAIwCNgIHATgDBAKkANQBdQIlA7gDJQD5AHwBwAAqArkCSQBgApwAtALDAdoAmQOkAVMAfgOpAL0BSAAvA94B0AJWAMEDHwCeAbQDRwEzAIcDvgBXAfQBrgLnAwoDOQFQA8wBugP4AUQB7gMpAhoAKQNJAukB2QKeAyQCTQGVABMBIANqAWQDnQLiABID0QIiAmEAZgJmA4cAxwEQAI0C5QB1Ae0CAAAfA3cAjwJsA1UBzQDXAxwBbwC4AuoDTQKLA7wBHAKzAE4CZQBxA4EBFwHyA6wB/gIPAVoCnAM=';

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


let scanPixelRaf = 0;
let scanPixelLoopStart = 0;
/** Tampon downscale → dither → upscale. */
let __scanPixelBuf = null;

function cancelScanPixelAnim() {
  if (scanPixelRaf) {
    cancelAnimationFrame(scanPixelRaf);
    scanPixelRaf = 0;
  }
}

/** Masque la couche dither utilisée pendant l’effet scan. */
function clearScanPixelLayer() {
  cancelScanPixelAnim();
  scanMicroZoom = 1;
  applyPhotoZoom();
  if (!scanPixelLayer) return;
  scanPixelLayer.style.transform = '';
  scanPixelLayer.classList.add('hidden');
  scanPixelLayer.setAttribute('aria-hidden', 'true');
  const c = scanPixelLayer.getContext('2d');
  if (c && scanPixelLayer.width > 0 && scanPixelLayer.height > 0) {
    c.clearRect(0, 0, scanPixelLayer.width, scanPixelLayer.height);
  }
}

/** Luminance perceptuelle rapide 0–255 (sRGB). */
function scanLumaByte(r, g, b) {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

/**
 * Downscale puis trame void-and-cluster 32×32 (ordered dither « blue noise »),
 * puis upscale sur destCanvas. Ulichney 1993 + rendu Surma / ditherpunk.
 */
function drawDitherTransitionOnto(srcCanvas, destCanvas, block, elapsedMs) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const dw = destCanvas.width;
  const dh = destCanvas.height;
  const b = Math.max(1, Math.min(Math.floor(block), Math.max(sw, sh)));
  const cw = Math.max(1, Math.ceil(sw / b));
  const ch = Math.max(1, Math.ceil(sh / b));
  if (!__scanPixelBuf) __scanPixelBuf = document.createElement('canvas');
  __scanPixelBuf.width = cw;
  __scanPixelBuf.height = ch;
  const sctx = __scanPixelBuf.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = false;
  sctx.clearRect(0, 0, cw, ch);
  sctx.drawImage(srcCanvas, 0, 0, sw, sh, 0, 0, cw, ch);

  const id = sctx.getImageData(0, 0, cw, ch);
  const px = id.data;
  const p = (elapsedMs % SCAN_PIXEL_MS) / SCAN_PIXEL_MS;
  const tEase = (1 - Math.cos(Math.PI * p)) / 2;
  /** 0 = photo en niveaux de gris lisses → 1 = trame 1 bit complète */
  const mixDither = Math.pow(tEase, 1.35);
  const ranks = getVoidClusterRanks();
  /** Défilement lent de la période 32×32 (void-cluster). */
  const crawlRow = (elapsedMs >> 10) % VOID_CLUSTER_DIM;
  const crawlCol = ((elapsedMs >> 10) * 17 + (elapsedMs >> 12)) % VOID_CLUSTER_DIM;

  for (let y = 0; y < ch; y++) {
    const row = y * cw * 4;
    const ry = (y + crawlRow) % VOID_CLUSTER_DIM;
    for (let x = 0; x < cw; x++) {
      const i = row + x * 4;
      const r = px[i];
      const g = px[i + 1];
      const bl = px[i + 2];
      const L = scanLumaByte(r, g, bl) / 255;
      const rx = (x + crawlCol) % VOID_CLUSTER_DIM;
      const th = (ranks[ry * VOID_CLUSTER_DIM + rx] + 0.5) / VOID_CLUSTER_AREA;
      const bit = L >= th ? 1 : 0;
      const out = mixDither * bit + (1 - mixDither) * L;
      const v = out <= 0 ? 0 : out >= 1 ? 255 : Math.round(out * 255);
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  sctx.putImageData(id, 0, 0);

  const dctx = destCanvas.getContext('2d');
  dctx.imageSmoothingEnabled = false;
  dctx.clearRect(0, 0, dw, dh);
  dctx.drawImage(__scanPixelBuf, 0, 0, cw, ch, 0, 0, dw, dh);
}

function scanPixelTick(now) {
  if (!scanPixelLayer || scanPixelLayer.classList.contains('hidden')) {
    scanMicroZoom = 1;
    applyPhotoZoom();
    if (scanPixelLayer) scanPixelLayer.style.transform = '';
    scanPixelRaf = 0;
    return;
  }
  if (!canvas?.width || !canvas?.height) {
    scanMicroZoom = 1;
    applyPhotoZoom();
    if (scanPixelLayer) scanPixelLayer.style.transform = '';
    scanPixelRaf = 0;
    return;
  }
  const elapsed = now - scanPixelLoopStart;
  const p = (elapsed % SCAN_PIXEL_MS) / SCAN_PIXEL_MS;
  /* Cosinus : ease global sur le cycle. */
  const t = (1 - Math.cos(Math.PI * p)) / 2;
  scanMicroZoom = 1 + SCAN_ZOOM_MAX_DELTA * t;
  applyPhotoZoom();
  scanPixelLayer.style.transform = `scale(${scanMicroZoom})`;
  /* Puissance > 1 : longtemps quasi net ; maxB bas = jamais de gros blocs (trame fine). */
  const tBlock = Math.pow(t, 2.2);
  const maxB = fastMode ? 4 : 5;
  const block = 1 + tBlock * (maxB - 1);
  drawDitherTransitionOnto(canvas, scanPixelLayer, block, elapsed);
  scanPixelRaf = requestAnimationFrame(scanPixelTick);
}

/** Affiche #scan-pixel-layer et anime la trame dither à partir du canvas de capture. */
function refreshScanPixelLayer() {
  if (!scanPixelLayer || !canvas?.width || !canvas?.height) return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    clearScanPixelLayer();
    return;
  }
  const w0 = canvas.width;
  const h0 = canvas.height;
  if (w0 < 2 || h0 < 2) return;
  scanPixelLayer.width = w0;
  scanPixelLayer.height = h0;
  scanPixelLayer.classList.remove('hidden');
  scanPixelLayer.setAttribute('aria-hidden', 'false');
  cancelScanPixelAnim();
  scanPixelLoopStart = performance.now();
  scanPixelRaf = requestAnimationFrame(scanPixelTick);
}

// ── Claude vision + critique ──────────────────────────────────────────────────
// Claude identifies books AND provides critiques in a single call.
const SYSTEM_PROMPT = `Tu es critique littéraire professionnel (conseil de lecture exigeant, ton presse sérieuse). Analyse cette photo de rayons de librairie.
Pour chaque livre dont tu identifies le titre sur les tranches ou couvertures :
- title: titre exact tel qu'il apparaît dans l'image
- author: auteur tel qu'il apparaît, ou null
- confidence: "high" (clairement lisible), "medium" (partiellement), "low" (incertain)
- genre: genre littéraire principal en français (Policier, Thriller, SF, Romance, Historique, Fantasy, Horreur, Littérature…)
- note: note publique moyenne sur 5 que tu connais (ex: 4.2), ou null si inconnue
- themes: tableau de 3 à 5 thèmes ou motifs en français (ex: ["vengeance","famille","mémoire"]), sans spoiler — [] si inconnu
- pour_qui: une phrase courte — quel lecteur ou niveau d'exigence (ex: "Amateurs de polar nordique lent") — null si inconnu
- pitch: une seule phrase accrocheuse sans spoiler (ton & promesse du livre) — null si inconnu
- recompenses: prix littéraires ou reconnaissance majeure connus pour CE titre (ex: "Prix Goncourt 2019") — null sinon
- critique: mini-critique professionnelle en français (4 à 6 phrases), pour un lecteur qui hésite à acheter. Structure implicite : (1) cadre — ce que propose l'ouvrage et où il se situe dans son genre ou chez l'auteur ; (2) analyse — écriture, rythme, tension narrative ou densité des idées (selon le cas), sans résumer l'intrigue ni révéler les retournements ; (3) bilan équilibré — qualités nettes et réserves honnêtes ; (4) verdict court — à qui le recommander et sous quelles attentes. Ton précis, sans jargon creux ni slogans marketing (« coup de cœur », « irrésistible », etc.). null si tu ne connais pas ce livre.
- bbox: rectangle du livre dans l'IMAGE ENVOYÉE (même cadrage que la photo). Objet {"x","y","w","h"} avec valeurs entre 0 et 1 : (x,y) = coin haut-gauche du livre (tranche ou couverture), w = largeur / largeur image, h = hauteur / hauteur image. Une entrée par livre, aussi précis que possible pour superposer un cadre en réalité augmentée.

Réponds UNIQUEMENT par un tableau JSON valide, sans texte autour :
[{"title":"…","author":"…","confidence":"high","genre":"Policier","note":4.2,"themes":["…"],"pour_qui":"…","pitch":"…","recompenses":null,"critique":"…","bbox":{"x":0.12,"y":0.35,"w":0.05,"h":0.28}}]
Retourner [] si aucun livre n'est identifiable.`;

const SYSTEM_PROMPT_FAST = `Photo rayon. Par livre lisible : title, author|null, confidence, genre court, note 0-5|null, themes max 3 courts mots-clés FR [], pour_qui une courte cible lecteur|null, pitch une phrase accroche|null, recompenses|null, critique : exactement 2 phrases, ton critique pro (cadrage du livre + qualités ou réserves utiles, sans spoiler ni langage pub), bbox {"x","y","w","h"} 0..1. JSON tableau uniquement :
[{"title":"","author":null,"confidence":"high","genre":"","note":null,"themes":[],"pour_qui":null,"pitch":null,"recompenses":null,"critique":"","bbox":{"x":0,"y":0,"w":0.1,"h":0.2}}]
Sinon [].`;

/** Fiche livre au clic : enrichissement texte (sans image). */
const SYSTEM_SHEET_DETAIL = `Tu es critique littéraire professionnel et conseiller de lecture : rigueur d'analyse, jugement nuancé, style clair (presse littéraire sérieuse, pas chronique promo).
Tu réponds exclusivement par UN objet JSON UTF-8 valide. Aucun markdown, aucun texte hors du JSON.
La clé "critique" doit être une vraie critique argumentée : cadrage du livre, mérites littéraires ou narratifs, limites éventuelles, public visé — sans spoiler majeur ni formules publicitaires creuses.
Si tu ne connais pas le livre, utilise null, [] ou chaînes vides là où c'est indiqué et une courte critique explicitant l'incertitude et ce qu'il faudrait vérifier avant achat.
Pour "livres_similaires", cite uniquement des livres réels avec titre et auteur exacts tels qu'en librairie (pas d'invention). Chaque suggestion doit avoir une année de première parution ("annee", 4 chiffres) connue avec certitude : elle sert à répartir les titres par décennie. Fournis aussi "style" (genre ou registre court en français, ex. « polar psychologique », ou null). Le champ "accroche" doit donner une idée concrète de l'intrigue (situation initiale, protagoniste, conflit ou mystère posé), pas un rappel de genre ni une phrase sur le ton ou la qualité du suspense : le genre va dans "style".
Pour "auteur_wikipedia" : n'invente pas d'URL. Soit null (auteur inconnu ou trop d'homonymes), soit un objet avec l'URL desktop exacte d'un article encyclopédique sur la personne physique auteur·rice principale·al de CE titre (pas un film, lieu, œuvre, page d'homonymes, m.mobile). Domaines autorisés : uniquement https://LL.wikipedia.org/wiki/... où LL est le code langue (fr ou en de préférence).`;

const MAX_TOKENS_SHEET_DETAIL = 4096;

/** Accumule le texte assistant depuis le flux SSE Messages API. */
async function readClaudeSse(body, onFirstToken) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trimStart();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          if (first) {
            first = false;
            onFirstToken?.();
          }
          fullText += ev.delta.text;
        }
      } catch {
        /* ligne SSE incomplète ou non JSON */
      }
    }
  }
  return fullText;
}

async function claudeNonStreamRequest(bodyObj) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ ...bodyObj, stream: false }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Clé API invalide — vérifiez les paramètres');
    if (res.status === 429) throw new Error('Quota dépassé — réessayez dans quelques secondes');
    throw new Error(e.error?.message || `Erreur API ${res.status}`);
  }
  const d = await res.json();
  return d.content?.[0]?.text || '';
}

function parseBooksJson(txt) {
  const m = String(txt || '').match(/\[[\s\S]*\]/);
  try {
    return m ? JSON.parse(m[0]) : [];
  } catch {
    return [];
  }
}

function parseSheetDetailJson(txt) {
  let s = String(txt || '').trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fenced) s = fenced[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Décompose une ligne "Titre — Auteur" (réponses IA legacy). */
function parseSiSimilaireLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const seps = [' — ', ' – ', ' - ', '—', '–'];
  for (const sep of seps) {
    const i = s.indexOf(sep);
    if (i > 0) {
      const titre = s.slice(0, i).trim();
      const auteur = s.slice(i + sep.length).trim();
      if (titre && auteur) return { titre, auteur, accroche: '', annee: '', style: '' };
    }
  }
  return null;
}

/** Année ou date courte affichable (parution) pour les cartes « prolonger la lecture ». */
function normalizeYearField(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const y = Math.floor(raw);
    if (y > 1000 && y < 2100) return String(y);
    return '';
  }
  const s = String(raw).trim();
  if (!s) return '';
  const m = s.match(/\b(1[89]\d{2}|20\d{2})\b/);
  if (m) return m[1];
  if (/^\d{4}$/.test(s)) return s;
  return s.length <= 12 ? s : s.slice(0, 10);
}

/** Année numérique exploitable pour le filtre par décennie (null si absent ou hors plage). */
function parsePublicationYear(raw) {
  const s = normalizeYearField(raw);
  if (!s) return null;
  const y = parseInt(s, 10);
  if (!Number.isFinite(y) || y < 1000 || y > 2099) return null;
  return y;
}

/** Les 5 dernières décennies calendaires (ex. en 2026 → 2020, 2010, 2000, 1990, 1980). */
function lastFiveDecadeStarts(refYear = new Date().getFullYear()) {
  const y = Number.isFinite(refYear) ? refYear : new Date().getFullYear();
  const currentDecade = Math.floor(y / 10) * 10;
  return Array.from({ length: 5 }, (_, i) => currentDecade - i * 10);
}

/** Libellés FR pour le prompt (ex. « 2020–2029 »). */
function describeLastFiveDecadesForPrompt(refYear = new Date().getFullYear()) {
  return lastFiveDecadeStarts(refYear).map(d => `${d}–${d + 9}`).join(' ; ');
}

/**
 * Garde au plus 2 titres par décennie parmi les 5 dernières décennies (parution dans la plage).
 * Ordre : décennies décroissantes ; dans chaque décennie, parutions les plus récentes d'abord.
 */
function capLivresSimilairesParDecennies(rows, refYear = new Date().getFullYear()) {
  const decades = lastFiveDecadeStarts(refYear);
  const allowed = new Set(decades);
  const byDecade = new Map(decades.map(d => [d, []]));
  for (const row of rows) {
    const y = parsePublicationYear(row.annee);
    if (y == null) continue;
    const d0 = Math.floor(y / 10) * 10;
    if (!allowed.has(d0)) continue;
    byDecade.get(d0).push({ row, y });
  }
  const out = [];
  for (const d of decades) {
    const bucket = byDecade.get(d) || [];
    bucket.sort((a, b) => b.y - a.y);
    for (const { row } of bucket.slice(0, 2)) out.push(row);
  }
  return out;
}

/** Libellé d'une décennie (ex. 2023 → « 2020–2029 »). */
function decadeRangeLabel(year) {
  const y = typeof year === 'number' ? year : parsePublicationYear(year);
  if (y == null) return null;
  const d0 = Math.floor(y / 10) * 10;
  return `${d0}–${d0 + 9}`;
}

/** Trie les suggestions : décennie décroissante, puis année décroissante ; sans année à la fin. */
function sortReaderSimilarPicksDecadeDesc(picks) {
  return [...picks].sort((a, b) => {
    const ya = parsePublicationYear(a.year);
    const yb = parsePublicationYear(b.year);
    if (ya != null && yb != null) {
      const da = Math.floor(ya / 10) * 10;
      const db = Math.floor(yb / 10) * 10;
      if (da !== db) return db - da;
      return yb - ya;
    }
    if (ya != null) return -1;
    if (yb != null) return 1;
    return 0;
  });
}

/**
 * Regroupe les picks par libellé de décennie (décroissant), après tri global.
 * Les entrées sans année valide sont regroupées en un seul bloc sans titre de décennie.
 */
function groupSimilarPicksByDecadeDesc(picks) {
  const sorted = sortReaderSimilarPicksDecadeDesc(picks);
  const groups = [];
  for (const p of sorted) {
    const label = decadeRangeLabel(p.year);
    const last = groups[groups.length - 1];
    if (label != null && last && last.label === label) {
      last.items.push(p);
    } else if (label == null && last && last.label === null) {
      last.items.push(p);
    } else {
      groups.push({ label, items: [p] });
    }
  }
  return groups;
}

/** Titres pour « Pour prolonger la lecture » (même source que la bande horizontale). */
function readerSimilarPicksFromBook(book) {
  const rowsRaw = Array.isArray(book.livres_similaires_ia) ? book.livres_similaires_ia : [];
  const rows = rowsRaw.length ? capLivresSimilairesParDecennies(rowsRaw) : [];
  if (rows.length) {
    const picks = rows
      .map(r => ({
        title: String(r.titre ?? '').trim(),
        author: String(r.auteur ?? '').trim(),
        year: normalizeYearField(r.annee ?? r.date ?? r.year ?? r.publishedDate ?? ''),
        style: String(r.style ?? r.genre ?? r.type ?? '').trim(),
        meta: String(r.accroche ?? '').trim() || 'Suggestion IA',
      }))
      .filter(p => p.title);
    return sortReaderSimilarPicksDecadeDesc(picks);
  }
  const raw = Array.isArray(book.si_similaire) ? book.si_similaire : [];
  const out = [];
  for (const line of raw) {
    const s = String(line || '').trim();
    if (!s) continue;
    const parsed = parseSiSimilaireLine(s);
    if (parsed) {
      out.push({
        title: parsed.titre,
        author: parsed.auteur,
        year: normalizeYearField(parsed.annee ?? ''),
        style: String(parsed.style ?? '').trim(),
        meta: parsed.accroche?.trim() || 'Suggestion IA',
      });
    } else {
      out.push({ title: s, author: '', year: '', style: '', meta: 'Suggestion IA' });
    }
  }
  return sortReaderSimilarPicksDecadeDesc(out);
}

async function fetchSheetDetailFromLlm(book) {
  const title = book.info?.title || book.title || '';
  const author = book.info?.authors?.join(', ') || book.author || '';
  const vi = book.info || {};
  const meta = [];
  if (vi.pageCount) meta.push(`${vi.pageCount} pages`);
  if (vi.publishedDate) meta.push(`parution : ${vi.publishedDate}`);
  if (vi.publisher) meta.push(`éditeur : ${vi.publisher}`);
  if (vi.language) meta.push(`langue : ${vi.language}`);
  const noteGb = vi.averageRating;
  if (noteGb != null) meta.push(`note Google Books ~ ${Number(noteGb).toFixed(1)}`);
  const desc = truncateBlurb(vi.description || '', 900);
  const decadesLecture = describeLastFiveDecadesForPrompt();

  const userMsg = `Enrichis la fiche pour un lecteur exigeant (critique professionnelle + conseil d'achat).

**Titre** : ${title}
**Auteur** : ${author || 'inconnu'}
**Genre (analyse depuis photo, peut être faux)** : ${book.genre || 'non précisé'}
**Confiance identification** : ${book.confidence || '?'}
**Note déjà estimée (scan)** : ${book.note != null ? book.note : 'non renseignée'}

**Métadonnées publiques** :
${meta.length ? meta.map(l => `- ${l}`).join('\n') : '- aucune'}

${desc ? `**Extrait résumé éditeur / catalogue** :\n${desc}\n` : ''}
${book.critique ? `**Première lecture depuis le scan photo (à prolonger et professionnaliser — ne pas recopier)** :\n${book.critique.slice(0, 700)}\n` : ''}

Réponds par un objet JSON avec exactement ces clés :
- "genre" : string, genre littéraire principal en français, ou null
- "note" : number 0–5 (réception / qualité estimée), ou null
- "themes" : tableau de 4 à 7 thèmes ou motifs courts en français, sans spoiler
- "pour_qui" : string, une phrase sur le public idéal, ou null
- "pitch" : string, une phrase accroche sans spoiler, ou null
- "recompenses" : string, prix ou distinctions pour CE titre, ou null
- "place_dans_loeuvre" : string, une phrase sur ce roman dans la bibliographie de l'auteur (chef-d'œuvre, entrée, pivot…), ou null
- "auteur_wikipedia" : null ou objet {"url": string, "titre_article": string|null, "lang": "fr"|"en"|null} — URL desktop de l'article biographique Wikipédia de l'auteur principal de CE livre (même personne que pour le titre et l'auteur ci-dessus ; pas film, lieu, homonyme, page d'œuvre). "url" = https://fr.wikipedia.org/wiki/... ou https://en.wikipedia.org/wiki/... uniquement, sans paramètres de requête. "titre_article" = titre d'article humain (optionnel). null si auteur inconnu ou incertitude forte.
- "critique" : string, critique littéraire professionnelle en français : 8 à 14 phrases réparties en 3 ou 4 paragraphes courts (séparés par deux retours à la ligne \\n\\n). Contenu attendu — sans spoiler majeur ni résumé scène par scène : (1) annonce et cadrage — nature de l'ouvrage, promesse et originalité relative dans son genre ; (2) analyse — style, voix, construction narrative ou développement des idées ; personnages ou tension selon le cas ; (3) bilan — forces principales et réserves argumentées (longueur, facilité, redites…) ; (4) verdict — pour quel lecteur, avec quel niveau d'attente ; préciser si le titre tient la promesse éditoriale. Interdit : langage publicitaire, superlatifs gratuits, « coup de cœur », mystère fake. Si les infos sont insuffisantes, le dire clairement et orienter la décision (acheter / attendre / chercher un extrait).
- "livres_similaires" : tableau d'exactement 10 objets {"titre": string, "auteur": string, "accroche": string|null, "annee": string|number, "style": string|null} — pour « prolonger la lecture » si on a aimé CE livre : œuvres réelles (titres + auteurs exacts), autres auteurs ou titres comparables quand c'est pertinent. Répartition stricte : exactement 2 livres par décennie sur les 5 dernières décennies calendaires, soit les plages ${decadesLecture} — chaque "annee" doit être l'année de première parution (4 chiffres) qui tombe dans l'une de ces plages uniquement ; 2 titres dans chaque plage, ni plus ni moins si tu peux tenir le quota (sinon complète au mieux avec des titres sûrs). Liste dans l'ordre : les deux titres de la décennie la plus récente d'abord, puis les deux de la suivante, et ainsi de suite jusqu'à la cinquième décennie (aligné sur les plages ci-dessus). style = genre ou registre court en français sinon null ; accroche = une ou deux phrases courtes (max ~220 caractères) : situation, protagoniste, conflit ou mystère posé, sans spoiler de résolution ; interdit : répéter "style", clichés « polar haute tension », commentaires sur le suspense ou la qualité littéraire ; ne pas inclure le titre analysé ni sa suite directe évidente
- "si_similaire" : (optionnel) tableau de chaînes "Titre — Auteur" aligné sur les mêmes livres, ou [] si tu as déjà tout mis dans livres_similaires`;

  const text = await claudeNonStreamRequest({
    model,
    max_tokens: MAX_TOKENS_SHEET_DETAIL,
    system: SYSTEM_SHEET_DETAIL,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMsg }] }],
  });
  return text;
}

function mergeSheetDetailIntoBook(book, d) {
  if (!d || typeof d !== 'object') return;
  if (typeof d.genre === 'string' && d.genre.trim()) book.genre = d.genre.trim();
  if (typeof d.note === 'number' && Number.isFinite(d.note)) {
    book.note = Math.min(5, Math.max(0, d.note));
  }
  if (Array.isArray(d.themes) && d.themes.length) {
    book.themes = d.themes.map(x => String(x).trim()).filter(Boolean).slice(0, 10);
  }
  if (typeof d.pour_qui === 'string' && d.pour_qui.trim()) book.pour_qui = d.pour_qui.trim();
  if (typeof d.pitch === 'string' && d.pitch.trim()) book.pitch = d.pitch.trim();
  if (typeof d.recompenses === 'string' && d.recompenses.trim()) book.recompenses = d.recompenses.trim();
  if (typeof d.place_dans_loeuvre === 'string' && d.place_dans_loeuvre.trim()) {
    book.place_dans_loeuvre = d.place_dans_loeuvre.trim();
  }
  if (typeof d.critique === 'string' && d.critique.trim()) book.critique = d.critique.trim();

  if (Array.isArray(d.livres_similaires)) {
    const mapped = d.livres_similaires
      .filter(x => x && typeof x === 'object')
      .map(x => ({
        titre: String(x.titre ?? x.title ?? '').trim(),
        auteur: String(x.auteur ?? x.author ?? '').trim(),
        accroche: (() => {
          const a = typeof x.accroche === 'string' ? x.accroche.trim() : '';
          if (a) return a;
          const intr = typeof x.intrigue === 'string' ? x.intrigue.trim() : '';
          if (intr) return intr;
          return typeof x.pourquoi === 'string' ? x.pourquoi.trim() : '';
        })(),
        annee: normalizeYearField(x.annee ?? x.date ?? x.parution ?? x.year ?? x.publishedDate ?? x.date_parution ?? ''),
        style: String(x.style ?? x.genre ?? x.type ?? '').trim(),
      }))
      .filter(x => x.titre && x.auteur);
    book.livres_similaires_ia = capLivresSimilairesParDecennies(mapped);
    book.si_similaire = book.livres_similaires_ia.length
      ? book.livres_similaires_ia.map(x => `${x.titre} — ${x.auteur}`)
      : [];
  } else if (Array.isArray(d.si_similaire)) {
    const lines = d.si_similaire.map(x => String(x).trim()).filter(Boolean).slice(0, 8);
    book.si_similaire = lines;
    book.livres_similaires_ia = lines.map(parseSiSimilaireLine).filter(Boolean);
  }

  const awM = mergeAuthorWikiLlmFromDetail(d);
  if (awM) book._authorWikiLlm = awM;
  else if (d && typeof d === 'object' && 'auteur_wikipedia' in d) delete book._authorWikiLlm;

  book._sheetLlmFetched = true;
}

async function callClaude(b64, onFirstToken) {
  const fast = fastMode;
  const maxTokens = MAX_TOKENS[fast ? 'fast' : 'normal'];
  const system = fast ? SYSTEM_PROMPT_FAST : SYSTEM_PROMPT;
  const userText = fast
    ? 'Liste les livres visibles + JSON demandé.'
    : 'Identifie les livres et fournis une critique pour chacun.';

  const baseBody = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: userText },
    ]}],
  };

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ ...baseBody, stream: true }),
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Clé API invalide — vérifiez les paramètres');
    if (res.status === 429) throw new Error('Quota dépassé — réessayez dans quelques secondes');
    throw new Error(e.error?.message || `Erreur API ${res.status}`);
  }

  let txt = '';
  try {
    txt = await readClaudeSse(res.body, onFirstToken);
  } catch {
    txt = '';
  }

  if (!txt.trim()) {
    txt = await claudeNonStreamRequest(baseBody);
  }

  return parseBooksJson(txt);
}

// ── Google Books — cover + metadata only (critique comes from Claude) ─────────
async function fetchCover(title, author) {
  const q = `intitle:${encodeURIComponent(title)}`
    + (author ? `+inauthor:${encodeURIComponent(author)}` : '');
  try {
    const r = await fetch(
      `${GBOOKS_URL}?q=${q}&maxResults=1&fields=items(volumeInfo(title,subtitle,authors,imageLinks,pageCount,publishedDate,averageRating,ratingsCount,categories,description,publisher,language,industryIdentifiers))`
    );
    const d = await r.json();
    return d.items?.[0]?.volumeInfo ?? null;
  } catch { return null; }
}

// ── Fiche auteur : Wikipédia en tête (extrait + lien) ; Open Library en complément (dates, portrait si pas d’image wiki) ──
function normTitle(t) {
  try {
    return String(t || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
}

function primaryAuthor(author) {
  if (!author) return '';
  return String(author).split(/[;,]/)[0].trim().replace(/\s+/g, ' ');
}

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html || '');
  return (d.textContent || d.innerText || '').trim();
}

function normalizeOlBio(bio) {
  if (!bio) return '';
  if (typeof bio === 'string') return stripHtml(bio).trim();
  if (typeof bio === 'object' && bio.value) return stripHtml(bio.value).trim();
  return '';
}

const LANG_LABEL = {
  fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand', it: 'Italien',
  pt: 'Portugais', nl: 'Néerlandais', sv: 'Suédois', no: 'Norvégien', da: 'Danois',
  pl: 'Polonais', ru: 'Russe', ja: 'Japonais', ko: 'Coréen', zh: 'Chinois',
};

function langLabel(code) {
  if (!code) return '';
  const c = String(code).trim().slice(0, 2).toLowerCase();
  return LANG_LABEL[c] || String(code).toUpperCase();
}

function pickPrimaryIsbn(info) {
  const ids = info?.industryIdentifiers;
  if (!Array.isArray(ids)) return '';
  const i13 = ids.find(x => x.type === 'ISBN_13');
  if (i13?.identifier) return String(i13.identifier).replace(/\s|-/g, '');
  const i10 = ids.find(x => x.type === 'ISBN_10');
  return i10?.identifier ? String(i10.identifier) : '';
}

// ── Wishlist (localStorage, P0–P2 : id stable, Effacer ≠ liste, schéma v1, quota, multi-onglets) ──
function enrichedBookStableId(book) {
  if (!book || typeof book !== 'object') return 'key::';
  const isbn = pickPrimaryIsbn(book.info);
  if (isbn) return `isbn:${isbn}`;
  const title = book.info?.title || book.title || '';
  const author = book.info?.authors?.join(', ') || book.author || '';
  return `key:${normTitle(title)}::${normTitle(primaryAuthor(author))}`;
}

function wishlistPayloadFromBook(book, opts = {}) {
  const omitBook = !!opts.omitBook;
  const title = book.info?.title || book.title || '';
  const author = book.info?.authors?.join(', ') || book.author || '';
  const id = enrichedBookStableId(book);
  const thumb = book.info?.imageLinks?.thumbnail?.replace('http:', 'https:')
    || book.info?.imageLinks?.smallThumbnail?.replace('http:', 'https:') || null;
  const isbn = pickPrimaryIsbn(book.info) || '';
  let bookSnap = null;
  if (!omitBook) {
    try {
      bookSnap = cloneBookForSheetHistory(book);
    } catch { /* entrée sans book */ }
  }
  return {
    id,
    title: (title || 'Sans titre').slice(0, 500),
    author: (author || 'Auteur inconnu').slice(0, 300),
    isbn: isbn.slice(0, 24),
    genre: typeof book.genre === 'string' ? book.genre.slice(0, 120) : null,
    thumbUrl: thumb ? thumb.slice(0, 2000) : null,
    addedAt: Date.now(),
    book: bookSnap,
  };
}

function wishlistHasId(id) {
  return wishlistItems.some(x => x.id === id);
}

function parseWishlistItemsArray(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const it of arr) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id) continue;
    const book = it.book && typeof it.book === 'object' ? it.book : null;
    let title = String(it.title || 'Sans titre').slice(0, 500);
    let author = String(it.author || '').slice(0, 300);
    if (book) {
      const t2 = book.info?.title || book.title || '';
      const a2 = book.info?.authors?.join(', ') || book.author || '';
      if (t2) title = String(t2).slice(0, 500);
      if (a2) author = String(a2).slice(0, 300);
    }
    out.push({
      id: it.id,
      title,
      author,
      isbn: String(it.isbn || '').slice(0, 24),
      genre: typeof it.genre === 'string' ? it.genre.slice(0, 120) : null,
      thumbUrl: typeof it.thumbUrl === 'string' ? it.thumbUrl.slice(0, 2000) : null,
      addedAt: Number.isFinite(it.addedAt) ? it.addedAt : Date.now(),
      book,
    });
  }
  return out;
}

function wishlistReloadFromDisk() {
  wishlistItems = [];
  try {
    const raw = localStorage.getItem(WISHLIST_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const arr = parsed?.items ?? (Array.isArray(parsed) ? parsed : []);
    wishlistItems = parseWishlistItemsArray(arr);
  } catch {
    wishlistItems = [];
  }
}

function wishlistApplyFromJsonString(jsonStr) {
  wishlistItems = [];
  if (jsonStr == null) return;
  try {
    const parsed = JSON.parse(jsonStr);
    const arr = parsed?.items ?? (Array.isArray(parsed) ? parsed : []);
    wishlistItems = parseWishlistItemsArray(arr);
  } catch {
    wishlistItems = [];
  }
}

function wishlistPersist() {
  const payload = JSON.stringify({ v: WISHLIST_SCHEMA_VERSION, items: wishlistItems });
  try {
    localStorage.setItem(WISHLIST_STORAGE_KEY, payload);
    return { ok: true };
  } catch (e) {
    const quota = e?.name === 'QuotaExceededError' || e?.code === 22;
    return { ok: false, quota };
  }
}

function wishlistSnapshotItems() {
  return wishlistItems.map(x => ({
    ...x,
    book: x.book ? cloneBookForSheetHistory(x.book) : null,
  }));
}

function wishlistRestoreSnapshot(snapshot) {
  wishlistItems = snapshot.map(x => ({
    ...x,
    book: x.book ? cloneBookForSheetHistory(x.book) : null,
  }));
}

function wishlistToggleFromBook(book) {
  const next = wishlistPayloadFromBook(book);
  const pos = wishlistItems.findIndex(x => x.id === next.id);
  const snapshot = wishlistSnapshotItems();
  if (pos >= 0) wishlistItems.splice(pos, 1);
  else wishlistItems.unshift(next);
  let r = wishlistPersist();
  if (!r.ok && r.quota && pos < 0 && next.book) {
    wishlistRestoreSnapshot(snapshot);
    wishlistItems.unshift(wishlistPayloadFromBook(book, { omitBook: true }));
    r = wishlistPersist();
  }
  if (!r.ok) {
    wishlistRestoreSnapshot(snapshot);
    return { ok: false, quota: r.quota };
  }
  return { ok: true, added: pos < 0 };
}

function updateWishlistHeaderBadge() {
  if (!wishlistBtn || !wishlistBadge) return;
  const n = wishlistItems.length;
  wishlistBadge.textContent = n > 99 ? '99+' : String(n);
  wishlistBadge.hidden = n === 0;
  wishlistBtn.setAttribute('aria-label', n ? `Ma liste, ${n} livre(s)` : 'Ma liste (vide)');
}

function getSheetBook() {
  if (sheetDetachedBook && typeof sheetDetachedBook === 'object') return sheetDetachedBook;
  const sheet = $('book-sheet');
  if (!sheet) return null;
  const idx = parseInt(sheet.dataset.sheetBookIdx ?? '', 10);
  if (!Number.isFinite(idx)) return null;
  return cachedEnrichedBooks[idx] || null;
}

function patchSheetWishlistButton() {
  const btn = $('sheet-wishlist-btn');
  const sheet = $('book-sheet');
  if (!btn || !sheet || sheet.classList.contains('hidden')) return;
  const book = getSheetBook();
  if (!book) return;
  const on = wishlistHasId(enrichedBookStableId(book));
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on ? '♥ En liste' : '♡ Ajouter à ma liste';
}

function refreshWishlistDependentUi() {
  updateWishlistHeaderBadge();
  patchSheetWishlistButton();
  renderWishlistPanelBody();
  if (resultsPanel?.classList.contains('has-results') && Array.isArray(cachedEnrichedBooks) && cachedEnrichedBooks.length) {
    renderCards(cachedEnrichedBooks);
    patchArMarkersWithCovers(cachedEnrichedBooks);
  }
}

function openWishlistModal() {
  if (!wishlistModal) return;
  renderWishlistPanelBody();
  wishlistModal.classList.remove('hidden');
}

function closeWishlistModal() {
  wishlistModal?.classList.add('hidden');
}

function renderWishlistPanelBody() {
  if (!wishlistBody) return;
  if (wishlistClearAll) wishlistClearAll.disabled = wishlistItems.length === 0;
  if (!wishlistItems.length) {
    wishlistBody.innerHTML = '<p class="empty-hint wishlist-empty">Aucun livre en liste. Ajoutez depuis une carte ou la fiche détail.</p>';
    return;
  }
  wishlistBody.innerHTML = wishlistItems.map(it => {
    const t = esc(it.title);
    const a = esc(it.author);
    const safeId = encodeURIComponent(it.id);
    const img = it.thumbUrl
      ? `<div class="wishlist-row-thumb"><img src="${esc(it.thumbUrl)}" alt="" loading="lazy"></div>`
      : '<div class="wishlist-row-thumb wishlist-row-thumb--ph" aria-hidden="true"></div>';
    return `<article class="wishlist-row wishlist-row--clickable" role="button" tabindex="0" data-wishlist-open="${safeId}" aria-label="Ouvrir la fiche : ${t}">
      ${img}
      <div class="wishlist-row-text">
        <div class="wishlist-row-title">${t}</div>
        <div class="wishlist-row-author">${a}</div>
      </div>
      <button type="button" class="wishlist-remove-btn" data-wishlist-remove="${safeId}" aria-label="Retirer de la liste : ${t}">Retirer</button>
    </article>`;
  }).join('');
}

/** Affichage lisible de publishedDate Google Books (YYYY, YYYY-MM, etc.). */
function formatPublishedDisplay(raw) {
  if (!raw || !String(raw).trim()) return '';
  const s = String(raw).trim();
  if (/^\d{4}$/.test(s)) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, mo, d] = iso;
    try {
      const dt = new Date(Number(y), Number(mo) - 1, Number(d));
      if (!Number.isNaN(dt.getTime())) {
        return dt.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
      }
    } catch { /* fallthrough */ }
    return s;
  }
  const ym = s.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const mi = Number(ym[2]) - 1;
    return mi >= 0 && mi < 12 ? `${months[mi]} ${ym[1]}` : s;
  }
  return s;
}

function readingEffortLabel(pages) {
  const p = Number(pages);
  if (!Number.isFinite(p) || p <= 0) return '';
  if (p < 200) return 'Lecture plutôt courte';
  if (p < 350) return 'Ampleur moyenne';
  if (p < 550) return 'Roman costaud — prévoir du temps';
  return 'Très volumineux';
}

function fmtRatingsCount(n) {
  if (!Number.isFinite(n) || n < 1) return '';
  if (n >= 10000) return `${Math.round(n / 1000)}k avis`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k avis`;
  return `${Math.round(n)} avis`;
}

function mergeThemeTags(book) {
  const seen = new Set();
  const out = [];
  const push = s => {
    const t = String(s || '').trim();
    if (!t || t.length > 52) return;
    const k = normTitle(t);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const ai = book.themes;
  if (Array.isArray(ai)) ai.forEach(push);
  else if (typeof ai === 'string') ai.split(/[,;|]/).forEach(x => push(x.trim()));
  const cats = book.info?.categories || [];
  for (const c of cats) {
    const parts = String(c).split('/').map(p => p.trim()).filter(Boolean);
    const leaf = parts[parts.length - 1];
    push(leaf);
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

function truncateBlurb(text, max = 480) {
  const plain = stripHtml(text).replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${sp > max * 0.65 ? cut.slice(0, sp) : cut}…`;
}

/** Premier titre d’article issu de la recherche wiki (page réelle, pas homonymie vide). */
async function wikiOpensearchFirstTitle(query, lang) {
  const q = String(query || '').trim();
  if (!q) return null;
  try {
    const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    u.searchParams.set('action', 'opensearch');
    u.searchParams.set('search', q);
    u.searchParams.set('limit', '6');
    u.searchParams.set('namespace', '0');
    u.searchParams.set('format', 'json');
    u.searchParams.set('origin', '*');
    const r = await fetch(u.toString());
    if (!r.ok) return null;
    const data = await r.json();
    const titles = Array.isArray(data?.[1]) ? data[1] : [];
    const first = titles.find(t => String(t).trim());
    return first ? String(first).trim() : null;
  } catch {
    return null;
  }
}

async function fetchWikiSummaryForTitle(title, lang) {
  const t = String(title || '').trim();
  if (!t) return null;
  const safe = encodeURIComponent(t.replace(/\s+/g, '_'));
  try {
    const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${safe}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.type === 'disambiguation' || !d.extract) return null;
    const thumb = d.thumbnail?.source ? String(d.thumbnail.source).replace(/^http:/, 'https:') : '';
    return {
      extract: d.extract,
      title: d.title,
      url: d.content_urls?.desktop?.page,
      lang,
      thumbUrl: thumb || '',
    };
  } catch {
    return null;
  }
}

/** Extrait { lang, title } d'une URL article desktop *.wikipedia.org/wiki/… (hors espaces de noms spéciaux). */
function parseWikipediaArticleUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s, 'https://fr.wikipedia.org');
    const host = u.hostname.replace(/^www\./i, '');
    const m = host.match(/^([a-z]{2,12})\.wikipedia\.org$/i);
    if (!m) return null;
    const lang = m[1].toLowerCase();
    const path = u.pathname || '';
    if (!path.startsWith('/wiki/')) return null;
    let enc = path.slice('/wiki/'.length).split('/')[0];
    if (!enc) return null;
    const decodedSeg = decodeURIComponent(enc);
    if (/^special:/i.test(decodedSeg)) return null;
    const title = decodedSeg.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    return { lang, title };
  } catch {
    return null;
  }
}

/** Valide et normalise la suggestion Wikipédia auteur renvoyée par l'IA (JSON fiche). */
function mergeAuthorWikiLlmFromDetail(d) {
  const aw = d?.auteur_wikipedia;
  if (aw == null) return null;
  let url = '';
  let titre_article = '';
  if (typeof aw === 'object' && aw) {
    url = String(aw.url || '').trim();
    titre_article = String(aw.titre_article || aw.title || '').trim();
  } else if (typeof aw === 'string') {
    url = aw.trim();
  }
  if (!url) return null;
  const base = url.split('#')[0].split('?')[0];
  const parsed = parseWikipediaArticleUrl(base);
  if (!parsed) return null;
  return {
    url: base,
    titre_article: titre_article || parsed.title,
    lang: parsed.lang,
  };
}

/** Résumé + lien Wikipédia (FR puis EN), avec recherche opensearch si le titre littéral ne matche pas. */
async function fetchWikiAuthorSummary(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;

  const tryLang = async lang => {
    let w = await fetchWikiSummaryForTitle(raw, lang);
    if (w) return w;
    const alt = await wikiOpensearchFirstTitle(raw, lang);
    if (!alt || alt === raw) return null;
    w = await fetchWikiSummaryForTitle(alt, lang);
    return w || null;
  };

  return (await tryLang('fr')) || (await tryLang('en'));
}

function pickOlAuthorDoc(docs, name) {
  if (!docs?.length) return null;
  const target = normTitle(name);
  return docs.find(d => normTitle(d.name) === target) || docs[0];
}

async function fetchOlAuthorDetail(authorKey) {
  const path = authorKey.startsWith('/') ? authorKey : `/authors/${authorKey}`;
  try {
    const r = await fetch(`https://openlibrary.org${path}.json`);
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

function renderAuthorSectionHtml(wiki, olDetail, _pickedDoc, authorName) {
  let bio = wiki?.extract ? String(wiki.extract).trim() : '';
  const olBio = normalizeOlBio(olDetail?.bio);
  if (olBio.length > bio.length) bio = olBio;

  const dates = [];
  if (olDetail?.birth_date) dates.push(`Naissance : ${olDetail.birth_date}`);
  if (olDetail?.death_date) dates.push(`Décès : ${olDetail.death_date}`);
  const dateStr = dates.join(' · ');

  const photoId = olDetail?.photos?.[0];
  const olPhotoUrl = photoId ? `https://covers.openlibrary.org/a/id/${photoId}-M.jpg` : '';
  const wikiPhoto = (wiki?.thumbUrl && String(wiki.thumbUrl).trim()) || '';
  const photoUrl = wikiPhoto || olPhotoUrl;

  const wikiIaHint = wiki?.fromLlm
    ? '<span class="sheet-author-wiki-ia" title="Article proposé lors de l\'approfondissement IA"> (IA)</span>'
    : '';
  const wikiArticleLink = wiki?.url
    ? `<p class="sheet-author-wiki sheet-author-wiki--primary"><a class="card-link" href="${esc(wiki.url)}" target="_blank" rel="noopener">Wikipédia — <span class="sheet-author-wiki-title">${esc(wiki.title || authorName)}</span> <span class="sheet-author-wiki-lang">(${wiki.lang?.toUpperCase() || '?'})</span>${wikiIaHint} ↗</a></p>`
    : '';

  const wikiSearchLink = !wiki?.url && authorName
    ? `<p class="sheet-author-wiki sheet-author-wiki--primary"><a class="card-link" href="https://fr.wikipedia.org/w/index.php?search=${encodeURIComponent(authorName)}" target="_blank" rel="noopener">Rechercher <strong>${esc(authorName)}</strong> sur Wikipédia ↗</a></p>`
    : '';

  const hasPortrait = Boolean(photoUrl);
  const hasDates = Boolean(dateStr);
  const hasBio = Boolean(bio);
  const hasWikiArticle = Boolean(wiki?.url);
  if (!hasWikiArticle && !wikiSearchLink && !hasPortrait && !hasDates && !hasBio) {
    return `
      <p class="sheet-author-empty">
        Pas d’entrée trouvée pour <strong>${esc(authorName)}</strong>.
        Essayez une recherche sur <a class="card-link" href="https://fr.wikipedia.org/w/index.php?search=${encodeURIComponent(authorName)}" target="_blank" rel="noopener">Wikipédia ↗</a> ou vérifiez l’orthographe du nom.
      </p>`;
  }

  const bioHint = !hasBio
    ? (hasWikiArticle
        ? '<p class="sheet-author-empty sheet-author-empty--inline">Pas d’extrait sur cette fiche — le lien mène à l’article Wikipédia complet.</p>'
        : (wikiSearchLink
            ? '<p class="sheet-author-empty sheet-author-empty--inline">Aucun article reconnu automatiquement — la recherche Wikipédia ci-dessus peut aider.</p>'
            : ''))
    : '';

  return `
    <div class="sheet-author-card">
      ${wikiArticleLink || wikiSearchLink}
      ${photoUrl ? `<img class="sheet-author-photo" src="${esc(photoUrl)}" alt="" loading="lazy">` : ''}
      ${dateStr ? `<div class="sheet-author-dates">${esc(dateStr)}</div>` : ''}
      ${hasBio ? `<div class="sheet-author-bio"><p>${esc(bio)}</p></div>` : ''}
      ${bioHint}
    </div>`;
}

function sheetAuthorSkeleton() {
  return `
    <div class="sheet-skel-block" aria-busy="true">
      <div class="sk sheet-skel-line"></div>
      <div class="sk sheet-skel-line mid"></div>
      <div class="sk sheet-skel-line short"></div>
    </div>`;
}

async function hydrateSheetAuthorZones(book, authorName, gen) {
  const mount = $('sheet-author-mount');
  if (!mount) return;

  if (!authorName) {
    if (gen !== bookSheetLoadGen) return;
    mount.innerHTML = '<p class="sheet-author-empty">Auteur non identifié sur cette détection.</p>';
    return;
  }

  mount.innerHTML = sheetAuthorSkeleton();

  try {
    const [wikiHeur, olSearch] = await Promise.all([
      fetchWikiAuthorSummary(authorName),
      fetch(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(authorName)}&limit=8`).then(r => r.json()).catch(() => ({ docs: [] })),
    ]);

    if (gen !== bookSheetLoadGen) return;

    let wiki = wikiHeur;
    const llmMeta = book._authorWikiLlm;
    const llmUrl = llmMeta && typeof llmMeta.url === 'string' ? llmMeta.url.trim() : '';
    if (llmUrl) {
      const pUrl = parseWikipediaArticleUrl(llmUrl);
      if (pUrl) {
        const wLlm = await fetchWikiSummaryForTitle(pUrl.title, pUrl.lang);
        if (wLlm?.url) {
          wiki = { ...wLlm, fromLlm: true };
        } else {
          const tit = String(llmMeta.titre_article || pUrl.title || '').trim() || pUrl.title;
          const base = llmUrl.split('#')[0].split('?')[0];
          wiki = {
            extract: wikiHeur?.extract || '',
            title: tit,
            url: base,
            lang: pUrl.lang,
            thumbUrl: wikiHeur?.thumbUrl || '',
            fromLlm: true,
          };
        }
      }
    }

    const docs = olSearch.docs || [];
    const picked = pickOlAuthorDoc(docs, authorName);
    let olDetail = null;
    if (picked?.key) {
      olDetail = await fetchOlAuthorDetail(picked.key);
    }

    if (gen !== bookSheetLoadGen) return;

    const m2 = $('sheet-author-mount');
    if (!m2 || gen !== bookSheetLoadGen) return;
    m2.innerHTML = renderAuthorSectionHtml(wiki, olDetail, picked, authorName);
  } catch {
    if (gen !== bookSheetLoadGen) return;
    const m2 = $('sheet-author-mount');
    if (m2) m2.innerHTML = '<p class="sheet-author-empty">Impossible de charger les informations auteur (réseau ou limite).</p>';
  }
}

function buildSheetFactsStrip(book) {
  const vi = book.info || {};
  const chips = [];
  const pd = formatPublishedDisplay(vi.publishedDate);
  if (pd) chips.push(`<span class="sheet-fact-chip" title="Parution">${esc(pd)}</span>`);
  const pages = vi.pageCount;
  if (pages) chips.push(`<span class="sheet-fact-chip">${pages} p.</span>`);
  const lang = langLabel(vi.language);
  if (lang) chips.push(`<span class="sheet-fact-chip">${esc(lang)}</span>`);
  let pub = vi.publisher ? String(vi.publisher).trim() : '';
  if (pub.length > 44) pub = `${pub.slice(0, 42)}…`;
  if (pub) chips.push(`<span class="sheet-fact-chip">${esc(pub)}</span>`);
  const ar = vi.averageRating;
  const rc = vi.ratingsCount;
  if (ar != null && rc) {
    chips.push(`<span class="sheet-fact-chip">GB ★ ${Number(ar).toFixed(1)} · ${esc(fmtRatingsCount(rc))}</span>`);
  } else if (ar != null) {
    chips.push(`<span class="sheet-fact-chip">GB ★ ${Number(ar).toFixed(1)}</span>`);
  }

  const catLeaves = [];
  const seen = new Set();
  for (const c of vi.categories || []) {
    const parts = String(c).split('/').map(p => p.trim()).filter(Boolean);
    const leaf = parts[parts.length - 1];
    const k = normTitle(leaf);
    if (!leaf || seen.has(k)) continue;
    seen.add(k);
    catLeaves.push(leaf);
    if (catLeaves.length >= 6) break;
  }
  const catsHtml = catLeaves.length
    ? `<div class="sheet-fact-cats" role="list">${catLeaves.map(t =>
      `<span class="sheet-fact-cat" role="listitem">${esc(t)}</span>`).join('')}</div>`
    : '';

  const rows = chips.length
    ? `<div class="sheet-facts-row">${chips.join('')}</div>`
    : '';
  const inner = (rows || catsHtml)
    ? `<div class="sheet-facts-inner">${rows}${catsHtml}</div>`
    : '';

  if (!inner) return '';
  return `<div id="sheet-facts" class="sheet-facts" aria-label="Informations édition">${inner}</div>`;
}

function buildSheetCritiqueBodyHtml(book, llmPending) {
  const raw = typeof book.critique === 'string' ? book.critique.trim() : '';
  if (raw) {
    const paras = raw.split(/\n+/).map(s => s.trim()).filter(Boolean).map(s => `<p>${esc(s)}</p>`).join('');
    return `<div class="sheet-critique">${paras}</div>`;
  }
  if (llmPending) {
    return `<div class="sheet-critique sheet-critique--waiting" aria-busy="true">
      <div class="sheet-llm-skel-lines">
        <div class="sheet-llm-skel-line"></div><div class="sheet-llm-skel-line sheet-llm-skel-line--mid"></div>
        <div class="sheet-llm-skel-line sheet-llm-skel-line--short"></div>
      </div>
      <p class="sheet-critique-wait-msg">Rédaction de la critique détaillée…</p>
    </div>`;
  }
  return '<p class="sheet-empty-soft">Pas encore de critique IA pour ce titre.</p>';
}

function buildSheetReaderSection(book, llmPending) {
  const pages = book.info?.pageCount;
  const themesArr = mergeThemeTags(book);
  const themeRow = themesArr.length
    ? `<div class="sheet-field">
        <span class="sheet-field-label">Thèmes & motifs</span>
        <div class="sheet-theme-row" role="list">${themesArr.map(t =>
      `<span class="sheet-chip-theme" role="listitem">${esc(t)}</span>`).join('')}</div>
      </div>`
    : '';

  const pourQuiRaw = typeof book.pour_qui === 'string' ? book.pour_qui.trim() : '';
  const pourQuiBlock = pourQuiRaw
    ? `<div class="sheet-insight">
        <span class="sheet-insight-ico" aria-hidden="true"></span>
        <div class="sheet-insight-main">
          <span class="sheet-field-label">Pour qui</span>
          <p class="sheet-insight-text">${esc(pourQuiRaw)}</p>
        </div>
      </div>`
    : '';

  const pitchRaw = typeof book.pitch === 'string' ? book.pitch.trim() : '';
  const pitchBlock = pitchRaw
    ? `<blockquote class="sheet-pullquote">
        <span class="sheet-field-label">Accroche</span>
        <p>${esc(pitchRaw)}</p>
      </blockquote>`
    : '';

  const placeRaw = typeof book.place_dans_loeuvre === 'string' ? book.place_dans_loeuvre.trim() : '';
  const placeBlock = placeRaw
    ? `<div class="sheet-place-loeuvre">
        <span class="sheet-field-label">Dans l'œuvre de l'auteur</span>
        <p class="sheet-place-text">${esc(placeRaw)}</p>
      </div>`
    : '';

  const simPicks = readerSimilarPicksFromBook(book);
  const simGroups = simPicks.length ? groupSimilarPicksByDecadeDesc(simPicks) : [];
  const simBlock = simGroups.length
    ? `<div class="sheet-similaire">
        <span class="sheet-field-label">Pour prolonger la lecture</span>
        <div class="sheet-sim-decades">${simGroups.map(g => {
    const head = g.label
      ? `<h4 class="sheet-sim-decade-title">${esc(g.label)}</h4>`
      : '';
    const btns = g.items.map(p => {
      const label = `Ouvrir la fiche : ${p.title}`;
      const au = p.author?.trim() ? esc(p.author.trim()) : '—';
      const yr = p.year?.trim() ? esc(p.year.trim()) : '—';
      const st = p.style?.trim() ? esc(p.style.trim()) : '—';
      return `<button type="button" class="sheet-sim-open" role="listitem"
        data-more-title="${esc(p.title)}"
        data-more-author="${esc(p.author)}"
        aria-label="${esc(label)}">
        <span class="sheet-sim-open-title">${esc(p.title)}</span>
        <span class="sheet-sim-open-facts">
          <span class="sheet-sim-fact"><span class="sheet-sim-fact-k">Auteur</span> ${au}</span>
          <span class="sheet-sim-fact"><span class="sheet-sim-fact-k">Parution</span> ${yr}</span>
          <span class="sheet-sim-fact"><span class="sheet-sim-fact-k">Style</span> ${st}</span>
        </span>
        <span class="sheet-sim-open-intrigue">
          <span class="sheet-sim-fact-k">Intrigue</span>
          <span class="sheet-sim-open-meta">${esc(p.meta)}</span>
        </span>
      </button>`;
    }).join('');
    const noDec = g.label == null ? ' data-sheet-sim-no-decade' : '';
    return `<section class="sheet-sim-decade"${noDec}>${head}<div class="sheet-sim-list sheet-sim-list--actions" role="list">${btns}</div></section>`;
  }).join('')}
        </div>
      </div>`
    : '';

  const effort = readingEffortLabel(pages);
  const ratingsLbl = fmtRatingsCount(book.info?.ratingsCount);
  const recoRaw = typeof book.recompenses === 'string' ? book.recompenses.trim() : '';

  const statCells = [];
  if (effort) statCells.push(['Rythme', effort]);
  if (ratingsLbl) statCells.push(['Avis catalogue', ratingsLbl]);
  if (recoRaw) statCells.push(['Distinctions', recoRaw]);

  const statsGrid = statCells.length
    ? `<div class="sheet-field sheet-field--flush">
        <span class="sheet-field-label">Cadre éditorial</span>
        <div class="sheet-stat-cards">${statCells.map(([k, v]) =>
      `<div class="sheet-stat-card"><span class="sheet-stat-k">${esc(k)}</span><span class="sheet-stat-v">${esc(v)}</span></div>`).join('')}</div>
      </div>`
    : '';

  const readerParts = [pourQuiBlock, pitchBlock, placeBlock, themeRow, simBlock, statsGrid].filter(Boolean);

  if (!readerParts.length && llmPending) {
    readerParts.push(`<div class="sheet-llm-inline-skel" aria-busy="true">
      <div class="sheet-llm-skel-lines">
        <div class="sheet-llm-skel-line"></div><div class="sheet-llm-skel-line sheet-llm-skel-line--mid"></div>
        <div class="sheet-llm-skel-line sheet-llm-skel-line--short"></div>
      </div>
      <p class="sheet-critique-wait-msg">Analyse lecteur en cours…</p>
    </div>`);
  }

  if (!readerParts.length) return '';

  return `<section id="sheet-reader-host" class="sheet-panel sheet-panel--reader sheet-panel--dense" aria-labelledby="sheet-reader-heading">
        <div class="sheet-panel-head">
          <span class="sheet-panel-orb sheet-panel-orb--reader" aria-hidden="true"></span>
          <div class="sheet-panel-head-text">
            <h3 id="sheet-reader-heading" class="sheet-panel-title">Profil de lecture</h3>
            <p class="sheet-panel-sub">Public, tonalité, prolongements — sans spoiler.</p>
          </div>
        </div>
        <div class="sheet-panel-body sheet-panel-body--stack">${readerParts.join('')}</div>
      </section>`;
}

function buildSheetCritiqueSection(book, llmPending) {
  const body = buildSheetCritiqueBodyHtml(book, llmPending);
  return `<section id="sheet-critique-host" class="sheet-panel sheet-panel--critique sheet-panel--dense sheet-panel--lead" aria-labelledby="sheet-critique-heading">
        <div class="sheet-panel-head">
          <span class="sheet-panel-orb sheet-panel-orb--warm" aria-hidden="true"></span>
          <div class="sheet-panel-head-text">
            <h3 id="sheet-critique-heading" class="sheet-panel-title">Critique IA</h3>
            <p class="sheet-panel-sub">${llmPending ? 'Synthèse en cours après la détection.' : 'Résumé lecture sans spoiler.'}</p>
          </div>
        </div>
        <div class="sheet-panel-body">${body}</div>
      </section>`;
}

function applySheetLlmDomPatch(book, gen) {
  if (gen !== bookSheetLoadGen) return;
  const newFacts = buildSheetFactsStrip(book);
  const factsEl = $('sheet-facts');
  if (newFacts) {
    if (factsEl) {
      factsEl.outerHTML = newFacts;
    } else {
      const wl = document.querySelector('.sheet-wishlist-row');
      if (wl) {
        const hero = document.querySelector('.sheet-hero-status');
        if (hero) hero.insertAdjacentHTML('beforeend', newFacts);
        else wl.insertAdjacentHTML('afterend', `<div class="sheet-hero-status">${newFacts}</div>`);
      }
    }
  } else if (factsEl) {
    const hero = factsEl.closest('.sheet-hero-status');
    factsEl.remove();
    if (hero && hero.childElementCount === 0) hero.remove();
  }
  const m = $('sheet-metrics');
  if (m) m.remove();
  const kick = document.querySelector('.sheet-kicker');
  if (kick) kick.textContent = book.genre ? book.genre : 'Livre';
  const r = $('sheet-reader-host');
  const nextReader = buildSheetReaderSection(book, false);
  if (nextReader) {
    if (r) r.outerHTML = nextReader;
  } else if (r) {
    r.remove();
  }
  const c = $('sheet-critique-host');
  if (c) c.outerHTML = buildSheetCritiqueSection(book, false);
  patchSheetWishlistButton();
  const curBook = getSheetBook();
  if (curBook && curBook._authorWikiLlm?.url) {
    const ar = primaryAuthor(curBook.info?.authors?.join(', ') || curBook.author || '');
    void hydrateSheetAuthorZones(curBook, ar, gen);
  }
}

function setSheetLlmBar(gen, mode, detail) {
  if (gen !== bookSheetLoadGen) return;
  const bar = $('sheet-llm-bar');
  if (!bar) return;
  bar.className = 'sheet-llm-bar';
  if (mode === 'hidden') {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  if (mode === 'busy') {
    bar.classList.add('sheet-llm-bar--busy');
    bar.innerHTML = '<span class="sheet-llm-spinner" aria-hidden="true"></span><span>Approfondissement IA des infos…</span>';
  } else if (mode === 'done') {
    bar.classList.add('sheet-llm-bar--done');
    bar.innerHTML = '<span class="sheet-llm-check" aria-hidden="true">✓</span><span>Fiche enrichie par IA</span>';
  } else if (mode === 'error') {
    bar.classList.add('sheet-llm-bar--err');
    bar.innerHTML = `<span>${detail ? esc(detail) : 'Enrichissement IA indisponible.'}</span>`;
  }
}

function writeEnrichedBookAtIndex(book, idx) {
  if (idx != null && Number.isFinite(idx) && idx >= 0) {
    cachedEnrichedBooks[idx] = book;
  }
}

async function runSheetLlmEnrich(book, idx, gen) {
  setSheetLlmBar(gen, 'busy');
  try {
    const txt = await fetchSheetDetailFromLlm(book);
    const d = parseSheetDetailJson(txt);
    if (gen !== bookSheetLoadGen) return;
    if (d) {
      mergeSheetDetailIntoBook(book, d);
    } else {
      book._sheetLlmFetched = true;
      setSheetLlmBar(gen, 'error', 'Réponse IA illisible.');
      writeEnrichedBookAtIndex(book, idx);
      applySheetLlmDomPatch(book, gen);
      return;
    }
    writeEnrichedBookAtIndex(book, idx);
    applySheetLlmDomPatch(book, gen);
    setSheetLlmBar(gen, 'done');
    setTimeout(() => {
      if (gen === bookSheetLoadGen) setSheetLlmBar(gen, 'hidden');
    }, 2600);
  } catch (err) {
    if (gen !== bookSheetLoadGen) return;
    book._sheetLlmFetched = true;
    writeEnrichedBookAtIndex(book, idx);
    const msg = err?.message || 'Erreur réseau ou quota.';
    setSheetLlmBar(gen, 'error', msg);
    applySheetLlmDomPatch(book, gen);
  }
}

function renderSheetShell(book, gen, opts = {}) {
  const llmPending = !!opts.llmPending;
  const titleRaw = book.info?.title || book.title;
  const authorRaw = book.info?.authors?.join(', ') || book.author || '';
  const authorNameHtml = esc(authorRaw || 'Auteur inconnu');
  const subRaw = book.info?.subtitle;
  const subtitleHtml = subRaw ? `<p class="sheet-subtitle">${esc(subRaw)}</p>` : '';
  const genreLabel = book.genre ? esc(book.genre) : 'Livre';
  const wlOn = wishlistHasId(enrichedBookStableId(book));
  const wishlistBtnHtml = `<div class="sheet-wishlist-row">
    <button type="button" id="sheet-wishlist-btn" class="wishlist-chip-btn${wlOn ? ' is-on' : ''}" aria-pressed="${wlOn ? 'true' : 'false'}">${wlOn ? '♥ En liste' : '♡ Ajouter à ma liste'}</button>
  </div>`;

  const factsHtml = buildSheetFactsStrip(book);
  const heroStatusHtml = factsHtml
    ? `<div class="sheet-hero-status">${factsHtml}</div>`
    : '';
  const readerSectionHtml = buildSheetReaderSection(book, llmPending);
  const critiqueSectionHtml = buildSheetCritiqueSection(book, llmPending);

  const blurbPlain = truncateBlurb(book.info?.description || '', 560);
  const blurbSection = blurbPlain
    ? `<details class="sheet-details sheet-details--compact">
        <summary class="sheet-details-sum">
          <span class="sheet-details-ico sheet-details-ico--doc" aria-hidden="true"></span>
          <span class="sheet-details-sum-main">
            <span class="sheet-details-sum-title">Résumé éditeur</span>
            <span class="sheet-details-sum-hint">Peut spoiler — ouvrir avec précaution</span>
          </span>
          <span class="sheet-details-chev" aria-hidden="true"></span>
        </summary>
        <div class="sheet-details-body">
          <div class="sheet-prose sheet-prose--blurb">${esc(blurbPlain)}</div>
        </div>
      </details>`
    : '';

  const R = retailSearchUrls(book.title, book.author);

  const llmBarHtml = llmPending
    ? `<div id="sheet-llm-bar" class="sheet-llm-bar sheet-llm-bar--busy" role="status" aria-live="polite"><span class="sheet-llm-spinner" aria-hidden="true"></span><span>Approfondissement IA des infos…</span></div>`
    : '<div id="sheet-llm-bar" class="sheet-llm-bar hidden" role="status" aria-live="polite"></div>';

  $('book-sheet-body').innerHTML = `
    <div class="sheet-layout">
      <header class="sheet-hero sheet-hero--compact">
        <div class="sheet-hero-copy">
          <p class="sheet-kicker">${genreLabel}</p>
          <h2 id="sheet-book-title" class="sheet-title">${esc(titleRaw)}</h2>
          ${subtitleHtml}
          <p class="sheet-byline sheet-byline--compact">Par <strong>${authorNameHtml}</strong></p>
          ${wishlistBtnHtml}
          ${heroStatusHtml}
        </div>
      </header>

      <div class="sheet-retail-block">
        <p class="sheet-cta-heading" id="sheet-retail-heading">Prix, disponibilité &amp; avis</p>
        <div class="sheet-cta-row sheet-cta-row--compact" role="group" aria-labelledby="sheet-retail-heading">
        <a class="sheet-cta sheet-cta--ghost sheet-cta--retail sheet-cta--compact" href="${R.fnac}" target="_blank" rel="noopener">
          <span class="sheet-cta-ico sheet-cta-ico--bag" aria-hidden="true"></span>
          <span class="sheet-cta-copy"><span class="sheet-cta-label">Fnac</span><span class="sheet-cta-sub">Catalogue &amp; commande</span></span>
        </a>
        <a class="sheet-cta sheet-cta--ghost sheet-cta--retail sheet-cta--compact" href="${R.amazon}" target="_blank" rel="noopener">
          <span class="sheet-cta-ico sheet-cta-ico--bag" aria-hidden="true"></span>
          <span class="sheet-cta-copy"><span class="sheet-cta-label">Amazon</span><span class="sheet-cta-sub">Prix &amp; stock FR</span></span>
        </a>
        <a class="sheet-cta sheet-cta--ghost sheet-cta--retail sheet-cta--compact" href="${R.barnes}" target="_blank" rel="noopener">
          <span class="sheet-cta-ico sheet-cta-ico--bag" aria-hidden="true"></span>
          <span class="sheet-cta-copy"><span class="sheet-cta-label">B&amp;N</span><span class="sheet-cta-sub">Recherche US</span></span>
        </a>
        <a class="sheet-cta sheet-cta--ghost sheet-cta--retail sheet-cta--compact" href="${R.senscritique}" target="_blank" rel="noopener">
          <span class="sheet-cta-ico" aria-hidden="true">★</span>
          <span class="sheet-cta-copy"><span class="sheet-cta-label">SensCritique</span><span class="sheet-cta-sub">Notes &amp; critiques</span></span>
        </a>
        </div>
      </div>

      ${llmBarHtml}

      ${readerSectionHtml}

      ${critiqueSectionHtml}

      ${blurbSection}

      <section class="sheet-panel sheet-panel--author sheet-panel--dense" aria-labelledby="sheet-author-heading">
        <div class="sheet-panel-head">
          <span class="sheet-panel-orb sheet-panel-orb--cool" aria-hidden="true"></span>
          <div class="sheet-panel-head-text">
            <h3 id="sheet-author-heading" class="sheet-panel-title">L’auteur</h3>
            <p class="sheet-panel-sub">Biographie : lien Wikipédia de l'auteur affiné par l'IA après approfondissement (si clé API) ; sinon recherche automatique. Dates et portrait : catalogues ouverts.</p>
          </div>
        </div>
        <div class="sheet-panel-body"><div id="sheet-author-mount">${sheetAuthorSkeleton()}</div></div>
      </section>

      <p class="sheet-footnote sheet-footnote--compact">Données agrégées (Wikipédia, Google Books, catalogues ouverts, IA) — à croiser.</p>
    </div>`;

  hydrateSheetAuthorZones(book, primaryAuthor(authorRaw), gen);
}

async function openBookSheetFromSimilarTitle(title, author) {
  const t = String(title || '').trim();
  const a = String(author || '').trim();
  if (!t) return;

  const sheetOpen = $('book-sheet');
  if (sheetOpen && !sheetOpen.classList.contains('hidden')) {
    pushSheetHistoryIfOpen();
  }

  bookSheetLoadGen += 1;
  const gen = bookSheetLoadGen;
  sheetDetachedBook = null;

  const info = await fetchCover(t, primaryAuthor(a) || '');
  if (gen !== bookSheetLoadGen) return;

  const resolvedTitle = String(info?.title || t).trim();
  let authorsArr = Array.isArray(info?.authors)
    ? info.authors.map(x => String(x).trim()).filter(Boolean)
    : [];
  if (!authorsArr.length && a) {
    authorsArr = a.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }
  const resolvedAuthor = authorsArr.length ? authorsArr.join(', ') : '';

  const vi = info
    ? { ...info, title: resolvedTitle || info.title, authors: authorsArr.length ? authorsArr : (info.authors || []) }
    : { title: resolvedTitle, authors: authorsArr };

  const book = {
    title: resolvedTitle,
    author: resolvedAuthor,
    info: vi,
    genre: 'Livre',
    confidence: 'medium',
    critique: '',
    _sheetLlmFetched: false,
  };

  sheetDetachedBook = book;
  const sheet = $('book-sheet');
  delete sheet.dataset.sheetBookIdx;
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  const llmPending = !!(apiKey && !book._sheetLlmFetched);
  renderSheetShell(book, gen, { llmPending });
  const scrollEl = $('book-sheet-scroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  if (llmPending) runSheetLlmEnrich(book, null, gen);
  updateBookSheetBackButton();
}

function openWishlistEntryById(id) {
  const it = wishlistItems.find(x => x.id === id);
  if (it) void openBookSheetFromWishlistItem(it);
}

async function openBookSheetFromWishlistItem(it) {
  if (!it || typeof it !== 'object' || !it.id) return;
  const snap =
    it.book &&
    typeof it.book === 'object' &&
    (String(it.book.info?.title || '').trim() || String(it.book.title || '').trim());
  const titleFallback = String(it.title || '').trim();
  if (!snap && !titleFallback) return;

  const sheetOpen = $('book-sheet');
  if (sheetOpen && !sheetOpen.classList.contains('hidden')) {
    pushSheetHistoryIfOpen();
  }

  bookSheetLoadGen += 1;
  const gen = bookSheetLoadGen;

  let book;
  if (snap) {
    book = cloneBookForSheetHistory(it.book);
  } else {
    const a = String(it.author || '').trim();
    const info = await fetchCover(titleFallback, primaryAuthor(a) || '');
    if (gen !== bookSheetLoadGen) return;
    const resolvedTitle = String(info?.title || titleFallback).trim();
    let authorsArr = Array.isArray(info?.authors)
      ? info.authors.map(x => String(x).trim()).filter(Boolean)
      : [];
    if (!authorsArr.length && a) {
      authorsArr = a.split(/[;,]/).map(s => s.trim()).filter(Boolean);
    }
    const resolvedAuthor = authorsArr.length ? authorsArr.join(', ') : '';

    const vi = info
      ? { ...info, title: resolvedTitle || info.title, authors: authorsArr.length ? authorsArr : (info.authors || []) }
      : { title: resolvedTitle, authors: authorsArr };

    book = {
      title: resolvedTitle,
      author: resolvedAuthor,
      info: vi,
      genre: 'Livre',
      confidence: 'medium',
      critique: '',
      _sheetLlmFetched: false,
    };
  }

  sheetDetachedBook = book;
  const sheet = $('book-sheet');
  delete sheet.dataset.sheetBookIdx;
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  closeWishlistModal();

  const llmPending = !!(apiKey && !book._sheetLlmFetched);
  renderSheetShell(book, gen, { llmPending });
  const scrollEl = $('book-sheet-scroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  if (llmPending) runSheetLlmEnrich(book, null, gen);
  updateBookSheetBackButton();
}

function openBookSheet(idx) {
  const book = cachedEnrichedBooks[idx];
  if (!book) return;
  const sheet = $('book-sheet');
  if (sheet && !sheet.classList.contains('hidden')) {
    const cur = parseInt(sheet.dataset.sheetBookIdx ?? '', 10);
    if (!sheetDetachedBook && Number.isFinite(cur) && cur === idx) return;
    pushSheetHistoryIfOpen();
  }
  bookSheetLoadGen += 1;
  const gen = bookSheetLoadGen;
  sheetDetachedBook = null;
  sheet.dataset.sheetBookIdx = String(idx);
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const llmPending = !!(apiKey && !book._sheetLlmFetched);
  renderSheetShell(book, gen, { llmPending });
  const scrollEl = $('book-sheet-scroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  if (llmPending) runSheetLlmEnrich(book, idx, gen);
  updateBookSheetBackButton();
}

function closeBookSheet() {
  const sheet = $('book-sheet');
  if (!sheet || sheet.classList.contains('hidden')) return;
  sheet.classList.add('hidden');
  sheet.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  delete sheet.dataset.sheetBookIdx;
  sheetDetachedBook = null;
  bookSheetHistoryStack = [];
  updateBookSheetBackButton();
  const bar = $('sheet-llm-bar');
  if (bar) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scan() {
  if (busy) return;
  if (!apiKey) { openSettings(); return; }
  const b64 = captureBase64();
  if (!b64) { setStatus('Choisissez une image (Photo ou Importer).'); return; }

  busy = true;
  scanBtn.disabled = true;
  scanBtn.setAttribute('aria-busy', 'true');
  scanBtn.classList.add('scanning');
  vp.classList.add('scanning');
  refreshScanPixelLayer();
  clearArLayer();
  expandResultsDrawer();
  setStatus('Étape 1/2 — analyse de l’image…');
  setHint('Envoi du cliché au modèle…');
  showSkeletons();

  try {
    // Phase 1 — Claude identifie et critique (1 seul appel)
    const books = await callClaude(b64, () => {
      setStatus(fastMode ? 'Réponse en cours (mode rapide)…' : 'Réception du modèle…');
    });
    if (!books.length) {
      showEmpty('Aucun livre identifié — rapprochez-vous ou améliorez la lumière');
      setStatus('Aucun livre détecté');
      setHint('Essayez un autre angle ou chargez une photo plus nette.');
      return;
    }

    // Phase 1 résultat — repères RA sur l’image ; détail dans le panneau du bas
    renderArMarkers(books);
    setStatus(`Étape 2/2 — ${books.length} livre(s), chargement des couvertures…`);
    setHint('Patience : les fiches complètes arrivent dans le panneau du bas.');

    // Phase 2 — couvertures Google Books en parallèle
    const enriched = await Promise.all(
      books.map(async b => ({ ...b, info: await fetchCover(b.title, b.author) }))
    );
    renderCards(enriched);
    patchArMarkersWithCovers(enriched);
    expandResultsDrawer();
    setStatus(`${enriched.length} livre(s) — fiches ci-dessous`);
    setHint('Touchez un livre ou un cadre orange pour ouvrir la fiche (bio auteur, autres titres…).');

  } catch (err) {
    showError(err.message || String(err));
    setStatus('Erreur — réessayez ou vérifiez la connexion');
    setHint('Vérifiez la clé API et votre réseau, puis Relancer depuis la fiche d’erreur.');
  } finally {
    busy = false;
    scanBtn.classList.remove('scanning');
    scanBtn.removeAttribute('aria-busy');
    vp.classList.remove('scanning');
    clearScanPixelLayer();
    scanBtn.disabled = false;
  }
}

function expandResultsDrawer() {
  setResultsExpanded(true);
}

function setResultsExpanded(expanded) {
  if (!resultsPanel || !resultsDrawerToggle) return;
  resultsPanel.classList.toggle('collapsed', !expanded);
  resultsDrawerToggle.setAttribute('aria-expanded', String(expanded));
  applySplitLayout();
  scheduleArReflow();
}

const CONF_DOT = { high: '#4ade80', medium: '#fbbf24', low: '#9ca3af' };

/** Accepte bbox objet, tableau [x,y,w,h], ou box_2d Gemini [y0,x0,y1,x1] en 0–1000. */
function normalizeBBox(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw) && raw.length >= 4) {
    const x = Number(raw[0]), y = Number(raw[1]), w = Number(raw[2]), h = Number(raw[3]);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) return clampBBox({ x, y, w, h });
    return null;
  }
  if (typeof raw !== 'object') return null;
  if (Array.isArray(raw.box_2d) && raw.box_2d.length >= 4) {
    const [y0, x0, y1, x1] = raw.box_2d.map(Number);
    if (![y0, x0, y1, x1].every(Number.isFinite)) return null;
    return clampBBox({
      x: x0 / 1000,
      y: y0 / 1000,
      w: Math.max(0.01, (x1 - x0) / 1000),
      h: Math.max(0.01, (y1 - y0) / 1000),
    });
  }
  const x = Number(raw.x), y = Number(raw.y), w = Number(raw.w), h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return clampBBox({ x, y, w, h });
}

function clampBBox(b) {
  let { x, y, w, h } = b;
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  w = Math.min(1, Math.max(0.015, w));
  h = Math.min(1, Math.max(0.015, h));
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  return { x, y, w, h };
}

/** Image affichée (cadrage = analyse + RA). */
function getVisibleCaptureMedia() {
  return previewEl;
}

/**
 * bbox normalisé 0–1 (coin haut-gauche du livre dans la frame analysée) → pixels dans #ar-layer.
 * Les fractions x/y/w/h correspondent aux axes de la source native (vidéo ou photo), comme après
 * drawImage plein cadre. Projette avec les dimensions source srcW×srcH et object-fit: contain (#preview).
 */
function bboxToArLayerPx(bb, srcW, srcH, mediaEl, layerEl) {
  const lr = layerEl.getBoundingClientRect();
  const mr = mediaEl.getBoundingClientRect();
  const boxW = mr.width;
  const boxH = mr.height;
  if (!srcW || !srcH || boxW < 2 || boxH < 2) return null;

  const scale = Math.min(boxW / srcW, boxH / srcH);
  const dispW = srcW * scale;
  const dispH = srcH * scale;
  const originX = mr.left - lr.left;
  const originY = mr.top - lr.top;
  const offX = (boxW - dispW) / 2;
  const offY = (boxH - dispH) / 2;

  return {
    left: originX + offX + bb.x * srcW * scale,
    top: originY + offY + bb.y * srcH * scale,
    width: bb.w * srcW * scale,
    height: bb.h * srcH * scale,
  };
}

function renderArMarkers(books) {
  lastBooksForAr = books;
  const srcW = lastSourceSize.w || lastCaptureSize.w;
  const srcH = lastSourceSize.h || lastCaptureSize.h;
  const media = getVisibleCaptureMedia();
  arLayer.innerHTML = '';
  if (!lastCaptureSize.w || !lastCaptureSize.h || !srcW || !srcH || !books?.length) {
    arLayer.classList.add('hidden');
    return;
  }

  let any = false;
  books.forEach((b, i) => {
    const bb = normalizeBBox(b.bbox);
    if (!bb) return;
    const px = bboxToArLayerPx(bb, srcW, srcH, media, arLayer);
    if (!px) return;
    any = true;
    const { left, top, width, height } = px;
    const dot = CONF_DOT[b.confidence] || '#9ca3af';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ar-marker';
    btn.dataset.bookIdx = String(i);
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.width = `${width}px`;
    btn.style.height = `${height}px`;
    btn.setAttribute('aria-label', `Livre détecté : ${b.title || 'sans titre'}`);
    btn.innerHTML = `
      <span class="ar-marker-frame" aria-hidden="true"></span>
      <span class="ar-marker-chip">
        <span class="ar-marker-dot" style="background:${dot}"></span>
        <span class="ar-marker-title">${esc(b.title || '')}</span>
      </span>`;
    arLayer.appendChild(btn);
  });

  arLayer.classList.toggle('hidden', !any);
}

function patchArMarkersWithCovers(books) {
  lastEnrichedForAr = books;
  if (arLayer.classList.contains('hidden')) return;
  books.forEach((b, i) => {
    const marker = arLayer.querySelector(`.ar-marker[data-book-idx="${i}"]`);
    if (!marker) return;
    const imgUrl = b.info?.imageLinks?.thumbnail?.replace('http:', 'https:')
      || b.info?.imageLinks?.smallThumbnail?.replace('http:', 'https:');
    if (!imgUrl) return;
    let img = marker.querySelector('.ar-marker-cover');
    if (!img) {
      img = document.createElement('img');
      img.className = 'ar-marker-cover';
      img.alt = '';
      marker.insertBefore(img, marker.firstChild);
    }
    img.src = imgUrl;
  });
}

function clearArLayer() {
  arLayer.innerHTML = '';
  arLayer.classList.add('hidden');
  lastBooksForAr = [];
  lastEnrichedForAr = [];
  lastCaptureSize = { w: 0, h: 0 };
  lastSourceSize = { w: 0, h: 0 };
}

// ── Render ────────────────────────────────────────────────────────────────────
const CONF_LABEL = { high: 'Sûr', medium: 'Probable', low: 'Incertain' };

const GENRE_COLOR = {
  'Policier':         '#3b82f6',
  'Thriller':         '#ef4444',
  'SF':               '#8b5cf6',
  'Science-fiction':  '#8b5cf6',
  'Romance':          '#ec4899',
  'Historique':       '#f59e0b',
  'Fantasy':          '#10b981',
  'Horreur':          '#dc2626',
  'Humour':           '#f97316',
  'Jeunesse':         '#06b6d4',
  'Littérature':      '#6b7280',
  'Biographie':       '#a78bfa',
};

function genreStyle(genre) {
  const c = GENRE_COLOR[genre] || '#6b7280';
  return `style="color:${c};background:${c}20;border-color:${c}40"`;
}

function stars(n) {
  const r = Math.min(5, Math.max(0, Math.round(n)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function renderCards(books) {
  cachedEnrichedBooks = books;
  resultsList.innerHTML = '';
  resultsLabel.textContent = `${books.length} livre(s)`;
  resultsPanel.classList.add('has-results');

  books.forEach((book, cardIdx) => {
    const { title, author, confidence, genre, note, critique, info } = book;
    const t     = esc(info?.title || title);
    const a     = esc(info?.authors?.join(', ') || author || 'Auteur inconnu');
    const img   = info?.imageLinks?.thumbnail?.replace('http:', 'https:');
    const pages = info?.pageCount;
    const year  = info?.publishedDate?.slice(0, 4);
    const conf  = confidence || 'medium';
    const gStr  = genre ? esc(genre) : null;
    const displayNote = note ?? info?.averageRating;
    const teaser = critique
      ? esc(critique.length > 140 ? `${critique.slice(0, 137)}…` : critique)
      : '';
    const onWl = wishlistHasId(enrichedBookStableId(book));
    const wlLabel = onWl ? 'Retirer de ma liste' : 'Ajouter à ma liste';

    const R = retailSearchUrls(title, author);

    resultsList.insertAdjacentHTML('beforeend', `
      <article class="book-card" data-book-idx="${cardIdx}" tabindex="0" role="button" aria-label="Ouvrir la fiche : ${t}">
        <div class="card-top">
          <div class="book-thumb">
            ${img ? `<img src="${img}" loading="lazy" alt="">` : '<span class="thumb-ph" aria-hidden="true"></span>'}
          </div>
          <div class="card-meta">
            <div class="card-meta-head">
              <div class="card-meta-stack">
                <div class="book-title">${t}</div>
                <div class="book-author">${a}</div>
                <div class="tag-row">
                  ${gStr ? `<span class="tag tag-genre" ${genreStyle(genre)}>${gStr}</span>` : ''}
                  ${displayNote ? `<span class="tag tag-note" title="Note publique">★ ${Number(displayNote).toFixed(1)}</span>` : ''}
                  ${year   ? `<span class="tag tag-meta">${year}</span>` : ''}
                  ${pages  ? `<span class="tag tag-meta">${pages} p.</span>` : ''}
                  <span class="tag conf-${conf}">${CONF_LABEL[conf] || conf}</span>
                </div>
                ${teaser ? `<p class="card-teaser">${teaser}</p>` : ''}
              </div>
              <button type="button" class="wishlist-card-btn${onWl ? ' is-on' : ''}" data-wishlist-card="${cardIdx}" aria-pressed="${onWl ? 'true' : 'false'}" aria-label="${esc(wlLabel)}" title="${esc(wlLabel)}">${onWl ? '♥' : '♡'}</button>
            </div>
          </div>
        </div>
        <div class="book-card-hint"><span>Fiche complète</span><span>›</span></div>
        <div class="card-footer">
          <a class="card-link fnac" href="${R.fnac}" target="_blank" rel="noopener">Fnac ↗</a>
          <a class="card-link amazon" href="${R.amazon}" target="_blank" rel="noopener">Amazon ↗</a>
          <a class="card-link barnes" href="${R.barnes}" target="_blank" rel="noopener">B&amp;N ↗</a>
          <a class="card-link" href="${R.senscritique}" target="_blank" rel="noopener">SensCritique ↗</a>
        </div>
      </article>`);
  });
  applySplitLayout();
  scheduleArReflow();
}

resultsList.addEventListener('click', e => {
  if (e.target.closest('#retry-scan-btn')) {
    scan();
    return;
  }
  const wlCard = e.target.closest('[data-wishlist-card]');
  if (wlCard) {
    e.preventDefault();
    e.stopPropagation();
    const ci = parseInt(wlCard.getAttribute('data-wishlist-card'), 10);
    const b = Number.isFinite(ci) ? cachedEnrichedBooks[ci] : null;
    if (!b) return;
    const r = wishlistToggleFromBook(b);
    if (!r.ok) {
      setHint(r.quota ? 'Stockage plein : retirez des livres de la liste ou libérez de l’espace navigateur.' : 'Impossible d’enregistrer la liste.');
      return;
    }
    refreshWishlistDependentUi();
    return;
  }
  if (e.target.closest('a.card-link')) return;
  const card = e.target.closest('.book-card');
  if (!card) return;
  const idx = parseInt(card.dataset.bookIdx, 10);
  if (Number.isFinite(idx)) openBookSheet(idx);
});

resultsList.addEventListener('keydown', e => {
  const wlBtn = e.target.closest('[data-wishlist-card]');
  if (wlBtn && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    e.stopPropagation();
    wlBtn.click();
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.book-card');
  if (!card || e.target.closest('a.card-link')) return;
  e.preventDefault();
  const idx = parseInt(card.dataset.bookIdx, 10);
  if (Number.isFinite(idx)) openBookSheet(idx);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (wishlistModal && !wishlistModal.classList.contains('hidden')) {
    closeWishlistModal();
    return;
  }
  if (!modal.classList.contains('hidden')) {
    closeSettings();
    return;
  }
  const sheet = $('book-sheet');
  if (sheet && !sheet.classList.contains('hidden')) {
    if (bookSheetHistoryStack.length) {
      popBookSheetHistory();
      return;
    }
    closeBookSheet();
    return;
  }
});

function showSkeletons(n = 3) {
  resultsLabel.textContent = 'Analyse en cours…';
  resultsPanel.classList.add('has-results');
  resultsList.innerHTML = Array(n).fill(`
    <div class="skeleton-card">
      <div class="sk" style="width:56px;height:80px;flex-shrink:0;border-radius:8px"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding-top:4px">
        <div class="sk" style="height:14px;width:65%;border-radius:5px"></div>
        <div class="sk" style="height:12px;width:40%;border-radius:5px"></div>
        <div class="sk" style="height:12px;width:55%;border-radius:5px"></div>
        <div class="sk" style="height:11px;width:90%;border-radius:5px"></div>
        <div class="sk" style="height:11px;width:75%;border-radius:5px"></div>
      </div>
    </div>`).join('');
  applySplitLayout();
  scheduleArReflow();
}

function showEmpty(msg) {
  resultsList.innerHTML = `<p class="empty-hint">${esc(msg)}</p>`;
  resultsLabel.textContent = 'Aucun résultat';
  resultsPanel.classList.remove('has-results');
  applySplitLayout();
  scheduleArReflow();
}

function showError(msg) {
  resultsPanel.classList.add('has-results');
  expandResultsDrawer();
  resultsLabel.textContent = 'Erreur';
  resultsList.innerHTML = `
    <div class="error-box">
      <p class="empty-hint error-msg">${esc(msg)}</p>
      <button type="button" class="btn-retry" id="retry-scan-btn">Réessayer</button>
    </div>`;
  applySplitLayout();
  scheduleArReflow();
}

// ── Photo (fichier / caméra native) ───────────────────────────────────────────
function loadFile(file) {
  if (!file?.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    clearArLayer();
    if (uploadedImg) URL.revokeObjectURL(previewEl.src);
    uploadedImg = img;
    previewEl.src = url;
    previewEl.classList.remove('hidden');
    viewportPhotoChrome?.classList.remove('hidden');
    viewportPhotoChrome?.setAttribute('aria-hidden', 'false');
    if (viewportEmpty) {
      viewportEmpty.classList.add('hidden');
      viewportEmpty.setAttribute('aria-hidden', 'true');
    }
    syncViewportHasPhoto();
    resetPhotoZoom();
    syncMainControlLabel();
    setStatus('Photo prête — touchez Envoyer pour analyser');
    setHint('Autre image : bouton central (appareil photo), Importer (photothèque / fichier), ou « Autre photo ». Roulette ou +/- pour zoomer.');
  };
  img.src = url;
}

function resetPhotoState() {
  if (uploadedImg) URL.revokeObjectURL(previewEl.src);
  uploadedImg = null;
  previewEl.classList.add('hidden');
  previewEl.removeAttribute('src');
  viewportPhotoChrome?.classList.add('hidden');
  viewportPhotoChrome?.setAttribute('aria-hidden', 'true');
  if (viewportEmpty) {
    viewportEmpty.classList.remove('hidden');
    viewportEmpty.setAttribute('aria-hidden', 'false');
  }
  syncViewportHasPhoto();
  resetPhotoZoom();
  syncMainControlLabel();
  clearArLayer();
  setStatus(STATUS_IDLE_NO_IMAGE);
  setHint('');
}

// ── Settings ──────────────────────────────────────────────────────────────────
function openSettings() {
  apiKeyIn.value = apiKey;
  apiKeyIn.type = 'password';
  if (toggleKeyBtn) toggleKeyBtn.textContent = 'Afficher';
  modelSel.value   = model;
  if (fastModeCheck) fastModeCheck.checked = fastMode;
  modal.classList.remove('hidden');
}

function closeSettings() {
  modal.classList.add('hidden');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Requête titre + auteur pour Fnac / Amazon / B&N / SensCritique (même logique que l’historique). */
function retailSearchUrls(title, author) {
  const raw = [title, author].filter(Boolean).join(' ');
  const q = encodeURIComponent(raw);
  return {
    fnac: `https://www.fnac.com/SearchResult/ResultList.aspx?Search=${q}&sft=1&sa=0`,
    amazon: `https://www.amazon.fr/s?k=${encodeURIComponent(raw)}`,
    barnes: `https://www.barnesandnoble.com/s/?keyword=${encodeURIComponent(raw)}`,
    senscritique: `https://www.senscritique.com/search?query=${q}`,
  };
}

function setStatus(t) {
  statusEl.textContent = t;
}

function setHint(t) {
  if (!hintLine) return;
  const s = String(t ?? '').trim();
  hintLine.textContent = s;
  if (s) {
    hintLine.hidden = false;
    hintLine.removeAttribute('aria-hidden');
  } else {
    hintLine.hidden = true;
    hintLine.setAttribute('aria-hidden', 'true');
  }
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Events ────────────────────────────────────────────────────────────────────
function onMainButtonClick() {
  if (busy) return;
  if (!uploadedImg) {
    fileInputCamera?.click();
    return;
  }
  scan();
}

scanBtn.addEventListener('click', onMainButtonClick);
resultsDrawerToggle?.addEventListener('click', () => {
  setResultsExpanded(resultsPanel.classList.contains('collapsed'));
});
uploadBtn.addEventListener('click', () => fileInputGallery?.click());
fileInputCamera?.addEventListener('change', e => { loadFile(e.target.files?.[0]); e.target.value = ''; });
fileInputGallery?.addEventListener('change', e => { loadFile(e.target.files?.[0]); e.target.value = ''; });
previewBack.addEventListener('click', resetPhotoState);
viewportEmpty?.addEventListener('click', () => { if (!busy) fileInputCamera?.click(); });
clearBtn.addEventListener('click', () => {
  if (resultsPanel.classList.contains('has-results') && resultsList.querySelector('.book-card')) {
    if (!confirm('Effacer les résultats du scan ? Votre liste de souhaits locale est conservée.')) return;
  }
  clearArLayer();
  cachedEnrichedBooks = [];
  closeBookSheet();
  showEmpty('Envoyez une photo de rayon pour découvrir les critiques');
  setStatus('Résultats effacés — Photo ou Importer pour recommencer.');
  setHint('');
});
settingsBtn.addEventListener('click', openSettings);
backdrop.addEventListener('click', closeSettings);
toggleKeyBtn?.addEventListener('click', () => {
  const show = apiKeyIn.type === 'password';
  apiKeyIn.type = show ? 'text' : 'password';
  toggleKeyBtn.textContent = show ? 'Masquer' : 'Afficher';
});
saveBtn.addEventListener('click', () => {
  apiKey   = apiKeyIn.value.trim();
  model    = modelSel.value;
  fastMode = !!(fastModeCheck && fastModeCheck.checked);
  localStorage.setItem('bl_key',      apiKey);
  localStorage.setItem('bl_model',    model);
  localStorage.setItem('bl_fast',     fastMode ? '1' : '0');
  closeSettings();
  setStatus('Paramètres enregistrés');
  setHint(uploadedImg ? 'Touchez Envoyer pour analyser cette image.' : '');
});

vp.addEventListener('dragover', e => { e.preventDefault(); vp.style.outline = '2px dashed var(--accent)'; });
vp.addEventListener('dragleave', () => { vp.style.outline = ''; });
vp.addEventListener('drop', e => { e.preventDefault(); vp.style.outline = ''; loadFile(e.dataTransfer.files?.[0]); });

arLayer.addEventListener('click', e => {
  const m = e.target.closest('.ar-marker');
  if (!m) return;
  const idx = parseInt(m.dataset.bookIdx, 10);
  expandResultsDrawer();
  if (Number.isFinite(idx) && cachedEnrichedBooks[idx]) openBookSheet(idx);
});

const arResizeRo = new ResizeObserver(() => scheduleArReflow());
arResizeRo.observe(vp);
arResizeRo.observe(arLayer);
arResizeRo.observe(previewEl);

window.visualViewport?.addEventListener('resize', () => {
  applySplitLayout();
  scheduleArReflow();
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    applySplitLayout();
    scheduleArReflow();
  }, 180);
});

initSplitPaneResize();

function initPhotoZoomHandlers() {
  if (!zoomRoot || !zoomPan || !zoomScaler) return;

  zoomRoot.addEventListener('wheel', (e) => {
    if (!vp.classList.contains('has-photo') || busy) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    nudgePhotoZoom(dir);
  }, { passive: false });

  zoomInBtn?.addEventListener('click', () => {
    if (!vp.classList.contains('has-photo') || busy) return;
    nudgePhotoZoom(1.15);
  });
  zoomOutBtn?.addEventListener('click', () => {
    if (!vp.classList.contains('has-photo') || busy) return;
    nudgePhotoZoom(1 / 1.15);
  });
  zoomResetBtn?.addEventListener('click', () => {
    if (!vp.classList.contains('has-photo') || busy) return;
    resetPhotoZoom();
  });

  zoomRoot.addEventListener('pointerdown', (e) => {
    if (!vp.classList.contains('has-photo') || busy) return;
    if (e.button !== 0) return;
    if (e.target.closest('.viewport-zoom-controls')) return;
    if (photoPinch) return;
    if (photoZoom.s <= 1.02 && photoZoom.s >= 0.98) return;
    photoDrag = {
      pid: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      tx0: photoZoom.tx,
      ty0: photoZoom.ty,
    };
    try {
      zoomRoot.setPointerCapture(e.pointerId);
    } catch (_) { /* noop */ }
  });

  zoomRoot.addEventListener('pointermove', (e) => {
    if (!photoDrag || photoDrag.pid !== e.pointerId || photoPinch) return;
    photoZoom.tx = photoDrag.tx0 + (e.clientX - photoDrag.x0);
    photoZoom.ty = photoDrag.ty0 + (e.clientY - photoDrag.y0);
    clampPhotoZoomPan();
    zoomPan.style.transform = `translate3d(${photoZoom.tx}px, ${photoZoom.ty}px, 0)`;
    scheduleArReflow();
  });

  zoomRoot.addEventListener('pointerup', endPhotoDrag);
  zoomRoot.addEventListener('pointercancel', endPhotoDrag);

  function pinchDist(t0, t1) {
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.hypot(dx, dy);
  }

  zoomRoot.addEventListener('touchstart', (e) => {
    if (!vp.classList.contains('has-photo') || busy) return;
    if (e.touches.length === 2) {
      photoTouchPan = null;
      const d0 = pinchDist(e.touches[0], e.touches[1]);
      photoPinch = {
        d0: Math.max(8, d0),
        s0: photoZoom.s,
        tx0: photoZoom.tx,
        ty0: photoZoom.ty,
      };
      photoDrag = null;
      return;
    }
    if (e.touches.length === 1 && !photoPinch && (photoZoom.s > 1.02 || photoZoom.s < 0.98)) {
      const t = e.touches[0];
      photoTouchPan = {
        x0: t.clientX,
        y0: t.clientY,
        tx0: photoZoom.tx,
        ty0: photoZoom.ty,
      };
    }
  }, { passive: true });

  zoomRoot.addEventListener('touchmove', (e) => {
    if (photoPinch && e.touches.length === 2) {
      e.preventDefault();
      const d = Math.max(4, pinchDist(e.touches[0], e.touches[1]));
      photoZoom.s = Math.min(PHOTO_ZOOM_MAX, Math.max(PHOTO_ZOOM_MIN, photoPinch.s0 * (d / photoPinch.d0)));
      photoZoom.tx = photoPinch.tx0;
      photoZoom.ty = photoPinch.ty0;
      clampPhotoZoomPan();
      applyPhotoZoom();
      return;
    }
    if (photoTouchPan && e.touches.length === 1 && !photoPinch) {
      e.preventDefault();
      const t = e.touches[0];
      photoZoom.tx = photoTouchPan.tx0 + (t.clientX - photoTouchPan.x0);
      photoZoom.ty = photoTouchPan.ty0 + (t.clientY - photoTouchPan.y0);
      clampPhotoZoomPan();
      applyPhotoZoom();
    }
  }, { passive: false });

  zoomRoot.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) photoPinch = null;
    if (e.touches.length === 0) photoTouchPan = null;
  });
  zoomRoot.addEventListener('touchcancel', () => {
    photoPinch = null;
    photoTouchPan = null;
  });

  const zro = new ResizeObserver(() => {
    clampPhotoZoomPan();
    applyPhotoZoom();
  });
  zro.observe(zoomRoot);
}

initPhotoZoomHandlers();

document.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

$('book-sheet-backdrop')?.addEventListener('click', closeBookSheet);
$('book-sheet-close')?.addEventListener('click', closeBookSheet);
$('book-sheet-back')?.addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  popBookSheetHistory();
});

$('book-sheet')?.addEventListener('click', async e => {
  const mini = e.target.closest('[data-more-title]');
  if (mini && mini.closest('#sheet-reader-host')) {
    e.preventDefault();
    const title = mini.getAttribute('data-more-title') || '';
    const author = mini.getAttribute('data-more-author') || '';
    await openBookSheetFromSimilarTitle(title, author);
    return;
  }
  if (!e.target.closest('#sheet-wishlist-btn')) return;
  const book = getSheetBook();
  if (!book) return;
  const r = wishlistToggleFromBook(book);
  if (!r.ok) {
    setHint(r.quota ? 'Stockage plein : retirez des livres de la liste ou libérez de l’espace navigateur.' : 'Impossible d’enregistrer la liste.');
    return;
  }
  patchSheetWishlistButton();
  updateWishlistHeaderBadge();
  renderWishlistPanelBody();
  if (resultsPanel?.classList.contains('has-results') && cachedEnrichedBooks?.length) {
    renderCards(cachedEnrichedBooks);
    patchArMarkersWithCovers(cachedEnrichedBooks);
  }
});

wishlistBtn?.addEventListener('click', () => openWishlistModal());
wishlistBackdrop?.addEventListener('click', () => closeWishlistModal());
wishlistClearAll?.addEventListener('click', () => {
  if (!wishlistItems.length) return;
  if (!confirm('Vider toute la liste de souhaits ? Cette action est indépendante des résultats de scan.')) return;
  wishlistItems = [];
  const r = wishlistPersist();
  if (!r.ok) {
    setHint('Impossible de mettre à jour le stockage local.');
    return;
  }
  refreshWishlistDependentUi();
});

wishlistBody?.addEventListener('click', e => {
  const rm = e.target.closest('[data-wishlist-remove]');
  if (rm) {
    const id = decodeURIComponent(rm.getAttribute('data-wishlist-remove') || '');
    if (!id) return;
    wishlistItems = wishlistItems.filter(x => x.id !== id);
    const r = wishlistPersist();
    if (!r.ok) {
      wishlistReloadFromDisk();
      setHint('Impossible de mettre à jour le stockage local.');
      return;
    }
    refreshWishlistDependentUi();
    return;
  }
  const row = e.target.closest('[data-wishlist-open]');
  if (!row) return;
  const openId = decodeURIComponent(row.getAttribute('data-wishlist-open') || '');
  if (!openId) return;
  openWishlistEntryById(openId);
});

wishlistBody?.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const row = e.target.closest('[data-wishlist-open]');
  if (!row || e.target.closest('[data-wishlist-remove]')) return;
  e.preventDefault();
  const openId = decodeURIComponent(row.getAttribute('data-wishlist-open') || '');
  if (openId) openWishlistEntryById(openId);
});

window.addEventListener('storage', e => {
  if (e.key !== WISHLIST_STORAGE_KEY) return;
  if (e.newValue == null) wishlistItems = [];
  else wishlistApplyFromJsonString(e.newValue);
  refreshWishlistDependentUi();
});
