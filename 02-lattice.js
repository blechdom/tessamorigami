import {
  $,
  TAU,
  clamp,
  lerp,
  FORM_SPECS,
  resizeCanvas,
  createCurvedTiling,
  samplePrototile,
  centroid,
  intersectSegmentWithLine,
  dedupePoints,
  VoiceBank,
  attachTransport,
} from "./study-shared.js";

const PALETTE = ["#e9b949", "#e64f35", "#2457c5"];
const PAPER = "#f1eee6";
const ACCENT = "#2457c5";
const PLAYHEAD = "#e64f35";
const MAX_VOICES = 24;

const state = {
  form: 1,
  curvature: 0,
  density: 0.56,
  extent: 0.88,
  angle: 22,
  offset: -0.78,
  speed: 0.16,
  voiceCap: 16,
  playing: false,
  pointerDown: false,
  lastTime: 0,
};

const canvas = $("#latticeCanvas");
const context = canvas.getContext("2d");
const latticeLayer = document.createElement("canvas");
const latticeContext = latticeLayer.getContext("2d");
const sound = new VoiceBank(MAX_VOICES, {
  master: 0.5,
  cutoff: 4300,
  delayTime: 0.14,
  feedback: 0.11,
  wet: 0.07,
});

let width = 1000;
let height = 700;
let dpr = 1;
let tiling;
let edgeControls = [];
let worldCenter = { x: 0, y: 0 };
let tiles = [];
let boundarySegments = [];
let tileScale = 80;
let activeBounds = { left: 40, right: 960, top: 50, bottom: 640 };
let geometryDirty = true;
let lastReadout = "";

function formatSignedPercent(value) {
  if (Math.abs(value) < 0.005) return "center";
  const sign = value < 0 ? "−" : "+";
  return `${sign}${Math.round(Math.abs(value) * 100)}%`;
}

function formatCurvature(value) {
  if (Math.abs(value) < 0.005) return "straight";
  return `${value < 0 ? "reverse " : "forward "}${Math.round(Math.abs(value) * 100)}%`;
}

function refreshTiling() {
  const result = createCurvedTiling(FORM_SPECS[state.form].type, state.curvature);
  tiling = result.tiling;
  edgeControls = result.controls;
  worldCenter = centroid(samplePrototile(tiling, edgeControls, undefined, 8));
  geometryDirty = true;
}

function screenPoint(point) {
  return {
    x: width * 0.5 + (point.x - worldCenter.x) * tileScale,
    y: height * 0.47 + (point.y - worldCenter.y) * tileScale,
  };
}

function pathBounds(points) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return { left, right, top, bottom };
}

function boxesOverlap(a, b, margin = 0) {
  return !(
    a.right < b.left - margin
    || a.left > b.right + margin
    || a.bottom < b.top - margin
    || a.top > b.bottom + margin
  );
}

