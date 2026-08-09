/**
 * 在线客服自动回复。
 * 内容对齐 PRD：充值/提现人工审核、KYC、设备解绑、三级返水、奖励与排行榜等。
 */
import { prisma } from '../lib/prisma.js';
import { env } from '../config.js';

const WELCOME = [
  '您好，欢迎联系至尊牛牛在线客服。',
  '请直接描述您的问题，例如充值、提现、实名认证、换设备等。',
  '涉及牌局请提供局号，人工客服会尽快为您处理。',
].join('\n');

type FaqRule = { id: string; patterns: RegExp[]; reply: string };

const FAQ_RULES: FaqRule[] = [
  {
    id: 'deposit',
    patterns: [/充值/, /入金/, /top\s*up/i, /deposit/i, /怎么充/, /如何充/],
    reply: [
      '【充值说明】',
      '1. 打开「钱包」→「充值」，按页面展示的收款账户转账。',
      '2. 提交金额与转账凭证后生成充值工单。',
      '3. 财务核实到账后才会入账，确认前余额不会增加。',
      '4. 到账后系统会推送通知；若超时未入账请回复凭证截图与转账时间。',
    ].join('\n'),
  },
  {
    id: 'withdraw',
    patterns: [/提现/, /提款/, /出金/, /withdraw/i, /怎么提/, /如何提/, /免费提/],
    reply: [
      '【提现说明】',
      '1. 需先完成实名认证（KYC），并绑定银行 / TNG 收款账户。',
      '2. 打开「钱包」→「提现」提交申请；金额会先冻结。',
      '3. 财务人工审核并线下转账后确认完成；驳回则解冻退回。',
      '4. 默认每日有免费提现次数，超出后按配置收取手续费（详见提现页）。',
    ].join('\n'),
  },
  {
    id: 'kyc',
    patterns: [/实名/, /kyc/i, /认证/, /duitnow/i, /身份证/, /审核驳回/, /驳回/],
    reply: [
      '【实名认证】',
      '1. 首次进入「钱包」会引导实名：真实姓名 + TNG DuitNow ID + 提款银行资料。',
      '2. 提交后状态为审核中；通过后才可充提与进群对局。',
      '3. 审核通过后银行户口默认不可自行修改，变更请联系客服。',
      '4. 若被驳回，请按驳回原因修改后重新提交。',
    ].join('\n'),
  },
  {
    id: 'device',
    patterns: [/换设备/, /解绑/, /换手机/, /设备/, /绑定设备/, /新手机/],
    reply: [
      '【设备绑定】',
      '账号与设备绑定，保障资金安全。',
      '如需更换设备：请在本会话说明情况（旧设备是否可用、UID），由后台人工解绑后再在新设备登录。',
      '请勿把账号借给他人使用。',
    ].join('\n'),
  },
  {
    id: 'invite',
    patterns: [/邀请/, /返水/, /推广/, /佣金/, /下级/, /代理/, /rebate/i, /invite/i],
    reply: [
      '【推广返水】',
      '绑定邀请人后形成三级推广关系，按「有效下注」日结发放：',
      '· 自身有效流水 0.7%',
      '· 直属下级 0.5%',
      '· 二级下级 0.3%',
      '可在「我的」→「我的推广 / 邀请好友」查看明细与邀请链接。',
    ].join('\n'),
  },
  {
    id: 'rewards',
    patterns: [/每日奖励/, /奖励/, /排行榜/, /积分榜/, /棋牌奖励/, /庄家奖励/, /特别奖励/],
    reply: [
      '【奖励与排行榜】',
      '「每日奖励」含棋牌 / 庄家 / 特别等标签任务，达标后可领取。',
      '「排行榜」按日/周/月展示积分等榜单，名次奖励以页面与公告为准。',
      '入口：大厅相关入口，或消息页活动通知。',
    ].join('\n'),
  },
  {
    id: 'game',
    patterns: [/怎么玩/, /规则/, /牛牛/, /玩法/, /竞标/, /抢包/, /红包/, /倍数/, /局号/],
    reply: [
      '【玩法简介】',
      '互动群内：竞标上庄 → 闲家下注 → 庄家发包 → 抢包认额 → 比牌结算。',
      '未通过实名不可进群对局；大厅可浏览玩法介绍。',
      '牌局争议请提供「局号」与截图，人工客服会为您核查。',
    ].join('\n'),
  },
  {
    id: 'hello',
    patterns: [/^(你好|您好|在吗|在不在|hi|hello|哈喽|客服)$/i],
    reply: WELCOME,
  },
];

export function resolveAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl;
  const base = env.miniappUrl.replace(/\/$/, '');
  return `${base}${avatarUrl.startsWith('/') ? '' : '/'}${avatarUrl}`;
}

export async function ensureSupportWelcome(userId: string): Promise<void> {
  const count = await prisma.chatMessage.count({ where: { userId } });
  if (count > 0) return;
  await prisma.chatMessage.create({
    data: {
      userId,
      senderType: 'SYSTEM',
      type: 'TEXT',
      content: WELCOME,
    },
  });
}

function matchFaq(text: string): FaqRule | null {
  const trimmed = text.trim();
  for (const rule of FAQ_RULES) {
    if (rule.patterns.some((re) => re.test(trimmed))) return rule;
  }
  return null;
}

/**
 * 用户发消息后匹配 FAQ，写入 SYSTEM 自动回复。返回创建的系统消息（0~1 条）。
 */
export async function handleUserSupportMessage(params: {
  userId: string;
  content: string;
  type: 'TEXT' | 'EMOJI' | 'STICKER';
}) {
  if (params.type !== 'TEXT' || !params.content.trim()) return [];

  const replies: string[] = [];
  const faq = matchFaq(params.content);
  if (faq) {
    replies.push(faq.reply);
  } else if (/人工|客服|投诉|催单|多久|什么时候/.test(params.content)) {
    replies.push(
      '已收到，人工客服会尽快回复。\n请尽量补充：UID、相关局号/工单号、截图说明，处理会更快。',
    );
  }

  const created = [];
  for (const content of replies) {
    created.push(
      await prisma.chatMessage.create({
        data: {
          userId: params.userId,
          senderType: 'SYSTEM',
          type: 'TEXT',
          content,
        },
      }),
    );
  }
  return created;
}

export { WELCOME, FAQ_RULES };
