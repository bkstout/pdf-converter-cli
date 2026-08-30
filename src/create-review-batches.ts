#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';

interface SourceBoundary {
  sourceChunk: number;
  startPage: number;
  endPage: number;
  characterOffset: number;
}

interface CandidateSongStart {
  offset: number;
  line: number;
  confidence: 'high' | 'medium';
  preview: string;
}

interface ReviewBatch {
  batchNumber: number;
  fileName: string;
  filePath: string;
  startOffset: number;
  endOffset: number;
  rawCharacters: number;
  sourcePageStart: number | null;
  sourcePageEnd: number | null;
  startsAtLikelySongBoundary: boolean;
  endsBeforeLikelySongBoundary: boolean;
  firstCandidatePreview: string | null;
  nextCandidatePreview: string | null;
  boundaryNote: string;
}

const DEFAULT_TARGET_CHARS = 25_000;
const DEFAULT_MAX_CHARS = 40_000;
const MIN_BATCH_CHARS = 8_000;

const program = new Command();
program
  .name('create-review-batches')
  .description('Split combined Adobe raw Markdown into LLM-sized review batches near likely hymn boundaries')
  .requiredOption('-i, --input <path>', 'Path to the combined raw Markdown file')
  .requiredOption('-o, --output-dir <path>', 'Directory for review batch files and manifest')
  .option('--target-chars <number>', 'Preferred raw character count per batch', String(DEFAULT_TARGET_CHARS))
  .option('--max-chars <number>', 'Hard raw character limit per batch', String(DEFAULT_MAX_CHARS))
  .option('--overwrite', 'Overwrite generated review batch files in an existing directory', false)
  .parse(process.argv);

const opts = program.opts<{
  input: string;
  outputDir: string;
  targetChars: string;
  maxChars: string;
  overwrite: boolean;
}>();

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
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

function sourcePageAtOffset(boundaries: SourceBoundary[], offset: number): number | null {
  let current: SourceBoundary | undefined;
  for (const boundary of boundaries) {
    if (boundary.characterOffset <= offset) current = boundary;
    else break;
  }
  return current?.startPage ?? null;
}

