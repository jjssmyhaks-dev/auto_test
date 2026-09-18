import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createApp } from "./app.js";
import { MemoryStore } from "./store.js";
import { createBlobStore } from "./blobs.js";
import { tryPgStore } from "./pg.js";

export { createApp } from "./app.js";

export async function createProductionApp() {
  const pg = await tryPgStore(process.env.DATABASE_URL);
  const store =
    pg ??
    MemoryStore.fromFile(
      process.env.VERIFLOW_CLOUD_DIR ?? join(homedir(), ".veriflow", "cloud-data"),
    );
  const blobs = await createBlobStore();
  return createApp({ store, blobs });
}

export function listen(port = Number(process.env.PORT ?? 8787)) {
  return createProductionApp().then((app) => {
    return serve({ fetch: app.fetch, port }, () => {
      console.log(`veriflow api listening on :${port}`);
    });
  });
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (self === invoked) {
  listen();
}
