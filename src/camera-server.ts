import express, { type Response } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

// Camera server: captures a local (USB) camera with ffmpeg and streams it as MJPEG over HTTP.
// The main app pulls the stream from CAMERA_URL. ffmpeg runs only while someone is watching.
const PORT = Number(process.env.CAMERA_PORT ?? 3001);
// Loopback by default: the stream has no authentication. Set CAMERA_HOST=0.0.0.0 to expose it on the network.
const HOST = process.env.CAMERA_HOST ?? "127.0.0.1";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const SIZE = process.env.CAMERA_SIZE ?? "1280x720";
const FPS = Number(process.env.CAMERA_FPS ?? 15);
const QUALITY = Number(process.env.CAMERA_QUALITY ?? 4); // ffmpeg -q:v, 2 (best) .. 31 (worst)
const IDLE_STOP_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const BOUNDARY = "frame";

// Linux: the first capture node of a USB camera, else the first capture node at all.
function detectLinuxDevice(): string | undefined {
  const base = "/sys/class/video4linux";
  if (!existsSync(base)) return undefined;
  const nodes = readdirSync(base)
    .filter((n) => /^video\d+$/.test(n))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .filter((n) => {
      try {
        return readFileSync(`${base}/${n}/index`, "utf8").trim() === "0"; // skip metadata nodes
      } catch {
        return true;
      }
    });
  const isUsb = (n: string): boolean => {
    try {
      return realpathSync(`${base}/${n}/device`).includes("/usb");
    } catch {
      return false;
    }
  };
  const pick = nodes.find(isUsb) ?? nodes[0];
  return pick ? `/dev/${pick}` : undefined;
}

function inputArgs(): string[] {
  const device = process.env.CAMERA_DEVICE;
  switch (process.platform) {
    case "linux": {
      const dev = device ?? detectLinuxDevice();
      if (!dev) throw new Error("No /dev/video* camera found. Set CAMERA_DEVICE=/dev/videoN.");
      return ["-f", "v4l2", "-framerate", String(FPS), "-video_size", SIZE, "-i", dev];
    }
    case "win32":
      if (!device) {
        throw new Error(
          'Set CAMERA_DEVICE to the camera name. List names: ffmpeg -list_devices true -f dshow -i dummy',
        );
      }
      return ["-f", "dshow", "-framerate", String(FPS), "-video_size", SIZE, "-i", `video=${device}`];
    case "darwin":
      return ["-f", "avfoundation", "-framerate", String(FPS), "-i", device ?? "0"];
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

const viewers = new Set<Response>();
const waiters = new Set<(frame: Buffer) => void>();
let ffmpeg: ChildProcess | null = null;
let lastFrame: Buffer | null = null;
let stopTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;

function publish(frame: Buffer): void {
  lastFrame = Buffer.from(frame);
  for (const wake of waiters) wake(lastFrame);
  waiters.clear();
  for (const res of viewers) {
    if (res.writableNeedDrain) continue; // slow client: drop frames instead of buffering
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(lastFrame);
    res.write("\r\n");
  }
}

let configError: string | null = null;

// Returns false when capture cannot start (no camera configured).
function startCapture(): boolean {
  clearTimeout(stopTimer);
  if (ffmpeg) return true;
  let args: string[];
  try {
    args = [
      "-hide_banner", "-loglevel", "error",
      ...inputArgs(),
      "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", String(QUALITY), "pipe:1",
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== configError) console.error(message); // log once, not per request
    configError = message;
    return false;
  }
  configError = null;

  const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpeg = child;
  console.error("Camera capture started");

  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const start = buf.indexOf(SOI);
      if (start < 0) {
        buf = buf.subarray(Math.max(0, buf.length - 1)); // keep a possible half marker
        break;
      }
      const end = buf.indexOf(EOI, start + 2);
      if (end < 0) {
        buf = buf.subarray(start);
        break;
      }
      publish(buf.subarray(start, end + 2));
      buf = buf.subarray(end + 2);
    }
    if (buf.length > MAX_BUFFER) buf = Buffer.alloc(0);
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.on("error", (err) => {
    console.error(`Cannot run ${FFMPEG}: ${err.message}. Install ffmpeg or set FFMPEG_PATH.`);
  });
  child.on("close", (code) => {
    if (ffmpeg === child) ffmpeg = null;
    lastFrame = null;
    if (code) console.error(`ffmpeg exited with code ${code}\n${stderr.trim()}`);
    // Camera unplugged or busy: keep trying while someone is watching.
    if (viewers.size > 0 || waiters.size > 0) {
      retryTimer = setTimeout(startCapture, 2000);
    }
  });
  return true;
}

function scheduleStop(): void {
  if (viewers.size > 0 || waiters.size > 0) return;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    clearTimeout(retryTimer);
    ffmpeg?.kill("SIGTERM");
    console.error("Camera capture stopped (no viewers)");
  }, IDLE_STOP_MS);
}

function nextFrame(timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(onFrame);
      reject(new Error("timeout"));
    }, timeoutMs);
    const onFrame = (frame: Buffer): void => {
      clearTimeout(timer);
      resolve(frame);
    };
    waiters.add(onFrame);
  });
}

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, capturing: ffmpeg !== null, viewers: viewers.size });
});

app.get("/stream", (req, res) => {
  if (!startCapture()) {
    res.status(503).json({ error: configError });
    return;
  }
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  viewers.add(res);
  req.on("close", () => {
    viewers.delete(res);
    scheduleStop();
  });
});

app.get("/snapshot", async (_req, res) => {
  if (!startCapture()) {
    res.status(503).json({ error: configError });
    return;
  }
  try {
    const frame = lastFrame ?? (await nextFrame(10_000));
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store" }).send(frame);
  } catch {
    res.status(504).json({ error: "No frame from camera" });
  } finally {
    scheduleStop();
  }
});

const server = app.listen(PORT, HOST, () => {
  console.error(`Camera server at http://${HOST}:${PORT}  (stream: /stream, snapshot: /snapshot)`);
});

function shutdown(): void {
  clearTimeout(retryTimer);
  ffmpeg?.kill("SIGTERM");
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