function segmentKey(a, b) {
  const precision = 50;
  const first = `${Math.round(a.x * precision)},${Math.round(a.y * precision)}`;
  const second = `${Math.round(b.x * precision)},${Math.round(b.y * precision)}`;
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function rebuildGeometry() {
  geometryDirty = false;
  const shortestSide = Math.min(width, height);
  tileScale = lerp(shortestSide * 0.19, shortestSide * 0.072, state.density);

  const halfWidth = width * lerp(0.2, 0.475, state.extent);
  const halfHeight = height * lerp(0.18, 0.445, state.extent);
  const centerX = width * 0.5;
  const centerY = height * 0.47;
  activeBounds = {
    left: centerX - halfWidth,
    right: centerX + halfWidth,
    top: centerY - halfHeight,
    bottom: centerY + halfHeight,
  };

  const worldHalfWidth = halfWidth / tileScale + 2;
  const worldHalfHeight = halfHeight / tileScale + 2;
  const samples = Math.abs(state.curvature) < 0.005 ? 1 : 8;
  const nextTiles = [];

  for (const instance of tiling.fillRegionBounds(
    worldCenter.x - worldHalfWidth,
    worldCenter.y - worldHalfHeight,
    worldCenter.x + worldHalfWidth,
    worldCenter.y + worldHalfHeight,
  )) {
    const path = samplePrototile(tiling, edgeControls, instance.T, samples).map(screenPoint);
    const bounds = pathBounds(path);
    if (!boxesOverlap(bounds, activeBounds, 2)) continue;
    nextTiles.push({
      path,
      bounds,
      aspect: instance.aspect,
      color: tiling.getColour(instance.t1, instance.t2, instance.aspect) % PALETTE.length,
    });
  }

  const uniqueSegments = new Map();
  for (const tile of nextTiles) {
    for (let index = 0; index < tile.path.length; index += 1) {
      const a = tile.path[index];
      const b = tile.path[(index + 1) % tile.path.length];
      const key = segmentKey(a, b);
      if (!uniqueSegments.has(key)) {
        uniqueSegments.set(key, {
          a,
          b,
          aspect: tile.aspect,
          angle: Math.atan2(b.y - a.y, b.x - a.x),
        });
      }
    }
  }

  tiles = nextTiles;
  boundarySegments = [...uniqueSegments.values()];
  $("#densityOut").textContent = `${tiles.length} tiles`;
  drawLatticeLayer();
}

function tracePath(targetContext, points) {
  if (points.length < 2) return;
  targetContext.beginPath();
  points.forEach((point, index) => {
    if (index === 0) targetContext.moveTo(point.x, point.y);
    else targetContext.lineTo(point.x, point.y);
  });
  targetContext.closePath();
}

function drawLatticeLayer() {
  latticeContext.clearRect(0, 0, width, height);
  latticeContext.fillStyle = "rgba(241,238,230,.55)";
  latticeContext.fillRect(
    activeBounds.left,
    activeBounds.top,
    activeBounds.right - activeBounds.left,
    activeBounds.bottom - activeBounds.top,
  );

  latticeContext.save();
  latticeContext.beginPath();
  latticeContext.rect(
    activeBounds.left,
    activeBounds.top,
    activeBounds.right - activeBounds.left,
    activeBounds.bottom - activeBounds.top,
  );
  latticeContext.clip();

  for (const tile of tiles) {
    tracePath(latticeContext, tile.path);
    latticeContext.fillStyle = `${PALETTE[tile.color]}24`;
    latticeContext.fill();
  }

  latticeContext.beginPath();
  for (const segment of boundarySegments) {
    latticeContext.moveTo(segment.a.x, segment.a.y);
    latticeContext.lineTo(segment.b.x, segment.b.y);
  }
  latticeContext.strokeStyle = "rgba(23,25,24,.46)";
  latticeContext.lineWidth = 0.82;
  latticeContext.stroke();
  latticeContext.restore();

  latticeContext.strokeStyle = "rgba(23,25,24,.66)";
  latticeContext.lineWidth = 1;
  latticeContext.strokeRect(
    activeBounds.left + 0.5,
    activeBounds.top + 0.5,
    activeBounds.right - activeBounds.left - 1,
    activeBounds.bottom - activeBounds.top - 1,
  );
}

function scanGeometry() {
  const angle = state.angle / 360 * TAU;
  const tangent = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -tangent.y, y: tangent.x };
  const halfWidth = (activeBounds.right - activeBounds.left) * 0.5;
  const halfHeight = (activeBounds.bottom - activeBounds.top) * 0.5;
  const center = {
    x: (activeBounds.left + activeBounds.right) * 0.5,
    y: (activeBounds.top + activeBounds.bottom) * 0.5,
  };
  const support = Math.abs(normal.x) * halfWidth + Math.abs(normal.y) * halfHeight;
  const origin = {
    x: center.x + normal.x * support * state.offset,
    y: center.y + normal.y * support * state.offset,
  };
  return { tangent, normal, center, support, origin };
}

function pointInsideField(point, tolerance = 1.5) {
  return point.x >= activeBounds.left - tolerance
    && point.x <= activeBounds.right + tolerance
    && point.y >= activeBounds.top - tolerance
    && point.y <= activeBounds.bottom + tolerance;
}

function findContacts(scan) {
  const contacts = [];
  for (const segment of boundarySegments) {
    const point = intersectSegmentWithLine(segment.a, segment.b, scan.origin, scan.normal);
    if (!point || !pointInsideField(point)) continue;
    contacts.push({
      ...point,
      aspect: segment.aspect,
      edgeAngle: segment.angle,
    });
  }
  const unique = dedupePoints(contacts, 1.35);
  unique.sort((a, b) => {
    const alongA = (a.x - scan.center.x) * scan.tangent.x + (a.y - scan.center.y) * scan.tangent.y;
    const alongB = (b.x - scan.center.x) * scan.tangent.x + (b.y - scan.center.y) * scan.tangent.y;
    return alongA - alongB || a.x - b.x || a.y - b.y;
  });
  return unique;
}

