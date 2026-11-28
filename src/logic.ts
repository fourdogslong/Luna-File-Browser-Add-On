/** Shared file classification and filtering helpers for the LUNA UI. */
export type SoundKind = 'Audio' | 'MIDI' | 'Folder' | 'Other';
export interface BrowserFile { name: string; path: string; isDirectory: boolean }
export interface MidiFingerprint {
  pitchClasses: number[];
  intervals: number[];
  onsetGaps: number[];
  noteLengths: number[];
  beatPositions: number[];
  noteCount: number;
  durationBeats: number;
  pitchRange: number;
  meanPitch: number;
  notesPerBeat: number;
}
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

/** Parse Standard MIDI File note events into a compact, tempo-independent signature. */
export function midiFingerprint(buffer: ArrayBuffer): MidiFingerprint {
  const data = new DataView(buffer);
  const ascii = (offset: number) => String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
  const need = (offset: number, count: number, end = data.byteLength) => {
    if (offset < 0 || offset + count > end) throw new Error('The MIDI file is truncated or malformed.');
  };
  if (data.byteLength < 14 || ascii(0) !== 'MThd') throw new Error('This is not a Standard MIDI File.');
  const headerLength = data.getUint32(4, false);
  if (headerLength < 6) throw new Error('The MIDI header is invalid.');
  need(8, headerLength);
  const division = data.getUint16(12, false);
  if (division & 0x8000 || division === 0) throw new Error('SMPTE-timed MIDI files are not supported for similarity yet.');
  const ppqn = division;
  let offset = 8 + headerLength;
  const notes: Array<{ start: number; stop: number; pitch: number; velocity: number }> = [];
  while (offset + 8 <= data.byteLength) {
    const chunk = ascii(offset), chunkLength = data.getUint32(offset + 4, false), chunkStart = offset + 8, chunkEnd = chunkStart + chunkLength;
    need(chunkStart, chunkLength);
    offset = chunkEnd;
    if (chunk !== 'MTrk') continue;
    let pos = chunkStart, tick = 0, runningStatus = 0;
    const active = new Map<number, Array<{ start: number; velocity: number }>>();
    let activeCount = 0;
    const readVlq = () => {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        need(pos, 1, chunkEnd);
        const byte = data.getUint8(pos++);
        value = (value << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) return value;
      }
      throw new Error('The MIDI file contains an invalid variable-length value.');
    };
    while (pos < chunkEnd) {
      tick += readVlq();
      need(pos, 1, chunkEnd);
      let status = data.getUint8(pos++);
      if (status < 0x80) {
        if (runningStatus < 0x80 || runningStatus >= 0xf0) throw new Error('The MIDI file has invalid running status.');
        pos--; status = runningStatus;
      } else if (status < 0xf0) runningStatus = status;
      else runningStatus = 0;
      if (status === 0xff) {
        need(pos, 1, chunkEnd); pos++;
        const length = readVlq(); need(pos, length, chunkEnd); pos += length;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const length = readVlq(); need(pos, length, chunkEnd); pos += length;
        continue;
      }
      const op = status & 0xf0, channel = status & 0x0f;
      const count = op === 0xc0 || op === 0xd0 ? 1 : 2;
      need(pos, count, chunkEnd);
      const a = data.getUint8(pos++), b = count === 2 ? data.getUint8(pos++) : 0;
      if (op !== 0x80 && op !== 0x90) continue;
      const key = channel * 128 + a;
      if (op === 0x90 && b > 0) {
        const stack = active.get(key) ?? [];
        stack.push({ start: tick, velocity: b }); active.set(key, stack);
        activeCount++;
        if (notes.length + activeCount > 100_000) throw new Error('This MIDI file has too many notes to analyze safely.');
      } else {
        const stack = active.get(key), on = stack?.shift();
        if (on) { activeCount--; notes.push({ start: on.start, stop: Math.max(on.start + 1, tick), pitch: a, velocity: on.velocity }); }
      }
      if (notes.length > 100_000) throw new Error('This MIDI file has too many notes to analyze safely.');
    }
    for (const [key, stack] of active) for (const on of stack) notes.push({ start: on.start, stop: Math.max(on.start + 1, tick), pitch: key % 128, velocity: on.velocity });
  }
  if (!notes.length) throw new Error('No playable notes were found in this MIDI file.');
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.stop - b.stop);
  let lastTick = 0, minPitch = 127, maxPitch = 0;
  for (const note of notes) { lastTick = Math.max(lastTick, note.stop); minPitch = Math.min(minPitch, note.pitch); maxPitch = Math.max(maxPitch, note.pitch); }
  const durationBeats = Math.max(1 / ppqn, lastTick / ppqn);
  const pitchClasses = new Array<number>(12).fill(0), intervals = new Array<number>(49).fill(0), onsetGaps = new Array<number>(24).fill(0), noteLengths = new Array<number>(16).fill(0), beatPositions = new Array<number>(16).fill(0);
  const onsets = [...new Set(notes.map((note) => note.start))].sort((a, b) => a - b);
  let pitchTotal = 0;
  for (const note of notes) { pitchClasses[note.pitch % 12]++; pitchTotal += note.pitch; const length = Math.max(1 / ppqn, (note.stop - note.start) / ppqn); noteLengths[Math.min(15, Math.floor(Math.log2(1 + length) * 4))]++; beatPositions[Math.floor((((note.start / ppqn) % 1) + 1) % 1 * 16) % 16]++; }
  for (let i = 1; i < notes.length; i++) { const interval = Math.max(-24, Math.min(24, notes[i].pitch - notes[i - 1].pitch)); intervals[interval + 24]++; }
  for (let i = 1; i < onsets.length; i++) { const gap = Math.max(1 / ppqn, (onsets[i] - onsets[i - 1]) / ppqn); onsetGaps[Math.min(23, Math.floor(Math.log2(1 + gap) * 5))]++; }
  const normalize = (values: number[]) => { const total = values.reduce((sum, value) => sum + value, 0) || 1; return values.map((value) => Number((value / total).toFixed(5))); };
  return {
    pitchClasses: normalize(pitchClasses), intervals: normalize(intervals), onsetGaps: normalize(onsetGaps), noteLengths: normalize(noteLengths), beatPositions: normalize(beatPositions),
    noteCount: notes.length, durationBeats: Number(durationBeats.toFixed(3)), pitchRange: maxPitch - minPitch, meanPitch: Number((pitchTotal / notes.length).toFixed(2)), notesPerBeat: Number((notes.length / durationBeats).toFixed(3)),
  };
}

