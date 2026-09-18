#!/usr/bin/env bun
import { run } from "../src/cli";

run(process.argv).catch((err: unknown) => {
  console.error(`squanchy: error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
