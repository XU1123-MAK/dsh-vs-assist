// DTE bridge: spawns Windows PowerShell to talk to Visual Studio via EnvDTE COM.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "vs-dte.ps1");
const PROG_IDS = ["VisualStudio.DTE.18.0", "VisualStudio.DTE.17.0", "VisualStudio.DTE.16.0", "VisualStudio.DTE.15.0"];

function psSingle(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function encodeCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function parseJsonLines(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

export class BridgeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VsBridgeError";
    this.details = details;
  }
}

/**
 * Run one DTE action in a fresh powershell.exe (STA) and return the JSON result.
 */
export async function runBridge(action, payload = {}, { timeoutMs = 60000, powershell = "powershell.exe" } = {}) {
  const payloadJson = JSON.stringify(payload ?? {});
  let payloadFile = null;
  try {
    if (payloadJson.length > 4096) {
      const dir = mkdtempSync(join(tmpdir(), "dsh-vs-"));
      payloadFile = join(dir, "payload.json");
      writeFileSync(payloadFile, payloadJson, "utf8");
    }
    const inv = payloadFile
      ? `& ${psSingle(SCRIPT)} -Action ${psSingle(action)} -PayloadFile ${psSingle(payloadFile)}`
      : `& ${psSingle(SCRIPT)} -Action ${psSingle(action)} -Payload ${psSingle(payloadJson)}`;
    const args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(inv)];
    const child = spawn(powershell, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    const timer = setTimeout(() => {
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {}
    }, timeoutMs);
    const [code] = await once(child, "close");
    clearTimeout(timer);
    const data = parseJsonLines(out);
    if (!data) {
      throw new BridgeError(`vs bridge failed (exit ${code})`, { code, out, err, timedOut: false });
    }
    if (data.ok !== true) {
      throw new BridgeError(String(data.error ?? "vs bridge error"), { code, out, err, data });
    }
    return data;
  } finally {
    if (payloadFile) {
      try { rmSync(dirname(payloadFile), { recursive: true, force: true }); } catch {}
    }
  }
}

export function vswherePath() {
  const base = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const p = join(base, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  return existsSync(p) ? p : null;
}

/**
 * Discover Visual Studio via vswhere; returns { installationPath, productPath, version } or null.
 */
export function discoverVs() {
  const vswhere = vswherePath();
  if (vswhere) {
    try {
      const res = spawnSync(vswhere, ["-latest", "-products", "*", "-format", "json", "-utf8"], {
        windowsHide: true, encoding: "utf8", timeout: 30000,
      });
      if (res.status === 0 && res.stdout) {
        const list = JSON.parse(res.stdout);
        if (Array.isArray(list) && list.length > 0) {
          const first = list[0];
          return {
            installationPath: first.installationPath,
            productPath: first.productPath,
            version: first.installationVersion,
            displayName: first.displayName,
          };
        }
      }
    } catch {}
  }
  // fallback: probe common install dirs
  const candidates = [
    join(process.env["ProgramFiles"] || "C:\\Program Files", "Microsoft Visual Studio", "18", "Community", "Common7", "IDE", "devenv.exe"),
    join(process.env["ProgramFiles"] || "C:\\Program Files", "Microsoft Visual Studio", "2022", "Community", "Common7", "IDE", "devenv.exe"),
    join(process.env["ProgramFiles"] || "C:\\Program Files", "Microsoft Visual Studio", "2022", "Professional", "Common7", "IDE", "devenv.exe"),
    join(process.env["ProgramFiles"] || "C:\\Program Files", "Microsoft Visual Studio", "2022", "Enterprise", "Common7", "IDE", "devenv.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return { installationPath: dirname(dirname(dirname(c))), productPath: c, version: null };
    }
  }
  return null;
}

function runReg(args) {
  try {
    return spawnSync("reg.exe", ["add", ...args, "/f"], { windowsHide: true, stdio: "ignore" }).status === 0;
  } catch { return false; }
}

/** Write software-rendering registry keys (fixes the black VS window on VMs / RDP). */
export function applySoftwareRendering(version) {
  const v = version || "18.0";
  const ok1 = runReg(["HKCU\\Software\\Microsoft\\Avalon.Graphics", "/v", "DisableHWAcceleration", "/t", "REG_DWORD", "/d", "1"]);
  const ok2 = runReg([`HKCU\\Software\\Microsoft\\VisualStudio\\${v}\\General`, "/v", "EnableHardwareAcceleration", "/t", "REG_DWORD", "/d", "0"]);
  return ok1 && ok2;
}

/** List devenv.exe process ids via tasklist. */
export function listDevenvPids() {
  try {
    const res = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq devenv.exe", "/FO", "CSV", "/NH"], {
      windowsHide: true, encoding: "utf8", timeout: 15000,
    });
    if (res.status !== 0 && res.status !== null) return [];
    const pids = [];
    for (const line of String(res.stdout).split(/\r?\n/)) {
      const m = /"devenv\.exe","(\d+)"/i.exec(line);
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  } catch { return []; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attach to a running VS instance. When none is found and launchIfMissing is true,
 * launches devenv.exe and polls until the DTE registers in the ROT.
 */
export async function ensureAttached(config, state) {
  const now = Date.now();
  if (state.lastStatus && state.lastStatus.ok && now - state.lastStatusAt < 25000) {
    return state.lastStatus;
  }
  if (state.attachPromise) return state.attachPromise;
  state.attachPromise = (async () => {
    let status = null;
    try {
      status = await runBridge("status", {}, { timeoutMs: config.commandTimeoutMs });
    } catch (error) {
      if (!config.launchIfMissing) throw error;
      status = null;
    }
    if (status) {
      state.lastStatus = status;
      state.lastStatusAt = Date.now();
      return status;
    }
    if (!config.launchIfMissing) {
      throw new BridgeError("no running Visual Studio instance found");
    }
    if (config.softwareRendering) applySoftwareRendering(config.versionKey);
    const vs = config.devenvPath ? { productPath: config.devenvPath } : discoverVs();
    if (!vs || !vs.productPath || !existsSync(vs.productPath)) {
      throw new BridgeError("Visual Studio not found; set devenvPath in the plugin config");
    }
    const child = spawn(vs.productPath, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    const deadline = Date.now() + config.launchTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        status = await runBridge("status", {}, { timeoutMs: config.commandTimeoutMs });
        if (status && status.ok) {
          state.lastStatus = status;
          state.lastStatusAt = Date.now();
          return status;
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw new BridgeError(`Visual Studio did not become ready within ${config.launchTimeoutMs}ms`, { lastError: String(lastError ?? "") });
  })().finally(() => {
    state.attachPromise = null;
  });
  return state.attachPromise;
}

export function newBridgeState() {
  return { lastStatus: null, lastStatusAt: 0, attachPromise: null };
}

export { PROG_IDS };
