import {
  TAU,
  VoiceBank,
  attachTransport,
  bindRange,
  clamp,
  lerp,
  resizeCanvas,
} from "./study-shared.js";

const canvas = document.getElementById("hyperplaneCanvas");
const context = canvas.getContext("2d");
const readout = document.getElementById("sectionReadout");
const topologyReadout = document.getElementById("topologyReadout");
const timelineFill = document.getElementById("timelineFill");
const timelineHead = document.getElementById("timelineHead");
const viewInput = document.getElementById("view");
const viewOutput = document.getElementById("viewOut");

const AXES = ["X", "Y", "Z", "W"];
const COLORS = {
  ink: "#171918",
  paper: "#f1eee6",
  blue: "#2457c5",
  violet: "#6556c9",
  red: "#e64f35",
  yellow: "#e9b949",
};

const state = {
  offset: 0,
  xw: 38,
  yw: -27,
  view: 24,
  motion: "drift",
  rate: 0.3,
  spread: 24,
  depth: 0.7,
  playing: false,
  elapsed: 0,
  lastTime: performance.now(),
  pointer: null,
};

let width = 1000;
let height = 720;
let lastSection = null;

const sound = new VoiceBank(12, {
  master: 0.42,
  cutoff: 4400,
  wet: 0.07,
  feedback: 0.1,
  delayTime: 0.17,
});

function degrees(value) {
  const rounded = Math.round(value);
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded)}°`;
}

bindRange("offset", state, "offset", (value) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`);
bindRange("xw", state, "xw", degrees);
bindRange("yw", state, "yw", degrees);
bindRange("view", state, "view", degrees);
bindRange("rate", state, "rate", (value) => `${value.toFixed(2)}×`);
bindRange("spread", state, "spread", (value) => `${Math.round(value)} st`);
bindRange("depth", state, "depth", (value) => `${Math.round(value * 100)}%`);

const motionInput = document.getElementById("motion");
const motionOutput = document.getElementById("motionOut");
motionInput.addEventListener("change", () => {
  state.motion = motionInput.value;
  motionOutput.textContent = state.motion;
});

attachTransport(document.getElementById("transport"), state, sound, {
  play: "hear every contact",
  pause: "silence the contacts",
  active: "all section corners are sounding",
  idle: "audio starts here",
});

function rotateInPlane(vector, axisA, axisB, angle) {
  const result = [...vector];
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  result[axisA] = cosine * vector[axisA] - sine * vector[axisB];
  result[axisB] = sine * vector[axisA] + cosine * vector[axisB];
  return result;
}

function transformedBasis(xwAngle, ywAngle) {
  let basis = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];

  // A fixed tilt keeps Z involved; the two controls then rotate the same
  // orthonormal frame through XW and YW. Orthogonality is preserved exactly.
  const rotations = [
    [0, 2, 0.38],
    [1, 2, -0.31],
    [0, 3, xwAngle],
    [1, 3, ywAngle],
  ];
  rotations.forEach(([axisA, axisB, angle]) => {
    basis = basis.map((vector) => rotateInPlane(vector, axisA, axisB, angle));
  });
  return basis;
}

function dot4(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function addScaled4(center, uAxis, u, vAxis, v) {
  return center.map((value, index) => value + uAxis[index] * u + vAxis[index] * v);
}

function clipHalfPlane(polygon, coefficientU, coefficientV, limit) {
  if (polygon.length === 0) return [];
  const result = [];
  const signedDistance = (point) => coefficientU * point.u + coefficientV * point.v - limit;

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const startDistance = signedDistance(start);
    const endDistance = signedDistance(end);
    const startInside = startDistance <= 1e-9;
    const endInside = endDistance <= 1e-9;

    if (startInside) result.push(start);
    if (startInside === endInside) continue;

    const denominator = startDistance - endDistance;
    if (Math.abs(denominator) < 1e-12) continue;
    const amount = startDistance / denominator;
    result.push({
      u: lerp(start.u, end.u, amount),
      v: lerp(start.v, end.v, amount),
    });
  }
  return result;
}

function dedupePolygon(polygon) {
  const result = [];
  polygon.forEach((point) => {
    const previous = result.at(-1);
    if (!previous || Math.hypot(point.u - previous.u, point.v - previous.v) > 1e-7) result.push(point);
  });
  if (result.length > 1 && Math.hypot(result[0].u - result.at(-1).u, result[0].v - result.at(-1).v) < 1e-7) {
    result.pop();
  }
  return result;
}

