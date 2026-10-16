# Contributing to dsh-vs-assist

Thanks for taking the time to contribute. This is a small, focused plugin, and
the notes below are mostly about the parts that are easy to get subtly wrong.

## Before you start

This plugin only works on **Windows** with a local Visual Studio installation,
because it drives the IDE through the `EnvDTE` COM automation interface. You do
not need Visual Studio to work on the JavaScript side, but you do need it to
exercise anything end to end.

Host packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/schemastery`) are **peer dependencies**. They are deliberately not
installed in this repository: the DSH loader injects them at runtime. As a
result `lib/index.js` cannot be imported with a plain `node` command from a
checkout — see [Testing](#testing) for what you can run instead.

## Ways to contribute

- **Bug reports** — please include your Visual Studio version (`vs_status`
  reports it), the exact tool call, and the raw result.
- **New tools** — small additions that fit the existing `vs_*` naming.
- **Fixes for IDE quirks** — Visual Studio's automation surface has sharp edges,
  and documented workarounds are genuinely valuable here.
- **Documentation** — especially setup problems on VMs and remote desktop.

## Development setup

```powershell
git clone https://github.com/XU1123-MAK/dsh-vs-assist.git
cd dsh-vs-assist

# Install into a DSH profile so you can exercise it for real
cd $env:DSH_HOME\profiles\desktop
& $env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs add "dsh-vs-assist@file:C:\path\to\dsh-vs-assist"
```

Then add the mount entry to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: vs-assist
      name: dsh-vs-assist
      config:
        launchIfMissing: true
```

Restart DSH (or toggle the plugin) and the `vs_*` tools appear in a session.

## Testing

There is no unit test suite yet. What you can run locally:

```powershell
# 1. JavaScript syntax
node --check lib/index.js
node --check lib/bridge.js
node --check lib/msbuild.js

# 2. PowerShell bridge syntax
$e = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  "lib/vs-dte.ps1", [ref]$null, [ref]$e)
$e.Count   # must be 0

# 3. The wrapper modules have no peer dependencies, so they import directly
node -e "import('./lib/bridge.js').then(m => console.log(Object.keys(m)))"
node -e "import('./lib/msbuild.js').then(m => console.log(Object.keys(m)))"

# 4. Package contents
npm pack --dry-run
```

CI runs all of the above plus the structural checks described below, on every
push and pull request.

For end-to-end verification, drive the tools from a live DSH session against a
throwaway solution and confirm the full loop: `vs_status` → `vs_context` →
`vs_edit` → `vs_save` → `vs_build` → fix errors → rebuild.

## Things that will bite you

These are enforced in CI because each one cost real debugging time. Please keep
them intact when editing.

### The PowerShell bridge must stay pure ASCII

`lib/vs-dte.ps1` is read by Windows PowerShell 5.1, which decodes `.ps1` files
using the system ANSI code page rather than UTF-8. Any non-ASCII byte is
misinterpreted at runtime. Keep identifiers, comments, and strings ASCII-only;
if you need Unicode data, pass it through the JSON payload instead.

### The bridge must keep its fail-closed default branch

Actions are dispatched by string name, so a typo on either side would otherwise
fail silently. The `default` branch must reject unknown actions.

### `lib/bridge.js` must pass `-STA`

`EnvDTE` requires a single-threaded apartment. Without `-STA`, every COM call
fails in ways that look like unrelated problems.

### Line endings matter more than usual here

A file containing mixed CRLF and LF makes Visual Studio raise a modal prompt
that blocks all further automation until a human dismisses it.
`.gitattributes` normalizes the repository to LF for this reason; please do not
remove it. `vs_new_file` normalizes mixed endings on write, and `vs_edit`
reports mixed endings through `lineEnding` / `lineEndingWarning`.

### Keep `@deepseek-ai/*` packages as peer dependencies

Never move them into `dependencies`. Bundling them would redistribute host code
and would also break loading, since the DSH loader supplies its own copies.

### Do not use the Copilot mark

The package name, description, and keywords must not contain "Copilot". CI
enforces this. The plugin is unaffiliated with GitHub, Inc. and Microsoft
Corporation, and does not contain or call GitHub Copilot code or services — see
[NOTICE](NOTICE). Descriptive references inside the disclaimer text itself are
fine and intended.

## Adding a tool

1. Add the action to `lib/vs-dte.ps1` in the `switch ($Action)` block. Return
   exactly one JSON line via `Out-JsonLine`, and call `Fail "..."` for errors.
2. Add a thin wrapper in `lib/index.js` using `reg({ ... })` with a
   `defineTool` definition: `name`, `description`, `parameters`, `output`, and
   an `execute` that awaits `attach()` then calls `bridge(action, payload)`.
3. Prefer the `jsonOut` output shape used by the existing tools for consistency.
4. Update the tool table in `README.md`.
5. If the tool changes the recommended workflow, update
   `skill/vs-assist.md` too.

Naming: tools are `vs_<verb>`; bridge actions are `<verb>` in snake_case.

## Pull requests

- Keep changes focused; one topic per pull request.
- Describe what you tested and on which Visual Studio version.
- Make sure CI passes.
- If you fix an IDE quirk, explain the symptom in the commit message so the next
  person recognizes it.

## Reporting security issues

Please do not open a public issue for a security problem. Contact the
maintainer directly through GitHub instead.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
