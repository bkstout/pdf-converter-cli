#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { PDFDocument } from 'pdf-lib';
import { Command } from 'commander';
import inquirer from 'inquirer';

const MAX_PAGES_PER_CHUNK = 50;
const POLL_INTERVAL_MS = 2_500;
const MAX_POLL_ATTEMPTS = 720; // 30 minutes at 2.5 seconds per chunk.

const TOKEN_URL = 'https://pdf-services.adobe.io/token';
const ASSETS_URL = 'https://pdf-services.adobe.io/assets';
const MARKDOWN_URL = 'https://pdf-services.adobe.io/operation/pdftomarkdown';

interface ChunkPlan {
  index: number;
  startPage: number;
  endPage: number;
  pdfPath: string;
  markdownPath: string;
}

interface ChunkResult extends ChunkPlan {
  status: 'completed' | 'failed' | 'skipped';
  markdownBytes?: number;
  error?: string;
}

const program = new Command();

program
  .name('pdf-converter')
  .description(
    'Convert a PDF to Markdown through Adobe PDF Services API using durable 50-page chunk outputs',
  )
  .requiredOption('-i, --input <path>', 'Path to the input PDF')
  .option(
    '-o, --output <path>',
    'Output directory or output base path. Example: docs\\ChurchHymnal-raw',
  )
  .option(
    '--keep-pdf-chunks',
    'Keep the generated split PDF chunks after the run completes',
    false,
  )
  .option(
    '--overwrite',
    'Allow overwriting existing Markdown chunk files and combined output',
    false,
  )
  .parse(process.argv);

const opts = program.opts<{
  input: string;
  output?: string;
  keepPdfChunks: boolean;
  overwrite: boolean;
}>();

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PDF_SERVICES_CLIENT_ID;
  const clientSecret = process.env.PDF_SERVICES_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing PDF_SERVICES_CLIENT_ID or PDF_SERVICES_CLIENT_SECRET in .env.',
    );
  }

  return { clientId, clientSecret };
}

async function getAccessToken(): Promise<{ token: string; clientId: string }> {
  const { clientId, clientSecret } = getClientCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await axios.post(TOKEN_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 60_000,
  });

  const token = response.data?.access_token;
  if (!token) {
    throw new Error('Adobe token response did not contain access_token.');
  }

  return { token, clientId };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeSlug(value: string): string {
  return value
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getOutputLayout(inputPath: string, suppliedOutput?: string) {
  const parsedInput = path.parse(inputPath);
  const defaultBase = `${parsedInput.name}-raw`;

  if (!suppliedOutput) {
    const outputDirectory = path.join(parsedInput.dir, defaultBase);
    return {
      outputDirectory,
      baseName: defaultBase,
      combinedMarkdownPath: path.join(outputDirectory, `${defaultBase}.md`),
    };
  }

  const resolvedOutput = path.resolve(suppliedOutput);
  const parsedOutput = path.parse(resolvedOutput);

  // If the supplied value has an extension, strip it; this tool creates .md outputs.
  const outputWithoutExtension = parsedOutput.ext
    ? path.join(parsedOutput.dir, parsedOutput.name)
    : resolvedOutput;

  const baseName = safeSlug(path.basename(outputWithoutExtension)) || defaultBase;
  const outputDirectory = `${outputWithoutExtension}-chunks`;

  return {
    outputDirectory,
    baseName,
    combinedMarkdownPath: path.join(
      path.dirname(outputWithoutExtension),
      `${path.basename(outputWithoutExtension)}.md`,
    ),
  };
}

async function splitPdfLocally(
  inputPath: string,
  chunkDirectory: string,
): Promise<ChunkPlan[]> {
  const sourceBytes = fs.readFileSync(inputPath);
  const sourceDocument = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
  });
  const pageCount = sourceDocument.getPageCount();
  const chunks: ChunkPlan[] = [];

  for (let startPage = 1, index = 1; startPage <= pageCount; startPage += MAX_PAGES_PER_CHUNK, index += 1) {
    const endPage = Math.min(startPage + MAX_PAGES_PER_CHUNK - 1, pageCount);
    const chunkDocument = await PDFDocument.create();
    const pageIndexes = Array.from(
      { length: endPage - startPage + 1 },
      (_, offset) => startPage - 1 + offset,
    );

    const copiedPages = await chunkDocument.copyPages(sourceDocument, pageIndexes);
    copiedPages.forEach((page) => chunkDocument.addPage(page));

    const filename = `chunk-${String(index).padStart(2, '0')}-pages-${startPage}-${endPage}.pdf`;
    const pdfPath = path.join(chunkDirectory, filename);
    fs.writeFileSync(pdfPath, await chunkDocument.save());

    chunks.push({
      index,
      startPage,
      endPage,
      pdfPath,
      markdownPath: path.join(
        chunkDirectory,
        `chunk-${String(index).padStart(2, '0')}-pages-${startPage}-${endPage}.md`,
      ),
    });
  }

  return chunks;
}

