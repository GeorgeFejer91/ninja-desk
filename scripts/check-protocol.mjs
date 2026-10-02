import assert from 'node:assert/strict';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import { hexToBytes, hmacHex, mouseMessage, roomFromPassword, transcript } from '../src/protocol.ts';

globalThis.crypto ??= webcrypto;
const password = '07'.repeat(32);
const secret = Buffer.from(password, 'hex');
const room = createHash('sha256').update(secret).digest('hex').slice(0, 32);
assert.equal(await roomFromPassword(password), room);
const proofText = `client|${transcript(room, 'generation', 'browser_1', '0'.repeat(32), '1'.repeat(32), '2'.repeat(64), '3'.repeat(64))}`;
assert.equal(await hmacHex(hexToBytes(password), proofText), createHmac('sha256', secret).update(proofText).digest('hex'));
assert.equal(mouseMessage('generation', 'browser_1', 1, 1, 100, 200, 0), 'mouse|generation|browser_1|1|1|100|200|0');
console.log('Protocol vectors passed');
