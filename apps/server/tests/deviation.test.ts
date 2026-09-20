import { describe, expect, it } from 'vitest';
import {
  buildDeviationQuestion,
  classifyDeviation,
  splitDeviationText,
} from '@froa/shared';

describe('复做偏差 → 追问条目', () => {
  it('按关键词归类：用量 / 火候 / 手感 / 时间 / 其他', () => {
    expect(classifyDeviation('糖放少了，颜色偏浅').category).toBe('amount');
    expect(classifyDeviation('收汁时间太长').category).toBe('time');
    expect(classifyDeviation('肉有点老，不够嫩').category).toBe('feel');
    expect(classifyDeviation('火太大，底部糊了').category).toBe('heat');
    expect(classifyDeviation('成品和照片不太一样').category).toBe('other');
  });

  it('一条偏差同时命中多类时，时间优先（"收汁时间太长肉老了"是时间问题）', () => {
    expect(classifyDeviation('收汁时间太长，肉有点老').category).toBe('time');
  });

  it('显式传入的分类覆盖关键词推断', () => {
    expect(classifyDeviation('肉有点老', 'heat').category).toBe('heat');
  });

  it('追问里带上步骤序号、步骤名和偏差现象', () => {
    const question = buildDeviationQuestion('糖放少了', 'amount', {
      stepOrder: 2,
      stepTitle: '炒糖色',
    });
    expect(question).toContain('第2步');
    expect(question).toContain('炒糖色');
    expect(question).toContain('糖放少了');
    expect(question).toContain('几克');
  });

  it('没有步骤时追问不拼接步骤前缀', () => {
    const question = buildDeviationQuestion('整体偏咸', 'amount');
    expect(question.startsWith('第')).toBe(false);
    expect(question).toContain('整体偏咸');
  });

  it('整段文本按句号、分号、换行拆成独立偏差', () => {
    const lines = splitDeviationText('颜色偏浅，糖放少了。\n收汁时间太长；肉有点老');
    expect(lines).toEqual(['颜色偏浅，糖放少了', '收汁时间太长', '肉有点老']);
  });

  it('拆分时丢弃过短的碎片，并受条数上限约束', () => {
    const many = Array.from({ length: 30 }, (_, i) => `第${i + 1}条偏差现象`).join('。');
    expect(splitDeviationText(many)).toHaveLength(20);
    expect(splitDeviationText('啊。真正的偏差是肉老了。')).toEqual(['真正的偏差是肉老了']);
  });
});
