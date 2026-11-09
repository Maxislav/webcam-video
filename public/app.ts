const video = document.getElementById("video") as HTMLVideoElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const deviceSelect = document.getElementById("deviceSelect") as HTMLSelectElement;
const snapshotBtn = document.getElementById("snapshotBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const placeholder = document.getElementById("placeholder") as HTMLParagraphElement;
const flash = document.getElementById("flash") as HTMLDivElement;
const analysisEl = document.getElementById("analysis") as HTMLDivElement;

const container = document.querySelector(".camera-container") as HTMLDivElement;
const selectBtn = document.getElementById("selectBtn") as HTMLButtonElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const selectionEl = document.getElementById("selection") as HTMLDivElement;
const selectLayer = document.getElementById("selectLayer") as HTMLDivElement;

const STORAGE_KEY = "webcam-video:deviceId";
const CROP_KEY_PREFIX = "webcam-video:crop:";
const MIN_CROP = 0.02;

// Crop area as fractions (0..1) of the video frame, so it survives resolution and window size changes.
interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

let currentStream: MediaStream | null = null;
let uploading = false;
let crop: Crop | null = null;
let selecting = false;
let dragCrop: Crop | null = null;

type StatusKind = "" | "loading" | "success" | "error";

function setStatus(message: string, kind: StatusKind = ""): void {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

function stopStream(): void {
  currentStream?.getTracks().forEach((track) => track.stop());
  currentStream = null;
}

function cropKey(): string | null {
  const id = currentStream?.getVideoTracks()[0]?.getSettings().deviceId;
  return id ? CROP_KEY_PREFIX + id : null;
}

function loadCrop(): Crop | null {
  const key = cropKey();
  if (!key) return null;
  try {
    const c = JSON.parse(localStorage.getItem(key) ?? "null") as Crop | null;
    if (
      c &&
      [c.x, c.y, c.width, c.height].every((n) => Number.isFinite(n)) &&
      c.x >= 0 && c.y >= 0 && c.width >= MIN_CROP && c.height >= MIN_CROP &&
      c.x + c.width <= 1.0001 && c.y + c.height <= 1.0001
    ) {
      return c;
    }
  } catch {
    // Corrupted value; treat as no crop.
  }
  return null;
}

function saveCrop(): void {
  const key = cropKey();
  if (!key) return;
  if (crop) localStorage.setItem(key, JSON.stringify(crop));
  else localStorage.removeItem(key);
}

// Area of the container actually covered by the video (object-fit: contain adds letterboxing).
function videoContentRect(): { left: number; top: number; width: number; height: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const scale = Math.min(cw / vw, ch / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height };
}

function renderCrop(): void {
  const shown = dragCrop ?? crop;
  const rect = videoContentRect();
  selectionEl.hidden = !shown || !rect;
  resetBtn.hidden = !crop;
  selectBtn.classList.toggle("active", selecting);
  selectBtn.textContent = selecting ? "Drag over the video…" : crop ? "Change area" : "Select area";
  if (!shown || !rect) return;
  selectionEl.style.left = `${rect.left + shown.x * rect.width}px`;
  selectionEl.style.top = `${rect.top + shown.y * rect.height}px`;
  selectionEl.style.width = `${shown.width * rect.width}px`;
  selectionEl.style.height = `${shown.height * rect.height}px`;
}

function setSelecting(value: boolean): void {
  selecting = value;
  selectLayer.classList.toggle("active", value);
  if (!value) dragCrop = null;
  renderCrop();
}

function pointToFrame(event: PointerEvent): { x: number; y: number } | null {
  const rect = videoContentRect();
  if (!rect) return null;
  const box = container.getBoundingClientRect();
  const px = event.clientX - box.left - container.clientLeft - rect.left;
  const py = event.clientY - box.top - container.clientTop - rect.top;
  return {
    x: Math.min(Math.max(px / rect.width, 0), 1),
    y: Math.min(Math.max(py / rect.height, 0), 1),
  };
}

let dragStart: { x: number; y: number } | null = null;

selectLayer.addEventListener("pointerdown", (event) => {
  const point = pointToFrame(event);
  if (!point) return;
  dragStart = point;
  dragCrop = null;
  selectLayer.setPointerCapture(event.pointerId);
});

selectLayer.addEventListener("pointermove", (event) => {
  if (!dragStart) return;
  const point = pointToFrame(event);
  if (!point) return;
  dragCrop = {
    x: Math.min(dragStart.x, point.x),
    y: Math.min(dragStart.y, point.y),
    width: Math.abs(point.x - dragStart.x),
    height: Math.abs(point.y - dragStart.y),
  };
  renderCrop();
});

selectLayer.addEventListener("pointerup", () => {
  if (!dragStart) return;
  dragStart = null;
  if (dragCrop && dragCrop.width >= MIN_CROP && dragCrop.height >= MIN_CROP) {
    crop = dragCrop;
    saveCrop();
    setStatus("Area saved. Snapshots will contain only this area.", "success");
  }
  setSelecting(false);
});

selectLayer.addEventListener("pointercancel", () => {
  dragStart = null;
  setSelecting(false);
});

selectBtn.addEventListener("click", () => setSelecting(!selecting));

resetBtn.addEventListener("click", () => {
  crop = null;
  saveCrop();
  setSelecting(false);
  setStatus("Area reset. Snapshots will contain the full frame.");
});

new ResizeObserver(renderCrop).observe(container);
video.addEventListener("loadedmetadata", renderCrop);
video.addEventListener("resize", renderCrop);

async function startStream(deviceId?: string): Promise<void> {
  stopStream();
  snapshotBtn.disabled = true;
  selectBtn.disabled = true;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false,
  });

  currentStream = stream;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  placeholder.hidden = true;
  snapshotBtn.disabled = false;
  selectBtn.disabled = false;
  setSelecting(false);
  crop = loadCrop();
  renderCrop();
}

