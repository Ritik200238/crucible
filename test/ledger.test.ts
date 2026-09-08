import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as signBuffer } from "node:crypto";

import {
  GENESIS_HASH,
  Ledger,
  LedgerError,
  canonicalJson,
  parseLedgerText,
  recordHash,
  signedMessage,
  type LedgerRecord,
} from "../src/ledger/chain.ts";
import { verifyChain, verifyLedger } from "../src/ledger/verify.ts";

/** Every test gets its own directory so nothing can leak between them. */
function inTempLedger(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "crucible-ledger-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ledgerFile(dir: string): string {
  return join(dir, "ledger.jsonl");
}

function readRecords(dir: string): LedgerRecord[] {
  return parseLedgerText(readFileSync(ledgerFile(dir), "utf8")).records;
}

function writeRecords(dir: string, records: LedgerRecord[]): void {
  writeFileSync(ledgerFile(dir), records.map((r) => canonicalJson(r)).join("\n") + "\n");
}

function seed(dir: string, count: number): Ledger {
  const ledger = new Ledger({ dir });
  for (let i = 0; i < count; i++) {
    ledger.append("decision", { step: i, symbol: "BNBUSDT", venue: "BINANCE_SPOT" });
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// Appending and reading
// ---------------------------------------------------------------------------

test("append returns the record it wrote and read gives it back", () => {
  inTempLedger((dir) => {
    const ledger = new Ledger({ dir });
    const payload = { symbol: "BNBUSDT", quoteQty: 500, nested: { a: [1, 2, 3], b: null } };
    const written = ledger.append("decision", payload);

    const back = ledger.read();
    assert.equal(back.length, 1);
    assert.deepEqual(back[0], written);
    assert.deepEqual(back[0]!.payload, payload);
    assert.equal(back[0]!.kind, "decision");
    assert.ok(!Number.isNaN(Date.parse(back[0]!.timestamp)));
  });
});

test("seq increments and every prevHash points at the record before it", () => {
  inTempLedger((dir) => {
    seed(dir, 5);
    const records = readRecords(dir);

    assert.equal(records.length, 5);
    for (let i = 0; i < records.length; i++) {
      assert.equal(records[i]!.seq, i);
      assert.equal(records[i]!.hash, recordHash(records[i]!));
      if (i > 0) assert.equal(records[i]!.prevHash, records[i - 1]!.hash);
    }
  });
});

test("the first record's prevHash is sixty-four zeros", () => {
  inTempLedger((dir) => {
    const first = new Ledger({ dir }).append("decision", { step: 0 });
    assert.equal(first.prevHash, GENESIS_HASH);
    assert.equal(first.prevHash, "0".repeat(64));
    assert.equal(first.seq, 0);
  });
});

test("head is null on an untouched ledger and the last record afterwards", () => {
  inTempLedger((dir) => {
    const ledger = new Ledger({ dir });
    assert.equal(ledger.head(), null);
    assert.deepEqual(ledger.read(), []);

    ledger.append("decision", { step: 0 });
    const last = ledger.append("receipt", { step: 1 });
    assert.deepEqual(ledger.head(), last);
    assert.equal(ledger.head()!.seq, 1);
  });
});

test("append refuses a record with no kind", () => {
  inTempLedger((dir) => {
    const ledger = new Ledger({ dir });
    assert.throws(() => ledger.append("  ", { step: 0 }), LedgerError);
    assert.deepEqual(ledger.read(), []);
  });
});

test("a payload that cannot be canonicalised is rejected before anything is written", () => {
  inTempLedger((dir) => {
    const ledger = new Ledger({ dir });
    ledger.append("decision", { step: 0 });
    assert.throws(() => ledger.append("decision", { price: Number.NaN }), LedgerError);

    // The rejected record must not have consumed a seq or touched the head.
    assert.equal(ledger.read().length, 1);
    assert.equal(verifyLedger({ dir }).ok, true);
  });
});

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

test("verifyChain accepts a chain nobody has touched", () => {
  inTempLedger((dir) => {
    seed(dir, 4);
    const result = verifyChain(readRecords(dir));
    assert.equal(result.ok, true);
    assert.equal(result.records, 4);
    assert.equal(result.brokenAt, null);
    assert.equal(result.reason, null);
  });
});

test("verifyChain accepts an empty array", () => {
  const result = verifyChain([]);
  assert.equal(result.ok, true);
  assert.equal(result.records, 0);
  assert.equal(result.brokenAt, null);
});

test("editing a payload in the middle breaks the chain at exactly that record", () => {
  inTempLedger((dir) => {
    seed(dir, 5);
    const records = readRecords(dir);
    records[2]!.payload = { step: 2, symbol: "BNBUSDT", venue: "ONCHAIN" };

    const result = verifyChain(records);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.reason!, /changed after it was written/);
  });
});

test("editing a payload in the middle is caught end to end on disk", () => {
  inTempLedger((dir) => {
    seed(dir, 5);
    const records = readRecords(dir);
    records[3]!.payload = { step: 3, quoteQty: 1_000_000 };
    writeRecords(dir, records);

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 3);
    assert.equal(result.records, 5);
  });
});

