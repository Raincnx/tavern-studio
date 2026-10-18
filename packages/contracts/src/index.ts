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

export interface OutfitState {
  id: string;
  description: string;
  referenceAssetId?: string;
  fromMessageId?: string;
  createdAt: string;
}

export interface VisualSnapshot {
  characterId: string;
  characterRevision: number;
  identity: string;
  outfit: OutfitState;
  references: { role: 'face' | 'body' | 'outfit'; assetId: string }[];
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

export interface VisualContext { key: string; snapshot: VisualSnapshot }

export interface Chat {
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
