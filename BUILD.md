# Build instructions

AdVeil ships with its one generated file already checked into the source (`rules/generated/dnr-rules.json`), so no build step is required to load or review the extension as submitted. These are the exact steps to reproduce that file from source.

## What is generated

Only `rules/generated/dnr-rules.json` - the declarativeNetRequest ad/tracker-blocking ruleset. It is generated from the human-edited plain text file `rules/domains-source.txt` by the script `rules/build-dnr-rules.js`.

No other file in this extension is generated, minified, bundled, transpiled, or otherwise machine-processed. Every `.js`, `.html`, and `.css` file, and `manifest.json`, is submitted exactly as hand-authored.

## Requirements

- **Node.js 18 or later.** Any OS (Linux, macOS, Windows) - the script has no OS-specific behavior.
- **No other software, package, or npm dependency is required.** The build script uses only Node's built-in `fs` and `path` modules.
- Install Node.js: https://nodejs.org/en/download (or any standard package manager, e.g. `apt install nodejs`, `brew install node`).
- Verify: `node --version` should print v18.0.0 or higher.

## Steps to reproduce `rules/generated/dnr-rules.json` exactly

1. Obtain the source (this zip, or `git clone https://github.com/achintha-ekanayake/AdVeil`).
2. From the project root, run:
   ```sh
   node rules/build-dnr-rules.js
   ```
   (equivalently, `npm run build` - defined in `package.json`, same command)
3. This reads `rules/domains-source.txt`, deduplicates and validates each domain, and writes `rules/generated/dnr-rules.json`.
4. The output is deterministic - running it again against an unchanged `rules/domains-source.txt` produces byte-for-byte identical output.

## Loading the result

Load the project root as an unpacked extension:
- **Firefox**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json`.
- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → select the project root.
