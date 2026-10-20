/**
 * Spawned by src/index.test.ts: installs the API's process-level handlers, then causes an
 * unhandled rejection (the process must keep running) and an uncaught exception (it must run
 * the fatal hook and exit 1).
 */

import { installProcessHandlers } from "../../src/lifecycle.js";

installProcessHandlers(() => console.log("fatal hook ran"));

void Promise.reject(new Error("rejection nobody handled"));

setTimeout(() => {
  console.log("still running after the rejection");
  setTimeout(() => {
    throw new Error("exception nobody caught");
  }, 10);
}, 100);

setTimeout(() => console.log("still running after the exception"), 2000);
