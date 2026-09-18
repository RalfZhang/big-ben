/**
 * 干跑「评论区自动回复」：只调 AI，不碰 Threads。用来调 reply.js 的人格提示词。
 *
 *   npm run threads:reply:try -- "打卡"
 */
import { compose } from './reply.js';

const said = process.argv.slice(2).join(' ').trim();
if (!said) {
  console.error('用法：npm run threads:reply:try -- "对方说的那句话"');
  process.exit(1);
}

try {
  const { text, via } = await compose({ id: 'dry-run', username: '路人甲', text: said });
  console.log(`\n对方：${said}`);
  console.log(`大笨钟（${via}）：${text}\n`);
} catch (err) {
  console.error(`\n✗ 编不出来：${err.message}\n`);
  process.exit(1);
}
