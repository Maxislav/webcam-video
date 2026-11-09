import express, { type NextFunction, type Request, type Response } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

try {
  process.loadEnvFile();
} catch {
  // No .env file (or Node too old for loadEnvFile); rely on the real environment.
}

const PORT = Number(process.env.PORT ?? 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const ANALYSIS_PROMPT = "Опиши, что на изображении.";
const ANALYSIS_TIMEOUT_MS = 30_000;
const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

interface SnapshotResult {
  filename: string;
  path: string;
  bytes: number;
}

interface Analysis {
  text: string;
  model: string;
}

/**
 * Sends the saved snapshot to OpenAI (vision) and returns the model's description.
 * Returns null when OPENAI_API_KEY is not set. Throws on API errors.
 */
async function analyzeSnapshot(imageBuffer: Buffer, mime: string): Promise<Analysis | null> {
  if (!OPENAI_API_KEY) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ANALYSIS_PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${imageBuffer.toString("base64")}` },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`OpenAI ${response.status}: ${body?.error?.message ?? response.statusText}`);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response");
  return { text, model: OPENAI_MODEL };
}

// YYYY-MM-DD_HH-mm-ss in server local time.
function timestampName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

// Never overwrites: two snapshots within one second get -1, -2, ... suffixes.
async function writeUniqueFile(base: string, ext: string, data: Buffer): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const filename = `${base}${attempt === 0 ? "" : `-${attempt}`}.${ext}`;
    try {
      await writeFile(path.join(UPLOADS_DIR, filename), data, { flag: "wx" });
      return filename;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

async function uploadSnapshot(req: Request, res: Response): Promise<void> {
  const image: unknown = req.body?.image;
  if (typeof image !== "string") {
    res.status(400).json({ error: "Body must be JSON: { image: <base64 data URL> }" });
    return;
  }

  const match = DATA_URL_RE.exec(image);
  if (!match) {
    res.status(400).json({ error: "image must be a base64 data URL (jpeg, png or webp)" });
    return;
  }

  const [, mime, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    res.status(400).json({ error: "Empty image" });
    return;
  }

  await mkdir(UPLOADS_DIR, { recursive: true });
  const filename = await writeUniqueFile(timestampName(new Date()), EXTENSIONS[mime], buffer);

  const saved: SnapshotResult = {
    filename,
    path: path.join("uploads", filename),
    bytes: buffer.length,
  };

  // The snapshot is already saved, so an analysis failure must not fail the upload.
  // Details stay in the server log; OpenAI error messages can echo part of the API key.
  let analysis: Analysis | null = null;
  let analysisError: string | undefined;
  try {
    analysis = await analyzeSnapshot(buffer, mime);
  } catch (err) {
    console.error("Snapshot analysis failed:", err);
    analysisError = "Analysis failed (see server log for details)";
  }

  res.status(201).json({ ...saved, analysis, ...(analysisError && { analysisError }) });
}

const app = express();

app.use(express.json({ limit: "15mb" }));
app.use(express.static(PUBLIC_DIR));

app.post("/api/upload-snapshot", (req, res, next) => {
  uploadSnapshot(req, res).catch(next);
});

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
