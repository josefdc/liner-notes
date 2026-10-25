// A server stand-in whose event loop is busy in 250 ms slices, so it handles a signal late (as a
// server on a loaded machine may). On SIGTERM it exits 0 shortly after.
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 10));
const busy = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
};
setInterval(() => busy(250), 1);
process.stdout.write("ready\n");
