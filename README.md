# pdf-converter-cli (Hymn Edition)

Tools to:
- Convert a hymnal PDF into rough Markdown using **Adobe PDF Services API**, with automatic splitting of scanned files into 100-page chunks.
- Restructure noisy OCR text into **GospelCue-style cleaned hymn text** using an **LLM** (OpenAI-compatible API).

## Prerequisites

- Node.js 18+
- Adobe PDF Services API credentials (Client ID + Client Secret) from: https://developer.adobe.com/document-services/apis/pdf-services/
- OpenAI-compatible API key (for example, OpenAI API).

## Setup

1. Copy `.env.example` to `.env` and fill in:
   ```
   PDF_SERVICES_CLIENT_ID=your_client_id_here
   PDF_SERVICES_CLIENT_SECRET=your_client_secret_here

   OPENAI_API_KEY=your_openai_key_here
   OPENAI_MODEL=gpt-4.1-mini
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Build the TypeScript sources:
   ```
   npm run build
   ```

## Commands

### 1) Convert hymnal PDF to rough Markdown

Interactive:
```bash
npm run start
```

Or directly:
```bash
node dist/index.js --input "docs/ChurchHymnal.pdf" --output docs/ChurchHymnal-raw
```

- The tool:
  - Counts pages using `pdf-lib`.
  - If page count > 100, uses Adobe **Split PDF** (via SDK) to split into 100-page chunks.
  - For each chunk, calls Adobe's **PDF to Markdown** REST operation.
  - Concatenates all chunk Markdown outputs into a single `.md` file, separated by `---` between chunks.

### 2) Restructure rough Markdown into GospelCue-style cleaned text

After you have a rough Markdown file (for example `docs/ChurchHymnal-raw.md`):

```bash
npm run restructure -- --input docs/ChurchHymnal-raw.md --output docs/ChurchHymnal-Batch01_Cleaned.txt
```

- The tool:
  - Sends the rough Markdown to an OpenAI-compatible chat completion API.
  - Asks the model to:
    - Split text into hymns.
    - Identify hymn titles.
    - Build a structured hymn text in this format:

      ```
      SONG TITLE: Kneel At the Cross
      KEY: D
      TIME SIGNATURE: 4/4
      TOPIC: Invitation, Surrender, Salvation, Prayer
      STYLE: Hymn
      TONE: invitation
      TEMPO: moderate
      ARTIST: Chas. E. Moody
      THEME SUMMARY: An invitation to surrender every care at the cross and find life, hope, and love in Jesus.

      Verse 1:
      Kneel at the cross, Christ will meet you there,
      Come while He waits for you;
      ...

      Chorus:
      Kneel at the cross, leave every care;
      Kneel at the cross, Jesus will meet you there.

      SONG TITLE: Leave Your Sorrows and Come Along
      KEY: Eb
      ...
      ```

    - Reconstruct broken syllables ("Sa -tan" -> "Satan", etc.).
    - Remove music notation and publisher noise, except where used in metadata.

## Notes on Adobe limits

- Extract / PDF to Markdown page limits:
  - Non-scanned PDFs: up to 400 pages per job.
  - **Scanned PDFs**: 150 pages per job. This tool uses a conservative 100-page chunk size to avoid `SCAN_PAGE_LIMIT_EXCEEDED` errors.

## Notes on LLM usage

- A full hymnal is large; you may want to run `restructure-hymns` on chunks (for example, several hymns at a time) to stay within model context limits.
- Review and spot-check the structured output before relying on it in production.
