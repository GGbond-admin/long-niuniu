import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { goBack } from '../lib/nav';
import BrandLogo from '../components/BrandLogo';

type Lobby = Awaited<ReturnType<typeof api.lobby>>;
type GameRules = Awaited<ReturnType<typeof api.gameRules>>;

const rulesCache = new Map<string, GameRules>();

function RuleBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rules-block">
      <h2>{title}</h2>
      <div className="rules-card">{children}</div>
    </section>
  );
}

function RuleParagraph({ text }: { text: string }) {
  if (/^\d+\.\s/.test(text)) {
    return <p><strong>{text}</strong></p>;
  }
  const labeled = /^([^：]{1,20}：)(.*)$/.exec(text);
  if (labeled) {
    return (
      <p>
        <strong>{labeled[1]}</strong>
        {labeled[2]}
      </p>
    );
  }
  return <p>{text}</p>;
}

export default function GameDetail({ kycStatus }: { kycStatus: string }) {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [lobbyError, setLobbyError] = useState('');
  const [lobbyRetryKey, setLobbyRetryKey] = useState(0);
  const [rules, setRules] = useState<GameRules | null>(null);
  const [rulesFailed, setRulesFailed] = useState(false);
  const room = roomId
    ? lobby?.games.find((game) => game.id === roomId)
    : lobby?.games[0];
  const roomMissing = !!lobby && !!roomId && !room;

  useEffect(() => {
    let alive = true;
    api
      .lobby()
      .then((result) => {
        if (!alive) return;
        setLobby(result);
        setLobbyError('');
      })
      .catch(() => {
        if (!alive) return;
        setLobbyError('房间信息加载失败，请检查网络后重试。');
        // 拿不到 gameCode 时先展示内置兜底规则，避免永久停在加载中
        setRulesFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [lobbyRetryKey]);

  useEffect(() => {
    const gameCode = room?.gameCode;
    if (!gameCode) return;
    const cached = rulesCache.get(gameCode);
    if (cached) {
      setRules(cached);
      setRulesFailed(false);
      return;
    }
    let alive = true;
    setRules(null);
    setRulesFailed(false);
    api
      .gameRules(gameCode)
      .then((result) => {
        rulesCache.set(gameCode, result);
        if (alive) {
          setRules(result);
          setRulesFailed(false);
        }
      })
      .catch(() => {
        if (alive) setRulesFailed(true);
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
        <button className="rules-back" type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
          ‹
        </button>
        <div className="rules-brand">
          <BrandLogo size={72} className="detail-hero-logo" />
          <h1>{room?.title ?? '至尊牛牛'}</h1>
          <p>玩法规则</p>
        </div>
      </header>

      {lobbyError && (
        <section className="feature-load-error" role="alert">
          <strong>房间信息没有加载成功</strong>
          <p>{lobbyError}</p>
          <button
            type="button"
            onClick={() => {
              setLobbyError('');
              setLobbyRetryKey((key) => key + 1);
            }}
          >
            重试
          </button>
        </section>
      )}

      {roomMissing && (
        <RuleBlock title="房间不存在">
          <p>该房间可能已下线或链接有误，请返回大厅重新选择游戏。</p>
        </RuleBlock>
      )}

      {rules && (
        <>
          {rules.document.sections.map((section) => (
            <RuleBlock title={section.title} key={section.id}>
              {section.body.split(/\n+/).map((paragraph, index) => (
                <RuleParagraph
                  key={`${section.id}-${index}`}
                  text={paragraph}
                />
              ))}
            </RuleBlock>
          ))}
          <small className="rules-version">
            规则版本 v{rules.document.version}
            {rules.document.publishedAt
              ? ` · ${new Date(rules.document.publishedAt).toLocaleDateString('zh-MY')}`
              : ''}
          </small>
        </>
      )}

      {!rules && !rulesFailed && !roomMissing && (
        <RuleBlock title="正在加载规则">
          <p>正在读取至尊牛牛玩法规则…</p>
        </RuleBlock>
      )}

      {!rules && rulesFailed && !roomMissing && (!room || room.gameCode === 'SUPREME_NIUNIU') && (
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
              所有玩家可在倒计时内输入整数金额竞标庄钱；首口自由输入，之后最低需要比当前最高价高 100，也可以加更多，低于最低加价会被拒绝。最高出价者成为本局庄家，相应金额从余额中冻结作「庄池」。
            </p>
            <p>
              续庄：上一局做庄的玩家如果选择续庄，将沿用上一局的庄钱继续做庄，无需再次竞标；同一玩家每桌仅可续庄一次。
            </p>
            <p>无人竞标庄钱：本局取消，不进入下注阶段。</p>
            <p>余额不足：系统会拒绝竞标并退回出价。</p>
          </li>
          <li>
            <strong>下注阶段</strong>
            <p>
              除庄家外的玩家可在「下注范围」内下注，倒计时结束即停止；也可选择梭哈。
            </p>
            <p>
              普通下注最高可下注按当前余额与本局最高牌型倍数计算（默认 17 倍）；输入过高时系统自动降低并告知实际接受金额。
            </p>
            <p>
              梭哈赔付固定 1:1，最低默认 30，房间上限为庄钱 × 满梭哈比例（默认 5%）× 人数系数，再与当前余额取较小值。
            </p>
            <p>未下注：视为本局弃权，不参与结算（不赢不输）。</p>
            <p>
              下注成功：按「实际下注 × 赔付倍数」冻结最大赔付预留金（普通=本局最高倍数、梭哈=1 倍）。
            </p>
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
            <p>闲家赢：庄家从庄池支付倍数 × 下注，平台抽取闲赢抽水（默认 3%）。</p>
            <p>闲家输：按庄家牌型倍数从最大赔付预留金扣除，剩余预留金自动退回。</p>
            <p>梭哈单：无论牌型多大，赢只按 1:1 拿等额下注、输只赔等额下注。</p>
            <p>同牌型按该牌型规则比较；比较键相同则平局退回。</p>
          </li>
          <li>
            <strong>庄钱不足时的赔付顺序</strong>
            <p>
              庄钱是庄家本局可赔付的最高金额，赔完即止。不够赔全部赢家时，普通与梭哈的赢家一起排队赔付：
            </p>
            <p>① 牌型等级高的先赔（梭哈按自己抢到的牌型排队）→ ② 同牌型按该牌型比较规则（普通比点数；对子先后两位再前位；金牛比中间位；其余比金额）→ ③ 全同则下注时间早的先赔。</p>
            <p>轮到某位赢家时庄钱不够全额，剩余庄钱全部赔给他；庄钱归零后，后面的赢家「喝水」，不获赔付，但下注冻结金额全额退回、不会倒扣。</p>
          </li>
        </ol>
      </RuleBlock>

      <RuleBlock title="点数计算">
        <p>将红包金额的三位关键数字相加，取个位数即为「点数」。</p>
        <p>例：3.42　3+4+2=9　9 点；1.28　1+2+8=11　1 点</p>
        <p>三位数字相加刚好等于 10 时不按点数计算，直接判为「牛牛」牌型。</p>
        <p>相加超过 10 取个位；个位为 0（如相加为 20）记为 0 点，是最小点数。</p>
      </RuleBlock>

      <RuleBlock title="牌型与倍数（由高到低）">
        <ul className="rules-list">
          <li>
            <b>豹子（17 倍）</b>
            <span>三位数字全部相同，如 1.11 / 7.77 / 9.99</span>
          </li>
          <li>
            <b>满牛（15 倍）</b>
            <span>后两位为 00，如 1.00 / 5.00 / 88.00</span>
          </li>
          <li>
            <b>顺子（13 倍）</b>
            <span>三位数字连续递增，如 0.12 / 1.23 / 7.89（0 可作起点）</span>
          </li>
          <li>
            <b>反顺（14 倍）</b>
            <span>三位数字连续递减，如 9.87 / 3.21 / 2.10；最大 9.87。0.98 也算倒顺</span>
          </li>
          <li>
            <b>对子（12 倍）</b>
            <span>末两位相同非零数字，如 1.22 / 7.55</span>
          </li>
          <li>
            <b>金牛（11 倍）</b>
            <span>0.X0 形式（X = 1–9），如 0.10 / 0.50 / 0.90</span>
          </li>
          <li>
            <b>牛牛（10 倍）</b>
            <span>三位数字相加刚好等于 10，如 2.35 / 1.36 / 5.50</span>
          </li>
          <li>
            <b>普通</b>
            <span>按 0–9 点数倍数结算</span>
          </li>
        </ul>
        <p>同时符合多个牌型时取上表更高的牌型。</p>
        <p>实际倍数以游戏内显示为准（与后台配置实时同步）。</p>
      </RuleBlock>

      <RuleBlock title="牌型比较规则">
        <p>先比牌型等级：豹子 ＞ 满牛 ＞ 顺子 ＞ 反顺 ＞ 对子 ＞ 金牛 ＞ 牛牛 ＞ 普通。</p>
        <p>等级不同：高等级胜。</p>
        <p>等级相同后按该牌型自己的规则比较：</p>
        <p>普通：先比点数（牛牛/10点 ＞ 9点 ＞ … ＞ 1点 ＞ 0点），同点再比金额。</p>
        <p>豹子 / 满牛 / 顺子 / 反顺 / 牛牛：比整笔金额。</p>
        <p>对子：先比后两位（99 ＞ 88 ＞ … ＞ 11），后两位相同再比前一位（例：8.99 赢 9.88；9.22 赢 1.22）。</p>
        <p>金牛：只比中间金额，前后不算（例：0.90 赢 0.10）。</p>
        <p>比较键相同：视为平局，本对不结算（双方下注金额原路返回）。</p>
        <p>例：1.22 平 1.22；2.80 平 2.80。</p>
      </RuleBlock>

      <RuleBlock title="如果您是庄家">
        <p>本局所有已下注的闲家与您对赌。</p>
        <p>赔付总额以「庄池」（您的中标金额）为上限，不会超过庄池亏损。</p>
        <p>庄家本局对赌毛利为正时，平台从该毛利抽取庄家抽水（默认 5%）；亏损不抽。</p>
        <p>本局结束后可选择「续庄」，沿用相同的庄钱继续坐庄；同一玩家每桌仅可续庄一次。</p>
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
            <span>豹子 ×3 — 288.88</span>
          </li>
          <li>
            <b>满牛王</b>
            <span>满牛 ×3 — 288.88</span>
          </li>
          <li>
            <b>顺子王</b>
            <span>顺子 ×3 — 188.88</span>
          </li>
          <li>
            <b>反顺王</b>
            <span>反顺 ×3 — 188.88</span>
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

      {!rules && rulesFailed && room && room.gameCode !== 'SUPREME_NIUNIU' && (
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
          disabled={
            kycStatus === 'PENDING'
            || (kycStatus === 'APPROVED' && (!roomId || roomMissing))
          }
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
