#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';

type Confidence = 'high' | 'medium' | 'low';
type BoundaryStatus = 'likely-complete' | 'possibly-continuation' | 'needs-boundary-review';

interface SourceBoundary {
  sourceChunk: number;
  startPage: number;
  endPage: number;
  characterOffset: number;
}

interface CandidateSongStart {
  offset: number;
  line: number;
  confidence: Confidence;
  songNumber: string | null;
  title: string;
  preview: string;
}

interface SongManifestEntry {
  songId: string;
  fileName: string;
  filePath: string;
  status: BoundaryStatus;
  startOffset: number;
  endOffset: number;
  rawCharacters: number;
  sourceChunkStart: number | null;
  sourceChunkEnd: number | null;
  sourceChunkPageRangeStart: string | null;
  sourceChunkPageRangeEnd: string | null;
  startConfidence: Confidence;
  titleCandidate: string;
  songNumberCandidate: string | null;
  previousTitleCandidate: string | null;
  nextTitleCandidate: string | null;
  notes: string[];
}

const program = new Command();
program
  .name('split-songs')
  .description('Split combined Adobe raw Markdown into one conservative raw Markdown file per likely hymn')
  .requiredOption('-i, --input <path>', 'Path to the combined raw Markdown file')
  .requiredOption('-o, --output-dir <path>', 'Directory for one-song files and song-manifest.json')
  .option('--overwrite', 'Replace previously generated one-song files in the output directory', false)
  .parse(process.argv);

const opts = program.opts<{ input: string; outputDir: string; overwrite: boolean }>();

function slug(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
  return cleaned || 'Untitled';
}

function lineNumberAtOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

function parseSourceBoundaries(raw: string): SourceBoundary[] {
  const boundaries: SourceBoundary[] = [];
  const pattern = /<!--\s*Source pages\s+(\d+)-(\d+);\s*chunk\s+(\d+)\/\d+\s*-->/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    boundaries.push({
      startPage: Number.parseInt(match[1], 10),
      endPage: Number.parseInt(match[2], 10),
      sourceChunk: Number.parseInt(match[3], 10),
      characterOffset: match.index,
    });
  }

  return boundaries;
}

function sourceBoundaryAtOffset(boundaries: SourceBoundary[], offset: number): SourceBoundary | null {
  let current: SourceBoundary | null = null;
  for (const boundary of boundaries) {
    if (boundary.characterOffset <= offset) current = boundary;
    else break;
  }
  return current;
}

function normalizeTitle(value: string): string {
  return value
    .replace(/^\d{1,3}\s+/, '')
    .replace(/\s+(?:Copyright|Words|Music|Arr\.).*$/i, '')
    .replace(/\s+\d{1,3}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikePersonName(value: string): boolean {
  const words = value.replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Z][a-z]+$/.test(word) || /^[A-Z]\.?$/.test(word));
}

function titleQuality(value: string): boolean {
  if (value.length < 4 || value.length > 100) return false;
  if (/^(?:CHORUS|REFRAIN|VERSE|COPYRIGHT|WORDS|MUSIC|ARR\.?|D\.C\.?|D\.S\.?|FINE)$/i.test(value)) return false;
  if (/^(?:Page|Source pages)\b/i.test(value)) return false;
  if (looksLikePersonName(value)) return false;
  if (!/[A-Za-z]{3}/.test(value)) return false;
  return true;
}

