import { z } from 'zod';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  AUDIO_KINDS,
  COMMENT_TARGET_TYPES,
  CONFIDENCE_LEVELS,
  HEAT_LEVELS,
  VAGUE_CATEGORIES,
  VERIFICATION_RESULTS,
  WORKSPACE_ROLES,
} from './enums';

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

export const idSchema = z.string().min(1).max(64);
export const emailSchema = z.string().trim().toLowerCase().email('请输入有效的邮箱地址');
export const passwordSchema = z.string().min(8, '密码至少 8 位').max(72);
export const displayNameSchema = z.string().trim().min(1, '请填写称呼').max(32);

/* ------------------------------------------------------------------ */
/* 鉴权                                                                */
/* ------------------------------------------------------------------ */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, '请输入密码'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const updateMeSchema = z.object({
  displayName: displayNameSchema.optional(),
  avatarUrl: z.string().url().nullish(),
});

/* ------------------------------------------------------------------ */
/* 家庭空间                                                            */
/* ------------------------------------------------------------------ */

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, '请填写家庭空间名称').max(64),
});

export const joinWorkspaceSchema = z.object({
  inviteCode: z.string().trim().min(4).max(32),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(WORKSPACE_ROLES),
});

export const kitchenReferenceSchema = z.object({
  label: z.string().trim().min(1, '请填写参照物名称，例如"奶奶家的汤勺"').max(64),
  amountValue: z.number().positive('必须大于 0'),
  amountUnit: z.string().trim().min(1).max(16),
  note: z.string().trim().max(500).nullish(),
});

/* ------------------------------------------------------------------ */
/* 食谱与版本                                                          */
/* ------------------------------------------------------------------ */

export const createRecipeSchema = z.object({
  workspaceId: idSchema.optional(),
  title: z.string().trim().min(1, '请填写食谱名称').max(120),
  dishCategory: z.string().trim().max(32).nullish(),
  coverUrl: z.string().url().nullish(),
});

/**
 * 更新食谱时不允许改 workspaceId —— 否则一张食谱能被"搬"到别的家庭空间，
 * 而音频、成员、版本都还留在原空间，数据立刻自相矛盾。
 */
export const updateRecipeSchema = createRecipeSchema.omit({ workspaceId: true }).partial();

/**
 * 乐观锁字段。
 * 客户端带上它读到数据时的时间戳；如果服务端已更新，返回 409 而不是静默覆盖别人的改动。
 */
export const expectedUpdatedAtSchema = z.string().datetime().optional();

/** 查询参数里的布尔值必须显式解析：z.coerce.boolean() 会把字符串 "false" 变成 true */
export const booleanQuerySchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

export const forkVersionSchema = z.object({
  fromVersionId: idSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(2000).nullish(),
});

export const updateVersionSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(2000).nullish(),
});

export const publishVersionSchema = z.object({
  changeNote: z
    .string()
    .trim()
    .min(5, '发布必须填写变更说明（至少 5 个字）')
    .max(4000),
  force: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* 步骤与用量                                                          */
/* ------------------------------------------------------------------ */

export const sensoryCuesSchema = z.array(z.string().trim().min(1).max(60)).max(20).default([]);

export const createStepSchema = z.object({
  title: z.string().trim().min(1, '请填写步骤名').max(120),
  instruction: z.string().trim().min(1, '请填写可复做描述').max(4000),
  heatLevel: z.enum(HEAT_LEVELS).nullish(),
  heatText: z.string().trim().max(64).nullish(),
  temperatureCMin: z.number().min(-50).max(500).nullish(),
  temperatureCMax: z.number().min(-50).max(500).nullish(),
  durationSecondsMin: z.number().int().min(0).max(86400).nullish(),
  durationSecondsMax: z.number().int().min(0).max(86400).nullish(),
  sensoryCues: sensoryCuesSchema.optional(),
  tool: z.string().trim().max(64).nullish(),
  sourceClipId: idSchema.nullish(),
});

export const updateStepSchema = createStepSchema.partial().extend({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const reorderSchema = z.object({
  orderedIds: z.array(idSchema).min(1),
});

export const createIngredientSchema = z.object({
  name: z.string().trim().min(1, '请填写食材名').max(64),
  amountText: z.string().trim().max(64).nullish(),
  amountValue: z.number().nullish(),
  amountUnit: z.string().trim().max(16).nullish(),
  amountMin: z.number().nullish(),
  amountMax: z.number().nullish(),
  isVague: z.boolean().optional(),
  vagueItemId: idSchema.nullish(),
  note: z.string().trim().max(500).nullish(),
  orderIndex: z.number().int().min(0).optional(),
});

export const updateIngredientSchema = createIngredientSchema.partial().extend({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

/* ------------------------------------------------------------------ */
/* 音频                                                                */
/* ------------------------------------------------------------------ */

export const audioKindSchema = z.enum(AUDIO_KINDS);

export const uploadAudioFieldsSchema = z.object({
  recipeId: idSchema,
  kind: audioKindSchema,
  durationMs: z.coerce.number().int().min(0).max(24 * 3600 * 1000),
  peaks: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('not array');
        const values = parsed
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n))
          .map((n) => Math.min(1, Math.max(0, n)));
        return values.length ? values : null;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'peaks 必须是数字数组' });
        return z.NEVER;
      }
    }),
});

