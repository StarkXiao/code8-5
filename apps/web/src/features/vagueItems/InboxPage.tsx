import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { SoundOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VAGUE_CATEGORIES,
  VAGUE_CATEGORY_LABELS,
  VAGUE_STATUS_LABELS,
  formatSpecSummary,
  type ResolvedSpec,
  type VagueCategory,
  type VagueItemDto,
  type VagueStatus,
} from '@froa/shared';
import { recipeApi, vagueItemApi, workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { SpecEditor } from '../../components/SpecEditor';
import { Waveform } from '../../components/Waveform';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';

const STATUS_COLORS: Record<VagueStatus, string> = {
  open: 'default',
  asked: 'blue',
  answered: 'gold',
  resolved: 'purple',
  verified: 'green',
  unresolvable: 'default',
};

const FILTERS: { value: VagueStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '待澄清' },
  { value: 'asked', label: '追问中' },
  { value: 'answered', label: '待整理' },
  { value: 'resolved', label: '待复做' },
  { value: 'verified', label: '已验证' },
  { value: 'unresolvable', label: '口语留白' },
];

/**
 * 追问台 —— 闭环的中枢。
 *
 * 左边是"今天要处理的事"，右边是选中的那一条的完整上下文：
 * 原话、原声、追问、答复、以及最终的归纳表单。
 */
