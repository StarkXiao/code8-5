import {
  buildDeviationQuestion,
  classifyDeviation,
  splitDeviationText,
  type VagueCategory,
} from '@froa/shared';
import type { Prisma } from '@prisma/client';
import { newId } from '../lib/ids';

type Tx = Prisma.TransactionClient;

export interface DeviationInput {
  text: string;
  stepId?: string | null;
  category?: VagueCategory | null;
  assigneeId?: string | null;
}

export interface CreatedDeviationItem {
  id: string;
  rawPhrase: string;
  category: VagueCategory;
  question: string;
  assigneeId: string | null;
  stepId: string | null;
  stepTitle: string | null;
  stepOrder: number | null;
  autoAssigned: boolean;
}

/**
 * 把复做提交里的偏差入参归一化成结构化列表。
 *
 * 新客户端传 deviationItems（逐条带步骤）；旧客户端只传 deviations 一段文本，
 * 这里按句拆开兜底，保证老脚本的闭环不被破坏。
 */
export function normalizeDeviationInputs(body: {
  deviations?: string | null;
  deviationItems?: DeviationInput[] | null;
}): DeviationInput[] {
  const items = body.deviationItems ?? [];
  if (items.length) {
    return items.map((item) => ({
      text: item.text.trim(),
      stepId: item.stepId ?? null,
      category: item.category ?? null,
      assigneeId: item.assigneeId ?? null,
    }));
  }
  return splitDeviationText(body.deviations ?? '').map((text) => ({
    text,
    stepId: null,
    category: null,
    assigneeId: null,
  }));
}

/** 把整段偏差文本保存为验证记录的快照（结构化提交时按行拼接，历史记录仍可通读） */
export function deviationSnapshot(inputs: DeviationInput[], rawText?: string | null): string | null {
  if (!inputs.length) return rawText?.trim() ? rawText.trim() : null;
  return inputs.map((item) => item.text).join('\n');
}

interface StepContext {
  id: string;
  title: string;
  orderIndex: number;
}

/**
 * 为一条偏差挑"合适的人"：
 *
 * 1. 显式指派优先；
 * 2. 该步骤（或该分类）已有结论的原始答复人 —— 谁当初回答的，就回去问谁；
 * 3. 该分类条目最常被指派/答复的人 —— "这类问题一直是外婆回答的"；
 * 4. 实在没有就空着（待澄清条目允许无人认领，整理者可在追问台补派）。
 */
async function pickAssignee(
  tx: Tx,
  recipeId: string,
  category: VagueCategory,
  stepId: string | null,
): Promise<string | null> {
  if (stepId) {
    const stepItem = await tx.vagueItem.findFirst({
      where: { recipeId, stepId },
      orderBy: { resolvedAt: 'desc' },
      select: { answerClipId: true, createdBy: true, assigneeId: true },
    });
    // answerClip 是答复人录的，但记录里没有直接的 answeredBy；
    // assigneeId 即当时被追问的人，是最可靠的"原话出处"。
    if (stepItem?.assigneeId) return stepItem.assigneeId;
  }

  const sameCategory = await tx.vagueItem.findMany({
    where: { recipeId, category, assigneeId: { not: null } },
    select: { assigneeId: true },
    take: 50,
  });

  const votes = new Map<string, number>();
  for (const row of sameCategory) {
    if (!row.assigneeId) continue;
    votes.set(row.assigneeId, (votes.get(row.assigneeId) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [userId, count] of votes) {
    if (count > bestCount) {
      best = userId;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 复做失败回路的核心：逐条偏差 → 定位步骤 → 归类 → 生成追问 → 指派 → 落库。
 *
 * 生成的条目直接进入 asked（追问中）状态：追问内容与责任人都已齐备，
 * 不需要整理者再手工点一次"追问"。它们仍可在追问台改派、改问法。
 */
export async function createDeviationVagueItems(
  tx: Tx,
  params: {
    recipeId: string;
    versionId: string;
    verificationId: string;
    performedBy: string;
    inputs: DeviationInput[];
  },
): Promise<CreatedDeviationItem[]> {
  const { recipeId, versionId, verificationId, performedBy, inputs } = params;

  const steps = await tx.step.findMany({
    where: { versionId },
    select: { id: true, title: true, orderIndex: true },
  });
  const stepById = new Map<string, StepContext>(steps.map((step) => [step.id, step]));

  const today = new Date().toISOString().slice(0, 10);
  const created: CreatedDeviationItem[] = [];

  for (const input of inputs) {
    const step = input.stepId ? stepById.get(input.stepId) ?? null : null;
    const { category } = classifyDeviation(input.text, input.category);

    const autoAssigned = !input.assigneeId;
    const assigneeId = input.assigneeId ?? (await pickAssignee(tx, recipeId, category, step?.id ?? null));

    const question = buildDeviationQuestion(input.text, category, {
      stepOrder: step ? step.orderIndex + 1 : null,
      stepTitle: step?.title ?? null,
    });

    const id = newId();
    await tx.vagueItem.create({
      data: {
        id,
        recipeId,
        versionId,
        stepId: step?.id ?? null,
        category,
        rawPhrase: input.text,
        transcript: `来自 ${today} 的复做反馈（偏差打回）`,
        status: 'asked',
        question,
        questionAskedAt: new Date(),
        assigneeId,
        reopenedFromVerificationId: verificationId,
        createdBy: performedBy,
      },
    });

    created.push({
      id,
      rawPhrase: input.text,
      category,
      question,
      assigneeId,
      stepId: step?.id ?? null,
      stepTitle: step?.title ?? null,
      stepOrder: step ? step.orderIndex + 1 : null,
      autoAssigned,
    });
  }

  return created;
}
