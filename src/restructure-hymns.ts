#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config({ override: true });
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Command } from 'commander';

const REQUIRED_LABELS = [
  'SONG TITLE:',
  'KEY:',
  'TIME SIGNATURE:',
  'TOPIC:',
  'STYLE:',
  'TONE:',
  'TEMPO:',
  'ARTIST:',
  'THEME SUMMARY:',
] as const;

const program = new Command();
program
  .name('restructure-hymns')
  .description('Clean one GospelCue raw review batch into labeled hymn blocks using an LLM')
  .requiredOption('-i, --input <path>', 'Path to a single GospelCue *_Raw.md batch')
  .requiredOption('-o, --output <path>', 'Path for the cleaned *_Cleaned.txt output')
  .option('--response-output <path>', 'Optional raw LLM response output path')
  .option('--max-input-chars <number>', 'Refuse oversized batch input above this character count', '45000')
  .parse(process.argv);

const opts = program.opts<{
  input: string;
  output: string;
  responseOutput?: string;
  maxInputChars: string;
}>();

function getEnvironment(): { apiKey: string; model: string } {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing. Add it to the ignored .env file in the project root.');
  return { apiKey, model };
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function removeCodeFences(text: string): string {
  return text.trim().replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateCleanedText(text: string): { songCount: number; missingLabels: string[] } {
  const songCount = (text.match(/^SONG TITLE:\s*.+$/gm) ?? []).length;
  const missingLabels = REQUIRED_LABELS.filter((label) => !new RegExp(`^${escapeRegExp(label)}\\s*.+$`, 'm').test(text));
  return { songCount, missingLabels };
}

function buildSystemPrompt(): string {
  return `
You are an expert hymn editor converting raw, OCR-heavy PDF-to-Markdown text into clean GospelCue hymn records.

The source is a traditional gospel hymnal. The raw input can contain broken syllables, reading-order errors,
music notation fragments, table markup, repeated harmony text, page numbers, copyright lines, and multi-column
interleaving. Restore only lyrics and metadata that are reasonably supported by the source. Never fabricate verses,
credits, keys, meter, or song titles simply to make a record look complete.

The input includes comments called BOUNDARY NOTE. They are instructions, not lyric text. A batch can begin or end
in the middle of a hymn. Do not duplicate a hymn across batches. If a beginning or ending fragment cannot be
reliably reconciled inside this batch, omit that incomplete hymn from final SONG TITLE records and append it under
an INCOMPLETE BOUNDARY FRAGMENTS section at the end, with a brief reason. Do not invent the missing text.

OUTPUT FORMAT â€” return plain text only, with no Markdown fences and no introduction.

For every complete hymn you can reconstruct, use exactly this field order:

SONG TITLE: <title>
KEY: <key or Unknown>
TIME SIGNATURE: <meter or Unknown>
TOPIC: <2 to 5 comma-separated themes>
STYLE: Hymn
TONE: <one concise lower-case descriptor>
TEMPO: <slow, moderate, upbeat, or Unknown>
ARTIST: <writer/composer/arranger names or Unknown>
THEME SUMMARY: <one complete sentence based only on the lyric content>

Verse 1:
<one lyric line per line>

Verse 2:
<one lyric line per line>

Chorus:
<one lyric line per line>

Rules:
- Preserve songs in source order.
- Use exactly: SONG TITLE, KEY, TIME SIGNATURE, TOPIC, STYLE, TONE, TEMPO, ARTIST, THEME SUMMARY.
- STYLE must always be Hymn.
- Use Verse 1:, Verse 2:, Verse 3:, etc.; use Chorus: or Refrain: only when the source supports one.
- Preserve poetic line breaks and normal punctuation where supported.
- Recombine clearly split syllables such as "Sa -tan" into "Satan" and "a -way" into "away".
- Remove staff/notation noise, table tags, duplicate harmony-only echoes, isolated page numbers, and publisher boilerplate.
- Do not treat the same song title repeated on a continuation page as a separate song.
- Do not infer KEY, TIME SIGNATURE, or ARTIST from a different song. Use Unknown when this batch does not support the value.
- Do not add a hymn number unless it is plainly present and reliable; hymn numbers are not part of SONG TITLE.
- Separate complete hymn records with exactly one blank line.
- If no incomplete fragment exists, do not add the INCOMPLETE BOUNDARY FRAGMENTS heading.
`.trim();
}

async function callOpenAI(rawText: string): Promise<string> {
  const { apiKey, model } = getEnvironment();
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: `Clean and structure this one review batch. Return only the specified plain-text records.\n\n${rawText}` },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 300_000,
  });

  const content = response.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`The LLM returned no usable text: ${JSON.stringify(response.data)}`);
  }
  return content;
}

async function main(): Promise<void> {
  const inputPath = path.resolve(opts.input);
  const outputPath = path.resolve(opts.output);
  const responseOutputPath = path.resolve(opts.responseOutput || outputPath.replace(/\.txt$/i, '.response.txt'));
  const maxInputChars = parsePositiveInteger(opts.maxInputChars, '--max-input-chars');

  if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
  const rawText = fs.readFileSync(inputPath, 'utf-8');
  if (rawText.length > maxInputChars) {
    throw new Error(`Input has ${rawText.length.toLocaleString()} characters, above --max-input-chars=${maxInputChars.toLocaleString()}. Create smaller review batches or explicitly raise the limit after checking model capacity.`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  console.log(`Input: ${inputPath}`);
  console.log(`Input size: ${rawText.length.toLocaleString()} characters`);
  console.log(`Model: ${process.env.OPENAI_MODEL || 'gpt-4.1-mini'}`);

  const responseText = await callOpenAI(rawText);
  fs.writeFileSync(responseOutputPath, `${responseText.trim()}\n`, 'utf-8');
  console.log(`Raw LLM response saved: ${responseOutputPath}`);

  const cleanedText = removeCodeFences(responseText);
  const validation = validateCleanedText(cleanedText);
  if (validation.songCount === 0) throw new Error(`No SONG TITLE records were found in the LLM response. Inspect ${responseOutputPath}.`);
  if (validation.missingLabels.length > 0) {
    throw new Error(`LLM response is missing required metadata labels: ${validation.missingLabels.join(', ')}. Inspect ${responseOutputPath}.`);
  }

  fs.writeFileSync(outputPath, `${cleanedText}\n`, 'utf-8');
  console.log(`Cleaned hymn records saved: ${outputPath}`);
  console.log(`Complete SONG TITLE records found: ${validation.songCount}`);
}

main().catch((error: unknown) => {
  console.error(`Error restructuring hymns: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});