export const isAllowedAudioMime = (mime: string): boolean =>
  (ALLOWED_AUDIO_MIME_TYPES as readonly string[]).includes(mime);

export const createClipSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  label: z.string().trim().max(120).nullish(),
});

export const updateTranscriptSchema = z.object({
  transcript: z.string().max(20000),
  transcriptStatus: z.enum(['none', 'pending', 'done', 'failed']).optional(),
});

/* ------------------------------------------------------------------ */
/* 待澄清条目（核心）                                                  */
/* ------------------------------------------------------------------ */

export const createVagueItemSchema = z.object({
  category: z.enum(VAGUE_CATEGORIES),
  rawPhrase: z.string().trim().min(1, '请填写原话').max(500),
  transcript: z.string().trim().max(4000).nullish(),
  clipId: idSchema.nullish(),
  stepId: idSchema.nullish(),
  versionId: idSchema.nullish(),
  assigneeId: idSchema.nullish(),
});

export const updateVagueItemSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  category: z.enum(VAGUE_CATEGORIES).optional(),
  rawPhrase: z.string().trim().min(1).max(500).optional(),
  transcript: z.string().trim().max(4000).nullish(),
  stepId: idSchema.nullish(),
  versionId: idSchema.nullish(),
  assigneeId: idSchema.nullish(),
  clipId: idSchema.nullish(),
});

export const askVagueItemSchema = z.object({
  question: z.string().trim().min(1, '请填写追问内容').max(1000),
  assigneeId: idSchema.nullish(),
});

export const answerVagueItemSchema = z
  .object({
    answerText: z.string().trim().max(4000).nullish(),
    answerClipId: idSchema.nullish(),
  })
  .refine((v) => (v.answerText && v.answerText.length > 0) || !!v.answerClipId, {
    message: '答复内容不能为空：请填写文字或关联一段语音',
    path: ['answerText'],
  });

export const resolvedSpecSchema = z.object({
  type: z.enum(VAGUE_CATEGORIES),
  value: z.number().nullish(),
  unit: z.string().trim().max(16).nullish(),
  range: z
    .object({ min: z.number(), max: z.number() })
    .nullish(),
  reference: z.string().trim().max(500).nullish(),
  criterion: z.string().trim().max(1000).nullish(),
  substitute: z.string().trim().max(500).nullish(),
  evidence: z
    .object({
      clipId: idSchema.nullish(),
      answeredBy: idSchema.nullish(),
      answeredAt: z.string().nullish(),
    })
    .default({}),
  confidence: z.enum(CONFIDENCE_LEVELS),
  notes: z.string().trim().max(1000).nullish(),
});

export const resolveVagueItemSchema = z.object({
  resolvedSpec: resolvedSpecSchema,
  /** 可选：把结论同步写入某条用量或某一步 */
  applyToIngredientId: idSchema.nullish(),
  applyToStepId: idSchema.nullish(),
});

export const markUnresolvableSchema = z.object({
  note: z.string().trim().min(2, '请说明为什么这条无法确定').max(500),
});

