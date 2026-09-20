import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  classifyDeviation,
  splitDeviationText,
  VAGUE_CATEGORIES,
  VAGUE_CATEGORY_LABELS,
  VERSION_STATUS_LABELS,
  type ReopenedDeviationDto,
  type VagueCategory,
  type VerificationResult,
} from '@froa/shared';
import { recipeApi, verificationApi, versionApi, workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';

const RESULT_LABEL: Record<string, string> = {
  success: '成功：跟食谱描述一致',
  partial: '部分成功：大体对，但某些地方对不上',
  fail: '失败：做出来不对',
};

interface DeviationRow {
  text: string;
  stepId?: string | null;
  /** 'auto' 表示交给服务端按关键词归类 */
  category?: VagueCategory | 'auto';
  assigneeId?: string | null;
}

/**
 * 复做验证 —— 闭环真正合上的地方。
 *
 * 规则（也是产品态度）：说"失败"必须逐条写清哪里不一样、出在哪一步。
 * 每条偏差会被自动归类、生成追问、指派给合适的家人（原结论的答复人优先），
 * 直接回到追问台继续整理。
 */
export function VerifyPage() {
  const { workspaceId, recipeId } = useParams<{ workspaceId: string; recipeId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{
    versionId: string;
    result: VerificationResult;
    deviationItems: DeviationRow[];
  }>();
  const [result, setResult] = useState<VerificationResult>('success');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [reopened, setReopened] = useState<ReopenedDeviationDto[] | null>(null);

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => recipeApi.get(recipeId!),
    enabled: Boolean(recipeId),
  });

  const versions = useQuery({
    queryKey: ['versions', recipeId],
    queryFn: () => versionApi.list(recipeId!),
    enabled: Boolean(recipeId),
  });

  const selectedVersionId = Form.useWatch('versionId', form) as string | undefined;

  const steps = useQuery({
    queryKey: ['steps', selectedVersionId],
    queryFn: () => versionApi.steps(selectedVersionId!),
    enabled: Boolean(selectedVersionId),
  });

  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => workspaceApi.members(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const runs = useQuery({
    queryKey: ['verifications', recipeId],
    queryFn: () => verificationApi.list(recipeId!),
    enabled: Boolean(recipeId),
  });

  const rows = (Form.useWatch('deviationItems', form) as DeviationRow[] | undefined) ?? [];

  const memberOptions = useMemo(
    () =>
      (members.data ?? []).map((member) => ({
        value: member.userId,
        label: `${member.displayName}（${member.role === 'owner' ? '所有者' : member.role === 'editor' ? '整理者' : member.role === 'contributor' ? '贡献者' : '旁观者'}）`,
      })),
    [members.data],
  );

  const stepOptions = useMemo(
    () =>
      (steps.data ?? []).map((step) => ({
        value: step.id,
        label: `第 ${step.orderIndex + 1} 步 · ${step.title}`,
      })),
    [steps.data],
  );

  const createMutation = useMutation({
    mutationFn: (values: {
      versionId: string;
      result: VerificationResult;
      deviationItems?: DeviationRow[];
    }) => {
      const deviationItems = (values.deviationItems ?? [])
        .filter((row) => row.text?.trim())
        .map((row) => ({
          text: row.text.trim(),
          stepId: row.stepId ?? null,
          category: row.category && row.category !== 'auto' ? row.category : null,
          assigneeId: row.assigneeId ?? null,
        }));
      // 结构化提交时 deviations 留空；服务端会把各条按行拼成快照存进历史
      return verificationApi.create(recipeId!, {
        versionId: values.versionId,
        result: values.result,
        deviationItems,
      });
    },
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: ['verifications', recipeId] });
      void queryClient.invalidateQueries({ queryKey: ['vague-items'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] });

      if (run.result === 'success') {
        message.success('复做成功！相关结论已标记为「已验证」');
        navigate(`/w/${workspaceId}/recipes/${recipeId}`);
      } else {
        const items = run.reopenedItems ?? [];
        const assigned = items.filter((item) => item.assigneeId);
        message.warning(
          `已记录 ${items.length} 条偏差，${assigned.length} 条已自动发出追问${
            items.length - assigned.length ? `，${items.length - assigned.length} 条待指派` : ''
          }`,
        );
        setReopened(items);
      }
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  if (versions.isLoading) return <Spin size="large" />;

  const published = versions.data?.find((version) => version.status === 'published');

  const appendBatch = () => {
    const list = (form.getFieldValue('deviationItems') ?? []) as DeviationRow[];
    const additions: DeviationRow[] = splitDeviationText(batchText).map((text) => ({
      text,
      stepId: null,
      category: 'auto',
      assigneeId: null,
    }));
    form.setFieldValue('deviationItems', [...list, ...additions]);
    setBatchText('');
    setBatchOpen(false);
  };

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>复做验证 · {recipe.data?.title}</h1>
          <div className="froa-hint">
            按食谱实际做一遍，把结果记下来。这是唯一能证明"整理到位了"的动作。
          </div>
        </div>
        <Link to={`/w/${workspaceId}/recipes/${recipeId}`}>返回食谱</Link>
      </div>

      {!published ? (
        <Empty description="还没有已发布的版本，先把草稿发布出来再验证。" />
      ) : (
        <Card title={`要验证的版本：v${published.versionNo}`}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="请真的做一次，不要凭印象填"
            description="做出来不对的地方，逐条写下「什么现象 + 出在哪一步」。系统会把每条偏差归类成火候/用量等追问，自动指派给最可能知道答案的家人。"
          />

          <Form
            form={form}
            layout="vertical"
            initialValues={{
              versionId: published.id,
              result: 'success',
              deviationItems: [] as DeviationRow[],
            }}
            onFinish={(values) => {
              if (values.result !== 'success') {
                const filled = (values.deviationItems ?? []).filter((row) => row.text?.trim());
                if (!filled.length) {
                  message.error('请至少填写一条偏差，否则无法定位问题');
                  return;
                }
              }
              createMutation.mutate(values);
            }}
          >
            <Form.Item label="验证哪个版本" name="versionId" rules={[{ required: true }]}>
              <Select
                options={(versions.data ?? [])
                  .filter((version) => version.status !== 'draft')
                  .map((version) => ({
                    value: version.id,
                    label: `v${version.versionNo} · ${VERSION_STATUS_LABELS[version.status]}`,
                  }))}
              />
            </Form.Item>

            <Form.Item label="结果" name="result" rules={[{ required: true }]}>
              <Radio.Group
                onChange={(event) => {
                  setResult(event.target.value as VerificationResult);
                  if (event.target.value !== 'success' && (form.getFieldValue('deviationItems') ?? []).length === 0) {
                    form.setFieldValue('deviationItems', [
                      { text: '', stepId: null, category: 'auto', assigneeId: null },
                    ]);
                  }
                }}
              >
                {(['success', 'partial', 'fail'] as VerificationResult[]).map((value) => (
                  <Radio.Button key={value} value={value}>
                    {RESULT_LABEL[value]}
                  </Radio.Button>
                ))}
              </Radio.Group>
            </Form.Item>

            {result !== 'success' && (
              <div className="froa-stack">
                <div className="froa-row" style={{ justifyContent: 'space-between' }}>
                  <Typography.Text strong>偏差清单（一条一条定位）</Typography.Text>
                  <Button size="small" onClick={() => setBatchOpen(true)}>
                    整段文字拆成多条
                  </Button>
                </div>

                <Form.List name="deviationItems">
                  {(fields, { add, remove }) => (
                    <div className="froa-stack">
                      {fields.map((field) => {
                        const row = rows[field.name];
                        const preview = row?.text?.trim()
                          ? classifyDeviation(row.text.trim(), row.category === 'auto' ? null : row.category ?? null)
                          : null;
                        return (
                          <Card key={field.key} size="small" className="froa-deviation-row">
                            <Space wrap align="start" style={{ width: '100%' }}>
                              <Form.Item
                                name={[field.name, 'text']}
                                style={{ flex: 1, minWidth: 260, marginBottom: 8 }}
                                rules={[{ required: true, message: '写清偏差现象' }]}
                              >
                                <Input.TextArea
                                  rows={1}
                                  autoSize={{ minRows: 1, maxRows: 3 }}
                                  placeholder="哪里和食谱不一样？例如：按 5 分钟收汁，肉还是柴的"
                                />
                              </Form.Item>
                              <Button
                                type="text"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={() => remove(field.name)}
                              />
                            </Space>
                            <Space wrap>
                              <Form.Item name={[field.name, 'stepId']} style={{ marginBottom: 0 }}>
                                <Select
                                  allowClear
                                  showSearch
                                  placeholder="出在哪一步（不选=整体问题）"
                                  style={{ width: 240 }}
                                  options={stepOptions}
                                  loading={steps.isLoading}
                                  optionFilterProp="label"
                                />
                              </Form.Item>
                              <Form.Item name={[field.name, 'category']} style={{ marginBottom: 0 }}>
                                <Select
                                  style={{ width: 150 }}
                                  options={[
                                    { value: 'auto', label: '分类自动识别' },
                                    ...VAGUE_CATEGORIES.map((value) => ({
                                      value,
                                      label: VAGUE_CATEGORY_LABELS[value],
                                    })),
                                  ]}
                                />
                              </Form.Item>
                              <Form.Item name={[field.name, 'assigneeId']} style={{ marginBottom: 0 }}>
                                <Select
                                  allowClear
                                  showSearch
                                  placeholder="追问谁（留空=自动指派）"
                                  style={{ width: 220 }}
                                  options={memberOptions}
                                  optionFilterProp="label"
                                />
                              </Form.Item>
                              {preview && (
                                <Tag color="orange">
                                  将归为「{VAGUE_CATEGORY_LABELS[preview.category]}」
                                  {preview.matched ? `（命中：${preview.matched}）` : ''}
                                </Tag>
                              )}
                            </Space>
                          </Card>
                        );
                      })}
                      <Button
                        type="dashed"
                        block
                        icon={<PlusOutlined />}
                        onClick={() => add({ text: '', stepId: null, category: 'auto', assigneeId: null })}
                      >
                        再加一条偏差
                      </Button>
                    </div>
                  )}
                </Form.List>

                <Typography.Text type="secondary">
                  不指定追问对象时，系统优先指派给这一步原结论的答复人；找不到就指派给这类问题最常回答的家人。
                </Typography.Text>
              </div>
            )}

            <Space style={{ marginTop: 16 }}>
              <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
                提交验证
              </Button>
              <Typography.Text type="secondary">
                提交成功后，成功会让相关结论变成「已验证」；失败会把每条偏差变成追问并直接发出。
              </Typography.Text>
            </Space>
          </Form>
        </Card>
      )}

      <Modal
        open={batchOpen}
        title="整段文字拆成多条"
        onCancel={() => setBatchOpen(false)}
        onOk={appendBatch}
        okText="拆成偏差条目"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          每行（或每个句号）会拆成一条独立偏差，步骤与追问对象可以拆完后逐条补。
        </Typography.Paragraph>
        <Input.TextArea
          rows={5}
          autoFocus
          value={batchText}
          onChange={(event) => setBatchText(event.target.value)}
          placeholder={'颜色偏浅，糖放少了\n收汁时间太长，肉有点老'}
        />
      </Modal>

      <Modal
        open={reopened !== null}
        title="偏差已转成追问"
        footer={[
          <Button key="close" onClick={() => setReopened(null)}>
            留在本页
          </Button>,
          <Button
            key="inbox"
            type="primary"
            onClick={() => navigate(`/w/${workspaceId}/recipes/${recipeId}/inbox`)}
          >
            去追问台查看
          </Button>,
        ]}
        onCancel={() => setReopened(null)}
        width={640}
      >
        <div className="froa-stack">
          {(reopened ?? []).map((item) => (
            <div key={item.id} className="froa-step-card">
              <div className="froa-item-meta">
                <span className={`froa-tag-cat cat-${item.category}`}>
                  {VAGUE_CATEGORY_LABELS[item.category]}
                </span>
                {item.stepTitle && (
                  <Tag color="geekblue">
                    第 {item.stepOrder} 步 · {item.stepTitle}
                  </Tag>
                )}
                {item.assigneeId ? (
                  <Tag color="blue">
                    已问 {item.assigneeName ?? '某位家人'}
                    {item.autoAssigned ? '（自动指派）' : ''}
                  </Tag>
                ) : (
                  <Tag color="red">待指派</Tag>
                )}
              </div>
              <p style={{ margin: '0.4rem 0 0' }}>「{item.rawPhrase}」</p>
              {item.question && <p className="froa-hint" style={{ margin: '0.2rem 0 0' }}>{item.question}</p>}
            </div>
          ))}
        </div>
      </Modal>

      <Card title={`历史验证记录（${runs.data?.length ?? 0}）`}>
        {!runs.data?.length ? (
          <Typography.Text type="secondary">还没有人复做过</Typography.Text>
        ) : (
          <div className="froa-stack">
            {runs.data.map((run) => (
              <div key={run.id} className="froa-step-card">
                <div className="froa-row">
                  <Tag color={run.result === 'success' ? 'green' : run.result === 'partial' ? 'gold' : 'red'}>
                    {RESULT_LABEL[run.result]}
                  </Tag>
                  <span>{run.performer?.displayName ?? '某人'}</span>
                  <span className="froa-hint">{run.performedAt.slice(0, 16).replace('T', ' ')}</span>
                  {run.reopenedItemIds?.length ? (
                    <Tag color="orange">新增 {run.reopenedItemIds.length} 条待澄清</Tag>
                  ) : null}
                </div>
                {run.deviations && <p style={{ margin: '0.5rem 0 0' }}>{run.deviations}</p>}
                {run.reopenedItems?.length ? (
                  <div className="froa-stack" style={{ marginTop: 6 }}>
                    {run.reopenedItems.map((item) => (
                      <Space key={item.id} size={6} wrap>
                        <span className={`froa-tag-cat cat-${item.category}`}>
                          {VAGUE_CATEGORY_LABELS[item.category]}
                        </span>
                        {item.stepTitle && (
                          <Tag color="geekblue">
                            第 {item.stepOrder} 步 · {item.stepTitle}
                          </Tag>
                        )}
                        <span>「{item.rawPhrase}」</span>
                        {item.assigneeId ? (
                          <Typography.Text type="secondary">→ 问 {item.assigneeName ?? '某位家人'}</Typography.Text>
                        ) : (
                          <Tag color="red">待指派</Tag>
                        )}
                      </Space>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
