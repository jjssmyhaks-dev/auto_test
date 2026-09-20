import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3BlobStore } from "./blobs.js";

/**
 * The S3 delete path against a fake S3-compatible server: verifies the
 * ListObjectsV2 request shape, XML key parsing, the batched DeleteObjects
 * body, and the returned count — i.e. everything except the signature math
 * itself (which MinIO/R2 validate in integration).
 */
describe("S3BlobStore deleteByPrefix", () => {
  let server: Server;
  let port = 0;
  const seen: { method: string; url: string; body: string }[] = [];
  const stored = new Map<string, Buffer>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ method: req.method ?? "", url, body: body.toString("utf8") });
        if (req.method === "GET" && url.includes("list-type=2")) {
          const keys = [...stored.keys()].filter((k) => k.startsWith(new URLSearchParams(url.split("?")[1]).get("prefix") ?? ""));
          const xml = `<?xml version="1.0"?><ListBucketResult>${keys
            .map((k) => `<Contents><Key>${k}</Key></Contents>`)
            .join("")}</ListBucketResult>`;
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(xml);
          return;
        }
        if (req.method === "POST" && url.endsWith("?delete")) {
          for (const m of body.toString("utf8").matchAll(/<Key>([^<]+)<\/Key>/g)) {
            stored.delete(m[1]);
          }
          res.writeHead(200, { "content-type": "application/xml" });
          res.end('<?xml version="1.0"?><DeleteResult><Deleted>true</Deleted></DeleteResult>');
          return;
        }
        if (req.method === "PUT") {
          const key = decodeURIComponent(url.split("/").slice(2).join("/"));
          stored.set(key, body);
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lists by prefix and batch-deletes the keys", async () => {
    stored.clear();
    seen.length = 0;
    stored.set("run_a/screenshots/step-0.png", Buffer.from("a"));
    stored.set("run_a/screenshots/step-1.png", Buffer.from("b"));
    stored.set("run_a/video.webm", Buffer.from("v"));
    stored.set("run_b/screenshots/step-0.png", Buffer.from("keep me"));
    const s3 = new S3BlobStore(`http://127.0.0.1:${port}`, "veriflow", "k", "s");
    const n = await s3.deleteByPrefix("run_a/");
    expect(n).toBe(3);
    expect(stored.has("run_b/screenshots/step-0.png")).toBe(true);
    expect([...stored.keys()].filter((k) => k.startsWith("run_a/"))).toHaveLength(0);

    // The list call used ListObjectsV2 with the right prefix.
    const list = seen.find((s) => s.method === "GET");
    expect(list?.url).toContain("list-type=2");
    expect(list?.url).toContain("prefix=run_a%2F");
    // The delete used POST ?delete with an XML body naming the keys.
    const del = seen.find((s) => s.method === "POST");
    expect(del?.url.endsWith("?delete")).toBe(true);
    expect(del?.body).toContain("<Key>run_a/video.webm</Key>");
  });

  it("returns 0 for an empty prefix without calling delete", async () => {
    stored.clear();
    seen.length = 0;
    const s3 = new S3BlobStore(`http://127.0.0.1:${port}`, "veriflow", "k", "s");
    const n = await s3.deleteByPrefix("nothing-here/");
    expect(n).toBe(0);
    expect(seen.find((s) => s.method === "POST")).toBeUndefined();
  });
});
