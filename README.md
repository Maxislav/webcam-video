# Webcam Video

Web app for capturing snapshots from a camera. Pick a video device, see the live feed, take a snapshot (button or `Space` / `Enter`), and it is uploaded to the server and saved in `./uploads/`.

Stack: Node.js, Express, TypeScript.

## Requirements

- Node.js 20.11 or newer
- npm
- A camera, and a browser that allows camera access (`localhost` or HTTPS is required)

## Install

```bash
npm install
```

## Run (development)

```bash
npm run dev
```

This builds the client (`public/app.ts` -> `public/app.js`) and starts the server with auto-restart. Open <http://localhost:3000> and allow camera access.

Note: `npm run dev` does not watch the client code. After editing `public/app.ts`, run `npm run build:client` and reload the page.

## Run (production)

```bash
npm run build
npm start
```

## Configuration

| Variable         | Default       | Description                                                     |
| ---------------- | ------------- | --------------------------------------------------------------- |
| `PORT`           | `3000`        | Port the server uses                                            |
| `OPENAI_API_KEY` | (unset)       | Enables image analysis with OpenAI; without it nothing is sent  |
| `OPENAI_MODEL`   | `gpt-4o-mini` | Vision-capable OpenAI model used for analysis                   |

Example: `PORT=8080 npm start`

Variables can also be put in a `.env` file in the project root (it is gitignored), e.g. `OPENAI_API_KEY=sk-...`. Restart the server after changing it.

## Image analysis (OpenAI)

When `OPENAI_API_KEY` is set, every saved snapshot (already cropped to the selected area) is sent to the OpenAI API together with a prompt, and the answer is shown in the list next to the preview. There are two editable prompt fields, backed by `prompts.json` in the project root: **Snapshot prompt** at the top of the page and **Question prompt** under the ask field:

```json
{ "snapshot_prompt": "Describe what is in the image.", "text_prompt": "" }
```

- **Snapshot prompt** (`snapshot_prompt`) is loaded into its field when the page opens and is sent with each snapshot (e.g. "Count the people in the image" or "Read the text on the sign"). If the field is empty, the saved `snapshot_prompt` is used, and a built-in "describe the image" prompt if that is empty too.
- **Question prompt** (`text_prompt`) is loaded into the field under the ask field. When you press **Send**, its text is appended to the end of your question (separated by a blank line), e.g. "Answer briefly in Russian". It is not sent with snapshots.
- Edits to either field are saved to `prompts.json` automatically, about 0.7 s after you stop typing (and on page close), so they are there after a reload or a server restart. You can also edit the file by hand; it is re-read on every request and on every page load, no restart needed. Because the app writes to it, `prompts.json` shows up as modified in `git status` after you edit a prompt.

- You need an API key from <https://platform.openai.com/api-keys>. API usage is billed separately; a ChatGPT Plus/Pro subscription does not include it.
- The image leaves your machine and goes to OpenAI. Do not enable this for sensitive scenes.
- If the analysis fails (bad key, network, timeout), the snapshot is still saved and the status line reports the error; details are in the server log.

## Usage