function planeSection(frame, offset) {
  const [uAxis, vAxis, normal] = frame;
  const center = normal.map((value) => value * offset);
  let polygon = [
    { u: -4, v: -4 },
    { u: 4, v: -4 },
    { u: 4, v: 4 },
    { u: -4, v: 4 },
  ];

  for (let axis = 0; axis < 4; axis += 1) {
    // cᵢ + uUᵢ + vVᵢ <= +1
    polygon = clipHalfPlane(polygon, uAxis[axis], vAxis[axis], 1 - center[axis]);
    // cᵢ + uUᵢ + vVᵢ >= -1
    polygon = clipHalfPlane(polygon, -uAxis[axis], -vAxis[axis], 1 + center[axis]);
  }

  polygon = dedupePolygon(polygon);
  const vertices = polygon.map((uv) => {
    const point = addScaled4(center, uAxis, uv.u, vAxis, uv.v);
    const boundaries = point
      .map((coordinate, axis) => ({ coordinate, axis }))
      .filter(({ coordinate }) => Math.abs(Math.abs(coordinate) - 1) < 1e-5)
      .map(({ coordinate, axis }) => `${coordinate >= 0 ? "+" : "−"}${AXES[axis]}`);
    return { ...uv, point, boundaries };
  });
  return { center, uAxis, vAxis, vertices };
}

function makeTesseract() {
  const vertices = [];
  for (let mask = 0; mask < 16; mask += 1) {
    vertices.push([0, 1, 2, 3].map((axis) => (mask & (1 << axis) ? 1 : -1)));
  }
  const edges = [];
  for (let mask = 0; mask < 16; mask += 1) {
    for (let axis = 0; axis < 4; axis += 1) {
      const neighbor = mask ^ (1 << axis);
      if (mask < neighbor) edges.push([mask, neighbor, axis]);
    }
  }
  return { vertices, edges };
}

const tesseract = makeTesseract();

function rotate3(point, yaw, pitch) {
  const cosineYaw = Math.cos(yaw);
  const sineYaw = Math.sin(yaw);
  const x1 = cosineYaw * point.x + sineYaw * point.z;
  const z1 = -sineYaw * point.x + cosineYaw * point.z;
  const cosinePitch = Math.cos(pitch);
  const sinePitch = Math.sin(pitch);
  return {
    x: x1,
    y: cosinePitch * point.y - sinePitch * z1,
    z: sinePitch * point.y + cosinePitch * z1,
  };
}

function project4(point, viewAngle) {
  const fourDimensionalPerspective = 1 / (1 - point[3] * lerp(0.04, 0.23, state.depth));
  const inThreeDimensions = {
    x: point[0] * fourDimensionalPerspective,
    y: point[1] * fourDimensionalPerspective,
    z: point[2] * fourDimensionalPerspective,
  };
  const rotated = rotate3(inThreeDimensions, viewAngle, -0.43);
  const threeDimensionalPerspective = 1 / (1 - rotated.z * 0.105);
  const scale = Math.min(width, height) * 0.205;
  return {
    x: width * 0.5 + rotated.x * threeDimensionalPerspective * scale,
    y: height * 0.47 + rotated.y * threeDimensionalPerspective * scale,
    depth: rotated.z,
    w: point[3],
  };
}

function line(a, b, color, lineWidth = 1) {
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.stroke();
}

function dot(point, radius, fill, stroke = null) {
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, TAU);
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawTesseract(projectedVertices) {
  const edges = tesseract.edges
    .map(([start, end, axis]) => ({
      start: projectedVertices[start],
      end: projectedVertices[end],
      axis,
      depth: (projectedVertices[start].depth + projectedVertices[end].depth) * 0.5,
    }))
    .sort((a, b) => a.depth - b.depth);

  edges.forEach((edge) => {
    const near = clamp((edge.depth + 2.5) / 5, 0, 1);
    const alpha = 0.22 + near * 0.55;
    const color = edge.axis === 3
      ? `rgba(36,87,197,${alpha})`
      : `rgba(23,25,24,${alpha * 0.82})`;
    line(edge.start, edge.end, color, 0.7 + near * 1.05);
  });

  projectedVertices.forEach((point) => {
    const near = clamp((point.depth + 2.5) / 5, 0, 1);
    dot(point, 1.5 + near * 1.25, point.w > 0 ? COLORS.blue : COLORS.ink);
  });
}

function drawSection(section, projectedSection) {
  if (projectedSection.length < 3) return;
  context.save();
  context.beginPath();
  projectedSection.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.fillStyle = "rgba(101,86,201,.19)";
  context.fill();
  context.strokeStyle = COLORS.violet;
  context.lineWidth = 2.2;
  context.lineJoin = "round";
  context.stroke();
  context.restore();

  projectedSection.forEach((point, index) => {
    const fill = index % 2 ? COLORS.yellow : COLORS.red;
    dot(point, 5.2, fill, COLORS.paper);
    const boundary = section.vertices[index].boundaries.join("·");
    if (width > 680 && boundary) {
      context.fillStyle = COLORS.ink;
      context.font = '8px "Courier New", monospace';
      context.fillText(boundary, point.x + 8, point.y - 8);
    }
  });
}

