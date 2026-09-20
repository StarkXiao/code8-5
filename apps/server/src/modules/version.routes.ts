import { Router } from 'express';
import {
  createIngredientSchema,
  createStepSchema,
  forkVersionSchema,
  publishVersionSchema,
  reorderSchema,
  updateIngredientSchema,
  updateStepSchema,
  updateVersionSchema,
  type ResolvedSpec,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId } from '../lib/ids';
import { assertNotStale } from '../lib/concurrency';
import { parseJson, stringifyJson } from '../lib/json';
import { requireAuth } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { z } from 'zod';
import {
  assertClipInRecipe,
  assertIngredientRole,
  assertRecipeRole,
  assertStepRole,
  assertVagueItemInRecipe,
  assertVersionEditable,
  assertVersionRole,
} from '../services/access';
import { logActivity } from '../services/activity';
import { computeSpecDiff, computeVersionDiff, summarizeLoggedSpec, type SpecSnapshot } from '../services/diff';
import { renderRecipeMarkdown } from '../services/export';
import { notify, workspaceMemberIds } from '../services/notify';
import { emitToWorkspace } from '../realtime/hub';
import {
  toIngredientDto,
  toStepDto,
  toUserBrief,
  toVersionDto,
} from '../services/serialize';

export const versionRouter: Router = Router();

versionRouter.use(requireAuth);

const diffQuerySchema = z.object({ against: z.string().min(1).optional() });
const exportQuerySchema = z.object({ format: z.enum(['md', 'json']).default('md') });

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

async function loadVersionOrThrow(versionId: string) {
  const version = await prisma.recipeVersion.findUnique({
    where: { id: versionId },
    include: {
      steps: { orderBy: { orderIndex: 'asc' } },
      ingredients: { orderBy: { orderIndex: 'asc' } },
    },
  });
  if (!version) throw notFound('版本');
  return version;
}

/** 找出该食谱当前应作为 fork 基线的版本：优先已发布，其次最新版本 */
async function resolveForkSource(recipeId: string, fromVersionId?: string) {
  if (fromVersionId) {
    const version = await prisma.recipeVersion.findUnique({ where: { id: fromVersionId } });
    if (!version || version.recipeId !== recipeId) throw notFound('源版本');
    return version;
  }
  const published = await prisma.recipeVersion.findFirst({
    where: { recipeId, status: 'published' },
    orderBy: { versionNo: 'desc' },
  });
  if (published) return published;

  const latest = await prisma.recipeVersion.findFirst({
    where: { recipeId },
    orderBy: { versionNo: 'desc' },
  });
  if (!latest) throw notFound('版本');
  return latest;
}

/* ------------------------------------------------------------------ */
/* 版本列表与创建                                                      */
/* ------------------------------------------------------------------ */

/**
 * 重建某个时间点上、这张食谱里每条口述结论的状态。
 *
 * 数据来源是审计日志：每次"整理成结论"都记下了 after.resolvedSpec，
 * 而"重新打开 / 标记口语留白"表示该结论作废。按时间顺序重放即可还原历史，
 * 不需要额外的历史表。
 */
async function buildSpecSnapshots(recipeId: string, cutoff: Date): Promise<SpecSnapshot[]> {
  const items = await prisma.vagueItem.findMany({
    where: { recipeId },
    select: { id: true, rawPhrase: true },
  });
  if (!items.length) return [];

  const logs = await prisma.activityLog.findMany({
    where: {
      entityType: 'vague_item',
      entityId: { in: items.map((item) => item.id) },
      action: { in: ['vague_item.resolve', 'vague_item.reopen', 'vague_item.mark_unresolvable'] },
      createdAt: { lte: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    select: { entityId: true, action: true, diff: true },
  });

  const summaryById = new Map<string, string | null>();
  for (const log of logs) {
    if (log.action === 'vague_item.resolve') {
      const payload = parseJson<{ after?: { resolvedSpec?: unknown } }>(log.diff, {});
      summaryById.set(log.entityId, summarizeLoggedSpec(payload.after?.resolvedSpec));
    } else {
      summaryById.set(log.entityId, null);
    }
  }

  return items.map((item) => ({
    id: item.id,
    rawPhrase: item.rawPhrase,
    summary: summaryById.get(item.id) ?? null,
  }));
}

versionRouter.get(
  '/recipes/:recipeId/versions',
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');

    const versions = await prisma.recipeVersion.findMany({
      where: { recipeId: recipeId! },
      orderBy: { versionNo: 'desc' },
      include: {
        _count: { select: { steps: true, ingredients: true, verifications: true } },
      },
    });

    send(
      res,
      versions.map((version) => ({
        ...toVersionDto(version),
        counts: {
          steps: version._count.steps,
          ingredients: version._count.ingredients,
          verifications: version._count.verifications,
        },
      })),
    );
  }),
);

