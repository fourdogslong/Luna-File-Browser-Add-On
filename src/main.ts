import { durationText, filterFiles, kindOf, midiFingerprint as parseMidiFingerprint, midiSimilarity, type BrowserFile, type MidiFingerprint } from './logic';

const $ = <T extends HTMLElement = HTMLElement>(id: string, _type?: { new(): T }): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};
const FAV_KEY = 'com.mathieu.luna-sound-browser.favorites.v1';
const COLOR_KEY = 'com.mathieu.luna-sound-browser.file-colors.v1';
const SETTINGS_KEY = 'com.mathieu.luna-sound-browser.settings.v1';
const SESSION_STORE_NAME = 'com.mathieu.production-browser';
// Keep this list aligned with formats LUNA can import. M4A may contain AAC or ALAC.
const AUDIO_EXT = /\.(wav|aif|aiff|mp3|m4a|aac|caf|flac)$/i;
const LUNA_PALETTE = ['#e5b747','#8c6245','#cc594f','#9060a8','#5d75bd','#42a5b5','#76a74f','#9a9a9a'];
const METRONOME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 21h10l-2.4-15h-5.2L7 21Z"/><path d="M9.2 17.5h5.6M12 16.8 16.8 8M12 16.8V5"/><circle cx="12" cy="16.8" r="1"/></svg>';
let luna: Luna.Client;
let session: Luna.Session | undefined;
let currentFolder = '';
let loadedFolder = '';
let files: BrowserFile[] = [];
let recursiveFiles: BrowserFile[] = [];
let visibleFiles: BrowserFile[] = [];
let listScrollFrame = 0;
let selected: BrowserFile | undefined;
let view = 'All';
let favoriteOnly = false;
let favorites = new Set<string>();
let browserStore: ReturnType<Luna.Session['storage']['context']> | undefined;
let sessionStateWrite = Promise.resolve();
let fileColors: Record<string, string> = {};
try { fileColors = JSON.parse(localStorage.getItem(COLOR_KEY) ?? '{}') as Record<string, string>; } catch { /* Ignore damaged color metadata. */ }
function normalizeFileColors(): void {
  const rgb = (hex: string) => { const value = Number.parseInt(hex.replace('#', ''), 16); return [(value >> 16) & 255, (value >> 8) & 255, value & 255]; };
  for (const [path, color] of Object.entries(fileColors)) {
    if (LUNA_PALETTE.includes(color)) continue;
    const source = rgb(color);
    fileColors[path] = LUNA_PALETTE.reduce((closest, candidate) => {
      const candidateRgb = rgb(candidate), closestRgb = rgb(closest);
      const distance = candidateRgb.reduce((sum, channel, index) => sum + (channel - source[index]) ** 2, 0);
      const closestDistance = closestRgb.reduce((sum, channel, index) => sum + (channel - source[index]) ** 2, 0);
      return distance < closestDistance ? candidate : closest;
    }, LUNA_PALETTE[0]);
  }
}
normalizeFileColors();
localStorage.removeItem('com.mathieu.luna-sound-browser.tags.v1');
localStorage.removeItem('com.mathieu.luna-sound-browser.tag-definitions.v1');
let settings = { autoplay: false, loop: false, syncSessionTempo: false, previewPath: false, accent: '#e5b747', background: 'default', interfaceZoom: 1, ignoreTypes: '', ignoreFolders: '', showEmpty: true, previewVolume: .8, stopPreviewOnAdd: true, doubleClickImport: true, singleExpand: false, includeSubfolders: false, similarCurrentFolderOnly: false, placesSize: 0, previewSize: 0 };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
  if (typeof saved.showEmpty !== 'boolean' && typeof saved.hideEmpty === 'boolean') saved.showEmpty = !saved.hideEmpty;
  delete saved.hideEmpty; delete saved.hidePresetCategories; delete saved.tagTiles;
  for (const obsolete of ['fullPaths','placesMode','folderRecursive','pluginIcons','resultsSize','foldersSearch','indexFolder','textSize','userPresetsOnly','temporaryPreview','dontShowPreviewConfirm','categoryTiles','showPresetCategories','showNonUadPlugins','previewWithTrackPlugins']) delete saved[obsolete];
  settings = { ...settings, ...(saved as Partial<typeof settings>) };
  if (!LUNA_PALETTE.includes(settings.accent)) settings.accent = LUNA_PALETTE[0];
  if (!['default', 'light', 'dark'].includes(settings.background)) settings.background = 'default';
  settings.interfaceZoom = Math.max(.8, Math.min(1.2, Number(settings.interfaceZoom) || 1));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
} catch { /* Ignore damaged settings. */ }
try { favorites = new Set<string>(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as string[]); } catch { /* Ignore a damaged local favorites record. */ }
let midiPreviewClip: Luna.Clip | undefined;
let midiPreviewEnabled = false;
let midiPreviewUndoFallback = false;
let midiPreviewPath = '';
let midiPreviewPlayhead: number | undefined;
let midiPreviewLoop: { start: number; stop: number; enabled: boolean } | undefined;
let midiPreviewCleanupInProgress = false;
let previewTempoRelease: Luna.Unsubscribe | undefined;
let doubleClickImportPath: string | undefined;
let spaceShortcutInstalled = false;
let waveformGeneration = 0;
const WAVEFORM_CACHE_LIMIT = 64;
const waveformCache = new Map<string, { peaks: number[]; info: ReturnType<typeof audioHeaderInfo>; channels: number; duration: number }>();
const mediaUrlCache = new Map<string, string>();
type AudioFingerprint = { spectrum: number[]; envelope: number[]; character: number[] };
const soundFeatures = new Map<string, AudioFingerprint>();
const soundDurations = new Map<string, number>();
const midiFeatureCacheKey = 'com.mathieu.luna-sound-browser.midi-features.v1';
const MIDI_FEATURE_CACHE_LIMIT = 2_000;
const midiFeatures = new Map<string, MidiFingerprint>();
try {
  const saved = JSON.parse(localStorage.getItem(midiFeatureCacheKey) ?? '{}') as Record<string, MidiFingerprint>;
  for (const [path, fingerprint] of Object.entries(saved)) if (Array.isArray(fingerprint.pitchClasses) && Array.isArray(fingerprint.intervals) && Array.isArray(fingerprint.onsetGaps) && Array.isArray(fingerprint.noteLengths) && Array.isArray(fingerprint.beatPositions)) midiFeatures.set(path, fingerprint);
} catch { /* Rebuild a damaged MIDI feature cache. */ }
const fftCos = Float32Array.from({ length: 128 * 256 }, (_, index) => Math.cos(2 * Math.PI * Math.floor(index / 256 + 1) * (index % 256) / 256));
const fftSin = Float32Array.from({ length: 128 * 256 }, (_, index) => Math.sin(2 * Math.PI * Math.floor(index / 256 + 1) * (index % 256) / 256));
let sessionReleases: Luna.Unsubscribe[] = [];
const placeChildren = new Map<string, string[]>();
const collapsedFolders = new Set<string>();
const knownFolders = new Set<string>();
const loadedFolderListings = new Set<string>();
const folderListingPromises = new Map<string, Promise<void>>();
let treeScanGeneration = 0;
let treeScanPromise: Promise<BrowserFile[]> | undefined;
let treeScanPath = '';
let folderSearchScanPromise: Promise<void> | undefined;
const folderHasContent = new Map<string, boolean>();
let similarMatches: Array<{ file: BrowserFile; score: number }> = [];
let similarReferencePath = '';
let similarSelectionGeneration = 0;
let similarReferenceFile: BrowserFile | undefined;
let similarAnalysisAbort: AbortController | undefined;
let similarAnalysisContext: AudioContext | undefined;
let similarAnalysisGeneration = 0;
let similarAnalysisFolderPath = '';
let similarPaneOpen = false;
let metadataIndexGeneration = 0;
let metadataIndexAbort: AbortController | undefined;
let filterMetadata = new Map<string, { rate?: number; bits?: number; channels?: number; bpm?: number }>();
const fileTempoCache = new Map<string, number | null>();
const fileTempoPromises = new Map<string, Promise<number | undefined>>();
const metadataCacheKey = 'com.mathieu.luna-sound-browser.file-metadata.v1';
try { const saved = JSON.parse(localStorage.getItem(metadataCacheKey) ?? '{}') as Record<string, { rate?: number; bits?: number; channels?: number; bpm?: number }>; for (const [path, metadata] of Object.entries(saved)) filterMetadata.set(path, metadata); } catch { /* Rebuild a damaged metadata cache. */ }
const featureCacheKey = 'com.mathieu.luna-sound-browser.sound-features.v2';
try {
  const saved = JSON.parse(localStorage.getItem(featureCacheKey) ?? '{}') as Record<string, AudioFingerprint>;
  for (const [path, fingerprint] of Object.entries(saved)) if (Array.isArray(fingerprint.spectrum) && Array.isArray(fingerprint.envelope) && Array.isArray(fingerprint.character)) soundFeatures.set(path, fingerprint);
} catch { /* Rebuild a damaged feature cache. */ }
try { localStorage.removeItem('com.mathieu.luna-sound-browser.sound-features.v1'); } catch { /* The obsolete signature cache is optional to remove. */ }
const durationCacheKey = 'com.mathieu.luna-sound-browser.sound-durations.v1';
try { const saved = JSON.parse(localStorage.getItem(durationCacheKey) ?? '{}') as Record<string, number>; for (const [path, duration] of Object.entries(saved)) if (Number.isFinite(duration) && duration > 0) soundDurations.set(path, duration); } catch { /* Rebuild a damaged duration cache. */ }
const keep = (fn: Luna.Unsubscribe) => sessionReleases.push(fn);
const say = (message: string, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
type BrowserStoredState = { fileFavorites: string[]; fileColors?: Record<string, string> };
function browserStoredState(): BrowserStoredState { return { fileFavorites: [...favorites], fileColors }; }
function persistBrowserState(): void {
  const value = browserStoredState();
  try { localStorage.setItem(FAV_KEY, JSON.stringify(value.fileFavorites)); localStorage.setItem(COLOR_KEY, JSON.stringify(value.fileColors)); } catch { /* Keep the current state in memory when browser storage is unavailable. */ }
  const target = browserStore;
  if (!target) return;
  sessionStateWrite = sessionStateWrite.catch(() => undefined).then(async () => {
    await target.load();
    if (target.value<BrowserStoredState>('browser', 'state').value === undefined) await target.add('browser', 'state', value);
    else await target.set('browser', 'state', value);
  }).catch((error) => say(`Could not save favorites to this LUNA session: ${String((error as Error).message ?? error)}`, true));
}
async function loadBrowserState(active: Luna.Session): Promise<void> {
  try {
    await active.storage.load();
    browserStore = active.storage.context(SESSION_STORE_NAME);
    await browserStore.load();
    const stored = browserStore.value<BrowserStoredState>('browser', 'state').value;
    if (stored) {
      favorites = new Set([...favorites, ...(stored.fileFavorites ?? [])]);
      fileColors = { ...fileColors, ...(stored.fileColors ?? {}) };
      normalizeFileColors();
      persistBrowserState();
      renderList();
    } else persistBrowserState();
  } catch { browserStore = undefined; /* localStorage remains a fallback when session storage is unavailable. */ }
}
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
function isWithinFolder(path: string, folder: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  const normalizedPath = normalize(path);
  const normalizedFolder = normalize(folder) || '/';
  if (normalizedFolder === '/') return normalizedPath.startsWith('/');
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}
function previewFolderPath(path: string): string {
  const place = (luna.gui.blessedFolders.value ?? []).filter((root) => { const normalized = root.replace(/[\\/]+$/, ''); return path.startsWith(normalized + '/') || path.startsWith(normalized + '\\'); }).sort((a, b) => b.length - a.length)[0];
  if (!place) return basename(currentFolder);
  const normalized = place.replace(/[\\/]+$/, '');
  const relative = path.slice(normalized.length).replace(/^[\\/]+/, '').split(/[\\/]/).slice(0, -1).join('/');
  return [basename(place), relative].filter(Boolean).join('/');
}


function selectedTrack(): Luna.Track | undefined {
  if (!session) return undefined;
  const focus = session.context.lastSelectedTrack.value;
  const ids = session.context.selectionTracks.value ?? [];
  return (focus ? session.tracks.byId(focus) : undefined) ?? ids.map((id) => session!.tracks.byId(id)).find(Boolean);
}
function updateCounts(): void { /* Counts are intentionally omitted in the compact browser layout. */ }
type IgnoreFolderRule = string;
let ignoreFolderRulesSource = '';
let ignoreFolderRulesCache: IgnoreFolderRule[] = [];
function ignoredFolderRules(): IgnoreFolderRule[] {
  if (ignoreFolderRulesSource === settings.ignoreFolders) return ignoreFolderRulesCache;
  const rules = settings.ignoreFolders.split(',').map(normalizeFolderName).filter(Boolean);
  ignoreFolderRulesSource = settings.ignoreFolders; ignoreFolderRulesCache = rules; return rules;
}
function normalizeFolderName(name: string): string { return name.trim().replace(/\u00a0/g, ' ').normalize('NFC').toLocaleLowerCase(); }
function isIgnoredFolder(name: string): boolean { const normalized = normalizeFolderName(name); return ignoredFolderRules().some((word) => normalized.includes(word)); }
function isIgnoredFolderPath(path: string): boolean {
  const roots = (luna.gui.blessedFolders.value ?? []).filter((folder) => isWithinFolder(path, folder)).sort((a, b) => b.length - a.length);
  const root = roots[0];
  if (!root) return isIgnoredFolder(basename(path));
  const relative = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  return [basename(root), ...relative].some(isIgnoredFolder);
}
function renderFolders(): void {
  const root = $('folders');
  const roots = (luna.gui.blessedFolders.value ?? []).filter((path) => !isIgnoredFolder(basename(path)));
  const query = $('foldersearch', HTMLInputElement).value.trim().toLocaleLowerCase();
  root.replaceChildren();
  root.classList.remove('single');
  if (!roots.length) { root.innerHTML = '<div class="empty">Add a sound folder to browse your library.</div>'; return; }
  const subtreeMatches = (path: string, ancestry = new Set<string>()): boolean => {
    if (ancestry.has(path)) return false;
    if (basename(path).toLocaleLowerCase().includes(query)) return true;
    const next = new Set(ancestry); next.add(path);
    return (placeChildren.get(path) ?? []).some((child) => subtreeMatches(child, next));
  };
  const draw = (path: string, depth: number, ancestry = new Set<string>()): void => {
    if (depth > 64 || ancestry.has(path)) return;
    const nextAncestry = new Set(ancestry); nextAncestry.add(path);
    if (!settings.showEmpty && folderHasContent.get(path) === false) return;
    if (query && !subtreeMatches(path)) return;
    const matches = !query || basename(path).toLocaleLowerCase().includes(query);
    const item = document.createElement('div'); item.className = `folder${currentFolder === path ? ' active' : ''}${depth ? ' folderchild' : ''}${query && !matches ? ' search-context' : ''}`;
    item.tabIndex = 0; item.setAttribute('role', 'treeitem');
    const label = basename(path);
    item.style.marginLeft = `${Math.min(depth, 8) * 8}px`;
    const children = placeChildren.get(path) ?? [];
    item.dataset.path = path;
    item.innerHTML = `<button class="foldertoggle${children.length ? '' : ' no-children'}" aria-label="${collapsedFolders.has(path) ? 'Expand' : 'Collapse'} folder" title="${collapsedFolders.has(path) ? 'Expand' : 'Collapse'}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" transform="${collapsedFolders.has(path) ? 'rotate(-90 6 6)' : ''}"/></svg></button><span class="folderglyph" style="color:var(--active)">▰</span><span class="folderpath" title="${esc(path)}">${esc(label)}</span>`;
    item.querySelector('.foldertoggle')!.addEventListener('click', (event) => { event.stopPropagation(); if (collapsedFolders.has(path)) { if (settings.singleExpand) { const parent = [...placeChildren.entries()].find(([, children]) => children.includes(path))?.[0]; const siblings = parent ? placeChildren.get(parent) ?? [] : roots; for (const sibling of siblings) if (sibling !== path) collapsedFolders.add(sibling); const collapseDescendants = (parentPath: string) => { for (const childPath of placeChildren.get(parentPath) ?? []) { collapsedFolders.add(childPath); collapseDescendants(childPath); } }; for (const child of children) collapseDescendants(child); let ancestor = parent; while (ancestor) { collapsedFolders.delete(ancestor); ancestor = [...placeChildren.entries()].find(([, children]) => children.includes(ancestor!))?.[0] ?? ''; } } collapsedFolders.delete(path); if (!loadedFolderListings.has(path)) void loadPlaceChildren(path); } else collapsedFolders.add(path); renderFolders(); });
    item.onclick = () => { currentFolder = path; void loadFolder(path, false).then(() => focusFolderRow(path)); };
    item.ondblclick = () => { currentFolder = path; void loadFolder(path, false).then(() => focusFolderRow(path)); };
    item.oncontextmenu = (event) => { event.preventDefault(); showFolderContext(event as MouseEvent, path); };
    root.append(item);
    if (query || !collapsedFolders.has(path)) for (const child of children) draw(child, depth + 1, nextAncestry);
  };
  for (const path of roots) draw(path, 0);
  if (query && !root.children.length) root.innerHTML = '<div class="empty">No matching folders.</div>';
}

async function loadPlaceChildren(path: string): Promise<void> {
  const inFlight = folderListingPromises.get(path);
  if (inFlight) return inFlight;
  const request = (async () => {
    const entries = await luna.gui.listFiles(path);
    const children = entries.filter((entry) => entry.isDirectory && !isIgnoredFolder(entry.name)).map((entry) => entry.path);
    placeChildren.set(path, children); loadedFolderListings.add(path);
    for (const child of children) { if (!knownFolders.has(child)) collapsedFolders.add(child); knownFolders.add(child); }
    const ignoredTypes = new Set(settings.ignoreTypes.split(',').map((ext) => ext.trim().replace(/^\./, '').toLocaleLowerCase()).filter(Boolean));
    folderHasContent.set(path, children.length > 0 || entries.some((entry) => !entry.isDirectory && !ignoredTypes.has(entry.name.split('.').pop()?.toLocaleLowerCase() ?? '') && (AUDIO_EXT.test(entry.name) || /\.(mid|midi)$/i.test(entry.name))));
    renderFolders();
  })().finally(() => folderListingPromises.delete(path));
  folderListingPromises.set(path, request);
  return request;
}

async function scanTree(path: string): Promise<BrowserFile[]> {
  const ignoredTypes = new Set(settings.ignoreTypes.split(',').map((ext) => ext.trim().replace(/^\./, '').toLocaleLowerCase()).filter(Boolean));
  const pending = [path];
  const visited = new Set<string>();
  const output: BrowserFile[] = [];
  const unreadable: string[] = [];
  const workers = Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const folder = pending.shift()!;
      if (visited.has(folder)) continue;
      visited.add(folder);
      let entries: BrowserFile[];
      try { entries = await luna.gui.listFiles(folder); }
      catch { unreadable.push(folder); placeChildren.set(folder, []); folderHasContent.set(folder, false); continue; }
      const dirs = entries.filter((entry) => entry.isDirectory && !isIgnoredFolder(entry.name));
      placeChildren.set(folder, dirs.map((entry) => entry.path));
      loadedFolderListings.add(folder);
      for (const dir of dirs) {
        if (!knownFolders.has(dir.path)) collapsedFolders.add(dir.path);
        knownFolders.add(dir.path);
        if (!visited.has(dir.path)) pending.push(dir.path);
      }
      output.push(...entries.filter((entry) => !entry.isDirectory && !ignoredTypes.has(entry.name.split('.').pop()?.toLocaleLowerCase() ?? '') && (AUDIO_EXT.test(entry.name) || /\.(mid|midi)$/i.test(entry.name))));
      folderHasContent.set(folder, dirs.length > 0 || entries.some((entry) => !entry.isDirectory && !ignoredTypes.has(entry.name.split('.').pop()?.toLocaleLowerCase() ?? '') && (AUDIO_EXT.test(entry.name) || /\.(mid|midi)$/i.test(entry.name))));
    }
  });
  await Promise.all(workers);
  if (unreadable.length) say(`Some folders could not be searched (${unreadable.length}); check LUNA folder access.`, true);
  return output;
}
function ensureTreeScan(path: string): Promise<BrowserFile[]> {
  if (treeScanPath === path && treeScanPromise) return treeScanPromise;
  const generation = ++treeScanGeneration;
  treeScanPath = path;
  treeScanPromise = scanTree(path).then((items) => {
    if (generation === treeScanGeneration && currentFolder === path) {
      recursiveFiles = items; renderFolders();
      if (settings.includeSubfolders) { renderList(); revealSelectedFileInList(); }
    }
    return items;
  });
  return treeScanPromise;
}

