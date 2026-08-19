import { EventEmitter } from 'node:events';

export interface RoundTransitionEvent {
  roundId: string;
  roomId: string;
  from: string;
  to: string;
}

export interface ClaimRecordedEvent {
  roundId: string;
  userId: string;
  amountCents: string;
}

export interface RewardGrantedEvent {
  userId: string;
  title: string;
  amountCents: string;
}

export interface RoundAnnouncementEvent {
  roundId: string;
  roomId: string;
  to: string;
}

class GameBus extends EventEmitter {
  transition(payload: RoundTransitionEvent) {
    this.emit('round:transition', payload);
  }

  claimRecorded(payload: ClaimRecordedEvent) {
    this.emit('claim:recorded', payload);
  }

  rewardGranted(payload: RewardGrantedEvent) {
    this.emit('reward:granted', payload);
  }

  announcementCompleted(payload: RoundAnnouncementEvent) {
    this.emit('round:announcement', payload);
  }
}

export const gameBus = new GameBus();
