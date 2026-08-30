#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import axios from 'axios';
import 'dotenv/config';

const program = new Command();

program
  .name('restructure-hymns')
  .description('Restructure rough OCR hymn markdown into GospelCue-style SONG TITLE / Verse / Chorus format using an LLM')
  .option('-i, --input <path>', 'Path to rough input .md (or .txt) file')
  .option('-o, --output <path>', 'Path for structured output cleaned .txt file')
  .parse(process.argv);

const opts = program.opts();

if (!opts.input) {
  console.error('Missing --input path to rough markdown/text file.');
  process.exit(1);
}

const inputPath = path.resolve(opts.input);
const outputPath = path.resolve(
  opts.output || inputPath.replace(/\.(md|txt)$/i, '.Cleaned.txt'),
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment.');
  process.exit(1);
}

async function callLLM(rawText: string): Promise<string> {
  const systemPrompt = `
You are an expert hymn editor converting OCR'd hymn-book text into clean, structured text.

The source is a traditional gospel hymnal (for example, "Church Hymnal") with multiple songs.
The OCR text is noisy: broken syllables (e.g., "Sa -tan", "a -way"), random numbers, publisher lines,
and fragments of music notation. Your job is to reconstruct clean lyrics and standardized metadata.

OUTPUT FORMAT (VERY IMPORTANT):

Repeat the following block for EACH hymn in the input, in order:

SONG TITLE: <exact hymn title>
KEY: <key, e.g., Ab, Bb, C, F>
TIME SIGNATURE: <meter, e.g., 4/4, 6/8, 3/4>
TOPIC: <comma-separated themes, e.g., "Praise, Worship, Redemption, Christ">
STYLE: Hymn
TONE: <one or two words, e.g., triumphant, prayer, assurance, invitation>
TEMPO: <one word, e.g., slow, moderate, upbeat>
ARTIST: <authors/composers, e.g., "Fanny J. Crosby; Chester G. Allen">
THEME SUMMARY: <one-sentence summary of the song's message>

Verse 1:
<lyrics, one line per lyric line>

Verse 2:
...

Verse 3:
...

Chorus:
<lyrics>

(leave one blank line, then begin the next hymn block with SONG TITLE: ...)

REQUIREMENTS:

- Use EXACTLY these label names and order at the top of each hymn block:
  SONG TITLE, KEY, TIME SIGNATURE, TOPIC, STYLE, TONE, TEMPO, ARTIST, THEME SUMMARY
  followed by a blank line, then Verse/Chorus sections.
- For STYLE, always use: Hymn.
- For KEY, TIME SIGNATURE, and ARTIST, infer from the text if possible; if not obvious, still choose reasonable values.
- For TOPIC, TONE, TEMPO, and THEME SUMMARY, infer from the lyrics, similar to:
  "GospelCue_Church_Hymnal_Batch07_Pages151-175_v1_Metadata-2.csv" and
  "GospelCue_Church_Hymnal_Batch07_Pages151-175_v1_Cleaned.txt" examples.
- Use "Verse 1:", "Verse 2:", etc. and "Chorus:" EXACTLY as section headers.
- Within verses and chorus, preserve poetic line breaks: one lyric line per line.
- Fully reconstruct words from split syllables: "Sa -tan" -> "Satan", "a -way" -> "away", etc.
- Remove music-notation noise: stray clefs, time signatures, barlines, random digits in the middle of lines.
- Remove pure publisher/rights boilerplate, page numbers, and layout instructions, except where a clean copyright
  line can clearly inform THEME SUMMARY or metadata.
- Do NOT add Markdown headings (#, ##, etc.). Use only the plain-text label format above.

Heuristics for this hymnal:
- Hymn entries often begin with a line like "130 Praise Him! Praise Him!" – a number plus title.
  The hymn number is NOT required in the output, but the title is.
- Subsequent lines with names and "Copyright" are metadata, not lyrics.
- Repeated stanzas between verses are likely the chorus (refrain).
- Ignore tune notation such as sequences of random letters/numbers or staff-like fragments.

Return ONLY the structured text described above. Do NOT wrap it in backticks.
`.trim();

  const userPrompt = `
Here is raw OCR'd hymn text from a hymnal. Clean it and structure it according to the specified SONG TITLE / Verse / Chorus schema:

${rawText}
`.trim();

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    },
  );

  const content = response.data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned no content.');
  }
  return content;
}

async function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf-8');

  console.log(`Restructuring hymns from: ${inputPath}`);
  try {
    const structured = await callLLM(raw);
    fs.writeFileSync(outputPath, structured, 'utf-8');
    console.log(`Structured hymns saved to: ${outputPath}`);
  } catch (err: any) {
    console.error(
      'Error calling LLM:',
      err.response?.data || err.message || err,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