async function convertPdfChunkToMarkdown(pdfPath: string): Promise<string> {
  const { token, clientId } = await getAccessToken();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'x-api-key': clientId,
  };

  const createAssetResponse = await axios.post(
    ASSETS_URL,
    { mediaType: 'application/pdf' },
    {
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    },
  );

  const uploadUri = createAssetResponse.data?.uploadUri;
  const assetID = createAssetResponse.data?.assetID;

  if (!uploadUri || !assetID) {
    throw new Error('Adobe asset request did not return uploadUri and assetID.');
  }

  await axios.put(uploadUri, fs.readFileSync(pdfPath), {
    headers: { 'Content-Type': 'application/pdf' },
    timeout: 300_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const createJobResponse = await axios.post(
    MARKDOWN_URL,
    { assetID },
    {
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    },
  );

  const pollingUrl = createJobResponse.headers.location as string | undefined;
  if (!pollingUrl) {
    throw new Error('Adobe job submission did not return a Location polling URL.');
  }

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);

    const statusResponse = await axios.get(pollingUrl, {
      headers: authHeaders,
      timeout: 60_000,
    });

    const status = statusResponse.data?.status;
    if (status === 'done') {
      const downloadUri = statusResponse.data?.asset?.downloadUri;
      if (!downloadUri) {
        throw new Error('Adobe completed the job but did not return asset.downloadUri.');
      }

      const resultResponse = await axios.get(downloadUri, {
        responseType: 'arraybuffer',
        timeout: 300_000,
      });
      return Buffer.from(resultResponse.data).toString('utf-8');
    }

    if (status === 'failed') {
      throw new Error(`Adobe conversion failed: ${JSON.stringify(statusResponse.data)}`);
    }

    process.stdout.write(
      `\r  Adobe job in progress (poll ${attempt}/${MAX_POLL_ATTEMPTS})...`,
    );
  }

  throw new Error(
    `Adobe conversion did not finish after ${MAX_POLL_ATTEMPTS} polling attempts.`,
  );
}

