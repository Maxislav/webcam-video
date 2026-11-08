# Claude Prompt: Node.js + TypeScript Camera Capture App

Copy and paste the following prompt into Claude to generate the full project code and setup instructions.

---

### Prompt for Claude:

Create a web application with a **Node.js + Express** backend written in **TypeScript**. 

#### Requirements:

1. **Backend (Node.js + Express + TypeScript):**
   * Configure an Express server in TypeScript (include `package.json`, `tsconfig.json`, and scripts for running the project with `tsx` or `ts-node-dev`).
   * Implement a REST API endpoint `POST /api/upload-snapshot` that receives image data (Base64 or `multipart/form-data`) and saves it to a local folder named `./uploads/` with a unique timestamped filename.
   * Include a placeholder function/method in the controller for future integration with an AI API (add clear comments on where to insert the AI request logic).

2. **Frontend (HTML/CSS + Client-side TypeScript or JavaScript):**
   * Minimalist and clean UI interface.
   * A styled container (`<div class="camera-container">`) displaying the live video feed.
   * A `<select>` dropdown menu to enumerate and choose from available video input devices (webcams, external USB capture cards, etc.) using `navigator.mediaDevices.enumerateDevices()`.
   * Dynamic switching of the active video stream upon selecting a device via `navigator.mediaDevices.getUserMedia()`.
   * A button to "Take Snapshot" as well as a keyboard shortcut handler (e.g., press `Space` or `Enter`) to trigger the snapshot.
   * Frame capture using an HTML5 `<canvas>`, converting the image to Base64/Blob, and sending it to the backend endpoint `/api/upload-snapshot`.
   * Visual feedback showing success/loading state when a snapshot is sent to the server.

#### Desired Output:
Provide a clear project file structure along with the complete, functional code for each file:
- `package.json`
- `tsconfig.json`
- `src/server.ts` (Express server setup, static file serving, and API routes)
- `public/index.html` (UI layout)
- `public/styles.css` (Basic responsive styles)
- `public/app.ts` (or `public/app.js` containing camera selection, keyboard listeners, canvas capture, and fetch API logic)

Include step-by-step terminal commands for installing dependencies, compiling TypeScript, and running the server locally.