export function midiSimilarity(a: MidiFingerprint, b: MidiFingerprint): number {
  const cosine = (left: readonly number[], right: readonly number[]) => {
    const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
    const l = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)), r = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
    return l && r ? Math.max(0, Math.min(1, dot / (l * r))) : 0;
  };
  const similarity = (x: number, y: number, scale: number) => Math.exp(-Math.abs(x - y) / Math.max(scale, 1e-6));
  const structure = cosine(a.intervals, b.intervals) * 0.28 + cosine(a.onsetGaps, b.onsetGaps) * 0.24 + cosine(a.pitchClasses, b.pitchClasses) * 0.18 + cosine(a.noteLengths, b.noteLengths) * 0.12 + cosine(a.beatPositions, b.beatPositions) * 0.08;
  const shape = similarity(a.pitchRange, b.pitchRange, 12) * 0.04 + similarity(a.notesPerBeat, b.notesPerBeat, Math.max(a.notesPerBeat, b.notesPerBeat, 1) * 0.5) * 0.03 + similarity(a.meanPitch, b.meanPitch, 18) * 0.03;
  const length = Math.exp(-0.18 * Math.abs(Math.log2(Math.max(a.durationBeats, 0.25) / Math.max(b.durationBeats, 0.25))));
  return Math.max(0, Math.min(1, (structure + shape) * length));
}
