import type { IngredientDto, ResolvedSpec, StepDto } from '@froa/shared';
import { HEAT_LEVEL_LABELS, VAGUE_CATEGORY_LABELS, formatSpecSummary } from '@froa/shared';
import type { VagueCategory } from '@froa/shared';

export interface ExportSpec {
  rawPhrase: string;
  category: VagueCategory;
  status: string;
  resolvedSpec: ResolvedSpec | null;
  question: string | null;
  answerText: string | null;
  unresolvableNote: string | null;
  clipLabel: string | null;
}

export interface ExportDeviation {
  stepTitle: string | null;
  category: VagueCategory;
  description: string;
  assigneeName: string | null;
}

export interface ExportVerification {
  performedAt: string;
  performedByName: string;
  result: string;
  deviations: string | null;
  deviationEntries?: ExportDeviation[];
}

export interface ExportInput {
  recipe: { title: string; dishCategory: string | null };
  version: {
    versionNo: number;
    title: string;
    summary: string | null;
    changeNote: string | null;
    publishedAt: string | null;
  };
  steps: StepDto[];
  ingredients: IngredientDto[];
  specs: ExportSpec[];
  verifications: ExportVerification[];
}

const RESULT_LABELS: Record<string, string> = {
  success: '成功',
  partial: '部分成功',
  fail: '失败',
};

function formatDuration(step: StepDto): string {
  const { durationSecondsMin: min, durationSecondsMax: max } = step;
  if (min === null && max === null) return '';
  if (min !== null && max !== null) return min === max ? `${min} 秒` : `${min}-${max} 秒`;
  return `${min ?? max} 秒`;
}

function formatAmount(item: IngredientDto): string {
  if (item.amountValue !== null) return `${item.amountValue}${item.amountUnit ?? ''}`;
  if (item.amountMin !== null || item.amountMax !== null) {
    return `${item.amountMin ?? '?'}-${item.amountMax ?? '?'}${item.amountUnit ?? ''}`;
  }
  return item.amountText ?? '适量';
}

// 把已发布版本导出成一份可交付的 Markdown 食谱。
// 内容包含用量表、步骤、每条模糊口述的整理结论与依据、复做验证历史。
export function renderRecipeMarkdown(input: ExportInput): string {
  const { recipe, version, steps, ingredients, specs, verifications } = input;
  const lines: string[] = [];

  lines.push(`# ${recipe.title}`);
  lines.push('');

  const meta: string[] = [`**版本**：v${version.versionNo}`];
  if (recipe.dishCategory) meta.push(`**分类**：${recipe.dishCategory}`);
  if (version.publishedAt) meta.push(`**发布时间**：${version.publishedAt.slice(0, 10)}`);
  lines.push(meta.join(' ｜ '));
  lines.push('');

  if (version.summary) {
    lines.push(`> ${version.summary}`);
    lines.push('');
  }

  lines.push('## 用量');
  lines.push('');
  if (!ingredients.length) {
    lines.push('_暂无用量记录_');
  } else {
    lines.push('| 食材 | 用量 | 原话 | 备注 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of ingredients) {
      const amount = formatAmount(item);
      const raw = item.isVague ? (item.amountText ?? '—') : '—';
      const note = item.note ?? (item.isVague ? '由模糊口述整理而来' : '—');
      lines.push(`| ${item.name} | ${amount} | ${raw} | ${note} |`);
    }
  }
  lines.push('');

  lines.push('## 步骤');
  lines.push('');
  if (!steps.length) {
    lines.push('_暂无步骤_');
  } else {
    [...steps]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .forEach((step, index) => {
        lines.push(`### ${index + 1}. ${step.title}`);
        lines.push('');
        lines.push(step.instruction);
        lines.push('');

        const details: string[] = [];
        if (step.heatLevel) details.push(`火候：${HEAT_LEVEL_LABELS[step.heatLevel]}`);
        if (step.heatText) details.push(`原话火候：${step.heatText}`);
        if (step.temperatureCMin !== null || step.temperatureCMax !== null) {
          details.push(`温度：${step.temperatureCMin ?? '?'}-${step.temperatureCMax ?? '?'} ℃`);
        }
        const duration = formatDuration(step);
        if (duration) details.push(`时长：${duration}`);
        if (step.tool) details.push(`器具：${step.tool}`);
        if (step.sensoryCues.length) details.push(`判断标准：${step.sensoryCues.join('、')}`);

        if (details.length) {
          lines.push(details.map((detail) => `- ${detail}`).join('\n'));
          lines.push('');
        }
      });
  }

  if (specs.length) {
    lines.push('## 口述整理记录');
    lines.push('');
    lines.push('> 这些原话原本是"一点""差不多"，下面是为了让外人也能复做而整理出的结论。');
    lines.push('');
    for (const spec of specs) {
      lines.push(`### ${VAGUE_CATEGORY_LABELS[spec.category]}：${spec.rawPhrase}`);
      lines.push('');
      if (spec.question) lines.push(`- 追问：${spec.question}`);
      if (spec.answerText) lines.push(`- 答复：${spec.answerText}`);
      if (spec.resolvedSpec) {
        lines.push(`- 结论：${formatSpecSummary(spec.resolvedSpec)}`);
        if (spec.resolvedSpec.reference) lines.push(`- 参照物：${spec.resolvedSpec.reference}`);
        if (spec.resolvedSpec.substitute) lines.push(`- 替代：${spec.resolvedSpec.substitute}`);
        if (spec.resolvedSpec.criterion) lines.push(`- 判断标准：${spec.resolvedSpec.criterion}`);
        lines.push(`- 置信度：${spec.resolvedSpec.confidence}`);
      }
      if (spec.unresolvableNote) lines.push(`- 口语留白：${spec.unresolvableNote}`);
      if (spec.clipLabel) lines.push(`- 原声依据：${spec.clipLabel}`);
      lines.push('');
    }
  }

  if (verifications.length) {
    lines.push('## 复做验证');
    lines.push('');
    for (const run of verifications) {
      const head = `${run.performedAt.slice(0, 10)} · ${run.performedByName} · ${
        RESULT_LABELS[run.result] ?? run.result
      }`;
      lines.push(`### ${head}`);
      lines.push('');

      if (run.deviationEntries?.length) {
        // 结构化偏差：按步骤列出"哪个环节、什么问题、追问了谁"
        for (const entry of run.deviationEntries) {
          const where = entry.stepTitle ? `步骤「${entry.stepTitle}」` : '整道菜';
          const who = entry.assigneeName ? ` → 已追问 ${entry.assigneeName}` : '';
          lines.push(
            `- ${where} · ${VAGUE_CATEGORY_LABELS[entry.category] ?? entry.category}：${entry.description}${who}`,
          );
        }
      } else if (run.deviations) {
        lines.push(run.deviations);
      } else {
        lines.push('_无偏差_');
      }
      lines.push('');
    }
  }

  if (version.changeNote) {
    lines.push('## 本次变更说明');
    lines.push('');
    lines.push(version.changeNote);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_由「家庭食谱口述整理器」导出。原始语音保存在系统中，可随时回放核对。_');
  lines.push('');

  return lines.join('\n');
}
