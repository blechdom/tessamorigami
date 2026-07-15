import {
  $,
  TAU,
  VoiceBank,
  attachTransport,
  bindRange,
  clamp,
  lerp,
  resizeCanvas,
} from "./study-shared.js";

const canvas = $("#gravityCanvas");
const context = canvas.getContext("2d");
const transport = $("#transport");
const readout = $("#fieldReadout");
const instruction = $("#dragInstruction");

const state = {
  playing: false,
  gravityAngle: 90,
  gravity: 0.75,
  stiffness: 0.82,
  damping: 0.018,
  wind: 0,
  turbulence: 0.12,
  resolution: 12,
  speed: 1,
  dragIndex: -1,
  pointer: { x: 0, y: 0, vx: 0, vy: 0, time: 0 },
};

const FIXED_STEP = 1 / 120;
const CONSTRAINT_PASSES = 6;
const MAX_STEPS_PER_FRAME = 16;
const FLOOR_FRACTION = 0.855;
const sound = new VoiceBank(10, {
  master: 0.42,
  cutoff: 3200,
  delayTime: 0.14,
  feedback: 0.08,
  wet: 0.055,
});

let width = 1000;
let height = 700;
let particles = [];
let springs = [];
let columns = state.resolution;
let rows = 8;
let accumulator = 0;
let lastFrame = performance.now();
let simulationTime = 0;
let lastAudioUpdate = 0;
let contactCount = 0;
let collisionQueue = [];
let resizedOnce = false;

function particleIndex(column, row) {
  return row * columns + column;
}

function connect(a, b, kind = "structural", strength = 1) {
  const first = particles[a];
  const second = particles[b];
  springs.push({
    a,
    b,
    kind,
    strength,
    rest: Math.hypot(second.x - first.x, second.y - first.y),
    strain: 0,
  });
}

function buildLattice() {
  columns = Math.round(state.resolution);
  rows = Math.max(5, Math.round(columns * 0.64));
  particles = [];
  springs = [];
  collisionQueue = [];
  contactCount = 0;
  state.dragIndex = -1;

  const span = Math.min(width * 0.62, height * 0.77);
  const spacing = span / Math.max(1, columns - 1);
  const left = width * 0.5 - span * 0.5;
  const top = Math.max(82, height * 0.16);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = left + column * spacing;
      const y = top + row * spacing * 0.88;
      particles.push({
        x,
        y,
        previousX: x,
        previousY: y,
        anchorX: x,
        anchorY: y,
        pinned: row === 0,
        row,
        column,
        tension: 0,
        speed: 0,
        collisionCooldown: 0,
      });
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const here = particleIndex(column, row);
      if (column < columns - 1) connect(here, particleIndex(column + 1, row));
      if (row < rows - 1) connect(here, particleIndex(column, row + 1));

      if (column < columns - 1 && row < rows - 1) {
        connect(here, particleIndex(column + 1, row + 1), "shear", 0.63);
        connect(particleIndex(column + 1, row), particleIndex(column, row + 1), "shear", 0.63);
      }
      if (column < columns - 2) connect(here, particleIndex(column + 2, row), "bend", 0.2);
      if (row < rows - 2) connect(here, particleIndex(column, row + 2), "bend", 0.2);
    }
  }

  const output = $("#resolutionOut");
  if (output) output.textContent = `${columns} × ${rows}`;
  accumulator = 0;
}

function resize() {
  const oldWidth = width;
  const oldHeight = height;
  ({ width, height } = resizeCanvas(canvas, context));

  if (!resizedOnce || particles.length === 0) {
    resizedOnce = true;
    buildLattice();
    return;
  }

  const scaleX = width / Math.max(oldWidth, 1);
  const scaleY = height / Math.max(oldHeight, 1);
  particles.forEach((particle) => {
    particle.x *= scaleX;
    particle.previousX *= scaleX;
    particle.anchorX *= scaleX;
    particle.y *= scaleY;
    particle.previousY *= scaleY;
    particle.anchorY *= scaleY;
  });
  springs.forEach((spring) => {
    const a = particles[spring.a];
    const b = particles[spring.b];
    spring.rest = Math.hypot(b.anchorX - a.anchorX, b.anchorY - a.anchorY);
  });
}

