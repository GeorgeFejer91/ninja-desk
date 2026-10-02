import assert from 'node:assert/strict';
import { clampPan, followPoint, imageRect, relativePoint, screenPoint, zoomPan } from '../companion/view-geometry.ts';

const desktop = { width: 800, height: 600, videoWidth: 1920, videoHeight: 1080, scale: 1, panX: 0, panY: 0 };
assert.deepEqual(imageRect(desktop), { x: 0, y: 75, width: 800, height: 450 });
assert.deepEqual(screenPoint(desktop, 400, 300), { x: 32768, y: 32768 });
assert.equal(screenPoint(desktop, 400, 30), null, 'letterbox tap must not click the desktop');
assert.deepEqual(relativePoint(desktop, 32768, 32768, 80, 45), { x: 39322, y: 39322 });

const pan = zoomPan(desktop, 2, 600, 400);
const zoomed = { ...desktop, scale: 2, panX: pan.x, panY: pan.y };
assert.deepEqual(pan, { x: -200, y: -100 });
assert.deepEqual(screenPoint(zoomed, 600, 400), screenPoint(desktop, 600, 400), 'zoom must keep the pointer anchor fixed');
assert.deepEqual(clampPan({ ...zoomed, panX: 999, panY: -999 }), { x: 400, y: -150 });
const followed = followPoint({ ...desktop, scale: 2 }, Math.round(65535 * 0.9), 32768);
assert.ok(Math.abs(followed.x + 288) < 0.1);
assert.ok(Math.abs(imageRect({ ...desktop, scale: 2, panX: followed.x }).x + 0.9 * 1600 - 752) < 0.1);

const phone = { ...desktop, width: 390, height: 700 };
assert.deepEqual(screenPoint(phone, 195, 350), { x: 32768, y: 32768 });
assert.equal(screenPoint(phone, 195, 100), null);
assert.equal(relativePoint(phone, 32768, 32768, 0, 21.9375).y, 39322, 'trackpad motion follows visible image scale');
const nativeScale = Math.max(phone.videoWidth / phone.width, phone.videoHeight / phone.height);
assert.equal(imageRect({ ...phone, scale: nativeScale }).width, 1920, 'actual size uses one source pixel per CSS pixel');
console.log('View geometry passed');
