/**
 * maia — read-only web client that streams files out of an atlas encrypted
 * vault stored in GitHub Releases. Entry point: load config, build the handler,
 * serve. This is the Deno Deploy entrypoint.
 */

import { loadConfig } from "./src/config.ts";
import { buildHandler } from "./src/server.ts";

const config = loadConfig();
const handler = buildHandler(config);

Deno.serve({ port: config.port }, handler);
