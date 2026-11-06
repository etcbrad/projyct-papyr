'use strict';

const noble = require('@abandonware/noble');
const robot = require('robotjs');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TARGET_NAME = 'Note Plus';
const SCAN_SECONDS = 0; // 0 means scan until explicitly stopped.

let scanning = false;
let connectedPeripheral = null;
let activeCharacteristics = [];
let restartTimer = null;
let mouseButtonDown = false;
let lastTabletPosition = null;
let cursorPosition = robot.getMousePos();
let pendingDelta = { x: 0, y: 0 };
let filteredDelta = { x: 0, y: 0 };
let pendingAbsoluteSample = null;
let pointerTimer = null;
let penWatchdogTimer = null;
let lastPacketAt = 0;
let toolboxServer = null;
const screen = robot.getScreenSize();
const MAX_RAW_JUMP = 5000;
const POINTER_TICK_MS = 1000 / 60;
const DEBUG_PACKETS = process.env.XPPEN_DEBUG === '1';
const TOOLBOX_HOST = '127.0.0.1';
const TOOLBOX_PORT = 8765;
const SETTINGS_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'XPPenNotePlusBridge', 'settings.json');
const PAPYR_HISTORY_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'XPPenNotePlusBridge', 'papyr-history.jsonl');

let pointerSensitivity = Number(process.env.XPPEN_SENSITIVITY || '0.1');
let smoothingAlpha = Number(process.env.XPPEN_SMOOTHING || '0.35');
let jitterDeadzone = 0.8;
let tapMoveThreshold = 350;
let doubleTapIntervalMs = 350;
let fullSheetMode = false;
let calibration = {
  ready: false,
  minX: 0,
  maxX: 65535,
  minY: 0,
  maxY: 65535,
  anchorX: null,
  anchorY: null,
  anchorScreenX: null,
  anchorScreenY: null,
  points: [],
};
let calibrationSession = null;
let activeBlot = null;
let blotHistory = [];
let blotSequence = 0;
const CALIBRATION_ORDER = ['top-left', 'top-right', 'bottom-right', 'bottom-left', 'first-mark'];
const ART_APP_NAMES = (process.env.XPPEN_ART_APPS || [
  'Adobe Photoshop',
  'Adobe Illustrator',
  'Affinity Photo',
  'Affinity Designer',
  'Krita',
  'Pixelmator Pro',
  'Sketchbook',
  'Procreate',
  'Procreate Dreams',
  'Dreams',
  'Paintz',
  'XPPen Art Test',
].join(','))
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

function log(message, ...args) {
  console.log(`[${new Date().toISOString()}] ${message}`, ...args);
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function applyRuntimeSettings(nextSettings, persist = true) {
  if (Object.prototype.hasOwnProperty.call(nextSettings, 'pointerSensitivity')) {
    pointerSensitivity = clamp(nextSettings.pointerSensitivity, 0.01, 0.5, pointerSensitivity);
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings, 'smoothingAlpha')) {
    smoothingAlpha = clamp(nextSettings.smoothingAlpha, 0.05, 0.9, smoothingAlpha);
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings, 'jitterDeadzone')) {
    jitterDeadzone = clamp(nextSettings.jitterDeadzone, 0, 10, jitterDeadzone);
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings, 'tapMoveThreshold')) {
    tapMoveThreshold = clamp(nextSettings.tapMoveThreshold, 50, 1000, tapMoveThreshold);
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings, 'doubleTapIntervalMs')) {
    doubleTapIntervalMs = clamp(nextSettings.doubleTapIntervalMs, 200, 600, doubleTapIntervalMs);
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings, 'dragLock')) {
    dragLock = Boolean(nextSettings.dragLock);
    if (!dragLock && mouseButtonDown) {
      robot.mouseToggle('up', 'left');
      mouseButtonDown = false;
      resetContactState();
    }
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings, 'fullSheetMode')) {
    fullSheetMode = Boolean(nextSettings.fullSheetMode);
  }
  if (nextSettings.calibration && typeof nextSettings.calibration === 'object') {
    const saved = nextSettings.calibration;
    const minX = clamp(saved.minX, 0, 65534, calibration.minX);
    const maxX = clamp(saved.maxX, minX + 1, 65535, calibration.maxX);
    const minY = clamp(saved.minY, 0, 65534, calibration.minY);
    const maxY = clamp(saved.maxY, minY + 1, 65535, calibration.maxY);
    const anchorX = saved.anchorX === null ? null : clamp(saved.anchorX, minX, maxX, null);
    const anchorY = saved.anchorY === null ? null : clamp(saved.anchorY, minY, maxY, null);
    const anchorScreenX = saved.anchorScreenX === null ? null : Number(saved.anchorScreenX);
    const anchorScreenY = saved.anchorScreenY === null ? null : Number(saved.anchorScreenY);
    calibration = {
      ready: Boolean(saved.ready)
        && anchorX !== null
        && anchorY !== null
        && Number.isFinite(anchorScreenX)
        && Number.isFinite(anchorScreenY)
        && calibrationGeometryIsUsable(Array.isArray(saved.points)
          ? saved.points.filter((point) => point.label !== 'first-mark')
          : []),
      minX,
      maxX,
      minY,
      maxY,
      anchorX,
      anchorY,
      anchorScreenX: Number.isFinite(anchorScreenX) ? anchorScreenX : null,
      anchorScreenY: Number.isFinite(anchorScreenY) ? anchorScreenY : null,
      points: Array.isArray(saved.points) ? saved.points : [],
    };
    if (saved.calibrationSession && saved.calibrationSession.active) {
      calibrationSession = {
        points: Array.isArray(saved.calibrationSession.points) ? saved.calibrationSession.points : [],
        activePoint: null,
      };
    }
  }
  if (persist) saveSettings();
}