/**
 * fork 新草稿版本。
 * 已发布版本不可修改，因此"要改"永远意味着"派生一个新草稿"。
 */
versionRouter.post(
  '/recipes/:recipeId/versions',
  validateBody(forkVersionSchema),
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'editor');

    const existingDraft = await prisma.recipeVersion.findFirst({
      where: { recipeId: recipeId!, status: 'draft' },
    });
    if (existingDraft) throw new ApiError('VERSION_DUPLICATE_DRAFT');

    const { fromVersionId, title, summary } = req.body as {
      fromVersionId?: string;
      title?: string;
      summary?: string | null;
    };

    const source = await resolveForkSource(recipeId!, fromVersionId);
    const sourceFull = await loadVersionOrThrow(source.id);
    const maxVersion = await prisma.recipeVersion.aggregate({
      where: { recipeId: recipeId! },
      _max: { versionNo: true },
    });

    const draft = await prisma.$transaction(async (tx) => {
      const version = await tx.recipeVersion.create({
        data: {
          id: newId(),
          recipeId: recipeId!,
          versionNo: (maxVersion._max.versionNo ?? 0) + 1,
          parentVersionId: source.id,
          status: 'draft',
          title: title ?? sourceFull.title,
          summary: summary ?? sourceFull.summary ?? null,
          createdBy: req.auth!.userId,
        },
      });

      for (const step of sourceFull.steps) {
        await tx.step.create({
          data: {
            id: newId(),
            versionId: version.id,
            orderIndex: step.orderIndex,
            title: step.title,
            instruction: step.instruction,
            heatLevel: step.heatLevel,
            heatText: step.heatText,
            temperatureCMin: step.temperatureCMin,
            temperatureCMax: step.temperatureCMax,
            durationSecondsMin: step.durationSecondsMin,
            durationSecondsMax: step.durationSecondsMax,
            sensoryCues: step.sensoryCues,
            tool: step.tool,
            sourceClipId: step.sourceClipId,
          },
        });
      }

      for (const item of sourceFull.ingredients) {
        await tx.ingredient.create({
          data: {
            id: newId(),
            versionId: version.id,
            orderIndex: item.orderIndex,
            name: item.name,
            amountText: item.amountText,
            amountValue: item.amountValue,
            amountUnit: item.amountUnit,
            amountMin: item.amountMin,
            amountMax: item.amountMax,
            isVague: item.isVague,
            vagueItemId: item.vagueItemId,
            note: item.note,
          },
        });
      }

      return version;
    });

    const access = await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');
    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'version.fork',
      entityType: 'recipe_version',
      entityId: draft.id,
      after: { from: source.versionNo, versionNo: draft.versionNo },
    });

    created(res, toVersionDto(draft));
  }),
);

/* ------------------------------------------------------------------ */
/* 版本详情与编辑                                                      */
/* ------------------------------------------------------------------ */

versionRouter.get(
  '/versions/:versionId',
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    await assertVersionRole(req.auth!.userId, versionId!, 'viewer');

    const version = await loadVersionOrThrow(versionId!);
    const [creator, parent] = await Promise.all([
      prisma.user.findUnique({
        where: { id: version.createdBy },
        select: { id: true, displayName: true, avatarUrl: true },
      }),
      version.parentVersionId
        ? prisma.recipeVersion.findUnique({
            where: { id: version.parentVersionId },
            select: { id: true, versionNo: true },
          })
        : Promise.resolve(null),
    ]);

    send(res, {
      ...toVersionDto(version),
      creator: creator ? toUserBrief(creator) : null,
      parent: parent ?? null,
    });
  }),
);

