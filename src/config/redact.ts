export function redactSecret(value: string | undefined): string {
  return value ? "<redacted>" : "<unset>";
}

export function redactUrl(value: unknown): string {
  try {
    const parsed = new URL(String(value));
    if (parsed.username) parsed.username = "redacted";
    if (parsed.password) parsed.password = "redacted";
    for (const name of new Set(parsed.searchParams.keys())) parsed.searchParams.set(name, "redacted");
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return "<invalid-url>";
  }
}
