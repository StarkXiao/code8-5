import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// 逐个把每个页面在真实浏览器里打开一遍，抓运行时崩溃与控制台报错。
// 上一次只有一条主闭环用例，MembersPage / NotificationsPage / DiffPage / VerifyPage
// 这些页面从来没被浏览器加载过，等于没验证。

const API = '/api';

interface Seeded {
  workspaceId: string;
  inviteCode: string;
  recipeId: string;
  publishedVersionId: string;
  draftVersionId: string;
  tokens: { accessToken: string; refreshToken: string };
  viewerTokens: { accessToken: string; refreshToken: string };
}

async function api<T>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  options: { token?: string; data?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
  const response = await request[method](`${API}${path}`, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    data: options.data,
    params: options.params,
  });
  expect(response.ok(), `${method.toUpperCase()} ${path} -> ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = await response.json();
  return body.data as T;
}

/** 造出一套覆盖所有状态的数据，否则空列表页面看不出问题 */
async function seed(request: APIRequestContext): Promise<Seeded> {
  const stamp = Date.now();
  const organizer = await api<{ tokens: Seeded['tokens']; user: { id: string } }>(
    request,
    'post',
    '/auth/register',
    { data: { email: `pages-${stamp}@e2e.test`, password: 'froa12345', displayName: '整理者' } },
  );
  const token = organizer.tokens.accessToken;

  const elder = await api<{ tokens: Seeded['tokens']; user: { id: string } }>(
    request,
    'post',
    '/auth/register',
    { data: { email: `pages-elder-${stamp}@e2e.test`, password: 'froa12345', displayName: '外婆' } },
  );

  const workspace = await api<{ id: string; inviteCode: string }>(request, 'post', '/workspaces', {
    token,
    data: { name: '全页面巡检厨房' },
  });

  await api(request, 'post', '/workspaces/join', {
    token: elder.tokens.accessToken,
    data: { inviteCode: workspace.inviteCode },
  });

  await api(request, 'post', `/workspaces/${workspace.id}/references`, {
    token,
    data: { label: '白瓷勺', amountValue: 8, amountUnit: 'g', note: '一平勺' },
  });

  // 再拉一个只读成员进来：按角色分支渲染的地方最容易出问题，之前完全没测过
  const viewer = await api<{ tokens: Seeded['tokens']; user: { id: string } }>(
    request,
    'post',
    '/auth/register',
    { data: { email: `pages-viewer-${stamp}@e2e.test`, password: 'froa12345', displayName: '旁观者' } },
  );
  await api(request, 'post', '/workspaces/join', {
    token: viewer.tokens.accessToken,
    data: { inviteCode: workspace.inviteCode },
  });
  await api(request, 'patch', `/workspaces/${workspace.id}/members/${viewer.user.id}`, {
    token,
    data: { role: 'viewer' },
  });

  const recipe = await api<{ id: string }>(request, 'post', '/recipes', {
    token,
    data: { workspaceId: workspace.id, title: '全页面红烧肉', dishCategory: '荤菜' },
  });

  const versions = await api<{ id: string; status: string }[]>(
    request,
    'get',
    `/recipes/${recipe.id}/versions`,
    { token },
  );
  const draftVersionId = versions[0]!.id;

  const seedStep = await api<{ id: string }>(request, 'post', `/versions/${draftVersionId}/steps`, {
    token,
    data: {
      title: '炒糖色',
      instruction: '中小火炒到枣红',
      heatLevel: 'medium_low',
      heatText: '中小火',
      durationSecondsMin: 120,
      durationSecondsMax: 180,
      sensoryCues: ['变枣红色', '闻到焦糖香'],
      tool: '厚底锅',
    },
  });
  await api(request, 'post', `/versions/${draftVersionId}/ingredients`, {
    token,
    data: { name: '冰糖', amountValue: 4, amountUnit: 'g', isVague: true, note: '白瓷勺半勺' },
  });

  // 待澄清条目：六种状态各来一条
  const item = async (category: string, rawPhrase: string) =>
    api<{ id: string }>(request, 'post', `/recipes/${recipe.id}/vague-items`, {
      token,
      data: { category, rawPhrase },
    });

  await item('amount', '放一点点糖');
  const asked = await item('heat', '中火炒到冒泡');
  const answered = await item('feel', '揉到不粘手');
  const resolved = await item('time', '焖一会儿');
  await item('other', '按老规矩来');

  await api(request, 'post', `/vague-items/${asked.id}/ask`, {
    token,
    data: { question: '火苗大概多大？', assigneeId: elder.user.id },
  });
  await api(request, 'post', `/vague-items/${answered.id}/ask`, {
    token,
    data: { question: '手感像什么？' },
  });
  await api(request, 'post', `/vague-items/${answered.id}/answer`, {
    token: elder.tokens.accessToken,
    data: { answerText: '像耳垂一样软' },
  });
  await api(request, 'post', `/vague-items/${resolved.id}/resolve`, {
    token,
    data: {
      resolvedSpec: {
        type: 'time',
        range: { min: 3, max: 8 },
        criterion: '筷子能轻松插透',
        confidence: 'confirmed',
        evidence: { answeredBy: elder.user.id },
      },
    },
  });

  // 评论 + 一次失败验证（会生成新的 open 条目和通知）
  await api(request, 'post', '/comments', {
    token: elder.tokens.accessToken,
    data: { targetType: 'vague_item', targetId: answered.id, body: '我记得是这样', mentions: [] },
  });

  await api(request, 'post', `/versions/${draftVersionId}/submit`, { token });
  const published = await api<{ id: string }>(request, 'post', `/versions/${draftVersionId}/publish`, {
    token,
    data: { changeNote: '把口述整理成可复做的第一版' },
  });

  // 一次失败验证：结构化偏差（按步骤、带分类与指派人），会生成"追问中"条目和通知
  await api(request, 'post', `/recipes/${recipe.id}/verifications`, {
    token: elder.tokens.accessToken,
    data: {
      versionId: published.id,
      result: 'fail',
      deviationItems: [
        { stepId: seedStep.id, category: 'heat', description: '按中小火炒，糖色一直偏浅不上色', assigneeId: organizer.user.id },
        { category: 'amount', description: '肉吃起来偏老，收汁可能太久' },
      ],
    },
  });

  const newDraft = await api<{ id: string }>(request, 'post', `/recipes/${recipe.id}/versions`, {
    token,
    data: { fromVersionId: published.id },
  });

  return {
    workspaceId: workspace.id,
    inviteCode: workspace.inviteCode,
    recipeId: recipe.id,
    publishedVersionId: published.id,
    draftVersionId: newDraft.id,
    tokens: organizer.tokens,
    viewerTokens: viewer.tokens,
  };
}

/** 把令牌塞进 localStorage，跳过登录 UI */
async function authenticate(page: Page, tokens: Seeded['tokens']) {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('froa.accessToken', access as string);
      localStorage.setItem('froa.refreshToken', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken],
  );
}

function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`崩溃: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // React 在开发模式下重复渲染产生的告警不算缺陷
    if (/Download the React DevTools|antd v5 support React is 16/.test(text)) return;
    problems.push(`控制台错误: ${text}`);
  });
  return problems;
}