function evenlySelect(points, count) {
  if (points.length <= count) return points;
  if (count <= 1) return [points[Math.floor(points.length * 0.5)]];
  const selected = [];
  for (let index = 0; index < count; index += 1) {
    selected.push(points[Math.round(index * (points.length - 1) / (count - 1))]);
  }
  return selected;
}

function frequencyForPoint(point) {
  const normalizedHeight = clamp(
    1 - (point.y - activeBounds.top) / Math.max(1, activeBounds.bottom - activeBounds.top),
    0,
    1,
  );
  const aspectOffset = (point.aspect % 6) / 30;
  return 73.42 * 2 ** (normalizedHeight * 4.25 + aspectOffset);
}

function voiceSpecs(points) {
  const gain = clamp(0.1 / Math.sqrt(Math.max(1, points.length)), 0.012, 0.045);
  return points.map((point) => {
    const edgeVerticality = Math.abs(Math.sin(point.edgeAngle));
    return {
      frequency: frequencyForPoint(point),
      gain,
      pan: clamp(point.x / Math.max(1, width) * 2 - 1, -1, 1),
      type: edgeVerticality > 0.72 ? "triangle" : "sine",
    };
  });
}

function drawDot(point, radius, fill, stroke, lineWidth = 1) {
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, TAU);
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = lineWidth;
    context.stroke();
  }
}

function drawScan(scan, contacts, voicedContacts) {
  const diagonal = Math.hypot(width, height) * 1.2;
  context.save();
  context.beginPath();
  context.rect(
    activeBounds.left,
    activeBounds.top,
    activeBounds.right - activeBounds.left,
    activeBounds.bottom - activeBounds.top,
  );
  context.clip();

  context.beginPath();
  context.moveTo(
    scan.origin.x - scan.tangent.x * diagonal,
    scan.origin.y - scan.tangent.y * diagonal,
  );
  context.lineTo(
    scan.origin.x + scan.tangent.x * diagonal,
    scan.origin.y + scan.tangent.y * diagonal,
  );
  context.strokeStyle = "rgba(241,238,230,.9)";
  context.lineWidth = 5;
  context.stroke();
  context.strokeStyle = PLAYHEAD;
  context.lineWidth = 1.8;
  context.stroke();

  const voiced = new Set(voicedContacts);
  for (const point of contacts) {
    if (voiced.has(point)) continue;
    drawDot(point, 2.7, PAPER, PLAYHEAD, 1.1);
  }
  for (const point of voicedContacts) {
    drawDot(point, 4.1, ACCENT, PAPER, 1.4);
  }
  context.restore();
}

function updateReadouts(contacts, voicedContacts) {
  const spec = FORM_SPECS[state.form];
  $("#fieldState").textContent = `IH${String(spec.type).padStart(2, "0")} · ${tiles.length} TILES`;
  $("#scanState").textContent = `SCAN ${Math.round(state.angle)}° · ${Math.round((state.offset + 1) * 50)}%`;

  const capped = contacts.length > voicedContacts.length;
  const readout = capped
    ? `${contacts.length} UNIQUE CONTACTS · ${voicedContacts.length} EVENLY SPACED VOICES`
    : `${contacts.length} UNIQUE CONTACTS · ${voicedContacts.length} VOICES`;
  if (readout !== lastReadout) {
    $("#contactReadout").textContent = readout;
    lastReadout = readout;
  }

  const progress = clamp((state.offset + 1) * 0.5, 0, 1);
  $("#timelineFill").style.width = `${progress * 100}%`;
  $("#timelineHead").style.left = `${progress * 100}%`;
  $("#offset").value = String(state.offset);
  $("#offsetOut").textContent = formatSignedPercent(state.offset);
}