versionRouter.patch(
  '/versions/:versionId',
  validateBody(updateVersionSchema),
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const { title, summary } = req.body as { title?: string; summary?: string | null };
    const current = await prisma.recipeVersion.findUnique({ where: { id: versionId! } });
    if (!current) throw notFound('版本');
    assertNotStale(
      current.updatedAt,
      (req.body as { expectedUpdatedAt?: string }).expectedUpdatedAt,
      { current: toVersionDto(current) },
    );

    const version = await prisma.recipeVersion.update({
      where: { id: versionId! },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'version.update',
      entityType: 'recipe_version',
      entityId: version.id,
      after: { title: version.title },
    });

    send(res, toVersionDto(version));
  }),
);

versionRouter.post(
  '/versions/:versionId/submit',
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'editor');
    if (access.versionStatus !== 'draft') throw new ApiError('VERSION_INVALID_TRANSITION');

    const version = await prisma.recipeVersion.update({
      where: { id: versionId! },
      data: { status: 'in_review' },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'version.submit',
      entityType: 'recipe_version',
      entityId: version.id,
    });

    send(res, toVersionDto(version));
  }),
);

versionRouter.post(
  '/versions/:versionId/reopen',
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'editor');
    if (access.versionStatus !== 'in_review') throw new ApiError('VERSION_INVALID_TRANSITION');

    const version = await prisma.recipeVersion.update({
      where: { id: versionId! },
      data: { status: 'draft' },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'version.reopen',
      entityType: 'recipe_version',
      entityId: version.id,
    });

    send(res, toVersionDto(version));
  }),
);

/**
 * 发布版本。
 *
 * 发布前的硬性守卫：
 * 1. 变更说明必填（否则版本历史没有"为什么改"）；
 * 2. 不存在"暂定(assumed)"的规格 —— 暂定值必须先确认或标记为口语留白。
 */
versionRouter.post(
  '/versions/:versionId/publish',
  validateBody(publishVersionSchema),
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'editor');
    if (access.versionStatus !== 'in_review') throw new ApiError('VERSION_INVALID_TRANSITION');

    const { changeNote, force } = req.body as { changeNote: string; force?: boolean };

    const assumed = await prisma.vagueItem.findMany({
      where: { recipeId: access.recipeId, status: 'resolved', confidence: 'assumed' },
      select: { id: true, rawPhrase: true },
    });
    if (assumed.length && !force) {
      throw new ApiError(
        'SPEC_ASSUMED_UNCONFIRMED',
        `还有 ${assumed.length} 条结论处于"暂定"状态，请先确认或标记为口语留白后再发布`,
        assumed,
      );
    }

    const published = await prisma.$transaction(async (tx) => {
      await tx.recipeVersion.updateMany({
        where: { recipeId: access.recipeId, status: 'published' },
        data: { status: 'archived' },
      });

      const version = await tx.recipeVersion.update({
        where: { id: versionId! },
        data: { status: 'published', publishedAt: new Date(), changeNote },
      });

      await tx.recipe.update({
        where: { id: access.recipeId },
        data: { updatedAt: new Date() },
      });

      return version;
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'version.publish',
      entityType: 'recipe_version',
      entityId: published.id,
      after: { versionNo: published.versionNo, changeNote, forced: Boolean(force) },
    });

    const members = await workspaceMemberIds(access.workspaceId);
    await notify({
      userIds: members,
      type: 'published',
      excludeUserId: req.auth!.userId,
      payload: {
        recipeId: access.recipeId,
        versionId: published.id,
        versionNo: published.versionNo,
        title: published.title,
        message: `v${published.versionNo}「${published.title}」已发布，可以去复做验证了`,
      },
    });

    emitToWorkspace(access.workspaceId, 'version:published', {
      recipeId: access.recipeId,
      versionId: published.id,
      versionNo: published.versionNo,
    });

    send(res, toVersionDto(published));
  }),
);

