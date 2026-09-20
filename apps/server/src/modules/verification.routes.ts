import { Router } from 'express';
import { createVerificationSchema, type DeviationItemInput } from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId } from '../lib/ids';
import { stringifyJson } from '../lib/json';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { assertClipInRecipe, assertRecipeRole, assertUsersInWorkspace } from '../services/access';
import { logActivity } from '../services/activity';
import { notify, workspaceMemberIds } from '../services/notify';
import { emitToWorkspace } from '../realtime/hub';
import { toVerificationDto } from '../services/serialize';
import {
  buildDeviationQuestion,
  detectCategory,
  loadVersionSteps,
  recommendAssignees,
} from '../services/deviations';
import type { DeviationEntry, VagueCategory } from '@froa/shared';

export const verificationRouter: Router = Router();

verificationRouter.use(requireAuth);

verificationRouter.get(
  '/recipes/:recipeId/verifications',
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');

    const runs = await prisma.verificationRun.findMany({
      where: { recipeId: recipeId! },
      include: {
        performer: { select: { id: true, displayName: true, avatarUrl: true } },
        reopenedItems: { select: { id: true } },
      },
      orderBy: { performedAt: 'desc' },
    });

    send(res, runs.map(toVerificationDto));
  }),
);

/** 旧式自由文本按句拆分成未定位步骤的偏差 */
function splitFreeTextDeviations(text: string): DeviationItemInput[] {
  const phrases = text
    .split(/[。；;\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .slice(0, 10);
  return (phrases.length ? phrases : [text.trim()]).map((description) => ({ description }));
}

/**
 * 提交复做验证 —— 这是闭环真正合上的动作。
 *
 * - success: 关联的已规格化条目升级为 verified（终态）；
 * - partial / fail: 偏差按步骤逐条提交（或退回自由文本），
 *   每条偏差自动生成一条"追问中"的待澄清条目：
 *     · 定位到具体步骤（stepId）；
 *     · 自动识别分类、自动生成追问话术；
 *     · 自动指派给最合适的人（该步骤上次的答复人 / 原声提供者），并发通知；
 *   同时把受影响步骤上的已规格化结论降级为"暂定"，逼着整理者逐条复核。
 */
verificationRouter.post(
  '/recipes/:recipeId/verifications',
  validateBody(createVerificationSchema),
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    const access = await assertRecipeRole(req.auth!.userId, recipeId!, 'contributor');

    const { versionId, result, deviations, deviationItems, photoUrls, voiceClipId, performedAt } =
      req.body as {
        versionId: string;
        result: 'success' | 'partial' | 'fail';
        deviations?: string | null;
        deviationItems?: DeviationItemInput[];
        photoUrls: string[];
        voiceClipId?: string | null;
        performedAt?: string;
      };

    const version = await prisma.recipeVersion.findUnique({ where: { id: versionId } });
    if (!version || version.recipeId !== recipeId) throw notFound('版本');

    // 复做反馈的录音也必须属于这张食谱，否则会挂上别人家的原声
    if (voiceClipId) await assertClipInRecipe(req.auth!.userId, voiceClipId, recipeId!);

    // 结构化偏差优先；为兼容旧客户端，没有结构化条目时退回自由文本拆分
    const rawDeviations: DeviationItemInput[] =
      deviationItems && deviationItems.length > 0
        ? deviationItems.slice(0, 20)
        : result !== 'success' && deviations?.trim()
          ? splitFreeTextDeviations(deviations)
          : [];

    if (result !== 'success' && rawDeviations.length === 0) {
      throw new ApiError('DEVIATION_REQUIRED');
    }

    // 提交的自由文本原文留档（结构化提交时拼成摘要），历史记录与导出仍可读
    const deviationsText =
      deviations?.trim() ||
      (rawDeviations.length
        ? rawDeviations.map((item) => item.description).join('；')
        : null);

    // ---- 提交前一次性完成定位解析：步骤校验、分类识别、指派人推荐 ----
    let resolvedDeviations: (DeviationItemInput & {
      stepTitle: string | null;
      stepOrder: number | null;
      category: VagueCategory;
      categoryAuto: boolean;
      assigneeId: string | null;
      assigneeAuto: boolean;
    })[] = [];

    if (rawDeviations.length) {
      const steps = await loadVersionSteps(versionId);
      const stepById = new Map(steps.map((step) => [step.id, step]));

      for (const item of rawDeviations) {
        if (item.stepId && !stepById.has(item.stepId)) {
          throw new ApiError('VALIDATION_FAILED', '偏差定位的步骤不属于该版本', {
            stepId: item.stepId,
          });
        }
      }

      // 显式指定的指派人必须在本空间内
      const explicitAssignees = rawDeviations
        .map((item) => item.assigneeId)
        .filter((id): id is string => Boolean(id));
      await assertUsersInWorkspace(access.workspaceId, [...new Set(explicitAssignees)]);

      const members = await workspaceMemberIds(access.workspaceId);
      const recommendations = await recommendAssignees({
        recipeId: recipeId!,
        stepIds: rawDeviations.map((item) => item.stepId ?? null),
        workspaceMemberIds: members,
        performerId: req.auth!.userId,
      });

      resolvedDeviations = rawDeviations.map((item) => {
        const step = item.stepId ? stepById.get(item.stepId) : null;
        const categoryAuto = !item.category;
        const assigneeAuto = !item.assigneeId;
        return {
          ...item,
          stepTitle: step?.title ?? null,
          stepOrder: step ? step.orderIndex : null,
          category: item.category ?? detectCategory(item.description),
          categoryAuto,
          assigneeId: item.assigneeId ?? recommendations.get(item.stepId ?? null) ?? null,
          assigneeAuto,
        };
      });
    }

    const reopenIds: string[] = [];
    const deviationEntries: DeviationEntry[] = [];
    /** 自动指派 -> 通知所需信息（事务外发通知） */
    const assignments: { assigneeId: string; question: string; rawPhrase: string; itemId: string }[] =
      [];

    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.verificationRun.create({
        data: {
          id: newId(),
          recipeId: recipeId!,
          versionId,
          performedBy: req.auth!.userId,
          performedAt: performedAt ? new Date(performedAt) : new Date(),
          result,
          deviations: deviationsText,
          // vagueItemId / assigneeName 在条目创建后于事务外回填
          deviationDetails: null,
          photoUrls: stringifyJson(photoUrls ?? []),
          voiceClipId: voiceClipId ?? null,
        },
      });

      if (result === 'success') {
        await tx.vagueItem.updateMany({
          where: { recipeId: recipeId!, status: 'resolved' },
          data: { status: 'verified' },
        });
      } else {
        // 每条偏差 -> 一条"追问中"的待澄清条目，直接进入追问回路
        for (const deviation of resolvedDeviations) {
          const question = buildDeviationQuestion(deviation.description, deviation.stepTitle);
          const item = await tx.vagueItem.create({
            data: {
              id: newId(),
              recipeId: recipeId!,
              versionId,
              stepId: deviation.stepId ?? null,
              category: deviation.category,
              rawPhrase: deviation.description,
              transcript: `来自复做反馈的偏差${deviation.stepTitle ? `（步骤：${deviation.stepTitle}）` : ''}`,
              status: deviation.assigneeId ? 'asked' : 'open',
              assigneeId: deviation.assigneeId,
              question: deviation.assigneeId ? question : null,
              questionAskedAt: deviation.assigneeId ? new Date() : null,
              reopenedFromVerificationId: created.id,
              createdBy: req.auth!.userId,
            },
          });
          reopenIds.push(item.id);

          if (deviation.assigneeId) {
            assignments.push({
              assigneeId: deviation.assigneeId,
              question,
              rawPhrase: deviation.description,
              itemId: item.id,
            });
          }

          deviationEntries.push({
            stepId: deviation.stepId ?? null,
            stepTitle: deviation.stepTitle,
            stepOrder: deviation.stepOrder,
            category: deviation.category,
            description: deviation.description,
            assigneeId: deviation.assigneeId,
            assigneeName: null, // 事务外批量补名字
            vagueItemId: item.id,
            categoryAuto: deviation.categoryAuto,
            assigneeAuto: deviation.assigneeAuto,
          });
        }

        // 只降级"受影响步骤"上的已规格化结论；无法定位到步骤的偏差则全部降级（保守处理）
        const affectedStepIds = [
          ...new Set(resolvedDeviations.map((d) => d.stepId).filter((id): id is string => Boolean(id))),
        ];
        const hasUnlocalized = resolvedDeviations.some((d) => !d.stepId);

        await tx.vagueItem.updateMany({
          where: {
            recipeId: recipeId!,
            status: 'resolved',
            ...(hasUnlocalized
              ? {}
              : { OR: [{ stepId: { in: affectedStepIds } }, { stepId: null }] }),
          },
          data: { confidence: 'assumed' },
        });
      }

      return created;
    });

    // ---- 事务外：补指派人名字、发通知 ----
    if (deviationEntries.length) {
      const nameRows = assignments.length
        ? await prisma.user.findMany({
            where: { id: { in: [...new Set(assignments.map((a) => a.assigneeId))] } },
            select: { id: true, displayName: true },
          })
        : [];
      const names = new Map(nameRows.map((row) => [row.id, row.displayName]));
      for (const entry of deviationEntries) {
        entry.assigneeName = entry.assigneeId ? (names.get(entry.assigneeId) ?? null) : null;
      }
      // 把名字也持久化进 deviationDetails，历史记录不用再联表
      await prisma.verificationRun.update({
        where: { id: run.id },
        data: { deviationDetails: stringifyJson(deviationEntries) },
      });

      // 每个被指派人收到一条（可能多条）"追问"通知
      for (const assignment of assignments) {
        await notify({
          userIds: [assignment.assigneeId],
          type: 'assigned',
          payload: {
            recipeId: recipeId!,
            itemId: assignment.itemId,
            rawPhrase: assignment.rawPhrase,
            question: assignment.question,
            verificationId: run.id,
            message: `复做出现偏差，需要你确认："${assignment.question}"`,
          },
        });
      }
    }

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'verification.create',
      entityType: 'vague_item',
      entityId: reopenIds[0] ?? run.id,
      after: {
        result,
        deviations: deviationsText,
        reopenedItemIds: reopenIds,
        deviationEntries: deviationEntries.map((entry) => ({
          stepId: entry.stepId,
          category: entry.category,
          assigneeId: entry.assigneeId,
          vagueItemId: entry.vagueItemId,
        })),
      },
    });

    const members = await workspaceMemberIds(access.workspaceId);
    await notify({
      userIds: members,
      // 复做成功有自己的通知类型：用 'published' 会显示成"版本动态"，语义不对
      type: result === 'success' ? 'verification_passed' : 'verification_failed',
      excludeUserId: req.auth!.userId,
      payload: {
        recipeId: recipeId!,
        versionId,
        verificationId: run.id,
        result,
        reopenedItemIds: reopenIds,
        message:
          result === 'success'
            ? `v${version.versionNo} 复做成功，结论已标记为"已验证"`
            : `v${version.versionNo} 复做出现偏差，已按步骤生成 ${reopenIds.length} 条追问${
                assignments.length ? `，其中 ${assignments.length} 条已自动指派` : ''
              }`,
      },
    });

    emitToWorkspace(access.workspaceId, 'verification:submitted', {
      recipeId: recipeId!,
      verificationId: run.id,
      result,
      reopenedItemIds: reopenIds,
    });

    created(res, {
      ...toVerificationDto({
        ...run,
        deviationDetails: stringifyJson(deviationEntries),
        reopenedItems: reopenIds.map((id) => ({ id })),
      }),
      reopenedItemIds: reopenIds,
    });
  }),
);
