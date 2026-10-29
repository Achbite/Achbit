type ShellOption = { value: string; label: string };

/** The automatic choice is named by the Host's observed result, without changing the saved preference. */
export function windowsShellOptions(
  options: readonly ShellOption[],
  preference: string,
  environment: Record<string, unknown> | null,
): readonly ShellOption[] {
  const configuration = environment?.configuration as { windowsShell?: string } | undefined;
  const shell = environment?.shell as { dialect?: string } | undefined;
  if (preference !== 'auto' || environment?.os !== 'windows'
    || environment.shellAvailable !== true || configuration?.windowsShell !== 'auto') return options;
  const resolved = options.find(option => option.value === shell?.dialect);
  if (!resolved) return options;
  return options.filter(option => option.value !== resolved.value)
    .map(option => option.value === 'auto' ? { ...option, label: resolved.label } : option);
}
