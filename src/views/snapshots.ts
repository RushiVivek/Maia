/** Snapshot list page (GET /). */

import type { Snapshot } from "../types.ts";
import { htmlShell } from "./layout.ts";
import { escapeAttr, escapeHtml } from "./escape.ts";

export function renderSnapshotList(snapshots: Snapshot[], tokenQuery: string): string {
  // Newest first for display (atlas stores newest-last).
  const items = [...snapshots].reverse().map((s) => {
    const href = `/${encodeURIComponent(s.id)}/${tokenQuery}`;
    return `<li class="dir">
<a class="name" href="${escapeAttr(href)}">${escapeHtml(s.name)}</a>
<span class="meta">${escapeHtml(s.created)}</span>
</li>`;
  }).join("\n");

  const body = `<h1>maia — snapshots</h1>
${snapshots.length === 0 ? "<p>No snapshots in this vault.</p>" : `<ul>\n${items}\n</ul>`}`;
  return htmlShell("maia — snapshots", body);
}