function writeManifest(
  manifestPath: string,
  inputPath: string,
  totalPages: number,
  results: ChunkResult[],
): void {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        inputPath,
        totalPages,
        chunkSizePages: MAX_PAGES_PER_CHUNK,
        generatedAt: new Date().toISOString(),
        chunks: results,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

async function main(): Promise<void> {
  const inputPath = path.resolve(opts.input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input PDF was not found: ${inputPath}`);
  }

  const outputLayout = getOutputLayout(inputPath, opts.output);
  const initialPrompt = !opts.output
    ? await inquirer.prompt([
        {
          type: 'input',
          name: 'output',
          message: 'Output base path (without .md):',
          default: path.join(path.dirname(inputPath), `${path.parse(inputPath).name}-raw`),
        },
      ])
    : null;

  const finalOutputLayout = initialPrompt
    ? getOutputLayout(inputPath, initialPrompt.output)
    : outputLayout;

  fs.mkdirSync(finalOutputLayout.outputDirectory, { recursive: true });
  const pdfChunkDirectory = path.join(finalOutputLayout.outputDirectory, 'pdf-chunks');
  fs.mkdirSync(pdfChunkDirectory, { recursive: true });

  const sourceBytes = fs.readFileSync(inputPath);
  const sourceDocument = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
  });
  const totalPages = sourceDocument.getPageCount();
  const manifestPath = path.join(finalOutputLayout.outputDirectory, 'conversion-manifest.json');

  console.log(`Input PDF: ${inputPath}`);
  console.log(`Pages: ${totalPages}`);
  console.log(`Chunk size: ${MAX_PAGES_PER_CHUNK} pages`);
  console.log(`Per-chunk Markdown folder: ${finalOutputLayout.outputDirectory}`);
  console.log(`Combined Markdown target: ${finalOutputLayout.combinedMarkdownPath}`);

  const chunks = await splitPdfLocally(inputPath, pdfChunkDirectory);
  console.log(`Created ${chunks.length} PDF chunk(s).`);

  const results: ChunkResult[] = [];

  for (const chunk of chunks) {
    console.log(
      `\n[${chunk.index}/${chunks.length}] Converting pages ${chunk.startPage}-${chunk.endPage}...`,
    );

    if (fs.existsSync(chunk.markdownPath) && !opts.overwrite) {
      const markdownBytes = fs.statSync(chunk.markdownPath).size;
      console.log(`  Existing Markdown found; skipped: ${chunk.markdownPath}`);
      results.push({ ...chunk, status: 'skipped', markdownBytes });
      writeManifest(manifestPath, inputPath, totalPages, results);
      continue;
    }

    try {
      const markdown = await convertPdfChunkToMarkdown(chunk.pdfPath);
      process.stdout.write('\n');

      if (!markdown.trim()) {
        throw new Error('Adobe returned an empty Markdown result.');
      }

      fs.writeFileSync(chunk.markdownPath, markdown, 'utf-8');
      const markdownBytes = fs.statSync(chunk.markdownPath).size;
      console.log(`  Saved ${markdownBytes.toLocaleString()} bytes: ${chunk.markdownPath}`);

      results.push({ ...chunk, status: 'completed', markdownBytes });
      writeManifest(manifestPath, inputPath, totalPages, results);
    } catch (error) {
      process.stdout.write('\n');
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAILED pages ${chunk.startPage}-${chunk.endPage}: ${message}`);
      results.push({ ...chunk, status: 'failed', error: message });
      writeManifest(manifestPath, inputPath, totalPages, results);
      console.error(`\nStopped. Review ${manifestPath}, fix the issue, then rerun the same command.`);
      console.error('Successful chunks are retained and will be skipped on rerun unless --overwrite is used.');
      process.exitCode = 1;
      return;
    }
  }

  const expectedMarkdownPaths = chunks.map((chunk) => chunk.markdownPath);
  const missingMarkdownPaths = expectedMarkdownPaths.filter(
    (chunkPath) => !fs.existsSync(chunkPath) || fs.statSync(chunkPath).size === 0,
  );

  if (missingMarkdownPaths.length > 0) {
    throw new Error(
      `Refusing to combine because ${missingMarkdownPaths.length} chunk Markdown file(s) are missing or empty.`,
    );
  }

  if (fs.existsSync(finalOutputLayout.combinedMarkdownPath) && !opts.overwrite) {
    throw new Error(
      `Combined output already exists: ${finalOutputLayout.combinedMarkdownPath}. Use --overwrite to replace it.`,
    );
  }

  const combinedMarkdown = chunks
    .map((chunk) => {
      const header = `<!-- Source pages ${chunk.startPage}-${chunk.endPage}; chunk ${chunk.index}/${chunks.length} -->`;
      return `${header}\n\n${fs.readFileSync(chunk.markdownPath, 'utf-8').trim()}`;
    })
    .join('\n\n---\n\n');

  fs.writeFileSync(finalOutputLayout.combinedMarkdownPath, `${combinedMarkdown}\n`, 'utf-8');

  if (!opts.keepPdfChunks) {
    fs.rmSync(pdfChunkDirectory, { recursive: true, force: true });
  }

  console.log('\nConversion complete.');
  console.log(`Per-chunk Markdown: ${finalOutputLayout.outputDirectory}`);
  console.log(`Combined Markdown: ${finalOutputLayout.combinedMarkdownPath}`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`\nFatal error: ${message}`);
  process.exit(1);
});