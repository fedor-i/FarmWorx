// Geofence maths. Shared by the server (alerts) and the worker phone (instant offline warnings).
// Points and polygon vertices are [lat, lng].

const M_PER_DEG_LAT = 111_320;
export const DRIFT_BUFFER_M = 30;
const MAX_ACCURACY_BUFFER_M = 100;

export function pointInPolygon([lat, lng], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const crosses = latI > lat !== latJ > lat;
    if (crosses && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI) inside = !inside;
  }
  return inside;
}

function toMetres([lat, lng], origin) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [(lng - origin[1]) * mPerDegLng, (lat - origin[0]) * M_PER_DEG_LAT];
}

function distanceToSegment(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// 0 when the point is inside, otherwise metres to the nearest edge.
export function distanceToPolygonM(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;
  const p = toMetres(point, point);
  let min = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    min = Math.min(min, distanceToSegment(p, toMetres(polygon[i], point), toMetres(polygon[j], point)));
  }
  return min;
}

function areaOf(polygon) {
  const origin = polygon[0];
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = toMetres(polygon[i], origin);
    const [xj, yj] = toMetres(polygon[j], origin);
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum / 2);
}

export function smallestZoneAt(point, zones) {
  return zones
    .filter((z) => pointInPolygon(point, z.polygon))
    .sort((a, b) => areaOf(a.polygon) - areaOf(b.polygon))[0];
}

export function driftBuffer(accuracyM = 0) {
  return Math.max(DRIFT_BUFFER_M, Math.min(accuracyM || 0, MAX_ACCURACY_BUFFER_M));
}

// GPS wanders near a fence, so a subject keeps its last zone until it is clearly outside it.
// Moving straight into another field still registers at once.
export function resolveZone(point, zones, lastZoneId, accuracyM = 0) {
  const inside = smallestZoneAt(point, zones);
  const last = zones.find((z) => z.id === lastZoneId);
  const enteredAnotherBlock = inside && inside.kind !== 'farm' && inside.id !== lastZoneId;
  if (last && !enteredAnotherBlock && distanceToPolygonM(point, last.polygon) <= driftBuffer(accuracyM)) return last.id;
  return inside?.id ?? null;
}

export function polygonCentre(polygon) {
  const sum = polygon.reduce((acc, [lat, lng]) => [acc[0] + lat, acc[1] + lng], [0, 0]);
  return [sum[0] / polygon.length, sum[1] / polygon.length];
}
