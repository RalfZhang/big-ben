/**
 * 干跑「评论区自动回复」：只调 AI，不碰 Threads。用来调 reply.js 的人格提示词。
 *
 *   npm run threads:reply:try -- "打卡"
 *
 * 给多句就当成一条评论串，从早到晚、你我交替，最后一句是这次要回的那条：
 *
 *   npm run threads:reply:try -- "你这钟准吗" "我走得比你上班还准时" "好吧"
 *                                 └ 对方        └ 你（大笨钟）        └ 对方这次说的
 *
 * 每句话记得各自带引号，否则会被 shell 拆成好几句。
 */
import { compose, contextMax } from './reply.js';

const said = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (!said.length) {
  console.error('用法：npm run threads:reply:try -- "对方说的那句话"');
  console.error('　　　npm run threads:reply:try -- "上文…" "你回的…" "对方这次说的"');
  process.exit(1);
}

const text = said[said.length - 1];
// 倒着数：紧挨着这条的是自己说的，再往前是对方，如此交替
const prior = said.slice(0, -1).map((t, i) => ({
  text: t,
  mine: (said.length - 1 - i) % 2 === 1,
  username: '路人甲',
}));
// 线上只回溯 contextMax 条，这里也截一样多，不然干跑出来的不是真实效果。
// contextMax 为 0 要单独挡：slice(-0) 是 slice(0)，会把整份原样返回
const context = contextMax ? prior.slice(-contextMax) : [];

try {
  const { text: out, via, skip } = await compose({ id: 'dry-run', username: '路人甲', text, context });

  console.log('');
  for (const c of context) console.log(`${c.mine ? '大笨钟' : '对方　'}：${c.text}`);
  console.log(`对方　：${text}`);
  console.log(skip ? `大笨钟（${via}）：——（不回）\n` : `大笨钟（${via}）：${out}\n`);
} catch (err) {
  console.error(`\n✗ 编不出来：${err.message}\n`);
  process.exit(1);
}
