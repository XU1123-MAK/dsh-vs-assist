// dsh-vs-assist — DeepSeek Harness plugin that drives Visual Studio through
// its DTE COM automation and implements an editor-assistant loop:
// read editor context -> generate code -> apply edits -> build -> fix errors.
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeError, ensureAttached, listDevenvPids, newBridgeState, runBridge, discoverVs,
} from "./bridge.js";
import {
  discoverMsbuild, pickBuildTarget, runMsbuild, getVsInfoFromDevenv,
} from "./msbuild.js";

const name = "dsh-vs-assist";
const inject = ["tools"];

const Config = z.object({
  devenvPath: z.string().description("Path to devenv.exe; auto-detected via vswhere when omitted."),
  msbuildPath: z.string().description("Path to MSBuild.exe; defaults to <VS install>\\MSBuild\\Current\\Bin\\MSBuild.exe."),
  versionKey: z.string().default("18.0").description("VisualStudio registry version key for software rendering (18.0 = VS 2026, 17.0 = VS 2022)."),
  launchIfMissing: z.boolean().default(true).description("Launch Visual Studio when no instance is running."),
  launchTimeoutMs: z.number().default(180000).description("How long to wait for a launched VS instance to register its DTE."),
  commandTimeoutMs: z.number().default(60000).description("Timeout for one DTE bridge roundtrip."),
  buildTimeoutMs: z.number().default(600000).description("Timeout for one build."),
  contextLines: z.number().default(60).description("Lines of context returned around the caret."),
  readMaxChars: z.number().default(120000).description("Cap on document text returned by vs_context."),
  softwareRendering: z.boolean().default(false).description("Write software-rendering registry keys before launching VS (fixes a black VS window on VMs/RDP)."),
  normalizeNewlines: z.boolean().default(true).description("Normalize mixed line endings in vs_new_file content before writing (prevents the VS line-ending modal prompt)."),
});

const jsonOut = {
  schema: { type: "json" },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
};