function currentSettings() {
  return {
    pointerSensitivity,
    smoothingAlpha,
    jitterDeadzone,
    tapMoveThreshold,
    doubleTapIntervalMs,
    fullSheetMode,
    frontmostApp,
    artModeActive,
    dragLock,
    canvasConstraintActive,
    calibration,
    calibrationSession: calibrationSession
      ? { active: true, points: calibrationSession.points }
      : null,
    blotCount: blotHistory.length,
  };
}

function beginBlot(sample) {
  blotSequence += 1;
  activeBlot = {
    id: `blot-${Date.now()}-${blotSequence}`,
    startedAt: Date.now(),
    samples: [],
  };
  appendBlotSample(sample);
}

function appendBlotSample(sample) {
  if (!activeBlot) return;
  const now = Date.now();
  const previous = activeBlot.samples[activeBlot.samples.length - 1];
  activeBlot.samples.push({
    dt: previous ? Math.max(0, now - activeBlot.startedAt - previous.elapsed) : 0,
    elapsed: now - activeBlot.startedAt,
    x: Math.round(sample.x),
    y: Math.round(sample.y),
    pressure: Math.round(sample.pressure),
  });
}

function finishBlot() {
  if (!activeBlot) return;
  const blot = {
    id: activeBlot.id,
    startedAt: activeBlot.startedAt,
    endedAt: Date.now(),
    samples: activeBlot.samples.map(({ elapsed, ...sample }) => sample),
  };
  blotHistory.push(blot);
  try {
    fs.mkdirSync(path.dirname(PAPYR_HISTORY_PATH), { recursive: true });
    fs.appendFileSync(PAPYR_HISTORY_PATH, `${JSON.stringify(blot)}\n`);
  } catch (error) {
    log(`Unable to append Papyr blot history: ${error.message}`);
  }
  log(`Papyr blot recorded: ${blot.id} (${blot.samples.length} samples)`);
  activeBlot = null;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(currentSettings(), null, 2)}\n`);
  } catch (error) {
    log(`Unable to save toolbox settings: ${error.message}`);
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    applyRuntimeSettings(saved, false);
    log(`Loaded toolbox settings from ${SETTINGS_PATH}`);
  } catch (error) {
    if (error.code !== 'ENOENT') log(`Unable to load toolbox settings: ${error.message}`);
  }
}

let contactActive = false;
let calibrationHoldActive = false;
let contactStartPosition = null;
let contactMoved = false;
let tapTimer = null;
let lastTapAt = 0;
let tapCount = 0;
let dragLock = false;
let frontmostApp = '';
let frontmostProcessName = '';
let frontmostWindowName = '';
let frontmostWindowBounds = null;
let artModeActive = false;
let canvasConstraintActive = false;
let appTimer = null;
let appRefreshInFlight = false;
let localSurfaceActiveUntil = 0;
let localSurfaceName = '';
let localSurfaceBounds = null;
let localSurfaceId = null;

function isLocalSurfaceActive() {
  return Date.now() < localSurfaceActiveUntil;
}

function canUseAbsoluteCanvas() {
  // The Codex embedded browser does not expose its inner webview rectangle in
  // macOS screen coordinates. Relative movement is safer there than applying
  // an approximate absolute transform that can jump outside the preview.
  return !(isLocalSurfaceActive() && !localSurfaceBounds);
}

function registerTap() {
  const now = Date.now();
  if (!tapTimer || now - lastTapAt > doubleTapIntervalMs) tapCount = 0;
  tapCount += 1;
  lastTapAt = now;
  if (tapCount === 3) {
    clearTimeout(tapTimer);
    tapTimer = null;
    lastTapAt = 0;
    tapCount = 0;
    dragLock = !dragLock;
    log(`Drag mode ${dragLock ? 'enabled' : 'disabled'} by triple-tap`);
    return;
  }

  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = setTimeout(() => {
    tapTimer = null;
    lastTapAt = 0;
    if (tapCount === 1) {
      robot.mouseClick('left');
      log('Click gesture');
    } else if (tapCount === 2) {
      robot.mouseClick('left', true);
      log('Double-click gesture');
    }
    tapCount = 0;
  }, doubleTapIntervalMs);
}

function resetContactState() {
  contactActive = false;
  contactStartPosition = null;
  contactMoved = false;
}

function calibrationStatus() {
  return {
    active: Boolean(calibrationSession),
    ready: calibration.ready,
    anchor: calibration.ready && calibration.anchorX !== null
      ? { x: calibration.anchorX, y: calibration.anchorY }
      : null,
    points: calibrationSession ? calibrationSession.points : calibration.points,
    nextPoint: calibrationSession
      ? CALIBRATION_ORDER[(calibrationSession.points.length)] || null
      : null,
  };
}

function startCalibration() {
  if (mouseButtonDown) {
    robot.mouseToggle('up', 'left');
    mouseButtonDown = false;
  }
  clearTimeout(tapTimer);
  tapTimer = null;
  tapCount = 0;
  resetContactState();
  calibrationHoldActive = false;
  lastTabletPosition = null;
  pendingDelta = { x: 0, y: 0 };
  filteredDelta = { x: 0, y: 0 };
  calibrationSession = { points: [], activePoint: null };
  saveSettings();
  log('Paper calibration started; waiting for top-left contact');
}

function cancelCalibration() {
  calibrationSession = null;
  saveSettings();
  resetContactState();
  log('Paper calibration cancelled');
}

function processCalibrationSample(sample) {
  if (!calibrationSession) return false;
  const hasContact = sample.contactFlag === 0xa1 && sample.pressure > 0;
  if (hasContact) {
    if (!calibrationSession.activePoint) {
      const label = CALIBRATION_ORDER[calibrationSession.points.length];
      if (label === 'first-mark') {
        // The fifth step is intentionally free placement. The four corners
        // define PaperSpace; this mark verifies an interior proportion and
        // must not be forced to the canvas center or used to move the cursor.
        canvasConstraintActive = false;
        const cursor = robot.getMousePos();
        const point = {
          label,
          x: sample.x,
          y: sample.y,
          screenX: cursor.x,
          screenY: cursor.y,
        };
        calibrationSession.points.push(point);
        const cornerPoints = calibrationSession.points.filter((item) => item.label !== 'first-mark');
        const xs = cornerPoints.map((item) => item.x);
        const ys = cornerPoints.map((item) => item.y);
        const geometryReady = calibrationGeometryIsUsable(cornerPoints);
        calibration = {
          ready: geometryReady,
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys),
          anchorX: geometryReady ? point.x : null,
          anchorY: geometryReady ? point.y : null,
          anchorScreenX: geometryReady ? point.screenX : null,
          anchorScreenY: geometryReady ? point.screenY : null,
          points: calibrationSession.points,
        };
        calibrationSession = null;
        saveSettings();
        log(geometryReady
          ? `First interior mark anchored at raw (${point.x}, ${point.y}) and screen (${point.screenX}, ${point.screenY}); corners define PaperSpace`
          : 'Calibration rejected: corner geometry is too small or degenerate; use Full Sheet or recalibrate');
        return false;
      }
      calibrationSession.activePoint = { label, samples: [] };
    }
    calibrationSession.activePoint.samples.push({ x: sample.x, y: sample.y });
    return true;
  }

  if (calibrationSession.activePoint) {
    const samples = calibrationSession.activePoint.samples;
    const point = {
      label: calibrationSession.activePoint.label,
      x: Math.round(samples.reduce((sum, item) => sum + item.x, 0) / samples.length),
      y: Math.round(samples.reduce((sum, item) => sum + item.y, 0) / samples.length),
    };
    calibrationSession.points.push(point);
    calibrationSession.activePoint = null;
    saveSettings();
    log(`Calibration captured ${point.label}: (${point.x}, ${point.y})`);

    if (calibrationSession.points.length === CALIBRATION_ORDER.length) {
      const xs = calibrationSession.points.map((item) => item.x);
      const ys = calibrationSession.points.map((item) => item.y);
      const anchor = calibrationSession.points.find((item) => item.label === 'first-mark');
      calibration = {
        ready: true,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
        anchorX: anchor ? anchor.x : null,
        anchorY: anchor ? anchor.y : null,
        anchorScreenX: anchor ? anchor.screenX : null,
        anchorScreenY: anchor ? anchor.screenY : null,
        points: calibrationSession.points,
      };
      calibrationSession = null;
      saveSettings();
      log(`Paper calibration complete: X ${calibration.minX}-${calibration.maxX}, Y ${calibration.minY}-${calibration.maxY}, first-mark anchor (${calibration.anchorX}, ${calibration.anchorY})`);
    } else {
      log(`Calibration waiting for ${CALIBRATION_ORDER[calibrationSession.points.length]} contact`);
    }
  }
  return true;
}

function shouldDraw() {
  return dragLock || artModeActive;
}

function updateFrontmostContext(appName, windowName = '', windowBounds = null) {
  const searchableContext = `${appName} ${windowName}`.toLowerCase();
  const detectedArtApp = ART_APP_NAMES.some((name) => searchableContext.includes(name));
  const nextArtMode = detectedArtApp || isLocalSurfaceActive();
  if (nextArtMode !== artModeActive) {
    artModeActive = nextArtMode;
    log(`Art mode ${artModeActive ? 'enabled' : 'disabled'} (${isLocalSurfaceActive() ? localSurfaceName : (windowName || appName || 'unknown app')})`);
    if (!artModeActive && mouseButtonDown) {
      robot.mouseToggle('up', 'left');
      mouseButtonDown = false;
      resetContactState();
    }
    if (!artModeActive) canvasConstraintActive = false;
  }
  frontmostProcessName = appName;
  frontmostWindowName = windowName;
  frontmostWindowBounds = windowBounds;
  frontmostApp = windowName ? `${appName} — ${windowName}` : appName;
}

function activateLocalSurface(name = 'local Papyr canvas', bounds = null, surfaceId = null) {
  if (isLocalSurfaceActive() && localSurfaceId && localSurfaceId !== surfaceId) {
    return false;
  }
  if (!isLocalSurfaceActive()) localSurfaceId = surfaceId || null;
  else if (surfaceId) localSurfaceId = surfaceId;
  localSurfaceName = String(name).slice(0, 120);
  localSurfaceActiveUntil = Date.now() + 3500;
  const embeddedHost = /chatgpt|codex/i.test(`${frontmostProcessName} ${frontmostWindowName}`);
  const browserHost = embeddedHost || /google chrome|safari|firefox/i.test(`${frontmostProcessName} ${frontmostWindowName}`);
  if (!browserHost) {
    localSurfaceActiveUntil = 0;
    localSurfaceBounds = null;
    updateFrontmostContext(frontmostProcessName, frontmostWindowName, frontmostWindowBounds);
    return false;
  }
  // Codex's embedded browser reports coordinates relative to its web surface,
  // not the macOS display. Use the host window's accessibility bounds there;
  // page-reported screenX/screenY would make contact correction bounce.
  if (!embeddedHost && bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      && bounds.width > 1 && bounds.height > 1) {
    localSurfaceBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  } else if (embeddedHost) {
    localSurfaceBounds = null;
  }
  updateFrontmostContext(frontmostProcessName, frontmostWindowName, frontmostWindowBounds);
  return true;
}

function refreshFrontmostApp() {
  if (appRefreshInFlight) return;
  appRefreshInFlight = true;
  execFile('/usr/bin/osascript', [
    '-e',
    `tell application "System Events"
      set p to first application process whose frontmost is true
      set w to front window of p
      set posn to position of w
      set sz to size of w
      return (name of p) & "||" & (name of w) & "||" & (item 1 of posn) & "," & (item 2 of posn) & "," & (item 1 of sz) & "," & (item 2 of sz)
    end tell`,
  ], (error, stdout) => {
    appRefreshInFlight = false;
    if (error) return;
    const [appName = '', windowName = '', boundsText = ''] = String(stdout).trim().split('||');
    const values = boundsText.split(',').map(Number);
    const windowBounds = values.length === 4 && values.every(Number.isFinite)
      ? { x: values[0], y: values[1], width: values[2], height: values[3] }
      : null;
    updateFrontmostContext(appName, windowName, windowBounds);
  });
}

function getCanvasBounds() {
  if (!canvasConstraintActive) return null;
  if (isLocalSurfaceActive() && localSurfaceBounds) {
    const margin = 2;
    return {
      left: Math.max(0, Math.round(localSurfaceBounds.x + margin)),
      top: Math.max(0, Math.round(localSurfaceBounds.y + margin)),
      right: Math.min(screen.width - 1, Math.round(localSurfaceBounds.x + localSurfaceBounds.width - margin)),
      bottom: Math.min(screen.height - 1, Math.round(localSurfaceBounds.y + localSurfaceBounds.height - margin)),
    };
  }
  if (!frontmostWindowBounds) return null;
  const chromeTopInset = frontmostProcessName === 'Google Chrome' ? 86 : 0;
  const margin = 2;
  const left = Math.max(0, frontmostWindowBounds.x + margin);
  const top = Math.max(0, frontmostWindowBounds.y + chromeTopInset);
  const right = Math.min(screen.width - 1, frontmostWindowBounds.x + frontmostWindowBounds.width - margin);
  const bottom = Math.min(screen.height - 1, frontmostWindowBounds.y + frontmostWindowBounds.height - margin);
  return { left, top, right, bottom };
}

function constrainCursorToCanvas() {
  const canvasBounds = getCanvasBounds();
  if (!canvasBounds) return;
  const constrainedPosition = {
    x: Math.max(canvasBounds.left, Math.min(canvasBounds.right, cursorPosition.x)),
    y: Math.max(canvasBounds.top, Math.min(canvasBounds.bottom, cursorPosition.y)),
  };
  const nextX = Math.round(constrainedPosition.x);
  const nextY = Math.round(constrainedPosition.y);
  cursorPosition = constrainedPosition;
  if (nextX !== Math.round(robot.getMousePos().x) || nextY !== Math.round(robot.getMousePos().y)) {
    robot.moveMouse(nextX, nextY);
  }
}

function moveCursorToCanvasCenter() {
  const canvasBounds = getCanvasBounds();
  if (!canvasBounds) return;
  cursorPosition = {
    x: (canvasBounds.left + canvasBounds.right) / 2,
    y: (canvasBounds.top + canvasBounds.bottom) / 2,
  };
  robot.moveMouse(Math.round(cursorPosition.x), Math.round(cursorPosition.y));
}

function getPaperRange() {
  if (fullSheetMode || !calibration.ready) {
    return { minX: 0, maxX: 65535, minY: 0, maxY: 65535 };
  }
  return {
    minX: calibration.minX,
    maxX: calibration.maxX,
    minY: calibration.minY,
    maxY: calibration.maxY,
  };
}

function getCalibratedCorners() {
  const byLabel = Object.fromEntries(calibration.points.map((point) => [point.label, point]));
  const labels = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  if (!labels.every((label) => byLabel[label]
      && Number.isFinite(byLabel[label].x)
      && Number.isFinite(byLabel[label].y))) return null;
  if (!calibrationGeometryIsUsable(labels.map((label) => byLabel[label]))) return null;
  return {
    topLeft: byLabel['top-left'],
    topRight: byLabel['top-right'],
    bottomRight: byLabel['bottom-right'],
    bottomLeft: byLabel['bottom-left'],
  };
}

function calibrationGeometryIsUsable(points) {
  if (!Array.isArray(points) || points.length !== 4) return false;
  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  const edgeLengths = [
    Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
    Math.hypot(bottomRight.x - topRight.x, bottomRight.y - topRight.y),
    Math.hypot(bottomLeft.x - bottomRight.x, bottomLeft.y - bottomRight.y),
    Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y),
  ];
  const twiceArea = Math.abs(
    topLeft.x * topRight.y + topRight.x * bottomRight.y + bottomRight.x * bottomLeft.y + bottomLeft.x * topLeft.y
      - topLeft.y * topRight.x - topRight.y * bottomRight.x - bottomRight.y * bottomLeft.x - bottomLeft.y * topLeft.x,
  );
  return edgeLengths.every((length) => length >= 5000) && twiceArea >= 100000000;
}

function normalizedPaperPoint(sample) {
  const corners = fullSheetMode ? null : getCalibratedCorners();
  if (!corners) {
    const paper = getPaperRange();
    return {
      x: clamp((sample.x - paper.minX) / Math.max(1, paper.maxX - paper.minX), 0, 1, 0),
      y: clamp((sample.y - paper.minY) / Math.max(1, paper.maxY - paper.minY), 0, 1, 0),
    };
  }

  // Invert the calibrated bilinear paper quadrilateral with a few Newton
  // iterations. This preserves skewed corners instead of reducing them to a
  // loose min/max rectangle.
  const a = corners.topLeft;
  const b = corners.topRight;
  const c = corners.bottomRight;
  const d = corners.bottomLeft;
  let u = 0.5;
  let v = 0.5;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const topX = a.x + (b.x - a.x) * u;
    const bottomX = d.x + (c.x - d.x) * u;
    const topY = a.y + (b.y - a.y) * u;
    const bottomY = d.y + (c.y - d.y) * u;
    const mappedX = topX + (bottomX - topX) * v;
    const mappedY = topY + (bottomY - topY) * v;
    const duX = (b.x - a.x) * (1 - v) + (c.x - d.x) * v;
    const duY = (b.y - a.y) * (1 - v) + (c.y - d.y) * v;
    const dvX = bottomX - topX;
    const dvY = bottomY - topY;
    const determinant = duX * dvY - dvX * duY;
    if (Math.abs(determinant) < 0.0001) break;
    const errorX = mappedX - sample.x;
    const errorY = mappedY - sample.y;
    u -= (errorX * dvY - dvX * errorY) / determinant;
    v -= (duX * errorY - errorX * duY) / determinant;
  }
  return { x: clamp(u, 0, 1, 0), y: clamp(v, 0, 1, 0) };
}

function moveCursorToPaperPoint(sample) {
  const canvasBounds = getCanvasBounds();
  if (!canvasBounds) return;
  const normalized = normalizedPaperPoint(sample);
  const nextPosition = {
    x: canvasBounds.left + normalized.x * (canvasBounds.right - canvasBounds.left),
    y: canvasBounds.top + normalized.y * (canvasBounds.bottom - canvasBounds.top),
  };
  const nextX = Math.round(nextPosition.x);
  const nextY = Math.round(nextPosition.y);
  cursorPosition = nextPosition;
  if (nextX !== Math.round(robot.getMousePos().x) || nextY !== Math.round(robot.getMousePos().y)) {
    robot.moveMouse(nextX, nextY);
  }
}

function flushPointer() {
  if (pendingAbsoluteSample && canUseAbsoluteCanvas() && artModeActive && (fullSheetMode || calibration.ready) && contactActive) {
    moveCursorToPaperPoint(pendingAbsoluteSample);
    pendingAbsoluteSample = null;
  }
  if (pendingDelta.x === 0 && pendingDelta.y === 0) return;

  const rawDelta = pendingDelta;
  pendingDelta = { x: 0, y: 0 };
  filteredDelta.x = filteredDelta.x * (1 - smoothingAlpha) + rawDelta.x * smoothingAlpha;
  filteredDelta.y = filteredDelta.y * (1 - smoothingAlpha) + rawDelta.y * smoothingAlpha;

  const filteredX = Math.abs(filteredDelta.x) < jitterDeadzone ? 0 : filteredDelta.x;
  const filteredY = Math.abs(filteredDelta.y) < jitterDeadzone ? 0 : filteredDelta.y;

  const unconstrainedPosition = {
    x: Math.max(0, Math.min(screen.width - 1, cursorPosition.x + filteredX * pointerSensitivity)),
    y: Math.max(0, Math.min(screen.height - 1, cursorPosition.y + filteredY * pointerSensitivity)),
  };
  const canvasBounds = getCanvasBounds();
  const nextPosition = canvasBounds ? {
    x: Math.max(canvasBounds.left, Math.min(canvasBounds.right, unconstrainedPosition.x)),
    y: Math.max(canvasBounds.top, Math.min(canvasBounds.bottom, unconstrainedPosition.y)),
  } : unconstrainedPosition;
  const nextX = Math.round(nextPosition.x);
  const nextY = Math.round(nextPosition.y);
  const currentX = Math.round(cursorPosition.x);
  const currentY = Math.round(cursorPosition.y);

  cursorPosition = nextPosition;
  if (nextX !== currentX || nextY !== currentY) robot.moveMouse(nextX, nextY);
}

function processFullSheetSample(sample) {
  const hasContact = sample.contactFlag === 0xa1 && sample.pressure > 0;
  canvasConstraintActive = true;

  if (hasContact && !contactActive) {
    contactActive = true;
    contactStartPosition = sample;
    contactMoved = false;
    lastTabletPosition = sample;
    pendingDelta = { x: 0, y: 0 };
    filteredDelta = { x: 0, y: 0 };
    moveCursorToPaperPoint(sample);
    pendingAbsoluteSample = null;
    beginBlot(sample);
  }

  if (hasContact) {
    // BLE can deliver many samples per display frame. Keep only the newest
    // absolute point and emit it from the 60 Hz pointer timer.
    pendingAbsoluteSample = sample;
    if (contactActive && !contactMoved && contactStartPosition) {
      const contactDistance = Math.hypot(
        sample.x - contactStartPosition.x,
        sample.y - contactStartPosition.y,
      );
      if (contactDistance >= tapMoveThreshold) {
        contactMoved = true;
        if (shouldDraw() && !mouseButtonDown) {
          robot.mouseToggle('down', 'left');
          mouseButtonDown = true;
          log('Full-sheet drawing contact began');
        }
      }
    }
    appendBlotSample(sample);
    lastTabletPosition = sample;
    return;
  }

  if (contactActive) {
    if (mouseButtonDown) {
      robot.mouseToggle('up', 'left');
      mouseButtonDown = false;
    } else if (!contactMoved) {
      registerTap();
    }
    finishBlot();
    pendingAbsoluteSample = null;
    resetContactState();
  }
  canvasConstraintActive = false;
  lastTabletPosition = sample;
  pendingDelta = { x: 0, y: 0 };
  filteredDelta = { x: 0, y: 0 };
  pendingAbsoluteSample = null;
}

function processSample(sample) {
  const hasContact = sample.contactFlag === 0xa1 && sample.pressure > 0;

  // Do not let the contact that completes calibration enter the drawing path.
  // Hold it until release so the newly-created transform cannot jump the cursor.
  if (calibrationHoldActive) {
    if (!hasContact) {
      calibrationHoldActive = false;
      canvasConstraintActive = false;
      lastTabletPosition = sample;
      pendingDelta = { x: 0, y: 0 };
      filteredDelta = { x: 0, y: 0 };
    }
    return;
  }

  if (calibrationSession) {
    const consumed = processCalibrationSample(sample);
    if (consumed || calibrationSession) return;
    // The fifth mark completed calibration. Swallow this contact and wait for
    // its release before allowing normal absolute mapping to resume.
    calibrationHoldActive = true;
    lastTabletPosition = sample;
    pendingDelta = { x: 0, y: 0 };
    filteredDelta = { x: 0, y: 0 };
    return;
  }

  if (canUseAbsoluteCanvas() && artModeActive && (fullSheetMode || calibration.ready)) {
    processFullSheetSample(sample);
    return;
  }

  if (hasContact && artModeActive) {
    canvasConstraintActive = true;
    if (!contactActive) constrainCursorToCanvas();
  }

  if (hasContact && !contactActive) {
    contactActive = true;
    contactStartPosition = sample;
    contactMoved = false;
    beginBlot(sample);
    // The first contact is the stroke anchor. Do not apply the gap between
    // the last hover sample and the first contact sample as cursor motion.
    lastTabletPosition = sample;
    pendingDelta = { x: 0, y: 0 };
    filteredDelta = { x: 0, y: 0 };
  }

  if (hasContact && contactActive && !contactMoved && contactStartPosition) {
    const contactDistance = Math.hypot(
      sample.x - contactStartPosition.x,
      sample.y - contactStartPosition.y,
    );
    if (contactDistance >= tapMoveThreshold) {
      contactMoved = true;
      if (shouldDraw() && !mouseButtonDown) {
        flushPointer();
        constrainCursorToCanvas();
        robot.mouseToggle('down', 'left');
        mouseButtonDown = true;
        log('Drawing contact began');
      }
    }
  }

  if (lastTabletPosition) {
    const rawDelta = {
      x: sample.x - lastTabletPosition.x,
      y: sample.y - lastTabletPosition.y,
    };
    if (Math.abs(rawDelta.x) <= MAX_RAW_JUMP && Math.abs(rawDelta.y) <= MAX_RAW_JUMP) {
      pendingDelta.x += rawDelta.x;
      pendingDelta.y += rawDelta.y;
    } else {
      // A stream reset or coordinate wrap should not fling the cursor.
      pendingDelta = { x: 0, y: 0 };
      filteredDelta = { x: 0, y: 0 };
    }
  }
  lastTabletPosition = sample;

  if (hasContact && contactActive) appendBlotSample(sample);

  if (!hasContact && contactActive) {
    if (mouseButtonDown) {
      robot.mouseToggle('up', 'left');
      mouseButtonDown = false;
    } else if (!contactMoved) {
      registerTap();
    }
    finishBlot();
    resetContactState();
  } else if (!hasContact) {
    canvasConstraintActive = false;
  }
}

/**
 * Parse one notification from the notepad.
 *
 * The offsets below are an example defensive decoder. Verify them against the
 * packet format of the firmware/model in use before relying on the values.
 */
function handleRawPacket(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    log('Ignoring non-Buffer notification');
    return;
  }

  lastPacketAt = Date.now();

  if (DEBUG_PACKETS) log(`BLE packet (${buffer.length} bytes): ${buffer.toString('hex')}`);

  // Notifications contain one or more 8-byte records:
  // 04 | contact flag (A0 hover/A1 contact) | X (LE) | Y (LE) | pressure (LE).
  // The original example used Big-Endian reads, but the live Note Plus
  // stream is internally consistent only when X/Y are decoded little-endian.
  const samples = [];
  for (let offset = 0; offset + 8 <= buffer.length; offset += 8) {
    const contactFlag = buffer[offset + 1];
    const x = buffer.readUInt16LE(offset + 2);
    const y = buffer.readUInt16LE(offset + 4);
    const pressure = buffer.readUInt16LE(offset + 6);
    samples.push({ contactFlag, x, y, pressure });
  }

  if (samples.length === 0) {
    if (mouseButtonDown) {
      robot.mouseToggle('up', 'left');
      mouseButtonDown = false;
    }
    resetContactState();
    canvasConstraintActive = false;
    return;
  }

  for (const sample of samples) processSample(sample);
}

const TOOLBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Note Plus Toolbox</title>
<style>
  :root { color-scheme: light dark; font: 15px -apple-system, BlinkMacSystemFont, sans-serif; }
  body { max-width: 620px; margin: 32px auto; padding: 0 20px; }
  h1 { font-size: 25px; margin-bottom: 6px; }
  .muted { opacity: .7; }
  .row { margin: 22px 0; }
  label { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; }
  input[type=range] { width: 100%; margin-top: 10px; accent-color: #3478f6; }
  output { min-width: 60px; text-align: right; font-variant-numeric: tabular-nums; }
  #status { min-height: 22px; color: #3478f6; }
  .card { border: 1px solid #8885; border-radius: 12px; padding: 4px 18px; }
</style>
</head>
<body>
<h1>XPPen Note Plus Toolbox</h1>
<p class="muted">Changes apply immediately and are saved for the next launch.</p>
  <p id="mode" class="muted">Loading…</p>
  <div class="row"><label><input id="fullSheet" type="checkbox"> Full Sheet mode <small class="muted">Use the complete Note Plus field; calibration is bypassed.</small></label></div>
  <div class="row"><button id="resetDrag" type="button">Reset drag lock</button> <small class="muted">Releases any held mouse state.</small></div>
<div class="card">
  <div class="row"><label for="sensitivity">Cursor sensitivity <output id="sensitivityValue"></output></label><input id="sensitivity" type="range" min="0.01" max="0.5" step="0.01"></div>
  <div class="row"><label for="smoothing">Smoothing responsiveness <output id="smoothingValue"></output></label><input id="smoothing" type="range" min="0.05" max="0.9" step="0.05"><small class="muted">Lower is smoother; higher is more immediate.</small></div>
  <div class="row"><label for="deadzone">Jitter deadzone <output id="deadzoneValue"></output></label><input id="deadzone" type="range" min="0" max="10" step="0.1"></div>
  <div class="row"><label for="tapThreshold">Contact movement threshold <output id="tapThresholdValue"></output></label><input id="tapThreshold" type="range" min="50" max="1000" step="10"><small class="muted">Lower starts drawing/dragging sooner after contact.</small></div>
  <div class="row"><label for="doubleTap">Double/triple-tap interval <output id="doubleTapValue"></output></label><input id="doubleTap" type="range" min="200" max="600" step="10"><small class="muted">Milliseconds allowed between taps.</small></div>
</div>
<div class="card" style="margin-top:18px">
  <h2>Paper calibration</h2>
  <p id="calibrationStatus" class="muted">No calibration captured.</p>
  <button id="startCalibration" type="button">Start five-point calibration</button>
  <button id="cancelCalibration" type="button">Cancel</button>
  <button id="clearCalibration" type="button">Clear saved calibration</button>
  <p class="muted">After starting, touch and hold the four corners, then make the first short mark inside the canvas. Its first contact becomes the interior anchor.</p>
</div>
<p id="status" role="status"></p>
<script>
const fields = {
  sensitivity: ['pointerSensitivity', 'sensitivityValue'],
  smoothing: ['smoothingAlpha', 'smoothingValue'],
  deadzone: ['jitterDeadzone', 'deadzoneValue'],
  tapThreshold: ['tapMoveThreshold', 'tapThresholdValue'],
  doubleTap: ['doubleTapIntervalMs', 'doubleTapValue']
};
let current = {};
function render(settings) {
  current = settings;
  for (const [id, [key, outputId]] of Object.entries(fields)) {
    document.getElementById(id).value = settings[key];
    document.getElementById(outputId).textContent = id === 'doubleTap' || id === 'tapThreshold' ? Math.round(settings[key]) + ' ms/raw' : Number(settings[key]).toFixed(2);
  }
  document.getElementById('mode').textContent = 'Frontmost app: ' + (settings.frontmostApp || 'unknown') + ' · Art mode: ' + (settings.artModeActive ? 'on' : 'off') + ' · Canvas constraint: ' + (settings.canvasConstraintActive ? 'on' : 'off') + ' · Drag lock: ' + (settings.dragLock ? 'on' : 'off');
  document.getElementById('fullSheet').checked = Boolean(settings.fullSheetMode);
}
async function load() { render(await (await fetch('/api/settings')).json()); }
function renderCalibration(state) {
  const status = document.getElementById('calibrationStatus');
  if (state.active) status.textContent = state.nextPoint === 'first-mark' ? 'Make the first short canvas mark. Captured: ' + state.points.length + '/5' : 'Touch the ' + state.nextPoint + ' corner, then release. Captured: ' + state.points.length + '/5';
  else if (state.ready) status.textContent = 'Calibration ready: 4 corners plus first-mark anchor saved.';
  else status.textContent = 'No calibration captured.';
}
async function calibrationAction(action) {
  renderCalibration(await (await fetch('/api/calibration', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action}) })).json());
}
async function save() {
  const update = {};
  for (const [id, [key]] of Object.entries(fields)) update[key] = Number(document.getElementById(id).value);
  render(await (await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(update) })).json());
  document.getElementById('status').textContent = 'Saved';
  setTimeout(() => document.getElementById('status').textContent = '', 900);
}
for (const id of Object.keys(fields)) document.getElementById(id).addEventListener('input', (event) => {
  document.getElementById(fields[id][1]).textContent = Number(event.target.value).toFixed(2);
});
for (const id of Object.keys(fields)) document.getElementById(id).addEventListener('change', save);
document.getElementById('fullSheet').addEventListener('change', async (event) => {
  await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ fullSheetMode: event.target.checked }) });
  document.getElementById('status').textContent = event.target.checked ? 'Full Sheet enabled' : 'Full Sheet disabled';
});
document.getElementById('resetDrag').addEventListener('click', async () => {
  await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ dragLock: false }) });
  document.getElementById('status').textContent = 'Drag lock reset';
});
document.getElementById('startCalibration').addEventListener('click', () => calibrationAction('start'));
document.getElementById('cancelCalibration').addEventListener('click', () => calibrationAction('cancel'));
document.getElementById('clearCalibration').addEventListener('click', () => calibrationAction('clear'));
load().catch(() => document.getElementById('status').textContent = 'Toolbox connection failed');
fetch('/api/calibration').then((response) => response.json()).then(renderCalibration);
setInterval(() => fetch('/api/calibration').then((response) => response.json()).then(renderCalibration), 500);
</script>
</body>
</html>`;

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function startToolboxServer() {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/art-test') {
      try {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(fs.readFileSync(path.join(__dirname, 'art-test.html')));
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(TOOLBOX_HTML);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/settings') {
      sendJson(response, 200, currentSettings());
      return;
    }
    if (request.method === 'GET' && request.url === '/api/calibration') {
      sendJson(response, 200, calibrationStatus());
      return;
    }
    if (request.method === 'GET' && request.url === '/api/blots') {
      sendJson(response, 200, { active: activeBlot ? { id: activeBlot.id, samples: activeBlot.samples.length } : null, blots: blotHistory });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/surface') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const active = activateLocalSurface(payload.name || 'local Papyr canvas', payload.bounds || null, payload.surfaceId || null);
          sendJson(response, 200, { active, artModeActive });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/calibration') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        try {
          const action = JSON.parse(body).action;
          if (action === 'start') startCalibration();
          else if (action === 'cancel') cancelCalibration();
          else if (action === 'clear') {
            calibration = { ready: false, minX: 0, maxX: 65535, minY: 0, maxY: 65535, anchorX: null, anchorY: null, anchorScreenX: null, anchorScreenY: null, points: [] };
            calibrationSession = null;
            saveSettings();
          } else throw new Error('Unknown calibration action');
          sendJson(response, 200, calibrationStatus());
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/settings') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10000) request.destroy();
      });
      request.on('end', () => {
        try {
          applyRuntimeSettings(JSON.parse(body));
          sendJson(response, 200, currentSettings());
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  });
  server.on('error', (error) => log(`Toolbox server error: ${error.message}`));
  server.listen(TOOLBOX_PORT, TOOLBOX_HOST, () => log(`Toolbox available at http://${TOOLBOX_HOST}:${TOOLBOX_PORT}`));
  return server;
}