function applyBounds(particle, reportCollision = false) {
  if (particle.pinned) return;
  const margin = 8;
  const floor = height * FLOOR_FRACTION;

  if (particle.x < margin) {
    particle.x = margin;
    particle.previousX = particle.x + (particle.x - particle.previousX) * 0.18;
  } else if (particle.x > width - margin) {
    particle.x = width - margin;
    particle.previousX = particle.x + (particle.x - particle.previousX) * 0.18;
  }

  if (particle.y > floor) {
    const incoming = particle.y - particle.previousY;
    particle.y = floor;
    particle.previousY = floor + Math.max(0, incoming) * 0.18;
    particle.previousX = particle.x - (particle.x - particle.previousX) * 0.74;

    if (reportCollision && incoming > 0.7 && particle.collisionCooldown <= 0) {
      collisionQueue.push({ particle, impact: incoming });
      particle.collisionCooldown = 0.095;
    }
  }
}

function integrate(step) {
  const angle = state.gravityAngle * Math.PI / 180;
  const gravityMagnitude = state.gravity * 980;
  const gravityX = Math.cos(angle) * gravityMagnitude;
  const gravityY = Math.sin(angle) * gravityMagnitude;
  const dragRetention = clamp(1 - state.damping * step * 60, 0.88, 0.9999);
  contactCount = 0;

  particles.forEach((particle, index) => {
    particle.tension = 0;
    particle.collisionCooldown = Math.max(0, particle.collisionCooldown - step);

    if (particle.pinned) {
      particle.x = particle.anchorX;
      particle.y = particle.anchorY;
      particle.previousX = particle.anchorX;
      particle.previousY = particle.anchorY;
      particle.speed = 0;
      return;
    }

    if (index === state.dragIndex) {
      particle.x = clamp(state.pointer.x, 10, width - 10);
      particle.y = clamp(state.pointer.y, 45, height * FLOOR_FRACTION);
      particle.previousX = particle.x - clamp(state.pointer.vx, -1800, 1800) * step;
      particle.previousY = particle.y - clamp(state.pointer.vy, -1800, 1800) * step;
      particle.speed = Math.hypot(state.pointer.vx, state.pointer.vy);
      return;
    }

    const velocityX = (particle.x - particle.previousX) * dragRetention;
    const velocityY = (particle.y - particle.previousY) * dragRetention;
    const phase = simulationTime * (2.1 + state.turbulence * 3.4)
      + particle.column * 0.71
      + particle.row * 0.39;
    const gust = Math.sin(phase) * 0.63 + Math.sin(phase * 0.47 + particle.row) * 0.37;
    const lift = Math.cos(phase * 0.79 - particle.column * 0.32);
    const windX = state.wind * 620 + state.turbulence * 430 * gust;
    const windY = state.turbulence * 110 * lift;

    particle.previousX = particle.x;
    particle.previousY = particle.y;
    particle.x += velocityX + (gravityX + windX) * step * step;
    particle.y += velocityY + (gravityY + windY) * step * step;
    particle.speed = Math.hypot(velocityX, velocityY) / step;
    applyBounds(particle, true);
    if (particle.y >= height * FLOOR_FRACTION - 0.1) contactCount += 1;
  });
}