function findLikelySongStarts(raw: string): CandidateSongStart[] {
  const candidates = new Map<number, CandidateSongStart>();
  const lines = raw.split(/\r?\n/);
  let offset = 0;

  const addCandidate = (lineOffset: number, confidence: CandidateSongStart['confidence'], preview: string) => {
    const existing = candidates.get(lineOffset);
    if (!existing || (existing.confidence === 'medium' && confidence === 'high')) {
      candidates.set(lineOffset, {
        offset: lineOffset,
        line: lineNumberAtOffset(raw, lineOffset),
        confidence,
        preview: preview.slice(0, 160),
      });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const next = (lines[i + 1] ?? '').trim();
    const previous = (lines[i - 1] ?? '').trim();

    const numberedTitle = /^(?:\d{1,3}\s+)([A-Z][A-Za-z0-9'â€™.,!?()\-â€“â€” ]{2,90})$/.test(line);
    const titleLike = /^[A-Z][A-Za-z0-9'â€™.,!?()\-â€“â€” ]{2,90}$/.test(line)
      && !/^(CHORUS|REFRAIN|VERSE|COPYRIGHT|D\.C\.|FINE)$/i.test(line)
      && !/[;:]{2,}/.test(line);
    const metadataNearby = /(?:Copyright|Arr\.|Words|Music|Owned by|owner|[A-Z]\.[A-Z]\.|Rev\.)/i.test(next)
      || /(?:Copyright|Arr\.|Words|Music|Owned by|owner|[A-Z]\.[A-Z]\.|Rev\.)/i.test(previous);
    const pageSeparator = /^<!--\s*Source pages\s+\d+-\d+;\s*chunk\s+\d+\/\d+\s*-->$/i.test(line);

    if (numberedTitle && (metadataNearby || line.length > 8)) {
      addCandidate(offset, 'high', line);
    } else if (titleLike && metadataNearby) {
      addCandidate(offset, 'high', line);
    } else if (titleLike && (previous === '' || pageSeparator)) {
      addCandidate(offset, 'medium', line);
    }

    offset += lines[i].length + 1;
  }

  return [...candidates.values()].sort((a, b) => a.offset - b.offset);
}

function pickBatchEnd(
  rawLength: number,
  batchStart: number,
  targetChars: number,
  maxChars: number,
  candidates: CandidateSongStart[],
): { end: number; nextCandidate: CandidateSongStart | null; safeBoundary: boolean } {
  const targetOffset = Math.min(batchStart + targetChars, rawLength);
  const hardLimit = Math.min(batchStart + maxChars, rawLength);
  const minimumPreferredEnd = Math.min(batchStart + MIN_BATCH_CHARS, rawLength);

  const afterTarget = candidates.find(
    (candidate) => candidate.offset >= targetOffset && candidate.offset <= hardLimit,
  );
  if (afterTarget) {
    return { end: afterTarget.offset, nextCandidate: afterTarget, safeBoundary: true };
  }

  const beforeTarget = [...candidates]
    .reverse()
    .find((candidate) => candidate.offset >= minimumPreferredEnd && candidate.offset < targetOffset);
  if (beforeTarget) {
    return { end: beforeTarget.offset, nextCandidate: beforeTarget, safeBoundary: true };
  }

  if (hardLimit >= rawLength) {
    return { end: rawLength, nextCandidate: null, safeBoundary: true };
  }

  return { end: hardLimit, nextCandidate: null, safeBoundary: false };
}

function batchHeader(batchNumber: number, boundaryNote: string): string {
  return [
    `<!-- GospelCue review batch ${String(batchNumber).padStart(2, '0')} -->`,
    '<!-- This file contains RAW Adobe PDF-to-Markdown output. It is not final lyric text. -->',
    `<!-- BOUNDARY NOTE: ${boundaryNote} -->`,
    '<!-- Do not treat source-page comments as lyric content. -->',
    '',
  ].join('\n');
}

function createBatches(
  raw: string,
  boundaries: SourceBoundary[],
  candidates: CandidateSongStart[],
  targetChars: number,
  maxChars: number,
  outputDir: string,
): ReviewBatch[] {
  const batches: ReviewBatch[] = [];
  let start = 0;
  let batchNumber = 1;

  while (start < raw.length) {
    while (start < raw.length && /\s/.test(raw[start])) start += 1;
    if (start >= raw.length) break;

    const currentCandidate = candidates.find((candidate) => candidate.offset === start) ?? null;
    const choice = pickBatchEnd(raw.length, start, targetChars, maxChars, candidates);
    const body = raw.slice(start, choice.end).trim();

    if (!body) break;

    const sourcePageStart = sourcePageAtOffset(boundaries, start);
    const sourcePageEnd = sourcePageAtOffset(boundaries, Math.max(start, choice.end - 1));
    const boundaryNote = choice.safeBoundary
      ? 'Batch ends immediately before a likely new hymn start. Treat the text as a complete editorial unit, but audit its first and last songs against the source.'
      : 'No reliable hymn-start boundary was found before the hard character limit. The batch may end inside a hymn. Do not invent, duplicate, or silently complete missing lyrics; flag the boundary fragment for manual reconciliation.';

    const fileName = `GospelCue_Church_Hymnal_Batch${String(batchNumber).padStart(2, '0')}_Raw.md`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, `${batchHeader(batchNumber, boundaryNote)}${body}\n`, 'utf-8');

    batches.push({
      batchNumber,
      fileName,
      filePath,
      startOffset: start,
      endOffset: choice.end,
      rawCharacters: body.length,
      sourcePageStart,
      sourcePageEnd,
      startsAtLikelySongBoundary: Boolean(currentCandidate),
      endsBeforeLikelySongBoundary: choice.safeBoundary,
      firstCandidatePreview: currentCandidate?.preview ?? null,
      nextCandidatePreview: choice.nextCandidate?.preview ?? null,
      boundaryNote,
    });

    if (choice.end <= start) throw new Error(`Batching did not advance at character offset ${start}.`);
    start = choice.end;
    batchNumber += 1;
  }

  return batches;
}

function main(): void {
  const inputPath = path.resolve(opts.input);
  const outputDir = path.resolve(opts.outputDir);
  const targetChars = parsePositiveInteger(opts.targetChars, '--target-chars');
  const maxChars = parsePositiveInteger(opts.maxChars, '--max-chars');

  if (targetChars > maxChars) throw new Error('--target-chars cannot be greater than --max-chars.');
  if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0 && !opts.overwrite) {
    throw new Error(`Output directory is not empty: ${outputDir}. Use --overwrite to replace generated batch files.`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  if (opts.overwrite) {
    for (const entry of fs.readdirSync(outputDir)) {
      if (/^GospelCue_Church_Hymnal_Batch\d+_Raw\.md$/i.test(entry) || entry === 'review-batch-manifest.json') {
        fs.rmSync(path.join(outputDir, entry), { force: true });
      }
    }
  }

  const raw = fs.readFileSync(inputPath, 'utf-8');
  const boundaries = parseSourceBoundaries(raw);
  const candidates = findLikelySongStarts(raw);
  const batches = createBatches(raw, boundaries, candidates, targetChars, maxChars, outputDir);
  const manifestPath = path.join(outputDir, 'review-batch-manifest.json');

  fs.writeFileSync(manifestPath, `${JSON.stringify({
    inputPath,
    generatedAt: new Date().toISOString(),
    rawCharacters: raw.length,
    targetChars,
    maxChars,
    sourceBoundaryMarkersFound: boundaries.length,
    likelySongStartsFound: candidates.length,
    batches,
  }, null, 2)}\n`, 'utf-8');

  console.log(`Created ${batches.length} review batch(es).`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Manifest: ${manifestPath}`);
  for (const batch of batches) {
    console.log(`  Batch ${String(batch.batchNumber).padStart(2, '0')}: ${batch.rawCharacters.toLocaleString()} chars; source pages ${batch.sourcePageStart ?? '?'}-${batch.sourcePageEnd ?? '?'}; ${batch.fileName}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}