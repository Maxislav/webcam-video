# CLAUDE.md

Webcam snapshot web app: live camera preview in the browser, optional crop area, snapshot uploaded to an Express server and saved in `uploads/`. Stack: Node.js (ESM), Express, TypeScript. No test suite, no linter.

## Commands

- `npm run dev` — build client, run server with `tsx watch` (http://localhost:3000)
- `npm run build:client` — compile `public/app.ts` -> `public/app.js` (required after every client edit; dev does NOT watch it)
- `npm run build` / `npm start` — production build and run from `dist/`
- `npm run typecheck` — type-check server and client; run before committing

## Structure

- `src/server.ts` — Express server, `POST /api/upload-snapshot`, file naming, `analyzeSnapshot()` (OpenAI `chat/completions` vision call via `fetch`, active only when `OPENAI_API_KEY` is set; each request is stateless, no conversation context), `POST /api/ask` (question with optional image from drop/paste in the ask field, not saved to `uploads/`; also stateless)
- `prompts.json` — `{ snapshot_prompt, text_prompt }`; read per request (no restart); missing/invalid file or empty snapshot prompt falls back to `DEFAULT_PROMPT` in `src/server.ts`. The page loads both into two editable fields ("Snapshot prompt" at the top, "Question prompt" under the ask field) via `GET /api/prompts` and autosaves edits (700 ms debounce, flushed on `pagehide`) via `PUT /api/prompts`. `snapshot_prompt` is sent as `prompt` with each snapshot (empty falls back to the saved one); `text_prompt` is not sent to the server as such: the client appends the field text to the end of the typed question on Send (`POST /api/ask` gets the combined `text`). The app rewrites this file at runtime, so it is tracked but will show as modified after prompt edits
- `public/app.ts` — all client logic (camera, device select, crop selection, upload); compiled to `public/app.js`
- `public/index.html`, `public/styles.css` — UI (always dark theme via CSS variables; text fields & select stay light via `--field-*`)
- `uploads/` — saved snapshots

## Conventions and gotchas

- `public/app.js`, `dist/`, `node_modules/`, `uploads/*` and `docs/codemie/analytics/` are gitignored. Never edit `app.js` by hand; edit `app.ts` and rebuild.
- Model answers are shown as a scrollable list kept in memory only; a page reload clears it.
- Crop area is stored as fractions (0..1) of the video frame, per camera, in `localStorage` (`webcam-video:crop:<deviceId>`), so it is independent of resolution and window size. The video uses `object-fit: contain`, so pointer coordinates must be mapped through `videoContentRect()` (letterboxing).
- Snapshot filenames are server-local time `YYYY-MM-DD_HH-mm-ss.<ext>`; a `-1`, `-2`, … suffix is added on same-second collisions (written with `wx`, never overwrites). Older files in `uploads/` use the previous `snapshot-<ISO>-<hex>` naming.
- The server accepts only jpeg/png/webp base64 data URLs; JSON body limit is 15 MB.
- Config via env vars or a gitignored `.env` (loaded with `process.loadEnvFile()`): `PORT`, `OPENAI_API_KEY`, `OPENAI_MODEL`. Never commit or log the key. Analysis failures must not fail the upload (file is already saved); the client gets a generic `analysisError` and details go to the server log only, because OpenAI error text can echo part of the key.
- Camera access needs `localhost` or HTTPS.
- Keep README.md in sync when behavior changes (usage, API, file naming).