function effectivePlane() {
  const phase = state.elapsed * state.rate;
  const drifting = state.motion === "drift";
  return {
    phase,
    offset: clamp(state.offset + (drifting ? Math.sin(phase * 0.77) * 0.42 : 0), -1.75, 1.75),
    xw: state.xw * Math.PI / 180 + (drifting ? Math.sin(phase * 0.43) * 0.34 : 0),
    yw: state.yw * Math.PI / 180 + (drifting ? Math.cos(phase * 0.31) * 0.29 : 0),
    view: state.view * Math.PI / 180,
  };
}

function soundSection(section, projectedSection) {
  if (!state.playing || section.vertices.length === 0) return;
  const pitchDirection = [0.19, 0.37, 0.57, 0.73];
  const maxProjection = pitchDirection.reduce((sum, value) => sum + Math.abs(value), 0);
  const voiceGain = clamp(0.105 / Math.sqrt(section.vertices.length), 0.025, 0.052);
  const specs = section.vertices.slice(0, 12).map((vertex, index) => {
    const pitchPosition = dot4(vertex.point, pitchDirection) / maxProjection;
    const semitones = pitchPosition * state.spread;
    const horizontal = (projectedSection[index].x - width * 0.5) / (Math.min(width, height) * 0.34);
    return {
      frequency: 196 * 2 ** (semitones / 12),
      gain: voiceGain * lerp(0.82, 1.08, (vertex.point[3] + 1) * 0.5),
      pan: clamp(horizontal * state.depth, -1, 1),
      type: vertex.point[3] > 0.25 ? "triangle" : "sine",
    };
  });
  sound.update(specs, {
    smoothing: 0.035,
    cutoff: lerp(1200, 7200, state.depth),
    feedback: lerp(0.03, 0.18, state.depth),
  });
}

function updateReadouts(section, plane) {
  const count = section.vertices.length;
  const contactWord = count === 1 ? "CONTACT" : "CONTACTS";
  readout.textContent = count
    ? `${count} ${contactWord} · OFFSET ${plane.offset >= 0 ? "+" : "−"}${Math.abs(plane.offset).toFixed(2)} · ALL SOUND TOGETHER`
    : `NO CONTACT · MOVE THE PLANE TOWARD THE HYPERCUBE`;
  topologyReadout.textContent = count ? `SECTION · ${count}-GON` : "SECTION · EMPTY";
  const progress = ((plane.phase / TAU) % 1 + 1) % 1;
  timelineFill.style.width = `${progress * 100}%`;
  timelineHead.style.left = `${progress * 100}%`;
}

function render() {
  context.clearRect(0, 0, width, height);
  const plane = effectivePlane();
  const frame = transformedBasis(plane.xw, plane.yw);
  const section = planeSection(frame, plane.offset);
  const projectedTesseract = tesseract.vertices.map((point) => project4(point, plane.view));
  const projectedSection = section.vertices.map((vertex) => project4(vertex.point, plane.view));

  drawTesseract(projectedTesseract);
  drawSection(section, projectedSection);

  if (section.vertices.length === 0) {
    context.fillStyle = "rgba(23,25,24,.62)";
    context.font = '10px "Courier New", monospace';
    context.textAlign = "center";
    context.fillText("THE PLANE DOES NOT CURRENTLY TOUCH THE HYPERCUBE", width * 0.5, height * 0.47);
    context.textAlign = "start";
    if (state.playing) sound.silence();
  } else {
    soundSection(section, projectedSection);
  }

  lastSection = section;
  updateReadouts(section, plane);
}

function resize() {
  ({ width, height } = resizeCanvas(canvas, context));
  render();
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  state.pointer = { x: event.clientX, view: state.view };
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.pointer) return;
  const bounds = canvas.getBoundingClientRect();
  state.view = clamp(state.pointer.view + (event.clientX - state.pointer.x) / bounds.width * 240, -180, 180);
  viewInput.value = String(state.view);
  viewOutput.textContent = degrees(state.view);
});

function releasePointer(event) {
  if (state.pointer && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  state.pointer = null;
}

canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", releasePointer);

function frame(time) {
  const delta = Math.min(0.05, (time - state.lastTime) / 1000);
  state.lastTime = time;
  if (state.motion === "drift") state.elapsed += delta;
  render();
  requestAnimationFrame(frame);
}

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(frame);

// Kept visible in devtools for inspecting the exact R⁴ section without
// introducing a second debug UI.
window.hyperplaneSection = () => lastSection;
