import { Router } from 'express';
import { createVerificationSchema, type VagueCategory, type VagueStatus } from '@froa/shared';
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
  createDeviationVagueItems,
  deviationSnapshot,
  normalizeDeviationInputs,
  type DeviationInput,
} from '../services/deviation';

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
        reopenedItems: {
          select: {
            id: true,
            rawPhrase: true,
            category: true,
            status: true,
            question: true,
            assigneeId: true,
            stepId: true,
            step: { select: { title: true, orderIndex: true } },
            assignee: { select: { displayName: true } },
          },
        },
      },
      orderBy: { performedAt: 'desc' },
    });

    send(
      res,
      runs.map((run) =>
        toVerificationDto({
          ...run,
          reopenedItems: run.reopenedItems.map((item) => ({
            id: item.id,
            rawPhrase: item.rawPhrase,
            category: item.category as VagueCategory,
            status: item.status as VagueStatus,
            question: item.question,
            assigneeId: item.assigneeId,
            assigneeName: item.assignee?.displayName ?? null,
            stepId: item.stepId,
            stepTitle: item.step?.title ?? null,
            stepOrder: item.step ? item.step.orderIndex + 1 : null,
          })),
        }),
      ),
    );
  }),
);

/**
 * 提交复做验证 —— 这是闭环真正合上的动作。
 *
 * - success: 关联的已规格化条目升级为 verified（终态）；
 * - partial / fail: 必填偏差说明。每条偏差都会：
 *   1) 定位到具体步骤（前端可逐条指定，落库前强校验属于本次验证版本）；
 *   2) 自动归类（火候/手感/用量/时间/其他）并生成对应问法的追问；
 *   3) 指派给合适的人（显式指定 > 该步骤原结论的被追问人 > 该分类最常答复的人），
 *      直接生成 status=asked 的待澄清条目并通知本人 —— 重新进入整理回路；
 *   4) 同时把这轮之前的已规格化结论降级为"暂定"，逼着整理者逐条复核。
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
        deviationItems?: DeviationInput[];
        photoUrls: string[];
        voiceClipId?: string | null;
        performedAt?: string;
      };

    const version = await prisma.recipeVersion.findUnique({ where: { id: versionId } });
    if (!version || version.recipeId !== recipeId) throw notFound('版本');

    // 复做反馈的录音也必须属于这张食谱，否则会挂上别人家的原声
    if (voiceClipId) await assertClipInRecipe(req.auth!.userId, voiceClipId, recipeId!);

    const inputs = normalizeDeviationInputs({ deviations, deviationItems });
    if (result !== 'success' && inputs.length === 0) {
      throw new ApiError('DEVIATION_REQUIRED');
    }

    // 偏差定位到的步骤必须属于本次验证的版本，且追问对象必须是本空间成员。
    // 不校验的话，一次复做反馈就能把追问条目挂到别的菜/别人家。
    if (inputs.length) {
      const stepIds = [...new Set(inputs.map((i) => i.stepId).filter(Boolean) as string[])];
      if (stepIds.length) {
        const steps = await prisma.step.findMany({
          where: { id: { in: stepIds } },
          select: { id: true, versionId: true, version: { select: { recipeId: true } } },
        });
        const validIds = new Set(
          steps
            .filter((step) => step.versionId === versionId && step.version.recipeId === recipeId)
            .map((step) => step.id),
        );
        const invalid = stepIds.filter((id) => !validIds.has(id));
        if (invalid.length) {
          throw new ApiError(
            'VALIDATION_FAILED',
            '偏差只能定位到本次验证版本里的步骤',
            { invalidStepIds: invalid },
          );
        }
      }

      const assigneeIds = [...new Set(inputs.map((i) => i.assigneeId).filter(Boolean) as string[])];
      await assertUsersInWorkspace(access.workspaceId, assigneeIds);
    }

    const snapshot = deviationSnapshot(inputs, deviations);
    let reopened: Awaited<ReturnType<typeof createDeviationVagueItems>> = [];

    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.verificationRun.create({
        data: {
          id: newId(),
          recipeId: recipeId!,
          versionId,
          performedBy: req.auth!.userId,
          performedAt: performedAt ? new Date(performedAt) : new Date(),
          result,
          deviations: snapshot,
          photoUrls: stringifyJson(photoUrls ?? []),
          voiceClipId: voiceClipId ?? null,
        },
      });

      if (result !== 'success') {
        reopened = await createDeviationVagueItems(tx, {
          recipeId: recipeId!,
          versionId,
          verificationId: created.id,
          performedBy: req.auth!.userId,
          inputs,
        });

        // 已规格化的结论降级：需要重新确认
        await tx.vagueItem.updateMany({
          where: { recipeId: recipeId!, status: 'resolved' },
          data: { confidence: 'assumed' },
        });
      } else {
        await tx.vagueItem.updateMany({
          where: { recipeId: recipeId!, status: 'resolved' },
          data: { status: 'verified' },
        });
      }

      return created;
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'verification.create',
      entityType: 'vague_item',
      entityId: reopened[0]?.id ?? run.id,
      after: {
        result,
        deviations: snapshot,
        reopenedItemIds: reopened.map((item) => item.id),
        assignments: reopened.map((item) => ({
          itemId: item.id,
          assigneeId: item.assigneeId,
          autoAssigned: item.autoAssigned,
          stepId: item.stepId,
          category: item.category,
        })),
      },
    });

    // 给每条被指派追问的人各发一条 —— 同一位家人被指派多条只通知一次，
    // 通知里带上条数，避免一口气刷出一排通知。
    if (reopened.length) {
      const byAssignee = new Map<string, { count: number; auto: boolean }>();
      for (const item of reopened) {
        if (!item.assigneeId) continue;
        const prev = byAssignee.get(item.assigneeId) ?? { count: 0, auto: false };
        prev.count += 1;
        prev.auto = prev.auto || item.autoAssigned;
        byAssignee.set(item.assigneeId, prev);
      }

      for (const [userId, { count, auto }] of byAssignee) {
        await notify({
          userIds: [userId],
          type: 'assigned',
          excludeUserId: req.auth!.userId,
          payload: {
            recipeId: recipeId!,
            versionId,
            verificationId: run.id,
            itemIds: reopened.filter((item) => item.assigneeId === userId).map((item) => item.id),
            count,
            autoAssigned: auto,
            message:
              count === 1
                ? `复做 v${version.versionNo} 时有一条偏差需要您确认："${
                    reopened.find((item) => item.assigneeId === userId)?.rawPhrase ?? ''
                  }"`
                : `复做 v${version.versionNo} 时有 ${count} 条偏差等着向您追问`,
          },
        });
      }

      // 没有指派到人的偏差，通知空间里的整理者们去追问台补派
      const unassigned = reopened.filter((item) => !item.assigneeId);
      if (unassigned.length) {
        const organizers = (
          await prisma.workspaceMember.findMany({
            where: { workspaceId: access.workspaceId, role: { in: ['owner', 'editor'] } },
            select: { userId: true },
          })
        ).map((member) => member.userId);

        await notify({
          userIds: organizers,
          type: 'verification_failed',
          excludeUserId: req.auth!.userId,
          payload: {
            recipeId: recipeId!,
            versionId,
            verificationId: run.id,
            result,
            unassignedCount: unassigned.length,
            reopenedItemIds: reopened.map((item) => item.id),
            message: `v${version.versionNo} 复做出现偏差，${unassigned.length} 条还没找到合适的人回答，请到追问台指派`,
          },
        });
      }

      // 其他成员收到一条"复做失败"广播；已被直接指派追问的人不重复打扰
      const members = await workspaceMemberIds(access.workspaceId);
      await notify({
        userIds: members.filter((id) => !byAssignee.has(id)),
        type: 'verification_failed',
        excludeUserId: req.auth!.userId,
        payload: {
          recipeId: recipeId!,
          versionId,
          verificationId: run.id,
          result,
          reopenedItemIds: reopened.map((item) => item.id),
          message: `v${version.versionNo} 复做出现偏差，已生成 ${reopened.length} 条追问并指派给相关家人`,
        },
      });
    } else if (result === 'success') {
      const members = await workspaceMemberIds(access.workspaceId);
      await notify({
        userIds: members,
        // 复做成功有自己的通知类型：用 'published' 会显示成"版本动态"，语义不对
        type: 'verification_passed',
        excludeUserId: req.auth!.userId,
        payload: {
          recipeId: recipeId!,
          versionId,
          verificationId: run.id,
          result,
          message: `v${version.versionNo} 复做成功，结论已标记为"已验证"`,
        },
      });
    }

    emitToWorkspace(access.workspaceId, 'verification:submitted', {
      recipeId: recipeId!,
      verificationId: run.id,
      result,
      reopenedItemIds: reopened.map((item) => item.id),
    });

    created(res, {
      ...toVerificationDto({
        ...run,
        reopenedItems: reopened.map((item) => ({
          id: item.id,
          rawPhrase: item.rawPhrase,
          category: item.category,
          status: 'asked' as const,
          question: item.question,
          assigneeId: item.assigneeId,
          stepId: item.stepId,
          stepTitle: item.stepTitle,
          stepOrder: item.stepOrder,
          autoAssigned: item.autoAssigned,
        })),
      }),
    });
  }),
);
