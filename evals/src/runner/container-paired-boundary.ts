interface FreshBoundaryCommandOptions {
  readonly suiteId: string;
  readonly expectedHome?: string;
  readonly expectedTmpDir?: string;
  readonly skillRoot?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * @notice Generates a zero-paid test command that checks fresh guest isolation.
 * @param options Expected arm identity and paths for the boundary assertions.
 * @returns Shell command consumed by the paired integration-test child.
 */
export function buildFreshBoundaryCommand(options: FreshBoundaryCommandOptions): string {
  const expectedHome = shellQuote(options.expectedHome ?? "/home/agent");
  const expectedTmpDir = shellQuote(options.expectedTmpDir ?? "/tmp");
  const skill = shellQuote(`${options.skillRoot ?? "/opt/skills"}/${options.suiteId}/SKILL.md`);
  return [
    `if ! { test "$HOME" = ${expectedHome} && test "$TMPDIR" = ${expectedTmpDir}; }; then exit 41; fi`,
    'if ! { test ! -e "$HOME/.paired-fresh" && test ! -e "$TMPDIR/paired-fresh" && test ! -e oracle.json && test ! -e validator.ts && test ! -e fresh-state.txt; }; then exit 42; fi',
    'if ! { : > "$HOME/.paired-fresh" && : > "$TMPDIR/paired-fresh" && : > fresh-state.txt; }; then exit 43; fi',
    `if test -f ${skill}; then printf treatment > nested-result.tmp || exit 44; else printf baseline > nested-result.tmp || exit 44; fi`,
    "printf 'agent-boundary-fresh\\n' || exit 45",
    'printf \'%s\\n\' "$GEMINI_API_KEY" || exit 46',
    'printf %s "$GEMINI_API_KEY" | base64 || exit 47',
    'sleep 120 >/dev/null 2>&1 &',
  ].join("; ");
}