/* ------------------------------------------------------------------ */
/* 版本差异                                                            */
/* ------------------------------------------------------------------ */

versionRouter.get(
  '/versions/:versionId/diff',
  validateQuery(diffQuerySchema),
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'viewer');

    const target = await loadVersionOrThrow(versionId!);
    const againstId = (req.query.against as string | undefined) ?? target.parentVersionId ?? undefined;

    if (!againstId) {
      // 没有父版本可比：全部内容视为新增，前端展示"首个版本"
      const diff = computeVersionDiff(
        { id: target.id, versionNo: target.versionNo, steps: [], ingredients: [] },
        {
          id: target.id,
          versionNo: target.versionNo,
          steps: target.steps.map(toStepDto),
          ingredients: target.ingredients.map(toIngredientDto),
        },
      );
      send(res, { ...diff, isInitial: true });
      return;
    }

    const base = await prisma.recipeVersion.findUnique({ where: { id: againstId } });
    if (!base || base.recipeId !== access.recipeId) throw notFound('对照版本');
    const baseFull = await loadVersionOrThrow(base.id);

    // 把"这条差异是因为哪句口述整理出来的"接到差异项上。
    // 差异按 step.title 与 ingredient.name 对齐，所以来源也必须按这两个键建索引 ——
    // 早先这里用原话当键，永远匹配不上，等于没有来源信息。
    const vagueItems = await prisma.vagueItem.findMany({
      where: { recipeId: access.recipeId, status: { in: ['resolved', 'verified'] } },
      select: { id: true, rawPhrase: true, stepId: true, versionId: true },
    });

    const sourcesByKey = new Map<string, { kind: 'vague_item'; id: string; label: string }[]>();
    const pushSource = (key: string, item: { id: string; rawPhrase: string }) => {
      const existing = sourcesByKey.get(key) ?? [];
      existing.push({ kind: 'vague_item', id: item.id, label: item.rawPhrase });
      sourcesByKey.set(key, existing);
    };

    const stepIds = vagueItems.map((item) => item.stepId).filter((id): id is string => Boolean(id));
    if (stepIds.length) {
      const linkedSteps = await prisma.step.findMany({
        where: { id: { in: stepIds } },
        select: { id: true, title: true },
      });
      const titleByStepId = new Map(linkedSteps.map((step) => [step.id, step.title]));
      for (const item of vagueItems) {
        const title = item.stepId ? titleByStepId.get(item.stepId) : undefined;
        if (title) pushSource(`step:${title}`, item);
      }
    }

    // 已写进用量的结论：按关联的用量名建索引
    const linkedIngredients = await prisma.ingredient.findMany({
      where: { versionId: target.id, vagueItemId: { not: null } },
      select: { name: true, vagueItem: { select: { id: true, rawPhrase: true } } },
    });
    for (const ingredient of linkedIngredients) {
      if (ingredient.vagueItem) pushSource(`ingredient:${ingredient.name}`, ingredient.vagueItem);
    }

    const diff = computeVersionDiff(
      {
        id: base.id,
        versionNo: base.versionNo,
        steps: baseFull.steps.map(toStepDto),
        ingredients: baseFull.ingredients.map(toIngredientDto),
      },
      {
        id: target.id,
        versionNo: target.versionNo,
        steps: target.steps.map(toStepDto),
        ingredients: target.ingredients.map(toIngredientDto),
      },
      sourcesByKey,
    );

    // 结论差异：重建"基准版本那一刻"与"目标版本那一刻"两套规格快照再比对。
    // 直接按 versionId 匹配是行不通的（见 services/diff.ts 的说明）。
    const baseCutoff = base.publishedAt ?? base.createdAt;
    const targetCutoff = target.publishedAt ?? new Date();

    const specEntries = computeSpecDiff(
      await buildSpecSnapshots(access.recipeId, baseCutoff),
      await buildSpecSnapshots(access.recipeId, targetCutoff),
    );

    send(res, { ...diff, entries: [...diff.entries, ...specEntries], specEntries });
  }),
);

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

