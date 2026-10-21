export interface Character {
  id: string;
  name: string;
  tagline: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  appearance: string;
  visual?: VisualProfile;
  tags: string[];
  color: string;
  avatarId?: string;
  rawCard?: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type CharacterInput = Pick<Character, 'name' | 'tagline' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'appearance' | 'tags' | 'color' | 'visual'>;

export interface VisualProfile {
  identity: string;
  outfit: string;
  faceAssetId?: string;
  bodyAssetId?: string;
  outfitAssetId?: string;
}

export interface UserPersona {
  id: string;
  name: string;
  description: string;
  visual: VisualProfile;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type FramingMode = 'auto' | 'together' | 'pov';

export interface OutfitState {
  id: string;
  description: string;
  referenceAssetId?: string;
  fromMessageId?: string;
  createdAt: string;
}

export interface VisualSnapshot {
  userPersona?: UserPersona;
  framing?: FramingMode;
  characterId: string;
  characterRevision: number;
  identity: string;
  outfit: OutfitState;
  references: { role: 'face' | 'body' | 'outfit'; assetId: string; personId?: 'main' | 'user' }[];
  scene?: SceneState;
}

export interface SceneFact {
  value: string;
  basis: 'explicit' | 'inherited' | 'uncertain' | 'manual';
  sourceMessageId?: string;
}

export interface ScenePerson {
  id: string;
  name: string;
  inFrame: boolean;
  position: SceneFact;
  action: SceneFact;
  expression: SceneFact;
  outfit: SceneFact;
  wearing: SceneFact;
  appearance: SceneFact;
  props: SceneFact;
}

export interface SceneState {
  identity: string;
  setting: SceneFact;
  camera: SceneFact;
  interaction: SceneFact;
  people: ScenePerson[];
}

export interface SceneContext {
  key: string;
  state?: SceneState;
  sourceMessageId?: string;
  pendingMessages: number;
}

export type WorldType = 'auto' | 'xianxia' | 'urban' | 'apocalypse' | 'fantasy' | 'wuxia' | 'scifi' | 'palace' | 'academy' | 'modern' | 'generic';
export type StateValue = string | number | boolean | null | StateValue[] | { [key: string]: StateValue };
export interface MemoryFact { id: string; value: string; sourceMessageId?: string; confidence: number; confirmed: boolean; createdAt: string; }
export interface StorySummary { id: string; rangeStart?: string; rangeEnd?: string; summary: string; facts: string[]; unresolved: string[]; createdAt: string; }
export interface MemoryState { shortSummary: string; storySummaries: StorySummary[]; permanentFacts: MemoryFact[]; unresolved: string[]; hiddenCount: number; }
export interface WorldState { lockedPaths?: string[]; sourceMessageId?: string; syncStatus?: 'idle' | 'updating' | 'failed'; syncError?: string; coverage?: string; chatId: string; revision: number; worldType: WorldType; world: Record<string, StateValue>; player: Record<string, StateValue>; characters: Record<string, Record<string, StateValue>>; relationships: Record<string, StateValue>; inventory: Record<string, StateValue>; location: Record<string, StateValue>; outfit: Record<string, StateValue>; memory: MemoryState; custom: Record<string, StateValue>; updatedAt: string; }
export type StatePatchOp = 'set' | 'inc' | 'add' | 'del' | 'merge' | 'append';
export interface StatePatch { op: StatePatchOp; path: string; value?: StateValue; key?: string; }
export interface WorldStateEvent { id: string; chatId: string; messageId?: string; revision: number; patch: StatePatch[]; inversePatch: StatePatch[]; source: 'model' | 'manual' | 'rollback' | 'migration'; status: 'applied' | 'rejected' | 'partial'; createdAt: string; }
export interface WorldStateSnapshot { chatId: string; messageId?: string; revision: number; state: WorldState; reason: 'generation' | 'swipe' | 'regenerate' | 'manual'; createdAt: string; }

export interface VisualContext { key: string; snapshot: VisualSnapshot }

export interface Chat {
  forkedFrom?: { chatId: string; messageId: string; title: string };
  userPersona?: UserPersona;
  framing?: FramingMode;
  id: string;
  characterId: string;
  title: string;
  revision: number;
  outfits?: OutfitState[];
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'streaming' | 'interrupted' | 'failed';
  error?: string;
  createdAt: string;
}

export type JobStatus = 'queued' | 'submitting' | 'running' | 'collecting' | 'reconciling' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled';

export interface ImageJob {
  id: string;
  characterId?: string;
  chatId?: string;
  sourceMessageId?: string;
  prompt: string;
  seed: number;
  workflowId: string;
  visual?: VisualSnapshot;
  compiledPrompt?: string;
  status: JobStatus;
  phase: string;
  progress: number | null;
  promptId?: string;
  assetId?: string;
  error?: string;
  needsAttention?: boolean;
  submittedAt?: string;
  submissionAcknowledged?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  personaId?: string;
  id: string;
  jobId?: string;
  characterId?: string;
  chatId?: string;
  sourceMessageId?: string;
  visual?: VisualSnapshot;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
}

export interface Settings {
  textProtocol?: 'openai' | 'anthropic';
  textPresetJson?: string;
  textPresetName?: string;
  textSystemPrompt?: string;
  textReasoningEffort?: 'default' | 'minimal' | 'low' | 'medium' | 'high';
  activeTextProfileId?: string;
  textProfileName?: string;
  textProfiles?: TextModelProfile[];
  comfyUrl: string;
  textUrl: string;
  textModel: string;
  allowCloud: boolean;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  researchUseConfirmed: boolean;
  hasApiKey: boolean;
}

export interface TextModelProfile {
  textProtocol?: 'openai' | 'anthropic';
  textPresetJson?: string;
  textPresetName?: string;
  textSystemPrompt?: string;
  textReasoningEffort?: Settings['textReasoningEffort'];
  id: string;
  name: string;
  textUrl: string;
  textModel: string;
  allowCloud: boolean;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  hasApiKey: boolean;
}

export interface SystemStatus {
  comfy: { online: boolean; message: string };
  text: { configured: boolean; model: string };
  version: string;
}

export interface Bootstrap {
  characters: Character[];
  chats: Chat[];
  jobs: ImageJob[];
  assets: Asset[];
  settings: Settings;
  eventCursor: number;
}

export interface StudioEvent {
  id: number;
  type: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
}