function findLikelySongStarts(raw: string): CandidateSongStart[] {
  const candidates = new Map<number, CandidateSongStart>();
  const lines = raw.split(/\r?\n/);
  let offset = 0;

  const addCandidate = (
    lineOffset: number,
    confidence: Confidence,
    songNumber: string | null,
    title: string,
    preview: string,
  ) => {
    const existing = candidates.get(lineOffset);
    const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
    if (!existing || rank[confidence] > rank[existing.confidence]) {
      candidates.set(lineOffset, {
        offset: lineOffset,
        line: lineNumberAtOffset(raw, lineOffset),
        confidence,
        songNumber,
        title,
        preview: preview.slice(0, 180),
      });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const next = (lines[index + 1] ?? '').trim();
    const previous = (lines[index - 1] ?? '').trim();
    const combined = `${line} ${next}`.slice(0, 260);
    const numbered = line.match(/^(\d{1,3})\s+(.{4,120})$/);
    const inlineNumbered = line.match(/^(\d{1,3})\s+(.{4,100}?)(?:\s+Copyright\b|\s+[A-Z]\.?\s*[A-Z]\.?\s*Copyright\b)/i);
    const titleOnly = /^[A-Z][A-Za-z0-9'’.,!?()&\- ]{3,100}$/.test(line);
    const nextHasCredit = /\b(?:Copyright|Words|Music|Arr\.|owner|owners)\b/i.test(next);
    const nearbyCredit = /\b(?:Copyright|Words|Music|Arr\.|owner|owners)\b/i.test(combined)
      || /\b(?:Copyright|Words|Music|Arr\.|owner|owners)\b/i.test(previous);
    const pageMarker = /^<!--\s*Source pages\s+\d+-\d+;\s*chunk\s+\d+\/\d+\s*-->$/i.test(previous);

    if (numbered) {
      const title = normalizeTitle(numbered[2]);
      if (titleQuality(title)) addCandidate(offset, nearbyCredit ? 'high' : 'medium', numbered[1], title, line);
    } else if (inlineNumbered) {
      const title = normalizeTitle(inlineNumbered[2]);
      if (titleQuality(title)) addCandidate(offset, 'high', inlineNumbered[1], title, line);
    } else if (titleOnly) {
      const title = normalizeTitle(line);
      if (titleQuality(title) && nextHasCredit) addCandidate(offset, 'high', null, title, line);
      else if (titleQuality(title) && (previous === '' || pageMarker)) addCandidate(offset, 'medium', null, title, line);
    }

    offset += lines[index].length + 1;
  }

  return [...candidates.values()].sort((a, b) => a.offset - b.offset);
}

function header(
  songId: string,
  candidate: CandidateSongStart,
  status: BoundaryStatus,
  previous: CandidateSongStart | null,
  next: CandidateSongStart | null,
): string {
  return [
    `<!-- GospelCue raw song candidate ${songId} -->`,
    '<!-- This file contains RAW Adobe PDF-to-Markdown output. It is not final lyric text. -->',
    `<!-- DETECTED TITLE: ${candidate.title} -->`,
    `<!-- DETECTED SONG NUMBER: ${candidate.songNumber ?? 'Unknown'} -->`,
    `<!-- BOUNDARY STATUS: ${status} -->`,
    `<!-- PREVIOUS DETECTED TITLE: ${previous?.title ?? 'None'} -->`,
    `<!-- NEXT DETECTED TITLE: ${next?.title ?? 'None'} -->`,
    '<!-- Preserve source order. Do not merge this file with another song unless boundary status says review is needed. -->',
    '',
  ].join('\n');
}

function statusFor(candidate: CandidateSongStart, index: number, total: number, rawCharacters: number): { status: BoundaryStatus; notes: string[] } {
  const notes: string[] = [];
  if (candidate.confidence !== 'high') notes.push('Song start was detected with less than high confidence.');
  if (index === 0) notes.push('First candidate may begin after an unrecognized prior-song continuation.');
  if (index === total - 1) notes.push('Final candidate may end after the available raw source.');
  if (rawCharacters < 500) notes.push('Candidate is very short and likely requires boundary review.');

  if (notes.some((note) => /very short|unrecognized prior-song|available raw source/i.test(note))) {
    return { status: 'needs-boundary-review', notes };
  }
  if (candidate.confidence !== 'high') return { status: 'possibly-continuation', notes };
  return { status: 'likely-complete', notes };
}

function cleanGeneratedFiles(outputDir: string): void {
  for (const entry of fs.readdirSync(outputDir)) {
    if (/^\d{3}_.+_Raw\.md$/i.test(entry) || entry === 'song-manifest.json') {
      fs.rmSync(path.join(outputDir, entry), { force: true });
    }
  }
}

function main(): void {
  const inputPath = path.resolve(opts.input);
  const outputDir = path.resolve(opts.outputDir);
  if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);

  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0 && !opts.overwrite) {
    throw new Error(`Output directory is not empty: ${outputDir}. Use --overwrite to replace generated one-song files.`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  if (opts.overwrite) cleanGeneratedFiles(outputDir);

  const raw = fs.readFileSync(inputPath, 'utf-8');
  const sourceBoundaries = parseSourceBoundaries(raw);
  const candidates = findLikelySongStarts(raw);
  if (candidates.length === 0) throw new Error('No likely song starts were found. No files were written.');

  const manifestSongs: SongManifestEntry[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const previous = index > 0 ? candidates[index - 1] : null;
    const next = index + 1 < candidates.length ? candidates[index + 1] : null;
    const endOffset = next?.offset ?? raw.length;
    const body = raw.slice(candidate.offset, endOffset).trim();
    const songId = String(index + 1).padStart(3, '0');
    const { status, notes } = statusFor(candidate, index, candidates.length, body.length);
    const sourceStart = sourceBoundaryAtOffset(sourceBoundaries, candidate.offset);
    const sourceEnd = sourceBoundaryAtOffset(sourceBoundaries, Math.max(candidate.offset, endOffset - 1));
    const fileName = `${songId}_${slug(candidate.title)}_Raw.md`;
    const filePath = path.join(outputDir, fileName);

    fs.writeFileSync(filePath, `${header(songId, candidate, status, previous, next)}${body}\n`, 'utf-8');
    manifestSongs.push({
      songId,
      fileName,
      filePath,
      status,
      startOffset: candidate.offset,
      endOffset,
      rawCharacters: body.length,
      sourceChunkStart: sourceStart?.sourceChunk ?? null,
      sourceChunkEnd: sourceEnd?.sourceChunk ?? null,
      sourceChunkPageRangeStart: sourceStart ? `${sourceStart.startPage}-${sourceStart.endPage}` : null,
      sourceChunkPageRangeEnd: sourceEnd ? `${sourceEnd.startPage}-${sourceEnd.endPage}` : null,
      startConfidence: candidate.confidence,
      titleCandidate: candidate.title,
      songNumberCandidate: candidate.songNumber,
      previousTitleCandidate: previous?.title ?? null,
      nextTitleCandidate: next?.title ?? null,
      notes,
    });
  }

  const manifestPath = path.join(outputDir, 'song-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    inputPath,
    generatedAt: new Date().toISOString(),
    rawCharacters: raw.length,
    sourceChunkMarkersFound: sourceBoundaries.length,
    likelySongStartsFound: candidates.length,
    statusCounts: {
      likelyComplete: manifestSongs.filter((song) => song.status === 'likely-complete').length,
      possiblyContinuation: manifestSongs.filter((song) => song.status === 'possibly-continuation').length,
      needsBoundaryReview: manifestSongs.filter((song) => song.status === 'needs-boundary-review').length,
    },
    songs: manifestSongs,
  }, null, 2)}\n`, 'utf-8');

  console.log(`Created ${manifestSongs.length} one-song candidate file(s).`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Manifest: ${manifestPath}`);
  for (const song of manifestSongs) {
    console.log(`  ${song.songId}: ${song.status}; ${song.rawCharacters.toLocaleString()} chars; ${song.fileName}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