test("editing the first record is detected at index zero", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    const records = readRecords(dir);
    records[0]!.payload = { step: 0, tampered: true };

    const result = verifyChain(records);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
  });
});

test("editing a record's kind or timestamp is detected", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    const byKind = readRecords(dir);
    byKind[1]!.kind = "receipt";
    assert.equal(verifyChain(byKind).brokenAt, 1);

    const byTime = readRecords(dir);
    byTime[2]!.timestamp = new Date(0).toISOString();
    assert.equal(verifyChain(byTime).brokenAt, 2);
  });
});

test("deleting a record from the middle is detected at its position", () => {
  inTempLedger((dir) => {
    seed(dir, 5);
    const records = readRecords(dir);
    records.splice(2, 1);

    const result = verifyChain(records);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.equal(result.records, 4);
    assert.match(result.reason!, /removed or reordered/);
  });
});

test("reordering two records is detected at the first one moved", () => {
  inTempLedger((dir) => {
    seed(dir, 4);
    const records = readRecords(dir);
    const a = records[1]!;
    const b = records[2]!;
    records[1] = b;
    records[2] = a;

    const result = verifyChain(records);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
  });
});

test("re-hashing an edited record moves the break to the next link", () => {
  inTempLedger((dir) => {
    // The tamperer who knows to recompute the hash cannot also fix the record
    // after it, because that record's prevHash is covered by its own hash.
    seed(dir, 4);
    const records = readRecords(dir);
    records[1]!.payload = { step: 1, quoteQty: 999 };
    records[1]!.hash = recordHash(records[1]!);

    const result = verifyChain(records);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.reason!, /chain is cut here/);
  });
});

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

test("the signature verifies on a clean ledger", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    const result = verifyLedger({ dir });
    assert.equal(result.ok, true);
    assert.equal(result.records, 3);
    assert.equal(result.brokenAt, null);
    assert.equal(result.reason, null);
    assert.equal(result.signatureValid, true);
  });
});

test("the public key is stable and is the one recorded in the signature file", () => {
  inTempLedger((dir) => {
    const ledger = seed(dir, 2);
    const key = ledger.publicKeyBase64();
    assert.equal(new Ledger({ dir }).publicKeyBase64(), key);

    const sig = JSON.parse(readFileSync(join(dir, "ledger.sig"), "utf8")) as {
      publicKey: string;
      count: number;
    };
    assert.equal(sig.publicKey, key);
    assert.equal(sig.count, 2);
  });
});

test("replacing the last record fails the signature even when the chain still adds up", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    const records = readRecords(dir);
    // Recompute the hash so the chain itself stays consistent. Only the
    // signature over the head can catch this.
    records[2]!.payload = { step: 2, quoteQty: 500_000 };
    records[2]!.hash = recordHash(records[2]!);
    writeRecords(dir, records);

    assert.equal(verifyChain(readRecords(dir)).ok, true);

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, null);
    assert.equal(result.signatureValid, false);
    assert.match(result.reason!, /final record was replaced/);
  });
});

test("deleting records off the end fails the signed count", () => {
  inTempLedger((dir) => {
    seed(dir, 4);
    writeRecords(dir, readRecords(dir).slice(0, 2));

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, null);
    assert.equal(result.records, 2);
    assert.equal(result.signatureValid, false);
    assert.match(result.reason!, /2 record\(s\) were deleted/);
  });
});

