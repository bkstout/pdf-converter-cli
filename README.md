# pdf-converter-cli

A local Node.js/TypeScript workflow for converting scanned hymn PDFs into raw Markdown with Adobe PDF Services API, then processing the output into GospelCue-style hymn records.

The project deliberately keeps PDFs, raw OCR, generated Markdown, LLM outputs, manifests, audit reports, and API credentials outside Git.

## Workflow overview

```text
Pass 1   Scanned PDF -> Adobe PDF-to-Markdown -> durable 50-page technical chunks + master raw Markdown
Pass 1.5 Master raw Markdown -> review-batch script -> LLM-sized, song-aware raw batches + manifest
Pass 2   One raw review batch -> LLM -> GospelCue-style cleaned text + raw model response
Pass 3   Cleaned text -> metadata script -> CSV + structural audit report
```

The Adobe chunk boundary is a reliability boundary, not an editorial boundary. Pass 1.5 works from the combined master Markdown and attempts to place LLM batch breaks before likely new-song starts. This gives a song that crosses PDF pages 50/51 a chance to stay together in a single editorial batch.

## Prerequisites

- Node.js 18 or later
- Adobe PDF Services API Client ID and Client Secret
- An OpenAI API key with API billing/credits for automated Pass 2, or ChatGPT for manual processing

A ChatGPT subscription does not automatically include OpenAI API usage. The local Pass 2 script calls the API using `OPENAI_API_KEY`.

## Setup

1. Install packages:

   ```powershell
   npm install
   ```

2. Create `.env` from `.env.example`:

   ```env
   PDF_SERVICES_CLIENT_ID=your_client_id_here
   PDF_SERVICES_CLIENT_SECRET=your_client_secret_here

   OPENAI_API_KEY=your_openai_key_here
   OPENAI_MODEL=gpt-4.1-mini
   ```

3. Build:

   ```powershell
   npm run build
   ```

Use real values only in `.env`; it is ignored by Git. Never put secrets in `.env.example`, source code, a Git commit, or a ChatGPT prompt.

## Pass 1: PDF to Markdown

Place the source PDF in the ignored `docs/` directory, then run:

```powershell
node dist\index.js --input "docs\ChurchHymnal.pdf" --output "docs\ChurchHymnal-raw"
```

The converter uses 50-page chunks. A 409-page hymnal becomes nine Adobe conversion jobs: pages 1-50, 51-100, and so on through 401-409. Successful Markdown results are retained per chunk. If an Adobe download or network request fails, run the exact command again without `--overwrite`; completed chunks are skipped and the converter resumes at the missing one.

## Pass 1.5: Make review batches

Create LLM-sized batches from the master raw Markdown, not directly from the 50-page technical chunks:

```powershell
npm run make-batches -- `
  --input "docs\ChurchHymnal-raw.md" `
  --output-dir "docs\review-batches-test" `
  --target-chars 15000 `
  --max-chars 20000
```

The script writes raw batch files and `review-batch-manifest.json`. It targets likely new-song starts but cannot perfectly understand music-heavy OCR. Read the manifest and audit the first/last song of every batch.

## Pass 2: Clean one review batch

Process only one batch first:

```powershell
npm run restructure -- `
  --input "docs\review-batches-test\GospelCue_Church_Hymnal_Batch01_Raw.md" `
  --output "docs\cleaned-batches-test\GospelCue_Church_Hymnal_Batch01_Cleaned.txt"
```

The script saves a sibling `.response.txt` file before validating the model output. It produces plain-text GospelCue records containing `SONG TITLE`, `KEY`, `TIME SIGNATURE`, `TOPIC`, `STYLE`, `TONE`, `TEMPO`, `ARTIST`, and `THEME SUMMARY`, followed by verse and chorus blocks.

## Pass 3: Build metadata CSV and audit

```powershell
npm run build-metadata -- `
  --input "docs\cleaned-batches-test\GospelCue_Church_Hymnal_Batch01_Cleaned.txt" `
  --metadata "docs\cleaned-batches-test\GospelCue_Church_Hymnal_Batch01_Metadata.csv" `
  --audit "docs\cleaned-batches-test\GospelCue_Church_Hymnal_Batch01_Audit.txt"
```

The CSV columns are:

```text
index, Song #, Song Title, KEY, TIME SIGNATURE, TOPIC, Style, Tone, Tempo, Artist, Theme Summary
```

`Song #` is intentionally blank; fill it only after confirming it against the hymnal source. The audit validates basic labels and CSV structure; it does not prove lyric accuracy, source coverage, writer/composer information, keys, or time signatures.

## Manual ChatGPT alternative

If you prefer manual ChatGPT cleanup, upload or paste one `GospelCue_Church_Hymnal_Batch##_Raw.md` file at a time. Use this instruction:

```text
Clean this one raw hymnal batch into plain-text GospelCue records. Preserve source order. Use SONG TITLE, KEY, TIME SIGNATURE, TOPIC, STYLE, TONE, TEMPO, ARTIST, THEME SUMMARY, then Verse and Chorus/Refrain labels. STYLE must be Hymn. Do not invent lyrics, titles, credits, key, or meter. This batch may begin or end with a partial hymn; do not duplicate it or invent missing text. Put uncertain boundary fragments at the end under INCOMPLETE BOUNDARY FRAGMENTS. Return plain text only, without Markdown code fences.
```

## Git safety

Before any commit:

```powershell
git status
git check-ignore -v .env
git add src package.json package-lock.json README.md .gitignore docs\README.md
git status
```

Never commit `.env`, source PDFs, raw Markdown, cleaned outputs, or generated CSV/audit files. `docs/` is ignored except for `docs/README.md`.