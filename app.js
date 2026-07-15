import { IsohedralTiling, EdgeShape, mul } from "./vendor/tactile/tactile.js";

const $ = (query) => document.querySelector(query);
const $$ = (query) => [...document.querySelectorAll(query)];
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

const FORM_SPECS = [
  { name: "triangle", type: 69, symbol: "△" },
  { name: "square", type: 39, symbol: "□" },
  { name: "pentagon", type: 20, symbol: "⬠" },
  { name: "hexagon", type: 1, symbol: "⬡" },
];
const PALETTE = ["#e5a938", "#e4573e", "#315cc4"];

const state = {
  form: 1,
  crease: 0.18,
  repeat: 0,
  fold: 0,
  beyond: 0,
  pulse: 1,
  playing: false,
  progress: 0,
  viewX: -0.46,
  viewY: 0.58,
  lastTime: 0,
  pointerDown: false,
  dragMode: null,
  pointer: { x: 0, y: 0 },
};

const canvas = $("#score");
const ctx = canvas.getContext("2d");
let width = 1000;
let height = 700;
let dpr = 1;
let tiling;
let defaultParams = [];
let edgeControls = [];
let revealedTiles = [];
let seedScreenVertices = [];

class SoundPaper {
  constructor() {
    this.context = null;
    this.master = null;
    this.filter = null;
    this.voices = [];
  }

  async ensure() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = 0.72;
      this.filter = this.context.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = 4200;
      this.filter.Q.value = 0.5;
      this.filter.connect(this.master).connect(this.context.destination);
      for (let index = 0; index < 10; index += 1) {
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();
        const pan = this.context.createStereoPanner();
        oscillator.type = index % 3 === 0 ? "sine" : "triangle";
        oscillator.frequency.value = 220;
        gain.gain.value = 0;
        oscillator.connect(gain).connect(pan).connect(this.filter);
        oscillator.start();
        this.voices.push({ oscillator, gain, pan });
      }
    }
    await this.context.resume();
  }

  update(specs, brightness = 1) {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.filter.frequency.setTargetAtTime(lerp(700, 5800, clamp(brightness, 0, 1)), now, 0.04);
    this.voices.forEach((voice, index) => {
      const spec = specs[index];
      voice.oscillator.type = spec?.type || "sine";
      voice.oscillator.frequency.setTargetAtTime(spec?.frequency || 220, now, 0.018);
      voice.gain.gain.setTargetAtTime(spec?.gain || 0, now, spec ? 0.016 : 0.045);
      voice.pan.pan.setTargetAtTime(spec?.pan || 0, now, 0.025);
    });
  }

  silence() { this.update([]); }

  pluck(frequency, pan = 0) {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.997, now + 0.5);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.72);
    panner.pan.value = clamp(pan, -1, 1);
    oscillator.connect(gain).connect(panner).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.75);
  }
}

const sound = new SoundPaper();

function resizeCanvas() {
  const bounds = canvas.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  width = bounds.width;
  height = bounds.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function refreshTiling() {
  const spec = FORM_SPECS[state.form];
  tiling = new IsohedralTiling(spec.type);
  defaultParams = tiling.getParameters();
  applyCrease();
}

function applyCrease() {
  if (!tiling) return;
  const displacement = (state.crease - 0.18) * 0.42;
  const parameters = defaultParams.map((value, index) => value + displacement * (index % 2 ? -0.62 : 1));
  tiling.setParameters(parameters);
  edgeControls = [];
  for (let index = 0; index < tiling.numEdgeShapes(); index += 1) {
    const shape = tiling.getEdgeShape(index);
    const bend = state.crease * 0.38;
    const c1 = { x: 0.28, y: bend * (index % 2 ? -1 : 1) };
    let c2 = { x: 0.72, y: -bend * (index % 2 ? -1 : 1) };
    if (shape === EdgeShape.S) c2 = { x: 1 - c1.x, y: -c1.y };
    if (shape === EdgeShape.U) c2 = { x: 1 - c1.x, y: c1.y };
    edgeControls.push(shape === EdgeShape.I ? [] : [c1, c2]);
  }
}

function cubic(a, b, c, d, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt * mt * t * b.x + 3 * mt * t * t * c.x + t ** 3 * d.x,
    y: mt ** 3 * a.y + 3 * mt * mt * t * b.y + 3 * mt * t * t * c.y + t ** 3 * d.y,
  };
}

