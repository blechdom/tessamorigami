import {
  $, TAU, VoiceBank, attachTransport, bindRange, clamp, lerp, resizeCanvas,
} from "./study-shared.js";

const canvas = $("#field");
const context = canvas.getContext("2d");
const sound = new VoiceBank(32, {
  master: 0.42,
  cutoff: 4300,
  delayTime: 0.23,
  feedback: 0.16,
  wet: 0.1,
});

const COLS = 30;
const ROWS = 21;
const state = {
  stretch: 1.15,
  twist: 0.56,
  relief: 0.72,
  turn: -22,
  sectionAngle: 24,
  focus: 0.52,
  focusSize: 0.48,
  rate: 0.3,
  voices: 20,
  mapping: "depth",
  spread: 0.78,
  register: 0,
  focusU: 0.16,
  focusV: -0.12,
  playing: false,
  dragging: false,
  phase: 0,
};

let size = { width: 1, height: 1 };
let lastTime = performance.now();
let projectedVertices = [];

const ink = "#171918";
const paper = "#f1eee6";
const violet = "#6556c9";
const blue = "#2457c5";
const red = "#e64f35";

function signed(value, digits = 2) {
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${Math.abs(value).toFixed(digits)}`;
}

bindRange("stretch", state, "stretch", (value) => `${value.toFixed(2)}×`);
bindRange("twist", state, "twist", (value) => `${Math.round(value * 180 / Math.PI)}°`);
bindRange("relief", state, "relief", (value) => value.toFixed(2));
bindRange("turn", state, "turn", (value) => `${value < 0 ? "−" : ""}${Math.abs(Math.round(value))}°`);
bindRange("sectionAngle", state, "sectionAngle", (value) => `${value < 0 ? "−" : ""}${Math.abs(Math.round(value))}°`);
bindRange("focus", state, "focus", (value) => signed(value));
bindRange("focusSize", state, "focusSize", (value) => value.toFixed(2));
bindRange("rate", state, "rate", (value) => `${value.toFixed(2)}×`);
bindRange("voices", state, "voices", (value) => String(Math.round(value)));
bindRange("spread", state, "spread", (value) => `${Math.round(value * 100)}%`);
bindRange("register", state, "register", (value) => `${signed(value, 1)} oct`);

const mappingNames = {
  depth: "VIEW DEPTH → PITCH",
  position: "FIELD POSITION → PITCH",
  strain: "LOCAL STRAIN → PITCH",
};

$("#mapping").addEventListener("change", (event) => {
  state.mapping = event.target.value;
  $("#mappingOut").textContent = state.mapping;
  $("#modeReadout").textContent = mappingNames[state.mapping];
});

attachTransport($("#transport"), state, sound, {
  play: "listen to the section",
  pause: "stop the section",
  active: "intersection points are sounding",
  idle: "audio starts here",
});

function vertexIndex(column, row) {
  return row * COLS + column;
}

function makeVertex(column, row, phase) {
  const u = column / (COLS - 1) * 2 - 1;
  const v = row / (ROWS - 1) * 2 - 1;
  const focusDistance = Math.hypot(u - state.focusU, v - state.focusV);
  const focusFalloff = Math.exp(-(focusDistance ** 2) / Math.max(0.02, state.focusSize ** 2));
  const breathing = Math.sin(phase * TAU + u * 3.4 - v * 2.1) * 0.055;

  let x = u * state.stretch;
  let y = v * (1 + 0.06 * Math.cos(u * Math.PI));
  let z = state.relief * (
    0.27 * Math.sin(u * Math.PI * 2.15) * Math.cos(v * Math.PI * 1.35)
    + 0.12 * Math.sin((u + v) * Math.PI * 2.5)
    + breathing
  );
  z += state.focus * focusFalloff * 0.82;
  y += state.focus * focusFalloff * (v - state.focusV) * 0.16;

  const twistAngle = state.twist * v + 0.18 * state.twist * Math.sin(u * Math.PI);
  const cosine = Math.cos(twistAngle);
  const sine = Math.sin(twistAngle);
  const twistedX = x * cosine + z * sine;
  const twistedZ = -x * sine + z * cosine;
  x = twistedX;
  z = twistedZ;

  return { x, y, z, u, v, strain: 0 };
}

function calculateStrain(vertices) {
  const baseX = 2 / (COLS - 1);
  const baseY = 2 / (ROWS - 1);
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS; column += 1) {
      const vertex = vertices[vertexIndex(column, row)];
      const lengths = [];
      if (column + 1 < COLS) {
        const other = vertices[vertexIndex(column + 1, row)];
        lengths.push(Math.hypot(other.x - vertex.x, other.y - vertex.y, other.z - vertex.z) / baseX);
      }
      if (row + 1 < ROWS) {
        const other = vertices[vertexIndex(column, row + 1)];
        lengths.push(Math.hypot(other.x - vertex.x, other.y - vertex.y, other.z - vertex.z) / baseY);
      }
      if (column > 0) {
        const other = vertices[vertexIndex(column - 1, row)];
        lengths.push(Math.hypot(other.x - vertex.x, other.y - vertex.y, other.z - vertex.z) / baseX);
      }
      if (row > 0) {
        const other = vertices[vertexIndex(column, row - 1)];
        lengths.push(Math.hypot(other.x - vertex.x, other.y - vertex.y, other.z - vertex.z) / baseY);
      }
      const meanSquaredDeformation = lengths.reduce(
        (sum, length) => sum + (length - 1) ** 2,
        0,
      ) / lengths.length;
      vertex.strain = clamp(Math.sqrt(meanSquaredDeformation), 0, 1.6);
    }
  }
}

function project(vertex) {
  const yaw = state.turn * Math.PI / 180;
  const pitch = -0.38;
  const yawX = vertex.x * Math.cos(yaw) + vertex.z * Math.sin(yaw);
  const yawZ = -vertex.x * Math.sin(yaw) + vertex.z * Math.cos(yaw);
  const viewY = vertex.y * Math.cos(pitch) - yawZ * Math.sin(pitch);
  const viewZ = vertex.y * Math.sin(pitch) + yawZ * Math.cos(pitch);
  const perspective = 1 / Math.max(1.8, 3.9 - viewZ * 0.34);
  const scale = Math.min(size.width, size.height) * 1.42;
  return {
    ...vertex,
    sx: size.width * 0.5 + yawX * scale * perspective,
    sy: size.height * 0.46 - viewY * scale * perspective,
    viewX: yawX,
    viewY,
    viewZ,
  };
}

function interpolateVertex(a, b, amount) {
  return {
    x: lerp(a.x, b.x, amount),
    y: lerp(a.y, b.y, amount),
    z: lerp(a.z, b.z, amount),
    u: lerp(a.u, b.u, amount),
    v: lerp(a.v, b.v, amount),
    strain: lerp(a.strain, b.strain, amount),
  };
}

function sectionDistance(vertex, offset) {
  const angle = state.sectionAngle * Math.PI / 180;
  return vertex.x * Math.cos(angle) + vertex.y * Math.sin(angle) + vertex.z * 0.34 - offset;
}

function edgeSection(a, b, offset) {
  const distanceA = sectionDistance(a, offset);
  const distanceB = sectionDistance(b, offset);
  if (distanceA * distanceB > 0 || Math.abs(distanceA - distanceB) < 1e-8) return null;
  const amount = distanceA / (distanceA - distanceB);
  return interpolateVertex(a, b, clamp(amount, 0, 1));
}

function makeSections(vertices, offset) {
  const segments = [];
  const points = [];
  for (let row = 0; row < ROWS - 1; row += 1) {
    for (let column = 0; column < COLS - 1; column += 1) {
      const corners = [
        vertices[vertexIndex(column, row)],
        vertices[vertexIndex(column + 1, row)],
        vertices[vertexIndex(column + 1, row + 1)],
        vertices[vertexIndex(column, row + 1)],
      ];
      const crossings = [];
      for (let edge = 0; edge < 4; edge += 1) {
        const crossing = edgeSection(corners[edge], corners[(edge + 1) % 4], offset);
        if (crossing && !crossings.some((point) => Math.hypot(point.u - crossing.u, point.v - crossing.v) < 1e-5)) {
          crossings.push(crossing);
        }
      }
      if (crossings.length >= 2) {
        segments.push([project(crossings[0]), project(crossings[1])]);
        points.push(...crossings);
        if (crossings.length === 4) {
          segments.push([project(crossings[2]), project(crossings[3])]);
          points.push(crossings[2], crossings[3]);
        }
      }
    }
  }

  const unique = [];
  for (const point of points) {
    if (!unique.some((other) => Math.hypot(other.u - point.u, other.v - point.v) < 0.025)) {
      unique.push(point);
    }
  }
  return { segments, points: unique.map(project) };
}

function strainColor(strain, alpha = 1) {
  const amount = clamp(strain / 0.75, 0, 1);
  const from = [36, 87, 197];
  const to = [230, 79, 53];
  const channels = from.map((value, index) => Math.round(lerp(value, to[index], amount)));
  return `rgba(${channels.join(",")},${alpha})`;
}

function drawField(projected) {
  const cells = [];
  for (let row = 0; row < ROWS - 1; row += 1) {
    for (let column = 0; column < COLS - 1; column += 1) {
      const corners = [
        projected[vertexIndex(column, row)],
        projected[vertexIndex(column + 1, row)],
        projected[vertexIndex(column + 1, row + 1)],
        projected[vertexIndex(column, row + 1)],
      ];
      cells.push({
        corners,
        depth: corners.reduce((sum, point) => sum + point.viewZ, 0) / 4,
        strain: corners.reduce((sum, point) => sum + point.strain, 0) / 4,
      });
    }
  }
  cells.sort((a, b) => a.depth - b.depth);
  for (const cell of cells) {
    context.beginPath();
    context.moveTo(cell.corners[0].sx, cell.corners[0].sy);
    cell.corners.slice(1).forEach((point) => context.lineTo(point.sx, point.sy));
    context.closePath();
    context.fillStyle = strainColor(cell.strain, 0.035 + clamp(cell.depth + 1, 0, 2) * 0.018);
    context.fill();
  }

  context.lineWidth = 0.65;
  for (let row = 0; row < ROWS; row += 1) {
    context.beginPath();
    for (let column = 0; column < COLS; column += 1) {
      const point = projected[vertexIndex(column, row)];
      if (column === 0) context.moveTo(point.sx, point.sy);
      else context.lineTo(point.sx, point.sy);
    }
    context.strokeStyle = "rgba(23,25,24,.30)";
    context.stroke();
  }
  for (let column = 0; column < COLS; column += 1) {
    context.beginPath();
    for (let row = 0; row < ROWS; row += 1) {
      const point = projected[vertexIndex(column, row)];
      if (row === 0) context.moveTo(point.sx, point.sy);
      else context.lineTo(point.sx, point.sy);
    }
    context.strokeStyle = "rgba(23,25,24,.30)";
    context.stroke();
  }
}

function drawSection(section, activePoints) {
  const active = new Set(activePoints);
  context.lineWidth = 3.3;
  context.lineCap = "round";
  context.strokeStyle = violet;
  for (const segment of section.segments) {
    context.beginPath();
    context.moveTo(segment[0].sx, segment[0].sy);
    context.lineTo(segment[1].sx, segment[1].sy);
    context.stroke();
  }
  context.lineCap = "butt";

  for (const point of section.points) {
    context.beginPath();
    context.arc(point.sx, point.sy, active.has(point) ? 4.4 : 3.1, 0, TAU);
    context.fillStyle = active.has(point) ? violet : paper;
    context.fill();
    context.lineWidth = 1.4;
    context.strokeStyle = active.has(point) ? paper : strainColor(point.strain);
    context.stroke();
  }
}

function drawFocus(projected) {
  let closest = projected[0];
  let closestDistance = Infinity;
  for (const point of projected) {
    const distance = Math.hypot(point.u - state.focusU, point.v - state.focusV);
    if (distance < closestDistance) {
      closest = point;
      closestDistance = distance;
    }
  }
  const radius = 10 + state.focusSize * 14;
  context.beginPath();
  context.arc(closest.sx, closest.sy, radius, 0, TAU);
  context.strokeStyle = "rgba(23,25,24,.72)";
  context.setLineDash([3, 4]);
  context.lineWidth = 1;
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.arc(closest.sx, closest.sy, 2.6, 0, TAU);
  context.fillStyle = state.focus >= 0 ? red : blue;
  context.fill();
}

function chooseVoices(points) {
  if (points.length <= state.voices) return [...points].sort((a, b) => a.v - b.v || a.u - b.u);
  const ordered = [...points].sort((a, b) => a.v - b.v || a.u - b.u);
  const chosen = [];
  for (let index = 0; index < state.voices; index += 1) {
    chosen.push(ordered[Math.round(index * (ordered.length - 1) / (state.voices - 1))]);
  }
  return chosen;
}

function updateSound(chosen) {
  if (!state.playing) return;
  const register = 2 ** state.register;
  const specs = chosen.map((point) => {
    let normalized;
    if (state.mapping === "position") normalized = clamp((1 - point.v) * 0.5, 0, 1);
    else if (state.mapping === "strain") normalized = clamp(point.strain / 0.85, 0, 1);
    else normalized = clamp((point.viewZ + 1.7) / 3.4, 0, 1);
    const frequency = 82.4 * register * 2 ** (normalized * 3.35);
    return {
      frequency,
      gain: 0.012 + clamp(point.strain, 0, 0.7) * 0.012,
      pan: clamp((point.sx / size.width * 2 - 1) * state.spread, -1, 1),
      type: point.strain > 0.42 ? "triangle" : "sine",
    };
  });
  const meanStrain = chosen.reduce((sum, point) => sum + point.strain, 0) / Math.max(1, chosen.length);
  sound.update(specs, {
    cutoff: 2100 + clamp(meanStrain, 0, 1) * 6200,
    feedback: 0.1 + state.relief * 0.055,
    smoothing: 0.035,
  });
}

function updateReadout(points, activePoints) {
  const meanStrain = points.reduce((sum, point) => sum + point.strain, 0) / Math.max(1, points.length);
  const depthValues = points.map((point) => point.viewZ);
  const depthSpread = depthValues.length
    ? Math.max(...depthValues) - Math.min(...depthValues)
    : 0;
  $("#readout").textContent = `${points.length} section points · ${activePoints.length} sounding · mean strain ${Math.round(meanStrain * 100)}% · depth spread ${depthSpread.toFixed(2)}`;
}

function setFocusFromPointer(event) {
  if (projectedVertices.length === 0) return;
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  let closest = projectedVertices[0];
  let distance = Infinity;
  for (const point of projectedVertices) {
    const candidate = (point.sx - x) ** 2 + (point.sy - y) ** 2;
    if (candidate < distance) {
      closest = point;
      distance = candidate;
    }
  }
  state.focusU = closest.u;
  state.focusV = closest.v;
}

canvas.addEventListener("pointerdown", (event) => {
  state.dragging = true;
  canvas.setPointerCapture(event.pointerId);
  setFocusFromPointer(event);
});
canvas.addEventListener("pointermove", (event) => {
  if (state.dragging) setFocusFromPointer(event);
});
canvas.addEventListener("pointerup", (event) => {
  state.dragging = false;
  canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("pointercancel", () => { state.dragging = false; });

function resize() {
  size = resizeCanvas(canvas, context);
}
window.addEventListener("resize", resize);
document.addEventListener("visibilitychange", () => {
  lastTime = performance.now();
  if (document.hidden) sound.silence();
});
resize();

function frame(now) {
  const elapsed = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  if (state.playing) state.phase = (state.phase + elapsed * state.rate) % 1;

  const vertices = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS; column += 1) {
      vertices.push(makeVertex(column, row, state.phase));
    }
  }
  calculateStrain(vertices);
  projectedVertices = vertices.map(project);
  const offset = Math.sin(state.phase * TAU) * (0.68 + state.stretch * 0.38);
  const section = makeSections(vertices, offset);
  const activePoints = chooseVoices(section.points);

  context.clearRect(0, 0, size.width, size.height);
  drawField(projectedVertices);
  drawSection(section, activePoints);
  drawFocus(projectedVertices);
  updateSound(activePoints);
  updateReadout(section.points, activePoints);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
