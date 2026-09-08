/**
 * The decision ledger: append-only, hash-chained, Ed25519-signed.
 *
 * Every routing decision and every execution outcome lands here as one JSON
 * line. Each line carries the SHA-256 of the line before it, so editing any
 * past record breaks the chain from that record onward, at exactly that index.
 *
 * The chain alone only proves internal consistency - anyone who can edit the
 * file can also recompute every hash after their edit. What closes that hole is
 * the detached signature over the head: the record count and the final hash are
 * signed with a key the operator holds, so a rewritten ledger can be
 * reconstructed but not re-signed.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBuffer,
  type KeyObject,
} from "node:crypto";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface LedgerRecord {
  /** Position in the chain. Always equal to the record's index in the file. */
  seq: number;
  timestamp: string;
  kind: string;
  payload: unknown;
  /** Hash of the record before this one; GENESIS_HASH for seq 0. */
  prevHash: string;
  /** SHA-256 over the canonical JSON of the five fields above. */
  hash: string;
}

/** The prevHash of the first record. Nothing precedes it, so nothing to point at. */
export const GENESIS_HASH = "0".repeat(64);

export const DEFAULT_LEDGER_DIR = ".crucible";

/**
 * Where the ledger lives.
 *
 * `CRUCIBLE_LEDGER_DIR` overrides the default, which a hosted instance needs:
 * a serverless bundler will not carry a dot-directory, so the deployed copy
 * sits somewhere ordinary and this points at it. Read on every call rather
 * than captured at import, so a test can move it.
 */
export function defaultLedgerDir(): string {
  return process.env.CRUCIBLE_LEDGER_DIR?.trim() || DEFAULT_LEDGER_DIR;
}

export interface LedgerPaths {
  dir: string;
  ledger: string;
  key: string;
  signature: string;
  lock: string;
}