function prototilePath(transform = [1, 0, 0, 0, 1, 0], curveSamples = 6) {
  const points = [];
  for (const segment of tiling.shape()) {
    const segmentTransform = mul(transform, segment.T);
    let local = [{ x: 0, y: 0 }];
    const controls = edgeControls[segment.id] || [];
    if (segment.shape !== EdgeShape.I && controls.length === 2) {
      for (let step = 1; step <= curveSamples; step += 1) {
        local.push(cubic({ x: 0, y: 0 }, controls[0], controls[1], { x: 1, y: 0 }, step / curveSamples));
      }
    } else {
      local.push({ x: 1, y: 0 });
    }
    if (segment.rev) local.reverse();
    for (const point of local) {
      const transformed = mul(segmentTransform, point);
      const previous = points.at(-1);
      if (!previous || Math.hypot(previous.x - transformed.x, previous.y - transformed.y) > 1e-6) points.push(transformed);
    }
  }
  if (points.length > 2 && Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) < 1e-6) points.pop();
  return points;
}

function centroid(points) {
  return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
}

function straightSeedVertices() {
  const points = tiling.vertices();
  const center = centroid(points);
  const scale = 1 / Math.max(...points.map((point) => Math.hypot(point.x - center.x, point.y - center.y)), 1e-6);
  return points.map((point) => ({ x: (point.x - center.x) * scale, y: (point.y - center.y) * scale }));
}

function worldSetup() {
  const seed = prototilePath();
  const center = centroid(seed);
  const scale = lerp(Math.min(width, height) * 0.245, Math.min(width, height) * 0.075, ease(state.repeat));
  return { seed, center, scale };
}

function collectTileInstances(setup) {
  const radius = lerp(2.5, 9, state.repeat);
  const candidates = [];
  for (const instance of tiling.fillRegionBounds(setup.center.x - radius, setup.center.y - radius, setup.center.x + radius, setup.center.y + radius)) {
    const path = prototilePath(instance.T, state.fold > 0.04 ? 2 : 5);
    const center = centroid(path);
    candidates.push({ ...instance, path, center, distance: Math.hypot(center.x - setup.center.x, center.y - setup.center.y) });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.aspect - b.aspect);
  const count = Math.max(1, Math.floor(lerp(1, Math.min(108, candidates.length), ease(state.repeat))));
  return candidates.slice(0, count);
}

function rotate3(point, angleX, angleY) {
  const cy = Math.cos(angleY), sy = Math.sin(angleY);
  const cx = Math.cos(angleX), sx = Math.sin(angleX);
  const x1 = cy * point.x + sy * point.z;
  const z1 = -sy * point.x + cy * point.z;
  return { x: x1, y: cx * point.y - sx * z1, z: sx * point.y + cx * z1 };
}

function surfacePoint(point, setup) {
  const x = (point.x - setup.center.x) * setup.scale;
  const y = (point.y - setup.center.y) * setup.scale;
  const nx = point.x - setup.center.x;
  const ny = point.y - setup.center.y;
  const z = state.fold * setup.scale * 0.78 * (Math.sin(nx * 1.35) * 0.58 + Math.cos(ny * 1.58) * 0.42);
  const rotated = rotate3({ x, y, z }, state.viewX * state.fold, state.viewY * state.fold);
  const perspective = 5 * setup.scale / Math.max(setup.scale, 5 * setup.scale - rotated.z);
  return {
    x: width * 0.5 + rotated.x * perspective,
    y: height * 0.46 + rotated.y * perspective,
    z: rotated.z / setup.scale,
  };
}

function drawPath(points, options = {}) {
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  if (options.closed !== false) ctx.closePath();
  if (options.fill) { ctx.fillStyle = options.fill; ctx.fill(); }
  ctx.strokeStyle = options.stroke || "#171918";
  ctx.lineWidth = options.width || 1;
  ctx.lineJoin = "round";
  ctx.stroke();
}

function drawDot(point, radius, fill, stroke = null) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function pointAlongLoop(points, progress) {
  const lengths = [];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index], b = points[(index + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(length);
    total += length;
  }
  let target = (((progress % 1) + 1) % 1) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    if (target <= lengths[index]) {
      const a = points[index], b = points[(index + 1) % points.length];
      const t = target / Math.max(lengths[index], 1e-6);
      return { point: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }, segment: index, segmentProgress: t, total };
    }
    target -= lengths[index];
  }
  return { point: points[0], segment: 0, segmentProgress: 0, total };
}

