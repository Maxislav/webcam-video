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

| Variable | Default | Description         |
| -------- | ------- | ------------------- |
| `PORT`   | `3000`  | Port the server uses |

Example: `PORT=8080 npm start`

## Usage

1. Open the app and allow camera access.
2. Choose a camera in the **Video source** dropdown.
3. Click **Take Snapshot**, or press `Space` / `Enter`.
4. The status line shows the saved file name. Images are stored in `uploads/`.

## API

`POST /api/upload-snapshot`

```json
{ "image": "data:image/jpeg;base64,..." }
```

Accepts jpeg, png or webp data URLs. Returns `201` with `{ filename, path, bytes, analysis }`, or `400` with `{ error }` for invalid input.

The `analysis` field is `null` for now. To add AI processing, implement `analyzeSnapshot()` in `src/server.ts`.

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
public/index.html   UI
public/styles.css   Styles
public/app.ts       Client logic (compiled to app.js)
uploads/            Saved snapshots
```

## Troubleshooting

- **Camera does not start:** use `http://localhost:3000` (not a LAN IP over plain HTTP) and check the browser's camera permission.
- **"Camera is in use":** close other apps using the camera.
- **Blank page / 404 for `app.js`:** run `npm run build:client`.
