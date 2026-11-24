/** Shared file classification and filtering helpers for the LUNA UI. */
export type SoundKind = 'Audio' | 'MIDI' | 'Folder' | 'Other';
export interface BrowserFile { name: string; path: string; isDirectory: boolean }
export function kindOf(file: BrowserFile): SoundKind {
  if (file.isDirectory) return 'Folder';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'caf', 'flac'].includes(ext)) return 'Audio';
  if (['mid', 'midi'].includes(ext)) return 'MIDI';
  return 'Other';
}
export function durationText(seconds?: number): string {
  if (!Number.isFinite(seconds) || !seconds) return '—';
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
export function filterFiles(files: readonly BrowserFile[], query: string, kind: string, favorites: ReadonlySet<string>): BrowserFile[] {
  const tokens = query.match(/"[^"]*"|\S+/g)?.map((token) => token.replace(/^"|"$/g, '').toLocaleLowerCase()).filter(Boolean) ?? [];
  const excluded = tokens.filter((token) => token.startsWith('-') && token.length > 1).map((token) => token.slice(1));
  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token.startsWith('-') && token.length > 1) continue;
    if (token === 'or') { if (groups.at(-1)?.length) groups.push([]); continue; }
    groups.at(-1)?.push(token);
  }
  const included = groups.filter((group) => group.length > 0);
  return files.filter((file) => {
    if (kind === 'Favorites' && !favorites.has(file.path)) return false;
    if (kind !== 'All' && kind !== 'Favorites' && kindOf(file) !== kind) return false;
    const name = file.name.toLocaleLowerCase();
    if (excluded.some((term) => name.includes(term))) return false;
    return !included.length || included.some((group) => group.every((term) => name.includes(term)));
  });
}
