/**
 * Type declarations for `dsh-vs-assist`.
 *
 * This plugin registers 14 `vs_*` tools against the Cordis tool registry and
 * installs a bundled `vs-assist` skill. The declarations below cover only the
 * plugin's own public exports; the tool schemas the model sees are generated
 * from `lib/index.js` at registration time.
 *
 * Note: the plugin drives Visual Studio on Windows only, and requires a local
 * Visual Studio installation to drive.
 */

/** Cordis plugin name used by loader diagnostics. */
export declare const name: "dsh-vs-assist";

/** Services required before the plugin activates. */
export declare const inject: readonly ["tools"];

/**
 * Resolved plugin configuration.
 *
 * Every field is optional at the call site; the defaults listed here are what
 * the plugin applies when a field is omitted.
 */
export interface VsAssistConfig {
  /** Path to `devenv.exe`. Auto-detected via `vswhere` when omitted. */
  devenvPath?: string;
  /**
   * Path to `MSBuild.exe`.
   * Defaults to `<VS install>\MSBuild\Current\Bin\MSBuild.exe`.
   */
  msbuildPath?: string;
  /**
   * Visual Studio registry version key used when writing software-rendering
   * keys (`18.0` = VS 2026, `17.0` = VS 2022, `16.0` = VS 2019).
   * @default "18.0"
   */
  versionKey?: string;
  /**
   * Launch Visual Studio when no instance is currently running.
   * @default true
   */
  launchIfMissing?: boolean;
  /**
   * How long to wait for a launched Visual Studio instance to register its
   * DTE automation object.
   * @default 180000
   */
  launchTimeoutMs?: number;
  /**
   * Timeout for one DTE bridge roundtrip.
   * @default 60000
   */
  commandTimeoutMs?: number;
  /**
   * Timeout for one build.
   * @default 600000
   */
  buildTimeoutMs?: number;
  /**
   * Lines of source context returned around the caret by `vs_context`.
   * @default 60
   */
  contextLines?: number;
  /**
   * Cap on the number of characters of full document text returned by
   * `vs_context`. Beyond this the `fullText` field is omitted.
   * @default 120000
   */
  readMaxChars?: number;
  /**
   * Write WPF software-rendering registry keys before launching Visual Studio.
   * This fixes a black Visual Studio window on virtual machines and RDP
   * sessions where hardware acceleration is unavailable.
   * @default false
   */
  softwareRendering?: boolean;
  /**
   * Normalize mixed line endings in `vs_new_file` content before writing.
   * A CRLF/LF mix makes Visual Studio raise a modal prompt that blocks further
   * automation, so leaving this enabled is strongly recommended.
   * @default true
   */
  normalizeNewlines?: boolean;
}

/** Config schema object (a Schemastery schema) validated by Cordis at load. */
export declare const Config: unknown;

/**
 * Plugin entry point. Called by the Cordis loader with the host context and
 * the validated configuration.
 *
 * Registers the `vs_*` tools and (when the `skills` service is mounted) the
 * bundled `vs-assist` skill.
 */
export declare function apply(
  ctx: unknown,
  config?: VsAssistConfig,
): void;
