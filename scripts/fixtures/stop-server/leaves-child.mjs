// A server stand-in that starts a child in its own process group which holds none of its output
// (stdio "ignore"), so the output closes while the child still runs. On SIGTERM it exits 0 at
// once, and the child goes on for a minute.
import { spawn } from "node:child_process";

process.on("SIGTERM", () => process.exit(0));
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
child.unref();
process.stdout.write(`child ${child.pid}\nready\n`);
setInterval(() => {}, 1000);
