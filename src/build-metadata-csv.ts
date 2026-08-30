#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';

const METADATA_FIELDS = [
  'SONG TITLE',
  'KEY',
  'TIME SIGNATURE',
  'TOPIC',
  'STYLE',
  'TONE',
  'TEMPO',
  'ARTIST',
  'THEME SUMMARY',
] as const;

type MetadataField = (typeof METADATA_FIELDS)[number];
type HymnRecord = Record<MetadataField, string>;

const program = new Command();
program
  .name('build-metadata-csv')
  .description('Create a GospelCue metadata CSV and audit report from one cleaned hymn text batch')
  .requiredOption('-i, --input <path>', 'Path to *_Cleaned.txt')
  .requiredOption('-m, --metadata <path>', 'Output CSV path')
  .requiredOption('-a, --audit <path>', 'Output audit TXT path')
  .parse(process.argv);

const opts = program.opts<{ input: string; metadata: string; audit: string }>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRecords(text: string): HymnRecord[] {
  const recordStarts = [...text.matchAll(/^SONG TITLE:\s*(.+)$/gm)];
  const records: HymnRecord[] = [];

  for (let i = 0; i < recordStarts.length; i += 1) {
    const start = recordStarts[i].index ?? 0;
    const end = i + 1 < recordStarts.length ? recordStarts[i + 1].index ?? text.length : text.length;
    const block = text.slice(start, end);
    const record = {} as HymnRecord;

    for (const field of METADATA_FIELDS) {
      const match = block.match(new RegExp(`^${escapeRegExp(field)}:\\s*(.*)$`, 'm'));
      record[field] = match?.[1]?.trim() || '';
    }
    records.push(record);
  }

  return records;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function createCsv(records: HymnRecord[]): string {
  const headers = ['index', 'Song #', 'Song Title', 'KEY', 'TIME SIGNATURE', 'TOPIC', 'Style', 'Tone', 'Tempo', 'Artist', 'Theme Summary'];
  const lines = [headers.map(csvEscape).join(',')];

  records.forEach((record, index) => {
    lines.push([
      String(index), '', record['SONG TITLE'], record.KEY, record['TIME SIGNATURE'], record.TOPIC,
      record.STYLE, record.TONE, record.TEMPO, record.ARTIST, record['THEME SUMMARY'],
    ].map(csvEscape).join(','));
  });

  return `${lines.join('\r\n')}\r\n`;
}

function createAudit(records: HymnRecord[], inputPath: string): string {
  const titleCounts = new Map<string, number>();
  const issues: string[] = [];

  records.forEach((record, index) => {
    const normalizedTitle = record['SONG TITLE'].toLocaleLowerCase();
    titleCounts.set(normalizedTitle, (titleCounts.get(normalizedTitle) ?? 0) + 1);
    for (const field of METADATA_FIELDS) {
      if (!record[field]) issues.push(`Record ${index + 1}: missing ${field}`);
    }
    if (record.STYLE && record.STYLE !== 'Hymn') {
      issues.push(`Record ${index + 1}: STYLE must be Hymn (found: ${record.STYLE})`);
    }
  });

  const duplicates = [...titleCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([title, count]) => `${title} (${count})`);
  const labelCounts = METADATA_FIELDS.map((field) => `- ${field}: ${records.filter((record) => Boolean(record[field])).length}`);

  return [
    'GospelCue Metadata Build Audit', '',
    `Source cleaned text: ${inputPath}`,
    `Song count: ${records.length}`,
    `CSV rows including header: ${records.length + 1}`,
    'CSV columns: 11', '',
    'Metadata label counts:', ...labelCounts, '',
    `Duplicate titles: ${duplicates.length === 0 ? 'None found' : duplicates.join('; ')}`,
    `Missing or invalid required metadata: ${issues.length === 0 ? 'None found' : issues.join('; ')}`,
    '', 'Audit limitation:',
    '- This script validates label presence and CSV structure. It does not prove lyric accuracy, source page coverage, correct author/composer attribution, or correct musical key/meter. Review each cleaned batch against the source PDF and raw Markdown.', '',
  ].join('\n');
}

function main(): void {
  const inputPath = path.resolve(opts.input);
  const metadataPath = path.resolve(opts.metadata);
  const auditPath = path.resolve(opts.audit);
  if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);

  const records = parseRecords(fs.readFileSync(inputPath, 'utf-8'));
  if (records.length === 0) throw new Error('No SONG TITLE records were found in the cleaned text.');

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(metadataPath, createCsv(records), 'utf-8');
  fs.writeFileSync(auditPath, createAudit(records, inputPath), 'utf-8');
  console.log(`Metadata CSV saved: ${metadataPath}`);
  console.log(`Audit report saved: ${auditPath}`);
  console.log(`Songs found: ${records.length}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}