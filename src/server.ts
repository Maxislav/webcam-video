import express, { type NextFunction, type Request, type Response } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
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

/**
 * Placeholder for future AI integration.
 *
 * Called after a snapshot has been saved to disk. Insert the AI API request
 * here, e.g. read the file (or use `imageBuffer`), send it to your provider,
 * and return the analysis so it can be included in the HTTP response.
 */
async function analyzeSnapshot(
  _imageBuffer: Buffer,
  _saved: SnapshotResult,
): Promise<unknown | null> {
  // TODO: AI API request goes here.
  //   const response = await aiClient.analyze({ image: _imageBuffer.toString("base64") });
  //   return response;
  return null;
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

  const analysis = await analyzeSnapshot(buffer, saved);

  res.status(201).json({ ...saved, analysis });
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