1. Open the app and allow camera access.
2. Choose a camera in the **Video source** dropdown.
3. (Optional) Click **Select area** and drag a rectangle over the preview. The area is remembered per camera (in the browser's `localStorage`), so you only do this once. `Esc` cancels; drag the frame itself to move it (it stays inside the video); **Change area** redraws it; **Reset area** goes back to the full frame.
4. Click **Take Snapshot**, or press `Space` / `Enter`. If an area is selected, only that area is saved. The camera is requested at its highest supported resolution (up to 4096×2160), and the snapshot is cut from the full-resolution frame, so the saved size is the camera resolution times the selected area; the status line shows the saved dimensions. Very large frames make bigger files; uploads are limited to 15 MB.
5. The status line shows the saved file name. Images are stored in `uploads/` and named by the server's local time: `YYYY-MM-DD_HH-mm-ss.jpg` (e.g. `2026-11-09_14-30-05.jpg`). Snapshots taken within the same second get a `-1`, `-2`, … suffix.
6. (Optional) Type a question in the text field under the preview and press **Send** (or `Enter`; `Shift+Enter` adds a new line). You can also drag an image file into the field or paste one from the clipboard (e.g. a screenshot): it is shown as a thumbnail (**Remove image** detaches it). When an image is attached, only the **Snapshot prompt** is sent with it (like a snapshot); the typed question and the question prompt are left out, and the typed text stays in the field after sending. Attached images are JPEG/PNG/WebP up to 10 MB and are not saved to `uploads/`. The model does not see earlier snapshots or answers. Requires `OPENAI_API_KEY`.
7. Answers (to snapshots and to questions) are collected in a scrollable list to the right of the camera preview (same height as the preview; below it on narrow screens), newest at the bottom (last 100 entries). Each entry has a **To question** button that copies its answer into the ask field in one click (appended after any text already there), ready to edit and send. The list lives only in the page: reloading it clears the list.

## API

`POST /api/upload-snapshot`

```json
{ "image": "data:image/jpeg;base64,...", "prompt": "optional, overrides snapshot_prompt" }
```

Accepts jpeg, png or webp data URLs. Returns `201` with `{ filename, path, bytes, analysis, analysisError? }`, or `400` with `{ error }` for invalid input (including a `prompt` that is not a string or is longer than 8000 characters).

`analysis` is `{ text, model }` when OpenAI analysis is enabled and succeeded, otherwise `null`. If it was enabled but failed, `analysisError` holds a short message (the file is saved anyway).

`GET /api/prompts`

Returns `{ snapshot_prompt, text_prompt }` from `prompts.json` (built-in defaults if the file is missing). Used to prefill the prompt fields.

`PUT /api/prompts`

```json
{ "snapshot_prompt": "...", "text_prompt": "..." }
```

Saves one or both prompts (strings of up to 8000 characters) into `prompts.json` and returns `200` with the full saved `{ snapshot_prompt, text_prompt }`; `400` with `{ error }` for invalid input. Used by the page to save edits.

`POST /api/ask`

```json
{ "text": "What is in this picture?", "image": "data:image/png;base64,..." }
```

Sends a question to OpenAI. `text` and `image` (jpeg, png or webp data URL) are both optional, but at least one is required; with an image and no text `snapshot_prompt` is used. The image is not saved. Every request is independent: the model does not remember earlier snapshots or questions. Returns `200` with `{ answer, model }`, `400` with `{ error }` for neither text nor image, a too long (over 8000 characters) text or an invalid image, `503` if `OPENAI_API_KEY` is not set, or `502` with a generic `{ error }` if OpenAI failed (details are in the server log).

## MCP server

`src/mcp.ts` is an [MCP](https://modelcontextprotocol.io) server (stdio) that lets an MCP client such as Claude Code use the app. On start it runs `npm run dev` itself unless the app already answers on `PORT`, and stops it when the client disconnects. Register it in a `.mcp.json` in the project root:

```json
{ "mcpServers": { "my-server": { "command": "node", "args": ["--import", "tsx", "src/mcp.ts"] } } }
```

(`npm run mcp` runs the same thing, but npm prints a banner to stdout, which breaks the protocol, so do not use it in `.mcp.json`.) Tools:

| Tool              | Description                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `list_snapshots`  | Saved files in `uploads/`, newest first (`limit`, default 20)                                |
| `ask`             | Question to OpenAI via `POST /api/ask`, optionally with a saved `snapshot` file name         |
| `get_prompts`     | Read `snapshot_prompt` and `text_prompt` from `prompts.json`                                 |
| `set_prompts`     | Update either prompt                                                                         |

Taking a new snapshot needs the camera in the browser, so it is not a tool. `ask` needs `OPENAI_API_KEY` on the app.

## Scripts

| Script                 | Description                                  |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Build client, run server with `tsx watch`    |
| `npm run build`        | Build client and server                      |
| `npm run build:client` | Compile `public/app.ts`                      |
| `npm start`            | Run the compiled server from `dist/`         |
| `npm run mcp`          | Run the MCP server (see "MCP server")        |
| `npm run typecheck`    | Type-check server and client without output  |

## Project structure

```
src/server.ts       Express server and upload endpoint
src/mcp.ts          MCP server (stdio) that starts the app and exposes tools
prompts.json        Snapshot and question prompts (loaded into the page, saved on edit)
public/index.html   UI
public/styles.css   Styles
public/app.ts       Client logic (compiled to app.js)
uploads/            Saved snapshots
```

## Troubleshooting

- **Camera does not start:** use `http://localhost:3000` (not a LAN IP over plain HTTP) and check the browser's camera permission.
- **"Camera is in use":** close other apps using the camera.
- **Blank page / 404 for `app.js`:** run `npm run build:client`.
