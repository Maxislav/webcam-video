import express, { type NextFunction, type Request, type Response } from "express";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

try {
  process.loadEnvFile();
} catch {
  // No .env file (or Node too old for loadEnvFile); rely on the real environment.
}

const PORT = Number(process.env.PORT ?? 3000);
// Base URL of the camera server (src/camera-server.ts). When set, the page shows its stream instead of a local browser camera.
const CAMERA_URL = process.env.CAMERA_URL?.trim().replace(/\/+$/, "");
const CAMERA_CONNECT_TIMEOUT_MS = 10_000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";
const DEFAULT_PROMPT = "Describe what is in the image.";
const ANALYSIS_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 8000;
const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PROMPTS_FILE = path.join(ROOT_DIR, "prompts.json");

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

interface Prompts {
  snapshot_prompt: string;
  text_prompt: string;
}

const PROMPT_KEYS = ["snapshot_prompt", "text_prompt"] as const;

// Read on every request so edits to prompts.json apply without restarting the server.
async function readPrompts(): Promise<Prompts> {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await readFile(PROMPTS_FILE, "utf8"));
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    // Missing or invalid file: fall back to the defaults.
  }
  return {
    snapshot_prompt: typeof parsed.snapshot_prompt === "string" ? parsed.snapshot_prompt : DEFAULT_PROMPT,
    text_prompt: typeof parsed.text_prompt === "string" ? parsed.text_prompt : "",
  };
}

// Writes are serialized (read-modify-write) and atomic (temp file + rename).
let promptsWrite: Promise<unknown> = Promise.resolve();

function savePrompts(patch: Partial<Prompts>): Promise<Prompts> {
  const run = promptsWrite.then(async () => {
    const next = { ...(await readPrompts()), ...patch };
    const tmp = `${PROMPTS_FILE}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmp, PROMPTS_FILE);
    return next;
  });
  promptsWrite = run.catch(() => undefined);
  return run;
}

async function readSnapshotPrompt(): Promise<string> {
  return (await readPrompts()).snapshot_prompt.trim() || DEFAULT_PROMPT;
}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

async function requestModel(content: ContentPart[]): Promise<Analysis> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content }],
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

/**
 * Sends the saved snapshot to OpenAI (vision) and returns the model's description.
 * customPrompt (from the page) wins over snapshot_prompt in prompts.json when non-empty.
 * Returns null when OPENAI_API_KEY is not set. Throws on API errors.
 */
async function analyzeSnapshot(imageBuffer: Buffer, mime: string, customPrompt: string): Promise<Analysis | null> {
  if (!OPENAI_API_KEY) return null;

  const prompt = customPrompt || (await readSnapshotPrompt());
  return requestModel([
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: `data:${mime};base64,${imageBuffer.toString("base64")}` } },
  ]);
}

// Free-form question with an optional image, answered independently of earlier requests.
// Without text, snapshot_prompt from prompts.json is used. Throws on API errors.
async function askText(text: string, image: string | null): Promise<Analysis> {
  const parts: ContentPart[] = [{ type: "text", text: text || (await readSnapshotPrompt()) }];
  if (image) parts.push({ type: "image_url", image_url: { url: image } });
  return requestModel(parts);
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

  const rawPrompt: unknown = req.body?.prompt ?? "";
  if (typeof rawPrompt !== "string" || rawPrompt.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `prompt must be a string of at most ${MAX_TEXT_LENGTH} characters` });
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
    analysis = await analyzeSnapshot(buffer, mime, rawPrompt.trim());
  } catch (err) {
    console.error("Snapshot analysis failed:", err);
    analysisError = "Analysis failed (see server log for details)";
  }

  res.status(201).json({ ...saved, analysis, ...(analysisError && { analysisError }) });
}

async function ask(req: Request, res: Response): Promise<void> {
  const rawText: unknown = req.body?.text ?? "";
  const rawImage: unknown = req.body?.image ?? null;
  if (typeof rawText !== "string" || (rawImage !== null && typeof rawImage !== "string")) {
    res.status(400).json({ error: "Body must be JSON: { text?: <string>, image?: <base64 data URL> }" });
    return;
  }
  const text = rawText.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `text is too long (max ${MAX_TEXT_LENGTH} characters)` });
    return;
  }
  if (rawImage !== null && !DATA_URL_RE.test(rawImage as string)) {
    res.status(400).json({ error: "image must be a base64 data URL (jpeg, png or webp)" });
    return;
  }
  if (!text && rawImage === null) {
    res.status(400).json({ error: "Provide text, an image, or both" });
    return;
  }
  if (!OPENAI_API_KEY) {
    res.status(503).json({ error: "OPENAI_API_KEY is not set on the server" });
    return;
  }

  try {
    const answer = await askText(text, rawImage as string | null);
    res.json({ answer: answer.text, model: answer.model });
  } catch (err) {
    // OpenAI error messages can echo part of the API key, so keep details in the log.
    console.error("Text request failed:", err);
    res.status(502).json({ error: "Request failed (see server log for details)" });
  }
}

const app = express();

app.use(express.json({ limit: "15mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/camera", (_req, res) => {
  res.json({ remote: Boolean(CAMERA_URL) });
});

// Same-origin proxy of the camera server stream, so the page can draw frames to a canvas without CORS taint.
app.get("/api/stream", async (_req, res) => {
  if (!CAMERA_URL) {
    res.status(404).json({ error: "CAMERA_URL is not set" });
    return;
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const connectTimer = setTimeout(() => abort.abort(), CAMERA_CONNECT_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${CAMERA_URL}/stream`, { signal: abort.signal });
    clearTimeout(connectTimer);
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: "Camera server unavailable" });
      return;
    }
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=frame");
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(upstream.body as WebReadableStream)
      .on("error", () => res.end())
      .pipe(res);
  } catch (err) {
    clearTimeout(connectTimer);
    if (!abort.signal.aborted || !res.headersSent) console.error("Camera stream proxy failed:", (err as Error).name);
    if (res.headersSent) res.end();
    else res.status(502).json({ error: "Camera server unavailable" });
  }
});

app.get("/api/prompts", (_req, res, next) => {
  readPrompts().then((prompts) => res.json(prompts), next);
});

app.put("/api/prompts", (req, res, next) => {
  const patch: Partial<Prompts> = {};
  for (const key of PROMPT_KEYS) {
    const value: unknown = req.body?.[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: `${key} must be a string of at most ${MAX_TEXT_LENGTH} characters` });
      return;
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Body must be JSON with snapshot_prompt and/or text_prompt" });
    return;
  }
  savePrompts(patch).then((prompts) => res.json(prompts), next);
});

app.post("/api/upload-snapshot", (req, res, next) => {
  uploadSnapshot(req, res).catch(next);
});

app.post("/api/ask", (req, res, next) => {
  ask(req, res).catch(next);
});

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (CAMERA_URL) console.log("Camera source: remote camera server");
});
