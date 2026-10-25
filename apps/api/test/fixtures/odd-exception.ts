/**
 * Spawned by src/index.test.ts: installs the API's process-level handlers, then throws an error
 * the log cannot read whole (its message is an object, reading its code throws). The handler
 * must still log it, run the fatal hook and exit 1.
 */

import { installProcessHandlers } from "../../src/lifecycle.js";

installProcessHandlers(() => console.log("fatal hook ran"));

setTimeout(() => {
  const error = new Error("odd exception");
  (error as unknown as { message: unknown }).message = { detail: "odd exception detail" };
  Object.defineProperty(error, "code", {
    get() {
      throw new Error("getter exploded");
    },
  });
  throw error;
}, 10);