function solveSprings() {
  const passStiffness = 1 - (1 - state.stiffness) ** (1 / CONSTRAINT_PASSES);

  for (let pass = 0; pass < CONSTRAINT_PASSES; pass += 1) {
    springs.forEach((spring) => {
      const a = particles[spring.a];
      const b = particles[spring.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(0.0001, Math.hypot(dx, dy));
      const rawStrain = (distance - spring.rest) / spring.rest;
      spring.strain = rawStrain;
      const inverseA = a.pinned || spring.a === state.dragIndex ? 0 : 1;
      const inverseB = b.pinned || spring.b === state.dragIndex ? 0 : 1;
      const inverseTotal = inverseA + inverseB;
      if (inverseTotal === 0) return;

      const correction = (distance - spring.rest) / distance
        * passStiffness
        * spring.strength;
      const correctionX = dx * correction;
      const correctionY = dy * correction;
      if (inverseA) {
        a.x += correctionX * (inverseA / inverseTotal);
        a.y += correctionY * (inverseA / inverseTotal);
      }
      if (inverseB) {
        b.x -= correctionX * (inverseB / inverseTotal);
        b.y -= correctionY * (inverseB / inverseTotal);
      }
    });

    particles.forEach((particle, index) => {
      if (particle.pinned) {
        particle.x = particle.anchorX;
        particle.y = particle.anchorY;
      } else if (index !== state.dragIndex) {
        applyBounds(particle, false);
      }
    });
  }

  springs.forEach((spring) => {
    const a = particles[spring.a];
    const b = particles[spring.b];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    spring.strain = (distance - spring.rest) / spring.rest;
    if (spring.kind !== "bend") {
      const positiveTension = Math.max(0, spring.strain);
      a.tension = Math.max(a.tension, positiveTension);
      b.tension = Math.max(b.tension, positiveTension);
    }
  });
}

function simulate(step) {
  simulationTime += step;
  integrate(step);
  solveSprings();
}

function tensionColor(strain, alpha = 1) {
  // The constraints keep geometric extension small, so a few percent is already
  // a meaningful load. Color is intentionally perceptual, while the readout
  // continues to report the unamplified physical ratio.
  const amount = clamp(Math.abs(strain) / 0.035, 0, 1);
  if (strain >= 0) {
    const red = Math.round(lerp(36, 230, amount));
    const green = Math.round(lerp(87, 79, amount));
    const blue = Math.round(lerp(197, 53, amount));
    return `rgba(${red},${green},${blue},${alpha})`;
  }
  const red = Math.round(lerp(36, 101, amount));
  const green = Math.round(lerp(87, 86, amount));
  const blue = Math.round(lerp(197, 201, amount));
  return `rgba(${red},${green},${blue},${alpha})`;
}

function drawFacet(a, b, c, parity) {
  const strain = (a.tension + b.tension + c.tension) / 3;
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.lineTo(c.x, c.y);
  context.closePath();
  context.fillStyle = strain > 0.004
    ? `rgba(230,79,53,${0.035 + clamp(strain * 8, 0, 0.12)})`
    : parity ? "rgba(36,87,197,.028)" : "rgba(233,185,73,.035)";
  context.fill();
}

function draw() {
  context.clearRect(0, 0, width, height);
  const floor = height * FLOOR_FRACTION;

  context.save();
  context.strokeStyle = "rgba(23,25,24,.42)";
  context.lineWidth = 1;
  context.setLineDash([3, 7]);
  context.beginPath();
  context.moveTo(0, floor + 0.5);
  context.lineTo(width, floor + 0.5);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "rgba(23,25,24,.54)";
  context.font = '8px "Courier New", monospace';
  context.textAlign = "right";
  context.fillText("COLLISION PLANE", width - 21, floor - 10);

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = particles[particleIndex(column, row)];
      const topRight = particles[particleIndex(column + 1, row)];
      const bottomLeft = particles[particleIndex(column, row + 1)];
      const bottomRight = particles[particleIndex(column + 1, row + 1)];
      if ((row + column) % 2 === 0) {
        drawFacet(topLeft, topRight, bottomRight, 0);
        drawFacet(topLeft, bottomRight, bottomLeft, 1);
      } else {
        drawFacet(topLeft, topRight, bottomLeft, 1);
        drawFacet(topRight, bottomRight, bottomLeft, 0);
      }
    }
  }

  springs.forEach((spring) => {
    if (spring.kind !== "structural") return;
    const a = particles[spring.a];
    const b = particles[spring.b];
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.strokeStyle = tensionColor(spring.strain, 0.36 + clamp(Math.abs(spring.strain) * 12, 0, 0.58));
    context.lineWidth = 0.72 + clamp(Math.max(0, spring.strain) * 40, 0, 2.2);
    context.stroke();
  });

  particles.forEach((particle, index) => {
    const active = index === state.dragIndex;
    const radius = particle.pinned ? 3.5 : active ? 6 : lerp(1.5, 3.6, clamp(particle.tension / 0.025, 0, 1));
    context.beginPath();
    context.arc(particle.x, particle.y, radius, 0, TAU);
    context.fillStyle = particle.pinned
      ? "#171918"
      : active
        ? "#e64f35"
        : tensionColor(particle.tension, 0.92);
    context.fill();
    if (active) {
      context.beginPath();
      context.arc(particle.x, particle.y, 13, 0, TAU);
      context.strokeStyle = "rgba(230,79,53,.48)";
      context.lineWidth = 1;
      context.stroke();
    }
  });

  if (state.dragIndex >= 0) {
    const particle = particles[state.dragIndex];
    context.beginPath();
    context.moveTo(particle.x, particle.y);
    context.lineTo(state.pointer.x, state.pointer.y);
    context.strokeStyle = "rgba(230,79,53,.45)";
    context.lineWidth = 1;
    context.stroke();
  }
  context.restore();
}

