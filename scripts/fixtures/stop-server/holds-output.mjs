// A server stand-in that leaves behind a process outside its process group which holds its
// output open for a minute. On SIGTERM it exits 0 at once.
import { spawn } from "node:child_process";

process.on("SIGTERM", () => process.exit(0));
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
holder.unref();
process.stdout.write(`holder ${holder.pid}\nready\n`);
setInterval(() => {}, 1000);
