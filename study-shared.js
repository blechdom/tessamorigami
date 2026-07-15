import { EdgeShape, IsohedralTiling, mul } from "./vendor/tactile/tactile.js";

export const TAU = Math.PI * 2;
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = (t) => t * t * (3 - 2 * t);
export const wrap01 = (value) => ((value % 1) + 1) % 1;
export const $ = (query, root = document) => root.querySelector(query);

export const FORM_SPECS = [
  { name: "triangle", type: 69, symbol: "△" },
  { name: "square", type: 39, symbol: "□" },
  { name: "pentagon", type: 20, symbol: "⬠" },
  { name: "hexagon", type: 1, symbol: "⬡" },
];

export function resizeCanvas(canvas, context, maxDpr = 2) {
  const bounds = canvas.getBoundingClientRect();
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: bounds.width, height: bounds.height, dpr };
}

export function bindRange(id, state, key, formatter, callback) {
  const input = document.getElementById(id);
  const output = document.getElementById(`${id}Out`);
  input.addEventListener("input", () => {
    state[key] = Number(input.value);
    if (output) output.textContent = formatter(state[key]);
    callback?.(state[key]);
  });
}

function cubic(a, b, c, d, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt * mt * t * b.x + 3 * mt * t * t * c.x + t ** 3 * d.x,
    y: mt ** 3 * a.y + 3 * mt * mt * t * b.y + 3 * mt * t * t * c.y + t ** 3 * d.y,
  };
}

export function createCurvedTiling(type, curvature = 0) {
  const tiling = new IsohedralTiling(type);
  const controls = [];
  for (let index = 0; index < tiling.numEdgeShapes(); index += 1) {
    const shape = tiling.getEdgeShape(index);
    const direction = index % 2 ? -1 : 1;
    const c1 = { x: 0.28, y: curvature * 0.42 * direction };
    let c2 = { x: 0.72, y: -curvature * 0.42 * direction };
    if (shape === EdgeShape.S) c2 = { x: 1 - c1.x, y: -c1.y };
    if (shape === EdgeShape.U) c2 = { x: 1 - c1.x, y: c1.y };
    controls.push(shape === EdgeShape.I ? [] : [c1, c2]);
  }
  return { tiling, controls };
}

export function samplePrototile(tiling, controls, transform = [1, 0, 0, 0, 1, 0], samples = 8) {
  const points = [];
  for (const segment of tiling.shape()) {
    const segmentTransform = mul(transform, segment.T);
    let local = [{ x: 0, y: 0 }];
    const edgeControls = controls[segment.id] || [];
    if (segment.shape !== EdgeShape.I && edgeControls.length === 2) {
      for (let step = 1; step <= samples; step += 1) {
        local.push(cubic(
          { x: 0, y: 0 },
          edgeControls[0],
          edgeControls[1],
          { x: 1, y: 0 },
          step / samples,
        ));
      }
    } else {
      local.push({ x: 1, y: 0 });
    }
    if (segment.rev) local.reverse();
    for (const point of local) {
      const transformed = mul(segmentTransform, point);
      const previous = points.at(-1);
      if (!previous || Math.hypot(previous.x - transformed.x, previous.y - transformed.y) > 1e-7) {
        points.push(transformed);
      }
    }
  }
  if (points.length > 2 && Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) < 1e-7) {
    points.pop();
  }
  return points;
}

export function centroid(points) {
  if (points.length === 0) return { x: 0, y: 0 };
  return points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
}

export function intersectSegmentWithLine(a, b, origin, normal) {
  const da = (a.x - origin.x) * normal.x + (a.y - origin.y) * normal.y;
  const db = (b.x - origin.x) * normal.x + (b.y - origin.y) * normal.y;
  if (Math.abs(da - db) < 1e-9 || da * db > 0) return null;
  const t = da / (da - db);
  if (t < 0 || t > 1) return null;
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), t };
}

export function dedupePoints(points, tolerance = 1.5) {
  const kept = [];
  for (const point of points) {
    if (!kept.some((other) => Math.hypot(other.x - point.x, other.y - point.y) < tolerance)) {
      kept.push(point);
    }
  }
  return kept;
}

export class VoiceBank {
  constructor(maxVoices = 24, options = {}) {
    this.maxVoices = maxVoices;
    this.options = options;
    this.context = null;
    this.voices = [];
  }

  async ensure() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = this.options.master ?? 0.55;
      this.filter = this.context.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = this.options.cutoff ?? 5200;
      this.filter.Q.value = 0.4;

      this.delay = this.context.createDelay(1.5);
      this.delay.delayTime.value = this.options.delayTime ?? 0.19;
      this.feedback = this.context.createGain();
      this.feedback.gain.value = this.options.feedback ?? 0.12;
      this.wet = this.context.createGain();
      this.wet.gain.value = this.options.wet ?? 0.08;
      this.delay.connect(this.feedback).connect(this.delay);
      this.delay.connect(this.wet).connect(this.master);
      this.filter.connect(this.master);
      this.filter.connect(this.delay);
      this.master.connect(this.context.destination);

      for (let index = 0; index < this.maxVoices; index += 1) {
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();
        const pan = this.context.createStereoPanner();
        oscillator.type = "sine";
        oscillator.frequency.value = 220;
        gain.gain.value = 0;
        oscillator.connect(gain).connect(pan).connect(this.filter);
        oscillator.start();
        this.voices.push({ oscillator, gain, pan });
      }
    }
    await this.context.resume();
  }

  update(specs, options = {}) {
    if (!this.context) return;
    const now = this.context.currentTime;
    const smoothing = options.smoothing ?? 0.025;
    if (Number.isFinite(options.cutoff)) {
      this.filter.frequency.setTargetAtTime(clamp(options.cutoff, 120, 12000), now, 0.05);
    }
    if (Number.isFinite(options.feedback)) {
      this.feedback.gain.setTargetAtTime(clamp(options.feedback, 0, 0.72), now, 0.08);
    }
    this.voices.forEach((voice, index) => {
      const spec = specs[index];
      voice.oscillator.type = spec?.type || "sine";
      voice.oscillator.frequency.setTargetAtTime(clamp(spec?.frequency || 220, 35, 12000), now, smoothing);
      voice.gain.gain.setTargetAtTime(clamp(spec?.gain || 0, 0, 0.14), now, spec ? smoothing : 0.05);
      voice.pan.pan.setTargetAtTime(clamp(spec?.pan || 0, -1, 1), now, smoothing);
    });
  }

  silence() {
    this.update([]);
  }

  pluck(frequency, pan = 0, strength = 0.12) {
    if (!this.context) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(clamp(frequency, 35, 9000), now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(clamp(strength, 0.002, 0.2), now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    panner.pan.value = clamp(pan, -1, 1);
    oscillator.connect(gain).connect(panner).connect(this.filter);
    oscillator.start(now);
    oscillator.stop(now + 0.58);
  }
}

export function attachTransport(button, state, sound, labels = {}) {
  button.addEventListener("click", async () => {
    if (!state.playing) await sound.ensure();
    state.playing = !state.playing;
    if (!state.playing) sound.silence();
    button.classList.toggle("playing", state.playing);
    const icon = button.querySelector(".transport-icon");
    const title = button.querySelector("b");
    const detail = button.querySelector("small");
    if (icon) icon.textContent = state.playing ? "■" : "▶";
    if (title) title.textContent = state.playing ? labels.pause || "pause" : labels.play || "listen";
    if (detail) detail.textContent = state.playing ? labels.active || "the field is moving" : labels.idle || "audio starts here";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) sound.silence();
  });
}