versionRouter.get(
  '/versions/:versionId/export',
  validateQuery(exportQuerySchema),
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'viewer');
    const format = (req.query.format as 'md' | 'json' | undefined) ?? 'md';

    const version = await loadVersionOrThrow(versionId!);
    const recipe = await prisma.recipe.findUnique({ where: { id: access.recipeId } });
    if (!recipe) throw notFound('食谱');

    const vagueItems = await prisma.vagueItem.findMany({
      where: { recipeId: access.recipeId },
      include: {
        clip: { include: { audio: { select: { id: true, kind: true, createdAt: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const verifications = await prisma.verificationRun.findMany({
      where: { versionId: version.id },
      include: { performer: { select: { id: true, displayName: true, avatarUrl: true } } },
      orderBy: { performedAt: 'desc' },
    });

    const payload = {
      recipe: { title: recipe.title, dishCategory: recipe.dishCategory },
      version: {
        versionNo: version.versionNo,
        title: version.title,
        summary: version.summary,
        changeNote: version.changeNote,
        publishedAt: version.publishedAt ? version.publishedAt.toISOString() : null,
      },
      steps: version.steps.map(toStepDto),
      ingredients: version.ingredients.map(toIngredientDto),
      specs: vagueItems.map((item) => ({
        rawPhrase: item.rawPhrase,
        category: item.category as ResolvedSpec['type'],
        status: item.status,
        resolvedSpec: item.resolvedSpec ? parseJson<ResolvedSpec | null>(item.resolvedSpec, null) : null,
        question: item.question,
        answerText: item.answerText,
        unresolvableNote: item.unresolvableNote,
        clipLabel: item.clip?.label ?? null,
      })),
      verifications: verifications.map((run) => ({
        performedAt: run.performedAt.toISOString(),
        performedByName: run.performer.displayName,
        result: run.result,
        deviations: run.deviations,
        deviationEntries: run.deviationDetails ? parseJson(run.deviationDetails, []) : [],
      })),
    };

    if (format === 'json') {
      send(res, payload);
      return;
    }

    const markdown = renderRecipeMarkdown(payload);
    const filename = encodeURIComponent(`${recipe.title}-v${version.versionNo}.md`);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(markdown);
  }),
);

/* ------------------------------------------------------------------ */
/* 步骤                                                                */
/* ------------------------------------------------------------------ */

versionRouter.get(
  '/versions/:versionId/steps',
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    await assertVersionRole(req.auth!.userId, versionId!, 'viewer');

    const steps = await prisma.step.findMany({
      where: { versionId: versionId! },
      orderBy: { orderIndex: 'asc' },
    });
    send(res, steps.map(toStepDto));
  }),
);

versionRouter.post(
  '/versions/:versionId/steps',
  validateBody(createStepSchema),
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const last = await prisma.step.aggregate({
      where: { versionId: versionId! },
      _max: { orderIndex: true },
    });

    if (req.body.sourceClipId) {
      await assertClipInRecipe(req.auth!.userId, req.body.sourceClipId, access.recipeId);
    }

    const step = await prisma.step.create({
      data: {
        id: newId(),
        versionId: versionId!,
        orderIndex: (last._max.orderIndex ?? -1) + 1,
        title: req.body.title,
        instruction: req.body.instruction,
        heatLevel: req.body.heatLevel ?? null,
        heatText: req.body.heatText ?? null,
        temperatureCMin: req.body.temperatureCMin ?? null,
        temperatureCMax: req.body.temperatureCMax ?? null,
        durationSecondsMin: req.body.durationSecondsMin ?? null,
        durationSecondsMax: req.body.durationSecondsMax ?? null,
        sensoryCues: stringifyJson(req.body.sensoryCues ?? []),
        tool: req.body.tool ?? null,
        sourceClipId: req.body.sourceClipId ?? null,
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'step.create',
      entityType: 'step',
      entityId: step.id,
      after: { title: step.title },
    });

    created(res, toStepDto(step));
  }),
);

versionRouter.post(
  '/versions/:versionId/steps/reorder',
  validateBody(reorderSchema),
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const { orderedIds } = req.body as { orderedIds: string[] };
    const existing = await prisma.step.findMany({
      where: { versionId: versionId! },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((step) => step.id));
    if (orderedIds.length !== existingIds.size || orderedIds.some((id) => !existingIds.has(id))) {
      throw new ApiError('VALIDATION_FAILED', '排序列表必须恰好包含该版本的全部步骤');
    }

    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.step.update({ where: { id }, data: { orderIndex: index } }),
      ),
    );

    const steps = await prisma.step.findMany({
      where: { versionId: versionId! },
      orderBy: { orderIndex: 'asc' },
    });
    send(res, steps.map(toStepDto));
  }),
);

