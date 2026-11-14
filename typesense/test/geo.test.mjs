import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearingDeg, compass, compassWord, distanceKm, humanDistance, isValidLatLng, parseDirection } from '../src/geo.mjs';

test('distanceKm matches a known Atlanta pair', () => {
  // Jackson Street Bridge -> Krog Street Tunnel, roughly 0.8 km.
  const km = distanceKm(33.7556, -84.3715, 33.754, -84.3639);
  assert.ok(km > 0.6 && km < 1.0, `expected ~0.8 km, got ${km}`);
});

test('distanceKm is zero for the same point', () => {
  assert.equal(distanceKm(33.75, -84.37, 33.75, -84.37), 0);
});

test('bearingDeg points north and east correctly', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0) - 0) < 0.5);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.5);
  assert.ok(Math.abs(bearingDeg(0, 0, -1, 0) - 180) < 0.5);
});

test('compass rounds to 16 points and wraps', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(225), 'SW');
  assert.equal(compass(359), 'N');
  assert.equal(compass(-90), 'W');
  assert.equal(compass(NaN), undefined);
});

test('compassWord is speakable', () => {
  assert.equal(compassWord(225), 'southwest');
  assert.equal(compassWord(67.5), 'east-northeast');
});

test('parseDirection accepts degrees and compass points', () => {
  assert.equal(parseDirection('230'), 230);
  assert.equal(parseDirection(230), 230);
  assert.equal(parseDirection('SW'), 225);
  assert.equal(parseDirection('sw'), 225);
  assert.equal(parseDirection('400'), 40);
  assert.equal(parseDirection('-45'), 315);
  assert.equal(parseDirection('up'), undefined);
  assert.equal(parseDirection(''), undefined);
  assert.equal(parseDirection(undefined), undefined);
});

test('humanDistance switches units', () => {
  assert.equal(humanDistance(0.25), '250 m');
  assert.equal(humanDistance(0.004), '10 m');
  assert.equal(humanDistance(1.44), '1.4 km');
  assert.equal(humanDistance(12.6), '13 km');
});

test('isValidLatLng rejects out-of-range and null island', () => {
  assert.ok(isValidLatLng(33.75, -84.39));
  assert.ok(!isValidLatLng(91, 0));
  assert.ok(!isValidLatLng(0, 181));
  assert.ok(!isValidLatLng(0, 0));
  assert.ok(!isValidLatLng(NaN, 5));
});