loadSettings();
toolboxServer = startToolboxServer();
pointerTimer = setInterval(flushPointer, POINTER_TICK_MS);
if (typeof pointerTimer.unref === 'function') pointerTimer.unref();
penWatchdogTimer = setInterval(() => {
  if (!contactActive && !mouseButtonDown) return;
  if (Date.now() - lastPacketAt <= 300) return;
  log('Pen stream went quiet; releasing active input');
  if (mouseButtonDown) {
    robot.mouseToggle('up', 'left');
    mouseButtonDown = false;
  }
  finishBlot();
  resetContactState();
  lastTabletPosition = null;
  pendingDelta = { x: 0, y: 0 };
  filteredDelta = { x: 0, y: 0 };
  pendingAbsoluteSample = null;
  canvasConstraintActive = false;
}, 100);
if (typeof penWatchdogTimer.unref === 'function') penWatchdogTimer.unref();
appTimer = setInterval(refreshFrontmostApp, 250);
if (typeof appTimer.unref === 'function') appTimer.unref();
refreshFrontmostApp();

async function stopScan() {
  if (!scanning) return;
  try {
    await noble.stopScanningAsync();
  } catch (error) {
    log(`Unable to stop BLE scan: ${error.message}`);
  } finally {
    scanning = false;
  }
}