function cornerStrength(points, segment) {
  const previous = points[(segment - 1 + points.length) % points.length];
  const current = points[segment];
  const next = points[(segment + 1) % points.length];
  const a = Math.atan2(current.y - previous.y, current.x - previous.x);
  const b = Math.atan2(next.y - current.y, next.x - current.x);
  let turn = Math.abs(b - a);
  if (turn > Math.PI) turn = TAU - turn;
  return clamp(turn / Math.PI, 0, 1);
}

function heightToFrequency(screenY, transpose = 0) {
  const normalized = clamp(screenY / height, 0, 1);
  return 220 * 2 ** ((0.53 - normalized) * 2.15 + transpose);
}

function renderSheet() {
  const setup = worldSetup();
  revealedTiles = collectTileInstances(setup);
  const fadeForBeyond = 1 - ease(state.beyond) * 0.86;
  const projectedTiles = revealedTiles.map((tile) => ({ ...tile, screen: tile.path.map((point) => surfacePoint(point, setup)) }));
  projectedTiles.sort((a, b) => (a.screen.reduce((sum, p) => sum + p.z, 0) / a.screen.length) - (b.screen.reduce((sum, p) => sum + p.z, 0) / b.screen.length));

  ctx.save();
  ctx.globalAlpha = fadeForBeyond;
  projectedTiles.forEach((tile, index) => {
    const colorIndex = tiling.getColour(tile.t1, tile.t2, tile.aspect) % PALETTE.length;
    const alpha = lerp(0.25, 0.69, 1 - index / Math.max(1, projectedTiles.length));
    drawPath(tile.screen, { fill: `${PALETTE[colorIndex]}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`, stroke: "rgba(23,25,24,.72)", width: state.fold > 0.05 ? 0.8 : 1 });
  });
  ctx.restore();

  const seedTile = projectedTiles[0];
  if (seedTile) {
    seedScreenVertices = tiling.vertices().map((point) => surfacePoint(mul(seedTile.T, point), setup));
    if (state.repeat < 0.15) {
      seedScreenVertices.forEach((point) => drawDot(point, 4.2, "#f1eee6", "#171918"));
    }
  }

  const voiceCount = Math.min(5, Math.max(1, Math.ceil(1 + state.repeat * 4)));
  const voices = [];
  for (let index = 0; index < voiceCount; index += 1) {
    const tile = projectedTiles[index * Math.max(1, Math.floor(projectedTiles.length / voiceCount))] || seedTile;
    if (!tile) continue;
    const phase = (state.progress - index * state.repeat * 0.115 + 1) % 1;
    const play = pointAlongLoop(tile.screen, phase);
    const color = index % 2 ? "#2457c5" : "#e64f35";
    drawDot(play.point, index ? 3.4 : 5.4, color);
    if (state.playing) {
      const attack = cornerStrength(tile.screen, play.segment);
      const envelope = 0.026 + Math.exp(-play.segmentProgress * 6) * attack * (0.08 / Math.sqrt(voiceCount));
      const aspectTranspose = tile.aspect / Math.max(1, tiling.numAspects()) * 0.5;
      voices.push({
        frequency: heightToFrequency(play.point.y, aspectTranspose),
        gain: envelope,
        pan: clamp(play.point.x / width * 2 - 1, -1, 1),
        type: index % 3 === 1 ? "triangle" : "sine",
      });
    }
  }
  return { setup, voices };
}

function rotatePlane(vector, a, b, angle) {
  const out = [...vector];
  const c = Math.cos(angle), s = Math.sin(angle);
  out[a] = c * vector[a] - s * vector[b];
  out[b] = s * vector[a] + c * vector[b];
  return out;
}

function hyperGeometry() {
  const seed = straightSeedVertices();
  const n = seed.length;
  const vertices = [];
  for (let wLayer = 0; wLayer < 2; wLayer += 1) {
    for (let zLayer = 0; zLayer < 2; zLayer += 1) {
      for (const point of seed) vertices.push([point.x, point.y, zLayer ? 0.76 : -0.76, wLayer ? 0.92 : -0.92]);
    }
  }
  const at = (w, z, i) => (w * 2 + z) * n + i;
  const edges = [];
  for (let w = 0; w < 2; w += 1) for (let z = 0; z < 2; z += 1) for (let i = 0; i < n; i += 1) edges.push([at(w, z, i), at(w, z, (i + 1) % n)]);
  for (let w = 0; w < 2; w += 1) for (let i = 0; i < n; i += 1) edges.push([at(w, 0, i), at(w, 1, i)]);
  for (let z = 0; z < 2; z += 1) for (let i = 0; i < n; i += 1) edges.push([at(0, z, i), at(1, z, i)]);
  return { vertices, edges };
}

