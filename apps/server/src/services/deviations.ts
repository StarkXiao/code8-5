import {
  matchVaguePhrases,
  renderQuestionTemplate,
  fallbackQuestion,
  type VagueCategory,
} from '@froa/shared';
import { prisma } from '../db/client';

/**
 * 复做失败后的偏差定位与追问分派。
 *
 * 一条结构化偏差要回答三件事：
 *   1. 出在哪一步（stepId，可空 = 整道菜层面）；
 *   2. 是哪类问题（category，提交人没选就按描述文本自动识别）；
 *   3. 该追问谁（assigneeId，没指定就按"这一步的原声/上次回答这句话的人"自动推荐）。
 */

export interface StepInfo {
  id: string;
  title: string;
  orderIndex: number;
}

/**
 * 按偏差描述自动识别分类：复用录音工作台的同一套模糊描述规则库。
 * 命中多条时取第一条；一条都不命中归为"其他"。
 */
export function detectCategory(description: string): VagueCategory {
  const matches = matchVaguePhrases(description);
  return matches[0]?.category ?? 'other';
}

/**
 * 为一条偏差生成追问话术。
 * 能命中规则库时用规则模板（问题更具体），否则用兜底问法；
 * 定位到步骤时带上步骤名，被追问的人不用再猜"你说的是哪一步"。
 */
export function buildDeviationQuestion(description: string, stepTitle: string | null): string {
  const matches = matchVaguePhrases(description);
  const body = matches.length
    ? renderQuestionTemplate(matches[0]!.question, matches[0]!.matchedPattern)
    : fallbackQuestion(description);
  const prefix = stepTitle
    ? `【${stepTitle}】复做时发现：${description}。`
    : `复做时发现：${description}。`;
  return `${prefix}${body}`;
}

interface StepSignals {
  id: string;
  sourceClipId: string | null;
  clipOwnerId: string | null;
  /** 这一步条目证据里记录的答复人计数 */
  answererCounts: Map<string, number>;
  /** 这一步历史上被指派人的计数 */
  assigneeCounts: Map<string, number>;
}

function countByUser(items: { assigneeId: string | null }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.assigneeId) continue;
    counts.set(item.assigneeId, (counts.get(item.assigneeId) ?? 0) + 1);
  }
  return counts;
}

function pickMember(
  candidates: Map<string, number>,
  memberIds: Set<string>,
  excludeUserId: string,
): string | null {
  const eligible = [...candidates.entries()]
    .filter(([userId, count]) => userId !== excludeUserId && memberIds.has(userId) && count > 0)
    .sort((a, b) => b[1] - a[1]);
  return eligible[0]?.[0] ?? null;
}

/**
 * 为每条偏差推荐"该追问谁"。
 *
 * 优先级（都限本空间成员、且排除复做人本人）：
 *   1. 这一步已有结论（resolvedSpec）的证据里记录的答复人 —— 上次就是 TA 回答的；
 *   2. 这一步原声片段的上传人 —— 原话出自 TA；
 *   3. 这一步历史上被追问/被指派最多的人；
 *   4. 整道菜范围内被指派/答复最多的贡献者；
 *   5. 都没有就不指派，等整理者在追问台手动指人。
 *
 * 返回 stepId(null 代表整道菜层面) -> 推荐人 id（可能为 null）。
 */
export async function recommendAssignees(params: {
  recipeId: string;
  stepIds: (string | null)[];
  workspaceMemberIds: string[];
  performerId: string;
}): Promise<Map<string | null, string | null>> {
  const { recipeId, stepIds, workspaceMemberIds, performerId } = params;
  const memberIds = new Set(workspaceMemberIds);
  const result = new Map<string | null, string | null>();

  const uniqueStepIds = [...new Set(stepIds.filter((id): id is string => Boolean(id)))];

  const [steps, recipeItems, clips] = await Promise.all([
    uniqueStepIds.length
      ? prisma.step.findMany({
          where: { id: { in: uniqueStepIds } },
          select: {
            id: true,
            sourceClipId: true,
            vagueItems: {
              select: { assigneeId: true, resolvedSpec: true },
            },
          },
        })
      : Promise.resolve([]),
    prisma.vagueItem.findMany({
      where: { recipeId },
      select: { stepId: true, status: true, assigneeId: true, resolvedSpec: true },
    }),
    uniqueStepIds.length
      ? prisma.audioClip.findMany({
          where: { stepSources: { some: { id: { in: uniqueStepIds } } } },
          select: { id: true, audio: { select: { ownerId: true } } },
        })
      : Promise.resolve([]),
  ]);

  const clipOwners = new Map<string, string>();
  for (const clip of clips) clipOwners.set(clip.id, clip.audio.ownerId);

  // 4. 全食谱兜底：已规格化/已验证条目背后被指派的人
  const recipeAnswerers = countByUser(
    recipeItems.filter((item) => item.status === 'resolved' || item.status === 'verified'),
  );
  const recipeLevel = pickMember(recipeAnswerers, memberIds, performerId);

  // 无步骤偏差：整道菜层面的兜底
  if (stepIds.includes(null)) result.set(null, recipeLevel);

  const signalsByStep = new Map<string, StepSignals>();
  for (const step of steps) {
    const answererCounts = new Map<string, number>();
    for (const item of step.vagueItems) {
      if (!item.resolvedSpec) continue;
      try {
        const spec = JSON.parse(item.resolvedSpec) as {
          evidence?: { answeredBy?: string | null };
        };
        const answeredBy = spec.evidence?.answeredBy;
        if (answeredBy) answererCounts.set(answeredBy, (answererCounts.get(answeredBy) ?? 0) + 1);
      } catch {
        // 历史脏数据不影响推荐
      }
    }
    signalsByStep.set(step.id, {
      id: step.id,
      sourceClipId: step.sourceClipId,
      clipOwnerId: step.sourceClipId ? (clipOwners.get(step.sourceClipId) ?? null) : null,
      answererCounts,
      assigneeCounts: countByUser(step.vagueItems),
    });
  }

  for (const stepId of uniqueStepIds) {
    const signals = signalsByStep.get(stepId);
    if (!signals) {
      result.set(stepId, null);
      continue;
    }

    // 1. 这一步结论证据里的答复人
    let assignee = pickMember(signals.answererCounts, memberIds, performerId);

    // 2. 这一步原声的上传人
    if (!assignee && signals.clipOwnerId) {
      const owner = signals.clipOwnerId;
      if (owner !== performerId && memberIds.has(owner)) assignee = owner;
    }

    // 3. 这一步历史被指派人
    if (!assignee) {
      assignee = pickMember(signals.assigneeCounts, memberIds, performerId);
    }

    // 4. 全食谱兜底
    if (!assignee) assignee = recipeLevel;

    result.set(stepId, assignee);
  }

  return result;
}

/** 载入一个版本的步骤摘要（偏差定位校验用） */
export async function loadVersionSteps(versionId: string): Promise<StepInfo[]> {
  return prisma.step.findMany({
    where: { versionId },
    select: { id: true, title: true, orderIndex: true },
    orderBy: { orderIndex: 'asc' },
  });
}
