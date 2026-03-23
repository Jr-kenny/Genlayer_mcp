#!/usr/bin/env node
import { startServer } from "./index.js";

startServer().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});

