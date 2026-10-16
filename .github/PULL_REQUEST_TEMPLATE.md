# Summary

<!-- What does this change, and why? -->

## Type of change

- [ ] Bug fix
- [ ] New tool
- [ ] Change to an existing tool
- [ ] Documentation
- [ ] CI / tooling

## Checklist

- [ ] JavaScript syntax passes (`node --check lib/*.js`)
- [ ] `lib/vs-dte.ps1` still parses and remains **pure ASCII**
- [ ] The bridge keeps its fail-closed `default` branch (if edited)
- [ ] `lib/bridge.js` still passes `-STA` (if edited)
- [ ] No `@deepseek-ai/*` package was moved out of `peerDependencies`
- [ ] Package name, description, and keywords still avoid the Copilot mark
- [ ] `npm pack --dry-run` looks correct
- [ ] README updated (tool table, if a tool was added or changed)
- [ ] `skill/vs-assist.md` updated, if the recommended workflow changed

## Testing

<!--
How did you verify this? If you exercised it against a real Visual Studio,
say which version and what you ran.
-->

- Visual Studio version:
- Commands run:
- Result:

## Related issues

<!-- e.g. Fixes #12 -->