function errorMessage(error) {
  if (error instanceof BridgeError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function sessionCwd(exec) {
  try {
    return exec.agent?.session?.header?.cwd ?? exec.agent?.options?.cwd ?? undefined;
  } catch { return undefined; }
}

function apply(ctx, config) {
  const c = {
    devenvPath: config.devenvPath,
    msbuildPath: config.msbuildPath,
    versionKey: config.versionKey ?? "18.0",
    launchIfMissing: config.launchIfMissing ?? true,
    launchTimeoutMs: config.launchTimeoutMs ?? 180000,
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
    buildTimeoutMs: config.buildTimeoutMs ?? 600000,
    contextLines: Math.max(1, config.contextLines ?? 60),
    readMaxChars: Math.max(1000, config.readMaxChars ?? 120000),
    softwareRendering: config.softwareRendering ?? false,
    normalizeNewlines: config.normalizeNewlines ?? true,
  };
  const state = newBridgeState();

  async function attach() {
    return ensureAttached(c, state);
  }

  async function bridge(action, payload) {
    return runBridge(action, payload, { timeoutMs: c.commandTimeoutMs });
  }

  const unregisters = [];

  function reg(tool) {
    unregisters.push(ctx.tools.register(defineTool(tool)));
  }

  // ---------------------------------------------------------------- vs_status
  reg({
    name: "vs_status",
    description: "Attach to the running Visual Studio instance (launching it when configured and missing) and report its state: version, open solution, active document, mode, and whether the automation UI is suppressed.",
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      return attach();
    },
  });

  // ------------------------------------------------------------- vs_instances
  reg({
    name: "vs_instances",
    description: "List devenv.exe processes and whether a Visual Studio instance is currently attached.",
    parameters: {},
    output: jsonOut,
    async execute() {
      const pids = listDevenvPids();
      let attached = null;
      try { attached = await attach(); } catch {}
      return { pids, attached };
    },
  });

  // -------------------------------------------------------------- vs_context
  reg({
    name: "vs_context",
    description: "Read the active Visual Studio editor document and its caret/selection context: file path, language, text around the caret, caret line/column/offset, selection text and offsets. Use before generating a completion or refactoring so the generated code matches the exact editor state.",
    parameters: {
      path: { type: "string", description: "Optional absolute path of a document; defaults to the active document." },
      name: { type: "string", description: "Optional document file name (e.g. Program.cs) when path is ambiguous." },
      contextLines: { type: "integer", description: "Override lines of context returned around the caret." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      const doc = await bridge("document", { path: args.path, name: args.name });
      const contextLines = args.contextLines ? Math.max(1, args.contextLines) : c.contextLines;
      const caretLine = Number(doc.caret?.line) || 1;
      const text = String(doc.text ?? "");
      const allLines = text.split(/\r\n|\r|\n/);
      const cl = Math.max(1, Math.min(caretLine, allLines.length));
      const from = Math.max(1, cl - contextLines);
      const to = Math.min(allLines.length, cl + contextLines);
      const context = [];
      for (let i = from; i <= to; i++) context.push({ line: i, text: allLines[i - 1] });
      const fullText = text.length <= c.readMaxChars ? text : undefined;
      return {
        ok: true,
        file: doc.fullName,
        name: doc.name,
        language: doc.language,
        saved: doc.saved,
        totalLines: allLines.length,
        textChars: text.length,
        truncated: text.length > c.readMaxChars,
        caret: doc.caret,
        selection: doc.selection,
        contextStart: from,
        contextEnd: to,
        context,
        ...(fullText !== undefined ? { fullText } : {}),
      };
    },
  });

  // ---------------------------------------------------------------- vs_edit
  reg({
    name: "vs_edit",
    description: "Apply a code edit inside the Visual Studio editor: mode 'insert' writes text at the caret (ghost-text completion accept); 'replace_selection' replaces the current selection; 'replace_range' replaces text between 1-based absolute offsets [startOffset, endOffset) taken from vs_context; 'replace_document' rewrites the whole file (avoid unless asked). Optionally reformats the document afterwards. Returns the new caret position.",
    parameters: {
      mode: {
        type: "string",
        enum: ["insert", "replace_selection", "replace_range", "replace_document"],
        description: "Edit mode. Defaults to insert.",
      },
      text: { type: "string", required: true, description: "The code text to write (UTF-8)." },
      path: { type: "string", description: "Optional absolute document path; defaults to the active document." },
      name: { type: "string", description: "Optional document file name when path is ambiguous." },
      startOffset: { type: "integer", description: "replace_range only: 1-based inclusive start offset." },
      endOffset: { type: "integer", description: "replace_range only: 1-based exclusive end offset." },
      format: { type: "boolean", description: "Run Edit.FormatDocument after the edit (true)." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("edit", {
        mode: args.mode,
        text: args.text,
        path: args.path,
        name: args.name,
        startOffset: args.startOffset,
        endOffset: args.endOffset,
        format: args.format === true,
      });
    },
  });

  // ------------------------------------------------------------ vs_complete
  reg({
    name: "vs_complete",
    description: "Inline completion: insert the given code at the current caret position of the active Visual Studio document. Prefer this when the user asked for a completion at the cursor.",
    parameters: {
      text: { type: "string", required: true, description: "The completion code to insert at the caret." },
      path: { type: "string", description: "Optional absolute document path; defaults to the active document." },
      format: { type: "boolean", description: "Reformat the document after insertion." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("edit", { mode: "insert", text: args.text, path: args.path, format: args.format === true });
    },
  });

  // ---------------------------------------------------------------- vs_open
  reg({
    name: "vs_open",
    description: "Open a file in Visual Studio and activate it, optionally placing the caret at line/column. A .sln or .slnx path opens as a solution instead.",
    parameters: {
      path: { type: "string", required: true, description: "Absolute path of the file to open." },
      line: { type: "integer", description: "1-based line to place the caret on." },
      column: { type: "integer", description: "1-based column to place the caret on." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("open", { path: args.path, line: args.line, column: args.column });
    },
  });

  // ------------------------------------------------------------- vs_new_file
  reg({
    name: "vs_new_file",
    description: "Create a new file on disk (directories created as needed) with the given content and open it in Visual Studio. Mixed line endings are normalized to the dominant style before writing (prevents the Visual Studio line-ending modal prompt).",
    parameters: {
      path: { type: "string", required: true, description: "Absolute path, or a path relative to the session working directory." },
      content: { type: "string", description: "Initial file content (UTF-8); defaults to empty." },
      open: { type: "boolean", description: "Open the file in Visual Studio (default true)." },
      line: { type: "integer", description: "Caret line after opening." },
      column: { type: "integer", description: "Caret column after opening." },
    },
    output: jsonOut,
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const target = isAbsolute(args.path) ? args.path : resolve(cwd || process.cwd(), args.path);
      mkdirSync(dirname(target), { recursive: true });
      let content = args.content ?? "";
      let newline = null;
      let normalized = false;
      if (c.normalizeNewlines !== false && content.includes("\n")) {
        const crlfCount = content.includes("\r\n") ? (content.match(/\r\n/g) || []).length : 0;
        const lfOnlyCount = (content.match(/(?<!\r)\n/g) || []).length;
        if (crlfCount > 0 && lfOnlyCount > 0) {
          newline = crlfCount >= lfOnlyCount ? "\r\n" : "\n";
          content = content.replace(/\r\n/g, "\n").replace(/\n/g, newline);
          normalized = true;
        } else if (crlfCount > 0) {
          newline = "\r\n";
        } else {
          newline = "\n";
        }
      }
      writeFileSync(target, content, "utf8");
      if (args.open === false) return { ok: true, created: target, opened: false, newline, normalized };
      await attach();
      const opened = await bridge("open", { path: target, line: args.line, column: args.column });
      return { ok: true, created: target, opened: true, newline, normalized, ...opened };
    },
  });

  // ---------------------------------------------------------------- vs_save
  reg({
    name: "vs_save",
    description: "Save the active Visual Studio document, a specific document, or all documents (all: true).",
    parameters: {
      all: { type: "boolean", description: "Save all open documents (File.SaveAll)." },
      path: { type: "string", description: "Absolute path of a specific document to save." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("save", { all: args.all === true, path: args.path });
    },
  });

  // --------------------------------------------------------------- vs_build
  reg({
    name: "vs_build",
    description: "Build the solution or project open in Visual Studio. Default engine 'msbuild' runs VS's MSBuild.exe and returns structured errors/warnings (file, line, column, code, message) — the reliable build-fix loop. Engine 'ide' builds inside the IDE (visible in the UI) and reports LastBuildInfo plus best-effort Error List items.",
    parameters: {
      engine: { type: "string", enum: ["msbuild", "ide"], description: "Build engine; defaults to msbuild." },
      configuration: { type: "string", description: "msbuild engine: build configuration, e.g. Debug or Release." },
      platform: { type: "string", description: "msbuild engine: build platform, e.g. x64 or Win32." },
      target: { type: "string", description: "msbuild engine: explicit .sln/.slnx/.vcxproj/.csproj path; defaults to the open solution or the project of the active document." },
      extraArgs: { type: "array", items: { type: "string" }, description: "msbuild engine: additional MSBuild switches." },
      timeoutMs: { type: "integer", description: "Build timeout in milliseconds." },
    },
    output: jsonOut,
    async execute(args, exec) {
      const status = await attach();
      if (args.engine === "ide") {
        return bridge("build_ide", {});
      }
      const sol = await bridge("solution", {}).catch(() => null);
      const picked = args.target
        ? { kind: "target", target: args.target }
        : pickBuildTarget(status, sol, status.activeDocument?.fullName);
      if (!picked?.target) {
        throw new Error("no solution or project to build: open a solution in Visual Studio or pass target");
      }
      const vsInfo = getVsInfoFromDevenv(status.fullName);
      const msbuild = c.msbuildPath ?? discoverMsbuild(c, vsInfo);
      if (!msbuild) {
        throw new Error("MSBuild.exe not found; set msbuildPath in the plugin config");
      }
      return runMsbuild({
        msbuildPath: msbuild,
        target: picked.target,
        configuration: args.configuration,
        platform: args.platform,
        extraArgs: Array.isArray(args.extraArgs) ? args.extraArgs.map(String) : [],
        timeoutMs: args.timeoutMs ?? c.buildTimeoutMs,
        cwd: dirname(picked.target),
      });
    },
  });

  // -------------------------------------------------------------- vs_errors
  reg({
    name: "vs_errors",
    description: "Read the Visual Studio Error List (build + IntelliSense items): description, file, line, column, severity level. Prefer the structured errors returned by vs_build when available; this tool is best-effort and can be empty when the IDE shell is suppressed.",
    parameters: {
      limit: { type: "integer", description: "Maximum items to return (default 100)." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("errors", { limit: args.limit ?? 100 });
    },
  });

  // ---------------------------------------------------------------- vs_run
  reg({
    name: "vs_run",
    description: "Control execution in Visual Studio: action 'start' begins debugging (F5), 'start_without_debug' runs without the debugger (Ctrl+F5), 'stop' stops the debug session. Best-effort: report the resulting IDE mode.",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "start_without_debug", "stop"], description: "Execution action." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("run", { action: args.action });
    },
  });

  // ------------------------------------------------------------ vs_solution
  reg({
    name: "vs_solution",
    description: "Describe the solution open in Visual Studio: full path and the list of projects (name, unique name, kind).",
    parameters: {},
    output: jsonOut,
    async execute(_args, exec) {
      await attach();
      return bridge("solution", {});
    },
  });

  // ------------------------------------------------------- vs_open_solution
  reg({
    name: "vs_open_solution",
    description: "Open a solution (.sln / .slnx) in Visual Studio. Use when the IDE has no solution loaded and the user wants a build/run loop on a project.",
    parameters: {
      path: { type: "string", required: true, description: "Absolute path of the .sln or .slnx file to open." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("open_solution", { path: args.path });
    },
  });

  // ------------------------------------------------------------- vs_command
  reg({
    name: "vs_command",
    description: "Execute one allowlisted Visual Studio editor command: FormatDocument, FormatSelection, CommentSelection, UncommentSelection, Undo, Redo, GoToDefinition, GoToDeclaration, FindAllReferences, SelectAll, Copy, Cut, Paste, ToggleBookmark, NextBookmark, PreviousBookmark, ExpandAllOutlining, CollapseAllOutlining, View.ErrorList, View.Output, View.SolutionExplorer, File.SaveAll, File.Close.",
    parameters: {
      name: { type: "string", required: true, description: "Exact command name from the allowlist." },
    },
    output: jsonOut,
    async execute(args, exec) {
      await attach();
      return bridge("exec_command", { name: args.name });
    },
  });

  // --------------------------------------------------------------- skill
  const SKILL_NAME = "vs-assist";
  const SKILL_DESC = "Drive the user's Visual Studio as a pair programmer: read the active editor context, insert or replace code in VS, build, read errors, and run — through the vs_* tools injected by this plugin.";
  const SKILL_BASE = new URL("../skill/", import.meta.url);
  const SKILL_MARKDOWN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../skill/vs-assist.md"), "utf8");

  function registerSkillOn(targetCtx) {
    const skills = targetCtx.get("skills");
    if (skills == null || typeof skills.register !== "function") return () => {};
    try {
      return skills.register({
        name: SKILL_NAME,
        description: SKILL_DESC,
        content: SKILL_MARKDOWN,
        source: "bundled",
        resourceBase: { kind: "directory", path: fileURLToPath(SKILL_BASE) },
      });
    } catch { return () => {}; }
  }

  unregisters.push(registerSkillOn(ctx));
  const agentSkillUnregisters = new Map();
  let skillActive = true;
  const registerForAgent = (agent) => {
    if (!skillActive || agentSkillUnregisters.has(agent)) return;
    try {
      agentSkillUnregisters.set(agent, registerSkillOn(agent.ctx));
    } catch {}
  };
  let stopCreated = () => {};
  let stopDisposed = () => {};
  if (typeof ctx.on === "function") {
    stopCreated = ctx.on("agent/created", ({ agent }) => registerForAgent(agent));
    stopDisposed = ctx.on("agent/disposed", ({ agent }) => {
      const un = agentSkillUnregisters.get(agent);
      if (typeof un === "function") un();
      agentSkillUnregisters.delete(agent);
    });
  }
  const agents = ctx.get("agents");
  if (agents != null && typeof agents.list === "function") {
    for (const agent of agents.list()) registerForAgent(agent);
  }

  // probe once at load
  (async () => {
    try {
      const pids = listDevenvPids();
      const vs = c.devenvPath ? { productPath: c.devenvPath } : discoverVs();
      const msbuild = c.msbuildPath ?? discoverMsbuild(c, vs ? getVsInfoFromDevenv(vs.productPath) : null);
      console.log(`[${name}] loaded: devenv=${vs?.productPath ?? "not found"} (${pids.length} running), msbuild=${msbuild ?? "not found"}`);
    } catch (error) {
      console.warn(`[${name}] probe failed: ${errorMessage(error)}`);
    }
  })();

  ctx.effect(() => () => {
    skillActive = false;
    stopDisposed();
    stopCreated();
    for (const un of [...agentSkillUnregisters.values()].reverse()) {
      if (typeof un === "function") un();
    }
    agentSkillUnregisters.clear();
    for (const un of unregisters.reverse()) {
      if (typeof un === "function") un();
    }
    unregisters.length = 0;
  });
}

export { Config, apply, inject, name };