versionRouter.patch(
  '/steps/:stepId',
  validateBody(updateStepSchema),
  asyncHandler(async (req, res) => {
    const { stepId } = req.params;
    const access = await assertStepRole(req.auth!.userId, stepId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const before = await prisma.step.findUnique({ where: { id: stepId! } });
    if (!before) throw notFound('步骤');

    const body = req.body as Record<string, unknown>;
    assertNotStale(before.updatedAt, body.expectedUpdatedAt as string | undefined, {
      current: toStepDto(before),
    });

    if (body.sourceClipId) {
      await assertClipInRecipe(req.auth!.userId, body.sourceClipId as string, access.recipeId);
    }

    const step = await prisma.step.update({
      where: { id: stepId! },
      data: {
        ...(body.title !== undefined ? { title: body.title as string } : {}),
        ...(body.instruction !== undefined ? { instruction: body.instruction as string } : {}),
        ...(body.heatLevel !== undefined ? { heatLevel: body.heatLevel as string | null } : {}),
        ...(body.heatText !== undefined ? { heatText: body.heatText as string | null } : {}),
        ...(body.temperatureCMin !== undefined
          ? { temperatureCMin: body.temperatureCMin as number | null }
          : {}),
        ...(body.temperatureCMax !== undefined
          ? { temperatureCMax: body.temperatureCMax as number | null }
          : {}),
        ...(body.durationSecondsMin !== undefined
          ? { durationSecondsMin: body.durationSecondsMin as number | null }
          : {}),
        ...(body.durationSecondsMax !== undefined
          ? { durationSecondsMax: body.durationSecondsMax as number | null }
          : {}),
        ...(body.sensoryCues !== undefined
          ? { sensoryCues: stringifyJson(body.sensoryCues) }
          : {}),
        ...(body.tool !== undefined ? { tool: body.tool as string | null } : {}),
        ...(body.sourceClipId !== undefined ? { sourceClipId: body.sourceClipId as string | null } : {}),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'step.update',
      entityType: 'step',
      entityId: step.id,
      before: { title: before.title, instruction: before.instruction },
      after: { title: step.title, instruction: step.instruction },
    });

    send(res, toStepDto(step));
  }),
);

versionRouter.delete(
  '/steps/:stepId',
  asyncHandler(async (req, res) => {
    const { stepId } = req.params;
    const access = await assertStepRole(req.auth!.userId, stepId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const step = await prisma.step.delete({ where: { id: stepId! } });

    // 删除后重排，保证 orderIndex 连续
    const remaining = await prisma.step.findMany({
      where: { versionId: step.versionId },
      orderBy: { orderIndex: 'asc' },
      select: { id: true },
    });
    await prisma.$transaction(
      remaining.map((item, index) => prisma.step.update({ where: { id: item.id }, data: { orderIndex: index } })),
    );

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'step.delete',
      entityType: 'step',
      entityId: stepId!,
      before: { title: step.title },
    });

    send(res, { removed: stepId });
  }),
);

/* ------------------------------------------------------------------ */
/* 用量                                                                */
/* ------------------------------------------------------------------ */

versionRouter.get(
  '/versions/:versionId/ingredients',
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    await assertVersionRole(req.auth!.userId, versionId!, 'viewer');

    const ingredients = await prisma.ingredient.findMany({
      where: { versionId: versionId! },
      orderBy: { orderIndex: 'asc' },
    });
    send(res, ingredients.map(toIngredientDto));
  }),
);

