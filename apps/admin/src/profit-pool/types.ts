export type BatchStatus = 'PENDING' | 'DISTRIBUTED' | 'NO_DISTRIBUTION';

export type ProfitPoolRoom = {
  id: string;
  title: string;
  gameCode: string;
  status: string;
  maxTerminalSeqNo: number;
  cutoverSeqNo: number;
  nextAvailableSeqNo: number;
  latestBatch: {
    id: string;
    poolCode: string;
    startSeqNo: number;
    endSeqNo: number;
    status: BatchStatus;
  } | null;
};

export type RangeCheck = {
  ok: boolean;
  room: { id: string; title: string; gameCode: string };
  startSeqNo: number;
  endSeqNo: number;
  roundCount: number;
  finishedRoundCount: number;
  cancelledRoundCount: number;
};

export type ProfitPoolPreview = {
  room: { id: string; title: string; gameCode: string };
  startSeqNo: number;
  endSeqNo: number;
  roundCount: number;
  finishedRoundCount: number;
  cancelledRoundCount: number;
  expenseBps: number;
  expenseCents: string;
  netPoolCents: string;
  bucketBase: number;
  distributedCents: string;
  residualCents: string;
  companyRemainingPointsHundredths: number;
  calculationHash: string;
  financials: {
    turnoverPlayerCents: string;
    turnoverBankerCents: string;
    turnoverCents: string;
    rakePlayerCents: string;
    rakeBankerCents: string;
    rakeTotalCents: string;
  };
  agents: PreviewAgent[];
};

export type PreviewAgent = {
  agentId: string;
  userId: string;
  parentAgentId: string | null;
  label: string;
  uid: string;
  nickname: string | null;
  level: number;
  status: string;
  sharePoints: number;
  directAgentCount: number;
  teamAgentCount: number;
  directPlayerCount: number;
  teamPlayerCount: number;
  selfTurnoverCents: string;
  teamTurnoverCents: string;
  contributionBp: number;
  selfAmountCents: string;
  overrideAmountCents: string;
  amountCents: string;
};

export type BatchSummary = {
  id: string;
  poolCode: string;
  roomId: string;
  room: { id: string; title: string; gameCode: string };
  startSeqNo: number;
  endSeqNo: number;
  roundCount: number;
  finishedRoundCount: number;
  cancelledRoundCount: number;
  turnoverPlayerCents: string;
  turnoverBankerCents: string;
  turnoverCents: string;
  rakePlayerCents: string;
  rakeBankerCents: string;
  rakeTotalCents: string;
  expenseBps: number;
  expenseCents: string;
  netPoolCents: string;
  distributedCents: string;
  residualCents: string;
  bucketBaseSnapshot: number;
  status: BatchStatus;
  generatedAt: string;
  distributedAt: string | null;
  _count?: { agentSnapshots: number };
};

export type BatchAgentSnapshot = {
  id: string;
  sourceAgentId: string;
  userId: string;
  parentSourceAgentId: string | null;
  label: string;
  uid: string;
  nickname: string | null;
  avatarUrl: string | null;
  level: number;
  statusSnapshot: string;
  sharePointsSnapshot: number;
  bucketBaseSnapshot: number;
  directAgentCount: number;
  teamAgentCount: number;
  directPlayerCount: number;
  teamPlayerCount: number;
  selfTurnoverCents: string;
  teamTurnoverCents: string;
  contributionBp: number;
  selfAmountCents: string;
  overrideAmountCents: string;
  amountCents: string;
};

export type BatchDetail = BatchSummary & {
  agentSnapshots: BatchAgentSnapshot[];
  roundLocks: Array<{
    id: string;
    seqNo: number;
    phaseSnapshot: string;
    finishedAtSnapshot: string | null;
  }>;
};

export type NetworkAgent = {
  id: string;
  userId: string;
  parentId: string | null;
  label: string;
  uid: string;
  nickname: string | null;
  avatarUrl: string | null;
  level: number;
  status: string;
  online: boolean;
  sharePoints: number;
  bucketBase: number;
  directAgentCount: number;
  teamAgentCount: number;
  directPlayerCount: number;
  teamPlayerCount: number;
  onlineTeamCount: number;
  turnoverCents: string;
  teamTurnoverCents: string;
  selfAmountCents: string;
  overrideAmountCents: string;
  profitCents: string;
  teamProfitCents: string;
  lifetimeProfitCents: string | null;
  contributionBp: number;
};

export type AgentNetwork = {
  mode: 'LIVE' | 'SNAPSHOT';
  generatedAt: string;
  batch: null | {
    id: string;
    poolCode: string;
    room: { id: string; title: string; gameCode: string };
    startSeqNo: number;
    endSeqNo: number;
    status: BatchStatus;
    generatedAt: string;
    turnoverCents: string;
    netPoolCents: string;
    distributedCents: string;
    residualCents: string;
    bucketBase: number;
    companyRemainingPointsHundredths: number;
  };
  summary: {
    agentCount: number;
    onlineAgentCount: number;
    rootAgentCount: number;
    teamPlayerCount: number;
  };
  nodes: NetworkAgent[];
};
