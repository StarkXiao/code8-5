import type {
  ActivityLogDto,
  AudioAttachmentDto,
  AudioClipDto,
  CommentDto,
  IngredientDto,
  KitchenReferenceDto,
  NotificationDto,
  RecipeDto,
  RecipeVersionDto,
  ReopenedDeviationDto,
  ResolvedSpec,
  StepDto,
  UserDto,
  VagueItemDto,
  VerificationRunDto,
  WorkspaceDto,
  WorkspaceMemberDto,
} from '@froa/shared';
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
} from '@froa/shared';
import { parseJson, parseJsonArray, parseNumberArray } from '../lib/json';

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: Date;
};

export function toUserDto(user: UserRow): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toUserBrief(user: { id: string; displayName: string; avatarUrl: string | null }) {
  return { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

export function toWorkspaceDto(
  workspace: { id: string; name: string; ownerId: string; inviteCode: string; createdAt: Date },
  role: WorkspaceRole,
): WorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    ownerId: workspace.ownerId,
    inviteCode: workspace.inviteCode,
    role,
    createdAt: workspace.createdAt.toISOString(),
  };
}

export function toMemberDto(member: {
  id: string;
  userId: string;
  role: string;
  joinedAt: Date;
  user: { email: string; displayName: string; avatarUrl: string | null };
}): WorkspaceMemberDto {
  return {
    id: member.id,
    userId: member.userId,
    displayName: member.user.displayName,
    email: member.user.email,
    avatarUrl: member.user.avatarUrl,
    role: member.role as WorkspaceRole,
    joinedAt: member.joinedAt.toISOString(),
  };
}

