// Denies outbound network access to the process that loads it, and counts the attempts:
//
//   node --import /abs/path/tests/deny-network.mjs app.js
//   NODE_OPTIONS="--import $PWD/tests/deny-network.mjs" npm start -w apps/api
//
// Every connection to a host that is not loopback (127.0.0.0/8, ::1, localhost) or a local
// socket fails, and so does every DNS lookup of such a host: fetch (and undici) rejects, an
// http(s) request or net/tls socket emits an error, a lookup calls back with an error. Each
// attempt is counted and logged on stderr ("[deny-network] blocked ...").
//
// On exit the process prints "[deny-network] outbound attempts: N (pid P)" on stderr, and, when
// DENY_NETWORK_REPORT names a file, appends one JSON line {pid, argv, attempts, hosts} to it (and
// another at each blocked attempt, so a process killed by a signal is still counted), so a test
// that starts several processes (npm, then the app) can check every one of them.
// globalThis.__denyNetwork.attempts() gives the count while the process runs.

import dns from "node:dns";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

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
  writeReport();
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

const realLookup = dns.lookup;
dns.lookup = function deniedLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) {
    const callback = rest.find((arg) => typeof arg === "function");
    const error = blocked("DNS lookup", hostname);
    if (callback) process.nextTick(() => callback(error));
    return {};
  }
  return realLookup.call(this, hostname, ...rest);
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function deniedPromiseLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) return Promise.reject(blocked("DNS lookup", hostname));
  return realPromiseLookup.call(this, hostname, ...rest);
};
for (const method of ["resolve", "resolve4", "resolve6", "resolveAny"]) {
  dns[method] = function deniedResolve(hostname, ...rest) {
    const callback = rest.find((arg) => typeof arg === "function");
    const error = blocked("DNS query", hostname);
    if (callback) process.nextTick(() => callback(error));
  };
}

// Named imports of the built-in modules (import { request } from "node:http") see the patches.
syncBuiltinESMExports();

// --- report -----------------------------------------------------------------------------------

globalThis.__denyNetwork = { attempts: () => blockedHosts.length, hosts: () => [...blockedHosts] };

/** Appends this process's count to DENY_NETWORK_REPORT, when it names a file. */
function writeReport() {
  const report = process.env.DENY_NETWORK_REPORT;
  if (!report) return;
  try {
    appendFileSync(
      report,
      `${JSON.stringify({
        pid: process.pid,
        argv: process.argv.slice(1),
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
  writeReport();
});
