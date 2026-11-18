import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// MCP over stdio: stdout carries the protocol, so everything we log goes to stderr.

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;
const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;

async function isUp(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/prompts`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

// Runs `npm run dev` (the web app) unless something already answers on PORT.
async function startApp(): Promise<void> {
  if (!child) {
    console.error("Starting `npm run dev`…");
    // stdout of the child must not reach our stdout, so both streams go to stderr.
    const proc = spawn("npm", ["run", "dev"], { cwd: ROOT_DIR, stdio: ["ignore", 2, 2], detached: true });
    proc.on("exit", () => {
      if (child === proc) child = null;
    });
    child = proc;
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isUp()) return;
    if (!child) throw new Error("`npm run dev` exited before the app became reachable");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The app did not start on ${BASE_URL} within ${STARTUP_TIMEOUT_MS / 1000} s`);
}

async function ensureApp(): Promise<void> {
  if (await isUp()) return;
  starting ??= startApp().finally(() => {
    starting = null;
  });
  await starting;
}

function stopApp(): void {
  if (!child?.pid) return;
  try {
    // The child leads its own process group, so this also stops tsx watch and its server.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  child = null;
}

async function callApi(method: "GET" | "POST" | "PUT", route: string, body?: unknown): Promise<unknown> {
  await ensureApp();
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data;
}

async function snapshotDataUrl(filename: string): Promise<string> {
  const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()];
  if (path.basename(filename) !== filename || !mime) {
    throw new Error("snapshot must be a file name from list_snapshots (jpg, png or webp), without a path");
  }
  const buffer = await readFile(path.join(UPLOADS_DIR, filename)).catch(() => {
    throw new Error(`Snapshot not found: ${filename}`);
  });
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(task: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await task() }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.registerTool(
  "list_snapshots",
  {
    description: "List saved camera snapshots in uploads/, newest first (file name, size in bytes, modified time).",
    inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Max entries, default 20") },
  },
  ({ limit }) =>
    run(async () => {
      const names = await readdir(UPLOADS_DIR).catch(() => [] as string[]);
      const files = await Promise.all(
        names
          .filter((name) => MIME_BY_EXT[path.extname(name).toLowerCase()])
          .map(async (name) => {
            const info = await stat(path.join(UPLOADS_DIR, name));
            return { filename: name, bytes: info.size, modified: info.mtime };
          }),
      );
      files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
      return JSON.stringify(
        files.slice(0, limit ?? 20).map((f) => ({ ...f, modified: f.modified.toISOString() })),
        null,
        2,
      );
    }),
);

server.registerTool(
  "ask",
  {
    description:
      "Ask OpenAI a question through the app (needs OPENAI_API_KEY on the app). Optionally include a saved " +
      "snapshot from list_snapshots. Without text, the saved snapshot_prompt is used as the question. " +
      "Every call is independent: the model has no memory of earlier calls.",
    inputSchema: {
      text: z.string().max(8000).optional().describe("The question or instructions"),
      snapshot: z.string().optional().describe("File name of a saved snapshot to attach"),
    },
  },
  ({ text, snapshot }) =>
    run(async () => {
      const image = snapshot ? await snapshotDataUrl(snapshot) : undefined;
      const data = (await callApi("POST", "/api/ask", { text: text ?? "", ...(image && { image }) })) as {
        answer: string;
      };
      return data.answer;
    }),
);

server.registerTool(
  "get_prompts",
  {
    description: "Read snapshot_prompt and text_prompt from prompts.json (the prompts shown in the web page).",
    inputSchema: {},
  },
  () => run(async () => JSON.stringify(await callApi("GET", "/api/prompts"), null, 2)),
);

server.registerTool(
  "set_prompts",
  {
    description: "Update snapshot_prompt and/or text_prompt in prompts.json. The page picks them up on reload.",
    inputSchema: {
      snapshot_prompt: z.string().max(8000).optional().describe("Prompt sent with each snapshot"),
      text_prompt: z.string().max(8000).optional().describe("Text appended to typed questions in the page"),
    },
  },
  ({ snapshot_prompt, text_prompt }) =>
    run(async () =>
      JSON.stringify(await callApi("PUT", "/api/prompts", { snapshot_prompt, text_prompt }), null, 2),
    ),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopApp();
    process.exit(0);
  });
}
process.on("exit", stopApp);
// The client closes our stdin when it disconnects.
process.stdin.on("close", () => process.exit(0));

await server.connect(new StdioServerTransport());
ensureApp().catch((err) => console.error("Could not start the app:", err));
