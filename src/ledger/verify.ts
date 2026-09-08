/**
 * Ledger verification.
 *
 * Two questions, answered separately because they fail for different reasons.
 * `verifyChain` asks whether the records are internally consistent: every hash
 * recomputed, every link followed, the first failure reported by index.
 * `verifyLedger` adds the question the chain cannot answer on its own - whether
 * this is the operator's ledger and not a convincing replacement - by checking
 * the Ed25519 signature over the record count and the head hash.
 */

import { existsSync, readFileSync } from "node:fs";
import { verify as verifySignature } from "node:crypto";
import {
  DEFAULT_LEDGER_DIR,
  GENESIS_HASH,
  LedgerError,
  type LedgerRecord,
  type LedgerSignatureFile,
  ledgerPaths,
  parseLedgerText,
  publicKeyFrom,
  recordHash,
  signedMessage,
} from "./chain.ts";

export interface VerifyResult {
  /** True only when nothing checked came back wrong. */
  ok: boolean;
  /** How many records were read and checked. */
  records: number;
  /** Index of the first record that failed, or null when the chain holds. */
  brokenAt: number | null;
  /** What went wrong, or what was skipped. Null when there is nothing to say. */
  reason: string | null;
  /** True only when an Ed25519 signature over this ledger's head was checked and held. */
  signatureValid: boolean;
}

/**
 * Recompute the chain over records already in memory.
 *
 * Three invariants, checked in the order that gives the clearest report: a
 * record's seq equals its index, its prevHash equals the previous record's
 * hash, and its own hash is the SHA-256 of its contents. The first two catch
 * records that were removed or reordered without being touched; the third
 * catches a record whose contents were edited in place.
 *
 * This function never sees a signature file, so `signatureValid` is always
 * false here. Only `verifyLedger` can establish it.
 */
export function verifyChain(records: LedgerRecord[]): VerifyResult {
  const broken = (index: number, why: string): VerifyResult => ({
    ok: false,
    records: records.length,
    brokenAt: index,
    reason: why,
    signatureValid: false,
  });

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) {
      return broken(i, `Record ${i} is missing from the array handed to verification.`);
    }

    if (record.seq !== i) {
      return broken(
        i,
        `The record at index ${i} carries seq ${record.seq}. A record's seq always equals ` +
          `its position in the file, so records have been removed or reordered here.`,
      );
    }

    const expectedPrev = i === 0 ? GENESIS_HASH : (records[i - 1]?.hash ?? GENESIS_HASH);
    if (record.prevHash !== expectedPrev) {
      return broken(
        i,
        `Record ${i} points back to ${short(record.prevHash)} but the record before it ` +
          `hashes to ${short(expectedPrev)}. The chain is cut here.`,
      );
    }

    let computed: string;
    try {
      computed = recordHash(record);
    } catch (err) {
      return broken(
        i,
        `Record ${i} holds a value that cannot be hashed (${(err as Error).message}) ` +
          `so its integrity cannot be established.`,
      );
    }
    if (computed !== record.hash) {
      return broken(
        i,
        `Record ${i} claims hash ${short(record.hash)} but its contents hash to ` +
          `${short(computed)}. This record was changed after it was written.`,
      );
    }
  }

  return {
    ok: true,
    records: records.length,
    brokenAt: null,
    reason: null,
    signatureValid: false,
  };
}

/**
 * Verify a ledger on disk: the chain, then the signature over its head.
 *
 * Signature failures do not set `brokenAt`. A ledger whose trailing records
 * were deleted has a chain that is perfectly consistent and a signed count that
 * no longer matches - there is no broken link to point at, which is exactly why
 * the count is signed alongside the head hash.
 */
export function verifyLedger(opts: { dir?: string } = {}): VerifyResult {
  const paths = ledgerPaths(opts.dir ?? DEFAULT_LEDGER_DIR);

  const text = existsSync(paths.ledger) ? readFileSync(paths.ledger, "utf8") : "";
  const parsed = parseLedgerText(text);

  const chain = verifyChain(parsed.records);
  let brokenAt: number | null = null;
  let chainReason: string | null = null;

  if (!chain.ok) {
    brokenAt = chain.brokenAt;
    chainReason = chain.reason;
  } else if (parsed.malformedAt !== null) {
    // parseLedgerText stops at the hole, so anything the chain check could have
    // faulted lies before it and would already have been reported above.
    brokenAt = parsed.malformedAt;
    chainReason =
      `Line ${parsed.malformedAt + 1} of ${paths.ledger} is not a ledger record, so the ` +
      `chain is cut at index ${parsed.malformedAt}. Records after it cannot be checked. ` +
      `Restore the file from a backup.`;
  }

  const signature = checkSignature(paths, parsed.records);

  const notes = [chainReason, signature.note];
  if (parsed.truncatedTail) {
    notes.push(
      `The last line of ${paths.ledger} is incomplete and was ignored. It was never ` +
        `signed and never counted, so no committed record was lost.`,
    );
  }
  const reason = notes.filter((n): n is string => n !== null).join(" ");

  return {
    ok: brokenAt === null && signature.valid,
    records: parsed.records.length,
    brokenAt,
    reason: reason === "" ? null : reason,
    signatureValid: signature.valid,
  };
}

