// MSBuild build engine: runs VS's MSBuild.exe as a subprocess and parses
// structured errors/warnings. Independent of the IDE's automation quirks.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { once } from "node:events";
import { vswherePath } from "./bridge.js";

export function discoverMsbuild(config, vsInfo) {
  if (config.msbuildPath && existsSync(config.msbuildPath)) return config.msbuildPath;
  if (vsInfo?.installationPath) {
    const p = join(vsInfo.installationPath, "MSBuild", "Current", "Bin", "MSBuild.exe");
    if (existsSync(p)) return p;
  }
  const vswhere = vswherePath();
  if (vswhere) {
    try {
      const res = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.Component.MSBuild", "-property", "installationPath"], {
        windowsHide: true, encoding: "utf8", timeout: 30000,
      });
      const line = String(res.stdout || "").split(/\r?\n/)[0]?.trim();
      if (line) {
        const p = join(line, "MSBuild", "Current", "Bin", "MSBuild.exe");
        if (existsSync(p)) return p;
      }
    } catch {}
  }
  return null;
}

const MSVC_LINE = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)?\s*:?\s*(.*)$/;
const MSB_LINE = /^(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*)$/;

function parseEntry(line) {
  const m = MSVC_LINE.exec(line);
  if (m) {
    return {
      severity: m[4] === "error" ? "error" : "warning",
      file: m[1],
      line: m[2] ? Number(m[2]) : undefined,
      column: m[3] ? Number(m[3]) : undefined,
      code: m[5] || undefined,
      message: (m[6] || "").trim(),
    };
  }
  const mb = MSB_LINE.exec(line);
  if (mb) {
    return { severity: mb[1] === "error" ? "error" : "warning", file: undefined, code: mb[2], message: (mb[3] || "").trim() };
  }
  return null;
}

/**
 * Build a solution/project with MSBuild.
 * @returns { success, exitCode, errorCount, warningCount, errors[], warnings[], outputTail, target }
 */
export async function runMsbuild({ msbuildPath, target, configuration, platform, extraArgs = [], timeoutMs = 600000, cwd }) {
  const args = [target, "/nologo", "/v:minimal", "/m", "/nodeReuse:false"];
  if (configuration) args.push(`/p:Configuration=${configuration}`);
  if (platform) args.push(`/p:Platform=${platform}`);
  for (const a of extraArgs) args.push(a);
  const child = spawn(msbuildPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd: cwd || undefined });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString("utf8"); });
  child.stderr.on("data", (d) => { out += d.toString("utf8"); });
  const timer = setTimeout(() => {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {}
  }, timeoutMs);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  const errors = [];
  const warnings = [];
  const lines = out.split(/\r?\n/);
  for (const line of lines) {
    if (/^\d+>/.test(line)) continue; // parallel-build prefix noise
    const entry = parseEntry(line.trim());
    if (!entry) continue;
    if (entry.severity === "error") errors.push(entry); else warnings.push(entry);
  }
  const tail = lines.slice(-60).join("\n");
  return {
    success: code === 0,
    exitCode: code,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    outputTail: tail.length > 12000 ? tail.slice(-12000) : tail,
    target,
  };
}

/** Pick a build target: solution path, or the project whose directory contains the active document. */
export function pickBuildTarget(status, solutionInfo, activeDocPath) {
  const solution = status?.solution || solutionInfo?.fullName;
  if (solution) return { kind: "solution", target: solution };
  if (activeDocPath && solutionInfo?.projects?.length) {
    const dir = dirname(activeDocPath).toLowerCase();
    for (const p of solutionInfo.projects) {
      if (!p.uniqueName) continue;
      const udir = dirname(p.uniqueName).toLowerCase();
      if (dir.startsWith(udir)) return { kind: "project", target: p.uniqueName };
    }
  }
  return null;
}

export function getVsInfoFromDevenv(devenvPath) {
  if (!devenvPath) return null;
  const ide = dirname(devenvPath);              // ...\Common7\IDE
  return { installationPath: dirname(dirname(ide)) };
}
