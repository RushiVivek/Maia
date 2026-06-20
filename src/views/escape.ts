/** HTML escaping for untrusted text (file/snapshot names from the vault). */

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escape for use inside a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return escapeHtml(s);
}