/**
 * 重新确认一条已规格化的结论。
 *
 * 用在复做出现偏差之后：系统会把原有结论降级为"暂定"，
 * 整理者逐条复核后要么重新确认（这条其实没问题），要么重开（这条得改）。
 */
export const confirmVagueItemSchema = z.object({
  note: z.string().trim().max(500).nullish(),
});

export const reopenVagueItemSchema = z.object({
  reason: z.string().trim().min(2, '请说明重开原因').max(500),
});

/* ------------------------------------------------------------------ */
/* 评论 / 验证 / 通知                                                  */
/* ------------------------------------------------------------------ */

export const createCommentSchema = z.object({
  targetType: z.enum(COMMENT_TARGET_TYPES),
  targetId: idSchema,
  parentId: idSchema.nullish(),
  body: z.string().trim().min(1, '评论不能为空').max(2000),
  mentions: z.array(idSchema).max(20).default([]),
});

/**
 * 一条结构化偏差：按步骤定位到具体出问题的环节。
 *
 * - stepId：偏差发生在哪个步骤（可空 = 整道菜层面的问题，无法定位到步骤）
 * - category：偏差类型，可空（后端用规则库按描述自动识别）
 * - assigneeId：这条偏差该追问谁，可空（后端按步骤原声/历史答复自动推荐）
 */
export const deviationItemSchema = z.object({
  stepId: idSchema.nullish(),
  category: z.enum(VAGUE_CATEGORIES).nullish(),
  description: z.string().trim().min(2, '请写清这一条偏差').max(500),
  assigneeId: idSchema.nullish(),
});

export const createVerificationSchema = z
  .object({
    versionId: idSchema,
    result: z.enum(VERIFICATION_RESULTS),
    /** 旧式自由文本偏差说明（仍支持，会按句拆分成未定位步骤的条目） */
    deviations: z.string().trim().max(4000).nullish(),
    /**
     * 结构化偏差：每条定位到一个具体环节，
     * 提交后各自生成一条带追问、带指派人的待澄清条目。
     */
    deviationItems: z.array(deviationItemSchema).max(20).optional(),
    photoUrls: z.array(z.string().url()).max(20).default([]),
    voiceClipId: idSchema.nullish(),
    performedAt: z.string().datetime().optional(),
  })
  .refine(
    (v) =>
      v.result === 'success' ||
      ((v.deviations && v.deviations.length > 0) || (v.deviationItems?.length ?? 0) > 0),
    {
      message: '复做失败或部分成功时，必须至少填写一条偏差（按步骤逐条填写）',
      path: ['deviationItems'],
    },
  );

export type DeviationItemInput = z.infer<typeof deviationItemSchema>;

export const readNotificationsSchema = z.object({
  ids: z.array(idSchema).max(500).optional(),
  all: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* 查询参数                                                            */
/* ------------------------------------------------------------------ */

export const vagueItemQuerySchema = z.object({
  status: z.enum(['open', 'asked', 'answered', 'resolved', 'verified', 'unresolvable']).optional(),
  category: z.enum(VAGUE_CATEGORIES).optional(),
  assigneeId: idSchema.optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const audioQuerySchema = z.object({
  recipeId: idSchema.optional(),
  kind: z.enum(AUDIO_KINDS).optional(),
  transcriptStatus: z.enum(['none', 'pending', 'done', 'failed']).optional(),
  // 注意不能用 z.coerce.boolean()：它把字符串 "false" 也当成 true
  includeDeleted: booleanQuerySchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateRecipeInput = z.infer<typeof createRecipeSchema>;
export type CreateStepInput = z.infer<typeof createStepSchema>;
export type CreateIngredientInput = z.infer<typeof createIngredientSchema>;
export type CreateVagueItemInput = z.infer<typeof createVagueItemSchema>;
export type ResolveVagueItemInput = z.infer<typeof resolveVagueItemSchema>;
/**
 * 带 .default() 的 schema，其「输出类型」会把默认值字段变成必填。
 * 调用方（前端）传的是「输入类型」，所以这里用 z.input 而不是 z.infer。
 */
export type CreateVerificationInput = z.input<typeof createVerificationSchema>;
export type CreateCommentInput = z.input<typeof createCommentSchema>;
