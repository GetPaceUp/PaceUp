// Adds one plain-English line to CHANGELOG.md for a merged pull request.
// The line is the PR body's "Changelog: ..." line if there is one, otherwise the PR title.
// "Changelog: none" (or "skip") adds nothing. Dates are India time.
// Usage: node changelog.cjs <CHANGELOG.md> <event.json>   (event = the pull_request webhook payload)
const fs = require('fs');

const MARKER = '<!-- changelog:entries';

function entryText(pr) {
  const m = /^\s*changelog\s*:\s*(.+?)\s*$/im.exec(pr.body || '');
  const text = (m ? m[1] : pr.title || '').replace(/\s+/g, ' ').trim();
  if (!text || /^(none|skip|n\/a|-)\.?$/i.test(text)) return null;
  return /[.!?)]$/.test(text) ? text : text + '.';
}

function indiaDate(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(iso)).replace('Sept', 'Sep');
}

function addEntry(changelog, pr) {
  const text = entryText(pr);
  if (!text) return { changelog, added: false, reason: 'no changelog line wanted' };
  if (new RegExp(`\\(PR ${pr.number}\\)\\s*$`, 'm').test(changelog)) {
    return { changelog, added: false, reason: `PR ${pr.number} already listed` };
  }
  const line = `- ${text} (PR ${pr.number})`;
  const heading = `## ${indiaDate(pr.merged_at)}`;
  const lines = changelog.split('\n');
  const at = lines.findIndex((l) => l.startsWith(MARKER));
  if (at < 0) throw new Error('CHANGELOG.md is missing the changelog:entries marker');
  let i = at + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (lines[i] === heading) lines.splice(i + 1, 0, line);
  else lines.splice(at + 1, 0, '', heading, line);
  return { changelog: lines.join('\n'), added: true, line };
}

module.exports = { addEntry, entryText, indiaDate };

if (require.main === module) {
  const [file, eventPath] = process.argv.slice(2);
  const pr = JSON.parse(fs.readFileSync(eventPath, 'utf8')).pull_request;
  if (!pr || !pr.merged) { console.log('Not a merged pull request; nothing to do.'); process.exit(0); }
  const result = addEntry(fs.readFileSync(file, 'utf8'), pr);
  if (result.added) { fs.writeFileSync(file, result.changelog); console.log('Added:', result.line); }
  else console.log('Skipped:', result.reason);
}
