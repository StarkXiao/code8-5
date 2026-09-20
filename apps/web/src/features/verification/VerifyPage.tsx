import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
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
  VAGUE_CATEGORIES,
  VAGUE_CATEGORY_LABELS,
  VERSION_STATUS_LABELS,
  type DeviationEntry,
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

interface DeviationFormItem {
  stepId?: string | null;
  category?: VagueCategory | null;
  assigneeId?: string | null;
  description?: string;
}

interface VerifyFormValues {
  versionId: string;
  result: VerificationResult;
  deviationItems?: DeviationFormItem[];
}

/**
 * 复做验证 —— 闭环真正合上的地方。
 *
 * 规则（也是产品态度）：说"失败"必须写清是**哪一步**、**哪里不一样**、**该问谁**。
 * 每条偏差提交后会自动变成一条已经指派人的追问，
 * 被追问的家人会收到通知，不需要整理者再人工拆条、逐条指人。
 */
export function VerifyPage() {
  const { workspaceId, recipeId } = useParams<{ workspaceId: string; recipeId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<VerifyFormValues>();
  const [result, setResult] = useState<VerificationResult>('success');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

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

  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => workspaceApi.members(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const steps = useQuery({
    queryKey: ['version-steps', selectedVersionId],
    queryFn: () => versionApi.steps(selectedVersionId!),
    enabled: Boolean(selectedVersionId),
  });

  const runs = useQuery({
    queryKey: ['verifications', recipeId],
    queryFn: () => verificationApi.list(recipeId!),
    enabled: Boolean(recipeId),
  });

  const createMutation = useMutation({
    mutationFn: (values: VerifyFormValues) =>
      verificationApi.create(recipeId!, {
        versionId: values.versionId,
        result: values.result,
        deviationItems: (values.deviationItems ?? [])
          .map((item) => ({
            stepId: item.stepId ?? null,
            category: item.category ?? null,
            assigneeId: item.assigneeId ?? null,
            description: item.description?.trim() ?? '',
          }))
          .filter((item) => item.description.length >= 2),
      }),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: ['verifications', recipeId] });
      void queryClient.invalidateQueries({ queryKey: ['vague-items'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] });
      form.resetFields();

      if (run.result === 'success') {
        message.success('复做成功！相关结论已标记为「已验证」');
        navigate(`/w/${workspaceId}/recipes/${recipeId}`);
      } else {
        const entries = run.deviationEntries ?? [];
        const assigned = entries.filter((entry) => entry.assigneeName);
        message.warning(
          `已按步骤生成 ${entries.length} 条追问` +
            (assigned.length ? `，${assigned.length} 条已自动指派给对应家人` : ''),
        );
        navigate(`/w/${workspaceId}/recipes/${recipeId}/inbox`);
      }
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  // 默认验证已发布版本：同步一次步骤下拉的数据源
  useEffect(() => {
    if (selectedVersionId) return;
    const current = versions.data?.find((version) => version.status === 'published');
    if (current) setSelectedVersionId(current.id);
  }, [versions.data, selectedVersionId]);

  if (versions.isLoading) return <Spin size="large" />;

  const published = versions.data?.find((version) => version.status === 'published');
  const selectableVersions = (versions.data ?? []).filter((version) => version.status !== 'draft');
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
            description="如果做出来不对，按步骤逐条写偏差。每条偏差会自动生成一条追问，并指派给这一步当初回答的人（也可以手动改指派人）。"
          />

          <Form
            form={form}
            layout="vertical"
            initialValues={{ versionId: published.id, result: 'success' }}
            onFinish={(values) => {
              if (values.result !== 'success') {
                const items = (values.deviationItems ?? []).filter(
                  (item) => (item.description?.trim().length ?? 0) >= 2,
                );
                if (!items.length) {
                  message.error('请至少填写一条偏差，并写清是哪一步、哪里不一样');
                  return;
                }
              }
              createMutation.mutate(values);
            }}
          >
            <Form.Item label="验证哪个版本" name="versionId" rules={[{ required: true }]}>
              <Select
                options={selectableVersions.map((version) => ({
                  value: version.id,
                  label: `v${version.versionNo} · ${VERSION_STATUS_LABELS[version.status]}`,
                }))}
                onChange={(value: string) => setSelectedVersionId(value)}
              />
            </Form.Item>

            <Form.Item label="结果" name="result" rules={[{ required: true }]}>
              <Radio.Group
                onChange={(event) => setResult(event.target.value as VerificationResult)}
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
                <Typography.Text strong>哪里不一样（按步骤逐条填写）</Typography.Text>
                <Typography.Text type="secondary">
                  定位到具体步骤后，系统才知道该复核哪条结论、该追问谁。不选步骤表示整道菜层面的问题。
                </Typography.Text>

                <Form.List name="deviationItems" initialValue={[{}]}>
                  {(fields, { add, remove }) => (
                    <div className="froa-stack">
                      {fields.map((field) => (
                        <Card
                          key={field.key}
                          size="small"
                          title={`偏差 ${field.name + 1}`}
                          extra={
                            fields.length > 1 ? (
                              <Button
                                size="small"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={() => remove(field.name)}
                              >
                                删除
                              </Button>
                            ) : null
                          }
                        >
                          <Space wrap align="start">
                            <Form.Item
                              name={[field.name, 'stepId']}
                              label="出在哪一步"
                              style={{ marginBottom: 8 }}
                            >
                              <Select
                                allowClear
                                placeholder="整道菜 / 定位不到步骤"
                                style={{ width: 220 }}
                                loading={steps.isLoading}
                                options={(steps.data ?? []).map((step) => ({
                                  value: step.id,
                                  label: `${step.orderIndex + 1}. ${step.title}`,
                                }))}
                              />
                            </Form.Item>

                            <Form.Item
                              name={[field.name, 'category']}
                              label="问题类型"
                              style={{ marginBottom: 8 }}
                            >
                              <Select
                                allowClear
                                placeholder="自动识别"
                                style={{ width: 130 }}
                                options={VAGUE_CATEGORIES.map((value) => ({
                                  value,
                                  label: VAGUE_CATEGORY_LABELS[value],
                                }))}
                              />
                            </Form.Item>

                            <Form.Item
                              name={[field.name, 'assigneeId']}
                              label="追问谁"
                              style={{ marginBottom: 8 }}
                              tooltip="留空时自动指派给这一步上次回答 / 提供原声的家人"
                            >
                              <Select
                                allowClear
                                placeholder="自动指派"
                                style={{ width: 160 }}
                                options={(members.data ?? []).map((member) => ({
                                  value: member.userId,
                                  label: member.displayName,
                                }))}
                              />
                            </Form.Item>
                          </Space>

                          <Form.Item
                            name={[field.name, 'description']}
                            rules={[{ required: true, min: 2, message: '请写清这一条偏差' }]}
                            style={{ marginBottom: 0 }}
                          >
                            <Input.TextArea
                              rows={2}
                              placeholder="例如：按中火炒，但糖色一直不上色，炒了五分钟还是浅黄的"
                            />
                          </Form.Item>
                        </Card>
                      ))}
                      <Button
                        block
                        icon={<PlusOutlined />}
                        onClick={() => add({})}
                        disabled={fields.length >= 20}
                      >
                        再加一条偏差
                      </Button>
                    </div>
                  )}
                </Form.List>
              </div>
            )}

            <Space style={{ marginTop: 16 }}>
              <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
                提交验证
              </Button>
              <Typography.Text type="secondary">
                成功会让结论变成「已验证」；失败会按步骤生成追问，受影响步骤的旧结论会被降级待复核。
              </Typography.Text>
            </Space>
          </Form>
        </Card>
      )}

      <Card title={`历史验证记录（${runs.data?.length ?? 0}）`}>
        {!runs.data?.length ? (
          <Typography.Text type="secondary">还没有人复做过</Typography.Text>
        ) : (
          <div className="froa-stack">
            {runs.data.map((run) => (
              <VerificationRunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function VerificationRunCard({ run }: { run: import('@froa/shared').VerificationRunDto }) {
  const entries = run.deviationEntries ?? [];
  return (
    <div className="froa-step-card">
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

      {entries.length ? (
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
          {entries.map((entry: DeviationEntry, index) => (
            <li key={entry.vagueItemId || index} style={{ marginBottom: 4 }}>
              <Space size={4} wrap>
                {entry.stepTitle && <Tag color="blue">{entry.stepTitle}</Tag>}
                <Tag>{VAGUE_CATEGORY_LABELS[entry.category]}</Tag>
                <span>{entry.description}</span>
                {entry.assigneeName && (
                  <Typography.Text type="secondary">
                    → 已追问 {entry.assigneeName}
                    {entry.assigneeAuto ? '（自动指派）' : ''}
                  </Typography.Text>
                )}
              </Space>
            </li>
          ))}
        </ul>
      ) : (
        run.deviations && <p style={{ margin: '0.5rem 0 0' }}>{run.deviations}</p>
      )}
    </div>
  );
}