async function loadFolder(path: string, enter = true, expandFolder = true): Promise<void> {
  const restartSimilar = similarAnalysisAbort && similarAnalysisFolderPath !== path ? similarReferenceFile : undefined;
  if (restartSimilar) { cancelSimilarAnalysis(); $('simlabel').textContent = `SCANNING ${basename(path)}`.toLocaleUpperCase(); }
  const selectedBeforeLoad = settings.includeSubfolders && selected && isWithinFolder(selected.path, path) ? selected : undefined;
  try {
    if (!(await luna.gui.available())) { say('Folder browsing is available inside LUNA.', true); return; }
    const entries = await luna.gui.listFiles(path);
    const ignoredTypes = new Set(settings.ignoreTypes.split(',').map((ext) => ext.trim().replace(/^\./, '').toLocaleLowerCase()).filter(Boolean));
      files = entries.filter((entry) => entry.isDirectory ? !isIgnoredFolder(entry.name) : !ignoredTypes.has(entry.name.split('.').pop()?.toLocaleLowerCase() ?? '') && (AUDIO_EXT.test(entry.name) || /\.(mid|midi)$/i.test(entry.name)));
    recursiveFiles = [];
    ++treeScanGeneration; treeScanPromise = undefined; treeScanPath = '';
    placeChildren.set(path, entries.filter((entry) => entry.isDirectory && !isIgnoredFolder(entry.name)).map((entry) => entry.path));
    loadedFolderListings.add(path);
    const collapseDescendants = (parent: string, seen = new Set<string>()) => {
      if (seen.has(parent)) return;
      seen.add(parent);
      for (const child of placeChildren.get(parent) ?? []) { collapsedFolders.add(child); collapseDescendants(child, seen); }
    };
    if (expandFolder) {
      collapsedFolders.delete(path);
      collapseDescendants(path);
    }
    folderHasContent.set(path, entries.some((entry) => !entry.isDirectory && !ignoredTypes.has(entry.name.split('.').pop()?.toLowerCase() ?? '') && (AUDIO_EXT.test(entry.name) || /\.(mid|midi)$/i.test(entry.name))) || entries.some((entry) => entry.isDirectory && !isIgnoredFolder(entry.name)));
    
    currentFolder = path;
    loadedFolder = path;
    selected = selectedBeforeLoad ?? restartSimilar;
    $('resultcount').textContent = `${files.length} sounds · ${basename(path)}`;
    renderList(); renderFolders(); updateCounts();
    if (!selected) void renderSound();
    else if (restartSimilar) void renderSound();
    if (settings.includeSubfolders || $('foldersearch', HTMLInputElement).value.trim()) void ensureTreeScan(path).catch((e) => say(`Could not scan subfolders: ${String((e as Error).message ?? e)}`, true));
      if (!files.length) say(`Folder opened · no audio or MIDI files in ${basename(path)}`); else say(`Browsing ${basename(path)} · ${files.length} items`);
    if (restartSimilar) void renderSimilar(restartSimilar, path);
  } catch (e) {
    const code = (e as Luna.Error)?.code;
    const reason = code === 'uasrv.not_permitted' ? 'LUNA has not granted this Add On access. Choose the folder again and approve the access prompt.' : String((e as Error).message ?? e);
    say(`Could not open ${basename(path)}: ${reason}`, true);
  }
}
async function selectPlace(path: string, expandSelected = true): Promise<void> {
  const ancestors: string[] = [];
  let cursor = path;
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor); ancestors.unshift(cursor);
    const parent = [...placeChildren.entries()].find(([, children]) => children.includes(cursor))?.[0];
    if (!parent) break;
    cursor = parent;
  }
  for (const ancestor of (expandSelected ? ancestors : ancestors.slice(0, -1))) collapsedFolders.delete(ancestor);
  currentFolder = path;
  renderFolders();
  await loadFolder(path, false, expandSelected);
  const row = [...$('folders').querySelectorAll<HTMLElement>('.folder')].find((item) => item.dataset.path === path);
  row?.scrollIntoView({ block: 'nearest' });
  focusFolderRow(path);
}
function focusFolderRow(path: string): void {
  [...$('folders').querySelectorAll<HTMLElement>('.folder[data-path]')].find((item) => item.dataset.path === path)?.focus({ preventScroll: true });
}
async function addFolder(): Promise<void> {
  try {
    if (!luna || !luna.gui) { say('LUNA is still connecting. Try Add Folder again in a moment.', true); return; }
    if (!(await luna.gui.available())) { say('Add Folder is available inside LUNA.', true); return; }
    await luna.gui.watchBlessedFolders();
    say('Choose a folder in LUNA…');
    const paths = await luna.gui.chooseFolders({ title: 'Choose a sound folder', allowMultiple: true });
    if (!paths.length) { say('Folder selection cancelled.'); return; }
    const readable: string[] = [];
    const rejected: string[] = [];
    for (const path of paths) {
      try {
        if (!isBlessedPath(path)) await luna.gui.addBlessedFolder(path);
        if (!isBlessedPath(path) && !await waitForBlessedPath(path)) { rejected.push(basename(path)); continue; }
        await luna.gui.listFiles(path);
        readable.push(path);
      } catch (error) { rejected.push(`${basename(path)} (${String((error as Error).message ?? error)})`); }
    }
    const path = readable[0];
    renderFolders();
    if (!path) { say(rejected.length ? `LUNA did not grant access to: ${rejected.join(', ')}. Add the folder in LUNA Settings › Add Ons › Folders and try again.` : 'No folder was added.', true); return; }
    const blessed = luna.gui.blessedFolders.value ?? [];
    for (const root of blessed) { knownFolders.add(root); if (!collapsedFolders.has(root) && root !== path) collapsedFolders.add(root); }
    await loadFolder(path);
    if (rejected.length) say(`Added ${readable.length} folder${readable.length === 1 ? '' : 's'}; access was not granted to ${rejected.join(', ')}.`, true);
  } catch (e) { say(`Add Folder failed: ${String((e as Error).message ?? e)}`, true); }
}
async function removePlace(path: string): Promise<void> {
  if (!luna?.gui || !(luna.gui.blessedFolders.value ?? []).includes(path)) return;
  try {
    await luna.gui.removeBlessedFolder(path);
    const rootPath = path.replace(/[\\/]+$/, '');
    const isInside = (candidate: string) => candidate === path || candidate.startsWith(`${rootPath}/`) || candidate.startsWith(`${rootPath}\\`);
    for (const key of [...placeChildren.keys()]) if (isInside(key)) placeChildren.delete(key);
    for (const key of [...loadedFolderListings]) if (isInside(key)) loadedFolderListings.delete(key);
    for (const key of [...folderHasContent.keys()]) if (isInside(key)) folderHasContent.delete(key);
    if (selected && isInside(selected.path)) { selected = undefined; await renderSound(); }
    if (isInside(currentFolder)) {
      currentFolder = (luna.gui.blessedFolders.value ?? [])[0] ?? '';
      if (currentFolder) await loadFolder(currentFolder);
      else { files = []; recursiveFiles = []; selected = undefined; renderList(); await renderSound(); }
    }
    renderFolders(); say(`Removed ${basename(path)} from Places.`);
  } catch (e) { say(`Could not remove ${basename(path)} from Places: ${String((e as Error).message ?? e)}`, true); }
}
function isBlessedPath(path: string): boolean {
  const roots = luna?.gui?.blessedFolders.value ?? [];
  return roots.some((root) => path === root || path.startsWith(`${root.replace(/[\\/]+$/, '')}/`) || path.startsWith(`${root.replace(/[\\/]+$/, '')}\\`));
}
function waitForBlessedPath(path: string, timeoutMs = 30000): Promise<boolean> {
  if (isBlessedPath(path)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: Luna.Unsubscribe = () => undefined;
    const finish = (granted: boolean) => { if (settled) return; settled = true; clearTimeout(timer); unsubscribe(); resolve(granted); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = luna.gui.blessedFolders.onChange(() => { if (isBlessedPath(path)) finish(true); });
    if (isBlessedPath(path)) finish(true);
  });
}
function rowIcon(file: BrowserFile): string { return file.isDirectory ? '▰' : kindOf(file) === 'MIDI' ? '⌘' : '♫'; }
function selectedFilterValue(group: string): string { return document.querySelector<HTMLButtonElement>(`[data-filter-group="${group}"][aria-pressed="true"]`)?.dataset.value ?? ''; }
function selectedChannelFilters(): string[] { return [...document.querySelectorAll<HTMLButtonElement>('[data-filter-channel][aria-pressed="true"]')].map((button) => button.dataset.filterChannel ?? ''); }
function selectedColorFilters(): string[] { return [...document.querySelectorAll<HTMLButtonElement>('[data-filter-color][aria-pressed="true"]')].map((button) => button.dataset.filterColor ?? ''); }
function hasAudioMetadataFilter(): boolean { return Boolean(selectedFilterValue('rate') || selectedFilterValue('bits') || selectedChannelFilters().length); }
function updateFilterButtonIndicator(): void {
  const active = view !== 'All' || favoriteOnly || Boolean(selectedFilterValue('format') || selectedFilterValue('rate') || selectedFilterValue('bits') || selectedChannelFilters().length || selectedColorFilters().length);
  $('clearfilters').hidden = !active;
}
function currentFileCandidates(): readonly BrowserFile[] {
  return settings.includeSubfolders && recursiveFiles.length ? recursiveFiles : files;
}
function matchesFormat(file: BrowserFile, format: string): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return format === 'aiff' ? extension === 'aif' || extension === 'aiff' : extension === format;
}
function refreshAudioMetadataIndex(): void {
  renderList();
  void indexAudioMetadata(currentFileCandidates());
}
function metadataScanCandidates(candidates: readonly BrowserFile[]): BrowserFile[] {
  const query = $('search', HTMLInputElement).value;
  const colorFilters = selectedColorFilters();
  const selectedFormat = selectedFilterValue('format');
  return filterFiles(candidates, query, view, favorites).filter((file) => {
    if (file.isDirectory || kindOf(file) !== 'Audio') return false;
    if (favoriteOnly && !favorites.has(file.path)) return false;
    if (selectedFormat && !matchesFormat(file, selectedFormat)) return false;
    if (colorFilters.length && !colorFilters.includes(fileColors[file.path] ?? 'none')) return false;
    return true;
  });
}
function renderList(): void {
  const query = $('search', HTMLInputElement).value;
  const source = currentFileCandidates();
  let visible = filterFiles(source, query, view, favorites).filter((file) => !file.isDirectory);
  if (favoriteOnly) visible = visible.filter((file) => favorites.has(file.path));
  const selectedFormat = selectedFilterValue('format');
  const selectedRate = Number(selectedFilterValue('rate') || 0), selectedBits = Number(selectedFilterValue('bits') || 0);
  const channelFilters = selectedChannelFilters(), colorFilters = selectedColorFilters();
  visible = visible.filter((file) => {
    if (selectedFormat && !matchesFormat(file, selectedFormat)) return false;
    if (colorFilters.length && !colorFilters.includes(fileColors[file.path] ?? 'none')) return false;
    if (kindOf(file) !== 'Audio' || (!selectedRate && !selectedBits && !channelFilters.length)) return true;
    const metadata = filterMetadata.get(file.path); if (!metadata) return false;
    if (selectedRate && metadata.rate !== selectedRate || selectedBits && metadata.bits !== selectedBits) return false;
    if (channelFilters.length && !channelFilters.some((filter) => filter === 'mono' ? metadata.channels === 1 : filter === 'stereo' ? metadata.channels === 2 : (metadata.channels ?? 0) > 2)) return false;
    return true;
  });
  const sort = $('sort', HTMLSelectElement).value;
  const byName = (a: BrowserFile, b: BrowserFile) => a.name.localeCompare(b.name, undefined, { numeric: true });
  if (sort === 'type_asc') visible.sort((a,b) => kindOf(a).localeCompare(kindOf(b)) || byName(a,b));
  else if (sort === 'type_desc') visible.sort((a,b) => kindOf(b).localeCompare(kindOf(a)) || byName(a,b));
  else if (sort === 'name_desc') visible.sort((a,b) => byName(b,a));
  else visible.sort((a,b) => Number(b.isDirectory) - Number(a.isDirectory) || byName(a,b));
  visibleFiles = visible;
  $('resultcount').textContent = `${visible.length} ${visible.length === 1 ? 'result' : 'results'}${query ? ` for “${query}”` : ''}`;
  const root = $('list');
  renderListWindow(root.scrollTop);
  updateFilterButtonIndicator();
}
function toggleFavorite(file: BrowserFile): void {
  if (favorites.has(file.path)) favorites.delete(file.path); else favorites.add(file.path);
  persistBrowserState(); updateCounts(); refreshAudioMetadataIndex();
  const button = document.querySelector<HTMLButtonElement>('#sounddetail .preview-favorite');
  if (button && selected?.path === file.path) {
    const active = favorites.has(file.path);
    button.textContent = active ? '★' : '☆';
    button.classList.toggle('on', active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'Remove from favorites' : 'Add to favorites');
  }
}
function toggleFileColor(file: BrowserFile, color: string): void {
  if (fileColors[file.path] === color) delete fileColors[file.path]; else fileColors[file.path] = color;
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(fileColors)); } catch { /* Persist to session storage when available. */ }
  persistBrowserState();
  for (const choice of document.querySelectorAll<HTMLButtonElement>('.file-color')) {
    const active = selected?.path === file.path && fileColors[file.path] === choice.dataset.color;
    choice.classList.toggle('selected', active); choice.setAttribute('aria-pressed', String(active));
  }
  renderList();
}
function renderListWindow(priorScroll = $('list').scrollTop): void {
  const root = $('list');
  const visible = visibleFiles;
  if (!visible.length) { root.innerHTML = '<div class="empty"><strong>No matching sounds</strong>Try another search or folder.</div>'; return; }
  const content = document.createDocumentFragment();
  const rowHeight = 22, start = Math.max(0, Math.floor(priorScroll / rowHeight) - 4), count = Math.min(48, Math.ceil((root.clientHeight || 280) / rowHeight) + 8);
  if (start) { const spacer = document.createElement('div'); spacer.style.height = `${start * rowHeight}px`; content.append(spacer); }
  for (const file of visible.slice(start, start + count)) {
    const row = document.createElement('div');
    row.className = `soundfile-row${selected?.path === file.path ? ' selected' : ''}`;
    row.dataset.path = file.path; row.tabIndex = 0; row.setAttribute('role', 'option');
    const assignedColor = fileColors[file.path];
    row.innerHTML = `<span class="fileicon">${rowIcon(file)}</span><span class="filename" title="${esc(file.path)}">${esc(file.name)}</span><span class="colorbadge"${assignedColor ? ` title="File color ${esc(assignedColor)}" style="--file-color:${esc(assignedColor)}"` : ' style="visibility:hidden"'} aria-hidden="true"></span><button class="star${favorites.has(file.path) ? ' on' : ''}" title="Favorite" aria-label="Favorite">${favorites.has(file.path) ? '★' : '☆'}</button>`;
    row.onclick = () => { row.focus({ preventScroll: true }); if (file.isDirectory) { if (midiPreviewEnabled || midiPreviewClip) void stopMidiPreview(); currentFolder = file.path; void loadFolder(file.path, false); } else { void (async () => { if (midiPreviewEnabled && midiPreviewPath !== file.path) await stopMidiPreview(); selected = file; renderList(); $('list').querySelector<HTMLElement>('.soundfile-row.selected')?.focus({ preventScroll: true }); await renderSound(); if (kindOf(file) === 'MIDI' && settings.autoplay) await previewMidiFile(file); })(); } };
    row.ondblclick = () => {
      if (file.isDirectory) { currentFolder = file.path; void loadFolder(file.path, false); }
      else if (settings.doubleClickImport && (kindOf(file) === 'Audio' || kindOf(file) === 'MIDI')) {
        doubleClickImportPath = file.path;
        if ($('status').textContent === 'Audio preview could not start. Click Preview to try again.') say('');
        void importSound(file).finally(() => setTimeout(() => { if (doubleClickImportPath === file.path) doubleClickImportPath = undefined; }, 1200));
      }
    };
    row.oncontextmenu = (event) => { event.preventDefault(); showFileContext(event as MouseEvent, file); };
    row.querySelector('button')!.onclick = (event) => { event.stopPropagation(); toggleFavorite(file); };
    content.append(row);
  }
  const remaining = visible.length - Math.min(visible.length, start + count);
  if (remaining) { const spacer = document.createElement('div'); spacer.style.height = `${remaining * rowHeight}px`; content.append(spacer); }
  root.replaceChildren(content);
  root.scrollTop = priorScroll;
}
function revealSelectedFileInList(): void {
  if (!selected) return;
  const index = visibleFiles.findIndex((file) => file.path === selected?.path);
  if (index < 0) return;
  const list = $('list'), rowHeight = 22, viewportHeight = list.clientHeight || 280;
  const rowTop = index * rowHeight, rowBottom = rowTop + rowHeight;
  if (rowTop < list.scrollTop) list.scrollTop = rowTop;
  else if (rowBottom > list.scrollTop + viewportHeight) list.scrollTop = rowBottom - viewportHeight;
  renderList();
}
let stopActiveAudioPreview: (() => void) | undefined;
let stopSyncedAudioPreview: (() => void) | undefined;
async function renderSound(forcePlay = false): Promise<void> {
  stopSyncedAudioPreview?.(); stopSyncedAudioPreview = undefined;
  stopActiveAudioPreview?.(); stopActiveAudioPreview = undefined;
  previewTempoRelease?.(); previewTempoRelease = undefined;
  const root = $('sounddetail');
  if ($('status').classList.contains('error')) say('');
  if (!selected) { root.innerHTML = '<div class="empty"><strong>Select a sound</strong>Preview it, inspect its details, or find similar samples.</div>'; if (!similarPaneOpen) $('simlabel').textContent = ''; $('similarpane').hidden = !similarPaneOpen; return; }
  const file = selected;
  if (file.path !== similarReferencePath && !similarMatches.some(({ file: match }) => match.path === file.path)) similarMatches = [];
  const audioFile = kindOf(file) === 'Audio';
  const generation = ++waveformGeneration;
  root.innerHTML = `<div class="previewcard"><div class="previewtop"><div class="eyebrow">${kindOf(file)} · ${esc(basename(currentFolder))}</div>${audioFile ? '<div class="fileinfo"><span title="Sample rate">⌁ <b id="info-rate">—</b></span><span title="Bit depth">▤ <b id="info-bits">—</b></span><span title="Channels">◖◗ <b id="info-channels">—</b></span><span title="Length">◷ <b id="info-length">—</b></span></div>' : ''}</div><div class="assetname" title="${esc(file.name)}">${esc(file.name)}</div><div class="path" title="${esc(file.path)}" ${settings.previewPath ? '' : 'hidden'}>${settings.previewPath ? esc(previewFolderPath(file.path)) : ''}</div>${audioFile ? `<div class="wave-wrap"><canvas class="wave" id="wavecanvas" aria-label="Waveform preview"></canvas><span class="wave-cursor" id="wavecursor" hidden></span></div>` : ''}<div class="file-mark-row"><div class="file-color-row" id="file-colors" role="group" aria-label="File color">${LUNA_PALETTE.map((color) => `<button type="button" class="file-color${fileColors[file.path] === color ? ' selected' : ''}" data-color="${color}" style="--file-swatch:${color}" title="${color}" aria-label="${fileColors[file.path] === color ? 'Clear' : 'Set'} file color ${color}" aria-pressed="${fileColors[file.path] === color}"></button>`).join('')}</div><button type="button" class="star preview-favorite${favorites.has(file.path) ? ' on' : ''}" title="Favorite" aria-label="${favorites.has(file.path) ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${favorites.has(file.path)}">${favorites.has(file.path) ? '★' : '☆'}</button></div><div class="audio-controls previewcontrols"><button class="primary" id="${audioFile ? 'preview' : 'previewmidi'}">▶ Preview</button>${audioFile ? '<label class="volumecontrol" title="Preview volume"><span class="vol-label">VOL</span><input id="previewvolume" type="range" min="0" max="1" step="0.01" value="' + (settings.previewVolume ?? .8) + '" aria-label="Preview volume"></label>' : '<span class="midi-control-spacer"></span>'}${audioFile ? `<button type="button" id="temposync" class="tempo-sync" aria-label="Use session tempo for audio preview" title="Preview at session tempo" aria-pressed="${settings.syncSessionTempo}">${METRONOME_ICON}</button>` : ''}<button id="autoplayoption" aria-pressed="${settings.autoplay}">Auto-Play</button><button id="loopoption" aria-pressed="${settings.loop}">Loop</button></div><div class="audio-controls"><button class="primary" id="import">＋ Add to selected track</button><button id="newtrackimport">＋ Add to new track</button><button id="similar">Find similar</button><button id="reveal">Go to Place</button></div></div>`;
  $('simlabel').textContent = '';
  $('similarpane').hidden = !similarPaneOpen;
  if (similarMatches.length) renderSimilarRows($('similarlist'));
  if (audioFile) {
    try {
      if (!(await luna.gui.available())) throw new Error('Preview is available inside LUNA.');
      let url = mediaUrlCache.get(file.path);
      if (!url) { url = await luna.gui.serveMediaFile('com.fourdogslong.file_browser', file.path); mediaUrlCache.set(file.path, url); }
      const audio = $('audio', HTMLAudioElement);
      audio.pause(); audio.src = url; audio.loop = settings.loop; audio.volume = settings.previewVolume ?? .8; audio.load();
      let decodedBuffer: AudioBuffer | undefined;
      let bufferReady: Promise<AudioBuffer> | undefined;
      const tempoBufferCache = new Map<number, AudioBuffer>();
      let loopContext: AudioContext | undefined;
      let loopSource: AudioBufferSourceNode | undefined;
      let scheduledPreviewSource: AudioBufferSourceNode | undefined;
      let loopGain: GainNode | undefined;
      let loopOffset = 0;
      let loopStartedAt = 0;
      let bufferLoopActive = false;
      let previewIsPlaying = false;
      let loopFrame = 0;
      let mediaCursorFrame = 0;
      const paintMediaCursor = () => {
        const cursor = document.getElementById('wavecursor') as HTMLElement | null;
        if (cursor && audio.duration) { cursor.hidden = false; cursor.style.left = `${Math.max(0, Math.min(100, audio.currentTime / audio.duration * 100))}%`; }
      };
      const animateMediaCursor = () => {
        paintMediaCursor();
        if (!audio.paused && !audio.ended && selected?.path === file.path) mediaCursorFrame = requestAnimationFrame(animateMediaCursor);
        else mediaCursorFrame = 0;
      };
      const startMediaCursor = () => { if (!mediaCursorFrame) mediaCursorFrame = requestAnimationFrame(animateMediaCursor); };
      const stopMediaCursor = () => { if (mediaCursorFrame) cancelAnimationFrame(mediaCursorFrame); mediaCursorFrame = 0; };
      const getDecodedBuffer = async (): Promise<AudioBuffer> => {
        if (decodedBuffer) return decodedBuffer;
        if (!bufferReady) bufferReady = (async () => {
          const Context = window.AudioContext;
          if (!Context) throw new Error('Gapless preview looping is unavailable.');
          loopContext ??= new Context();
          const bytes = await fileBytes(url);
          decodedBuffer = await loopContext.decodeAudioData(bytes.slice(0));
          return decodedBuffer;
        })();
        return bufferReady;
      };
      const getTempoBuffer = async (): Promise<AudioBuffer> => {
        const buffer = await getDecodedBuffer();
        const bpm = await getPreviewBpm();
        const sessionBpm = session?.transport.tempo.value;
        const ratio = bpm && sessionBpm && Number.isFinite(sessionBpm) ? sessionBpm / bpm : 1;
        if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.002) return buffer;
        const cached = tempoBufferCache.get(ratio);
        if (cached) return cached;
        const stretched = await timeStretchAudioBuffer(buffer, ratio, loopContext!);
        tempoBufferCache.set(ratio, stretched);
        return stretched;
      };
      const currentBufferTime = () => {
        if (!decodedBuffer?.duration) return loopOffset;
        const elapsed = Math.max(0, (loopContext?.currentTime ?? loopStartedAt) - loopStartedAt) * (loopSource?.playbackRate.value ?? 1);
        const position = loopOffset + elapsed;
        return settings.loop ? position % decodedBuffer.duration : Math.min(position, decodedBuffer.duration);
      };
      const stopBufferLoop = (preservePosition = true) => {
        if (bufferLoopActive && preservePosition) loopOffset = currentBufferTime();
        if (loopFrame) cancelAnimationFrame(loopFrame);
        loopFrame = 0;
        try { loopSource?.stop(); } catch { /* The source may already have ended. */ }
        loopSource?.disconnect(); loopSource = undefined; bufferLoopActive = false;
      };
      stopActiveAudioPreview = () => {
        stopBufferLoop(false); stopMediaCursor(); previewIsPlaying = false; audio.pause(); decodedBuffer = undefined; bufferReady = undefined; loopGain = undefined;
        if (loopContext && loopContext.state !== 'closed') void loopContext.close();
        loopContext = undefined;
      };
      const updateBufferCursor = () => {
        if (!bufferLoopActive || selected?.path !== file.path) return;
        const cursor = document.getElementById('wavecursor') as HTMLElement | null;
        if (cursor && decodedBuffer?.duration) { cursor.hidden = false; cursor.style.left = `${currentBufferTime() / decodedBuffer.duration * 100}%`; }
        loopFrame = requestAnimationFrame(updateBufferCursor);
      };
      const startBufferLoop = async () => {
        try {
          const buffer = await getDecodedBuffer();
          if (selected?.path !== file.path || !settings.loop || settings.syncSessionTempo) return false;
          loopContext ??= new AudioContext();
          await loopContext.resume();
          if (selected?.path !== file.path || !settings.loop || settings.syncSessionTempo) return false;
          if (!audio.paused && !bufferLoopActive) loopOffset = audio.currentTime;
          audio.pause(); audio.loop = false;
          loopGain ??= loopContext.createGain(); loopGain.connect(loopContext.destination);
          loopGain.gain.value = audio.volume;
          loopSource = loopContext.createBufferSource(); loopSource.buffer = buffer; loopSource.loop = true; loopSource.connect(loopGain);
          loopOffset = Math.max(0, Math.min(loopOffset, Math.max(0, buffer.duration - .001)));
          loopStartedAt = loopContext.currentTime; loopSource.start(0, loopOffset); bufferLoopActive = true;
          previewIsPlaying = true; $('preview').textContent = 'Ⅱ Pause'; $('preview').classList.add('is-playing');
          updateBufferCursor(); return true;
        } catch { audio.loop = settings.loop; return false; }
      };
      const tempoButton = $('temposync', HTMLButtonElement);
      let currentBpm = bpmFromFilename(file.name) ?? filterMetadata.get(file.path)?.bpm;
      let bpmReady = false, resolveBpmReady!: (bpm: number | undefined) => void;
      const bpmReadyPromise = new Promise<number | undefined>((resolve) => { resolveBpmReady = resolve; });
      const applyCurrentTempo = (bpm: number | undefined) => { if (selected?.path === file.path && document.getElementById('temposync') === tempoButton) applyPreviewTempo(audio, bpm, tempoButton); };
      const resolveTempoBpm = (bpm?: number) => { if (bpm) currentBpm = bpm; if (!bpmReady) { bpmReady = true; resolveBpmReady(currentBpm); } if (settings.syncSessionTempo) applyCurrentTempo(currentBpm); };
      if (currentBpm) resolveTempoBpm(currentBpm);
      void drawWaveform(url, generation, file, resolveTempoBpm, (buffer) => { decodedBuffer = buffer; });
      const getPreviewBpm = async (): Promise<number | undefined> => {
        if (!currentBpm && !bpmReady) await bpmReadyPromise;
        if (!currentBpm && settings.syncSessionTempo) { try { currentBpm = await audioFileBpm(file); } catch { currentBpm = undefined; } }
        return currentBpm;
      };
      const refreshTempoWatch = () => {
        previewTempoRelease?.(); previewTempoRelease = undefined;
        if (settings.syncSessionTempo && session) previewTempoRelease = session.transport.tempo.onChange(() => { void getPreviewBpm().then(applyCurrentTempo); });
      };
      if (settings.syncSessionTempo) { refreshTempoWatch(); void getPreviewBpm().then(applyCurrentTempo); }
      let pendingBeatRelease: Luna.Unsubscribe | undefined;
      let previewScheduled = false;
      let scheduledPreviewTimer = 0;
      let previewRequestGeneration = 0;
      const cancelQueuedPreview = () => {
        previewRequestGeneration++;
        pendingBeatRelease?.(); pendingBeatRelease = undefined; previewScheduled = false;
        if (scheduledPreviewTimer) clearTimeout(scheduledPreviewTimer); scheduledPreviewTimer = 0;
        if (scheduledPreviewSource) { if (loopSource === scheduledPreviewSource) stopBufferLoop(false); else { try { scheduledPreviewSource.stop(); } catch { /* Already stopped. */ } scheduledPreviewSource.disconnect(); } scheduledPreviewSource = undefined; }
        const button = document.getElementById('preview');
        button?.classList.remove('is-queued'); button?.removeAttribute('title'); button?.setAttribute('aria-label', 'Preview or pause audio');
      };
      const startPreview = async () => { cancelQueuedPreview(); previewIsPlaying = true; if (settings.syncSessionTempo) { applyCurrentTempo(currentBpm); void getPreviewBpm().then(applyCurrentTempo); } if (settings.loop && !settings.syncSessionTempo && await startBufferLoop()) return; audio.loop = settings.loop; await audio.play(); $('preview').textContent = 'Ⅱ Pause'; $('preview').classList.add('is-playing'); };
      const requestPreviewStart = () => {
        cancelQueuedPreview();
        const activeSession = session;
        if (!settings.syncSessionTempo || activeSession?.transport.playing.value !== true) { void startPreview().catch((error) => say(`Preview could not start: ${String((error as Error).message ?? error)}`, true)); return; }
        const transport = activeSession.transport;
        const timeline = activeSession.musical.timeline;
        let targetBar = 0, targetTick = 0, lastSessionSeconds = 0, lastLocationTime = 0;
        const request = ++previewRequestGeneration;
        previewScheduled = true;
        const button = $('preview'); button.classList.add('is-queued'); button.title = 'Preview queued for the next bar · beat 1'; button.setAttribute('aria-label', 'Preview queued for the next bar, beat 1');
        void (async () => {
          try {
            loopContext ??= new AudioContext(); await loopContext.resume();
            const buffer = await getTempoBuffer();
            if (request !== previewRequestGeneration || !previewScheduled || selected?.path !== file.path || transport.playing.value !== true) return;
            const position = transport.location.value;
            const beat = position?.bar_beat ?? timeline.barBeat(position?.tick ?? transport.tick);
            // Finish decode/stretch first, then choose the next bar. Cold auto-play must not
            // keep an earlier target and roll again while its audio is still being prepared.
            targetBar = beat.bar + 1;
            targetTick = timeline.tickAt({ bar: targetBar, beat: 1 });
            lastSessionSeconds = timeline.seconds(position?.tick ?? transport.tick);
            lastLocationTime = performance.now();
            pendingBeatRelease = transport.location.onChange(() => {
              if (!previewScheduled) return;
              if (selected?.path !== file.path || transport.playing.value !== true) { cancelQueuedPreview(); return; }
              const nextPosition = transport.location.value;
              if (!nextPosition) return;
              const nextBeat = nextPosition.bar_beat ?? timeline.barBeat(nextPosition.tick);
              lastSessionSeconds = timeline.seconds(nextPosition.tick); lastLocationTime = performance.now();
              if (nextBeat.bar >= targetBar && nextPosition.tick >= targetTick) { targetBar = nextBeat.bar + 1; targetTick = timeline.tickAt({ bar: targetBar, beat: 1 }); }
            });
            if (beat.bar >= targetBar && (position?.tick ?? transport.tick) >= targetTick) { targetBar = beat.bar + 1; targetTick = timeline.tickAt({ bar: targetBar, beat: 1 }); }
            const currentSessionSeconds = Math.max(timeline.seconds(position?.tick ?? transport.tick), lastSessionSeconds + (performance.now() - lastLocationTime) / 1000);
            let secondsUntil = timeline.seconds(targetTick) - currentSessionSeconds;
            if (!Number.isFinite(secondsUntil) || secondsUntil < .06) {
              targetBar = beat.bar + 1; targetTick = timeline.tickAt({ bar: targetBar, beat: 1 });
              secondsUntil = timeline.seconds(targetTick) - currentSessionSeconds;
            }
            if (!Number.isFinite(secondsUntil) || secondsUntil <= 0) throw new Error('Could not determine the next bar position.');
            stopBufferLoop(false); audio.pause(); audio.loop = false; loopOffset = 0;
            loopGain ??= loopContext.createGain(); loopGain.gain.value = audio.volume; loopGain.connect(loopContext.destination);
            const source = loopContext.createBufferSource(); source.buffer = buffer; source.loop = settings.loop; source.playbackRate.value = 1; source.connect(loopGain);
            loopSource = source; scheduledPreviewSource = source; loopStartedAt = loopContext.currentTime + secondsUntil; bufferLoopActive = true;
            source.onended = () => {
              if (loopSource !== source) return;
              loopSource = undefined; scheduledPreviewSource = undefined; bufferLoopActive = false; previewIsPlaying = false; stopMediaCursor();
              const previewButton = document.getElementById('preview'); if (previewButton) { previewButton.textContent = '▶ Preview'; previewButton.classList.remove('is-playing'); }
            };
            source.start(loopStartedAt, 0);
            pendingBeatRelease?.(); pendingBeatRelease = undefined;
            scheduledPreviewTimer = window.setTimeout(() => {
              if (request !== previewRequestGeneration || !previewScheduled || loopSource !== source) return;
              scheduledPreviewTimer = 0; previewScheduled = false; scheduledPreviewSource = undefined; previewIsPlaying = true;
              const previewButton = document.getElementById('preview'); previewButton?.classList.remove('is-queued'); previewButton?.classList.add('is-playing'); previewButton?.removeAttribute('title'); previewButton?.setAttribute('aria-label', 'Pause audio preview'); if (previewButton) previewButton.textContent = 'Ⅱ Pause';
              updateBufferCursor();
            }, Math.max(0, (loopStartedAt - loopContext.currentTime) * 1000));
          } catch (error) {
            if (request === previewRequestGeneration && previewScheduled) { cancelQueuedPreview(); say(`Could not schedule preview: ${String((error as Error).message ?? error)}`, true); }
          }
        })();
      };
      const stopPreviewForTransport = () => {
        cancelQueuedPreview();
        if (!settings.syncSessionTempo || !previewIsPlaying) return;
        stopBufferLoop(false); previewIsPlaying = false; audio.pause(); $('preview').textContent = '▶ Preview'; $('preview').classList.remove('is-playing');
      };
      stopSyncedAudioPreview = stopPreviewForTransport;
      $('preview').onclick = async () => { try { if (previewScheduled) cancelQueuedPreview(); else if (!previewIsPlaying) requestPreviewStart(); else { stopBufferLoop(); if (decodedBuffer) audio.currentTime = loopOffset; previewIsPlaying = false; audio.pause(); $('preview').textContent = '▶ Preview'; $('preview').classList.remove('is-playing'); } } catch(e) { say(`Preview could not start: ${String((e as Error).message ?? e)}`, true); } };
      tempoButton.onclick = async () => {
        const wasQueued = previewScheduled;
        if (wasQueued) cancelQueuedPreview();
        settings.syncSessionTempo = !settings.syncSessionTempo; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        tempoButton.setAttribute('aria-pressed', String(settings.syncSessionTempo)); refreshTempoWatch();
        if (bufferLoopActive) { stopBufferLoop(); audio.currentTime = loopOffset; }
        if (settings.syncSessionTempo) { applyCurrentTempo(currentBpm); void getPreviewBpm().then(applyCurrentTempo); if (previewIsPlaying) { audio.loop = settings.loop; await audio.play(); } }
        else { applyCurrentTempo(currentBpm); if (wasQueued) await startPreview(); else if (previewIsPlaying) { if (settings.loop) await startBufferLoop(); else { audio.loop = false; await audio.play(); } } }
      };
      $('loopoption').onclick = () => {
        settings.loop = !settings.loop; audio.loop = settings.loop; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); $('loopoption').setAttribute('aria-pressed', String(settings.loop)); void setMidiPreviewLoop(settings.loop);
        if (scheduledPreviewSource) scheduledPreviewSource.loop = settings.loop;
        if (!previewIsPlaying) return;
        if (settings.loop && !settings.syncSessionTempo) void startBufferLoop();
        else if (!settings.loop && bufferLoopActive) { stopBufferLoop(); audio.currentTime = loopOffset; audio.loop = false; void audio.play(); }
      };
      $('previewvolume', HTMLInputElement).oninput = (e) => { const volume = Number((e.target as HTMLInputElement).value); audio.volume = volume; if (loopGain) loopGain.gain.value = volume; settings.previewVolume = volume; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); };
      $('previewvolume', HTMLInputElement).onpointerdown = (e) => { if ((e as PointerEvent).altKey) { e.preventDefault(); audio.volume = 1; settings.previewVolume = 1; $('previewvolume', HTMLInputElement).value = '1'; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } };
      $('previewvolume', HTMLInputElement).oncontextmenu = (e) => { e.preventDefault(); const entered = prompt('Preview volume (0–100)', String(Math.round(audio.volume * 100))); if (entered === null) return; const value = Number(entered); if (Number.isFinite(value) && value >= 0 && value <= 100) { audio.volume = value / 100; settings.previewVolume = value / 100; $('previewvolume', HTMLInputElement).value = String(value / 100); localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } else say('Enter a volume from 0 to 100.', true); };
      audio.onloadedmetadata = () => { const length = document.getElementById('info-length'); if (length) length.textContent = durationText(audio.duration); paintMediaCursor(); if (settings.syncSessionTempo) void getPreviewBpm().then(applyCurrentTempo); };
      audio.ontimeupdate = paintMediaCursor;
      audio.onseeked = paintMediaCursor;
      audio.onplay = startMediaCursor;
      audio.onpause = stopMediaCursor;
      audio.onended = () => { stopMediaCursor(); previewIsPlaying = false; const button = document.getElementById('preview'); if (button) { button.textContent = '▶ Preview'; button.classList.remove('is-playing'); } };
      document.getElementById('wavecanvas')?.addEventListener('click', (event) => {
        const canvas = event.currentTarget as HTMLCanvasElement, rect = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, ((event as MouseEvent).clientX - rect.left) / rect.width));
        if (bufferLoopActive && decodedBuffer) { stopBufferLoop(false); loopOffset = ratio * decodedBuffer.duration; void startBufferLoop(); }
        else if (audio.duration) audio.currentTime = ratio * audio.duration;
      });
      if ((settings.autoplay || forcePlay) && doubleClickImportPath !== file.path) requestPreviewStart();
    } catch (e) { const message = String((e as Error).message ?? e); $('preview').setAttribute('title', message); $('preview').onclick = () => say(message, true); say(message, true); }
  }
  document.getElementById('autoplayoption')?.addEventListener('click', () => { settings.autoplay = !settings.autoplay; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); $('autoplayoption').setAttribute('aria-pressed', String(settings.autoplay)); if (settings.autoplay && kindOf(file) === 'MIDI' && !midiPreviewEnabled) void previewMidiFile(file); });
  if (kindOf(file) === 'MIDI') document.getElementById('loopoption')?.addEventListener('click', () => { settings.loop = !settings.loop; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); $('loopoption').setAttribute('aria-pressed', String(settings.loop)); void setMidiPreviewLoop(settings.loop); });
  $('import').onclick = () => void importSound(file);
  $('newtrackimport').onclick = () => void importToNewTrack(file);
  const midiPreviewButton = document.getElementById('previewmidi');
  if (midiPreviewButton) { midiPreviewButton.onclick = () => void previewMidiFile(file); updateMidiPreviewButton(); }
  $('reveal').onclick = () => { const folder = file.isDirectory ? file.path : file.path.replace(/[\\/][^\\/]+$/, ''); void selectPlace(folder); };
  $('similar').onclick = () => renderSimilar(file);
  for (const button of root.querySelectorAll<HTMLButtonElement>('.file-color')) button.onclick = () => toggleFileColor(file, button.dataset.color ?? '');
  root.querySelector<HTMLButtonElement>('.preview-favorite')!.onclick = () => toggleFavorite(file);
}
function paintWaveform(canvas: HTMLCanvasElement, peaks: readonly number[]): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * (window.devicePixelRatio || 1)));
  const height = Math.max(1, Math.floor(rect.height * (window.devicePixelRatio || 1)));
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--active').trim() || '#e5b747';
  ctx.globalAlpha = .82; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(width, mid); ctx.stroke();
  ctx.globalAlpha = .9;
  for (let x = 0; x < width; x++) {
    const peak = peaks[Math.min(peaks.length - 1, Math.floor(x * peaks.length / width))] ?? 0;
    ctx.beginPath(); ctx.moveTo(x + .5, mid - peak * (height * .46)); ctx.lineTo(x + .5, mid + peak * (height * .46)); ctx.stroke();
  }
}
async function drawWaveform(url: string, generation: number, file: BrowserFile, onBpm?: (bpm: number | undefined) => void, onDecoded?: (buffer: AudioBuffer) => void): Promise<void> {
  const canvas = $('wavecanvas', HTMLCanvasElement);
  const Context = window.AudioContext;
  if (!Context || !canvas) { onBpm?.(bpmFromFilename(file.name) ?? filterMetadata.get(file.path)?.bpm); return; }
  const cached = waveformCache.get(file.path);
  if (cached) {
    waveformCache.delete(file.path); waveformCache.set(file.path, cached);
    if (generation !== waveformGeneration || !canvas.isConnected) return;
    showAudioInfo(cached.info, cached.channels);
    rememberMetadata(file.path, { ...cached.info, channels: cached.info.channels ?? cached.channels });
    const cachedBpm = bpmFromFilename(file.name) ?? filterMetadata.get(file.path)?.bpm ?? fileTempoCache.get(file.path) ?? undefined;
    onBpm?.(cachedBpm);
    paintWaveform(canvas, cached.peaks);
    return;
  }
  const context = new Context();
  try {
    const bytes = await fileBytes(url);
    const headerInfo = audioHeaderInfo(bytes, file.name);
    const nameBpm = bpmFromFilename(file.name);
    const bpm = nameBpm ?? (settings.syncSessionTempo ? metadataBpm(bytes, file.name) : undefined);
    if (nameBpm || settings.syncSessionTempo) fileTempoCache.set(file.path, bpm ?? null);
    if (bpm) rememberMetadata(file.path, { bpm });
    onBpm?.(bpm);
    const decoded = await context.decodeAudioData(bytes.slice(0));
    onDecoded?.(decoded);
    if (generation !== waveformGeneration || !canvas.isConnected) return;
    showAudioInfo(headerInfo, decoded.numberOfChannels);
    rememberMetadata(file.path, { ...headerInfo, channels: headerInfo.channels ?? decoded.numberOfChannels });
    const channel = decoded.getChannelData(0);
    const peaks = Array.from({ length: 640 }, (_, bin) => {
      const start = Math.floor(bin * channel.length / 640), end = Math.max(start + 1, Math.floor((bin + 1) * channel.length / 640));
      let min = 1, max = -1;
      for (let i = start; i < end; i++) { const value = channel[i] ?? 0; if (value < min) min = value; if (value > max) max = value; }
      return Math.max(Math.abs(min), Math.abs(max));
    });
    if (!waveformCache.has(file.path) && waveformCache.size >= WAVEFORM_CACHE_LIMIT) {
      const oldest = waveformCache.keys().next().value;
      if (oldest) waveformCache.delete(oldest);
    }
    waveformCache.set(file.path, { peaks, info: headerInfo, channels: decoded.numberOfChannels, duration: decoded.duration });
    paintWaveform(canvas, peaks);
    if (hasAudioMetadataFilter()) renderList();
  } catch { const bpm = bpmFromFilename(file.name) ?? filterMetadata.get(file.path)?.bpm; if (settings.syncSessionTempo) fileTempoCache.set(file.path, bpm ?? null); onBpm?.(bpm); if (canvas.isConnected) canvas.title = 'Waveform unavailable for this audio format'; }
  finally { await context.close(); }
}
function fileBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Request cancelled.', 'AbortError')); return; }
    const request = new XMLHttpRequest(); request.open('GET', url); request.responseType = 'arraybuffer';
    let settled = false;
    const finish = (error?: Error, result?: ArrayBuffer) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result!);
    };
    const abort = () => { request.abort(); finish(new DOMException('Request cancelled.', 'AbortError')); };
    request.onload = () => request.status >= 200 && request.status < 300 || request.status === 0 && request.response instanceof ArrayBuffer && request.response.byteLength > 0 ? finish(undefined, request.response as ArrayBuffer) : finish(new Error(`Media request returned ${request.status}`));
    request.onerror = () => finish(new Error('The sample could not be read by this LUNA version.'));
    request.onabort = () => finish(new DOMException('Request cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    request.send();
  });
}
function audioHeaderInfo(buffer: ArrayBuffer, filename: string): { rate?: number; channels?: number; bits?: number; compressed?: boolean } {
  const view = new DataView(buffer); const text = (offset: number, length: number) => new TextDecoder().decode(new Uint8Array(buffer, offset, length));
  const safe = (offset: number, length: number) => offset >= 0 && offset + length <= view.byteLength;
  if (safe(0, 12) && text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') {
    let offset = 12;
    while (safe(offset, 8)) {
      const name = text(offset, 4), size = view.getUint32(offset + 4, true), body = offset + 8;
      if (name === 'fmt ' && safe(body, 16)) {
        const format = view.getUint16(body, true);
        return { rate: view.getUint32(body + 4, true), channels: view.getUint16(body + 2, true), bits: view.getUint16(body + 14, true), compressed: format !== 1 && format !== 3 && format !== 0xfffe };
      }
      offset = body + size + (size % 2);
    }
  }
  if (safe(0, 12) && text(0, 4) === 'FORM' && (text(8, 4) === 'AIFF' || text(8, 4) === 'AIFC')) {
    let offset = 12;
    while (safe(offset, 8)) {
      const name = text(offset, 4), size = view.getUint32(offset + 4, false), body = offset + 8;
      if (name === 'COMM' && size >= 18 && safe(body, Math.min(size, 30))) {
        const exponentWord = view.getUint16(body + 8, false), exponent = exponentWord & 0x7fff;
        const mantissa = Number(view.getBigUint64(body + 10, false));
        const rate = exponent ? mantissa * Math.pow(2, exponent - 16383 - 63) : 0;
        const compression = size >= 22 && text(8, 4) === 'AIFC' ? text(body + 18, 4) : 'NONE';
        return { rate: Math.round(rate), channels: view.getUint16(body, false), bits: view.getUint16(body + 6, false), compressed: compression !== 'NONE' && compression !== 'twos' && compression !== 'sowt' };
      }
      offset = body + size + (size % 2);
    }
  }
  if (safe(0, 42) && text(0, 4) === 'fLaC') {
    let offset = 4;
    while (safe(offset, 4)) {
      const header = view.getUint8(offset), type = header & 0x7f;
      const size = (view.getUint8(offset + 1) << 16) | (view.getUint8(offset + 2) << 8) | view.getUint8(offset + 3), body = offset + 4;
      if (type === 0 && size >= 34 && safe(body + 10, 8)) {
        const packed = view.getBigUint64(body + 10, false);
        return { rate: Number((packed >> 44n) & 0xfffffn), channels: Number((packed >> 41n) & 7n) + 1, bits: Number((packed >> 36n) & 31n) + 1 };
      }
      offset = body + size;
      if (header & 0x80) break;
    }
  }
  if (/\.mp3$/i.test(filename) && safe(0, 4)) {
    for (let offset = 0; offset < Math.min(view.byteLength - 4, 65536); offset++) {
      const header = view.getUint32(offset, false);
      if ((header & 0xffe00000) !== 0xffe00000) continue;
      const version = (header >>> 19) & 3, rateIndex = (header >>> 10) & 3, mode = (header >>> 6) & 3;
      if (version === 1 || rateIndex === 3) continue;
      const base = [44100, 48000, 32000][rateIndex];
      return { rate: version === 3 ? base : version === 2 ? base / 2 : base / 4, channels: mode === 3 ? 1 : 2, compressed: true };
    }
  }
  return { compressed: /\.(mp3|m4a|aac)$/i.test(filename) };
}
function showAudioInfo(info: ReturnType<typeof audioHeaderInfo>, channelsFallback?: number): void {
  const rate = document.getElementById('info-rate'), bits = document.getElementById('info-bits'), channels = document.getElementById('info-channels');
  if (rate) rate.textContent = info.rate ? `${(info.rate / 1000).toFixed(info.rate % 1000 ? 1 : 0)} kHz` : '—';
  if (bits) bits.textContent = info.bits ? `${info.bits}-bit` : info.compressed ? 'Lossy' : '—';
  if (channels) { const count = info.channels ?? channelsFallback; channels.textContent = count ? (count === 1 ? 'Mono' : count === 2 ? 'Stereo' : `${count} ch`) : '—'; }
}
function rememberMetadata(path: string, metadata: { rate?: number; bits?: number; channels?: number; duration?: number; size?: number; bpm?: number }): void {
  filterMetadata.set(path, { ...filterMetadata.get(path), ...metadata });
  try { localStorage.setItem(metadataCacheKey, JSON.stringify(Object.fromEntries(filterMetadata))); } catch { /* Metadata stays available for this session if storage is full. */ }
}
function validBpm(value: string | number | undefined): number | undefined {
  const bpm = typeof value === 'number' ? value : Number(value?.replace(',', '.'));
  return Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? bpm : undefined;
}
function bpmFromFilename(name: string): number | undefined {
  const match = name.match(/(?:^|[^0-9])(\d{2,3}(?:[.,]\d+)?)[\s_-]*bpm(?=$|[^a-z0-9])|(?:^|[^a-z0-9])bpm[\s_-]*(\d{2,3}(?:[.,]\d+)?)(?=$|[^0-9])/i);
  return validBpm(match?.[1] ?? match?.[2]);
}
/** WSOLA-style overlap-add stretch used on scheduled previews so tempo sync does not raise or lower pitch. */
async function timeStretchAudioBuffer(input: AudioBuffer, rate: number, context: BaseAudioContext): Promise<AudioBuffer> {
  const frame = Math.max(512, Math.min(4096, 2 ** Math.round(Math.log2(input.sampleRate * 0.04))));
  const hop = frame >> 1;
  const search = Math.max(32, Math.round(input.sampleRate * 0.008));
  const outputLength = Math.max(frame, Math.ceil(input.length / rate));
  const channels = Array.from({ length: input.numberOfChannels }, (_, channel) => input.getChannelData(channel));
  const output = Array.from({ length: input.numberOfChannels }, () => new Float32Array(outputLength));
  const weights = new Float32Array(outputLength);
  const maxSource = Math.max(0, input.length - frame);
  let grainIndex = 0;
  for (let outStart = 0; outStart < outputLength; outStart += hop, grainIndex++) {
    const expected = Math.min(maxSource, Math.max(0, Math.round(outStart * rate)));
    let best = grainIndex === 0 ? 0 : Math.min(maxSource, expected);
    if (grainIndex > 0) {
      let bestCorrelation = -Infinity;
      const from = Math.max(0, expected - search), to = Math.min(maxSource, expected + search);
      for (let candidate = from; candidate <= to; candidate += 24) {
        let correlation = 0, inputPower = 1e-12, outputPower = 1e-12;
        for (let i = 0; i < hop; i += 12) {
          const dest = outStart + i;
          if (dest >= outputLength || weights[dest] <= 1e-6) continue;
          const weight = weights[dest];
          for (let channel = 0; channel < channels.length; channel++) {
            const a = output[channel][dest] / weight, b = channels[channel][candidate + i];
            correlation += a * b; inputPower += a * a; outputPower += b * b;
          }
        }
        const score = correlation / Math.sqrt(inputPower * outputPower);
        if (score > bestCorrelation) { bestCorrelation = score; best = candidate; }
      }
    }
    const count = Math.min(frame, outputLength - outStart, input.length - best);
    for (let i = 0; i < count; i++) {
      const dest = outStart + i;
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, frame - 1));
      weights[dest] += window;
      for (let channel = 0; channel < channels.length; channel++) output[channel][dest] += channels[channel][best + i] * window;
    }
    if ((grainIndex & 31) === 31) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  const stretched = context.createBuffer(input.numberOfChannels, outputLength, input.sampleRate);
  for (let channel = 0; channel < output.length; channel++) {
    const destination = stretched.getChannelData(channel), data = output[channel];
    for (let i = 0; i < outputLength; i++) destination[i] = weights[i] > 1e-6 ? data[i] / weights[i] : 0;
  }
  return stretched;
}
function textBpm(text: string): number | undefined {
  const match = text.replace(/\0/g, ' ').match(/(?:^|[^a-z])(?:bpm|tbpm|tempo)\s*[:=\-]?\s*(\d{2,3}(?:[.,]\d+)?)/i);
  return validBpm(match?.[1]);
}
function id3Text(bytes: Uint8Array, start = 0): number | undefined {
  if (start + 10 > bytes.length || String.fromCharCode(...bytes.subarray(start, start + 3)) !== 'ID3') return undefined;
  const version = bytes[start + 3] ?? 0;
  const size = ((bytes[start + 6] ?? 0) << 21) | ((bytes[start + 7] ?? 0) << 14) | ((bytes[start + 8] ?? 0) << 7) | (bytes[start + 9] ?? 0);
  let offset = start + 10, end = Math.min(bytes.length, offset + size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + (version === 2 ? 6 : 10) <= end) {
    const short = version === 2, head = short ? 6 : 10;
    const id = String.fromCharCode(...bytes.subarray(offset, offset + (short ? 3 : 4)));
    if (!id.trim() || id.charCodeAt(0) === 0) break;
    const frameSize = short ? ((bytes[offset + 3] ?? 0) << 16) | ((bytes[offset + 4] ?? 0) << 8) | (bytes[offset + 5] ?? 0)
      : version === 4 ? (((bytes[offset + 4] ?? 0) << 21) | ((bytes[offset + 5] ?? 0) << 14) | ((bytes[offset + 6] ?? 0) << 7) | (bytes[offset + 7] ?? 0))
      : view.getUint32(offset + 4, false);
    const body = offset + head;
    if (frameSize <= 0 || body + frameSize > end) break;
    if (id === 'TBPM' || id === 'TBP') {
      const encoding = bytes[body] ?? 0;
      const data = bytes.subarray(body + 1, body + frameSize);
      const decoder = encoding === 1 ? new TextDecoder('utf-16') : encoding === 2 ? new TextDecoder('utf-16be') : encoding === 3 ? new TextDecoder('utf-8') : new TextDecoder('windows-1252');
      const bpm = validBpm(decoder.decode(data).replace(/\0/g, '').trim());
      if (bpm) return bpm;
    }
    if (id === 'TXXX' || id === 'TXX') {
      const data = new TextDecoder('windows-1252').decode(bytes.subarray(body + 1, body + frameSize)).replace(/\0/g, ' ');
      const bpm = textBpm(data);
      if (bpm) return bpm;
    }
    offset = body + frameSize;
  }
  return undefined;
}
function vorbisBpm(bytes: Uint8Array, offset: number, end: number): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (offset + 8 > end) return undefined;
  const vendorLength = view.getUint32(offset, true); offset += 4 + vendorLength;
  if (offset + 4 > end) return undefined;
  const count = Math.min(view.getUint32(offset, true), 10000); offset += 4;
  for (let index = 0; index < count && offset + 4 <= end; index++) {
    const length = view.getUint32(offset, true); offset += 4;
    if (!length || offset + length > end) return undefined;
    const bpm = textBpm(new TextDecoder().decode(bytes.subarray(offset, offset + length)));
    if (bpm) return bpm;
    offset += length;
  }
  return undefined;
}
function metadataBpm(buffer: ArrayBuffer, filename: string): number | undefined {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const directId3 = id3Text(bytes); if (directId3) return directId3;
  const limit = Math.min(bytes.length, 1024 * 1024);
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'fLaC') {
    let offset = 4;
    while (offset + 4 <= limit) {
      const header = bytes[offset] ?? 0, type = header & 0x7f;
      const length = ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if (type === 4) { const bpm = vorbisBpm(bytes, offset + 4, Math.min(limit, offset + 4 + length)); if (bpm) return bpm; }
      offset += 4 + length;
      if (header & 0x80) break;
    }
  }
  const label = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 12 && label(0, 4) === 'RIFF' && label(8, 4) === 'WAVE') {
    let offset = 12;
    while (offset + 8 <= limit) {
      const id = label(offset, 4), length = view.getUint32(offset + 4, true), body = offset + 8;
      if (id.toLowerCase() === 'acid' && length >= 20 && body + 20 <= limit) { const bpm = validBpm(view.getFloat32(body + 16, true)); if (bpm) return bpm; }
      if (id.toLowerCase() === 'id3 ' && body + length <= limit) { const bpm = id3Text(bytes, body); if (bpm) return bpm; }
      if (id.toLowerCase() === 'bpm ' && body + length <= limit) { const bpm = textBpm(new TextDecoder().decode(bytes.subarray(body, body + length))); if (bpm) return bpm; }
      offset = body + length + (length % 2);
    }
  }
  if (bytes.length >= 12 && label(0, 4) === 'FORM' && (label(8, 4) === 'AIFF' || label(8, 4) === 'AIFC')) {
    let offset = 12;
    while (offset + 8 <= limit) {
      const id = label(offset, 4), length = view.getUint32(offset + 4, false), body = offset + 8;
      if (id === 'ID3 ' && body + length <= limit) { const bpm = id3Text(bytes, body); if (bpm) return bpm; }
      offset = body + length + (length % 2);
    }
  }
  if (/\.m4a$/i.test(filename)) {
    for (let offset = 0; offset + 20 < limit; offset++) if (label(offset, 4) === 'tmpo') {
      const data = bytes.indexOf(100, offset + 4);
      if (data >= offset + 8 && data + 18 < limit && label(data, 4) === 'data') { const bpm = validBpm(view.getUint16(data + 16, false)); if (bpm) return bpm; }
    }
  }
  return textBpm(new TextDecoder('windows-1252').decode(bytes.subarray(0, limit)));
}
async function audioFileBpm(file: BrowserFile): Promise<number | undefined> {
  const fromName = bpmFromFilename(file.name); if (fromName) { fileTempoCache.set(file.path, fromName); return fromName; }
  const cached = filterMetadata.get(file.path)?.bpm;
  if (cached) { fileTempoCache.set(file.path, cached); return cached; }
  if (fileTempoCache.has(file.path)) return fileTempoCache.get(file.path) ?? undefined;
  const existing = fileTempoPromises.get(file.path); if (existing) return existing;
  const pending = (async () => {
    const url = await luna.gui.serveMediaFile('com.fourdogslong.file_browser', file.path);
    const bpm = metadataBpm(await fileBytes(url), file.name);
    fileTempoCache.set(file.path, bpm ?? null);
    if (bpm) rememberMetadata(file.path, { bpm });
    return bpm;
  })().finally(() => fileTempoPromises.delete(file.path));
  fileTempoPromises.set(file.path, pending);
  return pending;
}
function applyPreviewTempo(audio: HTMLAudioElement, bpm: number | undefined, button: HTMLButtonElement): void {
  if (!settings.syncSessionTempo) { audio.playbackRate = 1; button.title = 'Preview at session tempo'; return; }
  const sessionBpm = session?.transport.tempo.value;
  if (!bpm) { audio.playbackRate = 1; button.title = 'Tempo sync on · no BPM found in the file name or supported metadata'; return; }
  if (!sessionBpm || !Number.isFinite(sessionBpm)) { audio.playbackRate = 1; button.title = `Tempo sync on · file ${bpm} BPM · session tempo unavailable`; return; }
  const media = audio as unknown as Record<string, unknown>;
  if ('preservesPitch' in media) media.preservesPitch = true;
  else if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true;
  audio.playbackRate = sessionBpm / bpm;
  button.title = `Tempo sync on · ${bpm} BPM → ${sessionBpm} BPM`;
}
async function indexAudioMetadata(candidates: readonly BrowserFile[]): Promise<void> {
  metadataIndexAbort?.abort();
  const generation = ++metadataIndexGeneration;
  const controller = new AbortController();
  metadataIndexAbort = controller;
  if (!hasAudioMetadataFilter()) {
    renderList();
    if ($('status').textContent.startsWith('Reading audio details')) say('');
    if (metadataIndexAbort === controller) metadataIndexAbort = undefined;
    return;
  }
  const audioFiles = metadataScanCandidates(candidates).filter((file) => !filterMetadata.has(file.path));
  if (!audioFiles.length) {
    renderList();
    if ($('status').textContent.startsWith('Reading audio details')) say('');
    if (metadataIndexAbort === controller) metadataIndexAbort = undefined;
    return;
  }
  for (let i = 0; i < audioFiles.length; i++) {
    if (generation !== metadataIndexGeneration || controller.signal.aborted) return;
    const file = audioFiles[i];
    try {
      say(`Reading audio details · ${i + 1}/${audioFiles.length}`);
      const url = await luna.gui.serveMediaFile('com.fourdogslong.file_browser', file.path);
      if (generation !== metadataIndexGeneration || controller.signal.aborted) return;
      const bytes = await fileBytes(url, controller.signal);
      if (generation !== metadataIndexGeneration || controller.signal.aborted) return;
      const header = audioHeaderInfo(bytes, file.name);
      rememberMetadata(file.path, { ...header, channels: header.channels });
    } catch {
      if (generation !== metadataIndexGeneration || controller.signal.aborted) return;
      /* Unreadable or unsupported files stay unindexed. */
    }
    if (i % 10 === 9) { renderList(); await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); }
  }
  if (generation === metadataIndexGeneration && !controller.signal.aborted) {
    metadataIndexAbort = undefined;
    renderList(); say(`Audio details indexed · ${audioFiles.length} files.`);
  }
}
async function audioFingerprint(file: BrowserFile, context: AudioContext, signal?: AbortSignal): Promise<AudioFingerprint & { duration?: number }> {
  if (signal?.aborted) throw new DOMException('Similarity analysis cancelled.', 'AbortError');
  const cached = soundFeatures.get(file.path); if (cached) return { ...cached, duration: soundDurations.get(file.path) };
  const url = await luna.gui.serveMediaFile('com.fourdogslong.file_browser', file.path);
  if (signal?.aborted) throw new DOMException('Similarity analysis cancelled.', 'AbortError');
  const bytes = await fileBytes(url, signal);
  if (signal?.aborted) throw new DOMException('Similarity analysis cancelled.', 'AbortError');
  const decoded = await context.decodeAudioData(bytes);
  if (signal?.aborted) throw new DOMException('Similarity analysis cancelled.', 'AbortError');
  if (decoded.duration > 60) throw new Error('Similarity analysis supports samples up to 60 seconds.');
  soundDurations.set(file.path, decoded.duration);

  // Analyse at most 12 seconds, at the same fixed sample/frame budget for every file.
  // This adds useful kick/snare and dry/reverb cues without making large files slower.
  const channel = decoded.getChannelData(0);
  const sampleStep = Math.max(1, Math.floor(decoded.sampleRate / 11025));
  const signalLength = Math.min(channel.length, sampleStep * 11025 * 12);
  const windows = 16, size = 256;
  const bandRanges: Array<[number, number]> = [[1, 3], [3, 6], [6, 12], [12, 24], [24, 48], [48, 80], [80, 129]];
  const bandCenters = [0.035, 0.11, 0.21, 0.39, 0.68, 0.88, 0.97];
  const bandTotals = new Array<number>(bandRanges.length).fill(0);
  const frameLevels: number[] = [], frameFlatness: number[] = [];
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
  for (let w = 0; w < windows; w++) {
    const maxStart = Math.max(0, signalLength - sampleStep * size);
    const start = Math.floor(maxStart * w / (windows - 1));
    const frame = new Float64Array(size);
    let frameEnergy = 0;
    for (let i = 0; i < size; i++) {
      const value = channel[start + i * sampleStep] ?? 0;
      frame[i] = value * hann[i];
      frameEnergy += value * value;
    }
    const rms = Math.sqrt(frameEnergy / size);
    frameLevels.push(rms);
    const mags = new Float64Array(size / 2);
    for (let k = 1; k <= size / 2; k++) {
      let re = 0, im = 0;
      const offset = (k - 1) * size;
      for (let i = 0; i < size; i++) { re += frame[i] * fftCos[offset + i]; im -= frame[i] * fftSin[offset + i]; }
      mags[k - 1] = Math.hypot(re, im);
    }
    let magnitudeSum = 0, logMagnitudeSum = 0;
    for (const magnitude of mags) { magnitudeSum += magnitude; logMagnitudeSum += Math.log(magnitude + 1e-12); }
    frameFlatness.push(Math.max(0, Math.min(1, Math.exp(logMagnitudeSum / mags.length) / (magnitudeSum / mags.length + 1e-12))));
    const frameTotal = magnitudeSum || 1;
    const weight = Math.max(rms, 1e-6);
    for (let band = 0; band < bandRanges.length; band++) {
      const [from, to] = bandRanges[band];
      let sum = 0;
      for (let k = from; k < to; k++) sum += mags[k - 1] ?? 0;
      bandTotals[band] += (sum / frameTotal) * weight;
    }
  }
  const spectrumSum = bandTotals.reduce((sum, value) => sum + value, 0) || 1;
  const spectrum = bandTotals.map((value) => value / spectrumSum);
  const peak = Math.max(...frameLevels, 1e-8);
  const envelope = frameLevels.map((value) => value / peak);
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const early = mean(frameLevels.slice(0, 4)), late = mean(frameLevels.slice(-4));
  const lowShare = spectrum[0] + spectrum[1];
  const midShare = spectrum[2] + spectrum[3] + spectrum[4];
  const highShare = spectrum[5] + spectrum[6];
  const centroid = spectrum.reduce((sum, value, index) => sum + value * bandCenters[index], 0);
  const lateFlatness = mean(frameFlatness.slice(-5));
  const crest = Math.min(1, peak / (mean(frameLevels) * 8 + 1e-8));
  const tailLevel = late / peak;
  const tailRatio = late / (early + late + 1e-8);
  const reverbCharacter = Math.max(0, Math.min(1, 0.55 * tailLevel + 0.25 * tailRatio + 0.20 * lateFlatness));
  const character = [lowShare, midShare, highShare, centroid, lateFlatness, crest, early / peak, tailLevel, reverbCharacter];
  const fingerprint = {
    spectrum: spectrum.map((value) => Number(value.toFixed(4))),
    envelope: envelope.map((value) => Number(value.toFixed(4))),
    character: character.map((value) => Number(value.toFixed(4))),
  };
  soundFeatures.set(file.path, fingerprint);
  updateSimilarityCacheStatus();
  return { ...fingerprint, duration: decoded.duration };
}
async function midiFileFingerprint(file: BrowserFile, signal?: AbortSignal): Promise<MidiFingerprint> {
  if (signal?.aborted) throw new DOMException('Similarity analysis cancelled.', 'AbortError');
  const cached = midiFeatures.get(file.path);
  if (cached) return cached;
  const url = await luna.gui.serveMediaFile('com.fourdogslong.file_browser', file.path);
  if (signal?.aborted) throw new DOMException('Similarity analysis cancelled.', 'AbortError');
  const bytes = await fileBytes(url, signal);
  if (signal?.aborted) throw new DOMException('Similarity analysis cancelled.', 'AbortError');
  const fingerprint = parseMidiFingerprint(bytes);
  if (!midiFeatures.has(file.path) && midiFeatures.size >= MIDI_FEATURE_CACHE_LIMIT) {
    const oldest = midiFeatures.keys().next().value;
    if (oldest) midiFeatures.delete(oldest);
  }
  midiFeatures.set(file.path, fingerprint);
  updateSimilarityCacheStatus();
  return fingerprint;
}
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  return Math.max(0, Math.min(1, a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)));
}
function fingerprintSimilarity(a: AudioFingerprint, b: AudioFingerprint): number {
  const spectrum = cosineSimilarity(a.spectrum, b.spectrum);
  const envelope = Math.max(0, 1 - a.envelope.reduce((sum, value, index) => sum + Math.abs(value - (b.envelope[index] ?? 0)), 0) / Math.max(a.envelope.length, b.envelope.length));
  const weights = [1.8, 1.1, 1.1, 1, 0.7, 0.6, 0.8, 1.4, 1.8];
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const characterError = a.character.reduce((sum, value, index) => sum + Math.abs(value - (b.character[index] ?? 0)) * weights[index], 0);
  const character = Math.max(0, 1 - characterError / weightTotal);
  return spectrum * 0.55 + envelope * 0.22 + character * 0.23;
}
function updateSimilarityCacheStatus(): void {
  const status = document.getElementById('simcache');
  if (status) status.textContent = `${(soundFeatures.size + midiFeatures.size).toLocaleString()} files indexed`;
}
function cancelSimilarAnalysis(): void {
  similarAnalysisAbort?.abort(); similarAnalysisAbort = undefined; similarAnalysisGeneration++;
  const context = similarAnalysisContext; similarAnalysisContext = undefined;
  if (context && context.state !== 'closed') void context.close().catch(() => undefined);
}
async function renderSimilar(file: BrowserFile, folderOverride?: string): Promise<void> {
  cancelSimilarAnalysis();
  const generation = ++similarAnalysisGeneration;
  const controller = new AbortController();
  similarAnalysisAbort = controller;
  const isCurrent = () => generation === similarAnalysisGeneration && !controller.signal.aborted;
  const folderPath = folderOverride ?? currentFolder;
  const midiMode = kindOf(file) === 'MIDI';
  const matchKind = midiMode ? 'MIDI' : 'Audio';
  similarPaneOpen = true;
  const root = $('similarlist');
  $('list').hidden = true;
  $('similarpane').hidden = false;
  similarReferencePath = file.path;
  similarReferenceFile = file;
  similarAnalysisFolderPath = folderPath;
  similarMatches = [];
  $('simlabel').textContent = 'ANALYZING…';
  root.textContent = folderOverride ? `Scanning ${basename(folderOverride)}…` : midiMode ? 'Analyzing MIDI patterns locally…' : 'Analyzing sample features locally…';
  let candidates: BrowserFile[];
  if (folderOverride || settings.similarCurrentFolderOnly) {
    const source = folderPath ? await ensureTreeScan(folderPath) : files;
    if (!isCurrent()) return;
    candidates = source.filter((candidate) => candidate.path !== file.path && kindOf(candidate) === matchKind);
  } else {
    candidates = (settings.includeSubfolders && recursiveFiles.length ? recursiveFiles : files).filter((candidate) => candidate.path !== file.path && kindOf(candidate) === matchKind);
  }
  if (!folderOverride && !settings.similarCurrentFolderOnly && luna.gui.blessedFolders.value?.length) {
    try {
      const indexed = await Promise.all((luna.gui.blessedFolders.value ?? []).map(async (rootPath) => { try { return (await luna.gui.listAllFiles(rootPath)).files.filter((entry) => !entry.isDirectory && kindOf(entry) === matchKind); } catch { return []; } }));
      if (!isCurrent()) return;
      candidates = [...new Map(indexed.flat().map((item) => [item.path, item])).values()].filter((candidate) => candidate.path !== file.path);
    } catch { /* Older LUNA builds may not support recursive listing; use the visible folder. */ }
  }
  if (!isCurrent()) return;
  $('simlabel').textContent = midiMode ? 'MIDI MATCH' : 'ACOUSTIC MATCH';
  if (!candidates.length) { similarMatches = [{ file, score: 1 }]; renderSimilarRows(root); similarAnalysisAbort = undefined; return; }
  if (midiMode) {
    root.textContent = 'Analyzing MIDI note and rhythm patterns locally…';
    try {
      const reference = await midiFileFingerprint(file, controller.signal);
      if (!isCurrent()) return;
      const matches: { file: BrowserFile; score: number }[] = [];
      for (let i = 0; i < candidates.length; i++) {
        if (!isCurrent()) return;
        $('simlabel').textContent = `ANALYZING MIDI ${i + 1}/${candidates.length}`;
        try {
          const candidate = await midiFileFingerprint(candidates[i], controller.signal);
          if (!isCurrent()) return;
          matches.push({ file: candidates[i], score: midiSimilarity(reference, candidate) });
        } catch { if (!isCurrent()) return; /* Skip invalid or unreadable MIDI files. */ }
        if (i % 6 === 5) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (!isCurrent()) return;
      matches.sort((a, b) => b.score - a.score);
      $('simlabel').textContent = 'MIDI MATCH';
      similarMatches = [{ file, score: 1 }, ...matches.filter((match) => match.file.path !== file.path && match.score > 0).slice(0, 15)];
      renderSimilarRows(root);
    } catch (e) { if (isCurrent()) root.textContent = `Could not analyze this MIDI file: ${String((e as Error).message ?? e)}`; }
    finally {
      try { localStorage.setItem(midiFeatureCacheKey, JSON.stringify(Object.fromEntries(midiFeatures))); } catch { /* The local cache is optional. */ }
      updateSimilarityCacheStatus();
      if (similarAnalysisAbort === controller) similarAnalysisAbort = undefined;
    }
    return;
  }
  root.textContent = 'Analyzing sample features locally…';
  const Context = window.AudioContext;
  if (!Context) { root.textContent = 'Audio analysis is unavailable in this LUNA view.'; similarAnalysisAbort = undefined; return; }
  const context = new Context();
  similarAnalysisContext = context;
  try {
    const reference = await audioFingerprint(file, context, controller.signal);
    if (!isCurrent()) return;
    const matches: { file: BrowserFile; score: number }[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (!isCurrent()) return;
      $('simlabel').textContent = `ANALYZING ${i + 1}/${candidates.length}`;
      try {
        const candidate = await audioFingerprint(candidates[i], context, controller.signal);
        if (!isCurrent()) return;
        const acousticScore = fingerprintSimilarity(reference, candidate);
        const lengthPenalty = reference.duration && candidate.duration
          ? Math.exp(-0.25 * Math.abs(Math.log2(reference.duration / candidate.duration)))
          : 1;
        matches.push({ file: candidates[i], score: acousticScore * lengthPenalty });
      }
      catch { if (!isCurrent()) return; /* Skip files this browser cannot decode. */ }
    }
    if (!isCurrent()) return;
    matches.sort((a, b) => b.score - a.score);
    $('simlabel').textContent = 'ACOUSTIC MATCH';
    similarMatches = [{ file, score: 1 }, ...matches.filter((match) => match.file.path !== file.path && match.score > 0).slice(0, 15)];
    if (!similarMatches.length) { root.textContent = 'No compatible audio samples could be analyzed.'; return; }
    renderSimilarRows(root);
  } catch (e) { if (isCurrent()) root.textContent = `Could not analyze this sample: ${String((e as Error).message ?? e)}`; }
  finally {
    try { localStorage.setItem(featureCacheKey, JSON.stringify(Object.fromEntries(soundFeatures))); } catch { /* A full local storage quota only disables persistence of new fingerprints. */ }
    try { localStorage.setItem(durationCacheKey, JSON.stringify(Object.fromEntries(soundDurations))); } catch { /* A full local storage quota only disables persistence of new durations. */ }
    if (similarAnalysisContext === context) similarAnalysisContext = undefined;
    try { if (context.state !== 'closed') await context.close(); } catch { /* Cancellation may have closed the context already. */ }
    if (similarAnalysisAbort === controller) similarAnalysisAbort = undefined;
  }
}
function selectSimilarResult(index: number): void {
  if (!similarMatches.length) return;
  const targetIndex = Math.max(0, Math.min(similarMatches.length - 1, index));
  const file = similarMatches[targetIndex]?.file;
  if (!file) return;
  const generation = ++similarSelectionGeneration;
  const root = $('similarlist');
  selected = file;
  renderList();
  renderSimilarRows(root);
  const focusSelected = () => {
    const row = root.querySelector<HTMLElement>('.simrow.selected');
    if (!row) return;
    const rootRect = root.getBoundingClientRect(), rowRect = row.getBoundingClientRect();
    if (rowRect.top < rootRect.top) root.scrollTop -= rootRect.top - rowRect.top;
    else if (rowRect.bottom > rootRect.bottom) root.scrollTop += rowRect.bottom - rootRect.bottom;
    row.focus({ preventScroll: true });
  };
  focusSelected();
  void (async () => {
    if (midiPreviewEnabled || midiPreviewClip) await stopMidiPreview();
    if (generation !== similarSelectionGeneration) return;
    await renderSound(true);
    if (generation !== similarSelectionGeneration) return;
    focusSelected();
    if (kindOf(file) === 'MIDI') await previewMidiFile(file);
  })();
}
function renderSimilarRows(root: HTMLElement): void {
  if (!similarMatches.length) { root.replaceChildren(); return; }
  root.className = 'similar-results';
  const priorScroll = root.scrollTop;
  root.replaceChildren(...similarMatches.map(({ file, score }, index) => {
    const row = document.createElement('div'); row.className = `simrow${selected?.path === file.path ? ' selected' : ''}`; row.tabIndex = 0; row.dataset.index = String(index); row.setAttribute('role', 'option'); row.title = 'Select and preview this sample';
    row.innerHTML = `<span>${esc(file.name)}</span><span class="score"><i style="width:${Math.round(score * 100)}%"></i></span><span class="hint">${Math.round(score * 100)}%</span>`;
    row.onclick = () => { row.focus({ preventScroll: true }); selectSimilarResult(index); };
    row.onkeydown = (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); event.stopPropagation();
      selectSimilarResult(index + (event.key === 'ArrowDown' ? 1 : -1));
    };
    return row;
  }));
  root.scrollTop = priorScroll;
}
async function stopPreviewWhenAdding(): Promise<void> {
  if (!settings.stopPreviewOnAdd) return;
  const audio = $('audio', HTMLAudioElement);
  audio.pause(); audio.currentTime = 0;
  const previewButton = document.getElementById('preview');
  if (previewButton) { previewButton.textContent = '▶ Preview'; previewButton.classList.remove('is-playing'); }
  if (midiPreviewEnabled || midiPreviewClip) await stopMidiPreview();
}
async function importSound(file: BrowserFile): Promise<void> {
  if (!session) { say('Open a LUNA session before importing.', true); return; }
  const track = selectedTrack();
  if (!track) { say('Select a destination track in LUNA, then add this sound.', true); return; }
  const expected = kindOf(file) === 'MIDI' ? 'instrument' : 'audio';
  if (track.trackType.value !== expected) { say(`Select a ${expected} track to add this ${kindOf(file).toLowerCase()} file.`, true); return; }
  const cursorBeforeImport = session.transport.playing.value === true ? undefined : session.transport.tick;
  const selectionBeforeImport = session.context.snapshot();
  try {
    await luna.gui.available();
    const tempoFit = await importFileToTrack(file, track);
    await stopPreviewWhenAdding();
    await session.context.restore(selectionBeforeImport);
    if (cursorBeforeImport !== undefined) await session.transport.setPlayStart(cursorBeforeImport);
    say(`Imported ${file.name} onto ${track.name.value ?? 'selected track'}${tempoFit.note ? ` · ${tempoFit.note}` : ''}.`);
  }
  catch (e) { say(`Import failed: ${String((e as Error).message ?? e)}`, true); }
}
async function importToNewTrack(file: BrowserFile): Promise<void> {
  if (!session) { say('Open a LUNA session before importing.', true); return; }
  if (file.isDirectory) return;
  try {
    if (kindOf(file) === 'Audio' && !filterMetadata.has(file.path)) {
      const url = await luna.gui.serveMediaFile('com.fourdogslong.file_browser', file.path);
      const bytes = await fileBytes(url); const info = audioHeaderInfo(bytes, file.name); rememberMetadata(file.path, info);
    }
    const format = kindOf(file) === 'MIDI' ? 'stereo' : (filterMetadata.get(file.path)?.channels === 1 ? 'mono' : 'stereo');
    const [track] = await session.newTrack({ name: file.name.replace(/\.[^.]+$/, ''), trackType: kindOf(file) === 'MIDI' ? 'instrument' : 'audio', stemFormat: format, makeNameUnique: true });
    if (!track) throw new Error('LUNA did not create a track.');
    const tempoFit = await importFileToTrack(file, track);
    await stopPreviewWhenAdding();
    say(`Created ${format} ${kindOf(file).toLowerCase()} track and imported ${file.name}${tempoFit.note ? ` · ${tempoFit.note}` : ''}.`);
  } catch (e) { say(`Could not create a track for this file: ${String((e as Error).message ?? e)}`, true); }
}
async function waitForTrackPlaylist(trackId: string): Promise<Luna.Playlist> {
  if (!session) throw new Error('Open a LUNA session first.');
  await session.playlists.load(); await session.playlists.membersReady();
  await Luna.settle(() => session!.playlists.items.some((lane) => lane.trackUid.value === trackId), 'track playlist', { refresh: () => session!.playlists.load() });
  const lane = session.playlists.items.find((item) => item.trackUid.value === trackId);
  if (!lane) throw new Error('LUNA did not create a playlist for the instrument track.');
  await lane.clips.load(); await lane.clips.membersReady();
  return lane;
}
async function importFileToTrack(file: BrowserFile, track: Luna.Track): Promise<{ note?: string }> {
  if (!session) throw new Error('Open a LUNA session first.');
  const audio = kindOf(file) === 'Audio';
  const bpm = audio && settings.syncSessionTempo ? await audioFileBpm(file).catch(() => undefined) : undefined;
  let lane: Luna.Playlist | undefined;
  let priorClipIds = new Set<string>();
  if (bpm) {
    lane = await waitForTrackPlaylist(track.id);
    priorClipIds = new Set(lane.clips.items.map((clip) => clip.id));
  }
  await session.importFile(file.path, track.id);
  if (!audio || !settings.syncSessionTempo) return {};
  if (!bpm || !lane) return { note: 'no file BPM found; original duration kept' };
  let imported: Luna.Clip | undefined;
  for (let attempt = 0; attempt < 20 && !imported; attempt++) {
    await lane.clips.load(); await lane.clips.membersReady();
    imported = lane.clips.items.find((clip) => !priorClipIds.has(clip.id) && clip.clipType.value === 'audio');
    if (!imported) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const start = imported?.start.value;
  const sourceStart = imported?.sourceStart.value, sourceStop = imported?.sourceStop.value;
  if (!imported || start === undefined || sourceStart === undefined || sourceStop === undefined || sourceStop <= sourceStart) {
    return { note: `file BPM ${bpm} detected, but LUNA did not expose the imported clip for tempo fitting` };
  }
  const beats = (sourceStop - sourceStart) / 1e9 * bpm / 60;
  const stop = start + Math.round(beats * Luna.TICKS_PER_BEAT);
  if (!Number.isFinite(stop) || stop <= start) return { note: `file BPM ${bpm} detected, but its duration could not be fit` };
  await imported.trim(start, stop, { stretch: true });
  const sessionBpm = session.transport.tempo.value;
  return { note: sessionBpm ? `tempo-fit ${bpm} → ${sessionBpm} BPM` : `tempo-fit from ${bpm} BPM to the session tempo` };
}
async function previewMidiFile(file: BrowserFile): Promise<void> {
  if (!session) { say('Open a LUNA session before previewing MIDI.', true); return; }
  const source = selectedTrack();
  if (!source || source.trackType.value !== 'instrument') { say('Please select an instrument track to preview MIDI file.', true); return; }
  if (midiPreviewEnabled && midiPreviewPath === file.path) {
    if (session.transport.playing.value === true) { await stopMidiPreview(); return; }
    if (midiPreviewClip) {
      await setMidiPreviewLoop(settings.loop);
      await session.transport.seek(midiPreviewClip.start.value ?? midiPreviewPlayhead ?? 0);
      await session.transport.play();
      if (settings.loop) await setMidiPreviewLoop(true);
      updateMidiPreviewButton(); return;
    }
    await stopMidiPreview();
  }
  if (midiPreviewEnabled || midiPreviewClip) await stopMidiPreview();
  let importAccepted = false;
  try {
    midiPreviewPlayhead = session.transport.tick;
    midiPreviewLoop = { start: session.transport.loopStart.value ?? 0, stop: session.transport.loopStop.value ?? 0, enabled: session.transport.looping.value === true };
    await session.selectTimeline({ tracks: [source] });
    let importedLane = await waitForTrackPlaylist(source.id);
    const priorClipIds = new Set(importedLane.clips.items.map((clip) => clip.id));
    await session.importFile(file.path, source.id);
    importAccepted = true;
    importedLane = await waitForTrackPlaylist(source.id);
    await importedLane.clips.load(); await importedLane.clips.membersReady();
    let previewClip = importedLane.clips.items.find((clip) => !priorClipIds.has(clip.id) && clip.clipType.value === 'midi');
    for (let attempt = 0; !previewClip && attempt < 12; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await importedLane.clips.load(); await importedLane.clips.membersReady();
      previewClip = importedLane.clips.items.find((clip) => !priorClipIds.has(clip.id) && clip.clipType.value === 'midi');
    }
    if (!previewClip) { midiPreviewEnabled = true; midiPreviewUndoFallback = true; midiPreviewPath = file.path; updateMidiPreviewButton(); say(`${file.name} was imported onto ${source.name.value ?? 'the selected track'}, but LUNA has not exposed its clip yet. Audition is on; turn it off to remove the import.`); return; }
    midiPreviewClip = previewClip;
    midiPreviewEnabled = true; midiPreviewPath = file.path; updateMidiPreviewButton();
    await setMidiPreviewLoop(settings.loop); await session.transport.seek(previewClip.start.value ?? midiPreviewPlayhead ?? 0);
    if (session.transport.playing.value !== true) await session.transport.play();
    if (settings.loop) await setMidiPreviewLoop(true);
    say(`Auditioning ${file.name} on ${source.name.value ?? 'selected instrument track'} · On.`);
  } catch (e) {
    if (importAccepted && midiPreviewClip) { midiPreviewEnabled = true; midiPreviewPath = file.path; updateMidiPreviewButton(); say(`MIDI was imported, but playback did not start. Audition remains on; turn it off to remove the preview clip.`, true); }
    else { await stopMidiPreview(); say(`MIDI preview failed: ${String((e as Error).message ?? e)}`, true); }
  }
}
function updateMidiPreviewButton(): void {
  const button = document.getElementById('previewmidi');
  if (!button) return;
  const playing = midiPreviewEnabled && session?.transport.playing.value === true;
  button.setAttribute('aria-pressed', String(playing));
  button.classList.toggle('is-playing', playing);
  button.textContent = playing ? 'Ⅱ Pause' : '▶ Preview';
}
async function setMidiPreviewLoop(enabled: boolean): Promise<void> {
  if (!session || !midiPreviewEnabled || !midiPreviewClip) return;
  try {
    if (enabled) {
      const start = midiPreviewClip.start.value ?? 0, stop = midiPreviewClip.stop.value ?? 0;
      if (stop > start) await session.transport.setLoop(start, stop);
    }
    await session.transport.looping.set(enabled);
  } catch (e) { say(`Could not update MIDI preview loop: ${String((e as Error).message ?? e)}`, true); }
}
async function stopMidiPreview(): Promise<void> {
  if (midiPreviewCleanupInProgress) return;
  midiPreviewCleanupInProgress = true;
  const clip = midiPreviewClip; midiPreviewClip = undefined; midiPreviewEnabled = false; updateMidiPreviewButton();
  try {
    if (session) {
      if (session.transport.playing.value === true) await session.transport.stop();
      if (clip) await clip.delete();
      else if (midiPreviewUndoFallback) await session.undo();
      if (midiPreviewPlayhead !== undefined) await session.transport.seek(midiPreviewPlayhead);
      if (midiPreviewLoop) {
        if (midiPreviewLoop.stop > midiPreviewLoop.start) await session.transport.setLoop(midiPreviewLoop.start, midiPreviewLoop.stop);
        await session.transport.looping.set(midiPreviewLoop.enabled);
      }
      say('MIDI preview paused · preview clip removed.');
    }
  } catch (e) { say(`Could not remove the MIDI preview clip: ${String((e as Error).message ?? e)}`, true); }
  finally {
    midiPreviewUndoFallback = false; midiPreviewPath = ''; midiPreviewPlayhead = undefined; midiPreviewLoop = undefined;
    midiPreviewCleanupInProgress = false; updateMidiPreviewButton();
  }
}

function showFolderContext(event: MouseEvent, path: string): void {
  const menu = $('foldercontext'); menu.replaceChildren(); menu.hidden = false; menu.style.left = `${Math.min(event.clientX, innerWidth - 175)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 100)}px`;
  const reveal = document.createElement('button'); reveal.textContent = 'Reveal in Finder'; reveal.onclick = () => { menu.hidden = true; void luna.gui.revealPath(path).catch((e) => say(`Could not reveal folder: ${String((e as Error).message ?? e)}`, true)); }; menu.append(reveal);
  const open = document.createElement('button'); open.textContent = 'Search this folder'; open.onclick = () => { menu.hidden = true; currentFolder = path; void loadFolder(path, false); }; menu.append(open);
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  const blessedRoot = (luna.gui.blessedFolders.value ?? []).find((root) => normalize(root) === normalize(path));
  if (blessedRoot) {
    const remove = document.createElement('button'); remove.textContent = 'Remove from Places';
    remove.onclick = () => { menu.hidden = true; void removePlace(blessedRoot); }; menu.append(remove);
  }
}
function showFileContext(event: MouseEvent, file: BrowserFile): void {
  const menu = $('foldercontext'); menu.replaceChildren(); menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, innerWidth - 175)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 100)}px`;
  const action = (label: string, run: () => void) => { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { menu.hidden = true; run(); }; menu.append(button); };
  action('Reveal in Finder', () => { void luna.gui.revealPath(file.path).catch((e) => say(`Could not reveal file: ${String((e as Error).message ?? e)}`, true)); });
  action('Select for preview', () => { void (async () => { if (midiPreviewEnabled || midiPreviewClip) await stopMidiPreview(); selected = file; renderList(); await renderSound(); })(); });
}
async function bindSession(): Promise<void> {
  for (const off of sessionReleases) off(); sessionReleases = [];
  session = luna.sessions.current();
  if (!session) { browserStore = undefined; return; }
  await session.ready();
  await loadBrowserState(session);
  keep(session.transport.playing.onChange(() => {
    updateMidiPreviewButton();
    if (session?.transport.playing.value !== true) {
      stopSyncedAudioPreview?.();
      if (midiPreviewEnabled && !midiPreviewCleanupInProgress) void stopMidiPreview();
    }
  }));
  const folders = luna.gui.blessedFolders.value ?? [];
  currentFolder = currentFolder && folders.includes(currentFolder) ? currentFolder : folders[0] ?? '';
  renderFolders();
  if (currentFolder) { if (loadedFolder !== currentFolder) await loadFolder(currentFolder); }
  else say('Add a sound folder in Places to browse your library.');
}

async function connect(): Promise<void> {
  try {
    luna = await Luna.connect();
    const shortcut = Luna.bindShortcuts(luna);
    if (!shortcut.installed && !spaceShortcutInstalled) {
      spaceShortcutInstalled = true;
      window.addEventListener('keydown', (event) => {
        if (event.code !== 'Space' || event.repeat || event.defaultPrevented || event.isComposing) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('input,textarea,select,dialog[open],[contenteditable="true"],[data-renaming="true"]')) return;
        const active = luna.sessions.current();
        if (!active) return;
        event.preventDefault(); event.stopPropagation();
        void active.transport.toggle().catch((error) => say(`Could not toggle LUNA playback: ${String((error as Error).message ?? error)}`, true));
      }, true);
    }
    await luna.gui.available();
    await luna.gui.watchBlessedFolders();
    if (Luna.canDropPaths()) {
      Luna.onPathDrop({
        drop: async ({ paths }) => {
          const track = selectedTrack();
          if (!session || !track) { say('Select a destination track in LUNA before dropping files.', true); return; }
          for (const path of paths) {
            try { await session.importFile(path, track.id); say(`Imported ${basename(path)} onto ${track.name.value ?? 'selected track'}.`); }
            catch (e) { say(`Could not import ${basename(path)}: ${String((e as Error).message ?? e)}`, true); }
          }
        },
      });
    }
    luna.gui.blessedFolders.onChange(() => { renderFolders(); if (!currentFolder) { currentFolder = luna.gui.blessedFolders.value?.[0] ?? ''; if (currentFolder) void loadFolder(currentFolder); } });
    const savedFolders = luna.gui.blessedFolders.value ?? [];
    renderFolders();
    if (!currentFolder && savedFolders.length) { currentFolder = savedFolders[0]; await loadFolder(currentFolder); }
    await luna.sessions.ready();
    luna.sessions.focused.onChange(() => void bindSession());
    luna.sessions.items.onChange(() => void bindSession());
    await bindSession();
  } catch (e) { say(`Cannot connect to LUNA: ${String((e as Error).message ?? e)}`, true); }
}
$('addfolder').onclick = () => void addFolder();
$('list').addEventListener('scroll', () => { if (!listScrollFrame) listScrollFrame = requestAnimationFrame(() => { listScrollFrame = 0; renderListWindow(); }); });
$('search').addEventListener('input', refreshAudioMetadataIndex);
$('sort').addEventListener('change', () => renderList());
function renderSortTiles(): void {
  const select = $('sort', HTMLSelectElement), root = $('sorttiles');
  root.replaceChildren(...[...select.options].map((option) => {
    const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'categorytile sorttile'; tile.textContent = option.text; tile.setAttribute('aria-pressed', String(option.value === select.value));
    tile.onclick = () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); renderSortTiles(); };
    return tile;
  }));
}
renderSortTiles();
for (const tile of document.querySelectorAll<HTMLButtonElement>('[data-filter-channel],[data-filter-group],[data-filter-color]')) tile.onclick = () => {
  if (tile.dataset.filterChannel) tile.setAttribute('aria-pressed', String(tile.getAttribute('aria-pressed') !== 'true'));
  else if (tile.dataset.filterColor) tile.setAttribute('aria-pressed', String(tile.getAttribute('aria-pressed') !== 'true'));
  else {
    const group = tile.dataset.filterGroup ?? '';
    const wasSelected = tile.getAttribute('aria-pressed') === 'true';
    for (const option of document.querySelectorAll<HTMLButtonElement>(`[data-filter-group="${group}"]`)) option.setAttribute('aria-pressed', String(option === tile && !wasSelected));
  }
  refreshAudioMetadataIndex();
};
function toggleResultTab(tab: 'filters' | 'sort'): void {
  const filterTab = $('filterbutton'), sortTab = $('sort-toggle');
  const selectedTab = tab === 'filters' ? filterTab : sortTab;
  const open = selectedTab.getAttribute('aria-expanded') !== 'true';
  $('filterpanel').hidden = !open || tab !== 'filters';
  $('sortcontrol').hidden = !open || tab !== 'sort';
  filterTab.setAttribute('aria-expanded', String(open && tab === 'filters'));
  sortTab.setAttribute('aria-expanded', String(open && tab === 'sort'));
  filterTab.setAttribute('aria-selected', String(open && tab === 'filters'));
  sortTab.setAttribute('aria-selected', String(open && tab === 'sort'));
}
function clearAllFilters(): void {
  view = 'All'; favoriteOnly = false;
  for (const tile of document.querySelectorAll<HTMLButtonElement>('[data-filter-channel],[data-filter-group],[data-filter-color],[data-favorite-only]')) tile.setAttribute('aria-pressed', 'false');
  for (const tile of document.querySelectorAll<HTMLButtonElement>('[data-kind]')) tile.setAttribute('aria-pressed', 'false');
  refreshAudioMetadataIndex();
}
$('filterbutton').onclick = (event) => {
  if ((event.target as HTMLElement).closest('#clearfilters')) { event.stopPropagation(); clearAllFilters(); return; }
  toggleResultTab('filters');
};
$('sort-toggle').onclick = () => toggleResultTab('sort');
$('similarclose').onclick = () => { cancelSimilarAnalysis(); similarPaneOpen = false; similarReferenceFile = undefined; similarAnalysisFolderPath = ''; $('similarpane').hidden = true; $('list').hidden = false; $('simlabel').textContent = ''; similarMatches = []; similarReferencePath = ''; renderList(); };
for (const el of document.querySelectorAll<HTMLButtonElement>('[data-kind]')) el.onclick = () => {
  const next = el.dataset.kind ?? 'All';
  setView(view === next ? 'All' : next);
};
for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-filter-toggle]')) toggle.onclick = () => {
  const content = document.getElementById(toggle.dataset.filterToggle ?? '');
  if (!content) return;
  content.hidden = !content.hidden;
  const expanded = !content.hidden;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = `${expanded ? '▾' : '▸'} ${toggle.dataset.label ?? ''}`;
};
for (const tile of document.querySelectorAll<HTMLButtonElement>('[data-favorite-only]')) tile.onclick = () => {
  favoriteOnly = !favoriteOnly;
  tile.setAttribute('aria-pressed', String(favoriteOnly));
  refreshAudioMetadataIndex();
};
function setView(next: string): void {
  if (midiPreviewEnabled || midiPreviewClip) void stopMidiPreview();
  view = next;
  $('soundpane').hidden = false;
  document.querySelector('.places')!.removeAttribute('hidden');
  $('places-resizer').hidden = false; $('preview-resizer').hidden = false;
  for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-kind]')) chip.setAttribute('aria-pressed', String(chip.dataset.kind === next));
  refreshAudioMetadataIndex();
}
$('refresh').onclick = () => { if (currentFolder) void loadFolder(currentFolder); };
$('settings').onclick = () => $('settingsdialog', HTMLDialogElement).showModal();
$('closesettings').onclick = () => $('settingsdialog', HTMLDialogElement).close();
$('panelbackground', HTMLSelectElement).value = settings.background;
document.documentElement.dataset.background = settings.background;
$('panelbackground', HTMLSelectElement).addEventListener('change', () => {
  settings.background = $('panelbackground', HTMLSelectElement).value;
  document.documentElement.dataset.background = settings.background;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
});
$('help').onclick = () => $('helpdialog', HTMLDialogElement).showModal();
$('closehelp').onclick = () => $('helpdialog', HTMLDialogElement).close();
function renderAccentPalette(): void {
  const root = $('accentpalette');
  root.replaceChildren(...LUNA_PALETTE.map((color) => {
    const button = document.createElement('button'); button.type = 'button'; button.title = color; button.setAttribute('aria-label', `Accent ${color}`); button.style.setProperty('--swatch', color); button.setAttribute('aria-pressed', String(settings.accent === color));
    button.onclick = () => {
      settings.accent = color;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      document.documentElement.style.setProperty('--active', color);
      renderAccentPalette(); renderFolders();
    };
    return button;
  }));
}
function saveSettings(): void {
  settings = {
    ...settings,
    previewPath: $('previewpath', HTMLInputElement).checked,
    interfaceZoom: Number($('interfacezoom', HTMLInputElement).value),
    ignoreTypes: $('ignoretypes', HTMLInputElement).value,
    ignoreFolders: $('ignorefolders', HTMLInputElement).value,
    showEmpty: $('showempty', HTMLInputElement).checked,
    singleExpand: $('singleexpand', HTMLInputElement).checked,
    includeSubfolders: $('recursive', HTMLInputElement).checked,
    stopPreviewOnAdd: $('stoppreviewonadd', HTMLInputElement).checked,
    doubleClickImport: $('doubleclickimport', HTMLInputElement).checked,
    similarCurrentFolderOnly: $('similarcurrent', HTMLInputElement).checked,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  document.documentElement.style.setProperty('--active', settings.accent);
  document.documentElement.style.setProperty('--interface-zoom', String(settings.interfaceZoom));
  $('interfacezoomvalue').textContent = `${Math.round(settings.interfaceZoom * 100)}%`;
  renderFolders();
  if (selected) { const path = document.querySelector<HTMLElement>('#sounddetail .path'); if (path) { path.hidden = !settings.previewPath; path.textContent = settings.previewPath ? selected.path : ''; } }
}
async function applyFolderFilters(): Promise<void> {
  saveSettings();
  folderHasContent.clear(); placeChildren.clear(); loadedFolderListings.clear(); folderListingPromises.clear(); folderSearchScanPromise = undefined;
  recursiveFiles = []; knownFolders.clear(); collapsedFolders.clear(); treeScanPromise = undefined; treeScanPath = ''; ++treeScanGeneration;
  const roots = (luna.gui.blessedFolders.value ?? []).filter((path) => !isIgnoredFolder(basename(path)));
  if (currentFolder && isIgnoredFolderPath(currentFolder)) currentFolder = roots[0] ?? '';
  renderFolders();
  try {
    for (const root of roots) await loadPlaceChildren(root);
    if (currentFolder) {
      const root = roots.filter((path) => isWithinFolder(currentFolder, path)).sort((a, b) => b.length - a.length)[0];
      if (root) {
        let parent = root;
        collapsedFolders.delete(parent);
        const relative = currentFolder.slice(root.length).split(/[\\/]/).filter(Boolean);
        for (const segment of relative) {
          await loadPlaceChildren(parent);
          const child = (placeChildren.get(parent) ?? []).find((path) => basename(path).toLocaleLowerCase() === segment.toLocaleLowerCase());
          if (!child) break;
          parent = child; collapsedFolders.delete(parent);
        }
      }
      await loadFolder(currentFolder);
    }
    renderFolders();
  } catch (error) { say(`Could not apply folder filters: ${String((error as Error).message ?? error)}`, true); }
}
$('applyfilters').onclick = () => { void applyFolderFilters(); };
$('previewpath', HTMLInputElement).checked = settings.previewPath;
$('singleexpand', HTMLInputElement).checked = settings.singleExpand;
$('recursive', HTMLInputElement).checked = settings.includeSubfolders;
$('stoppreviewonadd', HTMLInputElement).checked = settings.stopPreviewOnAdd;
$('doubleclickimport', HTMLInputElement).checked = settings.doubleClickImport;
$('similarcurrent', HTMLInputElement).checked = settings.similarCurrentFolderOnly;
$('ignoretypes', HTMLInputElement).value = settings.ignoreTypes;
$('ignorefolders', HTMLInputElement).value = settings.ignoreFolders;
$('showempty', HTMLInputElement).checked = settings.showEmpty;
document.documentElement.style.setProperty('--active', settings.accent);
document.documentElement.style.setProperty('--interface-zoom', String(settings.interfaceZoom));
 $('interfacezoom', HTMLInputElement).value = String(settings.interfaceZoom);
 $('interfacezoomvalue').textContent = `${Math.round(settings.interfaceZoom * 100)}%`;
renderAccentPalette();
if (settings.placesSize) document.documentElement.style.setProperty('--places-size', `${settings.placesSize}px`);
if (settings.previewSize) document.documentElement.style.setProperty('--preview-size', `${settings.previewSize}px`);
for (const id of ['previewpath','ignoretypes','ignorefolders','showempty','singleexpand','similarcurrent','stoppreviewonadd','doubleclickimport']) $(id).addEventListener('input', saveSettings);
$('interfacezoom').addEventListener('input', () => {
  settings.interfaceZoom = Number($('interfacezoom', HTMLInputElement).value);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  document.documentElement.style.setProperty('--interface-zoom', String(settings.interfaceZoom));
  $('interfacezoomvalue').textContent = `${Math.round(settings.interfaceZoom * 100)}%`;
});
$('recursive').addEventListener('change', async () => { settings.includeSubfolders = $('recursive', HTMLInputElement).checked; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); if (settings.includeSubfolders && currentFolder) { try { await ensureTreeScan(currentFolder); } catch (e) { say(`Could not search subfolders: ${String((e as Error).message ?? e)}`, true); } } renderList(); });
$('foldersearch').addEventListener('input', () => {
  const query = $('foldersearch', HTMLInputElement).value.trim();
  renderFolders();
  if (query && !folderSearchScanPromise) {
    const roots = luna.gui.blessedFolders.value ?? [];
    folderSearchScanPromise = Promise.all(roots.map((path) => scanTree(path))).then(() => { renderFolders(); }).catch((e) => say(`Could not search folder names: ${String((e as Error).message ?? e)}`, true)).finally(() => { folderSearchScanPromise = undefined; });
  }
});
window.addEventListener('keydown', (event) => {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const search = $('search', HTMLInputElement); search.focus({ preventScroll: true }); search.select();
    return;
  }
  const editingText = target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));
  const searchField = target instanceof Element && target.matches('#search');
  if (!editingText && !$('settingsdialog', HTMLDialogElement).open && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && selected && !$('soundpane').hidden) {
    if (event.key === '0') {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); toggleFavorite(selected); return;
    }
    const colorIndex = Number(event.key) - 1;
    if (Number.isInteger(colorIndex) && colorIndex >= 0 && colorIndex < LUNA_PALETTE.length) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); toggleFileColor(selected, LUNA_PALETTE[colorIndex]!); return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !event.altKey && !event.shiftKey && (!editingText || searchField)) {
    let row = [...$('folders').querySelectorAll<HTMLElement>('.folder[data-path]')].find((item) => item.dataset.path === currentFolder);
    if (!row) return;
    const path = currentFolder;
    const wantsExpand = event.key === 'ArrowRight';
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    void (async () => {
      if (wantsExpand && !loadedFolderListings.has(path)) await loadPlaceChildren(path);
      const children = placeChildren.get(path) ?? [];
      if (!children.length) return;
      const collapsed = collapsedFolders.has(path);
      row = [...$('folders').querySelectorAll<HTMLElement>('.folder[data-path]')].find((item) => item.dataset.path === path);
      if (wantsExpand && collapsed || !wantsExpand && !collapsed) row?.querySelector<HTMLButtonElement>('.foldertoggle')?.click();
      focusFolderRow(path);
    })();
    return;
  }
  if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && (!editingText || searchField)) {
    const rows = [...$('folders').querySelectorAll<HTMLElement>('.folder[data-path]')];
    if (!rows.length) return;
    const current = rows.findIndex((row) => row.dataset.path === currentFolder);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = current < 0 ? (direction > 0 ? 0 : rows.length - 1) : current + direction;
    if (nextIndex < 0 || nextIndex >= rows.length || nextIndex === current) return;
    const path = rows[nextIndex]?.dataset.path;
    if (!path) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    void selectPlace(path, false);
    return;
  }
}, { capture: true });
window.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const target = event.target instanceof Element ? event.target : document.activeElement;
  const searchField = target?.matches('#search');
  const textEditor = target?.closest('textarea,[contenteditable="true"],input:not([type=button]):not([type=checkbox]):not([type=range])');
  if (!searchField && textEditor) return;
  if ($('soundpane').hidden) return;
  if (!$('similarpane').hidden && similarMatches.length) {
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const focusedSimilarRow = target?.closest<HTMLElement>('.simrow[data-index]');
    const current = focusedSimilarRow ? Number(focusedSimilarRow.dataset.index) : similarMatches.findIndex(({ file }) => file.path === selected?.path);
    const nextIndex = current < 0 ? (event.key === 'ArrowDown' ? 0 : similarMatches.length - 1) : current + (event.key === 'ArrowDown' ? 1 : -1);
    selectSimilarResult(nextIndex);
    return;
  }
  if (!visibleFiles.length) return;
  event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
  const currentIndex = visibleFiles.findIndex((file) => file.path === selected?.path);
  const index = currentIndex < 0 ? (event.key === 'ArrowDown' ? 0 : visibleFiles.length - 1) : Math.max(0, Math.min(visibleFiles.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)));
  const next = visibleFiles[index];
  if (!next) return;
  const priorPath = selected?.path;
  void (async () => {
    if (midiPreviewEnabled && (kindOf(next) !== 'MIDI' || midiPreviewPath !== next.path)) await stopMidiPreview();
    selected = next;
    const list = $('list'), rowHeight = 22, viewportHeight = list.clientHeight || 280;
    const selectedTop = index * rowHeight, selectedBottom = selectedTop + rowHeight;
    if (selectedTop < list.scrollTop) list.scrollTop = selectedTop;
    else if (selectedBottom > list.scrollTop + viewportHeight) list.scrollTop = selectedBottom - viewportHeight;
    renderList();
    list.querySelector<HTMLElement>('.soundfile-row.selected')?.focus({ preventScroll: true });
    await renderSound(kindOf(next) === 'Audio');
    if (kindOf(next) === 'MIDI' && next.path !== priorPath) await previewMidiFile(next);
  })();
}, { capture: true });

function installPaneResizer(id: string, pane: HTMLElement, setting: 'placesSize' | 'previewSize', direction: 1 | -1): void {
  const handle = $(id);
  handle.addEventListener('pointerdown', (event) => {
    const startY = event.clientY, startHeight = pane.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const max = Math.max(100, innerHeight - 180);
      const size = Math.max(68, Math.min(max, startHeight + (moveEvent.clientY - startY) * direction));
      settings[setting] = size;
      document.documentElement.style.setProperty(setting === 'placesSize' ? '--places-size' : '--preview-size', `${size}px`);
    };
    const finish = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  });
}
$('app').addEventListener('pointerdown', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('input,textarea,select,[contenteditable="true"]')) $('app').focus({ preventScroll: true });
}, true);
installPaneResizer('places-resizer', document.querySelector('.places') as HTMLElement, 'placesSize', 1);
installPaneResizer('preview-resizer', $('sounddetail'), 'previewSize', -1);
document.addEventListener('pointerdown', (event) => { if (!($('foldercontext').contains(event.target as Node))) $('foldercontext').hidden = true; });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('foldercontext').hidden = true; });
updateSimilarityCacheStatus();
void connect();
requestAnimationFrame(() => $('search', HTMLInputElement).focus());
