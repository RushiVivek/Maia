/** Directory listing page for a snapshot subtree. */

import type { Snapshot } from "../types.ts";
import type { DirChild } from "../tree.ts";
import { isVideo } from "../mime.ts";
import { htmlShell } from "./layout.ts";
import { escapeAttr, escapeHtml } from "./escape.ts";

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * @param snap     the snapshot
 * @param dir      current directory prefix ("" = root, else "a/b/")
 * @param children immediate children of `dir`
 * @param tokenQuery "?token=..." (or "") to preserve auth in links/copy-URL
 * @param origin   absolute origin (e.g. https://maia.deno.dev) for copy-URL
 */
export function renderListing(
  snap: Snapshot,
  dir: string,
  children: DirChild[],
  tokenQuery: string,
  origin: string,
): string {
  const segId = encodeURIComponent(snap.id);

  // Build a link to a child path within this snapshot.
  const linkTo = (relPath: string): string => {
    const enc = relPath.split("/").map(encodeURIComponent).join("/");
    return `/${segId}/${enc}${tokenQuery}`;
  };

  const rows = children.map((c) => {
    if (c.isDir) {
      const childPrefix = dir + c.name; // dir ends with "/" or is ""
      return `<li class="dir">
<a class="name" href="${escapeAttr(linkTo(childPrefix))}">${escapeHtml(c.name)}/</a>
</li>`;
    }
    const href = linkTo(c.path!);
    const size = c.size !== undefined ? `<span class="meta">${humanSize(c.size)}</span>` : "";
    let action = "";
    if (isVideo(c.path!)) {
      // Absolute, token-bearing URL for VLC; copied via a tiny inline handler.
      const abs = origin + linkTo(c.path!);
      action = `<button type="button" data-url="${
        escapeAttr(abs)
      }" onclick="copyUrl(this)">copy URL</button>`;
    }
    return `<li class="file">
<a class="name" href="${escapeAttr(href)}">${escapeHtml(c.name)}</a>
${size}
${action}
</li>`;
  }).join("\n");

  const crumbs = `<div class="crumbs">${escapeHtml(snap.name)} / ${escapeHtml(dir || "")}</div>`;

  const body = `<h1>${escapeHtml(snap.name)}</h1>
${crumbs}
<p>${upLink(snap, dir, tokenQuery)}</p>
${children.length === 0 ? "<p>(empty)</p>" : `<ul>\n${rows}\n</ul>`}
<script>
function copyUrl(btn){
  const u = btn.getAttribute('data-url');
  navigator.clipboard.writeText(u).then(()=>{const t=btn.textContent;btn.textContent='copied!';setTimeout(()=>btn.textContent=t,1200);});
}
</script>`;
  return htmlShell(`maia — ${snap.name}`, body);
}

function upLink(snap: Snapshot, dir: string, tokenQuery: string): string {
  const segId = encodeURIComponent(snap.id);
  if (dir === "") {
    return `<a href="${escapeAttr("/" + tokenQuery)}">← snapshots</a>`;
  }
  const parent = dir.replace(/[^/]+\/$/, ""); // strip last segment
  const enc = parent.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const href = `/${segId}/${enc ? enc + "/" : ""}${tokenQuery}`;
  return `<a href="${escapeAttr(href)}">← up</a>`;
}