async function startScan() {
  if (scanning || connectedPeripheral) return;
  if (noble.state !== 'poweredOn') {
    log(`Bluetooth is not ready (state: ${noble.state}); waiting for poweredOn`);
    return;
  }

  try {
    await noble.startScanningAsync([], false);
    scanning = true;
    log(`Scanning for peripherals whose local name includes "${TARGET_NAME}"`);
  } catch (error) {
    log(`Unable to start BLE scan: ${error.message}`);
    scheduleRestart();
  }
}

function scheduleRestart() {
  if (restartTimer || connectedPeripheral) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void startScan();
  }, 1000);
}

async function subscribeToPeripheral(peripheral) {
  try {
    const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    const characteristics = result.characteristics || [];
    for (const characteristic of characteristics) {
      log(`Characteristic ${characteristic.uuid} properties: ${characteristic.properties.join(',')}`);
    }
    activeCharacteristics = characteristics.filter((characteristic) =>
      Array.isArray(characteristic.properties) && characteristic.properties.includes('notify')
    );

    const services = result.services || [];
    log(`Discovered ${services.length} service(s), ${characteristics.length} characteristic(s), ${activeCharacteristics.length} notifiable`);

    for (const characteristic of activeCharacteristics) {
      // 2b10 is the stream that carries the notepad's coordinate records on
      // this device revision. 2b12 remains subscribed for status/control data.
      const isCoordinateStream = characteristic.uuid.endsWith('2b10');
      if (isCoordinateStream) characteristic.on('data', handleRawPacket);
      try {
        await characteristic.subscribeAsync();
        log(`Subscribed to characteristic ${characteristic.uuid}`);
      } catch (error) {
        if (isCoordinateStream) characteristic.removeListener('data', handleRawPacket);
        log(`Subscription failed for ${characteristic.uuid}: ${error.message}`);
      }
    }
  } catch (error) {
    log(`GATT discovery failed: ${error.message}`);
    throw error;
  }
}

