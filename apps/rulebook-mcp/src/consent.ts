// The consent page (D47), following the OAuth library's guide (docs/consent-page.md): it shows
// the client's name, the scope, where the tokens will go, a warning for apps on this computer,
// and asks the person to sign in with their Lexguard API key. Everything that came from the
// client (name, domain, redirect host, scopes) is escaped: an attacker chooses those values.
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);

export const SCOPE_TEXT: Readonly<Record<string, string>> = {
  "rules:read": "Read the rulebook (GDPR articles and the NDA playbook). No document access.",
};

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin =
    details.clientDomain !== undefined && details.clientDomain !== ""
      ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
      : "This app registered itself; its name is not verified.";
  const scopes = details.scope
    .map(
      (s) =>
        `<li><code>${escapeHtml(s)}</code>: ${escapeHtml(SCOPE_TEXT[s] ?? "Unknown scope.")}</li>`,
    )
    .join("");
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize ${name}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}input{width:100%;padding:.4rem;font:inherit}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}</style>
</head><body>
<h1>Allow ${name} to use the Lexguard rulebook?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>It asks for:</p><ul>${scopes}</ul>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><label>Your Lexguard API key<br><input type="password" name="api_key" autocomplete="off" required></label></p>
  <p><button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>
</body></html>`;
}

export function messagePage(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Lexguard rulebook</title><p>${escapeHtml(message)}</p>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
