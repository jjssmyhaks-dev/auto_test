/**
 * Live S3 dialect validation for S3BlobStore against a real S3-compatible
 * server. Validates put, signed get, list pagination (>1000 keys), paginated
 * DeleteObjects, and special-character keys — the paths the fake-S3 unit
 * tests cannot fully prove (strict servers reject signature quirks).
 *
 * Default target is the local Garage instance from scripts/garage.toml:
 *   docker run -d --name veriflow-garage -p 3900:3900 -p 3903:3903 \
 *     -v "$PWD/scripts/garage.toml:/etc/garage.toml" dxflrs/garage:v1.1.0
 *   (then: layout assign/apply, bucket create veriflow, key create + allow)
 *
 * Usage: S3_ENDPOINT=... node scripts/smoke-s3.mjs   (all env optional)
 */
import { S3BlobStore } from "../apps/api/dist/blobs.js";

const ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:3900";
const BUCKET = process.env.S3_BUCKET ?? "veriflow";
const ACCESS = process.env.S3_ACCESS_KEY ?? "GK24fd86d7e9864c82679e826b";
const SECRET = process.env.S3_SECRET_KEY ?? "d6dd72ae26b6ea1d0a6be80008db6d9f4558ab191f5fe7af1589b219a59eadae";
const REGION = process.env.S3_REGION ?? "us-east-1";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const s3 = new S3BlobStore(ENDPOINT, BUCKET, ACCESS, SECRET, REGION);
console.log(`S3 dialect validation → ${ENDPOINT} bucket=${BUCKET} region=${REGION}`);

// ---- 1. put / signed get round-trip (text + binary) ----
const textKey = "smoke/hello.txt";
await s3.put(textKey, Buffer.from("hello veriflow ☕ — signed get works"), "text/plain; charset=utf-8");
const gotText = await s3.get(textKey);
check("put + signed get (utf-8 text)", gotText?.toString("utf8") === "hello veriflow ☕ — signed get works");

const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256));
await s3.put("smoke/blob.bin", bin);
const gotBin = await s3.get("smoke/blob.bin");
check("put + signed get (binary)", Buffer.compare(bin, gotBin ?? Buffer.alloc(0)) === 0);

// ---- 2. overwrite ----
await s3.put(textKey, Buffer.from("v2"), "text/plain");
check("overwrite same key", (await s3.get(textKey))?.toString("utf8") === "v2");

// ---- 3. special-character keys (canonical URI encoding) ----
const special = [
  "docs/a b & c (1).txt", // spaces, ampersand, parens
  "plus+key.txt", // plus must be %2B in the canonical URI
  "uni-ключ-キー.txt", // non-ASCII
  "quote'and\"dquote.txt", // quotes (XML escaping on delete)
];
let specialOk = true;
for (const k of special) {
  try {
    await s3.put(k, Buffer.from(`content of ${k}`));
    const got = await s3.get(k);
    if (got?.toString("utf8") !== `content of ${k}`) specialOk = false;
  } catch (err) {
    specialOk = false;
    console.log(`    (${k}: ${err instanceof Error ? err.message : err})`);
  }
}
check("special-char keys put + signed get", specialOk);
const listed = await s3.list("docs/");
check("list finds the spaced key", listed.includes("docs/a b & c (1).txt"), JSON.stringify(listed));

// ---- 4. paginated list: 2400 keys > one 1000-key page ----
const N = 2400;
await Promise.all(
  Array.from({ length: Math.ceil(N / 64) }, (_, chunk) =>
    Promise.all(
      Array.from({ length: 64 }, (_, i) => {
        const n = chunk * 64 + i;
        return n < N ? s3.put(`bulk/obj-${String(n).padStart(5, "0")}`, Buffer.from(`payload ${n}`)) : undefined;
      }),
    ),
  ),
);
const bulk = await s3.list("bulk/");
check(`paginated list returns all ${N} keys`, bulk.length === N, `got ${bulk.length}`);

// ---- 5. paginated delete: 3 batches (1000/1000/400) ----
const deleted = await s3.deleteByPrefix("bulk/");
check(`paginated delete removes all ${N}`, deleted === N, `got ${deleted}`);
check("deleted keys are gone", (await s3.get("bulk/obj-00000")) === undefined);
check("list after delete is empty", (await s3.list("bulk/")).length === 0);

// ---- 6. deleting a missing prefix is a no-op ----
check("delete missing prefix returns 0", (await s3.deleteByPrefix("nope/")) === 0);

// ---- 7. cleanup + final state ----
await s3.deleteByPrefix("smoke/");
await s3.deleteByPrefix("docs/");
await s3.deleteByPrefix("uni-");
await s3.deleteByPrefix("plus");
await s3.deleteByPrefix("quote"); // exercises XML-escaped keys through DeleteObjects
const leftovers = await s3.list("");
check("bucket clean at end", leftovers.length === 0, JSON.stringify(leftovers.slice(0, 5)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