function updateAudio(now) {
  if (!state.playing) {
    collisionQueue = [];
    return;
  }
  if (!sound.context || now - lastAudioUpdate < 1 / 32) return;
  lastAudioUpdate = now;

  const floor = height * FLOOR_FRACTION;
  const candidates = particles
    .filter((particle) => !particle.pinned)
    .map((particle) => ({
      particle,
      activity: clamp(particle.tension / 0.018, 0, 1)
        + clamp(particle.speed / 900, 0, 1) * 0.58,
    }))
    .filter(({ activity }) => activity > 0.035)
    .sort((a, b) => b.activity - a.activity)
    .slice(0, 10);

  const voices = candidates.map(({ particle, activity }, index) => {
    const vertical = clamp(1 - particle.y / Math.max(floor, 1), 0, 1);
    const strainBrightness = clamp(particle.tension / 0.03, 0, 1);
    const frequency = 82 * 2 ** (vertical * 2.55 + strainBrightness * 0.66);
    return {
      type: index % 3 === 0 ? "triangle" : "sine",
      frequency,
      gain: 0.005 + clamp(activity, 0, 1.2) * 0.014,
      pan: clamp((particle.x / Math.max(width, 1)) * 2 - 1, -1, 1),
    };
  });

  const averageActivity = candidates.length
    ? candidates.reduce((sum, item) => sum + item.activity, 0) / candidates.length
    : 0;
  sound.update(voices, {
    smoothing: 0.045,
    cutoff: lerp(650, 5200, clamp(averageActivity, 0, 1)),
    feedback: lerp(0.035, 0.14, state.turbulence),
  });

  if (collisionQueue.length) {
    const loudest = [...collisionQueue]
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 2);
    loudest.forEach(({ particle, impact }) => {
      const pan = clamp((particle.x / Math.max(width, 1)) * 2 - 1, -1, 1);
      const frequency = 74 * 2 ** (clamp(1 - particle.x / width, 0, 1) * 1.65);
      sound.pluck(frequency, pan, clamp(impact / 65, 0.018, 0.085));
    });
    collisionQueue = [];
  }
}

function updateReadout(now) {
  if (Math.floor(now * 8) === Math.floor((now - 1 / 60) * 8)) return;
  const peakStrain = particles.reduce((peak, particle) => Math.max(peak, particle.tension), 0);
  const moving = particles.filter((particle) => particle.speed > 38).length;
  readout.textContent = `PEAK STRAIN ${(peakStrain * 100).toFixed(1)}% · MOVING ${moving} · CONTACTS ${contactCount}`;
}

