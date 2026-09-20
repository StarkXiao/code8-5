/**
 * 主闭环集成测试 —— 对应项目文档 17.3。
 *
 * 覆盖完整链路：
 *   录入口述 -> 标记为待澄清 -> 向另一位家人追问 -> 对方用语音回答
 *   -> 归纳成可复做规格 -> 发布版本 -> 他人复做失败并打回
 *   -> 重新整理并发布 -> 复做成功 -> 条目进入终态 verified
 *
 * 这条用例通过，才算"闭环成立"。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(email: string, displayName: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);

  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

/** 最小可用的 WAV 头 + 静音数据，用于验证上传链路（服务端只校验类型与大小） */
function fakeWav(seconds = 1): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function uploadAudio(session: Session, recipeId: string, kind: string): Promise<string> {
  const response = await request(app)
    .post('/api/audio')
    .set(auth(session))
    .field('recipeId', recipeId)
    .field('kind', kind)
    .field('durationMs', '1000')
    .field('peaks', JSON.stringify([0.1, 0.6, 0.9, 0.3, 0.2]))
    .attach('file', fakeWav(), { filename: 'voice.wav', contentType: 'audio/wav' })
    .expect(201);

  return response.body.data.id as string;
}

describe('主闭环：从一句模糊口述到一条已验证的可复做结论', () => {
  let organizer: Session;
  let elder: Session;
  let workspaceId = '';
  let recipeId = '';
  let versionId = '';
  let audioId = '';
  let clipId = '';
  let itemId = '';
  let failedVersionId = '';

  beforeAll(async () => {
    organizer = await register('organizer@e2e.test', '整理者');
    elder = await register('elder@e2e.test', '外婆');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. 创建家庭空间，并邀请另一位家人加入', async () => {
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '闭环测试厨房' })
      .expect(201);

    workspaceId = ws.body.data.id;
    expect(ws.body.data.role).toBe('owner');

    await request(app)
      .post('/api/workspaces/join')
      .set(auth(elder))
      .send({ inviteCode: ws.body.data.inviteCode })
      .expect(201);

    const members = await request(app)
      .get(`/api/workspaces/${workspaceId}/members`)
      .set(auth(organizer))
      .expect(200);

    expect(members.body.data).toHaveLength(2);
  });

  it('2. 新建食谱时自动生成 v1 草稿（不留空状态）', async () => {
    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '外婆的红烧肉' })
      .expect(201);

    recipeId = recipe.body.data.id;
    expect(recipe.body.data.counters.hasDraft).toBe(true);

    const versions = await request(app)
      .get(`/api/recipes/${recipeId}/versions`)
      .set(auth(organizer))
      .expect(200);

    expect(versions.body.data).toHaveLength(1);
    expect(versions.body.data[0].status).toBe('draft');
    versionId = versions.body.data[0].id;
  });

  it('3. 上传原始语音并框选出一段片段', async () => {
    audioId = await uploadAudio(organizer, recipeId, 'recipe_voice');

    const audio = await request(app).get(`/api/audio/${audioId}`).set(auth(organizer)).expect(200);

    expect(audio.body.data.transcriptStatus).toBe('none');
    expect(audio.body.data.peaks).toEqual([0.1, 0.6, 0.9, 0.3, 0.2]);
    // 音频只增不删：必须有校验和用于完整性检查
    expect(audio.body.data.sha256).toHaveLength(64);

    const clip = await request(app)
      .post(`/api/audio/${audioId}/clips`)
      .set(auth(organizer))
      .send({ startMs: 200, endMs: 800, label: '外婆说放糖那句' })
      .expect(201);

    clipId = clip.body.data.id;
  });

  it('4. 把原话标记为"用量模糊"，生成待澄清条目', async () => {
    const created = await request(app)
      .post(`/api/recipes/${recipeId}/vague-items`)
      .set(auth(organizer))
      .send({
        category: 'amount',
        rawPhrase: '放一点糖',
        transcript: '先炒糖色，放一点糖就行',
        clipId,
        versionId,
      })
      .expect(201);

    itemId = created.body.data.id;
    expect(created.body.data.status).toBe('open');
    expect(created.body.data.clipId).toBe(clipId);
  });

  it('5. 规则库能对这段文本给出建议（建议不等于结论）', async () => {
    const suggest = await request(app)
      .get(`/api/recipes/${recipeId}/vague-items/suggest`)
      .query({ text: '先炒糖色，放一点糖，中火炒到收汁，揉到不粘手' })
      .set(auth(organizer))
      .expect(200);

    const categories = suggest.body.data.matches.map((m: { category: string }) => m.category);
    expect(categories).toContain('amount');
    expect(categories).toContain('heat');
    expect(categories).toContain('feel');
  });

  it('6. 向另一位家人发出追问', async () => {
    const asked = await request(app)
      .post(`/api/vague-items/${itemId}/ask`)
      .set(auth(organizer))
      .send({ question: '放一点糖大概几克？用您那只勺是几勺？', assigneeId: elder.userId })
      .expect(200);

    expect(asked.body.data.status).toBe('asked');

    // 被指派的人应该收到通知
    const notifications = await request(app)
      .get('/api/notifications')
      .query({ unread: 'true' })
      .set(auth(elder))
      .expect(200);

    expect(notifications.body.data.length).toBeGreaterThan(0);
    expect(notifications.body.data[0].type).toBe('assigned');
  });

  it('7. 对方用语音回答', async () => {
    const answerAudio = await uploadAudio(elder, recipeId, 'answer_voice');
    const answerClip = await request(app)
      .post(`/api/audio/${answerAudio}/clips`)
      .set(auth(elder))
      .send({ startMs: 0, endMs: 900, label: '外婆的回答' })
      .expect(201);

    const answered = await request(app)
      .post(`/api/vague-items/${itemId}/answer`)
      .set(auth(elder))
      .send({ answerText: '我那只白瓷勺，半勺就够', answerClipId: answerClip.body.data.id })
      .expect(200);

    expect(answered.body.data.status).toBe('answered');
  });

  it('8. 归纳成可复做规格 —— 缺证据会被拒绝，补齐后通过', async () => {
    // 没有任何录音来源的条目：结论无法追溯，必须拒绝
    const orphan = await request(app)
      .post(`/api/recipes/${recipeId}/vague-items`)
      .set(auth(organizer))
      .send({ category: 'amount', rawPhrase: '糖看着放' })
      .expect(201);

    const missingEvidence = await request(app)
      .post(`/api/vague-items/${orphan.body.data.id}/resolve`)
      .set(auth(organizer))
      .send({
        resolvedSpec: { type: 'amount', value: 4, unit: 'g', confidence: 'confirmed', evidence: {} },
      })
      .expect(422);

    expect(missingEvidence.body.error.code).toBe('SPEC_INCOMPLETE');
    expect(missingEvidence.body.error.details.map((d: { field: string }) => d.field)).toContain(
      'evidence',
    );

    // 说不清也说不动的条目，允许标记为"口语留白" —— 这是合法终态，不是失败
    const unresolvable = await request(app)
      .post(`/api/vague-items/${orphan.body.data.id}/mark-unresolvable`)
      .set(auth(organizer))
      .send({ note: '外婆已过世，这条再也问不到了' })
      .expect(200);

    expect(unresolvable.body.data.status).toBe('unresolvable');
    expect(unresolvable.body.data.unresolvableNote).toContain('再也问不到了');

    const missingUnit = await request(app)
      .post(`/api/vague-items/${itemId}/resolve`)
      .set(auth(organizer))
      .send({
        resolvedSpec: { type: 'amount', value: 4, confidence: 'confirmed', evidence: { clipId } },
      })
      .expect(422);

    expect(missingUnit.body.error.details.map((d: { field: string }) => d.field)).toContain('unit');

    const resolved = await request(app)
      .post(`/api/vague-items/${itemId}/resolve`)
      .set(auth(organizer))
      .send({
        resolvedSpec: {
          type: 'amount',
          value: 4,
          unit: 'g',
          reference: '外婆家白瓷勺一平勺 8g，这里是半勺',
          confidence: 'confirmed',
          evidence: { clipId, answeredBy: elder.userId },
        },
      })
      .expect(200);

    expect(resolved.body.data.status).toBe('resolved');
    expect(resolved.body.data.resolvedSpec.value).toBe(4);
    // 关键：条目自带的原声片段会被自动继承为结论的证据，结论永远可一键回溯
    expect(resolved.body.data.resolvedSpec.evidence.clipId).toBe(clipId);
  });

  it('9. 权限边界：贡献者能补充原话，但不能归纳结论或发布', async () => {
    await request(app)
      .patch(`/api/vague-items/${itemId}`)
      .set(auth(elder))
      .send({ transcript: '（贡献者可以补充上下文）' })
      .expect(200);

    await request(app)
      .post(`/api/vague-items/${itemId}/mark-unresolvable`)
      .set(auth(elder))
      .send({ note: '贡献者不应有归纳权限' })
      .expect(403);

    await request(app).post(`/api/versions/${versionId}/submit`).set(auth(elder)).expect(403);
  });

  it('10. 提交并发布版本 —— 没有变更说明无法发布', async () => {
    await request(app).post(`/api/versions/${versionId}/submit`).set(auth(organizer)).expect(200);

    const noNote = await request(app)
      .post(`/api/versions/${versionId}/publish`)
      .set(auth(organizer))
      .send({ changeNote: '' })
      .expect(400);
    expect(noNote.body.error.code).toBe('VALIDATION_FAILED');

    const published = await request(app)
      .post(`/api/versions/${versionId}/publish`)
      .set(auth(organizer))
      .send({ changeNote: '把"一点糖"整理为 4g，依据外婆的原声回答' })
      .expect(200);

    expect(published.body.data.status).toBe('published');
    expect(published.body.data.versionNo).toBe(1);
  });

  it('11. 已发布版本不可直接修改，只能 fork 出新草稿', async () => {
    await request(app)
      .patch(`/api/versions/${versionId}`)
      .set(auth(organizer))
      .send({ summary: '偷偷改已发布版本' })
      .expect(409);

    await request(app)
      .post(`/api/versions/${versionId}/steps`)
      .set(auth(organizer))
      .send({ title: '偷偷加一步', instruction: '不该成功' })
      .expect(409);
  });

  it('12. 他人复做失败 -> 自动生成新的待澄清条目并打回', async () => {
    const failure = await request(app)
      .post(`/api/recipes/${recipeId}/verifications`)
      .set(auth(elder))
      .send({
        versionId,
        result: 'fail',
        deviations: '颜色偏浅，糖放少了。收汁时间太长，肉有点老。',
      })
      .expect(201);

    const reopened: string[] = failure.body.data.reopenedItemIds;
    expect(reopened.length).toBeGreaterThanOrEqual(2);

    const items = await request(app)
      .get(`/api/recipes/${recipeId}/vague-items`)
      .query({ status: 'open' })
      .set(auth(organizer))
      .expect(200);

    expect(items.body.data.length).toBe(reopened.length);
    // 失败反馈生成的条目必须能追溯回那次验证
    expect(items.body.data[0].reopenedFromVerificationId).toBe(failure.body.data.id);
  });

  it('13. 复做失败时缺少偏差说明会被拒绝', async () => {
    const rejected = await request(app)
      .post(`/api/recipes/${recipeId}/verifications`)
      .set(auth(elder))
      .send({ versionId, result: 'fail' })
      .expect(400);

    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('14. 整理者处理打回的条目，fork 新版本并再次发布', async () => {
    const draft = await request(app)
      .post(`/api/recipes/${recipeId}/versions`)
      .set(auth(organizer))
      .send({ fromVersionId: versionId })
      .expect(201);

    failedVersionId = draft.body.data.id;
    expect(draft.body.data.versionNo).toBe(2);
    expect(draft.body.data.status).toBe('draft');

    const steps = await request(app)
      .get(`/api/versions/${failedVersionId}/steps`)
      .set(auth(organizer))
      .expect(200);
    expect(Array.isArray(steps.body.data)).toBe(true);

    const openItems = await request(app)
      .get(`/api/recipes/${recipeId}/vague-items`)
      .query({ status: 'open' })
      .set(auth(organizer))
      .expect(200);

    for (const item of openItems.body.data as { id: string }[]) {
      await request(app)
        .post(`/api/vague-items/${item.id}/resolve`)
        .set(auth(organizer))
        .send({
          resolvedSpec: {
            type: 'other',
            criterion: '依据复做反馈调整：糖量加到 6g，收汁时间缩短到 3 分钟',
            confidence: 'confirmed',
            evidence: { answeredBy: elder.userId },
          },
        })
        .expect(200);
    }

    await request(app).post(`/api/versions/${failedVersionId}/submit`).set(auth(organizer)).expect(200);

    // 复做失败会把原有结论降级为"暂定"，此时不允许发布 —— 这是防止带病发布的关键闸门
    const blocked = await request(app)
      .post(`/api/versions/${failedVersionId}/publish`)
      .set(auth(organizer))
      .send({ changeNote: '试图带着未复核的结论发布' })
      .expect(422);

    expect(blocked.body.error.code).toBe('SPEC_ASSUMED_UNCONFIRMED');

    // 整理者逐条复核：确认没问题的重新确认
    const assumed = await request(app)
      .get(`/api/recipes/${recipeId}/vague-items`)
      .query({ status: 'resolved' })
      .set(auth(organizer))
      .expect(200);

    expect(assumed.body.data.length).toBeGreaterThan(0);
    for (const item of assumed.body.data as { id: string }[]) {
      await request(app)
        .post(`/api/vague-items/${item.id}/confirm`)
        .set(auth(organizer))
        .send({ note: '复核后认为这条没问题' })
        .expect(200);
    }

    const published = await request(app)
      .post(`/api/versions/${failedVersionId}/publish`)
      .set(auth(organizer))
      .send({ changeNote: '根据复做反馈：糖 4g 改为 6g，收汁时间缩短' })
      .expect(200);

    expect(published.body.data.versionNo).toBe(2);

    // 旧版本被归档，且任意时刻只有一个已发布版本
    const versions = await request(app)
      .get(`/api/recipes/${recipeId}/versions`)
      .set(auth(organizer))
      .expect(200);

    const publishedCount = versions.body.data.filter(
      (v: { status: string }) => v.status === 'published',
    ).length;
    expect(publishedCount).toBe(1);
  });

  it('15. 版本差异能说清"改了什么"', async () => {
    const diff = await request(app)
      .get(`/api/versions/${failedVersionId}/diff`)
      .query({ against: versionId })
      .set(auth(organizer))
      .expect(200);

    expect(diff.body.data.baseVersion.versionNo).toBe(1);
    expect(diff.body.data.targetVersion.versionNo).toBe(2);
    expect(diff.body.data.summary).toBeDefined();
  });

  it('16. 复做成功 -> 条目进入终态 verified，闭环合上', async () => {
    await request(app)
      .post(`/api/recipes/${recipeId}/verifications`)
      .set(auth(elder))
      .send({ versionId: failedVersionId, result: 'success' })
      .expect(201);

    const verified = await request(app)
      .get(`/api/recipes/${recipeId}/vague-items`)
      .query({ status: 'verified' })
      .set(auth(organizer))
      .expect(200);

    expect(verified.body.data.length).toBeGreaterThan(0);
    // 终态条目仍然保留证据链
    expect(verified.body.data[0].resolvedSpec).not.toBeNull();
  });

  it('17. 导出可交付的 Markdown 食谱，包含整理记录与验证历史', async () => {
    const exported = await request(app)
      .get(`/api/versions/${failedVersionId}/export`)
      .query({ format: 'md' })
      .set(auth(organizer))
      .expect(200);

    expect(exported.text).toContain('# 外婆的红烧肉');
    expect(exported.text).toContain('## 口述整理记录');
    expect(exported.text).toContain('放一点糖');
    expect(exported.text).toContain('## 复做验证');
  });

  it('18. 非成员无法访问该空间的任何数据', async () => {
    const outsider = await register('outsider@e2e.test', '路人');

    await request(app).get(`/api/recipes/${recipeId}`).set(auth(outsider)).expect(403);
    await request(app).get(`/api/audio/${audioId}`).set(auth(outsider)).expect(403);
    await request(app)
      .post(`/api/recipes/${recipeId}/vague-items`)
      .set(auth(outsider))
      .send({ category: 'amount', rawPhrase: '闯入' })
      .expect(403);
  });

  it('19. 音频是软删除，证据链不会因为误删而消失', async () => {
    await request(app).delete(`/api/audio/${audioId}`).set(auth(organizer)).expect(200);

    const list = await request(app)
      .get('/api/audio')
      .query({ recipeId })
      .set(auth(organizer))
      .expect(200);
    expect(list.body.data.some((a: { id: string }) => a.id === audioId)).toBe(false);

    // 但数据库里仍然保留记录与校验和
    const record = await prisma.audioAttachment.findUnique({ where: { id: audioId } });
    expect(record).not.toBeNull();
    expect(record?.deletedAt).not.toBeNull();
    expect(record?.sha256).toHaveLength(64);
  });

  /* ---------------------------------------------------------------- */
  /* 结构化偏差：按步骤定位 -> 自动识别分类 -> 自动转追问并指派        */
  /* ---------------------------------------------------------------- */

  it('20. 结构化偏差按步骤生成"追问中"条目，并自动指派给该步骤的答复人', async () => {
    // 准备一张新食谱 + 一个带原声的步骤 + 一条由 elder 答复并已发布的结论
    const r = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '外婆的糖醋排骨' })
      .expect(201);
    const structuredRecipeId = r.body.data.id as string;

    const v = await request(app)
      .get(`/api/recipes/${structuredRecipeId}/versions`)
      .set(auth(organizer))
      .expect(200);
    const structuredVersionId = v.body.data[0].id as string;

    const stepAudio = await uploadAudio(elder, structuredRecipeId, 'recipe_voice');
    const stepClip = await request(app)
      .post(`/api/audio/${stepAudio}/clips`)
      .set(auth(elder))
      .send({ startMs: 0, endMs: 900, label: '外婆讲炒糖色' })
      .expect(201);

    const step = await request(app)
      .post(`/api/versions/${structuredVersionId}/steps`)
      .set(auth(organizer))
      .send({
        title: '炒糖色',
        instruction: '中火炒糖到枣红色',
        heatLevel: 'medium',
        sourceClipId: stepClip.body.data.id,
      })
      .expect(201);
    const stepId = step.body.data.id as string;

    const item = await request(app)
      .post(`/api/recipes/${structuredRecipeId}/vague-items`)
      .set(auth(organizer))
      .send({
        category: 'heat',
        rawPhrase: '中火炒到枣红色',
        clipId: stepClip.body.data.id,
        stepId,
        versionId: structuredVersionId,
      })
      .expect(201);

    await request(app)
      .post(`/api/vague-items/${item.body.data.id}/answer`)
      .set(auth(elder))
      .send({ answerText: '火苗到锅底第二圈，看到枣红色就下肉' })
      .expect(200);

    await request(app)
      .post(`/api/vague-items/${item.body.data.id}/resolve`)
      .set(auth(organizer))
      .send({
        resolvedSpec: {
          type: 'heat',
          criterion: '枣红色、火苗到锅底第二圈',
          confidence: 'confirmed',
          evidence: { clipId: stepClip.body.data.id, answeredBy: elder.userId },
        },
      })
      .expect(200);

    await request(app)
      .post(`/api/versions/${structuredVersionId}/submit`)
      .set(auth(organizer))
      .expect(200);
    await request(app)
      .post(`/api/versions/${structuredVersionId}/publish`)
      .set(auth(organizer))
      .send({ changeNote: '结构化偏差测试的首版发布' })
      .expect(200);

    // 复做人由 organizer 担任，elder 是被追问对象 —— 不能自问自答
    const failure = await request(app)
      .post(`/api/recipes/${structuredRecipeId}/verifications`)
      .set(auth(organizer))
      .send({
        versionId: structuredVersionId,
        result: 'fail',
        deviationItems: [
          {
            stepId,
            // 故意不填 category，验证自动识别
            description: '按中火炒，糖一直不上色，还没炒到枣红色就结块了',
          },
          // 整道菜层面、无法定位步骤的偏差
          { category: 'amount', description: '整道菜偏甜，糖的总量可能多了' },
        ],
      })
      .expect(201);

    const entries = failure.body.data.deviationEntries as {
      stepId: string | null;
      stepTitle: string | null;
      category: string;
      description: string;
      assigneeId: string | null;
      assigneeName: string | null;
      vagueItemId: string;
      categoryAuto: boolean;
      assigneeAuto: boolean;
    }[];

    expect(entries).toHaveLength(2);

    const onStep = entries.find((entry) => entry.stepId === stepId)!;
    expect(onStep.stepTitle).toBe('炒糖色');
    // "中火"命中火候规则
    expect(onStep.category).toBe('heat');
    expect(onStep.categoryAuto).toBe(true);
    // 自动指派给这一步上次的答复人 / 原声提供者 elder
    expect(onStep.assigneeId).toBe(elder.userId);
    expect(onStep.assigneeName).toBe('外婆');
    expect(onStep.assigneeAuto).toBe(true);
    expect(onStep.vagueItemId).toBeTruthy();

    // 生成的条目直接是"追问中"，追问话术带着步骤名与偏差描述
    const generated = await request(app)
      .get(`/api/vague-items/${onStep.vagueItemId}`)
      .set(auth(organizer))
      .expect(200);
    expect(generated.body.data.status).toBe('asked');
    expect(generated.body.data.assigneeId).toBe(elder.userId);
    expect(generated.body.data.stepId).toBe(stepId);
    expect(generated.body.data.question).toContain('炒糖色');
    expect(generated.body.data.question).toContain('不上色');
    expect(generated.body.data.reopenedFromVerificationId).toBe(failure.body.data.id);

    // 被自动指派的人收到 assigned 通知，通知能追溯到那次验证
    const elderNotifications = await request(app)
      .get('/api/notifications')
      .set(auth(elder))
      .expect(200);
    const assigned = elderNotifications.body.data.find(
      (n: { type: string; payload?: { verificationId?: string } }) =>
        n.type === 'assigned' && n.payload?.verificationId === failure.body.data.id,
    );
    expect(assigned).toBeTruthy();

    // 受影响步骤上的旧结论被降级为"暂定"，无法定位步骤的偏差也会触发全量降级
    const degraded = await request(app)
      .get(`/api/vague-items/${item.body.data.id}`)
      .set(auth(organizer))
      .expect(200);
    expect(degraded.body.data.status).toBe('resolved');
    expect(degraded.body.data.confidence).toBe('assumed');
  });

  it('21. 只降级出偏差步骤的结论，其他步骤的结论不受牵连', async () => {
    const r = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '外婆的清蒸鱼' })
      .expect(201);
    const localRecipeId = r.body.data.id as string;
    const v = await request(app)
      .get(`/api/recipes/${localRecipeId}/versions`)
      .set(auth(organizer))
      .expect(200);
    const localVersionId = v.body.data[0].id as string;

    async function makeStep(title: string) {
      const response = await request(app)
        .post(`/api/versions/${localVersionId}/steps`)
        .set(auth(organizer))
        .send({ title, instruction: `${title}的描述` })
        .expect(201);
      return response.body.data.id as string;
    }
    const badStepId = await makeStep('第一步 腌制');
    const goodStepId = await makeStep('第二步 上锅蒸');

    async function makeResolvedItem(rawPhrase: string, stepId: string) {
      const created = await request(app)
        .post(`/api/recipes/${localRecipeId}/vague-items`)
        .set(auth(organizer))
        .send({ category: 'other', rawPhrase, stepId, versionId: localVersionId })
        .expect(201);
      await request(app)
        .post(`/api/vague-items/${created.body.data.id}/answer`)
        .set(auth(elder))
        .send({ answerText: '知道了' })
        .expect(200);
      await request(app)
        .post(`/api/vague-items/${created.body.data.id}/resolve`)
        .set(auth(organizer))
        .send({
          resolvedSpec: {
            type: 'other',
            criterion: rawPhrase,
            confidence: 'confirmed',
            evidence: { answeredBy: elder.userId },
          },
        })
        .expect(200);
      return created.body.data.id as string;
    }

    const badItemId = await makeResolvedItem('腌十分钟', badStepId);
    const goodItemId = await makeResolvedItem('蒸八分钟', goodStepId);

    await request(app)
      .post(`/api/versions/${localVersionId}/submit`)
      .set(auth(organizer))
      .expect(200);
    await request(app)
      .post(`/api/versions/${localVersionId}/publish`)
      .set(auth(organizer))
      .send({ changeNote: '清蒸鱼首版' })
      .expect(200);

    // 只有第一步出偏差，且明确指派给 organizer（显式指派）
    const failure = await request(app)
      .post(`/api/recipes/${localRecipeId}/verifications`)
      .set(auth(elder))
      .send({
        versionId: localVersionId,
        result: 'partial',
        deviationItems: [
          { stepId: badStepId, category: 'time', description: '腌了十分钟根本不入味', assigneeId: organizer.userId },
        ],
      })
      .expect(201);

    expect(failure.body.data.deviationEntries[0].assigneeId).toBe(organizer.userId);
    expect(failure.body.data.deviationEntries[0].assigneeAuto).toBe(false);

    const badItem = await request(app)
      .get(`/api/vague-items/${badItemId}`)
      .set(auth(organizer))
      .expect(200);
    const goodItem = await request(app)
      .get(`/api/vague-items/${goodItemId}`)
      .set(auth(organizer))
      .expect(200);

    expect(badItem.body.data.confidence).toBe('assumed');
    // 没出偏差的步骤，结论维持"已确认"
    expect(goodItem.body.data.confidence).toBe('confirmed');
  });

  it('22. 偏差不能定位到别的版本的步骤，也不能指派给空间外的人', async () => {
    // 新建一张食谱，拿一个外版本的步骤 id
    const other = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '别的菜' })
      .expect(201);
    const otherVersionId = (
      await request(app)
        .get(`/api/recipes/${other.body.data.id}/versions`)
        .set(auth(organizer))
        .expect(200)
    ).body.data[0].id as string;
    const foreignStep = await request(app)
      .post(`/api/versions/${otherVersionId}/steps`)
      .set(auth(organizer))
      .send({ title: '别人家的步骤', instruction: 'x' })
      .expect(201);

    const outsider = await register('outsider2@e2e.test', '路人乙');

    const badStep = await request(app)
      .post(`/api/recipes/${recipeId}/verifications`)
      .set(auth(elder))
      .send({
        versionId,
        result: 'fail',
        deviationItems: [{ stepId: foreignStep.body.data.id, description: '挂到别的版本的步骤上' }],
      })
      .expect(400);
    expect(badStep.body.error.code).toBe('VALIDATION_FAILED');

    const badAssignee = await request(app)
      .post(`/api/recipes/${recipeId}/verifications`)
      .set(auth(elder))
      .send({
        versionId,
        result: 'fail',
        deviationItems: [{ description: '指派给外人', assigneeId: outsider.userId }],
      })
      .expect(400);
    expect(badAssignee.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('23. 失败但一条偏差都没填仍然被拒绝；成功无需偏差', async () => {
    const rejected = await request(app)
      .post(`/api/recipes/${recipeId}/verifications`)
      .set(auth(elder))
      .send({ versionId, result: 'fail', deviationItems: [] })
      .expect(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');

    // 空描述的偏差条目会被过滤，等同于没填
    const rejectedBlank = await request(app)
      .post(`/api/recipes/${recipeId}/verifications`)
      .set(auth(elder))
      .send({ versionId, result: 'fail', deviationItems: [{ description: '  ' }] })
      .expect(400);
    expect(rejectedBlank.body.error.code).toBe('VALIDATION_FAILED');
  });
});
