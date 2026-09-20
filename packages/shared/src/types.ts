import type {
  AudioKind,
  CommentTargetType,
  Confidence,
  HeatLevel,
  NotificationType,
  RecipeStatus,
  TranscriptStatus,
  VagueCategory,
  VagueStatus,
  VerificationResult,
  VersionStatus,
  WorkspaceRole,
} from './enums';

/**
 * 可复做规格：把一句模糊口述变成"别人照着也能做出来"的结构化结论。
 * 必填规则见 validateResolvedSpec()。
 */
export interface ResolvedSpec {
  type: VagueCategory;
  /** 主体数值，例如 3（克） */
  value?: number | null;
  /** g | ml | 勺 | 度 | 秒 | 分钟 | null */
  unit?: string | null;
  /** 允许区间 */
  range?: { min: number; max: number } | null;
  /** 参照物说明，例如"外婆家一平勺≈8g，这里是约半勺" */
  reference?: string | null;
  /** 判断标准（火候/手感必填），例如"糖全部化开、变枣红色、闻到焦糖香" */
  criterion?: string | null;
  /** 替代方案 */
  substitute?: string | null;
  /** 证据链：必须指向原声片段或具体答复人 */
  evidence: {
    clipId?: string | null;
    answeredBy?: string | null;
    answeredAt?: string | null;
  };
  confidence: Confidence;
  notes?: string | null;
}

