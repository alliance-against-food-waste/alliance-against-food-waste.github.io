// Adds the person from an approved "New member" issue to members.json.
// Run by .github/workflows/add-member.yml via actions/github-script.
//
// The issue body is untrusted input: it is only ever read here, from the event
// payload, never interpolated into a shell command or a workflow expression.
// members.json is written through the contents API, so there is no git in the
// loop either; the commit message is plain data to the API.

const PATH = 'members.json';
const SITE = 'https://alliance-against-food-waste.github.io/#members';

// Must match the pledge on the website (index.html, input[name="vow"] values).
const REQUIRED = [
  'I eat up.',
  'I take only what I will finish.',
  'I honour the Fruit Basket Protocol.',
  'I carry every fruit basket I meet to the table.',
];
const BONUS = 'I arrange fruit in ways that afford eating.';
const HEROIC = 'I will finish the last slice of cake at events, for the alliance.';

// Letters (any script), digits, spaces, apostrophes, dots and hyphens; must
// start with a letter or digit; 60 characters at most.
const NAME_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'’-]{0,59}$/u;

// Same FNV-1a hash as memberNo() in index.html, so the number on the website
// matches the one on the member's card.
function memberNo(name) {
  let h = 2166136261;
  const s = name.toLowerCase();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'AAFW-' + String((h >>> 0) % 100000).padStart(5, '0');
}

// Issue forms render as "### Label\n\nvalue" blocks.
function parseForm(body) {
  const out = {};
  for (const block of body.replace(/\r\n/g, '\n').split(/^### /m).slice(1)) {
    const nl = block.indexOf('\n');
    const label = (nl < 0 ? block : block.slice(0, nl)).trim();
    const value = nl < 0 ? '' : block.slice(nl + 1).trim();
    out[label] = value === '_No response_' ? '' : value;
  }
  return out;
}

function cleanName(raw) {
  return (raw || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const issue = context.payload.issue;
  const issue_number = issue.number;

  const comment = (body) => github.rest.issues.createComment({ owner, repo, issue_number, body });
  // On a problem, take the label off again so a founder can simply re-apply
  // it once the issue has been fixed.
  const reject = async (why) => {
    await comment(`🍂 I could not add this member yet: ${why}\n\nEdit the issue and a founding member can add the \`approved\` label again.`);
    await github.rest.issues.removeLabel({ owner, repo, issue_number, name: 'approved' }).catch(() => {});
    core.notice(`Not added: ${why}`);
  };

  const form = parseForm(issue.body || '');
  const name = cleanName(form['Name']);
  if (!name) return reject('there is no name in a **Name** field. Was the issue opened with the "New member" form?');
  if (!NAME_RE.test(name)) {
    return reject('the name may only contain letters, digits, spaces, apostrophes, dots and hyphens (60 characters at most).');
  }

  const ticked = (form['Commitments'] || '')
    .split('\n')
    .map((l) => l.match(/^\s*[-*]\s*\[[xX]\]\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
  const missing = REQUIRED.filter((v) => !ticked.includes(v));
  if (missing.length) {
    return reject(`these required commitments are not ticked:\n${missing.map((v) => `- ${v}`).join('\n')}`);
  }

  const { data: file } = await github.rest.repos.getContent({ owner, repo, path: PATH, ref: context.payload.repository.default_branch });
  const members = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

  const existing = members.find((m) => m.issue === issue_number || m.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    await comment(`🍽️ **${existing.name}** is already on the [list of members](${SITE}). Nothing to do.`);
    await github.rest.issues.update({ owner, repo, issue_number, state: 'closed', state_reason: 'not_planned' });
    return;
  }

  const entry = {
    name,
    no: memberNo(name),
    joined: new Date().toISOString().slice(0, 10),
    issue: issue_number,
  };
  if (ticked.includes(BONUS)) entry.bonus = true;
  if (ticked.includes(HEROIC)) entry.heroic = true;
  members.push(entry);

  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: PATH,
    sha: file.sha,
    branch: context.payload.repository.default_branch,
    message: `Add member: ${name} (#${issue_number})`,
    content: Buffer.from(JSON.stringify(members, null, 2) + '\n', 'utf8').toString('base64'),
  });

  // Commits made with the workflow's own token may not start a Pages build on
  // their own, so ask for one explicitly. Not fatal if it fails: the next push
  // publishes the member anyway.
  await github.request('POST /repos/{owner}/{repo}/pages/builds', { owner, repo })
    .catch((e) => core.warning(`Could not request a Pages build: ${e.message}`));

  await comment(
    `🍎 Welcome to the alliance, **${name}**!\n\n` +
    `You are member **No. ${entry.no}**${entry.heroic ? ', and a volunteer for the last slice of cake 🍰' : ''}. ` +
    `You will appear on the [list of members](${SITE}) within a minute or two.\n\n_We eat up._`
  );
  await github.rest.issues.update({ owner, repo, issue_number, state: 'closed', state_reason: 'completed' });
};