/** Where the files live, so a verifier can find them without opening a Ledger. */
export function ledgerPaths(dir: string = defaultLedgerDir()): LedgerPaths {
  const base = resolve(dir);
  return {
    dir: base,
    ledger: join(base, "ledger.jsonl"),
    key: join(base, "ledger-key.json"),
    signature: join(base, "ledger.sig"),
    lock: join(base, "ledger.lock"),
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Serialise a value so that equal values always produce identical bytes.
 *
 * `JSON.stringify` cannot be used for hashing: it emits object keys in
 * insertion order, so `{a:1,b:2}` and `{b:2,a:1}` would hash differently even
 * though nothing about them differs. It also drops `undefined` values silently,
 * which would let two genuinely different payloads hash the same.
 *
 * Anything with no deterministic JSON form is rejected rather than coerced, and
 * the error names the exact path so the caller can find it.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "value", new Set<object>());
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isFinite(value)) {
        throw new LedgerError(
          `${path} is ${String(value)}, which JSON cannot represent. ` +
            `Replace it with null or a finite number before writing to the ledger.`,
        );
      }
      // -0 stringifies to "0", so the two zeroes cannot produce different hashes.
      return JSON.stringify(value);

    case "string":
      return JSON.stringify(value);

    case "undefined":
      throw new LedgerError(
        `${path} is undefined. JSON has no undefined, and dropping the field would let ` +
          `two different payloads hash the same, so omit the field or set it to null.`,
      );

    case "function":
      throw new LedgerError(
        `${path} is a function. Only JSON data can go in the ledger; ` +
          `record the function's result instead.`,
      );

    case "symbol":
      throw new LedgerError(
        `${path} is a symbol, which has no JSON form. Use a string instead.`,
      );

    case "bigint":
      throw new LedgerError(
        `${path} is a bigint, which JSON cannot represent. ` +
          `Write it as a string, or as a number if it fits in a double.`,
      );
  }

  const obj = value as object;

  // Honour the toJSON contract as JSON.stringify does, or a Date would
  // canonicalise to "{}" - a silent loss of the entire value.
  const toJson = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    return encode((toJson as () => unknown).call(obj), path, seen);
  }

  if (seen.has(obj)) {
    throw new LedgerError(
      `${path} refers back to a value that already contains it. ` +
        `A cyclic structure has no canonical form; break the cycle before appending.`,
    );
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item, i) => encode(item, `${path}[${i}]`, seen));
      return `[${items.join(",")}]`;
    }
    const pairs = Object.keys(obj)
      .sort()
      .map((key) => {
        const child = encode((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
        return `${JSON.stringify(key)}:${child}`;
      });
    return `{${pairs.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Hash the five chained fields of a record.
 *
 * The fields are picked out by name rather than spread, because verification
 * passes a complete record and folding its own `hash` into the digest would
 * make every hash unverifiable.
 */
export function recordHash(record: Omit<LedgerRecord, "hash">): string {
  const canonical = canonicalJson({
    seq: record.seq,
    timestamp: record.timestamp,
    kind: record.kind,
    payload: record.payload,
    prevHash: record.prevHash,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Reading lines off disk
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

function looksLikeRecord(value: unknown): value is LedgerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isInteger(r.seq) &&
    (r.seq as number) >= 0 &&
    typeof r.timestamp === "string" &&
    typeof r.kind === "string" &&
    "payload" in r &&
    typeof r.prevHash === "string" &&
    HEX64.test(r.prevHash) &&
    typeof r.hash === "string" &&
    HEX64.test(r.hash)
  );
}

export interface ParsedLedger {
  /** Every record read before the first unreadable line, in file order. */
  records: LedgerRecord[];
  /** Index of the first unreadable line, when it is not the last line. */
  malformedAt: number | null;
  /** True when the final line is unreadable, which a crash mid-append leaves behind. */
  truncatedTail: boolean;
}

/**
 * Split a ledger file into records.
 *
 * A half-written final line is the normal shape of a crash during append: that
 * record was never completed and never signed, so it is dropped and reported.
 * An unreadable line anywhere else is a hole in the middle of the chain - disk
 * damage or tampering - and is reported as a break at that index.
 */
export function parseLedgerText(text: string): ParsedLedger {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const records: LedgerRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i] ?? "");
    } catch {
      parsed = undefined;
    }
    if (!looksLikeRecord(parsed)) {
      const isLast = i === lines.length - 1;
      return { records, malformedAt: isLast ? null : i, truncatedTail: isLast };
    }
    records.push(parsed);
  }
  return { records, malformedAt: null, truncatedTail: false };
}

// ---------------------------------------------------------------------------
// Keys and the detached signature
// ---------------------------------------------------------------------------

export interface LedgerKeyFile {
  version: 1;
  algorithm: "ed25519";
  privateKeyPkcs8: string;
  publicKeySpki: string;
  createdAt: string;
}

export interface LedgerSignatureFile {
  version: 1;
  algorithm: "ed25519";
  /** Number of records the signature covers. */
  count: number;
  /** Hash of the last record, or GENESIS_HASH when count is 0. */
  headHash: string;
  /** Base64 Ed25519 signature over canonicalJson({count, headHash}). */
  signature: string;
  /**
   * Base64 SPKI of the signing key, so a verifier holding only the ledger and
   * this file can check it. This field is not itself signed, so a verifier that
   * also holds the operator's key file compares the two - see verifyLedger.
   */
  publicKey: string;
}

/** The exact bytes the signature covers. */
export function signedMessage(count: number, headHash: string): Buffer {
  return Buffer.from(canonicalJson({ count, headHash }), "utf8");
}

function parseKeyFile(raw: string, path: string): LedgerKeyFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new LedgerError(
      `${path} is not valid JSON (${(err as Error).message}). The ledger cannot be signed ` +
        `without it; restore it from your backup, or move it aside to start a new chain.`,
    );
  }
  const k = value as Record<string, unknown> | null;
  if (
    typeof k?.privateKeyPkcs8 !== "string" ||
    typeof k?.publicKeySpki !== "string" ||
    k?.algorithm !== "ed25519"
  ) {
    throw new LedgerError(
      `${path} is not a ledger key file: it must hold an ed25519 privateKeyPkcs8 and a ` +
        `publicKeySpki, both base64. Restore the original file rather than editing this one.`,
    );
  }
  return {
    version: 1,
    algorithm: "ed25519",
    privateKeyPkcs8: k.privateKeyPkcs8,
    publicKeySpki: k.publicKeySpki,
    createdAt: typeof k.createdAt === "string" ? k.createdAt : new Date(0).toISOString(),
  };
}

/**
 * Load the signing key, generating one on first use.
 *
 * The file is created with mode 0o600. POSIX enforces that; Windows ignores the
 * mode and the file inherits the directory ACL, so on that platform the key is
 * only as private as the ledger directory itself.
 */
function loadOrCreateKey(paths: LedgerPaths): LedgerKeyFile {
  if (existsSync(paths.key)) {
    return parseKeyFile(readFileSync(paths.key, "utf8"), paths.key);
  }

  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile: LedgerKeyFile = {
    version: 1,
    algorithm: "ed25519",
    privateKeyPkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKeySpki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    createdAt: new Date().toISOString(),
  };

  try {
    // "wx" so a key written by a concurrent process is never overwritten:
    // losing a signing key silently would invalidate every earlier signature.
    writeFileSync(paths.key, JSON.stringify(keyFile, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
    return parseKeyFile(readFileSync(paths.key, "utf8"), paths.key);
  }
  return keyFile;
}

export function privateKeyFrom(keyFile: LedgerKeyFile): KeyObject {
  try {
    return createPrivateKey({
      key: Buffer.from(keyFile.privateKeyPkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch (err) {
    throw new LedgerError(
      `The ledger private key could not be decoded (${(err as Error).message}). ` +
        `It must be a base64 PKCS#8 Ed25519 key; restore the key file from your backup.`,
    );
  }
}