// ---------------------------------------------------------------------------

interface SignatureCheck {
  valid: boolean;
  note: string | null;
}

function checkSignature(
  paths: ReturnType<typeof ledgerPaths>,
  records: LedgerRecord[],
): SignatureCheck {
  const head = records[records.length - 1];
  const headHash = head?.hash ?? GENESIS_HASH;

  if (!existsSync(paths.signature)) {
    // A ledger nobody has written to yet has nothing to sign, and calling that
    // a failure would make a fresh install look tampered with.
    if (records.length === 0) return { valid: true, note: null };
    return {
      valid: false,
      note:
        `There is no signature at ${paths.signature}, so these ${records.length} record(s) ` +
        `cannot be shown to be the operator's. Append to the ledger to re-sign it, or ` +
        `restore the signature file from a backup.`,
    };
  }

  let file: LedgerSignatureFile;
  try {
    file = parseSignatureFile(readFileSync(paths.signature, "utf8"), paths.signature);
  } catch (err) {
    return { valid: false, note: (err as Error).message };
  }

  // The public key inside the signature file is not itself signed, so on its
  // own it proves only that whoever wrote the file also signed it. Pinning it
  // against the operator's key file is what makes the signature mean anything.
  if (existsSync(paths.key)) {
    let operatorKey: string;
    try {
      const raw = JSON.parse(readFileSync(paths.key, "utf8")) as { publicKeySpki?: unknown };
      if (typeof raw.publicKeySpki !== "string") throw new Error("no publicKeySpki field");
      operatorKey = raw.publicKeySpki;
    } catch (err) {
      return {
        valid: false,
        note:
          `The operator key at ${paths.key} could not be read (${(err as Error).message}), ` +
          `so the signature cannot be tied to a known key. Restore the key file from your backup.`,
      };
    }
    if (operatorKey !== file.publicKey) {
      return {
        valid: false,
        note:
          `${paths.signature} was signed by a different key than the one in ${paths.key}. ` +
          `The ledger has been re-signed by someone else; treat every record in it as unproven.`,
      };
    }
  }

  let verified: boolean;
  try {
    verified = verifySignature(
      null,
      signedMessage(file.count, file.headHash),
      publicKeyFrom(file.publicKey),
      Buffer.from(file.signature, "base64"),
    );
  } catch (err) {
    return { valid: false, note: (err as Error).message };
  }
  if (!verified) {
    return {
      valid: false,
      note:
        `The Ed25519 signature in ${paths.signature} does not match the count and head hash ` +
        `it covers. The signature file has been altered; restore it from a backup.`,
    };
  }

  if (file.count !== records.length) {
    return {
      valid: false,
      note:
        `The signature covers ${file.count} record(s) but ${paths.ledger} holds ` +
        `${records.length}. ${
          file.count > records.length
            ? `${file.count - records.length} record(s) were deleted from the end of the ledger.`
            : `${records.length - file.count} record(s) were added without being signed.`
        }`,
    };
  }

  if (file.headHash !== headHash) {
    return {
      valid: false,
      note:
        `The signature covers head ${short(file.headHash)} but the last record hashes to ` +
        `${short(headHash)}. The final record was replaced after it was signed.`,
    };
  }

  if (!existsSync(paths.key)) {
    return {
      valid: true,
      note:
        `The signature was checked against the public key carried in ${paths.signature}, ` +
        `because ${paths.key} is not present. Compare that key with the operator's own ` +
        `before treating this as proof of origin: ${file.publicKey}`,
    };
  }

  return { valid: true, note: null };
}

function parseSignatureFile(raw: string, path: string): LedgerSignatureFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new LedgerError(
      `${path} is not valid JSON (${(err as Error).message}), so the ledger's signature ` +
        `cannot be checked. Restore the file from a backup.`,
    );
  }
  const s = value as Record<string, unknown> | null;
  if (
    s?.algorithm !== "ed25519" ||
    !Number.isInteger(s?.count) ||
    (s.count as number) < 0 ||
    typeof s?.headHash !== "string" ||
    typeof s?.signature !== "string" ||
    typeof s?.publicKey !== "string"
  ) {
    throw new LedgerError(
      `${path} is not a ledger signature: it must hold algorithm "ed25519", a count, a ` +
        `headHash, a base64 signature and a base64 publicKey. Restore the file from a backup.`,
    );
  }
  return {
    version: 1,
    algorithm: "ed25519",
    count: s.count as number,
    headHash: s.headHash,
    signature: s.signature,
    publicKey: s.publicKey,
  };
}

/** Hashes are 64 hex characters; nobody reads them in full in an error message. */
function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;
}