async function connectToPeripheral(peripheral) {
  connectedPeripheral = peripheral;
  peripheral.once('disconnect', handleDisconnect);
  log(`Connecting to ${peripheral.advertisement.localName || peripheral.uuid}`);

  try {
    await peripheral.connectAsync();
    await subscribeToPeripheral(peripheral);
  } catch (error) {
    log(`Connection/setup failed: ${error.message}`);
    try {
      await peripheral.disconnectAsync();
    } catch (disconnectError) {
      log(`Cleanup disconnect failed: ${disconnectError.message}`);
    }
  }
}

function handleDisconnect() {
  log('XPPen Note Plus disconnected');
  for (const characteristic of activeCharacteristics) {
    characteristic.removeListener('data', handleRawPacket);
  }
  activeCharacteristics = [];
  connectedPeripheral = null;
  lastTabletPosition = null;
  pendingDelta = { x: 0, y: 0 };
  filteredDelta = { x: 0, y: 0 };
  pendingAbsoluteSample = null;
  canvasConstraintActive = false;
  resetContactState();
  scheduleRestart();
}

noble.on('stateChange', (state) => {
  log(`Bluetooth adapter state: ${state}`);
  if (state === 'poweredOn') void startScan();
  else void stopScan();
});

noble.on('discover', (peripheral) => {
  const localName = peripheral.advertisement.localName || '';
  log(`Discovered BLE peripheral: ${localName || '(unnamed)'} (${peripheral.uuid})`);
  if (!localName.includes(TARGET_NAME)) return;

  log(`Found target: ${localName} (${peripheral.uuid})`);
  void stopScan().then(() => connectToPeripheral(peripheral));
});

async function shutdown(signal) {
  log(`Received ${signal}; shutting down`);
  clearTimeout(restartTimer);
  await stopScan();
  if (mouseButtonDown) robot.mouseToggle('up', 'left');
  if (tapTimer) clearTimeout(tapTimer);
  if (pointerTimer) clearInterval(pointerTimer);
  if (penWatchdogTimer) clearInterval(penWatchdogTimer);
  if (appTimer) clearInterval(appTimer);
  tapTimer = null;
  lastTapAt = 0;
  tapCount = 0;
  resetContactState();
  lastTabletPosition = null;
  pendingDelta = { x: 0, y: 0 };
  filteredDelta = { x: 0, y: 0 };
  canvasConstraintActive = false;
  if (toolboxServer) await new Promise((resolve) => toolboxServer.close(resolve));
  if (connectedPeripheral) {
    try { await connectedPeripheral.disconnectAsync(); } catch (error) { log(`Shutdown disconnect failed: ${error.message}`); }
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

log('Starting XPPen Note Plus BLE bridge');
if (noble.state === 'poweredOn') void startScan();
else log(`Waiting for Bluetooth adapter (current state: ${noble.state})`);

module.exports = { handleRawPacket };
