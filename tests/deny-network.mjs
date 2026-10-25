// Denies outbound network access to the process that loads it, and counts the attempts:
//
//   node --import /abs/path/tests/deny-network.mjs app.js
//   NODE_OPTIONS="--import $PWD/tests/deny-network.mjs" npm start -w apps/api
//
// What it enforces, in the process that loads it:
// - connections: every socket connection (net.Socket#connect, which tls, http, https, http2 and
//   undici use) to a host that is not loopback (127.0.0.0/8, ::1, localhost) fails, as do
//   fetch and http(s).request/get to such a host; local (unix) sockets are allowed;
// - DNS: dns.lookup and dns.promises.lookup of such a host fail (0.0.0.0 and :: are looked up, so
//   a server can listen on every interface), and every DNS query function (resolve*, reverse,
//   lookupService, on dns, dns.promises and their Resolver classes) fails whatever its argument;
// - worker threads: starting one fails, since this file is not loaded in them.
// Each refusal is counted and logged on stderr ("[deny-network] blocked ...").
//
// Not enforced: child processes are covered only when they inherit NODE_OPTIONS with this file
// (an inherited environment does); other programs (curl, python) are not covered at all.
//
// On exit the process prints "[deny-network] outbound attempts: N (pid P)" on stderr. When
// DENY_NETWORK_REPORT names a file, it appends JSON lines {pid, ppid, argv, execArgv, event,
// attempts, hosts} to it: event "start" when this file loads (so a test knows which pid runs what,
// and which process started it: the parent at that moment, or the process that adopted it when the
// parent has exited by then), "blocked" at each blocked attempt (so a process killed by a signal is
// still counted) and "exit" on exit (a process killed by a signal has none). `execArgv` names a
// process with no script (`node -e ...`, whose argv is empty). A test that starts several processes
// (npm, then the app) can check every one of them.
// globalThis.__denyNetwork.attempts() gives the count while the process runs.

import dns from "node:dns";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";

const blockedHosts = [];

function isLoopback(host) {
  if (host === undefined || host === null || host === "") return true; // Node's default: localhost
  const name = String(host)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (isIP(name) === 4) return name.startsWith("127.");
  if (isIP(name) === 6) return name === "::1" || name.startsWith("::ffff:127.");
  return false;
}

function blocked(what, host) {
  const label = String(host);
  blockedHosts.push(label);
  process.stderr.write(`[deny-network] blocked ${what} to ${label}\n`);
  // Written at once too: a process killed by a signal never reaches its exit report.
  writeReport("blocked");
  const error = new Error(`Network access is denied in this process (${what} to ${label})`);
  error.code = "ENETUNREACH";
  return error;
}

// --- fetch (Node's built-in undici) -----------------------------------------------------------

const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = function deniedFetch(input, init) {
    let host = null;
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
    } catch {
      // Not a URL fetch understands; let it fail on its own.
    }
    if (host !== null && !isLoopback(host)) return Promise.reject(blocked("fetch", host));
    return realFetch.call(this, input, init);
  };
}

// --- sockets: net, and everything built on it (tls, http, https, undici) ----------------------

