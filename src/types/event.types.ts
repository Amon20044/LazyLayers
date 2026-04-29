export type InvalidationType = 'del' | 'pattern';

export interface BaseInvalidationEvent {
  id?: string;
  type: InvalidationType;
  source: string;
  ts: number;
  generation?: number;
}

export interface DeleteEvent extends BaseInvalidationEvent {
  type: 'del';
  keys: string[];
}

export interface PatternEvent extends BaseInvalidationEvent {
  type: 'pattern';
  pattern: string;
}

export type InvalidationEvent = DeleteEvent | PatternEvent;