versionRouter.post(
  '/versions/:versionId/ingredients',
  validateBody(createIngredientSchema),
  asyncHandler(async (req, res) => {
    const { versionId } = req.params;
    const access = await assertVersionRole(req.auth!.userId, versionId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const last = await prisma.ingredient.aggregate({
      where: { versionId: versionId! },
      _max: { orderIndex: true },
    });

    if (req.body.vagueItemId) {
      await assertVagueItemInRecipe(req.auth!.userId, req.body.vagueItemId, access.recipeId);
    }

    const ingredient = await prisma.ingredient.create({
      data: {
        id: newId(),
        versionId: versionId!,
        orderIndex: req.body.orderIndex ?? (last._max.orderIndex ?? -1) + 1,
        name: req.body.name,
        amountText: req.body.amountText ?? null,
        amountValue: req.body.amountValue ?? null,
        amountUnit: req.body.amountUnit ?? null,
        amountMin: req.body.amountMin ?? null,
        amountMax: req.body.amountMax ?? null,
        isVague: req.body.isVague ?? false,
        vagueItemId: req.body.vagueItemId ?? null,
        note: req.body.note ?? null,
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'ingredient.create',
      entityType: 'ingredient',
      entityId: ingredient.id,
      after: { name: ingredient.name },
    });

    created(res, toIngredientDto(ingredient));
  }),
);

versionRouter.patch(
  '/ingredients/:ingredientId',
  validateBody(updateIngredientSchema),
  asyncHandler(async (req, res) => {
    const { ingredientId } = req.params;
    const access = await assertIngredientRole(req.auth!.userId, ingredientId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const before = await prisma.ingredient.findUnique({ where: { id: ingredientId! } });
    if (!before) throw notFound('用量');

    const body = req.body as Record<string, unknown>;
    assertNotStale(before.updatedAt, body.expectedUpdatedAt as string | undefined, {
      current: toIngredientDto(before),
    });

    if (body.vagueItemId) {
      await assertVagueItemInRecipe(req.auth!.userId, body.vagueItemId as string, access.recipeId);
    }

    const ingredient = await prisma.ingredient.update({
      where: { id: ingredientId! },
      data: {
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.amountText !== undefined ? { amountText: body.amountText as string | null } : {}),
        ...(body.amountValue !== undefined ? { amountValue: body.amountValue as number | null } : {}),
        ...(body.amountUnit !== undefined ? { amountUnit: body.amountUnit as string | null } : {}),
        ...(body.amountMin !== undefined ? { amountMin: body.amountMin as number | null } : {}),
        ...(body.amountMax !== undefined ? { amountMax: body.amountMax as number | null } : {}),
        ...(body.isVague !== undefined ? { isVague: body.isVague as boolean } : {}),
        ...(body.vagueItemId !== undefined ? { vagueItemId: body.vagueItemId as string | null } : {}),
        ...(body.note !== undefined ? { note: body.note as string | null } : {}),
        ...(body.orderIndex !== undefined ? { orderIndex: body.orderIndex as number } : {}),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'ingredient.update',
      entityType: 'ingredient',
      entityId: ingredient.id,
      before: { amountValue: before.amountValue, amountUnit: before.amountUnit },
      after: { amountValue: ingredient.amountValue, amountUnit: ingredient.amountUnit },
    });

    send(res, toIngredientDto(ingredient));
  }),
);

versionRouter.delete(
  '/ingredients/:ingredientId',
  asyncHandler(async (req, res) => {
    const { ingredientId } = req.params;
    const access = await assertIngredientRole(req.auth!.userId, ingredientId!, 'editor');
    assertVersionEditable(access.versionStatus);

    const ingredient = await prisma.ingredient.delete({ where: { id: ingredientId! } });
    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'ingredient.delete',
      entityType: 'ingredient',
      entityId: ingredientId!,
      before: { name: ingredient.name },
    });
    send(res, { removed: ingredientId });
  }),
);
