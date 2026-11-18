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

When `OPENAI_API_KEY` is set, every saved snapshot (already cropped to the selected area) is sent to the OpenAI API together with a prompt, and the answer is shown in the list next to the preview. There are two editable prompt fields at the top of the page. The left one, **Snapshot prompt**, is prefilled from `prompt.txt` on every page load; whatever is in it is sent with each snapshot (e.g. "Count the people in the image" or "Read the text on the sign"), so you can change it before every request. If the field is empty, the server falls back to `prompt.txt`, and to a default "describe the image" prompt if that file is missing or empty. The right one, **Question prompt**, starts empty and is sent as a system message (instructions such as "Answer briefly") with the questions typed in the ask field. Edit `prompt.txt` to change the default shown on load (re-read on every request, no restart needed).

- You need an API key from <https://platform.openai.com/api-keys>. API usage is billed separately; a ChatGPT Plus/Pro subscription does not include it.
- The image leaves your machine and goes to OpenAI. Do not enable this for sensitive scenes.
- If the analysis fails (bad key, network, timeout), the snapshot is still saved and the status line reports the error; details are in the server log.

## Usage

1. Open the app and allow camera access.
2. Choose a camera in the **Video source** dropdown.
3. (Optional) Click **Select area** and drag a rectangle over the preview. The area is remembered per camera (in the browser's `localStorage`), so you only do this once. `Esc` cancels; drag the frame itself to move it (it stays inside the video); **Change area** redraws it; **Reset area** goes back to the full frame.
4. Click **Take Snapshot**, or press `Space` / `Enter`. If an area is selected, only that area is saved. The camera is requested at its highest supported resolution (up to 4096×2160), and the snapshot is cut from the full-resolution frame, so the saved size is the camera resolution times the selected area; the status line shows the saved dimensions. Very large frames make bigger files; uploads are limited to 15 MB.
5. The status line shows the saved file name. Images are stored in `uploads/` and named by the server's local time: `YYYY-MM-DD_HH-mm-ss.jpg` (e.g. `2026-11-09_14-30-05.jpg`). Snapshots taken within the same second get a `-1`, `-2`, … suffix.
6. (Optional) Type a question in the text field under the preview and press **Send** (or `Enter`; `Shift+Enter` adds a new line). You can also drag an image file into the field or paste one from the clipboard (e.g. a screenshot): it is shown as a thumbnail (**Remove image** detaches it) and sent together with the question. With an image and no text, the snapshot prompt is used as the question. The **Question prompt** field at the top is sent along as instructions. Attached images are JPEG/PNG/WebP up to 10 MB and are not saved to `uploads/`. The model does not see earlier snapshots or answers. Requires `OPENAI_API_KEY`.
7. Answers (to snapshots and to questions) are collected in a scrollable list to the right of the camera preview (same height as the preview; below it on narrow screens), newest at the bottom (last 100 entries). The list lives only in the page: reloading it clears the list.

## API

`POST /api/upload-snapshot`

```json
{ "image": "data:image/jpeg;base64,...", "prompt": "optional, overrides prompt.txt" }
```

Accepts jpeg, png or webp data URLs. Returns `201` with `{ filename, path, bytes, analysis, analysisError? }`, or `400` with `{ error }` for invalid input (including a `prompt` that is not a string or is longer than 8000 characters).

`analysis` is `{ text, model }` when OpenAI analysis is enabled and succeeded, otherwise `null`. If it was enabled but failed, `analysisError` holds a short message (the file is saved anyway).

`GET /api/prompt`

Returns `{ prompt }`: the current contents of `prompt.txt` (or the built-in default). Used to prefill the prompt field.

`POST /api/ask`

```json
{ "text": "What is in this picture?", "image": "data:image/png;base64,...", "prompt": "optional system instructions" }
```

Sends a question to OpenAI. `text` and `image` (jpeg, png or webp data URL) are both optional, but at least one is required; with an image and no text the `prompt.txt` prompt is used. `prompt` (optional, up to 8000 characters) is sent as a system message. The image is not saved. Every request is independent: the model does not remember earlier snapshots or questions. Returns `200` with `{ answer, model }`, `400` with `{ error }` for neither text nor image, a too long (over 8000 characters) text or an invalid image, `503` if `OPENAI_API_KEY` is not set, or `502` with a generic `{ error }` if OpenAI failed (details are in the server log).

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