test("emptying the ledger while the signature survives is detected", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    writeFileSync(ledgerFile(dir), "");

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.records, 0);
    assert.equal(result.signatureValid, false);
  });
});

test("re-signing a rewritten ledger with a fresh key is rejected", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    const records = readRecords(dir);
    records[2]!.payload = { step: 2, quoteQty: 500_000 };
    records[2]!.hash = recordHash(records[2]!);
    writeRecords(dir, records);

    // A rewritten chain can always be re-signed - but only with a key that is
    // not the operator's, which is what pinning against the key file catches.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(
      join(dir, "ledger.sig"),
      JSON.stringify({
        version: 1,
        algorithm: "ed25519",
        count: 3,
        headHash: records[2]!.hash,
        signature: signBuffer(null, signedMessage(3, records[2]!.hash), privateKey).toString(
          "base64",
        ),
        publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      }),
    );

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.signatureValid, false);
    assert.match(result.reason!, /signed by a different key/);
  });
});

test("a missing signature file leaves the records unproven", () => {
  inTempLedger((dir) => {
    seed(dir, 2);
    rmSync(join(dir, "ledger.sig"));

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, null);
    assert.equal(result.signatureValid, false);
    assert.match(result.reason!, /no signature/);
  });
});

test("verifyChain does not look at signatures and says so by reporting false", () => {
  inTempLedger((dir) => {
    seed(dir, 2);
    assert.equal(verifyChain(readRecords(dir)).signatureValid, false);
  });
});

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

const FIXED = { seq: 0, timestamp: "2026-01-01T00:00:00.000Z", prevHash: GENESIS_HASH };

test("key order does not change the hash", () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(
    recordHash({ ...FIXED, kind: "decision", payload: { a: 1, b: 2 } }),
    recordHash({ ...FIXED, kind: "decision", payload: { b: 2, a: 1 } }),
  );
});

test("nested objects hash the same whatever order their keys arrive in", () => {
  const one = { outer: { z: 1, a: { q: [1, { m: 2, k: 3 }], p: true } }, first: "x" };
  const two = { first: "x", outer: { a: { p: true, q: [1, { k: 3, m: 2 }] }, z: 1 } };

  assert.equal(canonicalJson(one), canonicalJson(two));
  assert.equal(
    recordHash({ ...FIXED, kind: "decision", payload: one }),
    recordHash({ ...FIXED, kind: "decision", payload: two }),
  );
});

test("array order is part of the value, so reordering one changes the hash", () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  assert.equal(canonicalJson([1, 2, 3]), "[1,2,3]");
  assert.notEqual(
    recordHash({ ...FIXED, kind: "decision", payload: { legs: ["BUY", "SELL"] } }),
    recordHash({ ...FIXED, kind: "decision", payload: { legs: ["SELL", "BUY"] } }),
  );
});

test("canonical JSON rejects values with no deterministic form", () => {
  assert.throws(() => canonicalJson(Number.NaN), (err: Error) => {
    assert.ok(err instanceof LedgerError);
    assert.match(err.message, /NaN/);
    return true;
  });
  assert.throws(() => canonicalJson({ price: Number.POSITIVE_INFINITY }), /value\.price is Infinity/);
  assert.throws(() => canonicalJson(Number.NEGATIVE_INFINITY), /-Infinity/);
  assert.throws(() => canonicalJson(undefined), /undefined/);
  assert.throws(() => canonicalJson({ a: { b: undefined } }), /value\.a\.b is undefined/);
  assert.throws(() => canonicalJson([1, undefined]), /value\[1\] is undefined/);
  assert.throws(() => canonicalJson({ run: () => 1 }), /value\.run is a function/);
  assert.throws(() => canonicalJson({ id: Symbol("x") }), /value\.id is a symbol/);
  assert.throws(() => canonicalJson({ big: 1n }), /value\.big is a bigint/);
});

test("canonical JSON rejects a cycle instead of recursing forever", () => {
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /refers back to a value/);
});