function convexHull(points) {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of sorted) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point); }
  const upper = [];
  for (const point of [...sorted].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function renderBeyond(existingVoices) {
  if (state.beyond <= 0.004) return existingVoices;
  const hyper = hyperGeometry();
  const intensity = ease(state.beyond);
  const xw = intensity * (0.42 + Math.sin(state.progress * TAU) * 0.74);
  const yw = intensity * (0.28 + Math.cos(state.progress * TAU * 0.73) * 0.52);
  const rotated = hyper.vertices.map((original) => {
    let vector = rotatePlane(original, 0, 3, xw);
    vector = rotatePlane(vector, 1, 3, yw);
    vector = rotatePlane(vector, 0, 2, state.viewY);
    vector = rotatePlane(vector, 1, 2, state.viewX);
    return vector;
  });
  const scale = Math.min(width, height) * lerp(0.12, 0.205, intensity);
  const projected = rotated.map((v) => {
    const wScale = 3.25 / (3.25 - v[3]);
    const x3 = v[0] * wScale, y3 = v[1] * wScale, z3 = v[2] * wScale;
    const zScale = 4.3 / (4.3 - z3);
    return { x: width * 0.5 + x3 * zScale * scale, y: height * 0.45 + y3 * zScale * scale, depth: clamp((z3 + v[3] + 3) / 6, 0, 1) };
  });

  ctx.save();
  ctx.globalAlpha = intensity;
  const sortedEdges = hyper.edges.map((edge) => ({ edge, depth: (projected[edge[0]].depth + projected[edge[1]].depth) * 0.5 })).sort((a, b) => a.depth - b.depth);
  sortedEdges.forEach(({ edge: [a, b], depth }) => {
    ctx.beginPath();
    ctx.moveTo(projected[a].x, projected[a].y);
    ctx.lineTo(projected[b].x, projected[b].y);
    ctx.strokeStyle = `rgba(${a < hyper.vertices.length / 2 ? "36,87,197" : "101,86,201"},${0.22 + depth * 0.7})`;
    ctx.lineWidth = 0.7 + depth * 1.25;
    ctx.stroke();
  });
  projected.forEach((point, index) => drawDot(point, 2.2 + point.depth * 1.8, index < projected.length / 2 ? "#2457c5" : "#6556c9"));

  const sliceW = Math.sin(state.progress * TAU) * 1.12;
  const intersections = [];
  hyper.edges.forEach(([a, b]) => {
    const wa = rotated[a][3], wb = rotated[b][3];
    if ((wa - sliceW) * (wb - sliceW) > 0 || Math.abs(wa - wb) < 1e-6) return;
    const t = (sliceW - wa) / (wb - wa);
    intersections.push({
      x: lerp(projected[a].x, projected[b].x, t),
      y: lerp(projected[a].y, projected[b].y, t),
      depth: lerp(projected[a].depth, projected[b].depth, t),
    });
  });
  if (intersections.length >= 3) {
    const hull = convexHull(intersections);
    drawPath(hull, { fill: "rgba(233,185,73,.20)", stroke: "#e9b949", width: 1.7 });
    intersections.forEach((point) => drawDot(point, 3, "#f1eee6", "#e9b949"));
  }
  ctx.restore();

  if (!state.playing) return existingVoices;
  const count = Math.min(4, intersections.length);
  const hyperVoices = [];
  for (let index = 0; index < count; index += 1) {
    const point = intersections[index];
    hyperVoices.push({
      frequency: heightToFrequency(point.y, 0.03 * sliceW + index / 12),
      gain: intensity * 0.025,
      pan: clamp(point.x / width * 2 - 1, -1, 1),
      type: "sine",
    });
  }
  return [...existingVoices.slice(0, Math.max(1, 8 - hyperVoices.length)), ...hyperVoices];
}

function updateStageText() {
  const spec = FORM_SPECS[state.form];
  let phase = "A — outline";
  if (state.repeat > 0.08) phase = "B — isohedral field";
  if (state.fold > 0.08) phase = "C — folded surface";
  if (state.beyond > 0.08) phase = "D — 4D shadow";
  $("#phaseReadout").textContent = phase;
  const count = state.repeat < 0.03 ? "ONE TILE" : `${revealedTiles.length} TILES`;
  $("#stageState").textContent = `${count} · IH${String(spec.type).padStart(2, "0")}`;
  $("#stageHint").textContent = state.fold > 0.08 || state.beyond > 0.08 ? "DRAG TO ROTATE" : "DRAG A VERTEX";
  $("#axisKey").classList.toggle("visible", state.fold > 0.08 || state.beyond > 0.08);
}

function render(time) {
  if (!state.lastTime) state.lastTime = time;
  const delta = Math.min(60, time - state.lastTime);
  state.lastTime = time;
  if (state.playing) state.progress = (state.progress + delta / 5200 * state.pulse) % 1;
  ctx.clearRect(0, 0, width, height);
  const { voices } = renderSheet();
  const allVoices = renderBeyond(voices);
  if (state.playing) sound.update(allVoices, clamp(0.95 - state.fold * 0.35 + state.beyond * 0.22, 0, 1));
  const percent = `${state.progress * 100}%`;
  $("#timelineFill").style.width = percent;
  $("#timelineHead").style.left = percent;
  updateStageText();
  requestAnimationFrame(render);
}

function updateControl(id, value, text) {
  $(`#${id}`).value = value;
  $(`#${id}Out`).textContent = text;
}

function bindRange(id, key, formatter, callback) {
  const input = $(`#${id}`);
  input.addEventListener("input", () => {
    state[key] = Number(input.value);
    $(`#${id}Out`).textContent = formatter(state[key]);
    callback?.();
    $("#firstInstruction").classList.add("dismissed");
  });
}

bindRange("form", "form", (value) => FORM_SPECS[value].name, refreshTiling);
bindRange("crease", "crease", (value) => `${Math.round(value * 100)}%`, applyCrease);
bindRange("repeat", "repeat", (value) => value < 0.03 ? "one" : `${Math.round(lerp(1, 108, ease(value)))}`);
bindRange("fold", "fold", (value) => value < 0.03 ? "flat" : `${Math.round(value * 90)}°`);
bindRange("beyond", "beyond", (value) => value < 0.03 ? "2D" : value < 0.52 ? "3D" : "4D");
bindRange("pulse", "pulse", (value) => `${value.toFixed(2)}×`);

$("#transport").addEventListener("click", async () => {
  if (!state.playing) await sound.ensure();
  state.playing = !state.playing;
  if (!state.playing) sound.silence();
  $("#transport").classList.toggle("playing", state.playing);
  $(".transport-icon").textContent = state.playing ? "■" : "▶";
  $("#transport b").textContent = state.playing ? "pause the fold" : "hear the fold";
  $("#transport small").textContent = state.playing ? "the score is moving" : "audio starts here";
  $("#firstInstruction").classList.add("dismissed");
});

function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

canvas.addEventListener("pointerdown", async (event) => {
  const point = canvasPoint(event);
  state.pointerDown = true;
  state.pointer = point;
  canvas.setPointerCapture(event.pointerId);
  const nearestVertex = seedScreenVertices.reduce((best, vertex, index) => {
    const distance = Math.hypot(vertex.x - point.x, vertex.y - point.y);
    return distance < best.distance ? { index, distance } : best;
  }, { index: -1, distance: Infinity });
  state.dragMode = state.fold > 0.08 || state.beyond > 0.08 ? "rotate" : nearestVertex.distance < 34 ? "crease" : "pluck";
  await sound.ensure();
  const frequency = heightToFrequency(point.y, state.beyond * 0.12);
  sound.pluck(frequency, point.x / width * 2 - 1);
  $("#firstInstruction").classList.add("dismissed");
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.pointerDown) return;
  const point = canvasPoint(event);
  const dx = point.x - state.pointer.x;
  const dy = point.y - state.pointer.y;
  if (state.dragMode === "rotate") {
    state.viewY += dx * 0.008;
    state.viewX += dy * 0.008;
  } else if (state.dragMode === "crease") {
    state.crease = clamp(state.crease + (dx - dy) * 0.003, 0, 1);
    updateControl("crease", state.crease, `${Math.round(state.crease * 100)}%`);
    applyCrease();
  }
  state.pointer = point;
});

canvas.addEventListener("pointerup", () => { state.pointerDown = false; state.dragMode = null; });
canvas.addEventListener("pointercancel", () => { state.pointerDown = false; state.dragMode = null; });

const dialog = $("#aboutDialog");
$("#aboutOpen").addEventListener("click", () => dialog.showModal());
$("#aboutClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

new ResizeObserver(resizeCanvas).observe(canvas);
refreshTiling();
resizeCanvas();
requestAnimationFrame(render);
