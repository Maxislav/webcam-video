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

When `OPENAI_API_KEY` is set, every saved snapshot (already cropped to the selected area) is sent to the OpenAI API together with the prompt from `prompt.txt`, and the answer is shown under the preview. Edit `prompt.txt` to change what the model is asked (e.g. "Count the people in the image" or "Read the text on the sign"); it is re-read on every snapshot, so no restart is needed. If the file is missing or empty, a default "describe the image" prompt is used.

- Context is kept between snapshots: the server uses the OpenAI Responses API with `store: true` and passes the last response id as `previous_response_id`, so the model sees earlier snapshots and answers (e.g. "what changed since the last one?"). The id is held in server memory, so restarting the server starts a new conversation; reloading the page also resets it (the client calls `POST /api/reset-context` on load). The context is shared by everyone using the server, so a reload in one tab resets it for all. Every snapshot in the chain is re-billed as input tokens, so cost grows with the conversation length.
- You need an API key from <https://platform.openai.com/api-keys>. API usage is billed separately; a ChatGPT Plus/Pro subscription does not include it.
- The image leaves your machine and goes to OpenAI. Do not enable this for sensitive scenes.
- If the analysis fails (bad key, network, timeout), the snapshot is still saved and the status line reports the error; details are in the server log.

## Usage

1. Open the app and allow camera access.
2. Choose a camera in the **Video source** dropdown.
3. (Optional) Click **Select area** and drag a rectangle over the preview. The area is remembered per camera (in the browser's `localStorage`), so you only do this once. `Esc` cancels; drag the frame itself to move it (it stays inside the video); **Change area** redraws it; **Reset area** goes back to the full frame.
4. Click **Take Snapshot**, or press `Space` / `Enter`. If an area is selected, only that area is saved.
5. The status line shows the saved file name. Images are stored in `uploads/` and named by the server's local time: `YYYY-MM-DD_HH-mm-ss.jpg` (e.g. `2026-11-09_14-30-05.jpg`). Snapshots taken within the same second get a `-1`, `-2`, … suffix.
6. (Optional) Type a question in the text field under the preview and press **Send** (or `Enter`; `Shift+Enter` adds a new line). It goes to OpenAI without a picture, in the same conversation as the snapshots, so you can ask follow-ups about what the camera showed. Requires `OPENAI_API_KEY`.
7. Answers (to snapshots and to questions) are collected in a scrollable list to the right of the camera preview (same height as the preview; below it on narrow screens), newest at the bottom (last 100 entries). The list lives only in the page: reloading it clears the list and, with it, the model's context (see "Image analysis").

## API

`POST /api/upload-snapshot`

```json
{ "image": "data:image/jpeg;base64,..." }
```

Accepts jpeg, png or webp data URLs. Returns `201` with `{ filename, path, bytes, analysis, analysisError? }`, or `400` with `{ error }` for invalid input.

`analysis` is `{ text, model }` when OpenAI analysis is enabled and succeeded, otherwise `null`. If it was enabled but failed, `analysisError` holds a short message (the file is saved anyway).

`POST /api/ask`

```json
{ "text": "What did you see in the last picture?" }
```

Sends a text-only message to OpenAI in the same stored conversation as the snapshots (see "Image analysis"). Returns `200` with `{ answer, model }`, `400` with `{ error }` for an empty or too long (over 8000 characters) text, `503` if `OPENAI_API_KEY` is not set, or `502` with a generic `{ error }` if OpenAI failed (details are in the server log).

`POST /api/reset-context`

Forgets the stored conversation, so the next snapshot or question starts a new one. Returns `204`. Called by the page on every load.

## Scripts

| Script                 | Description                                  |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Build client, run server with `tsx watch`    |
| `npm run build`        | Build client and server                      |
| `npm run build:client` | Compile `public/app.ts`                      |
| `npm start`            | Run the compiled server from `dist/`         |
| `npm run typecheck`    | Type-check server and client without output  |

## Project structure

```
src/server.ts       Express server and upload endpoint
prompt.txt          Prompt sent to OpenAI together with each snapshot (editable)
public/index.html   UI
public/styles.css   Styles
public/app.ts       Client logic (compiled to app.js)
uploads/            Saved snapshots
```

## Troubleshooting

- **Camera does not start:** use `http://localhost:3000` (not a LAN IP over plain HTTP) and check the browser's camera permission.
- **"Camera is in use":** close other apps using the camera.
- **Blank page / 404 for `app.js`:** run `npm run build:client`.
