import assert from 'node:assert/strict';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import { hexToBytes, hmacHex, mouseMessage, parseAccessFragment, roomFromPassword, routePasswordForAccessLink, transcript } from '../src/protocol.ts';
import { iceRoute } from '../src/route.ts';
import { MouseMoveQueue } from '../companion/mouse-queue.ts';

globalThis.crypto ??= webcrypto;
const password = '07'.repeat(32);
const secret = Buffer.from(password, 'hex');
const room = createHash('sha256').update(secret).digest('hex').slice(0, 32);
assert.equal(await roomFromPassword(password), room);
const proofText = `client|${transcript(room, 'generation', 'browser_1', '0'.repeat(32), '1'.repeat(32), '2'.repeat(64), '3'.repeat(64))}`;
assert.equal(await hmacHex(hexToBytes(password), proofText), createHmac('sha256', secret).update(proofText).digest('hex'));
assert.equal(mouseMessage('generation', 'browser_1', 1, 1, 100, 200, 0), 'mouse|generation|browser_1|1|1|100|200|0');
const stats = [
  { id: 'transport', type: 'transport', connectionType: 'viewer', selectedCandidatePairId: 'pair' },
  { id: 'pair', connectionType: 'viewer', localCandidateId: 'local', remoteCandidateId: 'remote' },
  { id: 'local', connectionType: 'viewer', candidateType: 'host' },
  { id: 'remote', connectionType: 'viewer', candidateType: 'srflx' },
];
assert.equal(iceRoute(stats, 'viewer'), 'Direct');
assert.equal(iceRoute(stats.map(entry => entry.id === 'remote' ? { ...entry, candidateType: 'relay' } : entry), 'viewer'), 'Relayed');
assert.equal(iceRoute(stats.slice(0, 2), 'viewer'), 'Route unknown');
const sent = [];
const moves = new MouseMoveQueue(async (point) => {
  sent.push(point);
  return sent.length;
});
for (let i = 0; i < 4; i++) moves.move(i, i);
await Promise.resolve();
for (let i = 4; i < 100; i++) moves.move(i, i);
assert.equal(sent.length, 4, 'only four moves may await acknowledgement');
moves.ack(1);
assert.deepEqual(sent.at(-1), { x: 99, y: 99 }, 'the newest position must replace stale moves');
moves.reset();
moves.ack(2);
assert.equal(sent.length, 5, 'old acknowledgements must not flush a new session');
const id = 'ab'.repeat(16);
const fragment = `#access=v1.${id}.${password}`;
assert.deepEqual(parseAccessFragment(fragment), { id, secret: password });
assert.equal(parseAccessFragment(''), null);
assert.throws(() => parseAccessFragment(`#access=v1.${id}.wrong`), /Invalid access link/);
const routePassword = createHmac('sha256', secret).update('route|v1').digest('hex');
assert.equal(await routePasswordForAccessLink(password), routePassword);
assert.equal(await roomFromPassword(routePassword), createHash('sha256').update(Buffer.from(routePassword, 'hex')).digest('hex').slice(0, 32));
assert.equal(await roomFromPassword(routePassword), 'd4887bf5fb730ab7ab254caa7cc25f57');
console.log('Protocol vectors passed');
