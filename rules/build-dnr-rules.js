#!/usr/bin/env node
/**
 * Compiles rules/domains-source.txt into rules/generated/dnr-rules.json.
 * Domain-only blocking, main_frame never blocked, sub_frame included
 * (ad iframes). Plain Node, no deps. Run: node rules/build-dnr-rules.js
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, 'domains-source.txt');
const OUTPUT_PATH = path.join(__dirname, 'generated', 'dnr-rules.json');

// Conservative ceiling - well under Chrome's default 30,000-per-ruleset
// static rule limit, and comfortably inside Firefox's historically lower
// limits too. Fails loudly if the source list ever grows unexpectedly.
const MAX_RULES = 5000;

// Every resource type EXCEPT main_frame - never block a page the user
// directly navigated to. sub_frame is included on purpose (ad iframes).
const RESOURCE_TYPES = [
  'sub_frame',
  'script',
  'image',
  'xmlhttprequest',
  'media',
  'font',
  'stylesheet',
  'websocket',
  'ping',
  'other'
];

function readDomains(sourcePath) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const seen = new Set();
  const domains = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Guard against accidentally-pasted paths/URLs - this pipeline only
    // supports bare registrable domains (see plan.md scope limits).
    if (/[\/\s]/.test(line)) {
      throw new Error(
        `Invalid entry in domains-source.txt (contains "/" or whitespace): "${line}". ` +
        `Only bare domains are supported (e.g. "doubleclick.net").`
      );
    }

    const domain = line.toLowerCase();
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }

  return domains;
}

function buildRules(domains) {
  return domains.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: 'block' },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: RESOURCE_TYPES
    }
  }));
}

function main() {
  const domains = readDomains(SOURCE_PATH);

  if (domains.length === 0) {
    throw new Error('No domains found in domains-source.txt - refusing to write an empty ruleset.');
  }
  if (domains.length > MAX_RULES) {
    throw new Error(
      `Domain list has grown to ${domains.length} entries, above the safety ceiling of ${MAX_RULES}. ` +
      `Raise MAX_RULES deliberately if this is intentional, after checking platform DNR limits.`
    );
  }

  const rules = buildRules(domains);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(rules, null, 2) + '\n', 'utf8');

  console.log(`Built ${rules.length} DNR rules from ${domains.length} domains.`);
  console.log(`Output: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main();