export interface WaveformPeaks {
  /** 归一化到 0..1 的峰值数组 */
  values: number[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ApiListMeta {
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiResponse<T> {
  data: T;
  meta?: ApiListMeta | Record<string, unknown>;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceMemberDto {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface RecipeDto {
  id: string;
  workspaceId: string;
  title: string;
  dishCategory: string | null;
  coverUrl: string | null;
  status: RecipeStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 概览计数，用于首页待办角标 */
  counters?: RecipeCounters;
}

export interface RecipeCounters {
  openVagueItems: number;
  askedVagueItems: number;
  answeredVagueItems: number;
  resolvedVagueItems: number;
  verifiedVagueItems: number;
  unresolvableVagueItems: number;
  audioCount: number;
  pendingTranscriptCount: number;
  hasDraft: boolean;
  publishedVersionNo: number | null;
}

export interface StepDto {
  id: string;
  versionId: string;
  orderIndex: number;
  title: string;
  instruction: string;
  heatLevel: HeatLevel | null;
  heatText: string | null;
  temperatureCMin: number | null;
  temperatureCMax: number | null;
  durationSecondsMin: number | null;
  durationSecondsMax: number | null;
  sensoryCues: string[];
  tool: string | null;
  sourceClipId: string | null;
  /** 乐观锁用：改之前先记下它，提交时回传，能防止覆盖别人的修改 */
  updatedAt: string;
}

export interface IngredientDto {
  id: string;
  versionId: string;
  orderIndex: number;
  name: string;
  amountText: string | null;
  amountValue: number | null;
  amountUnit: string | null;
  amountMin: number | null;
  amountMax: number | null;
  isVague: boolean;
  vagueItemId: string | null;
  note: string | null;
  updatedAt: string;
}

export interface AudioAttachmentDto {
  id: string;
  workspaceId: string;
  recipeId: string;
  ownerId: string;
  kind: AudioKind;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  peaks: number[] | null;
  sha256: string;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  createdAt: string;
  url: string;
}

export interface AudioClipDto {
  id: string;
  audioAttachmentId: string;
  startMs: number;
  endMs: number;
  label: string | null;
  createdBy: string;
  createdAt: string;
}

export interface VagueItemDto {
  id: string;
  recipeId: string;
  versionId: string | null;
  stepId: string | null;
  clipId: string | null;
  category: VagueCategory;
  rawPhrase: string;
  transcript: string | null;
  status: VagueStatus;
  assigneeId: string | null;
  question: string | null;
  questionAskedAt: string | null;
  answerText: string | null;
  answerClipId: string | null;
  answerAt: string | null;
  /** 语音答复对应的音频；播放答复时用它（不要错用 clipAudio，那是提问那句） */
  answerClipAudio?: AudioAttachmentDto | null;
  resolvedSpec: ResolvedSpec | null;
  confidence: Confidence | null;
  unresolvableNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  reopenedFromVerificationId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 展开的关联数据，列表接口按需返回 */
  clip?: AudioClipDto | null;
  clipAudio?: AudioAttachmentDto | null;
  answerClip?: AudioClipDto | null;
  assignee?: Pick<UserDto, 'id' | 'displayName' | 'avatarUrl'> | null;
  step?: Pick<StepDto, 'id' | 'title' | 'orderIndex'> | null;
}

export interface CommentDto {
  id: string;
  targetType: CommentTargetType;
  targetId: string;
  authorId: string;
  parentId: string | null;
  body: string;
  mentions: string[];
  resolvedAt: string | null;
  createdAt: string;
  author?: Pick<UserDto, 'id' | 'displayName' | 'avatarUrl'>;
}

export interface VerificationRunDto {
  id: string;
  recipeId: string;
  versionId: string;
  performedBy: string;
  performedAt: string;
  result: VerificationResult;
  /** 旧格式整段文本；结构化提交时为各条偏差按行拼接的快照 */
  deviations: string | null;
  photoUrls: string[];
  voiceClipId: string | null;
  createdAt: string;
  reopenedItemIds?: string[];
  /** 打回生成的追问条目详情：定位到哪一步、问了谁、是不是自动指派 */
  reopenedItems?: ReopenedDeviationDto[];
  performer?: Pick<UserDto, 'id' | 'displayName' | 'avatarUrl'>;
}

/** 复做偏差被转成的待澄清追问条目（创建验证接口的回执用） */
export interface ReopenedDeviationDto {
  id: string;
  rawPhrase: string;
  category: VagueCategory;
  status: VagueStatus;
  question: string | null;
  assigneeId: string | null;
  assigneeName?: string | null;
  stepId: string | null;
  stepTitle?: string | null;
  stepOrder?: number | null;
  /** true = 没有显式指定，由系统按"结论答复人 / 最熟的人"指派（仅创建回执保证返回） */
  autoAssigned?: boolean;
}

export interface NotificationDto {
  id: string;
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface ActivityLogDto {
  id: string;
  workspaceId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  diff: Record<string, unknown> | null;
  createdAt: string;
  actor?: Pick<UserDto, 'id' | 'displayName'>;
}

export interface KitchenReferenceDto {
  id: string;
  workspaceId: string;
  label: string;
  amountValue: number;
  amountUnit: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface RecipeVersionDto {
  id: string;
  recipeId: string;
  versionNo: number;
  parentVersionId: string | null;
  status: VersionStatus;
  title: string;
  summary: string | null;
  changeNote: string | null;
  createdBy: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  steps?: StepDto[];
  ingredients?: IngredientDto[];
  changeSources?: ChangeSource[];
}

/** 版本差异的来源追溯：这条改动是因为哪条待澄清条目 / 哪次复做反馈 / 哪条评论 */
export interface ChangeSource {
  kind: 'vague_item' | 'verification' | 'comment' | 'manual';
  id: string | null;
  label: string;
}

export type DiffOp = 'added' | 'removed' | 'modified' | 'moved' | 'unchanged';

export interface DiffEntry {
  op: DiffOp;
  section: 'step' | 'ingredient' | 'spec';
  key: string;
  label: string;
  before: unknown;
  after: unknown;
  sources?: ChangeSource[];
}

export interface VersionDiffDto {
  baseVersion: { id: string; versionNo: number };
  targetVersion: { id: string; versionNo: number };
  entries: DiffEntry[];
  summary: { added: number; removed: number; modified: number; moved: number };
}
