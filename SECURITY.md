# Security

glint is a fork of [prismantis](https://github.com/NahumLitvin/prismantis) 0.6.0 (MIT), synced with 0.6.1.

## Audit, 2026-10-05

- The prismantis 0.6.0 installed from its marketplace matched the `v0.6.0` tag file for file.
- `hooks/vendor/prism.js` and `hooks/vendor/mermaid-text.js` rebuild byte for byte from prismjs 1.30.0 and
  beautiful-mermaid 1.1.3 (both MIT), pinned with integrity hashes in `scripts/package-lock.json`.
- The vendored code has no network, `eval`, `new Function` or dynamic import. Its `postMessage` is Prism's
  web-worker path, which never runs here, and `globalThis.process` is a color-support check.
- prismantis itself reaches: drawing, the clipboard (copy buttons), toasts, its own theme setting, and the
  terminal's name from the environment. No network, files, processes or model calls.

## What glint adds

- `$.process.run(['open', url])` for an `http(s)` URL, and `open -R` (reveal in Finder, never launch) for a
  file, when a link is clicked. Any other scheme is refused: the target comes from a reply.
- A note added to each prompt you type (≈170 tokens) saying how replies render. Turn it off with the
  `diagramHints` setting.

## Checking it yourself

```sh
scripts/verify.sh
```

Rebuilds the vendor bundles and compares their hashes, checks the engine calls the module makes against an
allow-list, and searches the hand-written code for network access and string evaluation.