test("canonical JSON keeps the primitives JSON already agrees on", () => {
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  assert.equal(canonicalJson({ line: "a\nb" }), '{"line":"a\\nb"}');
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson({}), "{}");
  // toJSON is honoured, or a Date would silently canonicalise to "{}".
  assert.equal(canonicalJson(new Date(0)), '"1970-01-01T00:00:00.000Z"');
});

test("a payload holding a newline stays on one line in the file", () => {
  inTempLedger((dir) => {
    const ledger = new Ledger({ dir });
    ledger.append("decision", { note: "first\nsecond" });
    ledger.append("decision", { note: "third" });

    assert.equal(readFileSync(ledgerFile(dir), "utf8").trimEnd().split("\n").length, 2);
    assert.equal(verifyLedger({ dir }).ok, true);
  });
});

// ---------------------------------------------------------------------------
// Damaged files
// ---------------------------------------------------------------------------

test("an incomplete last line is ignored and reported, not treated as a break", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    appendFileSync(ledgerFile(dir), '{"seq":3,"timestamp":"2026-01-0');

    const result = verifyLedger({ dir });
    assert.equal(result.ok, true);
    assert.equal(result.records, 3);
    assert.equal(result.brokenAt, null);
    assert.equal(result.signatureValid, true);
    assert.match(result.reason!, /incomplete and was ignored/);

    assert.equal(new Ledger({ dir }).read().length, 3);
  });
});

test("appending after an incomplete last line continues the chain", () => {
  inTempLedger((dir) => {
    const ledger = seed(dir, 2);
    appendFileSync(ledgerFile(dir), '{"seq":2,"timesta');

    const next = ledger.append("receipt", { step: 2 });
    assert.equal(next.seq, 2);
    assert.equal(next.prevHash, readRecords(dir)[1]!.hash);

    const result = verifyLedger({ dir });
    assert.equal(result.ok, true);
    assert.equal(result.records, 3);
    assert.equal(result.reason, null);
  });
});

test("a damaged line in the middle is a chain break at that line", () => {
  inTempLedger((dir) => {
    seed(dir, 4);
    const lines = readFileSync(ledgerFile(dir), "utf8").trimEnd().split("\n");
    lines[2] = '{"seq":2,"broken":';
    writeFileSync(ledgerFile(dir), lines.join("\n") + "\n");

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.equal(result.records, 2);
    assert.match(result.reason!, /not a ledger record/);
  });
});

test("read refuses a ledger with a hole in the middle", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    const lines = readFileSync(ledgerFile(dir), "utf8").trimEnd().split("\n");
    lines[1] = "";
    writeFileSync(ledgerFile(dir), lines.join("\n") + "\n");

    const ledger = new Ledger({ dir });
    assert.throws(() => ledger.read(), LedgerError);
    assert.throws(() => ledger.append("decision", { step: 3 }), /Restore the file from a backup/);
  });
});

test("a record whose hash is not sixty-four hex characters is not a record", () => {
  inTempLedger((dir) => {
    seed(dir, 3);
    const records = readRecords(dir);
    const lines = records.map((r) => canonicalJson(r));
    lines[1] = canonicalJson({ ...records[1]!, hash: "not-a-hash" });
    writeFileSync(ledgerFile(dir), lines.join("\n") + "\n");

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
  });
});

test("a corrupt signature file is reported rather than thrown", () => {
  inTempLedger((dir) => {
    seed(dir, 2);
    writeFileSync(join(dir, "ledger.sig"), "{ not json");

    const result = verifyLedger({ dir });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, null);
    assert.equal(result.signatureValid, false);
    assert.match(result.reason!, /not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// Nothing there yet
// ---------------------------------------------------------------------------

test("an empty ledger verifies with zero records", () => {
  inTempLedger((dir) => {
    const result = verifyLedger({ dir });
    assert.equal(result.ok, true);
    assert.equal(result.records, 0);
    assert.equal(result.brokenAt, null);
    assert.equal(result.reason, null);
    assert.equal(result.signatureValid, true);
  });
});

test("a ledger directory that does not exist verifies as empty", () => {
  inTempLedger((dir) => {
    const result = verifyLedger({ dir: join(dir, "never-created") });
    assert.equal(result.ok, true);
    assert.equal(result.records, 0);
  });
});
