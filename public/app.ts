const video = document.getElementById("video") as HTMLVideoElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const deviceSelect = document.getElementById("deviceSelect") as HTMLSelectElement;
const snapshotBtn = document.getElementById("snapshotBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const placeholder = document.getElementById("placeholder") as HTMLParagraphElement;
const flash = document.getElementById("flash") as HTMLDivElement;

const STORAGE_KEY = "webcam-video:deviceId";

let currentStream: MediaStream | null = null;
let uploading = false;

type StatusKind = "" | "loading" | "success" | "error";

function setStatus(message: string, kind: StatusKind = ""): void {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

function stopStream(): void {
  currentStream?.getTracks().forEach((track) => track.stop());
  currentStream = null;
}

async function startStream(deviceId?: string): Promise<void> {
  stopStream();
  snapshotBtn.disabled = true;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false,
  });

  currentStream = stream;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  placeholder.hidden = true;
  snapshotBtn.disabled = false;
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
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.92);

    setStatus("Uploading snapshot…", "loading");
    const response = await fetch("/api/upload-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Upload failed (${response.status})`);

    setStatus(`Saved ${data.filename} (${Math.round(data.bytes / 1024)} KB)`, "success");
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
