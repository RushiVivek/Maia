/** Minimal, phone-friendly HTML shell. No external assets. */

import { escapeHtml } from "./escape.ts";

export function htmlShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; max-width: 50rem; margin-inline: auto; }
h1 { font-size: 1.2rem; word-break: break-all; }
a { color: inherit; }
ul { list-style: none; padding: 0; margin: 0; }
li { padding: .55rem .25rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); display: flex; gap: .5rem; align-items: center; }
li .name { flex: 1; min-width: 0; word-break: break-all; }
li .meta { opacity: .6; font-size: .85rem; white-space: nowrap; }
.crumbs { opacity: .7; font-size: .9rem; margin-bottom: .5rem; word-break: break-all; }
.dir::before { content: "📁 "; }
.file::before { content: "📄 "; }
button { font: inherit; padding: .2rem .5rem; cursor: pointer; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