export function publicKeyFrom(spkiBase64: string): KeyObject {
  try {
    return createPublicKey({
      key: Buffer.from(spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch (err) {
    throw new LedgerError(
      `The ledger public key could not be decoded (${(err as Error).message}). ` +
        `It must be a base64 SPKI Ed25519 key.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Append serialisation
// ---------------------------------------------------------------------------

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialise appends across processes.
 *
 * The CLI and the MCP server both append. Without a lock, two of them can read
 * the same head, compute the same seq and prevHash, and write two records
 * claiming the same position - a break no later verification can repair.
 */
function withAppendLock<T>(paths: LedgerPaths, body: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(paths.lock, "wx");
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      // A process killed mid-append leaves its lock behind and nothing else
      // would ever clear it, so an old lock is treated as abandoned.
      try {
        if (Date.now() - statSync(paths.lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(paths.lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LedgerError(
          `Timed out after ${LOCK_WAIT_MS} ms waiting for ${paths.lock}. Another process is ` +
            `appending to this ledger; wait for it to finish, or delete the lock file if no ` +
            `such process is running.`,
        );
      }
      sleepSync(20);
    }
  }
  try {
    return body();
  } finally {
    closeSync(fd);
    rmSync(paths.lock, { force: true });
  }
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface LedgerOptions {
  /** Directory holding ledger.jsonl, the key and the signature. */
  dir?: string;
}

export class Ledger {
  readonly paths: LedgerPaths;
  private key: LedgerKeyFile | null = null;

  constructor(opts: LedgerOptions = {}) {
    this.paths = ledgerPaths(opts.dir ?? defaultLedgerDir());
  }

  /** Base64 SPKI of the signing key, for anyone verifying this ledger. */
  publicKeyBase64(): string {
    return this.loadKey().publicKeySpki;
  }

  /**
   * Every committed record, oldest first.
   *
   * A half-written final line is dropped: it was never a complete record.
   * Damage anywhere else is refused, because carrying on would hide the break
   * under records that all look valid.
   */
  read(): LedgerRecord[] {
    if (!existsSync(this.paths.ledger)) return [];
    const parsed = parseLedgerText(readFileSync(this.paths.ledger, "utf8"));
    if (parsed.malformedAt !== null) {
      throw new LedgerError(
        `Line ${parsed.malformedAt + 1} of ${this.paths.ledger} is not a ledger record, ` +
          `so the chain has a hole in it. Run ledger verification for the full report, and ` +
          `do not append until the file is restored from a backup.`,
      );
    }
    return parsed.records;
  }

  head(): LedgerRecord | null {
    const records = this.read();
    return records.length > 0 ? (records[records.length - 1] ?? null) : null;
  }

  /** Append one record and re-sign the head. Returns the record as written. */
  append(kind: string, payload: unknown): LedgerRecord {
    if (typeof kind !== "string" || kind.trim() === "") {
      throw new LedgerError(
        'A ledger record needs a non-empty kind, such as "decision" or "receipt", so the ' +
          "record can be found later without parsing its payload.",
      );
    }
    // Reject an uncanonicalisable payload here rather than after the line is on
    // disk, where the bad value would already be committed to the chain.
    canonicalJson(payload);

    const key = this.loadKey();
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });

    return withAppendLock(this.paths, () => {
      const prev = this.readForAppend();
      const unsigned: Omit<LedgerRecord, "hash"> = {
        seq: prev === null ? 0 : prev.record.seq + 1,
        timestamp: new Date().toISOString(),
        kind,
        payload,
        prevHash: prev === null ? GENESIS_HASH : prev.record.hash,
      };
      const record: LedgerRecord = { ...unsigned, hash: recordHash(unsigned) };

      // The line lands before the signature. A crash between the two leaves the
      // signature covering the previous head, which verification reports as an
      // unsigned last record rather than as a broken chain.
      appendFileSync(this.paths.ledger, canonicalJson(record) + "\n", { mode: 0o600 });
      this.writeSignature(key, prev === null ? 1 : prev.count + 1, record.hash);
      return record;
    });
  }

  private loadKey(): LedgerKeyFile {
    this.key ??= loadOrCreateKey(this.paths);
    return this.key;
  }

  /**
   * Read the head under the append lock, discarding a half-written final line.
   *
   * That line is a partial write: never signed, never counted, so dropping it
   * loses nothing committed. Refusing instead would leave the ledger
   * permanently unappendable after a single crash.
   */
  private readForAppend(): { record: LedgerRecord; count: number } | null {
    if (!existsSync(this.paths.ledger)) return null;
    const text = readFileSync(this.paths.ledger, "utf8");
    const parsed = parseLedgerText(text);
    if (parsed.malformedAt !== null) {
      throw new LedgerError(
        `Line ${parsed.malformedAt + 1} of ${this.paths.ledger} is not a ledger record. ` +
          `Appending would bury the damage under valid records, so nothing was written. ` +
          `Restore the file from a backup and try again.`,
      );
    }
    if (parsed.truncatedTail) {
      // Measured off the bytes actually on disk, not off a re-serialised
      // record, so the cut lands exactly after the last complete line however
      // that line was written.
      const lines = text.split("\n");
      let keep = 0;
      for (let i = 0; i < parsed.records.length; i++) {
        keep += Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
      }
      truncateSync(this.paths.ledger, keep);
    }
    const last = parsed.records[parsed.records.length - 1];
    return last === undefined ? null : { record: last, count: parsed.records.length };
  }

  private writeSignature(key: LedgerKeyFile, count: number, headHash: string): void {
    const signature = signBuffer(null, signedMessage(count, headHash), privateKeyFrom(key));
    const file: LedgerSignatureFile = {
      version: 1,
      algorithm: "ed25519",
      count,
      headHash,
      signature: signature.toString("base64"),
      publicKey: key.publicKeySpki,
    };
    // Written whole and renamed into place, so a reader never catches half a
    // signature file and reports a sound ledger as forged.
    const temp = `${this.paths.signature}.tmp`;
    writeFileSync(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.paths.signature);
  }
}
