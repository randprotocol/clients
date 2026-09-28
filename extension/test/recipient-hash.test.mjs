// lib/recipient-hash.js against the bridge's own pinned fixture (randbridge.org/status/src/address.rs,
// tests::pinned): the wallet's hash and the status service's must never disagree about an address.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientHash, blake3, base58Decode } from '../shared/lib/recipient-hash.js';

const REAL = 'rand11qgA3ETvTzELbwHGufX8G858UvqXz9svmrrq3X8ZhgAETJj48e1WLvwtKkLX3MMAWVL9iLBJwCeMXo5kDcUV6aSYfqkF7U3hNkgmtTWng4U1z1j6B6D7axSBpEADg6Xs8J6oF1E3cRErfyo6HdJgfAx5Ujt3Ga5mfd4bj57jDJRkj1TYsDQnWLzezYVbjPKtftudQrr8U9vAVa3gwg7WiC4zFSerpbLvmgAke8bHUcqTGg897DYNWbwSKpy8JC3xyMETmJRnL6mZXG6bTrUQUnpc3BXC6MAtHBGRF8z69U5CwmU3PNXZcmHnLz1JDoRkzdv2suijTGg267sMRassupZr1EnrbRR4W69y8iTWCSLnnCn7taZCw4sLFSSwPi8tJNXDtuFnr5suHvgv9eH3XS3V5BEEjjvUei96gLW91Pwrm3LuFmwfjUJaYpqmanDkCL2e2tAAaTNT6qgYeBfeRrqabzNE6uEw8RxxNmwXGx3kMjEso2FoZS8Wyoi9VX2zFFRAPPuXNtGw1FGN658oxTYNf9gCthek5b3LwJd5TSFnk4GS8YngPCo9b3Li1b6tnqNdSYHYm6mpDDTnrRyn4dYpVgyRuco4PTZF9tAhfeBwnqYd4yQaRt5Y5WZdjkB916frfkEJkixngMmquN3KNSfvsWfCnLS4c2isMYXvczvTXQfHB2nGBSiRszEprWUgKv8qr9aH1VdBKrinbzjU62RXRvCQTXPRNUwDxPNJ6xU5cm4A9kV6V7yZVN41nTZKaSKhMmdQAR236UHstdGyAeXXhEvSJunkc9Qcd3A31QHnS6rNM5Py2zDwHbKyitVrJfKb4TNPvJJAcmTjZ3dkDPyXCdpVAq62Pcoy7dh3oZJvhnhJDJ7G9fk96hkDcRYYMPcH65bjBTm6HyAo1XVbH7hJMTPzvA1tN98pXBeFDbrJWyp2syKN4o6HZaUbS5TRja6QbxvnEwNN8rDK738xoSEH72NNjwkfnAYvt2vQATeNRVc72sumXcyvBtj6zt5ECt7FQPYyX6gfy13DUDgsGCtrCfw1LyypT8aeW67FKoyfae8UubmXwKaW1Q9GAXQBQKpFHBPs717tmqDYLaZF7QSUJRSoh5GjwqNgzSDKhBLtUJJYCPkKpZLKWcMSGNp7yt6jzCch15hgUWrwxMHGShnyWkunAHZgf29JivS5VVMBj86T6bJmLpgo1xFrj21mRsMHDdSJRae8RSvDW2dLTtexqaHCFs9J668jLab7ZcshxYnRymNpCrzLowab2rrWBuEbxLPhZqrRCRskTrQBoQr838NqvQWwHfzEmoiWUyfn3dETcGuyFFgkachCEMar4MveKShTbPuiweKu6Z1nu4CqypzVe9vDyperHd193ySf9mf1iqvi5hzXuRtWkTDjKaVVT34k7HkuDosCbmP4SCcchChUaotgFRUpbWGGTtdMxHmfcNRe6w6a6r5bi4k9inXvuo12ptNXG4rSt7zFcq9Ant79h2wqpPhjjh17yvhNaFmQ2kndeCycZxiomhpxYTLFA3XYPtPFUjaCL46kFSyniqhVV37N79X8u6xJNAhXuSYdycTPUHqhrfGJAPFniGKhjhYj4GpbssKMWENCgpoKBrSAqVbAMUXE8FUexfYik5TRgPE7aDuLm4n9';
const PINNED = '58bbaf413a0a303a1740c286673f0ce74199c7b64d035a7a6772468bac66b972';
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

test('blake3 of the empty input is the published vector', () => {
  assert.equal(hex(blake3(new Uint8Array(0))), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
});

test('the real address hashes to the bridge\'s pinned value', () => {
  assert.equal(recipientHash(REAL), PINNED);
  assert.equal(recipientHash(`  ${REAL}\n`), PINNED, 'whitespace around it is ignored, as the bridge does');
});

test('base58 keeps leading zero bytes', () => {
  assert.deepEqual([...base58Decode('111')], [0, 0, 0]);
  assert.deepEqual([...base58Decode('2')], [1]);
});

test('anything that is not a full shielded address is refused', () => {
  assert.throws(() => recipientHash('rond1abc'), /starts with rand1/);
  assert.throws(() => recipientHash('rand10OIl'), /not base58/);
  assert.throws(() => recipientHash('rand1' + '2'.repeat(44)), /expected 1216/);
});