function targetOf(args) {
  // net.connect normalizes its arguments to [options, callback] before Socket#connect.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) return null; // a local (unix) socket
    return { host: first.host ?? first.hostname ?? "localhost", port: first.port };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return null; // a socket path
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function deniedConnect(...args) {
  const target = targetOf(args);
  if (target && !isLoopback(target.host)) {
    const error = blocked("connection", `${target.host}:${target.port}`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return realConnect.apply(this, args);
};

// http(s).request and .get: refuse the request itself, so the error names the URL's host.
function hostOfRequest(args) {
  const [first, second] = args;
  if (typeof first === "string" || first instanceof URL) {
    try {
      return new URL(String(first)).hostname;
    } catch {
      return undefined;
    }
  }
  const options = first && typeof first === "object" ? first : second;
  if (!options || typeof options !== "object") return undefined;
  if (options.socketPath) return "localhost";
  return options.hostname ?? options.host ?? "localhost";
}

for (const [name, module] of [
  ["http", http],
  ["https", https],
]) {
  for (const method of ["request", "get"]) {
    const real = module[method];
    module[method] = function deniedRequest(...args) {
      const host = hostOfRequest(args);
      if (host !== undefined && !isLoopback(host)) {
        throw blocked(`${name}.${method}`, host);
      }
      return real.apply(this, args);
    };
  }
}

// --- DNS --------------------------------------------------------------------------------------

// Listening on every interface looks up 0.0.0.0 or ::; connecting to them is still refused.
const isLocalLookup = (hostname) =>
  isLoopback(hostname) || ["0.0.0.0", "::", "[::]"].includes(String(hostname));

const realLookup = dns.lookup;
dns.lookup = function deniedLookup(hostname, ...rest) {
  if (!isLocalLookup(hostname)) {
    const callback = rest.find((arg) => typeof arg === "function");
    const error = blocked("DNS lookup", hostname);
    if (callback) process.nextTick(() => callback(error));
    return {};
  }
  return realLookup.call(this, hostname, ...rest);
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function deniedPromiseLookup(hostname, ...rest) {
  if (!isLocalLookup(hostname)) return Promise.reject(blocked("DNS lookup", hostname));
  return realPromiseLookup.call(this, hostname, ...rest);
};

// Every query function: callback style on dns and dns.Resolver, promises on dns.promises and
// dns.promises.Resolver.
const QUERY = /^(?:resolve|reverse|lookupService$)/;
const denyCallback = (name) =>
  function deniedQuery(target, ...rest) {
    const callback = rest.find((arg) => typeof arg === "function");
    const error = blocked(`DNS ${name}`, target);
    if (callback) process.nextTick(() => callback(error));
    return {};
  };
const denyPromise = (name) =>
  function deniedQuery(target) {
    return Promise.reject(blocked(`DNS ${name}`, target));
  };
for (const [target, deny] of [
  [dns, denyCallback],
  [dns.Resolver.prototype, denyCallback],
  [dns.promises, denyPromise],
  [dns.promises.Resolver.prototype, denyPromise],
]) {
  // The Resolver classes inherit their query methods: walk the prototype chain.
  for (
    let owner = target;
    owner && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner)
  ) {
    for (const name of Object.getOwnPropertyNames(owner)) {
      if (QUERY.test(name) && typeof owner[name] === "function") target[name] = deny(name);
    }
  }
}

// --- worker threads ---------------------------------------------------------------------------

// A worker would run without this file (--import is not applied to workers): refuse to start one.
const RealWorker = workerThreads.Worker;
workerThreads.Worker = function DeniedWorker(filename) {
  throw blocked("worker thread", String(filename).slice(0, 80));
};
workerThreads.Worker.prototype = RealWorker.prototype;

// Named imports of the built-in modules (import { request } from "node:http") see the patches.
syncBuiltinESMExports();

// --- report -----------------------------------------------------------------------------------

globalThis.__denyNetwork = { attempts: () => blockedHosts.length, hosts: () => [...blockedHosts] };

/** Appends this process's count to DENY_NETWORK_REPORT, when it names a file. */
function writeReport(event) {
  const report = process.env.DENY_NETWORK_REPORT;
  if (!report) return;
  try {
    appendFileSync(
      report,
      `${JSON.stringify({
        pid: process.pid,
        ppid: process.ppid,
        argv: process.argv.slice(1),
        execArgv: process.execArgv,
        event,
        attempts: blockedHosts.length,
        hosts: blockedHosts,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`[deny-network] could not write the report: ${error}\n`);
  }
}

process.on("exit", () => {
  process.stderr.write(
    `[deny-network] outbound attempts: ${blockedHosts.length} (pid ${process.pid})\n`,
  );
  writeReport("exit");
});

writeReport("start");