export function toRecipeDto(recipe: {
  id: string;
  workspaceId: string;
  title: string;
  dishCategory: string | null;
  coverUrl: string | null;
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): RecipeDto {
  return {
    id: recipe.id,
    workspaceId: recipe.workspaceId,
    title: recipe.title,
    dishCategory: recipe.dishCategory,
    coverUrl: recipe.coverUrl,
    status: recipe.status as RecipeStatus,
    createdBy: recipe.createdBy,
    createdAt: recipe.createdAt.toISOString(),
    updatedAt: recipe.updatedAt.toISOString(),
  };
}

export function toStepDto(step: {
  id: string;
  versionId: string;
  orderIndex: number;
  title: string;
  instruction: string;
  heatLevel: string | null;
  heatText: string | null;
  temperatureCMin: number | null;
  temperatureCMax: number | null;
  durationSecondsMin: number | null;
  durationSecondsMax: number | null;
  sensoryCues: string | null;
  tool: string | null;
  sourceClipId: string | null;
  updatedAt: Date;
}): StepDto {
  return {
    id: step.id,
    versionId: step.versionId,
    orderIndex: step.orderIndex,
    title: step.title,
    instruction: step.instruction,
    heatLevel: (step.heatLevel as HeatLevel | null) ?? null,
    heatText: step.heatText,
    temperatureCMin: step.temperatureCMin,
    temperatureCMax: step.temperatureCMax,
    durationSecondsMin: step.durationSecondsMin,
    durationSecondsMax: step.durationSecondsMax,
    sensoryCues: parseJsonArray(step.sensoryCues),
    tool: step.tool,
    sourceClipId: step.sourceClipId,
    updatedAt: step.updatedAt.toISOString(),
  };
}

export function toIngredientDto(ingredient: {
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
  updatedAt: Date;
}): IngredientDto {
  return {
    id: ingredient.id,
    versionId: ingredient.versionId,
    orderIndex: ingredient.orderIndex,
    name: ingredient.name,
    amountText: ingredient.amountText,
    amountValue: ingredient.amountValue,
    amountUnit: ingredient.amountUnit,
    amountMin: ingredient.amountMin,
    amountMax: ingredient.amountMax,
    isVague: ingredient.isVague,
    vagueItemId: ingredient.vagueItemId,
    note: ingredient.note,
    updatedAt: ingredient.updatedAt.toISOString(),
  };
}

export function toAudioDto(audio: {
  id: string;
  workspaceId: string;
  recipeId: string;
  ownerId: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  peaks: string | null;
  sha256: string;
  transcript: string | null;
  transcriptStatus: string;
  createdAt: Date;
}): AudioAttachmentDto {
  return {
    id: audio.id,
    workspaceId: audio.workspaceId,
    recipeId: audio.recipeId,
    ownerId: audio.ownerId,
    kind: audio.kind as AudioKind,
    mimeType: audio.mimeType,
    sizeBytes: audio.sizeBytes,
    durationMs: audio.durationMs,
    peaks: parseNumberArray(audio.peaks),
    sha256: audio.sha256,
    transcript: audio.transcript,
    transcriptStatus: audio.transcriptStatus as TranscriptStatus,
    createdAt: audio.createdAt.toISOString(),
    url: `/api/audio/${audio.id}/stream`,
  };
}

export function toClipDto(clip: {
  id: string;
  audioAttachmentId: string;
  startMs: number;
  endMs: number;
  label: string | null;
  createdBy: string;
  createdAt: Date;
}): AudioClipDto {
  return {
    id: clip.id,
    audioAttachmentId: clip.audioAttachmentId,
    startMs: clip.startMs,
    endMs: clip.endMs,
    label: clip.label,
    createdBy: clip.createdBy,
    createdAt: clip.createdAt.toISOString(),
  };
}

type VagueItemRow = {
  id: string;
  recipeId: string;
  versionId: string | null;
  stepId: string | null;
  clipId: string | null;
  category: string;
  rawPhrase: string;
  transcript: string | null;
  status: string;
  assigneeId: string | null;
  question: string | null;
  questionAskedAt: Date | null;
  answerText: string | null;
  answerClipId: string | null;
  answerAt: Date | null;
  resolvedSpec: string | null;
  confidence: string | null;
  unresolvableNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  reopenedFromVerificationId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toVagueItemDto(item: VagueItemRow): VagueItemDto {
  return {
    id: item.id,
    recipeId: item.recipeId,
    versionId: item.versionId,
    stepId: item.stepId,
    clipId: item.clipId,
    category: item.category as VagueCategory,
    rawPhrase: item.rawPhrase,
    transcript: item.transcript,
    status: item.status as VagueStatus,
    assigneeId: item.assigneeId,
    question: item.question,
    questionAskedAt: iso(item.questionAskedAt),
    answerText: item.answerText,
    answerClipId: item.answerClipId,
    answerAt: iso(item.answerAt),
    resolvedSpec: item.resolvedSpec ? parseJson<ResolvedSpec | null>(item.resolvedSpec, null) : null,
    confidence: (item.confidence as Confidence | null) ?? null,
    unresolvableNote: item.unresolvableNote,
    resolvedBy: item.resolvedBy,
    resolvedAt: iso(item.resolvedAt),
    reopenedFromVerificationId: item.reopenedFromVerificationId,
    createdBy: item.createdBy,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function toCommentDto(comment: {
  id: string;
  targetType: string;
  targetId: string;
  authorId: string;
  parentId: string | null;
  body: string;
  mentions: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  author?: { id: string; displayName: string; avatarUrl: string | null } | null;
}): CommentDto {
  return {
    id: comment.id,
    targetType: comment.targetType as CommentTargetType,
    targetId: comment.targetId,
    authorId: comment.authorId,
    parentId: comment.parentId,
    body: comment.body,
    mentions: parseJsonArray(comment.mentions),
    resolvedAt: iso(comment.resolvedAt),
    createdAt: comment.createdAt.toISOString(),
    ...(comment.author ? { author: toUserBrief(comment.author) } : {}),
  };
}

export function toVerificationDto(run: {
  id: string;
  recipeId: string;
  versionId: string;
  performedBy: string;
  performedAt: Date;
  result: string;
  deviations: string | null;
  photoUrls: string | null;
  voiceClipId: string | null;
  createdAt: Date;
  reopenedItems?: Array<{ id: string } | ReopenedDeviationDto>;
  performer?: { id: string; displayName: string; avatarUrl: string | null } | null;
}): VerificationRunDto {
  const reopenedItems = (run.reopenedItems ?? []) as Array<{ id: string } & Partial<ReopenedDeviationDto>>;
  const richItems = reopenedItems.filter((item): item is ReopenedDeviationDto => item.rawPhrase !== undefined);

  return {
    id: run.id,
    recipeId: run.recipeId,
    versionId: run.versionId,
    performedBy: run.performedBy,
    performedAt: run.performedAt.toISOString(),
    result: run.result as VerificationResult,
    deviations: run.deviations,
    photoUrls: parseJsonArray(run.photoUrls),
    voiceClipId: run.voiceClipId,
    createdAt: run.createdAt.toISOString(),
    ...(reopenedItems.length ? { reopenedItemIds: reopenedItems.map((item) => item.id) } : {}),
    ...(richItems.length ? { reopenedItems: richItems } : {}),
    ...(run.performer ? { performer: toUserBrief(run.performer) } : {}),
  };
}

export function toNotificationDto(notification: {
  id: string;
  userId: string;
  type: string;
  payload: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationDto {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type as NotificationType,
    payload: notification.payload ? parseJson<Record<string, unknown> | null>(notification.payload, null) : null,
    readAt: iso(notification.readAt),
    createdAt: notification.createdAt.toISOString(),
  };
}

export function toActivityDto(log: {
  id: string;
  workspaceId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  diff: string | null;
  createdAt: Date;
  actor?: { id: string; displayName: string } | null;
}): ActivityLogDto {
  return {
    id: log.id,
    workspaceId: log.workspaceId,
    actorId: log.actorId,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    diff: log.diff ? parseJson<Record<string, unknown> | null>(log.diff, null) : null,
    createdAt: log.createdAt.toISOString(),
    ...(log.actor ? { actor: { id: log.actor.id, displayName: log.actor.displayName } } : {}),
  };
}

export function toReferenceDto(reference: {
  id: string;
  workspaceId: string;
  label: string;
  amountValue: number;
  amountUnit: string;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}): KitchenReferenceDto {
  return {
    id: reference.id,
    workspaceId: reference.workspaceId,
    label: reference.label,
    amountValue: reference.amountValue,
    amountUnit: reference.amountUnit,
    note: reference.note,
    createdBy: reference.createdBy,
    createdAt: reference.createdAt.toISOString(),
  };
}

export function toVersionDto(
  version: {
    id: string;
    recipeId: string;
    versionNo: number;
    parentVersionId: string | null;
    status: string;
    title: string;
    summary: string | null;
    changeNote: string | null;
    createdBy: string;
    publishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    steps?: Parameters<typeof toStepDto>[0][];
    ingredients?: Parameters<typeof toIngredientDto>[0][];
  },
  changeSources?: RecipeVersionDto['changeSources'],
): RecipeVersionDto {
  return {
    id: version.id,
    recipeId: version.recipeId,
    versionNo: version.versionNo,
    parentVersionId: version.parentVersionId,
    status: version.status as VersionStatus,
    title: version.title,
    summary: version.summary,
    changeNote: version.changeNote,
    createdBy: version.createdBy,
    publishedAt: iso(version.publishedAt),
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    ...(version.steps ? { steps: version.steps.map(toStepDto) } : {}),
    ...(version.ingredients ? { ingredients: version.ingredients.map(toIngredientDto) } : {}),
    ...(changeSources ? { changeSources } : {}),
  };
}