test('每个页面都能真实加载且不报错', async ({ page, request }) => {
  const data = await seed(request);
  await authenticate(page, data.tokens);
  const problems = collectProblems(page);

  for (const route of pageRoutes(data)) {
    await page.goto(route.path);
    await expect(
      page.getByRole('heading', { name: route.expect }).first(),
      `页面 ${route.path} 没有渲染出预期内容`,
    ).toBeVisible({ timeout: 15_000 });
  }

  expect(problems, `页面报错：\n${problems.join('\n')}`).toEqual([]);
});

test('只读角色的每个页面同样不报错', async ({ page, request }) => {
  const data = await seed(request);
  await authenticate(page, data.viewerTokens);
  const problems = collectProblems(page);

  for (const route of pageRoutes(data)) {
    await page.goto(route.path);
    await expect(
      page.getByRole('heading', { name: route.expect }).first(),
      `只读角色打开 ${route.path} 没有渲染出预期内容`,
    ).toBeVisible({ timeout: 15_000 });
  }

  // 只读角色不应该看到任何"能改"的入口
  await page.goto(`${pageRoutes(data)[6]!.path}`);
  await expect(page.getByRole('button', { name: /添加步骤|提交并发布/ })).toHaveCount(0);

  expect(problems, `只读角色页面报错：\n${problems.join('\n')}`).toEqual([]);
});

function pageRoutes(data: Seeded): { path: string; expect: RegExp }[] {
  const base = `/w/${data.workspaceId}`;
  const recipe = `${base}/recipes/${data.recipeId}`;

  return [
    { path: '/', expect: /我的家庭空间/ },
    { path: base, expect: /全页面巡检厨房/ },
    { path: `${base}/members`, expect: /成员与参照物/ },
    { path: `${base}/notifications`, expect: /通知/ },
    { path: `${base}/activity`, expect: /操作日志/ },
    { path: recipe, expect: /全页面红烧肉/ },
    { path: `${recipe}/record`, expect: /录音工作台/ },
    { path: `${recipe}/inbox`, expect: /追问台/ },
    { path: `${recipe}/edit`, expect: /编辑草稿/ },
    { path: `${recipe}/verify`, expect: /复做验证/ },
    { path: `${recipe}/versions`, expect: /版本历史/ },
    {
      path: `${recipe}/versions/${data.publishedVersionId}/diff/${data.draftVersionId}`,
      expect: /版本差异/,
    },
    { path: `/join/${data.inviteCode}`, expect: /全页面巡检厨房/ },
  ];
}
