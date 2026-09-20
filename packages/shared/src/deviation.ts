import { VAGUE_CATEGORIES, type VagueCategory } from './enums';

/**
 * 复做偏差 → 待澄清条目的归类与追问生成。
 *
 * 录音整理阶段用的是 rules.ts（识别口述里的模糊说法）；
 * 这里是复做反馈阶段：用户填的是"做出来哪里不对"，措辞完全不同
 * （"肉老了""糖放少了""收汁太久"），所以单独维护一套关键词。
 *
 * 规则同样只给"建议"：前端可以让用户改分类，服务端允许显式传入 category 覆盖。
 */

export interface DeviationClassification {
  category: VagueCategory;
  /** 命中的关键词，用于界面上解释"为什么归到这一类"，未命中为 null */
  matched: string | null;
}

/**
 * 按优先级排列：一条偏差可能同时命中多类关键词
 * （"收汁时间太长，肉老了"既像时间又像手感），排在前面的类胜出。
 * 用量排在火候前面：像"糖放少了，颜色偏浅"这种，根因是用量而不是火。
 */
const DEVIATION_KEYWORDS: { category: VagueCategory; words: string[] }[] = [
  {
    category: 'time',
    words: [
      '时间',
      '分钟',
      '太久',
      '太长',
      '太短',
      '久了',
      '超时',
      '早了',
      '晚了',
      '没到时间',
      '多焖',
      '多炖',
      '多煮',
      '少焖',
      '少炖',
      '少煮',
    ],
  },
  {
    category: 'feel',
    words: [
      '粘手',
      '粘牙',
      '硬',
      '太软',
      '太稀',
      '太稠',
      '太干',
      '太湿',
      '柴',
      '老了',
      '不够嫩',
      '不烂',
      '没烂',
      '口感',
      '手感',
      '筋道',
      '发不起来',
      '发过了',
      '塌',
      '回缩',
      '质地',
    ],
  },
  {
    category: 'amount',
    words: [
      '放多',
      '放少',
      '多了',
      '少了',
      '太多',
      '太少',
      '咸了',
      '淡了',
      '太咸',
      '太淡',
      '太甜',
      '太酸',
      '太辣',
      '偏咸',
      '偏淡',
      '偏甜',
      '用量',
      '几克',
      '几勺',
      '半勺',
      '一勺',
      '一把',
      '一撮',
      '糖',
      '盐',
      '酱油',
      '醋',
      '调料',
    ],
  },
  {
    category: 'heat',
    words: [
      '火候',
      '火大',
      '火小',
      '火太',
      '焦',
      '糊',
      '夹生',
      '没熟',
      '不熟',
      '生的',
      '温度',
      '冒烟',
      '气泡',
      '冒泡',
      '上色',
      '颜色',
      '偏深',
      '偏浅',
      '糖色',
      '收汁',
    ],
  },
];

/**
 * 把一条复做偏差归到 heat/feel/amount/time/other。
 * 归不出来就是 other —— 仍然会生成追问，不会被丢掉。
 */
export function classifyDeviation(text: string, override?: VagueCategory | null): DeviationClassification {
  if (override && VAGUE_CATEGORIES.includes(override)) {
    return { category: override, matched: null };
  }

  const source = text ?? '';
  for (const group of DEVIATION_KEYWORDS) {
    const hit = group.words.find((word) => source.includes(word));
    if (hit) return { category: group.category, matched: hit };
  }
  return { category: 'other', matched: null };
}

/** 各类偏差的追问模板，{现象} 会被替换成用户填写的那条偏差 */
const DEVIATION_QUESTION_TEMPLATES: Record<VagueCategory, string> = {
  amount: '上次复做时用量没对上（{现象}）。实际应该放多少？大概几克，或者用您平时那只勺是几勺？',
  heat: '上次复做时火候没对上（{现象}）。这一步火苗大概多大？看到锅里什么样子才算对？',
  feel: '上次复做时手感口感没对上（{现象}）。做到什么手感才算对？能和什么常见的东西比一下吗？',
  time: '上次复做时时间没对上（{现象}）。实际应该多久？到点时怎么判断（看什么、听什么、摸起来怎样）？',
  other: '上次复做时这一步和食谱写的不一致（{现象}）。能再说说是怎么做才对吗？（可以直接录语音）',
};

export interface DeviationQuestionContext {
  /** 偏差定位到的步骤序号（从 1 开始，用于前缀） */
  stepOrder?: number | null;
  /** 偏差定位到的步骤名 */
  stepTitle?: string | null;
}

/**
 * 根据偏差分类与所在步骤，生成那条自动追问的具体问法。
 * 步骤会写进问法本身 —— 被问的人在通知里就能看到"问的是哪一步"。
 */
export function buildDeviationQuestion(
  text: string,
  category: VagueCategory,
  context: DeviationQuestionContext = {},
): string {
  const phenomenon = (text ?? '').trim();
  const body = DEVIATION_QUESTION_TEMPLATES[category].replace('{现象}', phenomenon);
  const stepLabel =
    context.stepTitle != null
      ? `第${(context.stepOrder ?? 0) > 0 ? context.stepOrder : '?'}步「${context.stepTitle}」：`
      : '';
  return `${stepLabel}${body}`;
}

/**
 * 把整段偏差说明拆成一条条独立偏差。
 *
 * 新前端按"一行一条"结构化提交；这个拆分同时服务于：
 * - 旧客户端/脚本只传一段 deviations 文本时的兜底；
 * - 前端"批量文本模式"的实时预览。
 */
export function splitDeviationText(deviations: string, maxItems = 20): string[] {
  return (deviations ?? '')
    .split(/[。；;\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .slice(0, maxItems);
}
