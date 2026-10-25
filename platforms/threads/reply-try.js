/**
 * Dry run for comment replies: calls the AI only, never Threads. Use it to tune the persona in reply.js.
 *
 *   npm run threads:reply:try -- "打卡"
 *
 * Several messages form a thread, oldest first, taking turns: them, you (Big Ben), them…
 * The last one is the comment to answer. Quote each message, or the shell splits it:
 *
 *   npm run threads:reply:try -- "你这钟准吗" "我走得比你上班还准时" "好吧"
 *
 * To add the original post, set REPLY_POST (like in production, it doesn't count toward contextMessages):
 *
 *   REPLY_POST="咣！咣！咣！现在是 15 点整" npm run threads:reply:try -- "准吗"
 */
import { compose, contextMax } from './reply.js';

const said = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (!said.length) {
  console.error('Usage: npm run threads:reply:try -- "their message"');
  console.error('       npm run threads:reply:try -- "earlier…" "your reply…" "their new message"');
  process.exit(1);
}

const text = said[said.length - 1];
// Count backwards: the message just before is ours, the one before that is theirs, and so on
const prior = said.slice(0, -1).map((t, i) => ({
  text: t,
  mine: (said.length - 1 - i) % 2 === 1,
  username: 'passerby',
}));
// Production keeps only contextMax messages, so cut the same here.
// contextMax 0 needs its own check: slice(-0) is slice(0), which keeps everything
const post = String(process.env.REPLY_POST || '').trim();
const context = contextMax
  ? [...(post ? [{ text: post, mine: true, root: true }] : []), ...prior.slice(-contextMax)]
  : [];

try {
  const { text: out, via, skip } = await compose({ id: 'dry-run', username: 'passerby', text, context });

  console.log('');
  for (const c of context) console.log(`${c.root ? 'post   ' : c.mine ? 'Big Ben' : 'them   '}: ${c.text}`);
  console.log(`them   : ${text}`);
  console.log(skip ? `Big Ben (${via}): — (no reply)\n` : `Big Ben (${via}): ${out}\n`);
} catch (err) {
  console.error(`\n✗ No reply composed: ${err.message}\n`);
  process.exit(1);
}