export function InboxPage() {
  const { workspaceId, recipeId } = useParams<{ workspaceId: string; recipeId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const { playClip, playAudio } = useAudioPlayback();

  const [statusFilter, setStatusFilter] = useState<VagueStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<VagueCategory | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [unresolvableOpen, setUnresolvableOpen] = useState(false);
  const [unresolvableForm] = Form.useForm<{ note: string }>();

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => recipeApi.get(recipeId!),
    enabled: Boolean(recipeId),
  });

  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => workspaceApi.members(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const summary = useQuery({
    queryKey: ['vague-summary', recipeId],
    queryFn: () => vagueItemApi.summary(recipeId!),
    enabled: Boolean(recipeId),
  });

  const items = useQuery({
    queryKey: ['vague-items', recipeId, statusFilter, categoryFilter],
    queryFn: () =>
      vagueItemApi.list(recipeId!, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        category: categoryFilter,
        pageSize: 200,
      }),
    enabled: Boolean(recipeId),
  });

  const detail = useQuery({
    queryKey: ['vague-item', selectedId],
    queryFn: () => vagueItemApi.get(selectedId!),
    enabled: Boolean(selectedId),
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['vague-items'] });
    void queryClient.invalidateQueries({ queryKey: ['vague-item'] });
    void queryClient.invalidateQueries({ queryKey: ['vague-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['recipe'] });
  };

  const askMutation = useMutation({
    mutationFn: (values: { question: string; assigneeId?: string }) =>
      vagueItemApi.ask(selectedId!, values),
    onSuccess: () => {
      message.success('已发出追问，对方会收到通知');
      invalidateAll();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const answerMutation = useMutation({
    mutationFn: (values: { answerText: string }) => vagueItemApi.answer(selectedId!, values),
    onSuccess: () => {
      message.success('已记录答复');
      invalidateAll();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const resolveMutation = useMutation({
    mutationFn: (spec: ResolvedSpec) =>
      vagueItemApi.resolve(selectedId!, { resolvedSpec: spec }),
    onSuccess: () => {
      message.success('已保存为可复做结论');
      setResolving(false);
      invalidateAll();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const confirmMutation = useMutation({
    mutationFn: () => vagueItemApi.confirm(selectedId!, '复核后确认'),
    onSuccess: () => {
      message.success('已重新确认');
      invalidateAll();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const unresolvableMutation = useMutation({
    mutationFn: (values: { note: string }) => vagueItemApi.markUnresolvable(selectedId!, values.note),
    onSuccess: () => {
      message.success('已标记为口语留白');
      setUnresolvableOpen(false);
      unresolvableForm.resetFields();
      invalidateAll();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const reopenMutation = useMutation({
    mutationFn: () => vagueItemApi.reopen(selectedId!, '需要重新整理'),
    onSuccess: () => {
      message.success('已重新打开');
      invalidateAll();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const canResolve = recipe.data?.myRole === 'owner' || recipe.data?.myRole === 'editor';
  const list = items.data ?? [];
  const current = detail.data;

  const todoText = useMemo(() => {
    const todo = summary.data?.todo;
    if (!todo) return '';
    return `待追问 ${todo.toAsk} ｜ 待整理 ${todo.toResolve} ｜ 待复做 ${todo.toVerify}`;
  }, [summary.data]);

  if (items.isLoading || recipe.isLoading) return <Spin size="large" />;

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>追问台 · {recipe.data?.title}</h1>
          <div className="froa-hint">{todoText || '把说不清的地方一条条问清楚，再整理成可复做的结论。'}</div>
        </div>
        <Space wrap>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/record`}>
            <Button>去录音</Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/edit`}>
            <Button>编辑草稿</Button>
          </Link>
        </Space>
      </div>

      <Space wrap>
        <Segmented
          value={statusFilter}
          onChange={(value) => setStatusFilter(value as VagueStatus | 'all')}
          options={FILTERS.map((filter) => ({
            value: filter.value,
            label:
              filter.value === 'all' ? (
                filter.label
              ) : (
                <Badge
                  count={summary.data?.byStatus[filter.value] ?? 0}
                  size="small"
                  offset={[8, -2]}
                  color="#c9a88c"
                >
                  {filter.label}
                </Badge>
              ),
          }))}
        />
        <Select
          allowClear
          placeholder="按分类筛选"
          style={{ width: 150 }}
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={VAGUE_CATEGORIES.map((value) => ({ value, label: VAGUE_CATEGORY_LABELS[value] }))}
        />
      </Space>

      <div className="froa-inbox-columns">
        <div className="froa-stack">
          {list.length === 0 ? (
            <Empty description="这个筛选下没有条目" />
          ) : (
            list.map((item) => (
              <div
                key={item.id}
                className={`froa-item-card cat-${item.category}${selectedId === item.id ? ' selected' : ''}`}
                onClick={() => {
                  setSelectedId(item.id);
                  setResolving(false);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === 'Enter' && setSelectedId(item.id)}
              >
                <div className="froa-item-meta">
                  <span className={`froa-tag-cat cat-${item.category}`}>
                    {VAGUE_CATEGORY_LABELS[item.category]}
                  </span>
                  <Tag color={STATUS_COLORS[item.status]}>{VAGUE_STATUS_LABELS[item.status]}</Tag>
                  {item.step && <Tag color="geekblue">步骤 {item.step.orderIndex + 1}：{item.step.title}</Tag>}
                  {item.assignee && <span>问 {item.assignee.displayName}</span>}
                  {!item.assignee && item.reopenedFromVerificationId && (
                    <Tag color="orange">待指派</Tag>
                  )}
                  <span>{item.createdAt.slice(0, 10)}</span>
                </div>
                <p className="froa-item-raw">「{item.rawPhrase}」</p>
                {item.resolvedSpec && (
                  <div className="froa-hint">结论：{formatSpecSummary(item.resolvedSpec)}</div>
                )}
                {item.unresolvableNote && (
                  <div className="froa-hint">留白原因：{item.unresolvableNote}</div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="froa-detail">
          {!current ? (
            <Empty description="从左边选一条，右边会显示它的全部上下文和原声" />
          ) : (
            <VagueItemDetail
              key={current.id}
              item={current}
              canResolve={canResolve}
              members={members.data ?? []}
              resolving={resolving}
              onToggleResolve={() => setResolving((value) => !value)}
              onResolve={(spec) => resolveMutation.mutate(spec)}
              resolvePending={resolveMutation.isPending}
              onConfirm={() => confirmMutation.mutate()}
              confirmPending={confirmMutation.isPending}
              onReopen={() => reopenMutation.mutate()}
              reopenPending={reopenMutation.isPending}
              onOpenUnresolvable={() => setUnresolvableOpen(true)}
              onAsk={(values) => askMutation.mutate(values)}
              askPending={askMutation.isPending}
              onAnswer={(values) => answerMutation.mutate(values)}
              answerPending={answerMutation.isPending}
              onPlayClip={() => playClip(current.clip, current.clipAudio, current.rawPhrase)}
              onPlayAnswerClip={() =>
                playClip(current.answerClip, current.answerClipAudio, '语音答复')
              }
            />
          )}
        </div>
      </div>

      <Modal
        forceRender
        open={unresolvableOpen}
        title="标记为口语留白"
        onCancel={() => setUnresolvableOpen(false)}
        onOk={() => unresolvableForm.submit()}
        okText="确认留白"
        cancelText="取消"
        confirmLoading={unresolvableMutation.isPending}
      >
        <Typography.Paragraph type="secondary">
          "说不清"也是一种结论。写清原因，这条就会成为合法终态，不会永远挂在待办里。
        </Typography.Paragraph>
        <Form form={unresolvableForm} layout="vertical" onFinish={(v) => unresolvableMutation.mutate(v)}>
          <Form.Item
            label="为什么无法确定"
            name="note"
            rules={[{ required: true, min: 2, message: '请说明原因' }]}
          >
            <Input.TextArea rows={3} placeholder="例如：外婆已经想不起来具体是多少了" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

interface DetailProps {
  item: VagueItemDto;
  canResolve: boolean;
  members: { userId: string; displayName: string }[];
  resolving: boolean;
  resolvePending: boolean;
  confirmPending: boolean;
  reopenPending: boolean;
  askPending: boolean;
  answerPending: boolean;
  onToggleResolve: () => void;
  onResolve: (spec: ResolvedSpec) => void;
  onConfirm: () => void;
  onReopen: () => void;
  onOpenUnresolvable: () => void;
  onAsk: (values: { question: string; assigneeId?: string }) => void;
  onAnswer: (values: { answerText: string }) => void;
  onPlayClip: () => void;
  onPlayAnswerClip: () => void;
}

function VagueItemDetail(props: DetailProps) {
  const { item } = props;
  const terminal = item.status === 'verified' || item.status === 'unresolvable';

  // 表单实例放在这里而不是父组件：父组件在还没选中条目时就会创建实例，
  // 此时没有任何 <Form> 挂载，antd 会告警"useForm 未连接到 Form"。
  // 放在子组件 + 用 key 绑定 item.id，切换条目时组件重建，表单自然清空。
  const [askForm] = Form.useForm<{ question: string; assigneeId?: string }>();
  const [answerForm] = Form.useForm<{ answerText: string }>();

  return (
    <div className="froa-stack">
      {item.reopenedFromVerificationId && (
        <Alert
          type="warning"
          showIcon
          message="这条来自一次失败的复做"
          description={
            item.step
              ? `定位在步骤「${item.step.title}」。复核这一步的结论：确认没问题就重新确认，有问题就按下面的追问继续问。`
              : '这是整道菜层面的偏差，暂时定位不到具体步骤。可以先追问补充信息，再决定改哪条结论。'
          }
        />
      )}
      <div>
        <div className="froa-item-meta">
          <span className={`froa-tag-cat cat-${item.category}`}>
            {VAGUE_CATEGORY_LABELS[item.category]}
          </span>
          <Tag color={STATUS_COLORS[item.status]}>{VAGUE_STATUS_LABELS[item.status]}</Tag>
        </div>
        <h2 style={{ margin: '0.5rem 0' }}>「{item.rawPhrase}」</h2>
        {item.transcript && <Typography.Paragraph type="secondary">{item.transcript}</Typography.Paragraph>}
      </div>

      {/* 原声：整个流程的证据锚点 */}
      {item.clip && item.clipAudio ? (
        <div>
          <div className="froa-row" style={{ marginBottom: 6 }}>
            <Button icon={<SoundOutlined />} onClick={props.onPlayClip} type="primary" ghost>
              听原声
            </Button>
            <span className="froa-hint">{item.clip.label ?? '当时那句话'}</span>
          </div>
          <Waveform
            peaks={item.clipAudio.peaks}
            durationMs={item.clipAudio.durationMs}
            height={64}
            selection={{ startMs: item.clip.startMs, endMs: item.clip.endMs }}
            emptyHint="这段音频没有波形数据（仍可播放）"
          />
        </div>
      ) : (
        <Typography.Text type="warning">这条没有关联原声片段</Typography.Text>
      )}

      <Divider style={{ margin: '0.5rem 0' }} />

      {/* 追问 */}
      {item.question ? (
        <div>
          <Typography.Text strong>已发出的追问</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 4 }}>{item.question}</Typography.Paragraph>
          {item.questionAskedAt && (
            <Typography.Text type="secondary" style={{ fontSize: '0.85rem' }}>
              {item.questionAskedAt.slice(0, 16).replace('T', ' ')}
            </Typography.Text>
          )}
        </div>
      ) : null}

      {!terminal && (
        <Form form={askForm} layout="vertical" onFinish={props.onAsk}>
          <Form.Item
            label={item.question ? '换个问法再问一次' : '发出追问'}
            name="question"
            rules={[{ required: true, message: '请填写要问的话' }]}
          >
            <Input.TextArea rows={2} placeholder="放一点糖大概几克？用您那只勺是几勺？" />
          </Form.Item>
          <Form.Item name="assigneeId" style={{ marginBottom: 8 }}>
            <Select
              allowClear
              placeholder="问谁（可选，会给对方发通知）"
              options={props.members.map((member) => ({
                value: member.userId,
                label: member.displayName,
              }))}
            />
          </Form.Item>
          <Button htmlType="submit" loading={props.askPending}>
            发出追问
          </Button>
        </Form>
      )}

      {/* 答复 */}
      {item.answerText || item.answerClipId ? (
        <div>
          <Typography.Text strong>对方的答复</Typography.Text>
          {item.answerText && <Typography.Paragraph>{item.answerText}</Typography.Paragraph>}
          {item.answerClip && (
            <Button size="small" onClick={props.onPlayAnswerClip}>
              播放语音答复
            </Button>
          )}
        </div>
      ) : null}

      {!terminal && (
        <Form form={answerForm} layout="vertical" onFinish={props.onAnswer}>
          <Form.Item label="直接记录答复（长辈口头说完，你来打字）" name="answerText">
            <Input.TextArea rows={2} placeholder="我那只白瓷勺，半勺就够" />
          </Form.Item>
          <Button htmlType="submit" loading={props.answerPending}>
            记录答复
          </Button>
        </Form>
      )}

      <Divider style={{ margin: '0.5rem 0' }} />

      {/* 结论 */}
      {item.resolvedSpec ? (
        <div>
          <Typography.Text strong>可复做结论</Typography.Text>
          <Typography.Paragraph style={{ marginTop: 4 }}>
            {formatSpecSummary(item.resolvedSpec)}
          </Typography.Paragraph>
          <Space wrap>
            <Tag>置信度：{item.resolvedSpec.confidence}</Tag>
            {item.resolvedSpec.evidence.clipId && <Tag color="green">可回溯到原声</Tag>}
          </Space>
        </div>
      ) : (
        <Typography.Text type="secondary">还没有整理出可复做的结论</Typography.Text>
      )}

      {props.resolving && (
        <SpecEditor
          category={item.category}
          initial={item.resolvedSpec}
          clipId={item.clipId}
          members={props.members}
          submitting={props.resolvePending}
          onSubmit={props.onResolve}
          onCancel={props.onToggleResolve}
        />
      )}

      {!props.resolving && (
        <Space wrap>
          {!terminal && props.canResolve && (
            <Button type="primary" onClick={props.onToggleResolve}>
              {item.resolvedSpec ? '修改结论' : '整理成可复做结论'}
            </Button>
          )}

          {item.status === 'resolved' && props.canResolve && (
            <Button onClick={props.onConfirm} loading={props.confirmPending}>
              复核后重新确认
            </Button>
          )}

          {!terminal && props.canResolve && (
            <Button onClick={props.onOpenUnresolvable}>标记为口语留白</Button>
          )}

          {(item.status === 'verified' || item.status === 'unresolvable') && props.canResolve && (
            <Button onClick={props.onReopen} loading={props.reopenPending}>
              重新打开
            </Button>
          )}
        </Space>
      )}

      {inviteToVerify(item, props.members)}
    </div>
  );
}

/** resolved 状态的条目提示去发起复做验证 —— 闭环的最后一步不能没有入口 */
function inviteToVerify(item: VagueItemDto, _members: { userId: string }[]) {
  if (item.status !== 'resolved') return null;
  return (
    <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: '0.85rem' }}>
      整理好的结论需要有人真的做一遍才算数。到食谱页发起一次复做验证，成功这条就会变成"已验证"。
    </Typography.Paragraph>
  );
}