function render(time) {
  if (!state.lastTime) state.lastTime = time;
  const deltaSeconds = Math.min(0.06, (time - state.lastTime) / 1000);
  state.lastTime = time;

  if (state.playing) {
    state.offset = ((state.offset + 1 + deltaSeconds * state.speed) % 2) - 1;
  }
  if (geometryDirty) rebuildGeometry();

  const scan = scanGeometry();
  const contacts = findContacts(scan);
  const voicedContacts = evenlySelect(contacts, Math.min(MAX_VOICES, state.voiceCap));

  context.clearRect(0, 0, width, height);
  context.drawImage(latticeLayer, 0, 0, width, height);
  drawScan(scan, contacts, voicedContacts);

  if (state.playing) {
    sound.update(voiceSpecs(voicedContacts), {
      smoothing: 0.028,
      cutoff: clamp(2200 + contacts.length * 42 + Math.abs(state.curvature) * 1800, 1800, 7600),
      feedback: clamp(0.08 + state.density * 0.12, 0.08, 0.22),
    });
  }
  updateReadouts(contacts, voicedContacts);
  requestAnimationFrame(render);
}

function dismissInstruction() {
  $("#firstInstruction").classList.add("dismissed");
}

function bindControl(id, key, formatter, onChange) {
  const input = $(`#${id}`);
  const output = $(`#${id}Out`);
  input.addEventListener("input", () => {
    state[key] = Number(input.value);
    if (output) output.textContent = formatter(state[key]);
    onChange?.();
    dismissInstruction();
  });
}

bindControl("form", "form", (value) => {
  const spec = FORM_SPECS[value];
  return `${spec.name} · IH${String(spec.type).padStart(2, "0")}`;
}, refreshTiling);
bindControl("curvature", "curvature", formatCurvature, refreshTiling);
bindControl("density", "density", () => "rebuilding", () => { geometryDirty = true; });
bindControl("extent", "extent", (value) => `${Math.round(value * 100)}%`, () => { geometryDirty = true; });
bindControl("angle", "angle", (value) => `${Math.round(value)}°`);
bindControl("offset", "offset", formatSignedPercent);
bindControl("speed", "speed", (value) => `${(2 / value).toFixed(1)} s`);
bindControl("voiceCap", "voiceCap", (value) => `${Math.round(value)} voices`);

attachTransport($("#transport"), state, sound, {
  play: "scan the lattice",
  pause: "pause the scan",
  active: "the line is the playhead",
  idle: "audio starts here",
});
$("#transport").addEventListener("click", dismissInstruction);

function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function placeLineFromPointer(event) {
  const point = canvasPoint(event);
  const scan = scanGeometry();
  const projected = (point.x - scan.center.x) * scan.normal.x
    + (point.y - scan.center.y) * scan.normal.y;
  state.offset = clamp(projected / Math.max(scan.support, 1), -1, 1);
}

canvas.addEventListener("pointerdown", (event) => {
  state.pointerDown = true;
  canvas.setPointerCapture(event.pointerId);
  placeLineFromPointer(event);
  dismissInstruction();
});
canvas.addEventListener("pointermove", (event) => {
  if (state.pointerDown) placeLineFromPointer(event);
});
canvas.addEventListener("pointerup", () => { state.pointerDown = false; });
canvas.addEventListener("pointercancel", () => { state.pointerDown = false; });

canvas.addEventListener("keydown", (event) => {
  const offsetStep = event.shiftKey ? 0.01 : 0.025;
  if (event.key === "ArrowLeft") state.offset = clamp(state.offset - offsetStep, -1, 1);
  else if (event.key === "ArrowRight") state.offset = clamp(state.offset + offsetStep, -1, 1);
  else if (event.key === "ArrowUp") state.angle = (state.angle + 1) % 180;
  else if (event.key === "ArrowDown") state.angle = (state.angle + 179) % 180;
  else if (event.key === " ") $("#transport").click();
  else return;
  $("#angle").value = String(state.angle);
  $("#angleOut").textContent = `${Math.round(state.angle)}°`;
  dismissInstruction();
  event.preventDefault();
});

const dialog = $("#aboutDialog");
$("#aboutOpen").addEventListener("click", () => dialog.showModal());
$("#aboutClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

function handleResize() {
  const size = resizeCanvas(canvas, context);
  width = size.width;
  height = size.height;
  dpr = size.dpr;
  latticeLayer.width = canvas.width;
  latticeLayer.height = canvas.height;
  latticeContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  geometryDirty = true;
}

new ResizeObserver(handleResize).observe(canvas);
refreshTiling();
handleResize();
requestAnimationFrame(render);