async function populateDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const activeId = currentStream?.getVideoTracks()[0]?.getSettings().deviceId;

  deviceSelect.replaceChildren(
    ...cameras.map((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${index + 1}`;
      return option;
    }),
  );

  if (cameras.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No video devices found";
    deviceSelect.append(option);
  }

  if (activeId && cameras.some((c) => c.deviceId === activeId)) {
    deviceSelect.value = activeId;
  }
  deviceSelect.disabled = cameras.length === 0;
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "Camera access was denied. Allow it in the browser and reload.";
      case "NotFoundError":
        return "No camera found.";
      case "NotReadableError":
        return "Camera is in use by another application.";
      case "OverconstrainedError":
        return "Selected camera is no longer available.";
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function switchDevice(deviceId?: string): Promise<void> {
  try {
    setStatus("Starting camera…", "loading");
    await startStream(deviceId);
    if (deviceId) localStorage.setItem(STORAGE_KEY, deviceId);
    await populateDevices();
    setStatus("");
  } catch (err) {
    placeholder.hidden = false;
    placeholder.textContent = "Camera unavailable";
    setStatus(describeError(err), "error");
  }
}

async function takeSnapshot(): Promise<void> {
  if (uploading || !currentStream || video.videoWidth === 0) return;
  uploading = true;
  snapshotBtn.disabled = true;

  flash.classList.remove("active");
  void flash.offsetWidth;
  flash.classList.add("active");

  try {
    const sx = crop ? Math.round(crop.x * video.videoWidth) : 0;
    const sy = crop ? Math.round(crop.y * video.videoHeight) : 0;
    const sw = crop ? Math.min(Math.round(crop.width * video.videoWidth), video.videoWidth - sx) : video.videoWidth;
    const sh = crop ? Math.min(Math.round(crop.height * video.videoHeight), video.videoHeight - sy) : video.videoHeight;
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d")!.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    const image = canvas.toDataURL("image/jpeg", 0.92);

    analysisEl.hidden = true;
    analysisEl.textContent = "";
    setStatus("Uploading and analyzing…", "loading");
    const response = await fetch("/api/upload-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Upload failed (${response.status})`);

    const saved = `Saved ${data.filename} (${Math.round(data.bytes / 1024)} KB)`;
    if (data.analysisError) {
      setStatus(`${saved}. ${data.analysisError}`, "error");
    } else {
      setStatus(saved, "success");
    }
    if (data.analysis?.text) {
      analysisEl.textContent = data.analysis.text;
      analysisEl.hidden = false;
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Upload failed", "error");
  } finally {
    uploading = false;
    snapshotBtn.disabled = !currentStream;
  }
}

snapshotBtn.addEventListener("click", () => void takeSnapshot());

deviceSelect.addEventListener("change", () => void switchDevice(deviceSelect.value));

document.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && selecting) {
    dragStart = null;
    setSelecting(false);
    return;
  }
  if (event.code !== "Space" && event.code !== "Enter") return;
  if (event.repeat) return;
  // Let focused controls handle their own Space/Enter activation.
  if (event.target instanceof HTMLElement && event.target.closest("select, button")) return;
  event.preventDefault();
  void takeSnapshot();
});

async function init(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    placeholder.textContent = "Camera API unavailable";
    setStatus("getUserMedia requires HTTPS or localhost.", "error");
    return;
  }

  navigator.mediaDevices.addEventListener("devicechange", () => void populateDevices());

  // Permission must be granted before enumerateDevices() exposes device labels.
  await switchDevice(localStorage.getItem(STORAGE_KEY) ?? undefined);
  if (!currentStream && localStorage.getItem(STORAGE_KEY)) {
    // Saved device may have disappeared; fall back to the default camera.
    localStorage.removeItem(STORAGE_KEY);
    await switchDevice();
  }
}

void init();