function frame(timeMs) {
  const now = timeMs / 1000;
  const elapsed = clamp((timeMs - lastFrame) / 1000, 0, 0.05);
  lastFrame = timeMs;

  if (state.playing || state.dragIndex >= 0) {
    accumulator += elapsed * state.speed;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      simulate(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }

  draw();
  updateAudio(now);
  updateReadout(now);
  requestAnimationFrame(frame);
}

function pointerPosition(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * width / Math.max(bounds.width, 1),
    y: (event.clientY - bounds.top) * height / Math.max(bounds.height, 1),
  };
}

canvas.addEventListener("pointerdown", (event) => {
  const point = pointerPosition(event);
  let nearest = -1;
  let nearestDistance = Math.min(68, Math.max(width, height) * 0.08);
  particles.forEach((particle, index) => {
    if (particle.pinned) return;
    const distance = Math.hypot(particle.x - point.x, particle.y - point.y);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  if (nearest < 0) return;

  state.dragIndex = nearest;
  state.pointer = { ...point, vx: 0, vy: 0, time: performance.now() };
  canvas.setPointerCapture(event.pointerId);
  instruction.classList.add("dismissed");
  event.preventDefault();
});

canvas.addEventListener("pointermove", (event) => {
  if (state.dragIndex < 0) return;
  const point = pointerPosition(event);
  const time = performance.now();
  const elapsed = Math.max(1 / 240, (time - state.pointer.time) / 1000);
  const measuredX = (point.x - state.pointer.x) / elapsed;
  const measuredY = (point.y - state.pointer.y) / elapsed;
  state.pointer.vx = lerp(state.pointer.vx, measuredX, 0.48);
  state.pointer.vy = lerp(state.pointer.vy, measuredY, 0.48);
  state.pointer.x = point.x;
  state.pointer.y = point.y;
  state.pointer.time = time;
});

function releasePointer(event) {
  if (state.dragIndex < 0) return;
  const particle = particles[state.dragIndex];
  particle.previousX = particle.x - clamp(state.pointer.vx, -1500, 1500) * FIXED_STEP * 0.58;
  particle.previousY = particle.y - clamp(state.pointer.vy, -1500, 1500) * FIXED_STEP * 0.58;
  state.dragIndex = -1;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", releasePointer);

attachTransport(transport, state, sound, {
  play: "drop the field",
  pause: "hold the field",
  active: "strain, motion, and impact are sounding",
  idle: "audio and gravity start here",
});

bindRange("gravityAngle", state, "gravityAngle", (value) => {
  const rounded = Math.round(value);
  if (rounded === 90) return "90° down";
  if (rounded === -90) return "−90° up";
  if (Math.abs(rounded) === 180) return "180° left";
  if (rounded === 0) return "0° right";
  return `${rounded}°`;
});
bindRange("gravity", state, "gravity", (value) => `${value.toFixed(2)} g`);
bindRange("stiffness", state, "stiffness", (value) => `${Math.round(value * 100)}%`);
bindRange("damping", state, "damping", (value) => `${(value * 100).toFixed(1)}%`);
bindRange("wind", state, "wind", (value) => {
  if (Math.abs(value) < 0.025) return "still";
  return `${value < 0 ? "←" : "→"} ${Math.round(Math.abs(value) * 100)}%`;
});
bindRange("turbulence", state, "turbulence", (value) => `${Math.round(value * 100)}%`);
bindRange("resolution", state, "resolution", (value) => `${Math.round(value)} columns`, buildLattice);
bindRange("speed", state, "speed", (value) => `${value.toFixed(2)}×`);

$("#resetField").addEventListener("click", buildLattice);

new ResizeObserver(resize).observe(canvas);
document.addEventListener("visibilitychange", () => {
  lastFrame = performance.now();
  accumulator = 0;
  if (document.hidden) sound.silence();
});

resize();
requestAnimationFrame(frame);
