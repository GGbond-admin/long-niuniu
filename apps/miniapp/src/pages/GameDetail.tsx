import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import BrandLogo from '../components/BrandLogo';

type Lobby = Awaited<ReturnType<typeof api.lobby>>;
type GameRules = Awaited<ReturnType<typeof api.gameRules>>;

function RuleBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rules-block">
      <h2>{title}</h2>
      <div className="rules-card">{children}</div>
    </section>
  );
}

export default function GameDetail({ kycStatus }: { kycStatus: string }) {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [rules, setRules] = useState<GameRules | null>(null);
  const room = roomId
    ? lobby?.games.find((game) => game.id === roomId)
    : lobby?.games[0];

  useEffect(() => {
    api.lobby().then(setLobby).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!room?.gameCode) return;
    let alive = true;
    setRules(null);
    api
      .gameRules(room.gameCode)
      .then((result) => {
        if (alive) setRules(result);
      })
      .catch(() => {
        // 至尊牛牛保留内置只读规则作为离线兜底。
      });
    return () => {
      alive = false;
    };
  }, [room?.gameCode]);

  function enterGame() {
    if (kycStatus === 'PENDING') return;
    if (kycStatus !== 'APPROVED') {
      navigate('/kyc');
      return;
    }
    const targetId = room?.id ?? roomId;
    if (!targetId) return;
    navigate(`/game/${targetId}/play`);
  }

  return (
    <div className="page detail-page rules-page">
      <header className="rules-top">
        <button className="rules-back" type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div className="rules-brand">
          <BrandLogo size={72} className="detail-hero-logo" />
          <h1>{room?.title ?? '至尊牛牛'}</h1>
          <p>玩法规则</p>
        </div>
      </header>

      {rules && (
        <>
          <RuleBlock title={rules.document.title}>
            <p>{rules.document.summary}</p>
            <small className="rules-version">
              规则版本 v{rules.document.version}
              {rules.document.publishedAt
                ? ` · ${new Date(rules.document.publishedAt).toLocaleDateString('zh-MY')}`
                : ''}
            </small>
          </RuleBlock>
          {rules.document.sections.map((section) => (
            <RuleBlock title={section.title} key={section.id}>
              {section.body.split(/\n+/).map((paragraph, index) => (
                <p key={`${section.id}-${index}`}>{paragraph}</p>
              ))}
            </RuleBlock>
          ))}
          <RuleBlock title="当前游戏配置摘要">
            <ul className="rules-list">
              <li>
                <b>竞标时间</b>
                <span>{rules.config.round.bidDurationSeconds} 秒</span>
              </li>
              <li>
                <b>下注时间</b>
                <span>{rules.config.round.betDurationSeconds} 秒</span>
              </li>
              <li>
                <b>抢包时间</b>
                <span>{rules.config.round.claimDurationSeconds} 秒</span>
              </li>
              <li>
                <b>闲家盈利抽水</b>
                <span>{Number(rules.config.fees.rakeRatio ?? 0) * 100}%</span>
              </li>
            </ul>
            <p>配置修改仅对下一局生效；进行中牌局继续使用开局快照。</p>
          </RuleBlock>
        </>
      )}

      {!rules && (!room || room.gameCode === 'SUPREME_NIUNIU') && (
        <>
      <RuleBlock title="游戏简介">
        <p>
          至尊牛牛是基于 Touch n Go eWallet 红包链接的多人对战玩法。
        </p>
        <p>
          每局由一位玩家通过竞标庄钱做「庄家」，闲家自由下注，系统统一发出 TNG 红包链接，按抢到的金额识别「点数/牌型」并比对庄闲大小，胜者按倍数赢取庄家筹码，平台抽取小额抽水。
        </p>
      </RuleBlock>

      <RuleBlock title="在哪里玩">
        <p>
          本游戏在「至尊牛牛互动群」内进行，请先进入「我的消息 → 至尊牛牛互动群」参与对局。竞标庄钱、下注、抢包等动作都在该群内完成。
        </p>
      </RuleBlock>

      <RuleBlock title="角色说明">
        <p>
          <strong>庄家：</strong>
          通过竞标庄钱上庄获得的玩家，承担本局所有闲家的输赢，赔付上限为庄池金额。
        </p>
        <p>
          <strong>闲家：</strong>
          未做庄的其他玩家，可在下注阶段下注与庄家对赌；不下注即视为本局弃权。
        </p>
      </RuleBlock>

      <RuleBlock title="游戏流程">
        <ol className="rules-steps">
          <li>
            <strong>大厅阶段</strong>
            <p>玩家进入对应群组房间等待开局；系统在凑够最低人数后自动开启下一局。</p>
          </li>
          <li>
            <strong>上庄 · 竞标庄钱</strong>
            <p>
              所有玩家可在倒计时内输入金额竞标庄钱，最高出价者成为本局庄家，相应金额从余额中冻结作「庄池」。
            </p>
            <p>
              续庄：竞标中标局结束后，庄家可沿用上一局庄钱再坐一局，无需再次竞标；连续坐庄最多两局。第三局恢复公开竞标，原庄仍可参与并再次中标。
            </p>
            <p>无人竞标庄钱：本局取消，不进入下注阶段。</p>
            <p>余额不足：系统会拒绝竞标并退回出价。</p>
          </li>
          <li>
            <strong>下注阶段</strong>
            <p>除庄家外的玩家可在「下注范围」内下注，倒计时结束即停止。</p>
            <p>未下注：视为本局弃权，不参与结算（不赢不输）。</p>
            <p>下注成功：金额从余额中冻结，等待结算。</p>
          </li>
          <li>
            <strong>系统发包</strong>
            <p>
              下注阶段结束后，系统统一发出 TNG 红包链接到游戏群。庄家与所有已下注的闲家依次抢包；抢到金额即为本人本局的「红包金额」。
            </p>
          </li>
          <li>
            <strong>抢额识别</strong>
            <p>
              系统按红包金额的小数与整数位计算「点数」与「牌型」（详见下方「点数计算」「牌型与倍数」章节）。
            </p>
          </li>
          <li>
            <strong>结算</strong>
            <p>系统逐个比对庄家与闲家的牌型 / 点数，按倍数结算并扣除抽水：</p>
            <p>闲家赢：庄家从庄池支付倍数 × 下注，平台抽取闲赢抽水（默认 5%）。</p>
            <p>闲家输：闲家下注全数归庄家，平台抽取庄家盈利的抽水（默认 5%）。</p>
            <p>牌型 / 点数相同：庄赢闲输。</p>
            <p>庄池不足赔付：以庄池余额为上限，不足部分免赔。</p>
          </li>
        </ol>
      </RuleBlock>

      <RuleBlock title="点数计算">
        <p>将红包金额（含小数点后两位）的所有数字相加，取个位数即为「点数」。</p>
        <p>例：3.42　3+4+2=9　9 点</p>
        <p>总和为 0 或末位为 0 时显示为 10 点（即「牛牛」最大点数）。</p>
      </RuleBlock>

      <RuleBlock title="牌型与倍数（由高到低）">
        <ul className="rules-list">
          <li>
            <b>豹子（17 倍）</b>
            <span>三位非零相同数字，如 1.11 / 7.77 / 9.99</span>
          </li>
          <li>
            <b>满牛（15 倍）</b>
            <span>整数金额，如 1.00 / 5.00 / 88.00</span>
          </li>
          <li>
            <b>反顺（14 倍）</b>
            <span>三位数字严格递减，如 9.87 / 3.21 / 2.10</span>
          </li>
          <li>
            <b>顺子（13 倍）</b>
            <span>三位数字严格递增，如 0.12 / 1.23 / 7.89</span>
          </li>
          <li>
            <b>对子（12 倍）</b>
            <span>末两位相同非零数字，如 1.22 / 7.55</span>
          </li>
          <li>
            <b>金牛（11 倍）</b>
            <span>仅一位非零数字，如 0.10 / 0.50</span>
          </li>
          <li>
            <b>普通</b>
            <span>按 1–10 点数倍数结算</span>
          </li>
        </ul>
        <p>实际倍数以游戏内显示为准（与后台配置实时同步）。</p>
      </RuleBlock>

      <RuleBlock title="牌型比较规则">
        <p>先比牌型等级：豹子 ＞ 满牛 ＞ 反顺 ＞ 顺子 ＞ 对子 ＞ 金牛 ＞ 普通。</p>
        <p>等级不同：高等级胜。</p>
        <p>等级相同 / 点数相同：比红包金额，金额大者胜。</p>
        <p>例：2.80（10 点）赢 1.09（10 点）</p>
        <p>等级相同且金额完全相同：视为平局，本对不结算（双方下注金额原路返回）。</p>
        <p>例：2.80 平 2.80</p>
      </RuleBlock>

      <RuleBlock title="如果您是庄家">
        <p>本局所有已下注的闲家与您对赌。</p>
        <p>赔付总额以「庄池」（您的中标金额）为上限，不会超过庄池亏损。</p>
        <p>庄家盈利时，平台从盈利中抽取庄家抽水（默认 5%）。</p>
        <p>竞标中标局结束后可选择「续庄」，沿用相同庄钱再坐一局；连续最多两局。第三局须公开竞标，您仍可参拍并再次中标。</p>
      </RuleBlock>

      <RuleBlock title="如果您是闲家">
        <p>请在下注倒计时内完成下注；超时未下注视为弃权，不参与结算。</p>
        <p>赢家：按牌型倍数 × 您的下注获得收益（扣闲赢抽水）。</p>
        <p>输家：下注全数归庄家。</p>
        <p>未下注 / 弃权：本局对您不结算，余额不变。</p>
      </RuleBlock>

      <RuleBlock title="棋牌奖励">
        <p>每日抢到指定牌型组合即可领取额外奖励：</p>
        <ul className="rules-list">
          <li>
            <b>豹子王</b>
            <span>豹子 ×3 — RM 288.88</span>
          </li>
          <li>
            <b>满牛王</b>
            <span>满牛 ×3 — RM 288.88</span>
          </li>
          <li>
            <b>顺子王</b>
            <span>顺子 ×3 — RM 188.88</span>
          </li>
          <li>
            <b>反顺王</b>
            <span>反顺 ×3 — RM 188.88</span>
          </li>
        </ul>
        <p>每日 0 点重新计算，未完成的进度不会跨天累计。具体牌型要求与奖励金额以游戏内公告为准。</p>
      </RuleBlock>

      <RuleBlock title="特殊情况">
        <p>无人竞标庄钱上庄：本局自动取消，无人参与结算。</p>
        <p>下注阶段无人下注：本局取消，庄池金额全额退回庄家。</p>
        <p>红包链接异常 / 失效：系统自动取消本局，所有冻结金额原路退回。</p>
        <p>抢包超时：未抢部分按规则自动结算或退回。</p>
      </RuleBlock>

      <RuleBlock title="注意事项">
        <p>上庄前请确认账户余额足够覆盖庄池；不足将自动退回竞标庄钱。</p>
        <p>红包链接由系统统一发出，禁止玩家私下分享或冒充系统链接。</p>
        <p>抢包顺序按操作时间确定，请提前准备 TNG 客户端。</p>
        <p>牌型 / 倍数 / 抽水比例 / 服务费等数值会根据运营情况调整，请以游戏内显示为准。</p>
      </RuleBlock>
        </>
      )}

      {!rules && room && room.gameCode !== 'SUPREME_NIUNIU' && (
        <RuleBlock title="规则暂不可用">
          <p>当前游戏规则尚未发布，请稍后重试或联系客服。</p>
        </RuleBlock>
      )}

      {room?.id && (
        <div className="game-context-links" aria-label="当前游戏内容">
          <button type="button" onClick={() => navigate(`/game/${room.id}/rewards`)}>
            每日奖励
          </button>
          <button type="button" onClick={() => navigate(`/game/${room.id}/leaderboards`)}>
            排行榜
          </button>
        </div>
      )}

      <div className="sticky-action">
        <button
          className="primary-action"
          type="button"
          onClick={enterGame}
          disabled={kycStatus === 'PENDING' || (!room?.id && kycStatus === 'APPROVED')}
        >
          {kycStatus === 'APPROVED'
            ? `进入${room?.interactionGroupTitle ?? '游戏互动群'}`
            : kycStatus === 'PENDING'
              ? '实名审核中，通过后可进入'
              : '完成实名后进入互动群'}
        </button>
      </div>
    </div>
  );
}
