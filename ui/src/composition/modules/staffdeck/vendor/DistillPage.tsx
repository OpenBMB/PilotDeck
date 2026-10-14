// @ts-nocheck
import { USER_CONTENT_ATTRIBUTES, USER_CONTENT_TITLE_ATTRIBUTES } from './FormalUserContent';
import {
  ApiOutlined, ArrowLeftOutlined, BranchesOutlined, CheckCircleOutlined,
  CheckOutlined, CodeOutlined, CloseOutlined, CloseCircleOutlined,
  DeleteOutlined, DownOutlined, FileTextOutlined, InfoCircleOutlined,
  LoadingOutlined, PlusOutlined, RightOutlined, SaveOutlined, SendOutlined,
  StopOutlined, UploadOutlined, WarningOutlined,
} from './DistillPageHost';
import { Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type HTMLAttributes,
  type HTMLInputTypeAttribute,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Checkbox, Dialog, DialogContent, DialogFooter, DialogTitle, Input, Popover,
  PopoverContent, PopoverTrigger, UISelect, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Textarea, Tooltip, TooltipContent,
  TooltipProvider, TooltipTrigger, UIButton, ConfirmDialog, AppHeader,
  CapabilityScopeBadge, CapabilityScopeControl, normalizeCapabilityScope,
  ModelConfigDropdown, cn,
  subscribeEnterpriseCapabilityCatalogRefresh, SELECT_TRIGGER_CLASS,
  formatHandoffAssigneeValue, parseHandoffAssigneeValue,
  ApiError, copyTextToClipboard,
  useDistillPageHost,
} from './DistillPageHost';
import type { EnterpriseAuthUser, GeneralSkillRead, KnowledgeBaseRead, ModelConfigRead, SkillCard, SkillRead, ToolProbeResponse, ToolRead, ToolSuggestion } from './DistillPageHost';
import {
  ACTION_EMPTY_CLASS,
  ACTION_LIST_CLASS,
  CARD_OUTLINE_BUTTON_CLASS,
  CHAT_ACTIONS_GROUP_CLASS,
  CHAT_CARD_BODY_CLASS,
  CHAT_ATTACHMENT_CLASS,
  CHAT_ATTACHMENT_ICON_CLASS,
  CHAT_ATTACHMENT_MAIN_CLASS,
  CHAT_ATTACHMENT_NAME_CLASS,
  CHAT_ATTACHMENT_TYPE_CLASS,
  CHAT_ATTACHMENT_USER_CLASS,
  CHAT_ATTACHMENTS_CLASS,
  CHAT_ATTACHMENTS_USER_CLASS,
  CHAT_CARD_CLASS,
  CHAT_CARD_DRAGGING_CLASS,
  CHAT_CARD_FULLSCREEN_CLASS,
  CHAT_ACTIONS_CLASS,
  CHAT_COMPOSER_SHELL_CLASS,
  CHAT_CONFIRM_CLASS,
  CHAT_CONTENT_CLASS,
  CHAT_CONTENT_USER_ATTACHMENTS_CLASS,
  CHAT_DECISION_CLASS,
  CHAT_EDIT_ACTIONS_CLASS,
  CHAT_EDIT_PANEL_CLASS,
  CHAT_EDIT_PANEL_USER_ATTACHMENTS_CLASS,
  CHAT_EDIT_TEXTAREA_CLASS,
  CHAT_FAILURE_BUTTON_CLASS,
  CHAT_FAILURE_CLASS,
  CHAT_FAILURE_COPY_CLASS,
  CHAT_FAILURE_DETAILS_CLASS,
  CHAT_FAILURE_ICON_CLASS,
  CHAT_FAILURE_LABEL_CLASS,
  CHAT_FAILURE_META_CLASS,
  CHAT_FAILURE_RAW_CLASS,
  CHAT_FAILURE_STAGE_CLASS,
  CHAT_FAILURE_SUMMARY_CLASS,
  CHAT_FAILURE_VALUE_CLASS,
  CHAT_HOVER_ACTIONS_CLASS,
  CHAT_HOVER_BUTTON_CLASS,
  CHAT_MESSAGES_CLASS,
  CHAT_PANEL_CLASS,
  CHAT_COMPOSER_CLASS,
  CHAT_TEXTAREA_CLASS,
  CHAT_THINKING_BLOCK_CLASS,
  CHAT_THINKING_BUTTON_CLASS,
  CHAT_THINKING_DETAIL_CLASS,
  CHAT_THINKING_DETAILS_CLASS,
  CHAT_TIME_CLASS,
  CHAT_UPLOAD_DROP_HINT_CLASS,
  CHAT_WARNING_CLASS,
  CHAT_WARNING_ITEM_CLASS,
  CHAT_WARNING_TITLE_CLASS,
  CONDITION_EDITOR_CLASS,
  CONDITION_INPUT_CLASS,
  CONDITION_PRESET_CLASS,
  CONDITION_READABLE_CLASS,
  DIFF_NEW_CLASS,
  DIFF_OLD_CLASS,
  DISTILL_CARD_BODY_CLASS,
  DISTILL_CARD_CLASS,
  DISTILL_CARD_HEADER_CLASS,
  DISTILL_ACTIONS_CLASS,
  DISTILL_PAGE_CLASS,
  FLOW_CHIP_CLASS,
  FLOW_CHIP_LIST_CLASS,
  FLOW_CHIP_MUTED_CLASS,
  FLOW_CLASS,
  FLOW_COMPACT_META_CLASS,
  FLOW_COMPACT_ROW_CLASS,
  FLOW_CONNECTION_PREVIEW_CLASS,
  FLOW_EDGES_CLASS,
  FLOW_EDGE_PATH_CLASS,
  FLOW_GRAPH_CANVAS_CLASS,
  FLOW_META_CLASS,
  FLOW_META_LABEL_CLASS,
  FLOW_META_ROW_CLASS,
  FLOW_NODE_BADGES_CLASS,
  FLOW_NODE_CONNECT_HANDLE_ACTIVE_CLASS,
  FLOW_NODE_CONNECT_HANDLE_CLASS,
  FLOW_NODE_POSITION_CLASS,
  FLOW_NODE_SHELL_CLASS,
  FLOW_NODE_SUMMARY_CLASS,
  FLOW_ROOT_POSITION_CLASS,
  FLOW_FULLSCREEN_CLASS,
  FLOW_FULLSCREEN_PANNABLE_CLASS,
  FLOW_FULLSCREEN_WITH_AI_CLASS,
  FLOW_INSPECTOR_BODY_CLASS,
  FLOW_INSPECTOR_CLASS,
  FLOW_INSPECTOR_EMPTY_CLASS,
  FLOW_INSPECTOR_HEADER_CLASS,
  FLOW_ROUTE_COUNT_CLASS,
  FLOW_RULE_CONDITION_CONTROLS_CLASS,
  FLOW_RULE_CONDITION_INPUT_CLASS,
  FLOW_RULE_DELETE_CLASS,
  FLOW_RULE_EDITOR_CLASS,
  FLOW_RULE_EMPTY_CLASS,
  FLOW_RULE_FIELD_CLASS,
  FLOW_RULE_FIELD_CONDITION_CLASS,
  FLOW_RULE_FIELD_LABEL_CLASS,
  FLOW_RULE_FIELD_PRIORITY_CLASS,
  FLOW_RULE_FIELD_TARGET_CLASS,
  FLOW_RULE_HEAD_CLASS,
  FLOW_RULE_ITEM_CLASS,
  FLOW_RULE_LABEL_INPUT_CLASS,
  FLOW_RULE_LIST_CLASS,
  FLOW_RULE_PRIORITY_CLASS,
  FLOW_RULE_TARGET_CLASS,
  FLOW_ZOOM_SHELL_CLASS,
  FLOW_ZOOM_CONTROLS_CLASS,
  FLOW_ZOOM_STEP_BUTTON_CLASS,
  FLOW_ZOOM_TOOLBAR_CLASS,
  FLOW_ZOOM_TOOLBAR_FULLSCREEN_CLASS,
  FLOW_ZOOM_VALUE_CLASS,
  FLOW_VIEWER_CLASS,
  FLOW_VIEWER_BODY_CLASS,
  FLOW_VIEWER_FULLSCREEN_CLASS,
  FLOW_VIEWER_FULLSCREEN_PANEL_CLASS,
  FLOW_VIEWER_TITLE_CLASS,
  FLOW_VIEWER_TITLE_MARK_CLASS,
  FLOW_VIEWER_TITLE_META_CLASS,
  flowZoomPresetButtonClass,
  INLINE_ADD_CLASS,
  INLINE_ADD_SETTLED_CLASS,
  INLINE_REMOVE_CLASS,
  NODE_DELETE_CONFIRM_CLASS,
  PILL_OUTLINE_BUTTON_CLASS,
  NODE_INSERT_BUTTON_CLASS,
  NODE_INSERT_ROW_CLASS,
  NODE_INSERT_ROW_EDGE_CLASS,
  RETRY_POLICY_EDITOR_CLASS,
  RETRY_POLICY_FIELD_CLASS,
  PRIMARY_BUTTON_CLASS,
  RETURN_BUTTON_CLASS,
  REWRITE_MODEL_BUTTON_CLASS,
  SAVE_REVIEW_ACTION_DIFF_CLASS,
  SAVE_REVIEW_ACTION_DIFF_NEW_CLASS,
  SAVE_REVIEW_ACTION_DIFF_OLD_CLASS,
  SAVE_REVIEW_DIFF_CLASS,
  SAVE_REVIEW_DIFF_PATH_CLASS,
  SAVE_REVIEW_DIFF_ROW_CLASS,
  SAVE_REVIEW_DIFF_SIGN_CLASS,
  SAVE_REVIEW_DIFF_SIGN_NEW_CLASS,
  SAVE_REVIEW_DIFF_SIGN_OLD_CLASS,
  SAVE_REVIEW_FORM_CLASS,
  SAVE_REVIEW_FORM_LABEL_CLASS,
  SECTION_CARD_TITLE_CLASS,
  SELECTION_MARK_CLASS,
  SOURCE_ACTION_ADD_CLASS,
  SOURCE_ACTION_EDIT_BUTTON_CLASS,
  SOURCE_ACTION_EMPTY_CLASS,
  SOURCE_ACTION_EDITOR_CLASS,
  SOURCE_ACTION_LIST_CLASS,
  SOURCE_ACTION_LIST_EDITABLE_CLASS,
  SOURCE_ACTION_PICKER_CLASS,
  SOURCE_ACTION_REMOVE_CLASS,
  SOURCE_ACTION_SELECT_CLASS,
  SOURCE_ACTION_TOKEN_CLASS,
  SOURCE_EMPTY_STATE_CLASS,
  SOURCE_EMPTY_TEXT_CLASS,
  SOURCE_CARD_CLASS,
  SOURCE_COLLAPSIBLE_EDITOR_CLASS,
  SOURCE_COLLAPSIBLE_HEAD_CLASS,
  SOURCE_COLLAPSIBLE_PREVIEW_CLASS,
  SOURCE_COLLAPSIBLE_PREVIEW_MUTED_CLASS,
  SOURCE_COLLAPSIBLE_TOGGLE_CLASS,
  SOURCE_EDIT_FIELD_CLASS,
  SOURCE_EDIT_HINT_CLASS,
  SOURCE_EDIT_INPUT_CLASS,
  SOURCE_GROUP_TITLE_CLASS,
  SOURCE_INPUT_CLASS,
  SOURCE_JSON_INLINE_CLASS,
  SOURCE_KEY_CLASS,
  SOURCE_LINE_CLASS,
  SOURCE_MD_CLASS,
  SOURCE_META_LIST_CLASS,
  SOURCE_READONLY_VALUE_CLASS,
  SOURCE_RENDERED_CLASS,
  SOURCE_SELECT_CLASS,
  SOURCE_STEP_BLOCK_CLASS,
  SOURCE_STEP_HEADER_CLASS,
  SOURCE_STEP_TITLE_EDIT_CLASS,
  SOURCE_STEPS_CLASS,
  SOURCE_TITLE_INPUT_CLASS,
  SOURCE_TOOLBAR_CLASS,
  SOURCE_VALUE_CLASS,
  TOOL_ACTION_BUTTON_CLASS,
  TOOL_ACTION_CONFIRM_CLASS,
  TOOL_ACTION_GROUP_CLASS,
  TOOL_ACTION_GROUP_DETAIL_CLASS,
  TOOL_ACTION_REJECT_CLASS,
  TOOL_METHOD_CLASS,
  TOOL_SUGGESTION_ACTIONS_CLASS,
  TOOL_SUGGESTION_CLASS,
  TOOL_SUGGESTION_DESC_CLASS,
  TOOL_SUGGESTION_DETAIL_CLASS,
  TOOL_SUGGESTION_DETAIL_FOOTER_CLASS,
  TOOL_SUGGESTION_DETAIL_PRE_CLASS,
  TOOL_SUGGESTION_HEAD_CLASS,
  TOOL_SUGGESTION_MAIN_CLASS,
  TOOL_SUGGESTION_META_CLASS,
  TOOL_SUGGESTION_TITLE_CLASS,
  TOOL_SUGGESTIONS_CLASS,
  UPLOAD_LIST_CLASS,
  UPLOAD_NAME_CLASS,
  UPLOAD_STATUS_CLASS,
  WORKBENCH_CLASS,
  actionChipClass,
  chatBubbleClass,
  chatRowClass,
  distillFlowNodeClass,
  distillSourceSectionClass,
  flowEdgeLabelClass,
  toolStatusBadgeClass,
  uploadItemClass,
  type ToolStatusBadgeVariant,
} from './distillPageStyles';
import { buildDistillFailure, type DistillFailure } from './distillFailure';
import {
  normalizeSkillFlowWheelDelta,
  reanchorSkillFlowConnection,
  skillNodeFlowPosition,
  withSkillNodeFlowPosition,
  withoutSkillEdgeAt,
  type SkillFlowConnectionPreview,
  type SkillFlowPosition,
} from './skillFlowModel';

type ChatItem = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  outgoingText?: string;
  createdAt?: string;
  thinking?: 'running' | 'done';
  thinkingDetails?: string[];
  thinkingOpen?: boolean;
  failure?: DistillFailure;
  failureOpen?: boolean;
  warnings?: string[];
  toolSuggestions?: ToolSuggestionItem[];
  actionState?: 'pending' | 'confirmed' | 'rejected';
  snapshotBefore?: DistillHistorySnapshot;
  operations?: DistillHistoryOperation[];
};

type ChatAttachment = {
  id: string;
  name: string;
  type: string;
};

type ToolSuggestionItem = ToolSuggestion & {
  status?: 'pending' | 'accepted' | 'created' | 'rejected';
  probeStatus?: 'idle' | 'probing' | 'success' | 'error';
};

type ProbeToolOptions = {
  sampleArguments?: Record<string, unknown>;
  silent?: boolean;
  allowWhileLoading?: boolean;
};

type UploadAttachment = {
  id: string;
  name: string;
  status: 'uploading' | 'ready' | 'error';
  text?: string;
  error?: string;
};

type TargetSelection = {
  path: string;
  label: string;
};
type ToolDescriptionMap = Record<string, string>;
type ToolActionStatus = 'existing' | 'pending' | 'accepted' | 'created' | 'rejected' | 'incomplete';
type ToolStatusMap = Record<string, ToolActionStatus>;

type ViewMode = 'source' | 'flow';

type SelectOption = {
  value: string;
  label: string;
};

type CapabilityReferenceOption = SelectOption & {
  description?: string;
  capabilityScope?: unknown;
  unavailableReason?: string;
};

const CAPABILITY_REFERENCE_FIELDS = [
  'general_skill_ids',
  'tool_ids',
  'knowledge_base_ids',
  'required_general_skill_ids',
  'required_tool_ids',
  'required_knowledge_base_ids',
];

const REQUIRED_CAPABILITY_FIELD_BY_ALLOWED: Record<string, string> = {
  general_skill_ids: 'required_general_skill_ids',
  tool_ids: 'required_tool_ids',
  knowledge_base_ids: 'required_knowledge_base_ids',
};

const NODE_TYPE_OPTIONS: SelectOption[] = [
  { value: 'collect_info', label: '收集信息' },
  { value: 'decision', label: '条件判断' },
  { value: 'tool_call', label: '调用工具' },
  { value: 'knowledge_query', label: '检索知识' },
  { value: 'response', label: '回复用户' },
  { value: 'handoff', label: '转人工' },
  { value: 'subflow', label: '调用子 SOP' },
];

const BASE_ACTION_OPTIONS: SelectOption[] = [
  { value: 'ask_user', label: '询问用户' },
  { value: 'continue_flow', label: '继续流程' },
  { value: 'answer_user', label: '回复用户' },
  { value: 'handoff_human', label: '转人工' },
  { value: 'ask_clarification', label: '澄清问题' },
  { value: 'clarify_user', label: '澄清用户需求' },
  { value: 'update_memory', label: '更新记忆' },
  { value: 'reflect', label: '反思检查' },
  { value: 'finish', label: '结束流程' },
  { value: 'stop', label: '停止流程' },
];

const CONDITION_PRESET_OPTIONS: SelectOption[] = [
  { value: '__always__', label: '总是可进入' },
  { value: 'missing_required_info', label: '缺少任一必填信息' },
  { value: 'missing_slots([])', label: '缺少指定字段' },
  { value: 'all_required_info_collected', label: '必填信息已收集完成' },
  { value: 'tool_success', label: '工具执行成功' },
  { value: 'tool_failed', label: '工具执行失败' },
  { value: 'user_confirmed', label: '用户已确认' },
  { value: 'user_rejected', label: '用户已拒绝' },
  { value: '__custom__', label: '自定义条件' },
];

const CONDITION_PRESET_TEXT: Record<string, string> = {
  missing_required_info: '还有必填信息没有收集到时进入',
  'missing_slots([])': '缺少某个指定字段时进入',
  all_required_info_collected: '所有必填信息都收集完成后进入',
  tool_success: '上一步工具调用成功后进入',
  tool_failed: '上一步工具调用失败后进入',
  user_confirmed: '用户明确确认后进入',
  user_rejected: '用户明确拒绝后进入',
};

const RETRY_STRATEGY_OPTIONS: SelectOption[] = [
  { value: 'ask_user', label: '继续追问用户' },
  { value: 'reflect', label: '反思并修正' },
  { value: 'retry_tool', label: '重新调用工具' },
  { value: 'handoff_human', label: '转人工处理' },
  { value: 'skip', label: '跳过当前节点' },
  { value: 'stop', label: '停止流程' },
];

type PendingChange = {
  assistantId: string;
  previousDraft: SkillCard;
  nextDraft: SkillCard;
  changedPaths: string[];
};
type TextDiffPhase = 'mark' | 'type' | 'settled';
type TextDiffAnimation = {
  key: string;
  path: string;
  field: string;
  prefix: string;
  removed: string;
  inserted: string;
  suffix: string;
  phase: TextDiffPhase;
  progress: number;
};

type ActiveDistillJob = {
  jobId: string;
  kind: 'distill' | 'rewrite';
  assistantId: string;
  lastSeq: number;
  status?: string;
  createPayload?: { title: string; raw_content: string };
  previousDraft?: SkillCard;
  targets?: string[];
};

const DEFAULT_TARGET_PATHS: string[] = [];
const DEFAULT_DISTILL_MESSAGES: ChatItem[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: '请粘贴原始技能说明，或点击右侧某一块后告诉我需要怎样改写。',
  },
];
const DISTILL_REWRITE_MODEL_STORAGE_KEY = 'skill-distill-rewrite-model';
const _CHANNEL_LABELS: Record<string, string> = { feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信', wechat: '微信', web: '网页端' };
const UNASSIGNED_USER_VALUE = '__unassigned__';
// 渠道转接通知运行时已支持飞书/企微私聊,处理人选项提供对应渠道标注
// (后端同样拒绝其他渠道)。钉钉/微信适配器只能回会话内消息,不在此列。
const HANDOFF_NOTIFY_CHANNELS = new Set(['feishu', 'wecom']);

type HandoffAssigneeUser = {
  id: string;
  username: string;
  display_name?: string;
  source?: string;
  channel_identities?: Array<{ channel: string; display_name?: string; external_user_id?: string }>;
};

export function handoffAssigneeUserOptions(tenantUsers: HandoffAssigneeUser[]): SelectOption[] {
  // 内部成员一律可选(网页端投递);已绑定支持渠道身份的成员追加"姓名（渠道）"选项,
  // 选中后运行时按该渠道转接。其他渠道身份不生成选项(通知未实现),
  // 渠道懒建账号(渠道客户/群聊)也不进入处理人选项。
  const options: SelectOption[] = [];
  tenantUsers.filter((user) => !user.source || user.source === 'web').forEach((user) => {
    const name = user.display_name || user.username || user.id;
    options.push({ value: user.id, label: `${name}（${_CHANNEL_LABELS.web}）` });
    const channels = new Set<string>();
    (user.channel_identities || []).forEach((identity) => {
      const channel = String(identity.channel || '').trim();
      if (channel && HANDOFF_NOTIFY_CHANNELS.has(channel)) channels.add(channel);
    });
    channels.forEach((channel) => {
      options.push({
        value: `${user.id}::${channel}`,
        label: `${name}（${_CHANNEL_LABELS[channel] || channel}）`,
      });
    });
  });
  return options;
}

type DistillCacheSnapshot = {
  draft: SkillCard | null;
  loadedSkill: SkillRead | null;
  lastSavedDraft: SkillCard | null;
  messages: ChatItem[];
  input: string;
  selectedPaths: string[];
  highlightedPaths: string[];
  updatingPaths: string[];
  dirtyPaths: string[];
  textDiffs: TextDiffAnimation[];
  pendingChange: PendingChange | null;
  viewMode: ViewMode;
  attachments: UploadAttachment[];
  streamStatus: string;
  activeJob: ActiveDistillJob | null;
};

type DistillHistoryOperationKind = 'skill_change' | 'version_save' | 'tool_add';

type DistillHistoryOperation = {
  kind: DistillHistoryOperationKind;
  label: string;
  skillId?: string;
  version?: string;
  toolId?: string;
  toolName?: string;
};

type DistillHistorySnapshot = {
  draft: SkillCard | null;
  loadedSkill: SkillRead | null;
  lastSavedDraft: SkillCard | null;
  selectedPaths: string[];
  highlightedPaths: string[];
  updatingPaths: string[];
  dirtyPaths: string[];
  textDiffs: TextDiffAnimation[];
  pendingChange: PendingChange | null;
  viewMode: ViewMode;
  tools: ToolRead[];
  attachments: UploadAttachment[];
  streamStatus: string;
};

type EditingMessage = {
  id: string;
  text: string;
};

type DistillPageProps = {
  active?: boolean;
  searchParamsOverride?: URLSearchParams;
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

function lockSkillIdForDraft(draft: SkillCard, lockedSkillId: string): SkillCard {
  if (!lockedSkillId || draft.skill_id === lockedSkillId) return draft;
  return { ...cloneSkill(draft), skill_id: lockedSkillId };
}

function lockNullableSkillIdForDraft(draft: SkillCard | null, lockedSkillId: string): SkillCard | null {
  return draft ? lockSkillIdForDraft(draft, lockedSkillId) : null;
}

function lockPendingChangeSkillId(change: PendingChange | null, lockedSkillId: string): PendingChange | null {
  if (!change || !lockedSkillId) return change;
  return {
    ...change,
    previousDraft: lockSkillIdForDraft(change.previousDraft, lockedSkillId),
    nextDraft: lockSkillIdForDraft(change.nextDraft, lockedSkillId),
  };
}

export default function DistillPage({ active = true, searchParamsOverride, currentUser, onLogout }: DistillPageProps = {}) {
  const { navigate, api, notify, streamGet, streamPost, restoreEditorReadSnapshot, saveVersionPolicy, permitsNativeConflictRecovery, tenantId: TENANT_ID, readEmployeeScope, isTeamScope } = useDistillPageHost();
  const [routerSearchParams] = useSearchParams();
  const searchParams = searchParamsOverride || routerSearchParams;
  const skillId = searchParams.get('skill_id');
  const mode = searchParams.get('mode') || '';
  const workspaceId = searchParams.get('workspace_id') || '';
  const editorContext = searchParams.get('editor_context') || '';
  const draftId = searchParams.get('draft_id') || '';
  const publishedVersion = searchParams.get('published_version') || '';
  const editorReadQuery = draftId ? `&draft_id=${encodeURIComponent(draftId)}` : publishedVersion ? `&published_version=${encodeURIComponent(publishedVersion)}` : '';
  const [selectedAgentId, setSelectedAgentId] = useState(readEmployeeScope);
  const activeAgentId = searchParams.get('agent_id') || selectedAgentId;
  const agentQuery = activeAgentId ? `&agent_id=${encodeURIComponent(activeAgentId)}` : '';
  const agentSearchParam = activeAgentId ? `agent_id=${encodeURIComponent(activeAgentId)}` : '';
  const agentOnlyQuery = agentSearchParam ? `?${agentSearchParam}` : '';
  const cacheIdentity = skillId || (mode === 'create' ? `create:${workspaceId || 'pending'}` : mode || 'new');
  const cacheKey = `skill-distill:${TENANT_ID}:${activeAgentId || 'default'}:${cacheIdentity}${editorContext ? `:context:${encodeURIComponent(editorContext)}` : ''}`;
  const [draft, setDraft] = useState<SkillCard | null>(null);
  const [loadedSkill, setLoadedSkill] = useState<SkillRead | null>(null);
  const [lastSavedDraft, setLastSavedDraft] = useState<SkillCard | null>(null);
  const [messages, setMessages] = useState<ChatItem[]>(DEFAULT_DISTILL_MESSAGES);
  const [input, setInput] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>(DEFAULT_TARGET_PATHS);
  const [highlightedPaths, setHighlightedPaths] = useState<string[]>([]);
  const [updatingPaths, setUpdatingPaths] = useState<string[]>([]);
  const [dirtyPaths, setDirtyPaths] = useState<string[]>([]);
  const [textDiffs, setTextDiffs] = useState<TextDiffAnimation[]>([]);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);
  const [saveDraftSnapshot, setSaveDraftSnapshot] = useState<SkillCard | null>(null);
  const [saveName, setSaveName] = useState('');
  const [saveDomain, setSaveDomain] = useState('');
  const [saveVersion, setSaveVersion] = useState('');
  const [assignedVersionLabel, setAssignedVersionLabel] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearAfterSave, setClearAfterSave] = useState(false);
  const [clearNewConfirm, setClearNewConfirm] = useState<{ title: string; description: string } | null>(null);
  const [rerunConfirm, setRerunConfirm] = useState<{
    index: number;
    snapshot: DistillHistorySnapshot;
    rollbackOperations: DistillHistoryOperation[];
    text: string;
    outgoingText: string;
  } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('flow');
  const [flowFullscreen, setFlowFullscreen] = useState(false);
  const [flowAssistantPanelOpen, setFlowAssistantPanelOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [attachments, setAttachments] = useState<UploadAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [toolDetail, setToolDetail] = useState<ToolSuggestionItem | null>(null);
  const [toolDetailMessageId, setToolDetailMessageId] = useState<string | null>(null);
  const [probeArgsText, setProbeArgsText] = useState('');
  const [tools, setTools] = useState<ToolRead[]>([]);
  const [generalSkills, setGeneralSkills] = useState<GeneralSkillRead[]>([]);
  const [sopSkills, setSopSkills] = useState<SkillRead[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [tenantUsers, setTenantUsers] = useState<Array<{ id: string; username: string; display_name?: string; source?: string; channel_identities?: Array<{ channel: string; display_name?: string; external_user_id?: string; external_account_scope?: string }> }>>([]);
  const [modelConfigs, setModelConfigs] = useState<ModelConfigRead[]>([]);
  const [selectedRewriteModelId, setSelectedRewriteModelId] = useState(
    () => window.localStorage.getItem(`${DISTILL_REWRITE_MODEL_STORAGE_KEY}:${TENANT_ID}`) || '',
  );
  const [streamStatus, setStreamStatus] = useState('');
  const [activeJob, setActiveJob] = useState<ActiveDistillJob | null>(null);
  const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(null);
  const [sourceAutoScroll, setSourceAutoScroll] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);
  const uploadControllersRef = useRef<Record<string, AbortController>>({});
  const dragDepthRef = useRef(0);
  const animationTimersRef = useRef<number[]>([]);
  const capabilityCatalogRequestRef = useRef(0);
  const sourceScrollRef = useRef<HTMLDivElement | null>(null);
  const chatMessagesRef = useRef<HTMLDivElement | null>(null);
  const [cacheReady, setCacheReady] = useState(false);
  const [hydratedCacheKey, setHydratedCacheKey] = useState('');

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setSelectedAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, []);

  useEffect(() => {
    if (!active || skillId || mode !== 'create' || workspaceId) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('workspace_id', createDistillWorkspaceId());
    navigate(`/enterprise/skills/distill?${nextParams.toString()}`, { replace: true });
  }, [active, mode, navigate, searchParams, skillId, workspaceId]);

  useEffect(() => {
    setCacheReady(false);
    setHydratedCacheKey('');
    if (mode === 'create' && !workspaceId) return;
    const cached = readDistillCache(cacheKey);
    if (cached) {
      if (skillId && isBlankDistillWorkspace(cached)) {
        removeDistillCache(cacheKey);
      } else {
        const cachedLockedSkillId = cached.loadedSkill?.skill_id || skillId || '';
        // Restore the precondition from the same cached read as this content.
        // Never fetch a newer ETag to authorize an older editable draft.
        if (cached.loadedSkill) restoreEditorReadSnapshot?.(cached.loadedSkill);
        setDraft(lockNullableSkillIdForDraft(cached.draft, cachedLockedSkillId));
        setLoadedSkill(cached.loadedSkill);
        setLastSavedDraft(lockNullableSkillIdForDraft(cached.lastSavedDraft, cachedLockedSkillId));
        setMessages(cached.messages.length > 0 ? cached.messages : DEFAULT_DISTILL_MESSAGES);
        setInput(cached.input);
        setSelectedPaths(normalizeInitialSelectedPaths(cached.selectedPaths));
        setHighlightedPaths(cached.highlightedPaths);
        setUpdatingPaths(cached.updatingPaths);
        setDirtyPaths(cached.dirtyPaths);
        setTextDiffs(cached.textDiffs);
        setPendingChange(lockPendingChangeSkillId(cached.pendingChange, cachedLockedSkillId));
        setViewMode('flow');
        setAttachments(cached.attachments.filter((item) => item.status !== 'uploading'));
        setStreamStatus(cached.streamStatus);
        setActiveJob(cached.activeJob || null);
        if (cached.activeJob && cached.activeJob.status !== 'succeeded' && cached.activeJob.status !== 'failed') {
          setLoading(true);
        }
        setSaveDraftSnapshot(null);
        setHydratedCacheKey(cacheKey);
        setCacheReady(true);
        return;
      }
    }

    if (!skillId) {
      setDraft(null);
      setLoadedSkill(null);
      setLastSavedDraft(null);
      setMessages(DEFAULT_DISTILL_MESSAGES);
      setInput('');
      setSelectedPaths(DEFAULT_TARGET_PATHS);
      setPendingChange(null);
      setHighlightedPaths([]);
      setUpdatingPaths([]);
      setDirtyPaths([]);
      setTextDiffs([]);
      setAttachments([]);
      setStreamStatus('');
      setSaveDraftSnapshot(null);
      setHydratedCacheKey(cacheKey);
      setCacheReady(true);
      return;
    }

    api
      .get<SkillRead>(`/api/enterprise/skills/${encodeURIComponent(skillId)}?tenant_id=${TENANT_ID}${agentQuery}${editorReadQuery}`)
      .then((result) => {
        const nextContent = lockSkillIdForDraft(result.content, result.skill_id || skillId || '');
        const nextResult = nextContent === result.content ? result : { ...result, content: nextContent };
        setDraft(nextContent);
        setLoadedSkill(nextResult);
        setLastSavedDraft(nextContent);
        setSelectedPaths(DEFAULT_TARGET_PATHS);
        setPendingChange(null);
        setHighlightedPaths([]);
        setUpdatingPaths([]);
        setDirtyPaths([]);
        setTextDiffs([]);
        setAttachments([]);
        setStreamStatus('');
        setSaveDraftSnapshot(null);
        setMessages([
          {
            id: 'loaded',
            role: 'assistant',
            content: `已加载「${result.name}」。你可以在右侧选择一个或多个区域，然后在这里描述需要怎样改写。`,
          },
        ]);
        setHydratedCacheKey(cacheKey);
        setCacheReady(true);
      })
      .catch((error) => {
        notify.error(error instanceof Error ? error.message : '加载技能失败');
        setHydratedCacheKey(cacheKey);
        setCacheReady(true);
      });
  }, [agentQuery, cacheKey, mode, skillId, workspaceId, editorReadQuery]);

  useEffect(() => {
    if (!cacheReady || hydratedCacheKey !== cacheKey) return;
    writeDistillCache(cacheKey, {
      draft,
      loadedSkill,
      lastSavedDraft,
      messages,
      input,
      selectedPaths,
      highlightedPaths,
      updatingPaths,
      dirtyPaths,
      textDiffs,
      pendingChange,
      viewMode,
      attachments: attachments.filter((item) => item.status !== 'uploading'),
      streamStatus,
      activeJob,
    });
  }, [
    attachments,
    cacheKey,
    cacheReady,
    dirtyPaths,
    draft,
    highlightedPaths,
    hydratedCacheKey,
    input,
    lastSavedDraft,
    loadedSkill,
    loading,
    messages,
    pendingChange,
    selectedPaths,
    streamStatus,
    activeJob,
    textDiffs,
    updatingPaths,
    viewMode,
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      Object.values(uploadControllersRef.current).forEach((controller) => controller.abort());
      clearAnimationTimers();
    };
  }, []);

  useEffect(() => {
    if (!cacheReady || hydratedCacheKey !== cacheKey || !activeJob) return;
    if (activeJob.status === 'succeeded' || activeJob.status === 'failed') return;
    if (abortRef.current) return;
    const controller = new AbortController();
    manualStopRef.current = false;
    abortRef.current = controller;
    setLoading(true);
    void streamGet(
      `/api/enterprise/skills/jobs/${encodeURIComponent(activeJob.jobId)}/stream?after_seq=${activeJob.lastSeq || 0}`,
      (item) => handleResumedJobEvent(activeJob, item),
      controller.signal,
    )
      .catch((error) => {
        if (controller.signal.aborted) return;
        updateMessage(activeJob.assistantId, '生成连接已断开，后端任务仍可继续。', { thinking: 'done' });
        notify.error(error instanceof Error ? error.message : '恢复生成失败');
      })
      .finally(() => finishStream(controller));
  }, [activeJob, cacheKey, cacheReady, hydratedCacheKey]);

  useEffect(() => {
    if (!active) {
      document.body.classList.remove('skill-distill-fixed');
      return;
    }
    document.body.classList.add('skill-distill-fixed');
    return () => {
      document.body.classList.remove('skill-distill-fixed');
    };
  }, [active]);

  const refreshCapabilityCatalog = useCallback(async () => {
    if (!active) return;
    const requestId = capabilityCatalogRequestRef.current + 1;
    capabilityCatalogRequestRef.current = requestId;
    const [toolResult, skillResult, knowledgeResult, sopResult] = await Promise.allSettled([
      api.get<ToolRead[]>(`/api/enterprise/tools?tenant_id=${TENANT_ID}${agentQuery}`),
      api.get<GeneralSkillRead[]>(
        `/api/enterprise/general-skills?tenant_id=${TENANT_ID}${agentQuery}`,
      ),
      api.get<KnowledgeBaseRead[]>(
        `/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}${agentQuery}`,
      ),
      api.get<SkillRead[]>(`/api/enterprise/skills?tenant_id=${TENANT_ID}${agentQuery}`),
    ]);
    if (requestId !== capabilityCatalogRequestRef.current) return;
    if (toolResult.status === 'fulfilled') setTools(toolResult.value);
    if (skillResult.status === 'fulfilled') setGeneralSkills(skillResult.value);
    if (knowledgeResult.status === 'fulfilled') setKnowledgeBases(knowledgeResult.value);
    if (sopResult.status === 'fulfilled') setSopSkills(sopResult.value);
  }, [active, agentQuery]);

  useEffect(() => {
    void refreshCapabilityCatalog();
    return () => {
      capabilityCatalogRequestRef.current += 1;
    };
  }, [refreshCapabilityCatalog]);

  useEffect(() => {
    if (!active) return;
    return subscribeEnterpriseCapabilityCatalogRefresh(() => {
      void refreshCapabilityCatalog();
    });
  }, [active, refreshCapabilityCatalog]);

  useEffect(() => {
    api
      .get<Array<{ id: string; username: string; display_name?: string; source?: string; channel_identities?: Array<{ channel: string; display_name?: string; external_user_id?: string }> }>>(
        `/api/auth/users?tenant_id=${TENANT_ID}&include_channel=true`,
      )
      .then(setTenantUsers)
      .catch(() => setTenantUsers([]));
  }, []);

  useEffect(() => {
    api
      .get<ModelConfigRead[]>(`/api/enterprise/model-configs?tenant_id=${TENANT_ID}`)
      .then((rows) => {
        const enabled = rows.filter((item) => item.enabled);
        setModelConfigs(enabled);
        setSelectedRewriteModelId((current) => {
          if (current && enabled.some((item) => item.id === current)) return current;
          const fallback = enabled.find((item) => item.is_default)?.id || enabled[0]?.id || '';
          if (fallback) {
            window.localStorage.setItem(`${DISTILL_REWRITE_MODEL_STORAGE_KEY}:${TENANT_ID}`, fallback);
          }
          return fallback;
        });
      })
      .catch(() => setModelConfigs([]));
  }, []);

  useEffect(() => {
    if (!chatMessagesRef.current) return;
    chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
  }, [attachments, loading, messages]);

  useEffect(() => {
    if (!loading || !sourceAutoScroll || !sourceScrollRef.current) return;
    sourceScrollRef.current.scrollTop = sourceScrollRef.current.scrollHeight;
  }, [draft, loading, sourceAutoScroll, textDiffs, viewMode]);

  const allPaths = useMemo(() => (draft ? allTargetPaths(draft) : DEFAULT_TARGET_PATHS), [draft]);
  const uploadingFile = attachments.some((item) => item.status === 'uploading');
  const readyAttachments = attachments.filter((item) => item.status === 'ready' && item.text?.trim());
  const allSelected = draft ? selectedPaths.length > 0 && allPaths.every((path) => selectedPaths.includes(path)) : false;
  const toolDescriptions = useMemo(() => buildToolDescriptionMap(tools, messages), [messages, tools]);
  const toolStatuses = useMemo(() => buildToolStatusMap(tools, messages), [messages, tools]);
  const lockedSkillId = loadedSkill?.skill_id || skillId || '';
  const saveReviewDraft = useMemo(() => {
    const sourceDraft = saveDraftSnapshot || draft;
    if (!sourceDraft) return null;
    const nextDraft = {
      ...cloneSkill(sourceDraft),
      name: saveName.trim() || sourceDraft.name,
      business_domain: saveDomain.trim() || undefined,
      version: saveVersion.trim() || sourceDraft.version,
    };
    return lockSkillIdForDraft(nextDraft, lockedSkillId);
  }, [draft, lockedSkillId, saveDomain, saveDraftSnapshot, saveName, saveVersion]);
  const saveReviewDiffs = useMemo(() => {
    if (!saveReviewDraft) return [];
    const baseDraft = lastSavedDraft || blankSkillForAnimation(saveReviewDraft);
    const changedPaths = diffTargetPaths(baseDraft, saveReviewDraft, allTargetPaths(saveReviewDraft));
    return collectTextDiffs(baseDraft, saveReviewDraft, changedPaths).filter((diff) => diff.field !== 'version');
  }, [lastSavedDraft, saveReviewDraft]);
  const hasSaveableDraftChanges = useMemo(
    () => hasSkillContentChanges(lockNullableSkillIdForDraft(pendingChange?.nextDraft || draft, lockedSkillId), lastSavedDraft),
    [draft, lastSavedDraft, lockedSkillId, pendingChange],
  );
  const saveReviewHasContentChanges = useMemo(
    () => hasSkillContentChanges(saveReviewDraft, lastSavedDraft),
    [lastSavedDraft, saveReviewDraft],
  );

  useEffect(() => {
    if (!lockedSkillId) return;
    setDraft((current) => lockNullableSkillIdForDraft(current, lockedSkillId));
    setLastSavedDraft((current) => lockNullableSkillIdForDraft(current, lockedSkillId));
    setSaveDraftSnapshot((current) => lockNullableSkillIdForDraft(current, lockedSkillId));
    setPendingChange((current) => lockPendingChangeSkillId(current, lockedSkillId));
  }, [lockedSkillId]);

  async function send() {
    const text = buildOutgoingText(input, readyAttachments);
    if (!text || loading || uploadingFile) return;
    const displayText = input.trim();
    const displayAttachments = buildDisplayAttachments(readyAttachments);
    const snapshotBefore = createHistorySnapshot();
    const confirmedDraft = lockNullableSkillIdForDraft(pendingChange?.nextDraft || draft, lockedSkillId);
    confirmPendingChange(false);
    setInput('');
    setAttachments([]);
    pushMessage('user', displayText, { attachments: displayAttachments, outgoingText: text, snapshotBefore });
    if (!confirmedDraft) {
      await createDraftFromText(text);
      return;
    }
    await rewriteSelectedTarget(text, confirmedDraft);
  }

  async function createDraftFromText(text: string) {
    const payload = parseInitialSkillPrompt(text);
    setLoading(true);
    setSourceAutoScroll(true);
    setStreamStatus('正在生成 SOP 草稿');
    let streamBuffer = '';
    let latestPreview = createStreamingDraftSeed(payload);
    let latestPreviewSignature = JSON.stringify(latestPreview);
    setDraft(latestPreview);
    setSelectedPaths(DEFAULT_TARGET_PATHS);
    setHighlightedPaths([]);
    setUpdatingPaths([]);
    setTextDiffs([]);
    const assistantId = pushMessage('assistant', '', {
      thinking: 'running',
      thinkingDetails: ['正在理解技能目标与输入信息'],
      thinkingOpen: false,
    });
    const baseJob: ActiveDistillJob = {
      jobId: '',
      kind: 'distill',
      assistantId,
      lastSeq: 0,
      status: 'queued',
      createPayload: payload,
    };
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamPost(
        '/api/enterprise/skills/distill/stream',
        {
          tenant_id: TENANT_ID,
          agent_id: activeAgentId || undefined,
          ...payload,
          model_config_id: selectedRewriteModelId || undefined,
        },
        (item) => {
          trackActiveJobEvent(item, baseJob);
          if (item.event === 'status') {
            appendThinkingDetail(assistantId, String(item.data.text || '正在处理'));
            return;
          }
          if (item.event === 'chunk_reset') {
            streamBuffer = '';
            latestPreview = createStreamingDraftSeed(payload);
            latestPreviewSignature = JSON.stringify(latestPreview);
            setDraft(latestPreview);
            return;
          }
          if (item.event === 'chunk') {
            const content = typeof item.data.content === 'string' ? item.data.content : '';
            if (!content) return;
            streamBuffer += content;
            const preview = previewSkillFromStream(streamBuffer, latestPreview, payload);
            const previewSignature = JSON.stringify(preview);
            if (previewSignature !== latestPreviewSignature) {
              latestPreview = preview;
              latestPreviewSignature = previewSignature;
              setDraft(preview);
              setStreamStatus('正在解码技能结构');
            }
            return;
          }
          if (item.event === 'complete') {
            const draftSkill = lockSkillIdForDraft(item.data.draft_skill as SkillCard, lockedSkillId);
            const nextWarnings = Array.isArray(item.data.warnings) ? item.data.warnings.map(String) : [];
            const nextToolSuggestions = normalizeToolSuggestions(item.data.tool_suggestions);
            appendThinkingDetail(assistantId, `已生成 SOP 草稿：${draftSkill.name}`);
            clearAnimationTimers();
            setDraft(draftSkill);
            setHighlightedPaths([]);
            setUpdatingPaths([]);
            setTextDiffs([]);
            setSelectedPaths(DEFAULT_TARGET_PATHS);
            updateMessage(
              assistantId,
              `已生成「${draftSkill.name}」草稿。你可以在右侧选择一个或多个区域继续改写。`,
              {
                thinking: 'done',
                warnings: nextWarnings,
                toolSuggestions: nextToolSuggestions,
                operations: [{ kind: 'skill_change', label: `生成 SOP 草稿：${draftSkill.name}`, skillId: draftSkill.skill_id }],
              },
            );
            setStreamStatus('生成完成');
            if (nextToolSuggestions.length > 0) {
              void autoProbeToolSuggestions(assistantId, nextToolSuggestions);
            }
            setActiveJob(null);
            return;
          }
          if (item.event === 'error') {
            applyDistillFailure(assistantId, item.data.message, 'distill');
            setActiveJob(null);
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted && !manualStopRef.current) return;
      appendThinkingDetail(assistantId, '生成失败，已保留当前草稿');
      applyDistillFailure(assistantId, error, 'distill');
      if (controller.signal.aborted) {
        notify.info('已停止生成');
      } else {
        notify.error(error instanceof Error ? error.message : '生成失败');
      }
    } finally {
      finishStream(controller);
    }
  }

  async function rewriteSelectedTarget(
    text: string,
    currentDraft: SkillCard | null = draft,
    targetPathsOverride?: string[],
    initialThinkingDetails?: string[],
    conversationOverride?: ChatItem[],
  ) {
    if (!currentDraft) return;
    setSourceAutoScroll(false);
    const editableDraft = canonicalizeSkillCapabilityRefs(lockSkillIdForDraft(currentDraft, lockedSkillId));
    const previousDraft = cloneSkill(editableDraft);
    const targets = targetPathsOverride?.length
      ? targetPathsOverride
      : selectedPaths.length > 0
        ? selectedPaths
        : allTargetPaths(editableDraft);
    const scopeLabel = targetLabel(targets, editableDraft);
    setLoading(true);
    setStreamStatus('正在改写选中内容');
    const assistantId = pushMessage('assistant', '', {
      thinking: 'running',
      thinkingDetails: initialThinkingDetails || [`改写范围：${scopeLabel}`],
      thinkingOpen: false,
    });
    const baseJob: ActiveDistillJob = {
      jobId: '',
      kind: 'rewrite',
      assistantId,
      lastSeq: 0,
      status: 'queued',
      previousDraft,
      targets,
    };
    const controller = new AbortController();
    let receivedMessageChunk = false;
    manualStopRef.current = false;
    abortRef.current = controller;
    try {
      await streamPost(
        `/api/enterprise/skills/${encodeURIComponent(editableDraft.skill_id)}/rewrite/stream`,
        {
          tenant_id: TENANT_ID,
          agent_id: activeAgentId || undefined,
          current_skill: editableDraft,
          instruction: text,
          model_config_id: selectedRewriteModelId || undefined,
          target_path: targets[0],
          target_paths: targets,
          target_label: scopeLabel,
          conversation: (conversationOverride || messages).map((item) => ({ role: item.role, content: item.content })),
        },
        (item) => {
          trackActiveJobEvent(item, baseJob);
          if (item.event === 'status') {
            appendThinkingDetail(assistantId, String(item.data.text || '正在处理'));
            return;
          }
          if (item.event === 'message_chunk') {
            const content = typeof item.data.content === 'string' ? item.data.content : '';
            if (content) {
              receivedMessageChunk = true;
              appendMessage(assistantId, content);
            }
            return;
          }
          if (item.event === 'complete') {
            const nextDraft = lockSkillIdForDraft(item.data.draft_skill as SkillCard, lockedSkillId);
            const nextWarnings = Array.isArray(item.data.warnings) ? item.data.warnings.map(String) : [];
            const nextToolSuggestions = normalizeToolSuggestions(item.data.tool_suggestions);
            const changedPaths = diffTargetPaths(previousDraft, nextDraft, targets);
            const changedLabel = changedPaths.length > 0 ? targetLabel(changedPaths, nextDraft) : '未检测到结构变化';
            appendThinkingDetail(assistantId, `模型返回改写结果：${changedLabel}`);
            appendThinkingDetail(assistantId, '右侧已更新预览，等待确认或拒绝');
            animateDraftChange(previousDraft, nextDraft, changedPaths);
            setPendingChange({ assistantId, previousDraft, nextDraft, changedPaths });
            setSelectedPaths((current) => reconcileSelectedPaths(current, nextDraft));
            setStreamStatus('改写完成');
            if (!receivedMessageChunk) {
              updateMessage(
                assistantId,
                String(item.data.assistant_message || '已完成局部改写。'),
                {
                  thinking: 'done',
                  warnings: nextWarnings,
                  toolSuggestions: nextToolSuggestions,
                  actionState: 'pending',
                  operations: changedPaths.length
                    ? [{ kind: 'skill_change', label: `改写：${changedLabel}`, skillId: nextDraft.skill_id }]
                    : [],
                },
              );
            } else {
              updateMessage(assistantId, undefined, {
                thinking: 'done',
                warnings: nextWarnings,
                toolSuggestions: nextToolSuggestions,
                actionState: 'pending',
                operations: changedPaths.length
                  ? [{ kind: 'skill_change', label: `改写：${changedLabel}`, skillId: nextDraft.skill_id }]
                  : [],
              });
            }
            if (nextToolSuggestions.length > 0) {
              void autoProbeToolSuggestions(assistantId, nextToolSuggestions);
            }
            setActiveJob(null);
            return;
          }
          if (item.event === 'error') {
            applyDistillFailure(assistantId, item.data.message, 'rewrite');
            setActiveJob(null);
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted && !manualStopRef.current) return;
      appendThinkingDetail(assistantId, '改写失败，已保留当前草稿');
      applyDistillFailure(assistantId, error, 'rewrite');
      if (controller.signal.aborted) {
        notify.info('已停止改写');
      } else {
        notify.error(error instanceof Error ? error.message : '改写失败');
      }
    } finally {
      finishStream(controller);
    }
  }

  function openSaveReview(options: { clearAfterSave?: boolean } = {}) {
    const targetDraft = lockNullableSkillIdForDraft(pendingChange?.nextDraft || draft, lockedSkillId);
    if (!targetDraft) return;
    if (!hasSkillContentChanges(targetDraft, lastSavedDraft)) {
      notify.info('当前没有内容变化，无需保存草稿。');
      return;
    }
    confirmPendingChange(false);
    setClearAfterSave(Boolean(options.clearAfterSave));
    setSaveDraftSnapshot(targetDraft);
    setSaveName(targetDraft.name);
    setSaveDomain(targetDraft.business_domain || '');
    const versionPolicy = loadedSkill ? saveVersionPolicy?.(loadedSkill) : undefined;
    setAssignedVersionLabel(versionPolicy?.label || '');
    setSaveVersion(versionPolicy ? targetDraft.version : loadedSkill ? bumpSkillVersion(loadedSkill.version || targetDraft.version) : '1.0.0');
    setSaveReviewOpen(true);
  }

  async function saveDraft() {
    if (!saveReviewDraft) return;
    if (!hasSkillContentChanges(saveReviewDraft, lastSavedDraft)) {
      notify.info('当前没有内容变化，无需保存草稿。');
      return;
    }
    let finalDraft: SkillCard = canonicalizeSkillCapabilityRefs(
      normalizeSubflowNodes(lockSkillIdForDraft(saveReviewDraft, lockedSkillId)),
    );
    let renamedSkillId = '';
    try {
      let savedSkill: SkillRead;
      if (loadedSkill) {
        savedSkill = await api.put<SkillRead>(`/api/enterprise/skills/${loadedSkill.skill_id}${agentOnlyQuery}`, {
          tenant_id: TENANT_ID,
          content: finalDraft,
          status: loadedSkill.status,
        });
      } else {
        try {
          savedSkill = await api.post<SkillRead>(`/api/enterprise/skills${agentOnlyQuery}`, { tenant_id: TENANT_ID, content: finalDraft, status: 'published' });
        } catch (error) {
          if (!permitsNativeConflictRecovery?.(error)) throw error;
          finalDraft = {
            ...cloneSkill(finalDraft),
            skill_id: uniqueDraftSkillId(finalDraft.skill_id),
          };
          renamedSkillId = finalDraft.skill_id;
          savedSkill = await api.post<SkillRead>(`/api/enterprise/skills${agentOnlyQuery}`, { tenant_id: TENANT_ID, content: finalDraft, status: 'published' });
        }
      }
      const savedContent = lockSkillIdForDraft(savedSkill.content, savedSkill.skill_id || lockedSkillId);
      if (savedContent !== savedSkill.content) {
        savedSkill = { ...savedSkill, content: savedContent };
      }
      setLoadedSkill(savedSkill);
      setDraft(savedContent);
      setLastSavedDraft(savedContent);
      setSaveDraftSnapshot(null);
      setHighlightedPaths([]);
      setDirtyPaths([]);
      setSaveReviewOpen(false);
      appendOperationToLatestMessage({
        kind: 'version_save',
        label: `保存版本 ${savedSkill.version}`,
        skillId: savedSkill.skill_id,
        version: savedSkill.version,
      });
      if (clearAfterSave) {
        setClearAfterSave(false);
        clearDistillWorkspace();
        notify.success('SOP 已保存，当前改写已清空');
      } else {
        notify.success(renamedSkillId ? `SOP ID 已存在，已另存为 ${renamedSkillId}` : 'SOP 已保存');
      }
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存失败');
    }
  }

  function stopStream() {
    const jobId = activeJob?.jobId;
    manualStopRef.current = true;
    if (jobId) {
      void api.post(`/api/enterprise/skills/jobs/${encodeURIComponent(jobId)}/cancel`);
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setActiveJob(null);
    setStreamStatus('已停止');
  }

  function trackActiveJobEvent(item: { event: string; data: Record<string, unknown> }, baseJob: ActiveDistillJob) {
    const jobId = typeof item.data.job_id === 'string' ? item.data.job_id : baseJob.jobId;
    if (!jobId) return;
    const seq = typeof item.data.seq === 'number' ? item.data.seq : baseJob.lastSeq;
    const status = typeof item.data.status === 'string' ? item.data.status : baseJob.status;
    setActiveJob((current) => ({
      ...baseJob,
      ...(current?.jobId === jobId ? current : {}),
      jobId,
      lastSeq: Math.max(current?.jobId === jobId ? current.lastSeq : 0, seq || 0),
      status,
    }));
  }

  function handleResumedJobEvent(job: ActiveDistillJob, item: { event: string; data: Record<string, unknown> }) {
    trackActiveJobEvent(item, job);
    if (item.event === 'status') {
      appendThinkingDetail(job.assistantId, String(item.data.text || '正在处理'));
      return;
    }
    if (item.event === 'message_chunk') {
      const content = typeof item.data.content === 'string' ? item.data.content : '';
      if (content) appendMessage(job.assistantId, content);
      return;
    }
    if (item.event === 'complete') {
      if (job.kind === 'distill') {
        completeResumedDistillJob(job, item.data);
      } else {
        completeResumedRewriteJob(job, item.data);
      }
      setActiveJob(null);
      return;
    }
    if (item.event === 'error') {
      applyDistillFailure(job.assistantId, item.data.message, job.kind);
      setActiveJob(null);
      setLoading(false);
      return;
    }
    if (item.event === 'job_complete') {
      const status = String(item.data.status || '');
      if (status === 'failed') {
        applyDistillFailure(job.assistantId, item.data.error, job.kind);
        setActiveJob(null);
      }
    }
  }

  function completeResumedDistillJob(job: ActiveDistillJob, data: Record<string, unknown>) {
    const rawDraftSkill = data.draft_skill as SkillCard | undefined;
    if (!rawDraftSkill) return;
    const draftSkill = lockSkillIdForDraft(rawDraftSkill, lockedSkillId);
    const nextWarnings = Array.isArray(data.warnings) ? data.warnings.map(String) : [];
    const nextToolSuggestions = normalizeToolSuggestions(data.tool_suggestions);
    clearAnimationTimers();
    setDraft(draftSkill);
    setHighlightedPaths([]);
    setUpdatingPaths([]);
    setTextDiffs([]);
    setSelectedPaths(DEFAULT_TARGET_PATHS);
    appendThinkingDetail(job.assistantId, `已生成 SOP 草稿：${draftSkill.name}`);
    updateMessage(
      job.assistantId,
      `已生成「${draftSkill.name}」草稿。你可以在右侧选择一个或多个区域继续改写。`,
      {
        thinking: 'done',
        warnings: nextWarnings,
        toolSuggestions: nextToolSuggestions,
        operations: [{ kind: 'skill_change', label: `生成 SOP 草稿：${draftSkill.name}`, skillId: draftSkill.skill_id }],
      },
    );
    setStreamStatus('生成完成');
    if (nextToolSuggestions.length > 0) {
      void autoProbeToolSuggestions(job.assistantId, nextToolSuggestions);
    }
  }

  function completeResumedRewriteJob(job: ActiveDistillJob, data: Record<string, unknown>) {
    const rawNextDraft = data.draft_skill as SkillCard | undefined;
    if (!rawNextDraft) return;
    const nextDraft = lockSkillIdForDraft(rawNextDraft, lockedSkillId);
    const previousDraft = lockNullableSkillIdForDraft(job.previousDraft || draft, lockedSkillId);
    if (!previousDraft) {
      setDraft(nextDraft);
      updateMessage(job.assistantId, String(data.assistant_message || '已完成改写。'), { thinking: 'done' });
      return;
    }
    const targets = job.targets?.length ? job.targets : allTargetPaths(previousDraft);
    const nextWarnings = Array.isArray(data.warnings) ? data.warnings.map(String) : [];
    const nextToolSuggestions = normalizeToolSuggestions(data.tool_suggestions);
    const changedPaths = diffTargetPaths(previousDraft, nextDraft, targets);
    const changedLabel = changedPaths.length > 0 ? targetLabel(changedPaths, nextDraft) : '未检测到结构变化';
    appendThinkingDetail(job.assistantId, `模型返回改写结果：${changedLabel}`);
    appendThinkingDetail(job.assistantId, '右侧已更新预览，等待确认或拒绝');
    animateDraftChange(previousDraft, nextDraft, changedPaths);
    setPendingChange({ assistantId: job.assistantId, previousDraft, nextDraft, changedPaths });
    setSelectedPaths((current) => reconcileSelectedPaths(current, nextDraft));
    setStreamStatus('改写完成');
    updateMessage(job.assistantId, String(data.assistant_message || '已完成局部改写。'), {
      thinking: 'done',
      warnings: nextWarnings,
      toolSuggestions: nextToolSuggestions,
      actionState: 'pending',
      operations: changedPaths.length
        ? [{ kind: 'skill_change', label: `改写：${changedLabel}`, skillId: nextDraft.skill_id }]
        : [],
    });
    if (nextToolSuggestions.length > 0) {
      void autoProbeToolSuggestions(job.assistantId, nextToolSuggestions);
    }
  }

  async function stageFileUpload(file: File) {
    if (loading) return;
    const suffix = file.name.toLowerCase().split('.').pop() || '';
    if (!['md', 'txt', 'doc', 'docx'].includes(suffix)) {
      notify.error('仅支持 .md、.doc、.docx、.txt 文件');
      return;
    }
    const id = `file_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const controller = new AbortController();
    uploadControllersRef.current[id] = controller;
    setAttachments((current) => [...current, { id, name: file.name, status: 'uploading' }]);
    try {
      const contentBase64 = await fileToBase64(file);
      if (controller.signal.aborted) return;
      const result = await api.postWithSignal<{ filename: string; text: string }>(
        '/api/enterprise/skills/files/extract',
        {
          filename: file.name,
          content_base64: contentBase64,
        },
        controller.signal,
      );
      setAttachments((current) =>
        current.map((item) =>
          item.id === id ? { id, name: result.filename, status: 'ready', text: result.text } : item,
        ),
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setAttachments((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, status: 'error', error: error instanceof Error ? error.message : '读取文件失败' }
            : item,
        ),
      );
    } finally {
      delete uploadControllersRef.current[id];
    }
  }

  function uploadFiles(files: File[]) {
    files.forEach((file) => {
      void stageFileUpload(file);
    });
  }

  function cancelAttachment(id: string) {
    uploadControllersRef.current[id]?.abort();
    delete uploadControllersRef.current[id];
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    uploadFiles(files);
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    uploadFiles(Array.from(event.dataTransfer.files || []));
  }

  function openToolDetail(messageId: string, suggestion: ToolSuggestionItem) {
    setToolDetailMessageId(messageId);
    setToolDetail(suggestion);
    setProbeArgsText(JSON.stringify(suggestion.sample_arguments || {}, null, 2));
  }

  async function autoProbeToolSuggestions(messageId: string, suggestions: ToolSuggestionItem[]) {
    const extractedSuggestions = suggestions.filter((suggestion) => suggestion.resolution_status !== 'incomplete');
    const pendingSuggestions = suggestions.filter(
      (suggestion) => toolSuggestionResolution(suggestion) === 'new_candidate' && !suggestion.probe_result,
    );
    if (extractedSuggestions.length === 0) return;

    appendThinkingDetail(
      messageId,
      `正在抽取工具：${extractedSuggestions.map((item) => item.display_name || item.name).join('、')}`,
    );
    const existingSuggestions = suggestions.filter((suggestion) => toolSuggestionResolution(suggestion) === 'existing');
    existingSuggestions.forEach((suggestion) => {
      appendThinkingDetail(messageId, `已匹配现有工具：${suggestion.matched_tool_display_name || suggestion.display_name || suggestion.name}`);
    });
    if (pendingSuggestions.length === 0) return;
    appendThinkingDetail(messageId, '正在测试工具接口');
    setStreamStatus('正在测试工具接口');

    let successCount = 0;
    let failureCount = 0;
    for (const suggestion of pendingSuggestions) {
      const result = await probeToolSuggestion(messageId, suggestion, {
        silent: true,
        allowWhileLoading: true,
      });
      if (!result) {
        failureCount += 1;
        appendThinkingDetail(messageId, `工具测试失败：${suggestion.display_name || suggestion.name}`);
        continue;
      }
      if (result.success) {
        successCount += 1;
        appendThinkingDetail(messageId, `工具测试成功：${suggestion.display_name || suggestion.name}`);
      } else {
        failureCount += 1;
        const reason = result.error?.message ? `，${result.error.message}` : '';
        appendThinkingDetail(messageId, `工具测试失败：${suggestion.display_name || suggestion.name}${reason}`);
      }
    }

    appendThinkingDetail(messageId, `工具测试完成：${successCount} 个成功，${failureCount} 个失败`);
    setStreamStatus('工具测试完成');
  }

  async function probeToolSuggestion(
    messageId: string,
    suggestion: ToolSuggestionItem,
    options: ProbeToolOptions = {},
  ): Promise<ToolProbeResponse | null> {
    if (toolSuggestionResolution(suggestion) !== 'new_candidate') return null;
    if ((!options.allowWhileLoading && loading) || suggestion.probeStatus === 'probing') return null;
    const args = options.sampleArguments || suggestion.sample_arguments || {};
    if (Object.keys(args).length === 0) {
      if (!options.silent) notify.warning('缺少样例参数，无法测试接口');
      const result: ToolProbeResponse = {
        success: false,
        inferred_output_schema: {},
        error: { code: 'MISSING_SAMPLE_ARGUMENTS', message: '缺少样例参数，无法测试接口' },
      };
      setToolSuggestionPatch(messageId, suggestion.name, { probeStatus: 'error', probe_result: result });
      return result;
    }
    setToolSuggestionPatch(messageId, suggestion.name, { probeStatus: 'probing' });
    try {
      const payload = {
        ...toolPayloadFromSuggestion(suggestion, lockNullableSkillIdForDraft(pendingChange?.nextDraft || draft, lockedSkillId)?.skill_id, TENANT_ID),
        sample_arguments: args,
      };
      const result = await api.post<ToolProbeResponse>('/api/enterprise/tools/probe', payload);
      const nextOutputSchema = result.success && result.inferred_output_schema
        ? result.inferred_output_schema
        : suggestion.output_schema;
      setToolSuggestionPatch(messageId, suggestion.name, {
        probeStatus: result.success ? 'success' : 'error',
        probe_result: result,
        sample_arguments: args,
        output_schema: nextOutputSchema || {},
      });
      if (result.success) {
        if (!options.silent) notify.success('接口测试成功');
      } else {
        if (!options.silent) notify.error(result.error?.message || '接口测试失败');
      }
      return result;
    } catch (error) {
      const result: ToolProbeResponse = {
        success: false,
        inferred_output_schema: {},
        error: { code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : '接口测试失败' },
      };
      setToolSuggestionPatch(messageId, suggestion.name, {
        probeStatus: 'error',
        probe_result: result,
      });
      if (!options.silent) notify.error(result.error?.message || '接口测试失败');
      return result;
    }
  }

  function applyProbeArgumentsFromDetail() {
    if (!toolDetail || !toolDetailMessageId) return;
    const parsed = parseJsonObject(probeArgsText);
    if (!parsed) {
      notify.error('样例参数必须是 JSON 对象');
      return;
    }
    setToolSuggestionPatch(toolDetailMessageId, toolDetail.name, { sample_arguments: parsed });
    setToolDetail({ ...toolDetail, sample_arguments: parsed });
    notify.success('样例参数已更新');
  }

  function probeToolDetail() {
    if (!toolDetail || !toolDetailMessageId) return;
    const parsed = parseJsonObject(probeArgsText);
    if (!parsed) {
      notify.error('样例参数必须是 JSON 对象');
      return;
    }
    void probeToolSuggestion(toolDetailMessageId, { ...toolDetail, sample_arguments: parsed }, { sampleArguments: parsed });
  }

  async function confirmToolSuggestion(messageId: string, suggestion: ToolSuggestionItem) {
    if (loading) return;
    if (toolSuggestionResolution(suggestion) !== 'new_candidate') {
      notify.warning('该工具不是可新增候选');
      return;
    }
    if (!suggestion.probe_result?.success) {
      notify.warning('请先测试接口成功后再新增工具');
      return;
    }
    const nextSuggestions = nextToolSuggestionsWithPatch(messageId, suggestion.name, { status: 'accepted' });
    setToolSuggestionStatus(messageId, suggestion.name, 'accepted');
    const shouldCommit = toolSuggestionSelectionsComplete(nextSuggestions);
    if (!shouldCommit) {
      notify.success('已确认，等待其他工具建议处理完成后统一更新 SOP');
      return;
    }
    await commitToolSuggestionSelections(messageId, nextSuggestions);
  }

  async function commitToolSuggestionSelections(messageId: string, suggestions: ToolSuggestionItem[]) {
    const activeDraft = lockNullableSkillIdForDraft(pendingChange?.nextDraft || draft, lockedSkillId);
    const acceptedSuggestions = suggestions.filter(
      (item) => toolSuggestionResolution(item) === 'new_candidate' && item.status === 'accepted',
    );
    if (acceptedSuggestions.length === 0) {
      notify.info('所有工具建议已拒绝，SOP 草稿未变更');
      return;
    }
    try {
      const createdTools: ToolRead[] = [];
      const createdNewTools: ToolRead[] = [];
      for (const suggestion of acceptedSuggestions) {
        if (!suggestion.probe_result?.success) {
          throw new Error(`工具「${suggestion.display_name || suggestion.name}」尚未测试通过`);
        }
        const payload = toolPayloadFromSuggestion(suggestion, activeDraft?.skill_id, TENANT_ID);
        let createdTool: ToolRead;
        let createdNewTool = false;
        try {
          createdTool = await api.post<ToolRead>(`/api/enterprise/tools${agentQuery ? `?${agentQuery.slice(1)}` : ''}`, payload);
          createdNewTool = true;
        } catch (error) {
          if (!permitsNativeConflictRecovery?.(error)) throw error;
          createdTool = toolReadFromSuggestion(suggestion, activeDraft?.skill_id, TENANT_ID);
        }
        createdTools.push(createdTool);
        if (createdNewTool) createdNewTools.push(createdTool);
        setToolSuggestionStatus(messageId, suggestion.name, 'created');
      }
      setTools((current) => createdTools.reduce((nextTools, tool) => upsertToolRead(nextTools, tool), current));
      createdNewTools.forEach((createdTool) => {
        appendOperationToMessage(messageId, {
          kind: 'tool_add',
          label: `新增工具：${createdTool.display_name || createdTool.name}`,
          toolId: createdTool.id,
          toolName: createdTool.name,
        });
      });
      if (!activeDraft) return;
      const toolNames = acceptedSuggestions.map((item) => item.display_name || item.name).join('、');
      const nextDraft = lockSkillIdForDraft(
        integrateToolSuggestionsIntoDraft(
          activeDraft,
          acceptedSuggestions,
          pendingChange?.changedPaths?.length ? pendingChange.changedPaths : selectedPaths,
        ),
        lockedSkillId,
      );
      const changedPaths = diffTargetPaths(activeDraft, nextDraft, allTargetPaths(nextDraft));
      confirmPendingChange(false);
      clearAnimationTimers();
      setDraft(nextDraft);
      setPendingChange(null);
      setUpdatingPaths([]);
      setTextDiffs([]);
      if (changedPaths.length > 0) {
        setHighlightedPaths((current) => mergePaths(current, changedPaths));
        setDirtyPaths((current) => mergePaths(current, changedPaths));
        appendOperationToMessage(messageId, {
          kind: 'skill_change',
          label: `接入工具：${toolNames}`,
          skillId: nextDraft.skill_id,
        });
      }
      notify.success(`已确认 ${acceptedSuggestions.length} 个工具，当前草稿已局部更新`);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '新增工具或更新 SOP 失败');
    }
  }

  function rejectToolSuggestion(messageId: string, toolName: string) {
    const nextSuggestions = nextToolSuggestionsWithPatch(messageId, toolName, { status: 'rejected' });
    setToolSuggestionStatus(messageId, toolName, 'rejected');
    removeToolActionFromDraft(toolName);
    if (toolSuggestionSelectionsComplete(nextSuggestions)) {
      void commitToolSuggestionSelections(messageId, nextSuggestions);
    }
  }

  function removeToolActionFromDraft(toolName: string) {
    setDraft((current) => (current ? lockSkillIdForDraft(removeToolActionFromSkill(current, toolName), lockedSkillId) : current));
    setPendingChange((current) =>
      current
        ? {
            ...current,
            nextDraft: lockSkillIdForDraft(removeToolActionFromSkill(current.nextDraft, toolName), lockedSkillId),
          }
        : current,
    );
  }

  function setToolSuggestionStatus(messageId: string, toolName: string, status: ToolSuggestionItem['status']) {
    setToolSuggestionPatch(messageId, toolName, { status });
  }

  function nextToolSuggestionsWithPatch(
    messageId: string,
    toolName: string,
    patch: Partial<ToolSuggestionItem>,
  ): ToolSuggestionItem[] {
    const targetMessage = messages.find((item) => item.id === messageId);
    return (targetMessage?.toolSuggestions || []).map((suggestion) =>
      suggestion.name === toolName ? { ...suggestion, ...patch } : suggestion,
    );
  }

  function setToolSuggestionPatch(messageId: string, toolName: string, patch: Partial<ToolSuggestionItem>) {
    setMessages((current) =>
      current.map((item) =>
        item.id === messageId
          ? {
              ...item,
              toolSuggestions: (item.toolSuggestions || []).map((suggestion) =>
                suggestion.name === toolName ? { ...suggestion, ...patch } : suggestion,
              ),
            }
          : item,
      ),
    );
    setToolDetail((current) => (current?.name === toolName ? { ...current, ...patch } : current));
  }

  function closeSaveReview() {
    setSaveReviewOpen(false);
    setSaveDraftSnapshot(null);
    setClearAfterSave(false);
  }

  function handleClearClick() {
    if (loading) return;
    if (!hasUnsavedSkillChanges()) {
      setClearNewConfirm({
        title: skillId ? '清空并新建 SOP？' : '清空当前改写？',
        description: skillId
          ? '清空只会进入一个新的 SOP 草稿工作台，不会删除或替换当前正在编辑的 SOP。'
          : '当前技能没有未保存变更，确认清空当前改写内容和对话记录？',
      });
      return;
    }
    setClearConfirmOpen(true);
  }

  function hasUnsavedSkillChanges() {
    const targetDraft = lockNullableSkillIdForDraft(pendingChange?.nextDraft || draft, lockedSkillId);
    if (!targetDraft) return false;
    return hasSkillContentChanges(targetDraft, lastSavedDraft);
  }

  function clearDistillWorkspace() {
    clearAnimationTimers();
    abortRef.current?.abort();
    Object.values(uploadControllersRef.current).forEach((controller) => controller.abort());
    uploadControllersRef.current = {};
    const nextWorkspaceId = createDistillWorkspaceId();
    const nextParams = new URLSearchParams({ mode: 'create', workspace_id: nextWorkspaceId });
    if (activeAgentId) nextParams.set('agent_id', activeAgentId);
    const nextRoute = `/enterprise/skills/distill?${nextParams.toString()}`;
    const nextCacheKey = `skill-distill:${TENANT_ID}:${activeAgentId || 'default'}:create:${nextWorkspaceId}`;
    removeDistillCache(cacheKey);
    removeDistillCache(nextCacheKey);
    setCacheReady(false);
    setHydratedCacheKey('');
    setDraft(null);
    setLoadedSkill(null);
    setLastSavedDraft(null);
    setMessages(DEFAULT_DISTILL_MESSAGES);
    setInput('');
    setSelectedPaths(DEFAULT_TARGET_PATHS);
    setHighlightedPaths([]);
    setUpdatingPaths([]);
    setDirtyPaths([]);
    setTextDiffs([]);
    setPendingChange(null);
    setSaveDraftSnapshot(null);
    setSaveReviewOpen(false);
    setClearConfirmOpen(false);
    setClearAfterSave(false);
    setAttachments([]);
    setStreamStatus('');
    setActiveJob(null);
    if (skillId || workspaceId !== nextWorkspaceId) {
      navigate(nextRoute, { replace: true });
    } else {
      setHydratedCacheKey(cacheKey);
      setCacheReady(true);
    }
  }

  function toggleTarget(target: TargetSelection) {
    setSelectedPaths((current) => {
      if (current.includes(target.path)) {
        return current.filter((path) => path !== target.path);
      }
      return [...current, target.path];
    });
  }

  function handleSourceEdit(nextDraft: SkillCard, path: string) {
    const lockedDraft = lockSkillIdForDraft(nextDraft, lockedSkillId);
    setDraft(lockedDraft);
    setDirtyPaths((current) => mergePaths(current, [path]));
    setHighlightedPaths((current) => mergePaths(current, [path]));
  }

  function toggleAllTargets() {
    setSelectedPaths(allSelected ? [] : allPaths);
  }

  function pushMessage(role: ChatItem['role'], content: string, extra: Partial<ChatItem> = {}) {
    const id = `${role}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setMessages((current) => [...current, { id, role, content, createdAt: new Date().toISOString(), ...extra }]);
    return id;
  }

  function updateMessage(id: string, content?: string, extra: Partial<ChatItem> = {}) {
    setMessages((current) =>
      current.map((item) => (item.id === id ? { ...item, ...(content === undefined ? {} : { content }), ...extra } : item)),
    );
  }

  function applyDistillFailure(
    assistantId: string,
    error: unknown,
    kind: ActiveDistillJob['kind'],
  ) {
    const failure = buildDistillFailure(error, kind);
    updateMessage(assistantId, '当前草稿未变更，可以调整要求或模型配置后重试。', {
      thinking: 'done',
      failure,
      failureOpen: false,
    });
  }

  function toggleFailureDetails(messageId: string) {
    setMessages((current) =>
      current.map((item) =>
        item.id === messageId ? { ...item, failureOpen: !item.failureOpen } : item,
      ),
    );
  }

  async function copyFailureDetails(failure: DistillFailure) {
    const text = [
      `${failure.summary} · ${failure.stage}`,
      failure.code ? `错误码：${failure.code}` : '',
      failure.detail,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await copyTextToClipboard(text);
      notify.success('错误详情已复制');
    } catch {
      notify.error('复制错误详情失败');
    }
  }

  function appendOperationToMessage(id: string, operation: DistillHistoryOperation) {
    setMessages((current) =>
      current.map((item) =>
        item.id === id ? { ...item, operations: [...(item.operations || []), operation] } : item,
      ),
    );
  }

  function appendOperationToLatestMessage(operation: DistillHistoryOperation) {
    setMessages((current) => {
      const index = [...current].reverse().findIndex((item) => item.role === 'assistant' || item.role === 'user');
      if (index < 0) return current;
      const targetIndex = current.length - 1 - index;
      return current.map((item, currentIndex) =>
        currentIndex === targetIndex ? { ...item, operations: [...(item.operations || []), operation] } : item,
      );
    });
  }

  function appendMessage(id: string, content: string) {
    setMessages((current) =>
      current.map((item) => (item.id === id ? { ...item, content: `${item.content}${content}` } : item)),
    );
  }

  function appendThinkingDetail(id: string, detail: string) {
    const nextDetail = detail.trim();
    if (!nextDetail) return;
    setMessages((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        const previous = item.thinkingDetails || [];
        if (previous[previous.length - 1] === nextDetail) return item;
        return { ...item, thinkingDetails: [...previous, nextDetail] };
      }),
    );
  }

  function toggleThinking(id: string) {
    setMessages((current) =>
      current.map((item) => (item.id === id ? { ...item, thinkingOpen: !item.thinkingOpen } : item)),
    );
  }

  function finishStream(controller: AbortController) {
    if (abortRef.current === controller) abortRef.current = null;
    setLoading(false);
  }

  function createHistorySnapshot(): DistillHistorySnapshot {
    return {
      draft: draft ? cloneSkill(draft) : null,
      loadedSkill: loadedSkill ? cloneSkillRead(loadedSkill) : null,
      lastSavedDraft: lastSavedDraft ? cloneSkill(lastSavedDraft) : null,
      selectedPaths: [...selectedPaths],
      highlightedPaths: [...highlightedPaths],
      updatingPaths: [...updatingPaths],
      dirtyPaths: [...dirtyPaths],
      textDiffs: textDiffs.map((item) => ({ ...item })),
      pendingChange: pendingChange
        ? {
            assistantId: pendingChange.assistantId,
            previousDraft: cloneSkill(pendingChange.previousDraft),
            nextDraft: cloneSkill(pendingChange.nextDraft),
            changedPaths: [...pendingChange.changedPaths],
          }
        : null,
      viewMode,
      tools: tools.map((tool) => ({ ...tool })),
      attachments: attachments.map((item) => ({ ...item })),
      streamStatus,
    };
  }

  function restoreHistorySnapshot(snapshot: DistillHistorySnapshot) {
    clearAnimationTimers();
    abortRef.current?.abort();
    const snapshotLockedSkillId = snapshot.loadedSkill?.skill_id || lockedSkillId;
    setDraft(lockNullableSkillIdForDraft(snapshot.draft ? cloneSkill(snapshot.draft) : null, snapshotLockedSkillId));
    setLoadedSkill(snapshot.loadedSkill ? cloneSkillRead(snapshot.loadedSkill) : null);
    setLastSavedDraft(lockNullableSkillIdForDraft(snapshot.lastSavedDraft ? cloneSkill(snapshot.lastSavedDraft) : null, snapshotLockedSkillId));
    setSelectedPaths([...snapshot.selectedPaths]);
    setHighlightedPaths([...snapshot.highlightedPaths]);
    setUpdatingPaths([...snapshot.updatingPaths]);
    setDirtyPaths([...snapshot.dirtyPaths]);
    setTextDiffs(snapshot.textDiffs.map((item) => ({ ...item })));
    setPendingChange(lockPendingChangeSkillId(
      snapshot.pendingChange
        ? {
            assistantId: snapshot.pendingChange.assistantId,
            previousDraft: cloneSkill(snapshot.pendingChange.previousDraft),
            nextDraft: cloneSkill(snapshot.pendingChange.nextDraft),
            changedPaths: [...snapshot.pendingChange.changedPaths],
          }
        : null,
      snapshotLockedSkillId,
    ));
    setViewMode(snapshot.viewMode);
    setTools(snapshot.tools.map((tool) => ({ ...tool })));
    setAttachments(snapshot.attachments.filter((item) => item.status !== 'uploading').map((item) => ({ ...item })));
    setStreamStatus(snapshot.streamStatus);
    setActiveJob(null);
    setLoading(false);
  }

  function confirmPendingChange(showToast = true) {
    if (!pendingChange) return;
    clearAnimationTimers();
    setDraft(lockSkillIdForDraft(pendingChange.nextDraft, lockedSkillId));
    setUpdatingPaths([]);
    setTextDiffs([]);
    updateMessage(pendingChange.assistantId, undefined, { actionState: 'confirmed' });
    setPendingChange(null);
    if (showToast) notify.success('已确认改写');
  }

  function rejectPendingChange() {
    if (!pendingChange) return;
    clearAnimationTimers();
    setDraft(lockSkillIdForDraft(pendingChange.previousDraft, lockedSkillId));
    setHighlightedPaths([]);
    setUpdatingPaths([]);
    setTextDiffs([]);
    updateMessage(pendingChange.assistantId, undefined, { actionState: 'rejected' });
    setPendingChange(null);
    notify.info('已拒绝改写并还原');
  }

  function requestEditHistoryMessage(item: ChatItem, index: number) {
    if (loading || item.role !== 'user') return;
    setEditingMessage({ id: item.id, text: visibleChatContent(item) });
  }

  async function copyHistoryMessage(item: ChatItem) {
    const text = visibleChatContent(item);
    try {
      await navigator.clipboard.writeText(text);
      notify.success('已复制');
    } catch {
      notify.error('复制失败');
    }
  }

  function cancelEditingMessage() {
    setEditingMessage(null);
  }

  function submitEditingMessage() {
    if (!editingMessage || loading) return;
    const text = editingMessage.text.trim();
    if (!text) return;
    const index = messages.findIndex((item) => item.id === editingMessage.id);
    const item = index >= 0 ? messages[index] : null;
    if (!item || item.role !== 'user') {
      setEditingMessage(null);
      return;
    }
    const outgoingText = buildEditedOutgoingText(item, text);
    const snapshot = item.snapshotBefore;
    if (!snapshot) {
      updateMessage(item.id, text, { outgoingText });
      setEditingMessage(null);
      return;
    }
    const rollbackOperations = collectRollbackOperations(messages.slice(index + 1));
    if (rollbackOperations.length === 0) {
      void rerunEditedMessage(index, snapshot, rollbackOperations, text, outgoingText);
      return;
    }
    setRerunConfirm({ index, snapshot, rollbackOperations, text, outgoingText });
  }

  async function rerunEditedMessage(
    index: number,
    snapshot: DistillHistorySnapshot,
    operations: DistillHistoryOperation[],
    displayText: string,
    outgoingText: string,
  ) {
    try {
      await rollbackPersistedOperations(snapshot, operations);
      const snapshotLockedSkillId = snapshot.loadedSkill?.skill_id || lockedSkillId;
      const confirmedDraft = lockNullableSkillIdForDraft(snapshot.pendingChange?.nextDraft || snapshot.draft, snapshotLockedSkillId);
      restoreHistorySnapshot({
        ...snapshot,
        draft: confirmedDraft ? cloneSkill(confirmedDraft) : null,
        pendingChange: null,
        updatingPaths: [],
        textDiffs: [],
      });
      const editedUser: ChatItem = {
        id: `user_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content: displayText,
        outgoingText,
        createdAt: new Date().toISOString(),
        snapshotBefore: snapshot,
      };
      const previousMessages = messages.slice(0, index);
      const nextMessages = [...previousMessages, editedUser];
      setMessages(nextMessages);
      setEditingMessage(null);
      if (!confirmedDraft) {
        await createDraftFromText(outgoingText);
        return;
      }
      await rewriteSelectedTarget(outgoingText, confirmedDraft, undefined, undefined, nextMessages);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '回退失败');
    }
  }

  async function rollbackPersistedOperations(
    snapshot: DistillHistorySnapshot,
    operations: DistillHistoryOperation[],
  ) {
    const toolOps = operations.filter((operation) => operation.kind === 'tool_add' && operation.toolId);
    for (const operation of toolOps) {
      try {
        await api.delete(`/api/enterprise/tools/${encodeURIComponent(String(operation.toolId))}?tenant_id=${TENANT_ID}${agentQuery}`);
      } catch {
        // Tool may already have been removed. Local state is restored from the snapshot below.
      }
    }

    const versionOps = operations.filter((operation) => operation.kind === 'version_save' && operation.skillId);
    for (const operation of versionOps) {
      const skillId = String(operation.skillId);
      if (snapshot.loadedSkill) {
        await api.put<SkillRead>(`/api/enterprise/skills/${encodeURIComponent(snapshot.loadedSkill.skill_id)}${agentOnlyQuery}`, {
          tenant_id: TENANT_ID,
          content: snapshot.loadedSkill.content,
          status: snapshot.loadedSkill.status,
        });
        if (operation.version && operation.version !== snapshot.loadedSkill.version) {
          try {
            await api.delete(
              `/api/enterprise/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(operation.version)}?tenant_id=${TENANT_ID}${agentQuery}`,
            );
          } catch {
            // A saved version may be shared with current state or already removed. The active draft has been restored.
          }
        }
      } else {
        try {
          await api.delete(`/api/enterprise/skills/${encodeURIComponent(skillId)}?tenant_id=${TENANT_ID}${agentQuery}`);
        } catch {
          // If the skill was not persisted, there is nothing else to roll back.
        }
      }
    }
  }

  function animateDraftChange(
    previousDraft: SkillCard,
    nextDraft: SkillCard,
    changedPaths: string[],
    markDelay = 520,
  ) {
    clearAnimationTimers();
    const lockedPreviousDraft = lockSkillIdForDraft(previousDraft, lockedSkillId);
    const lockedNextDraft = lockSkillIdForDraft(nextDraft, lockedSkillId);
    const paths = changedPaths;
    if (paths.length === 0) {
      setDraft(lockedNextDraft);
      setHighlightedPaths([]);
      setUpdatingPaths([]);
      setTextDiffs([]);
      return;
    }
    const nextTextDiffs = collectTextDiffs(lockedPreviousDraft, lockedNextDraft, paths);
    setHighlightedPaths(paths);
    setUpdatingPaths(paths);
    setTextDiffs(nextTextDiffs);
    setDraft(lockedPreviousDraft);
    const startTimer = window.setTimeout(() => {
      setTextDiffs((current) => current.map((diff) => ({ ...diff, phase: 'type', progress: 0 })));
      const steps = 24;
      let tick = 0;
      const interval = window.setInterval(() => {
        tick += 1;
        const progress = Math.min(tick / steps, 1);
        setTextDiffs((current) => current.map((diff) => ({ ...diff, phase: 'type', progress })));
        setDraft(typedDraft(lockedPreviousDraft, lockedNextDraft, nextTextDiffs, progress));
        if (progress >= 1) {
          window.clearInterval(interval);
          animationTimersRef.current = animationTimersRef.current.filter((timer) => timer !== interval);
          setTextDiffs((current) => current.map((diff) => ({ ...diff, phase: 'settled', progress: 1 })));
          setDraft(lockedNextDraft);
          setUpdatingPaths([]);
          setDirtyPaths((current) => mergePaths(current, paths));
        }
      }, 38);
      animationTimersRef.current.push(interval);
    }, markDelay);
    animationTimersRef.current.push(startTimer);
  }

  function clearAnimationTimers() {
    animationTimersRef.current.forEach((timer) => {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    });
    animationTimersRef.current = [];
  }

  const pageTitle = mode === 'create' && !skillId ? '新建 SOP' : '编辑 SOP';

  return (
    <div className={DISTILL_PAGE_CLASS}>
      <AppHeader className="shrink-0" onLogout={onLogout} userName={currentUser?.username} title={pageTitle} />
      <div className={DISTILL_ACTIONS_CLASS}>
        <UIButton variant="outline" className={RETURN_BUTTON_CLASS} onClick={() => navigate('/enterprise/skills')}>
          <ArrowLeftOutlined />
          返回
        </UIButton>
      </div>
      <div className={WORKBENCH_CLASS}>
        <DistillSectionCard
          className={cn(
            CHAT_CARD_CLASS,
            'h-full min-h-0',
            dragActive && CHAT_CARD_DRAGGING_CLASS,
            flowFullscreen && flowAssistantPanelOpen && CHAT_CARD_FULLSCREEN_CLASS,
          )}
          bodyClassName={CHAT_CARD_BODY_CLASS}
          title={flowFullscreen ? 'AI 修改' : '对话蒸馏'}
          extra={flowFullscreen && flowAssistantPanelOpen ? (
            <UIButton
              variant="ghost"
              size="icon"
              className="size-7 rounded-[8px] text-[#858b9c] hover:bg-[#f1f3f6] hover:text-[#18181a]"
              aria-label="收起 AI 修改面板"
              title="收起 AI 修改面板"
              onClick={() => setFlowAssistantPanelOpen(false)}
            >
              <PanelLeftClose />
            </UIButton>
          ) : undefined}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className={CHAT_PANEL_CLASS}>
            {dragActive && <div className={CHAT_UPLOAD_DROP_HINT_CLASS}>松开上传文档</div>}
            <div className={CHAT_MESSAGES_CLASS} ref={chatMessagesRef}>
              {messages.map((item, index) => (
                <div key={item.id} className={chatRowClass(item.role)}>
                  <div
                    className={chatBubbleClass({
                      role: item.role,
                      editing: editingMessage?.id === item.id,
                      hasAttachments: item.role === 'user' && Boolean(item.attachments?.length),
                    })}
                  >
                    {item.role === 'assistant' && item.thinking && (
                      <div className={CHAT_THINKING_BLOCK_CLASS}>
                        <button
                          type="button"
                          className={CHAT_THINKING_BUTTON_CLASS}
                          onClick={() => toggleThinking(item.id)}
                        >
                          {item.thinking === 'running' ? <LoadingOutlined /> : <CheckOutlined />}
                          <span>{item.thinking === 'running' ? '正在学习' : '学习记录'}</span>
                          {item.thinkingOpen ? <DownOutlined /> : <RightOutlined />}
                        </button>
                        {item.thinkingOpen && (
                          <div className={CHAT_THINKING_DETAILS_CLASS}>
                            {(item.thinkingDetails || []).map((detail, index) => (
                              <div key={`${item.id}_detail_${index}`} className={CHAT_THINKING_DETAIL_CLASS}>
                                {detail}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {item.role === 'assistant' && item.failure && (
                      <div className={CHAT_FAILURE_CLASS}>
                        <button
                          type="button"
                          className={CHAT_FAILURE_BUTTON_CLASS}
                          aria-expanded={Boolean(item.failureOpen)}
                          onClick={() => toggleFailureDetails(item.id)}
                        >
                          <span className={CHAT_FAILURE_ICON_CLASS}>
                            <CloseCircleOutlined />
                          </span>
                          <span className={CHAT_FAILURE_SUMMARY_CLASS}>{item.failure.summary}</span>
                          <span className={CHAT_FAILURE_STAGE_CLASS}>{item.failure.stage}</span>
                          {item.failureOpen ? <DownOutlined /> : <RightOutlined />}
                        </button>
                        {item.failureOpen && (
                          <div className={CHAT_FAILURE_DETAILS_CLASS}>
                            <div className={CHAT_FAILURE_META_CLASS}>
                              <span className={CHAT_FAILURE_LABEL_CLASS}>阶段</span>
                              <span className={CHAT_FAILURE_VALUE_CLASS}>{item.failure.stage}</span>
                              <span className={CHAT_FAILURE_LABEL_CLASS}>错误码</span>
                              <span className={CHAT_FAILURE_VALUE_CLASS}>{item.failure.code || '未提供'}</span>
                            </div>
                            <pre className={CHAT_FAILURE_RAW_CLASS}>{item.failure.detail}</pre>
                            <button
                              type="button"
                              className={CHAT_FAILURE_COPY_CLASS}
                              onClick={() => void copyFailureDetails(item.failure!)}
                            >
                              <CopyGlyph />
                              复制错误详情
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {item.role === 'user' && item.attachments && item.attachments.length > 0 && (
                      <div className={cn(CHAT_ATTACHMENTS_CLASS, CHAT_ATTACHMENTS_USER_CLASS)}>
                        {item.attachments.map((attachment) => (
                          <div {...USER_CONTENT_ATTRIBUTES} className={cn(CHAT_ATTACHMENT_CLASS, CHAT_ATTACHMENT_USER_CLASS)} key={attachment.id} title={attachment.name}>
                            <span className={CHAT_ATTACHMENT_ICON_CLASS}>
                              <FileTextOutlined />
                            </span>
                            <span className={CHAT_ATTACHMENT_MAIN_CLASS}>
                              <span {...USER_CONTENT_ATTRIBUTES} className={CHAT_ATTACHMENT_NAME_CLASS}>{attachment.name}</span>
                              <span className={CHAT_ATTACHMENT_TYPE_CLASS}>{attachment.type}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {item.role === 'user' && editingMessage?.id === item.id ? (
                      <div
                        className={cn(
                          CHAT_EDIT_PANEL_CLASS,
                          item.attachments?.length ? CHAT_EDIT_PANEL_USER_ATTACHMENTS_CLASS : undefined,
                        )}
                      >
                        <Textarea
                          className={CHAT_EDIT_TEXTAREA_CLASS}
                          value={editingMessage.text}
                          rows={3}
                          autoFocus
                          onChange={(event) => setEditingMessage({ id: item.id, text: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              submitEditingMessage();
                            }
                          }}
                        />
                        <div className={CHAT_EDIT_ACTIONS_CLASS}>
                          <UIButton variant="outline" onClick={cancelEditingMessage}>取消</UIButton>
                          <UIButton onClick={submitEditingMessage} disabled={!(editingMessage?.text || '').trim()}>
                            发送
                          </UIButton>
                        </div>
                      </div>
                    ) : (
                      <>
                        {item.content ? (
                          <div
                            {...(item.id !== 'welcome' && item.id !== 'loaded' ? USER_CONTENT_ATTRIBUTES : {})}
                            className={cn(
                              CHAT_CONTENT_CLASS,
                              item.role === 'user' && item.attachments?.length ? CHAT_CONTENT_USER_ATTACHMENTS_CLASS : undefined,
                            )}
                          >
                            {visibleChatContent(item)}
                          </div>
                        ) : item.role === 'assistant' && item.thinking === 'running' ? null : item.role === 'assistant' ? (
                          '正在处理...'
                        ) : null}
                        {item.role === 'user' && (
                          <div className={CHAT_HOVER_ACTIONS_CLASS}>
                            <span className={CHAT_TIME_CLASS}>{formatMessageTime(item.createdAt)}</span>
                            <button type="button" className={CHAT_HOVER_BUTTON_CLASS} title="复制" onClick={() => void copyHistoryMessage(item)}>
                              <CopyGlyph />
                            </button>
                            <button
                              type="button"
                              className={CHAT_HOVER_BUTTON_CLASS}
                              title="修改"
                              onClick={() => requestEditHistoryMessage(item, index)}
                              disabled={loading}
                            >
                              <PencilGlyph />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    {item.warnings && item.warnings.length > 0 && (() => {
                      const warnings = compactWarningItems(item.warnings || [], item.toolSuggestions);
                      if (warnings.length === 0) return null;
                      return (
                        <div className={CHAT_WARNING_CLASS}>
                          <div className={CHAT_WARNING_TITLE_CLASS}>
                            <WarningOutlined />
                            <span>提示</span>
                          </div>
                          {warnings.map((warning, index) => (
                            <div key={`${item.id}_warning_${index}`} className={CHAT_WARNING_ITEM_CLASS} title={warning.title}>
                              {warning.text}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    {item.toolSuggestions && item.toolSuggestions.length > 0 && (
                      <div className={TOOL_SUGGESTIONS_CLASS}>
                        {item.toolSuggestions.map((suggestion) => {
                          const canResolveSuggestion =
                            toolSuggestionResolution(suggestion) === 'new_candidate' &&
                            suggestion.status !== 'accepted' &&
                            suggestion.status !== 'created' &&
                            suggestion.status !== 'rejected';
                          return (
                            <div className={TOOL_SUGGESTION_CLASS} key={`${item.id}_${suggestion.name}`}>
                              <div className={TOOL_SUGGESTION_MAIN_CLASS}>
                                <div className={TOOL_SUGGESTION_HEAD_CLASS}>
                                  <div className={TOOL_SUGGESTION_TITLE_CLASS}>{toolSuggestionTitle(suggestion)}</div>
                                  <span className={toolStatusBadgeClass(toolSuggestionStatusClass(suggestion))}>
                                    {toolSuggestionStatusText(suggestion)}
                                  </span>
                                </div>
                                <div {...USER_CONTENT_ATTRIBUTES} className={TOOL_SUGGESTION_DESC_CLASS}>
                                  {suggestion.reason || suggestion.description || suggestion.name}
                                </div>
                                <div className={TOOL_SUGGESTION_META_CLASS}>
                                  <span className={TOOL_METHOD_CLASS}>{suggestion.method || 'POST'}</span>
                                  <span {...USER_CONTENT_ATTRIBUTES}>{suggestion.url || '-'}</span>
                                </div>
                              </div>
                              <div className={TOOL_SUGGESTION_ACTIONS_CLASS}>
                                <span className={cn(TOOL_ACTION_GROUP_CLASS, TOOL_ACTION_GROUP_DETAIL_CLASS)}>
                                  <SimpleTooltip title="查看详情">
                                    <UIButton
                                      className={TOOL_ACTION_BUTTON_CLASS}
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => openToolDetail(item.id, suggestion)}
                                    >
                                      <InfoCircleOutlined />
                                    </UIButton>
                                  </SimpleTooltip>
                                </span>
                                {canResolveSuggestion && (
                                  <span className={TOOL_ACTION_GROUP_CLASS}>
                                    <SimpleTooltip title="确认新增">
                                      <UIButton
                                        className={cn(TOOL_ACTION_BUTTON_CLASS, TOOL_ACTION_CONFIRM_CLASS)}
                                        variant="ghost"
                                        size="icon"
                                        disabled={!suggestion.probe_result?.success}
                                        onClick={() => void confirmToolSuggestion(item.id, suggestion)}
                                      >
                                        <CheckCircleOutlined />
                                      </UIButton>
                                    </SimpleTooltip>
                                    <SimpleTooltip title="拒绝">
                                      <UIButton
                                        className={cn(TOOL_ACTION_BUTTON_CLASS, TOOL_ACTION_REJECT_CLASS)}
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => rejectToolSuggestion(item.id, suggestion.name)}
                                      >
                                        <CloseCircleOutlined />
                                      </UIButton>
                                    </SimpleTooltip>
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {item.actionState === 'pending' && (
                      <div className={CHAT_CONFIRM_CLASS}>
                        <UIButton size="sm" onClick={() => confirmPendingChange()}>
                          确认
                        </UIButton>
                        <UIButton size="sm" variant="outline" onClick={rejectPendingChange}>
                          拒绝
                        </UIButton>
                      </div>
                    )}
                    {item.actionState === 'confirmed' && <div className={CHAT_DECISION_CLASS}>已确认</div>}
                    {item.actionState === 'rejected' && <div className={CHAT_DECISION_CLASS}>已拒绝</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className={CHAT_COMPOSER_SHELL_CLASS}>
              <div className={CHAT_COMPOSER_CLASS}>
              {attachments.length > 0 && (
                <div className={UPLOAD_LIST_CLASS}>
                  {attachments.map((attachment) => (
                    <div className={uploadItemClass(attachment.status)} key={attachment.id}>
                      <FileTextOutlined />
                      <span {...USER_CONTENT_ATTRIBUTES} className={UPLOAD_NAME_CLASS}>{attachment.name}</span>
                      <span className={UPLOAD_STATUS_CLASS}>
                        {attachment.status === 'uploading' && '读取中'}
                        {attachment.status === 'ready' && '已读取'}
                        {attachment.status === 'error' && (attachment.error || '读取失败')}
                      </span>
                      <UIButton
                        size="icon"
                        variant="ghost"
                        onClick={() => cancelAttachment(attachment.id)}
                      >
                        <CloseOutlined />
                      </UIButton>
                    </div>
                  ))}
                </div>
              )}
              <Textarea
                className={CHAT_TEXTAREA_CLASS}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={handleComposerPaste}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={4}
                placeholder={
                  draft
                    ? '说明你要如何改写右侧选中的部分'
                    : '输入或粘贴需要整理的 SOP 流程说明'
                }
              />
              <div className={cn(CHAT_ACTIONS_CLASS, flowFullscreen && 'flex-nowrap gap-[6px]')}>
                <span className={cn('min-w-0 truncate text-[12px] text-[#858b9c]', flowFullscreen && 'sr-only')}>{streamStatus}</span>
                <div className={cn(CHAT_ACTIONS_GROUP_CLASS, flowFullscreen && 'w-full flex-nowrap justify-start gap-[6px]')}>
                  <label>
                    <input
                      type="file"
                      accept=".md,.txt,.doc,.docx"
                      multiple
                      className="hidden"
                      disabled={loading}
                      onChange={(event) => {
                        const files = event.target.files ? Array.from(event.target.files) : [];
                        files.forEach((file) => void stageFileUpload(file));
                        event.target.value = '';
                      }}
                    />
                    <UIButton
                      asChild
                      variant="outline"
                      disabled={uploadingFile || loading}
                      className={cn(CARD_OUTLINE_BUTTON_CLASS, flowFullscreen && 'shrink-0 px-[10px]')}
                    >
                      <span>
                        <UploadOutlined />
                        {flowFullscreen ? '上传' : '上传文件'}
                      </span>
                    </UIButton>
                  </label>
                  {loading && (
                    <UIButton
                      variant="outline"
                      className={cn(CARD_OUTLINE_BUTTON_CLASS, flowFullscreen && 'shrink-0 px-[10px]')}
                      onClick={stopStream}
                    >
                      <StopOutlined />
                      停止
                    </UIButton>
                  )}
                  <ModelConfigDropdown
                    models={modelConfigs}
                    value={selectedRewriteModelId}
                    onChange={(modelId) => {
                      setSelectedRewriteModelId(modelId);
                      window.localStorage.setItem(`${DISTILL_REWRITE_MODEL_STORAGE_KEY}:${TENANT_ID}`, modelId);
                    }}
                    buttonClassName={cn(
                      REWRITE_MODEL_BUTTON_CLASS,
                      flowFullscreen && 'min-w-0 flex-1 px-[10px]',
                    )}
                    menuClassName={flowFullscreen ? 'z-[130]' : undefined}
                  />
                  <UIButton
                    disabled={loading || uploadingFile || (!input.trim() && readyAttachments.length === 0)}
                    className={cn(PRIMARY_BUTTON_CLASS, flowFullscreen && 'shrink-0 px-[12px]')}
                    onClick={() => void send()}
                  >
                    {loading ? <LoadingOutlined className="animate-spin" /> : <SendOutlined />}
                    发送
                  </UIButton>
                </div>
              </div>
              </div>
            </div>
          </div>
        </DistillSectionCard>
        <DistillSectionCard
          className={cn(SOURCE_CARD_CLASS, 'h-full min-h-0')}
          bodyClassName={DISTILL_CARD_BODY_CLASS}
          title={viewMode === 'source' ? '源码' : '流程图'}
          extra={
            <div className="flex flex-wrap justify-end gap-[8px]">
              <UIButton variant="outline" className={CARD_OUTLINE_BUTTON_CLASS} disabled={loading} onClick={handleClearClick}>
                清空
              </UIButton>
              <SimpleTooltip title={draft && !hasSaveableDraftChanges ? '当前没有内容变化' : ''}>
                <UIButton
                  variant="outline"
                  className={CARD_OUTLINE_BUTTON_CLASS}
                  disabled={!draft || loading || !hasSaveableDraftChanges}
                  onClick={() => openSaveReview()}
                >
                  <SaveOutlined />
                  保存草稿
                </UIButton>
              </SimpleTooltip>
            </div>
          }
        >
          <div className={SOURCE_TOOLBAR_CLASS}>
            <div className="flex flex-wrap items-center gap-[8px]">
              <UIButton
                variant="outline"
                className={CARD_OUTLINE_BUTTON_CLASS}
                onClick={() => setViewMode(viewMode === 'source' ? 'flow' : 'source')}
              >
                {viewMode === 'source' ? <BranchesOutlined /> : <CodeOutlined />}
                {viewMode === 'source' ? '显示流程' : '显示源码'}
              </UIButton>
              <UIButton variant="outline" className={CARD_OUTLINE_BUTTON_CLASS} disabled={!draft} onClick={toggleAllTargets}>
                {allSelected ? '清空选择' : '全选'}
              </UIButton>
            </div>
          </div>
          {!draft ? (
            <div className={SOURCE_EMPTY_STATE_CLASS}>
              <FileTextOutlined className="text-[28px] text-[#c0c6d4]" />
              <p className={SOURCE_EMPTY_TEXT_CLASS}>暂无 SOP 草稿</p>
              <p className="text-[12px] leading-[18px] text-[#c0c6d4]">在左侧输入说明或上传文档后开始生成</p>
            </div>
          ) : viewMode === 'source' ? (
            <SkillSource
              skill={draft}
              selectedPaths={selectedPaths}
              highlightedPaths={highlightedPaths}
              updatingPaths={updatingPaths}
              dirtyPaths={dirtyPaths}
              textDiffs={textDiffs}
              toolDescriptions={toolDescriptions}
              toolStatuses={toolStatuses}
              generalSkills={generalSkills}
              sopSkills={sopSkills}
              tools={tools}
              knowledgeBases={knowledgeBases}
              tenantUsers={tenantUsers}
              containerRef={sourceScrollRef}
              lockSkillId={Boolean(lockedSkillId)}
              onToggle={toggleTarget}
              onEdit={handleSourceEdit}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <SkillFlow
                skill={draft}
                selectedPaths={selectedPaths}
                highlightedPaths={highlightedPaths}
                updatingPaths={updatingPaths}
                dirtyPaths={dirtyPaths}
                textDiffs={textDiffs}
                toolDescriptions={toolDescriptions}
                toolStatuses={toolStatuses}
                generalSkills={generalSkills}
                sopSkills={sopSkills}
                tools={tools}
                knowledgeBases={knowledgeBases}
                tenantUsers={tenantUsers}
                containerRef={sourceScrollRef}
                lockSkillId={Boolean(lockedSkillId)}
                assistantPanelOpen={flowAssistantPanelOpen}
                onAssistantPanelOpenChange={setFlowAssistantPanelOpen}
                onFullscreenChange={setFlowFullscreen}
                onToggle={toggleTarget}
                onEdit={handleSourceEdit}
              />
            </div>
          )}
        </DistillSectionCard>
      </div>
      <KDialog
        open={clearConfirmOpen}
        onOpenChange={(open) => !open && setClearConfirmOpen(false)}
        title="清空前是否保存？"
        width={520}
        footer={
          <div className="flex flex-wrap justify-end gap-[8px]">
            <UIButton variant="outline" onClick={() => setClearConfirmOpen(false)}>取消</UIButton>
            <UIButton
              variant="outline"
              onClick={() => {
                setClearConfirmOpen(false);
                clearDistillWorkspace();
              }}
            >
              不保存清空
            </UIButton>
            <UIButton
              onClick={() => {
                setClearConfirmOpen(false);
                openSaveReview({ clearAfterSave: true });
              }}
            >
              保存并清空
            </UIButton>
          </div>
        }
      >
        <p className="m-0 text-[14px] leading-[22px] text-foreground">
          检测到当前 SOP 有未保存变更。你可以先保存当前内容；清空后会进入新的 SOP 草稿工作台，不会把原 SOP 替换为空。
        </p>
      </KDialog>
      <KDialog
        open={saveReviewOpen}
        onOpenChange={(open) => !open && closeSaveReview()}
        title="保存SOP版本"
        width={820}
        footer={
          <div className="flex flex-wrap justify-end gap-[8px]">
            <UIButton variant="outline" onClick={closeSaveReview}>取消</UIButton>
            <UIButton disabled={!saveReviewHasContentChanges} onClick={() => void saveDraft()}>保存</UIButton>
          </div>
        }
      >
        <div className={SAVE_REVIEW_FORM_CLASS}>
          <label className={SAVE_REVIEW_FORM_LABEL_CLASS}>
            <span>SOP名称</span>
            <Input value={saveName} onChange={(event) => setSaveName(event.target.value)} />
          </label>
          <label className={SAVE_REVIEW_FORM_LABEL_CLASS}>
            <span>业务域</span>
            <Input value={saveDomain} onChange={(event) => setSaveDomain(event.target.value)} />
          </label>
          <label className={SAVE_REVIEW_FORM_LABEL_CLASS}>
            <span>版本号</span>
            <Input value={assignedVersionLabel || saveVersion} disabled={Boolean(assignedVersionLabel) || !saveReviewHasContentChanges} onChange={(event) => setSaveVersion(event.target.value)} />
          </label>
        </div>
        <div className={SAVE_REVIEW_DIFF_CLASS}>
          <strong className="text-[13px] font-semibold text-foreground">本轮修改 diff</strong>
          {saveReviewDiffs.length === 0 ? (
            <EmptyState description="暂无结构差异" />
          ) : (
            saveReviewDiffs.map((diff) => (
              <div key={diff.key} className={SAVE_REVIEW_DIFF_ROW_CLASS}>
                <div className={SAVE_REVIEW_DIFF_PATH_CLASS}>{diffTargetLabel(diff.path, saveReviewDraft)} / {fieldLabel(diff.field)}</div>
                <SaveReviewDiffValue diff={diff} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} />
              </div>
            ))
          )}
        </div>
      </KDialog>
      <KDialog
        open={Boolean(toolDetail)}
        onOpenChange={(open) => !open && setToolDetail(null)}
        title="工具详情"
        width={1040}
        footer={
          <div className={cn(TOOL_SUGGESTION_DETAIL_FOOTER_CLASS, "flex flex-wrap justify-end gap-[8px]")}>
            <UIButton variant="outline" onClick={() => setToolDetail(null)}>关闭</UIButton>
            {toolDetail && toolSuggestionResolution(toolDetail) === 'new_candidate' && (
              <>
                <UIButton variant="outline" onClick={applyProbeArgumentsFromDetail}>应用样例参数</UIButton>
                <UIButton
                  disabled={toolDetail?.probeStatus === 'probing'}
                  onClick={probeToolDetail}
                >
                  {toolDetail?.probeStatus === 'probing' ? <LoadingOutlined className="animate-spin" /> : <ApiOutlined />}
                  {toolDetail?.probe_result ? '再次测试' : '测试接口'}
                </UIButton>
              </>
            )}
          </div>
        }
      >
        {toolDetail && (
          <div className={TOOL_SUGGESTION_DETAIL_CLASS}>
            <div><strong>解析状态：</strong>{toolSuggestionResolutionLabel(toolDetail)}</div>
            {toolDetail.matched_tool_name && (
              <div><strong>匹配工具：</strong>{toolDetail.matched_tool_display_name || toolDetail.matched_tool_name}</div>
            )}
            <div><strong>工具名：</strong>{toolDetail.name}</div>
            <div><strong>显示名：</strong>{toolDetail.display_name || '-'}</div>
            <div><strong>说明：</strong>{toolDetail.description || '-'}</div>
            <div><strong>方法：</strong>{toolDetail.method}</div>
            <div><strong>URL：</strong>{toolDetail.url}</div>
            {toolDetail.missing_reason && <div><strong>缺失原因：</strong>{toolDetail.missing_reason}</div>}
            <div><strong>原因：</strong>{toolDetail.reason || '-'}</div>
            <div><strong>来源：</strong>{toolDetail.source_excerpt || '-'}</div>
            <strong className="text-[13px] font-semibold text-foreground">样例参数</strong>
            <Textarea
              value={probeArgsText}
              rows={5}
              onChange={(event) => setProbeArgsText(event.target.value)}
            />
            <strong className="text-[13px] font-semibold text-foreground">输入 Schema</strong>
            <pre className={TOOL_SUGGESTION_DETAIL_PRE_CLASS}>{JSON.stringify(toolDetail.input_schema || {}, null, 2)}</pre>
            <strong className="text-[13px] font-semibold text-foreground">输出 Schema</strong>
            <pre className={TOOL_SUGGESTION_DETAIL_PRE_CLASS}>{JSON.stringify(toolDetail.output_schema || {}, null, 2)}</pre>
            {toolDetail.probe_result && (
              <>
                <strong className="text-[13px] font-semibold text-foreground">测试结果</strong>
                <pre className={TOOL_SUGGESTION_DETAIL_PRE_CLASS}>{JSON.stringify(toolDetail.probe_result, null, 2)}</pre>
              </>
            )}
          </div>
        )}
      </KDialog>
      {clearNewConfirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setClearNewConfirm(null)}
          title={clearNewConfirm.title}
          description={clearNewConfirm.description}
          confirmText="清空"
          destructive={false}
          onConfirm={() => {
            setClearNewConfirm(null);
            clearDistillWorkspace();
          }}
        />
      )}
      {rerunConfirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRerunConfirm(null)}
          title="重新编辑这条消息？"
          confirmText="确认回退"
          destructive={false}
          description={
            <div>
              <p className="m-0 mb-[8px]">重新编辑会回到这条消息发送前的 SOP 草稿，并截断之后的推理记录。</p>
              <div className="rollback-operation-list flex flex-wrap gap-[6px]">
                {rerunConfirm.rollbackOperations.map((operation, operationIndex) => (
                  <DistillTag key={`${operation.kind}_${operationIndex}`}>{operation.label}</DistillTag>
                ))}
              </div>
            </div>
          }
          onConfirm={() => {
            const payload = rerunConfirm;
            setRerunConfirm(null);
            void rerunEditedMessage(
              payload.index,
              payload.snapshot,
              payload.rollbackOperations,
              payload.text,
              payload.outgoingText,
            );
          }}
        />
      )}
    </div>
  );
}

function DistillSectionCard({
  className,
  bodyClassName,
  title,
  extra,
  children,
  ...rest
}: {
  className?: string;
  bodyClassName?: string;
  title?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <section className={cn(DISTILL_CARD_CLASS, 'h-full min-h-0', className)} {...rest}>
      {(title || extra) && (
        <div className={DISTILL_CARD_HEADER_CLASS}>
          <div className={cn('min-w-0', SECTION_CARD_TITLE_CLASS)}>{title}</div>
          {extra ? <div className="shrink-0">{extra}</div> : null}
        </div>
      )}
      <div className={cn(DISTILL_CARD_BODY_CLASS, bodyClassName)}>{children}</div>
    </section>
  );
}

function KDialog({
  open,
  onOpenChange,
  title,
  width = 520,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  width?: number;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] gap-0 overflow-y-auto rounded-[16px] p-0"
        style={{ width: `min(${width}px, calc(100vw - 32px))`, maxWidth: 'calc(100vw - 32px)' }}
      >
        {title != null && (
          <DialogTitle className="border-b border-border px-[24px] py-[16px] text-[16px] font-semibold text-foreground">
            {title}
          </DialogTitle>
        )}
        <div className="px-[24px] py-[20px]">{children}</div>
        {footer != null && (
          <DialogFooter>{footer}</DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SimpleTooltip({ title, children }: { title?: ReactNode; children: ReactNode }) {
  if (!title) return <>{children}</>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function EmptyState({ description }: { description: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-[8px] py-[32px] text-center text-[13px] text-[#858b9c]">
      {description}
    </div>
  );
}

function DistillTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-[6px] bg-[#f2f3f5] px-[8px] py-px text-[12px] font-medium leading-[18px] text-[#5b6273]">
      {children}
    </span>
  );
}

/**
 * Inline text input for the SOP source editor.
 */
function SourceInput({
  className,
  ...rest
}: {
  className?: string;
  type?: HTMLInputTypeAttribute;
  value?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  readOnly?: boolean;
  style?: CSSProperties;
  onChange?: ChangeEventHandler<HTMLInputElement>;
}) {
  return <Input className={cn(SOURCE_INPUT_CLASS, className)} {...rest} />;
}

/** Auto-growing textarea replacement for Ant Design's `Input.TextArea autoSize`. */
function AutoGrowTextarea({
  className,
  minRows = 1,
  maxRows,
  value,
  style,
  ...rest
}: {
  className?: string;
  minRows?: number;
  maxRows?: number;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  style?: CSSProperties;
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [autoSize, setAutoSize] = useState<{ height: number; overflowY: 'auto' | 'hidden' } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const resize = () => {
      const computed = window.getComputedStyle(el);
      const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
      const verticalPadding = (Number.parseFloat(computed.paddingTop) || 0)
        + (Number.parseFloat(computed.paddingBottom) || 0);
      const verticalBorder = (Number.parseFloat(computed.borderTopWidth) || 0)
        + (Number.parseFloat(computed.borderBottomWidth) || 0);
      const minHeight = lineHeight * minRows + verticalPadding + verticalBorder;
      const maxHeight = maxRows
        ? lineHeight * Math.max(minRows, maxRows) + verticalPadding + verticalBorder
        : Number.POSITIVE_INFINITY;
      const nextHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));
      const nextOverflowY = maxRows || el.scrollHeight > maxHeight ? 'auto' : 'hidden';
      setAutoSize((current) => (
        current?.height === nextHeight && current.overflowY === nextOverflowY
          ? current
          : { height: nextHeight, overflowY: nextOverflowY }
      ));
    };
    resize();
    let previousWidth = el.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? el.clientWidth;
      if (Math.abs(nextWidth - previousWidth) < 0.5) return;
      previousWidth = nextWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [maxRows, minRows, value]);
  return (
    <Textarea
      ref={ref}
      rows={minRows}
      value={value}
      style={{ ...style, height: autoSize?.height, overflowY: autoSize?.overflowY }}
      className={cn(SOURCE_INPUT_CLASS, className)}
      {...rest}
    />
  );
}

/** Native number input replacement for Ant Design's `InputNumber`. */
function SourceNumberInput({
  className,
  value,
  min,
  placeholder,
  onChange,
}: {
  className?: string;
  value: number | null;
  min?: number;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <Input
      type="number"
      className={cn(SOURCE_INPUT_CLASS, className)}
      value={value ?? ''}
      min={min}
      placeholder={placeholder}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === '' ? null : Number(raw));
      }}
    />
  );
}

/**
 * Searchable action picker (replaces Ant Design's `Select showSearch`). Renders
 * a filterable input backed by a popover list. Committing an empty value removes
 * the action, matching the previous `allowClear` behaviour.
 */
export function ActionCombobox({
  value,
  options,
  placeholder = '选择一个动作',
  onSelect,
}: {
  value?: string;
  options: SelectOption[];
  placeholder?: string;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(normalizedQuery) ||
          String(option.value).toLowerCase().includes(normalizedQuery),
      )
    : options;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onSelect(value || '');
      }}
    >
      <PopoverTrigger asChild>
        <input
          type="text"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          className={SOURCE_ACTION_SELECT_CLASS}
          autoFocus
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (filtered.length > 0) onSelect(String(filtered[0].value));
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="z-[130] max-h-[280px] w-[320px] overflow-y-auto p-[4px]"
      >
        {filtered.length === 0 ? (
          <div className="px-[10px] py-[12px] text-center text-[13px] text-[#858b9c]">无匹配动作</div>
        ) : (
          filtered.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              className={cn(
                'flex w-full items-center rounded-[8px] px-[10px] py-[6px] text-left text-[13px] text-foreground hover:bg-muted',
                option.value === value && 'bg-muted',
              )}
              onClick={() => onSelect(String(option.value))}
            >
              {option.label}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** shadcn Select styled for the SOP source editor. */
function SourceSelect({
  className,
  value,
  options,
  placeholder,
  onChange,
}: {
  className?: string;
  value?: string;
  options: SelectOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <UISelect value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="z-[130]">
        {options.map((option) => (
          <SelectItem key={String(option.value)} value={String(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UISelect>
  );
}

function SkillSource({
  skill,
  selectedPaths,
  highlightedPaths,
  updatingPaths,
  dirtyPaths,
  textDiffs,
  toolDescriptions,
  toolStatuses,
  generalSkills,
  sopSkills,
  tools,
  knowledgeBases,
  tenantUsers,
  containerRef,
  lockSkillId,
  onToggle,
  onEdit,
}: {
  skill: SkillCard;
  selectedPaths: string[];
  highlightedPaths: string[];
  updatingPaths: string[];
  dirtyPaths: string[];
  textDiffs: TextDiffAnimation[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
  generalSkills: GeneralSkillRead[];
  sopSkills: SkillRead[];
  tools: ToolRead[];
  knowledgeBases: KnowledgeBaseRead[];
  tenantUsers: Array<{ id: string; username: string; display_name?: string; source?: string; channel_identities?: Array<{ channel: string; display_name?: string; external_user_id?: string }> }>;
  containerRef: RefObject<HTMLDivElement>;
  lockSkillId?: boolean;
  onToggle: (target: TargetSelection) => void;
  onEdit: (nextDraft: SkillCard, path: string) => void;
}) {
  const { notify } = useDistillPageHost();
  const [deleteNodeIndex, setDeleteNodeIndex] = useState<number | null>(null);

  function editBasic(
    field: keyof SkillCard,
    value: string | string[] | number | null,
  ) {
    if (field === 'skill_id' && lockSkillId) return;
    const next = cloneSkill(skill);
    if (field === 'trigger_intents' || field === 'user_utterance_examples' || field === 'goal' || field === 'required_info' || field === 'response_rules') {
      next[field] = Array.isArray(value) ? value : splitEditableList(String(value ?? ''));
    } else if (field === 'step_timeout_seconds') {
      next.step_timeout_seconds = typeof value === 'number' ? value : null;
    } else if (field === 'capability_scope') {
      next.capability_scope = normalizeCapabilityScope(value);
    } else if (field === 'skill_id' || field === 'name' || field === 'version' || field === 'business_domain' || field === 'description') {
      next[field] = String(value);
    }
    onEdit(next, 'basic');
  }

  function editStep(index: number, field: string, value: string | string[] | boolean | Record<string, unknown>) {
    const next = cloneSkill(skill);
    const listValue = [
      'expected_user_info',
      'allowed_actions',
      'general_skill_ids',
      'tool_ids',
      'knowledge_base_ids',
      'required_general_skill_ids',
      'required_tool_ids',
      'required_knowledge_base_ids',
    ].includes(field)
      ? Array.isArray(value)
        ? value
        : splitEditableList(String(value))
      : value;
    next.nodes = Array.isArray(next.nodes) ? [...next.nodes] : [];
    const currentNode = { ...(next.nodes[index] || {}) };
    const nodeField = field === 'step_id' ? 'node_id' : field;
    if (nodeField === 'node_id') {
      const previousId = String(currentNode.node_id || currentNode.step_id || `node_${index + 1}`);
      const nextId = String(listValue || '').trim();
      if (!nextId) {
        notify.warning('节点 ID 不能为空');
        return;
      }
      const duplicated = next.nodes.some((node, nodeIndex) => (
        nodeIndex !== index && String(node?.node_id || node?.step_id || '') === nextId
      ));
      if (duplicated) {
        notify.warning(`节点 ID「${nextId}」已经存在`);
        return;
      }
      currentNode.node_id = nextId;
      next.edges = normalizeSkillEdges(next).map((edge) => ({
        ...edge,
        source_node_id: String(edge.source_node_id || '') === previousId ? nextId : edge.source_node_id,
        next_node_id: String(edge.next_node_id || '') === previousId ? nextId : edge.next_node_id,
      }));
      if (next.start_node_id === previousId) next.start_node_id = nextId;
      next.terminal_node_ids = asStringList(next.terminal_node_ids).map((nodeId) => (nodeId === previousId ? nextId : nodeId));
      next.nodes[index] = currentNode;
      onEdit(next, stepTargetPath(index));
      return;
    }
    if (nodeField === 'assignee_user_id') {
      const { userId, channel } = parseHandoffAssigneeValue(String(listValue));
      currentNode.assignee_user_id = userId || null;
      currentNode.assignee_notify_channel = userId ? channel : null;
    } else if (nodeField === 'type') {
      applyNodeTypeChange(currentNode, String(listValue));
    } else if (CAPABILITY_REFERENCE_FIELDS.includes(nodeField)) {
      const currentRefs = nodeCapabilityRefs(currentNode);
      currentNode.capability_refs = updateCapabilityRefs(
        currentRefs,
        nodeField,
        asStringList(listValue),
      );
      delete currentNode.general_skill_ids;
      delete currentNode.tool_ids;
      delete currentNode.knowledge_base_ids;
      delete currentNode.required_general_skill_ids;
      delete currentNode.required_tool_ids;
      delete currentNode.required_knowledge_base_ids;
    } else {
      currentNode[nodeField] = listValue;
    }
    next.nodes[index] = normalizeSubflowNode(currentNode);
    onEdit(next, stepTargetPath(index));
  }

  function updateEdge(index: number, edgeIndex: number, patch: Record<string, unknown>) {
    const next = cloneSkill(skill);
    const sourceId = nodeIdAt(next, index);
    const edges = normalizeSkillEdges(next);
    const globalIndex = findSourceEdgeIndex(edges, sourceId, edgeIndex);
    if (globalIndex < 0) return;
    edges[globalIndex] = { ...edges[globalIndex], ...patch };
    next.edges = edges;
    onEdit(next, stepTargetPath(index));
  }

  function addEdge(index: number) {
    const next = cloneSkill(skill);
    const sourceId = nodeIdAt(next, index);
    const nodes = normalizeSkillNodes(next);
    const fallbackTarget = nodes.find((node) => String(node.node_id || node.step_id || '') !== sourceId);
    const targetId = String(nodes[index + 1]?.node_id || nodes[index + 1]?.step_id || fallbackTarget?.node_id || fallbackTarget?.step_id || '');
    const sourceEdges = normalizeSkillEdges(next).filter((edge) => String(edge.source_node_id || '') === sourceId);
    const priority = sourceEdges.length > 0
      ? Math.max(...sourceEdges.map((edge, sourceIndex) => edgePriority(edge, sourceIndex))) + 1
      : 1;
    next.edges = [
      ...normalizeSkillEdges(next),
      {
        source_node_id: sourceId,
        next_node_id: targetId,
        condition: '',
        priority,
        label: targetId ? '新增流转' : '',
      },
    ];
    onEdit(next, stepTargetPath(index));
  }

  function deleteEdge(index: number, edgeIndex: number) {
    const next = cloneSkill(skill);
    const sourceId = nodeIdAt(next, index);
    const edges = normalizeSkillEdges(next);
    const globalIndex = findSourceEdgeIndex(edges, sourceId, edgeIndex);
    if (globalIndex < 0) return;
    edges.splice(globalIndex, 1);
    next.edges = edges;
    onEdit(next, stepTargetPath(index));
  }

  function insertNodeBetween(index: number) {
    const next = cloneSkill(skill);
    const nodes = normalizeSkillNodes(next);
    const insertAt = nodes.length === 0 ? 0 : Math.max(0, Math.min(index + 1, nodes.length));
    const sourceNode = insertAt > 0 ? nodes[insertAt - 1] : null;
    const targetNode = insertAt < nodes.length ? nodes[insertAt] : null;
    const sourceId = sourceNode ? String(sourceNode.node_id || sourceNode.step_id || `node_${insertAt}`) : '';
    const targetId = targetNode ? String(targetNode.node_id || targetNode.step_id || `node_${insertAt + 1}`) : '';
    const newNodeId = uniqueNodeId(nodes, `node_${insertAt + 1}`);
    const newNode = {
      node_id: newNodeId,
      type: 'collect_info',
      name: '新增节点',
      instruction: '说明这个节点要完成的目标。',
      optional: false,
      condition: '',
      expected_user_info: [],
      allowed_actions: ['continue_flow'],
      capability_refs: {
        general_skill_ids: [],
        tool_ids: [],
        knowledge_base_ids: [],
        required_general_skill_ids: [],
        required_tool_ids: [],
        required_knowledge_base_ids: [],
      },
      knowledge_scope: {},
      retry_policy: {},
      metadata: {},
    };
    nodes.splice(insertAt, 0, newNode);
    next.nodes = nodes;

    const edges = normalizeSkillEdges(next);
    if (sourceId && targetId) {
      const directEdgeIndexes = edges
        .map((edge, edgeIndex) => ({ edge, edgeIndex }))
        .filter(({ edge }) => String(edge.source_node_id || '') === sourceId && String(edge.next_node_id || '') === targetId)
        .map(({ edgeIndex }) => edgeIndex);
      if (directEdgeIndexes.length > 0) {
        directEdgeIndexes.forEach((edgeIndex) => {
          edges[edgeIndex] = {
            ...edges[edgeIndex],
            next_node_id: newNodeId,
            label: String(edges[edgeIndex].label || '').trim() || '进入新增节点',
          };
        });
        const maxPriority = Math.max(...directEdgeIndexes.map((edgeIndex, localIndex) => edgePriority(edges[edgeIndex], localIndex)));
        edges.push({
          source_node_id: newNodeId,
          next_node_id: targetId,
          condition: '',
          priority: maxPriority + 1,
          label: `继续到 ${String(targetNode?.name || targetId)}`,
        });
      } else {
        const sourcePriority = edges
          .filter((edge) => String(edge.source_node_id || '') === sourceId)
          .reduce((max, edge, sourceIndex) => Math.max(max, edgePriority(edge, sourceIndex)), 0) + 1;
        edges.push({
          source_node_id: sourceId,
          next_node_id: newNodeId,
          condition: '',
          priority: sourcePriority,
          label: '进入新增节点',
        });
        edges.push({
          source_node_id: newNodeId,
          next_node_id: targetId,
          condition: '',
          priority: 1,
          label: `继续到 ${String(targetNode?.name || targetId)}`,
        });
      }
    } else if (!sourceId && targetId) {
      edges.push({
        source_node_id: newNodeId,
        next_node_id: targetId,
        condition: '',
        priority: 1,
        label: `继续到 ${String(targetNode?.name || targetId)}`,
      });
      next.start_node_id = newNodeId;
    } else if (sourceId && !targetId) {
      const sourcePriority = edges
        .filter((edge) => String(edge.source_node_id || '') === sourceId)
        .reduce((max, edge, sourceIndex) => Math.max(max, edgePriority(edge, sourceIndex)), 0) + 1;
      edges.push({
        source_node_id: sourceId,
        next_node_id: newNodeId,
        condition: '',
        priority: sourcePriority,
        label: '进入新增节点',
      });
      const previousTerminalIds = asStringList(next.terminal_node_ids);
      next.terminal_node_ids = previousTerminalIds.length > 0
        ? [...previousTerminalIds.filter((terminalId) => terminalId !== sourceId), newNodeId]
        : [newNodeId];
    } else {
      next.start_node_id = newNodeId;
      next.terminal_node_ids = [newNodeId];
    }
    next.edges = edges;
    if (!next.start_node_id) next.start_node_id = String(nodes[0]?.node_id || '');
    if (asStringList(next.terminal_node_ids).length === 0 && nodes.length > 0) {
      next.terminal_node_ids = [String(nodes[nodes.length - 1].node_id || '')];
    }
    onEdit(next, stepTargetPath(insertAt));
  }

  function confirmDeleteNode(index: number) {
    const nodes = normalizeSkillNodes(skill);
    if (nodes.length <= 1) {
      notify.warning('至少需要保留一个节点');
      return;
    }
    setDeleteNodeIndex(index);
  }

  function runDeleteNode(index: number) {
    const nodes = normalizeSkillNodes(skill);
    const node = nodes[index];
    if (!node) return;
    const nodeId = String(node.node_id || node.step_id || `node_${index + 1}`);
    const next = cloneSkill(skill);
    const nextNodes = normalizeSkillNodes(next).filter((_node, nodeIndex) => nodeIndex !== index);
    next.nodes = nextNodes;
    next.edges = normalizeSkillEdges(next).filter((edge) => (
      String(edge.source_node_id || '') !== nodeId && String(edge.next_node_id || '') !== nodeId
    ));
    if (next.start_node_id === nodeId) next.start_node_id = String(nextNodes[0]?.node_id || '');
    next.terminal_node_ids = asStringList(next.terminal_node_ids).filter((terminalId) => terminalId !== nodeId);
    if (next.terminal_node_ids.length === 0 && nextNodes.length > 0) {
      next.terminal_node_ids = [String(nextNodes[nextNodes.length - 1].node_id || '')];
    }
    onEdit(next, stepTargetPath(Math.min(index, Math.max(nextNodes.length - 1, 0))));
  }

  function renderDeleteNodeConfirm() {
    if (deleteNodeIndex === null) return null;
    const nodes = normalizeSkillNodes(skill);
    const index = deleteNodeIndex;
    const node = nodes[index];
    if (!node) return null;
    const nodeId = String(node.node_id || node.step_id || `node_${index + 1}`);
    const edges = normalizeSkillEdges(skill);
    const incomingEdges = edges.filter((edge) => String(edge.next_node_id || '') === nodeId);
    const outgoingEdges = edges.filter((edge) => String(edge.source_node_id || '') === nodeId);
    const affected = [...incomingEdges, ...outgoingEdges];
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && setDeleteNodeIndex(null)}
        title={`确认删除 Node ${index + 1}：${String(node.name || nodeId)}？`}
        confirmText="确认删除"
        description={
          <div className={NODE_DELETE_CONFIRM_CLASS}>
            <p>删除后会同时移除所有连接到这个节点、或从这个节点发出的流转规则。</p>
            <strong>将受影响的连接</strong>
            <ul>
              {affected.length > 0 ? (
                affected.map((edge, edgeIndex) => (
                  <li key={`${String(edge.source_node_id)}_${String(edge.next_node_id)}_${edgeIndex}`}>
                    {nodeDisplayNameById(nodes, String(edge.source_node_id || ''))}
                    {' -> '}
                    {nodeDisplayNameById(nodes, String(edge.next_node_id || ''))}
                    {String(edge.label || edge.condition || '').trim() ? `：${String(edge.label || edge.condition)}` : ''}
                  </li>
                ))
              ) : (
                <li>无直接连接关系</li>
              )}
            </ul>
          </div>
        }
        onConfirm={() => {
          runDeleteNode(index);
          setDeleteNodeIndex(null);
        }}
      />
    );
  }

  const steps = skillGraphSteps(skill);
  const nodeNameMap = steps.reduce<Record<string, string>>((acc, step, index) => {
    const nodeId = String(step.node_id || step.step_id || `node_${index + 1}`);
    acc[nodeId] = String(step.name || nodeId);
    return acc;
  }, {});
  const edgeMap = skillGraphEdgeMap(skill);
  const terminalNodeIds = new Set(asStringList(skill.terminal_node_ids));
  const startNodeId = String(skill.start_node_id || '');
  const nodeOptions = steps.map((step, index) => {
    const nodeId = String(step.node_id || step.step_id || `node_${index + 1}`);
    return {
      value: nodeId,
      label: `Node ${index + 1} · ${String(step.name || nodeId)}`,
    };
  });
  const actionOptions = buildActionOptions(toolDescriptions, toolStatuses, steps);
  const generalSkillOptions: CapabilityReferenceOption[] = generalSkills.map((item) => ({
    value: item.id,
    label: item.name || item.slug,
    description: item.description || item.slug,
    capabilityScope: item.capability_scope,
    unavailableReason: item.status === 'published' ? undefined : '技能未启用',
  }));
  const toolOptions: CapabilityReferenceOption[] = tools.map((item) => ({
    value: item.id,
    label: item.display_name || item.name,
    description: item.description || item.name,
    capabilityScope: item.capability_scope,
    unavailableReason: item.enabled ? undefined : '工具已停用',
  }));
  const knowledgeBaseOptions: CapabilityReferenceOption[] = knowledgeBases.map((item) => ({
    value: item.id,
    label: item.name,
    description: item.description,
    capabilityScope: item.capability_scope,
    unavailableReason: item.status === 'active' || item.status === 'published' ? undefined : '知识库已下线',
  }));
  const sopOptions: SelectOption[] = sopSkills
    .filter((item) => (
      item.status === 'published'
      && item.skill_id !== skill.skill_id
      && !wouldCreateSopNestingCycle(skill.skill_id, item.skill_id, sopSkills)
    ))
    .map((item) => ({
      value: item.skill_id,
      label: `${item.name} · ${item.skill_id}`,
    }));
  const tenantUserOptions: SelectOption[] = [
    { value: UNASSIGNED_USER_VALUE, label: '未指定（使用渠道默认）' },
    ...handoffAssigneeUserOptions(tenantUsers),
  ];

  return (
    <div className={SOURCE_MD_CLASS} ref={containerRef}>
      <div className={SOURCE_GROUP_TITLE_CLASS}>基础信息</div>
      <SelectableTarget
        className={distillSourceSectionClass('basic', selectedPaths, highlightedPaths, updatingPaths, dirtyPaths)}
        target={{ path: 'basic', label: '基础信息' }}
        onToggle={onToggle}
      >
        {selectedPaths.includes('basic') && <span className={SELECTION_MARK_CLASS}><CheckOutlined /></span>}
        <div className={SOURCE_RENDERED_CLASS}>
          <EditableSourceHeading value={skill.name} onChange={(value) => editBasic('name', value)} />
          <div className={SOURCE_META_LIST_CLASS}>
            <EditableSourceTextLine
              label={fieldLabel('skill_id')}
              value={skill.skill_id}
              readOnly={lockSkillId}
              onChange={(value) => editBasic('skill_id', value)}
            />
            <EditableSourceTextLine label={fieldLabel('version')} value={skill.version} onChange={(value) => editBasic('version', value)} />
            <EditableSourceTextLine label={fieldLabel('business_domain')} value={skill.business_domain || ''} onChange={(value) => editBasic('business_domain', value)} />
            <EditableSourceTextLine label={fieldLabel('description')} value={skill.description || ''} multiline onChange={(value) => editBasic('description', value)} />
            <CapabilityScopeControl
              compact
              resourceType="sop"
              value={normalizeCapabilityScope(skill.capability_scope)}
              onChange={(value) => editBasic('capability_scope', value)}
            />
            <EditableSourceNumberLine
              label={fieldLabel('step_timeout_seconds')}
              value={skill.step_timeout_seconds}
              min={1}
              max={3600}
              placeholder="不单独限制"
              onChange={(value) => editBasic('step_timeout_seconds', value)}
            />
            <EditableSourceListLine label={fieldLabel('trigger_intents')} values={skill.trigger_intents} onChange={(value) => editBasic('trigger_intents', value)} />
            <EditableSourceListLine label={fieldLabel('user_utterance_examples')} values={skill.user_utterance_examples} onChange={(value) => editBasic('user_utterance_examples', value)} />
            <EditableSourceListLine label={fieldLabel('goal')} values={skill.goal} onChange={(value) => editBasic('goal', value)} />
            <EditableSourceListLine label={fieldLabel('required_info')} values={skill.required_info} onChange={(value) => editBasic('required_info', value)} />
            <EditableSourceListLine label={fieldLabel('response_rules')} values={skill.response_rules} minRows={5} maxRows={14} onChange={(value) => editBasic('response_rules', value)} />
          </div>
        </div>
      </SelectableTarget>
      <div className={SOURCE_GROUP_TITLE_CLASS}>详细节点</div>
      <div className={SOURCE_STEPS_CLASS}>
        <div className={cn(NODE_INSERT_ROW_CLASS, NODE_INSERT_ROW_EDGE_CLASS)}>
          <UIButton variant="outline" size="sm" className={NODE_INSERT_BUTTON_CLASS} onClick={() => insertNodeBetween(-1)}>
            <PlusOutlined />
            {steps.length > 0 ? '在最前新增节点' : '新增第一个节点'}
          </UIButton>
        </div>
        {steps.map((step, index) => {
          const stepId = String(step.node_id || step.step_id || `node_${index + 1}`);
          const path = stepTargetPath(index);
          const outgoingEdges = edgeMap[stepId] || [];
          const isSubflow = String(step.type || '') === 'subflow';
          // 处理人仅对 handoff 节点有意义;转人工动作只允许出现在 handoff 节点上,
          // 回复/收集等其他节点一律不展示处理人与转人工动作。
          const isHandoffNode = String(step.type || '') === 'handoff';
          const nodeState = [
            stepId === startNodeId ? '起始节点' : '',
            Boolean(step.optional) ? '可选' : '必选',
            terminalNodeIds.has(stepId) ? '终止节点' : '流程节点',
          ].filter(Boolean).join(' · ');
          return (
            <div className={SOURCE_STEP_BLOCK_CLASS} key={path}>
              {index > 0 && (
                <div className={NODE_INSERT_ROW_CLASS}>
                  <UIButton variant="outline" size="sm" className={NODE_INSERT_BUTTON_CLASS} onClick={() => insertNodeBetween(index - 1)}>
                    <PlusOutlined />
                    在 Node {index} 和 Node {index + 1} 之间新增节点
                  </UIButton>
                </div>
              )}
              <SelectableTarget
                className={distillSourceSectionClass(path, selectedPaths, highlightedPaths, updatingPaths, dirtyPaths)}
                target={{ path, label: `节点 ${index + 1}：${step.name || stepId}` }}
                onToggle={onToggle}
              >
                {selectedPaths.includes(path) && <span className={SELECTION_MARK_CLASS}><CheckOutlined /></span>}
                <div className={SOURCE_RENDERED_CLASS}>
                  <div className={SOURCE_STEP_HEADER_CLASS}>
                    <EditableSourceStepHeading
                      index={index}
                      value={String(step.name || '')}
                      fallback={stepId}
                      onChange={(value) => editStep(index, 'name', value)}
                    />
                    <EditableSourceField>
                      <UIButton variant="destructive" size="sm" onClick={() => confirmDeleteNode(index)}>
                        <DeleteOutlined />
                        删除节点
                      </UIButton>
                    </EditableSourceField>
                  </div>
                  <div className={SOURCE_META_LIST_CLASS}>
                    <EditableSourceTextLine label={fieldLabel('step_id')} value={stepId} onChange={(value) => editStep(index, 'step_id', value)} />
                    <EditableSourceSelectLine
                      label={fieldLabel('type')}
                      value={String(step.type || 'collect_info')}
                      options={NODE_TYPE_OPTIONS}
                      onChange={(value) => editStep(index, 'type', value)}
                    />
                    {isSubflow && (
                      <EditableSourceSelectLine
                        label="调用子 SOP"
                        value={String(step.sub_sop_id || '')}
                        options={sopOptions}
                        onChange={(value) => editStep(index, 'sub_sop_id', value)}
                      />
                    )}
                    <SourceReadonlyLine label="节点状态" value={nodeState} staticLabels />
                    {isSubflow ? (
                      <SourceReadonlyLine label="执行职责" value="仅进入所选子 SOP；父子流程共享当前 TaskFrame 字段。" />
                    ) : (
                      <>
                        <EditableSourceTextLine label={fieldLabel('instruction')} value={String(step.instruction || '')} multiline collapsible onChange={(value) => editStep(index, 'instruction', value)} />
                        <EditableSourceListLine label={fieldLabel('expected_user_info')} values={asStringList(step.expected_user_info)} onChange={(value) => editStep(index, 'expected_user_info', value)} />
                        <EditableSourceActionLine values={asStringList(step.allowed_actions)} options={filterActionOptionsForNodeType(actionOptions, String(step.type || ''))} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} onChange={(value) => editStep(index, 'allowed_actions', value)} />
                        <EditableCapabilityReferencesLine label="SOP 技能" values={asStringList(step.general_skill_ids)} requiredValues={asStringList(step.required_general_skill_ids)} options={generalSkillOptions} emptyText="未指定技能" onChange={(value) => editStep(index, 'general_skill_ids', value)} onRequiredChange={(value) => editStep(index, 'required_general_skill_ids', value)} />
                        <EditableCapabilityReferencesLine label="SOP 工具" values={asStringList(step.tool_ids)} requiredValues={asStringList(step.required_tool_ids)} options={toolOptions} emptyText="未指定工具" onChange={(value) => editStep(index, 'tool_ids', value)} onRequiredChange={(value) => editStep(index, 'required_tool_ids', value)} />
                        <EditableCapabilityReferencesLine label="SOP 知识库" values={asStringList(step.knowledge_base_ids)} requiredValues={asStringList(step.required_knowledge_base_ids)} options={knowledgeBaseOptions} emptyText="未指定知识库" onChange={(value) => editStep(index, 'knowledge_base_ids', value)} onRequiredChange={(value) => editStep(index, 'required_knowledge_base_ids', value)} />
                      </>
                    )}
                    {isHandoffNode && (
                      <EditableSourceSelectLine
                        label="处理人"
                        value={
                          step.assignee_user_id
                            ? formatHandoffAssigneeValue(
                              String(step.assignee_user_id),
                              String(step.assignee_notify_channel || ''),
                            )
                            : UNASSIGNED_USER_VALUE
                        }
                        options={tenantUserOptions}
                        onChange={(value) => editStep(
                          index,
                          'assignee_user_id',
                          value === UNASSIGNED_USER_VALUE ? '' : value,
                        )}
                      />
                    )}
                    <EditableFlowRulesLine
                      sourceNodeId={stepId}
                      edges={outgoingEdges}
                      nodes={steps}
                      nodeOptions={nodeOptions}
                      terminal={terminalNodeIds.has(stepId)}
                      onAdd={() => addEdge(index)}
                      onUpdate={(edgeIndex, patch) => updateEdge(index, edgeIndex, patch)}
                      onDelete={(edgeIndex) => deleteEdge(index, edgeIndex)}
                    />
                    {!isSubflow && <SourceJsonLine label="知识范围" value={step.knowledge_scope} />}
                    {!isSubflow && <EditableRetryPolicyLine value={step.retry_policy} onChange={(value) => editStep(index, 'retry_policy', value)} />}
                  </div>
                </div>
              </SelectableTarget>
            </div>
          );
        })}
        {steps.length > 0 && (
          <div className={cn(NODE_INSERT_ROW_CLASS, NODE_INSERT_ROW_EDGE_CLASS)}>
            <UIButton variant="outline" size="sm" className={NODE_INSERT_BUTTON_CLASS} onClick={() => insertNodeBetween(steps.length - 1)}>
              <PlusOutlined />
              在最后新增节点
            </UIButton>
          </div>
        )}
      </div>
      {renderDeleteNodeConfirm()}
    </div>
  );
}

export function SkillFlow({
  skill,
  selectedPaths,
  highlightedPaths,
  updatingPaths,
  dirtyPaths,
  textDiffs,
  toolDescriptions,
  toolStatuses,
  generalSkills,
  sopSkills,
  tools,
  knowledgeBases,
  tenantUsers,
  containerRef,
  lockSkillId,
  assistantPanelOpen,
  onAssistantPanelOpenChange,
  onFullscreenChange,
  onToggle,
  onEdit,
}: {
  skill: SkillCard;
  selectedPaths: string[];
  highlightedPaths: string[];
  updatingPaths: string[];
  dirtyPaths: string[];
  textDiffs: TextDiffAnimation[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
  generalSkills: GeneralSkillRead[];
  sopSkills: SkillRead[];
  tools: ToolRead[];
  knowledgeBases: KnowledgeBaseRead[];
  tenantUsers: Array<{ id: string; username: string; display_name?: string; source?: string; channel_identities?: Array<{ channel: string; display_name?: string; external_user_id?: string }> }>;
  containerRef: RefObject<HTMLDivElement>;
  lockSkillId?: boolean;
  assistantPanelOpen: boolean;
  onAssistantPanelOpenChange: (open: boolean) => void;
  onFullscreenChange: (open: boolean) => void;
  onToggle: (target: TargetSelection) => void;
  onEdit: (nextDraft: SkillCard, path: string) => void;
}) {
  const { notify } = useDistillPageHost();
  const [flowZoom, setFlowZoom] = useState(0.64);
  const [flowPreset, setFlowPreset] = useState<'fit' | '100' | null>('fit');
  const [flowPan, setFlowPan] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedNodeIndex, setSelectedNodeIndex] = useState<number | null>(null);
  const [basicInspectorOpen, setBasicInspectorOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [flowViewportWidth, setFlowViewportWidth] = useState(0);
  const [armedConnectionSourceId, setArmedConnectionSourceId] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [hoveredEdgeId, setHoveredEdgeId] = useState('');
  const [nodePositionOverrides, setNodePositionOverrides] = useState<Record<string, SkillFlowPosition>>({});
  const [connectionDrag, setConnectionDrag] = useState<SkillFlowConnectionPreview | null>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const connectionPointerRef = useRef<{ sourceNodeId: string; startX: number; startY: number } | null>(null);
  const connectionDragRef = useRef<typeof connectionDrag>(null);
  const nodeDragRef = useRef<{
    pointerId: number;
    nodeId: string;
    nodeIndex: number;
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
    moved: boolean;
    captureTarget: HTMLDivElement;
  } | null>(null);
  const suppressNodeClickRef = useRef('');
  const panStateRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const nodes = skillGraphSteps(skill);
  const edgeMap = skillGraphEdgeMap(skill);
  const terminalSet = new Set(asStringList(skill.terminal_node_ids));
  const nodeNameMap = Object.fromEntries(
    nodes.map((node, index) => {
      const nodeId = String(node.node_id || node.step_id || `node_${index + 1}`);
      return [nodeId, String(node.name || nodeId)];
    }),
  );
  const graphKey = `${skill.skill_id || 'skill'}:${skill.version || 'draft'}:${nodes.length}:${skill.start_node_id || ''}`;
  const centeredGraphKey = useRef('');
  const graphLayout = buildSkillFlowCanvasLayout(skill, nodes, nodeNameMap, nodePositionOverrides);
  const zoomedWidth = graphLayout.width * flowZoom;
  const zoomedHeight = graphLayout.height * flowZoom;
  const canvasWidth = Math.max(zoomedWidth, flowViewportWidth);
  const canvasOffsetX = Math.max(0, (canvasWidth - zoomedWidth) / 2);
  const selectedNode = selectedNodeIndex === null ? null : nodes[selectedNodeIndex] || null;
  const selectedNodeId = selectedNodeIndex === null
    ? ''
    : String(selectedNode?.node_id || selectedNode?.step_id || `node_${selectedNodeIndex + 1}`);
  const nodeOptions = nodes.map((node, index) => {
    const nodeId = String(node.node_id || node.step_id || `node_${index + 1}`);
    return { value: nodeId, label: `Node ${index + 1} · ${String(node.name || nodeId)}` };
  });
  const actionOptions = buildActionOptions(toolDescriptions, toolStatuses, nodes);
  // 流程视图当前选中的节点在非 handoff 类型下不提供转人工动作
  const selectedNodeType = selectedNodeIndex === null
    ? ''
    : String(nodes[selectedNodeIndex]?.type || '');
  const inspectorActionOptions = filterActionOptionsForNodeType(actionOptions, selectedNodeType);
  const generalSkillOptions: CapabilityReferenceOption[] = generalSkills.map((item) => ({
    value: item.id,
    label: item.name || item.slug,
    description: item.description || item.slug,
    capabilityScope: item.capability_scope,
    unavailableReason: item.status === 'published' ? undefined : '技能未启用',
  }));
  const toolOptions: CapabilityReferenceOption[] = tools.map((item) => ({
    value: item.id,
    label: item.display_name || item.name,
    description: item.description || item.name,
    capabilityScope: item.capability_scope,
    unavailableReason: item.enabled ? undefined : '工具已停用',
  }));
  const knowledgeBaseOptions: CapabilityReferenceOption[] = knowledgeBases.map((item) => ({
    value: item.id,
    label: item.name,
    description: item.description,
    capabilityScope: item.capability_scope,
    unavailableReason: item.status === 'active' || item.status === 'published' ? undefined : '知识库已下线',
  }));
  const sopOptions: SelectOption[] = sopSkills
    .filter((item) => (
      item.status === 'published'
      && item.skill_id !== skill.skill_id
      && !wouldCreateSopNestingCycle(skill.skill_id, item.skill_id, sopSkills)
    ))
    .map((item) => ({
      value: item.skill_id,
      label: `${item.name} · ${item.skill_id}`,
    }));
  const tenantUserOptions: SelectOption[] = [
    { value: UNASSIGNED_USER_VALUE, label: '未指定（使用渠道默认）' },
    ...handoffAssigneeUserOptions(tenantUsers),
  ];

  const editFlowNode = (
    index: number,
    field: string,
    value: string | string[] | boolean | Record<string, unknown>,
  ) => {
    const next = cloneSkill(skill);
    const listValue = [
      'expected_user_info',
      'allowed_actions',
      'general_skill_ids',
      'tool_ids',
      'knowledge_base_ids',
      'required_general_skill_ids',
      'required_tool_ids',
      'required_knowledge_base_ids',
    ].includes(field)
      ? Array.isArray(value) ? value : splitEditableList(String(value))
      : value;
    next.nodes = Array.isArray(next.nodes) ? [...next.nodes] : [];
    const currentNode = { ...(next.nodes[index] || {}) };
    const nodeField = field === 'step_id' ? 'node_id' : field;
    if (nodeField === 'node_id') {
      const previousId = String(currentNode.node_id || currentNode.step_id || `node_${index + 1}`);
      const nextId = String(listValue || '').trim();
      if (!nextId) {
        notify.warning('节点 ID 不能为空');
        return;
      }
      const duplicated = next.nodes.some((node, nodeIndex) => (
        nodeIndex !== index && String(node?.node_id || node?.step_id || '') === nextId
      ));
      if (duplicated) {
        notify.warning(`节点 ID「${nextId}」已经存在`);
        return;
      }
      currentNode.node_id = nextId;
      next.edges = normalizeSkillEdges(next).map((edge) => ({
        ...edge,
        source_node_id: String(edge.source_node_id || '') === previousId ? nextId : edge.source_node_id,
        next_node_id: String(edge.next_node_id || '') === previousId ? nextId : edge.next_node_id,
      }));
      if (next.start_node_id === previousId) next.start_node_id = nextId;
      next.terminal_node_ids = asStringList(next.terminal_node_ids).map((nodeId) => (nodeId === previousId ? nextId : nodeId));
    } else if (nodeField === 'assignee_user_id') {
      const { userId, channel } = parseHandoffAssigneeValue(String(listValue));
      currentNode.assignee_user_id = userId || null;
      currentNode.assignee_notify_channel = userId ? channel : null;
    } else if (nodeField === 'type') {
      applyNodeTypeChange(currentNode, String(listValue));
    } else if (CAPABILITY_REFERENCE_FIELDS.includes(nodeField)) {
      const currentRefs = nodeCapabilityRefs(currentNode);
      currentNode.capability_refs = updateCapabilityRefs(
        currentRefs,
        nodeField,
        asStringList(listValue),
      );
      delete currentNode.general_skill_ids;
      delete currentNode.tool_ids;
      delete currentNode.knowledge_base_ids;
      delete currentNode.required_general_skill_ids;
      delete currentNode.required_tool_ids;
      delete currentNode.required_knowledge_base_ids;
    } else {
      currentNode[nodeField] = listValue;
    }
    next.nodes[index] = normalizeSubflowNode(currentNode);
    onEdit(next, stepTargetPath(index));
  };

  const editFlowBasic = (
    field: keyof SkillCard,
    value: string | string[] | number | null,
  ) => {
    if (field === 'skill_id' && lockSkillId) return;
    const next = cloneSkill(skill);
    if (field === 'trigger_intents' || field === 'user_utterance_examples' || field === 'goal' || field === 'required_info' || field === 'response_rules') {
      next[field] = Array.isArray(value) ? value : splitEditableList(String(value ?? ''));
    } else if (field === 'step_timeout_seconds') {
      next.step_timeout_seconds = typeof value === 'number' ? value : null;
    } else if (field === 'capability_scope') {
      next.capability_scope = normalizeCapabilityScope(value);
    } else if (field === 'skill_id' || field === 'name' || field === 'version' || field === 'business_domain' || field === 'description') {
      next[field] = String(value);
    }
    onEdit(next, 'basic');
  };

  const updateFlowEdge = (index: number, edgeIndex: number, patch: Record<string, unknown>) => {
    const next = cloneSkill(skill);
    const sourceId = nodeIdAt(next, index);
    const edges = normalizeSkillEdges(next);
    const globalIndex = findSourceEdgeIndex(edges, sourceId, edgeIndex);
    if (globalIndex < 0) return;
    edges[globalIndex] = { ...edges[globalIndex], ...patch };
    next.edges = edges;
    onEdit(next, stepTargetPath(index));
  };

  const addFlowEdge = (index: number) => {
    const next = cloneSkill(skill);
    const sourceId = nodeIdAt(next, index);
    const target = nodes.find((node, nodeIndex) => nodeIndex !== index && String(node.node_id || node.step_id || ''));
    const targetId = String(target?.node_id || target?.step_id || '');
    const sourceEdges = normalizeSkillEdges(next).filter((edge) => String(edge.source_node_id || '') === sourceId);
    const priority = sourceEdges.length > 0
      ? Math.max(...sourceEdges.map((edge, sourceIndex) => edgePriority(edge, sourceIndex))) + 1
      : 1;
    next.edges = [...normalizeSkillEdges(next), {
      source_node_id: sourceId,
      next_node_id: targetId,
      condition: '',
      priority,
      label: targetId ? '新增流转' : '',
    }];
    onEdit(next, stepTargetPath(index));
  };

  const deleteFlowEdge = (index: number, edgeIndex: number) => {
    const next = cloneSkill(skill);
    const sourceId = nodeIdAt(next, index);
    const edges = normalizeSkillEdges(next);
    const globalIndex = findSourceEdgeIndex(edges, sourceId, edgeIndex);
    if (globalIndex < 0) return;
    edges.splice(globalIndex, 1);
    next.edges = edges;
    onEdit(next, stepTargetPath(index));
  };

  const connectFlowNodes = (sourceNodeId: string, targetNodeId: string) => {
    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return;
    const next = cloneSkill(skill);
    const edges = normalizeSkillEdges(next);
    if (edges.some((edge) => (
      String(edge.source_node_id || '') === sourceNodeId && String(edge.next_node_id || '') === targetNodeId
    ))) {
      notify.warning('这两个节点之间已经存在流转规则');
      return;
    }
    const sourceIndex = nodes.findIndex((node, index) => String(node.node_id || node.step_id || `node_${index + 1}`) === sourceNodeId);
    const targetName = nodeNameMap[targetNodeId] || targetNodeId;
    const sourceEdges = edges.filter((edge) => String(edge.source_node_id || '') === sourceNodeId);
    const priority = sourceEdges.length > 0
      ? Math.max(...sourceEdges.map((edge, edgeIndex) => edgePriority(edge, edgeIndex))) + 1
      : 1;
    next.edges = [...edges, {
      source_node_id: sourceNodeId,
      next_node_id: targetNodeId,
      condition: '',
      priority,
      label: `连接到 ${targetName}`,
    }];
    if (sourceIndex >= 0) setSelectedNodeIndex(sourceIndex);
    onEdit(next, stepTargetPath(Math.max(sourceIndex, 0)));
    notify.success(`已连接到「${targetName}」，右侧流转规则已同步`);
  };
  const deleteFlowEdgeAt = (edgeIndex: number) => {
    const edge = normalizeSkillEdges(skill)[edgeIndex];
    if (!edge) return;
    const sourceNodeId = String(edge.source_node_id || '');
    const targetNodeId = String(edge.next_node_id || '');
    const sourceIndex = nodes.findIndex((node, index) => (
      String(node.node_id || node.step_id || `node_${index + 1}`) === sourceNodeId
    ));
    onEdit(withoutSkillEdgeAt(skill, edgeIndex), stepTargetPath(Math.max(sourceIndex, 0)));
    setSelectedEdgeId('');
    notify.success(`已删除「${nodeNameMap[sourceNodeId] || sourceNodeId} → ${nodeNameMap[targetNodeId] || targetNodeId}」流转`);
  };
  const startNodeDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    node: SkillFlowCanvasNode,
  ) => {
    if (event.button !== 0 || connectionDrag || armedConnectionSourceId) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, [role="combobox"], [data-flow-connect-handle]')) return;
    nodeDragRef.current = {
      pointerId: event.pointerId,
      nodeId: node.nodeId,
      nodeIndex: node.index,
      pointerX: event.clientX,
      pointerY: event.clientY,
      startX: node.x,
      startY: node.y,
      moved: false,
      captureTarget: event.currentTarget,
    };
  };
  const handleNodePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - drag.pointerX) / flowZoom;
    const deltaY = (event.clientY - drag.pointerY) / flowZoom;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    if (!drag.moved && !drag.captureTarget.hasPointerCapture(drag.pointerId)) {
      drag.captureTarget.setPointerCapture(drag.pointerId);
    }
    drag.moved = true;
    const position = {
      x: Math.max(32, drag.startX + deltaX),
      y: Math.max(32, drag.startY + deltaY),
    };
    setFlowPreset(null);
    setNodePositionOverrides((current) => ({ ...current, [drag.nodeId]: position }));
  };
  const finishNodeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    nodeDragRef.current = null;
    if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
      drag.captureTarget.releasePointerCapture(drag.pointerId);
    }
    if (!drag.moved) return;
    const position = {
      x: Math.max(32, drag.startX + (event.clientX - drag.pointerX) / flowZoom),
      y: Math.max(32, drag.startY + (event.clientY - drag.pointerY) / flowZoom),
    };
    setNodePositionOverrides((current) => ({ ...current, [drag.nodeId]: position }));
    suppressNodeClickRef.current = drag.nodeId;
    onEdit(withSkillNodeFlowPosition(skill, drag.nodeIndex, position), stepTargetPath(drag.nodeIndex));
  };
  const updateZoom = (
    nextZoom: number,
    preset: 'fit' | '100' | null = null,
    minimumZoom = isFullscreen ? 0.2 : 0.36,
  ) => {
    const next = Math.min(1.18, Math.max(minimumZoom, Math.round(nextZoom * 100) / 100));
    const container = containerRef.current;
    setFlowPreset(preset);
    if (!container) {
      setFlowZoom(next);
      return;
    }
    if (isFullscreen) {
      const centerX = container.clientWidth / 2;
      const centerY = container.clientHeight / 2;
      const graphX = (centerX - flowPan.x) / flowZoom;
      const graphY = (centerY - flowPan.y) / flowZoom;
      setFlowPreset(preset);
      setFlowZoom(next);
      setFlowPan({
        x: centerX - graphX * next,
        y: centerY - graphY * next,
      });
      return;
    }
    const centerX = (container.scrollLeft + container.clientWidth / 2) / flowZoom;
    const centerY = (container.scrollTop + container.clientHeight / 2) / flowZoom;
    setFlowZoom(next);
    window.requestAnimationFrame(() => {
      container.scrollLeft = Math.max(0, centerX * next - container.clientWidth / 2);
      container.scrollTop = Math.max(0, centerY * next - container.clientHeight / 2);
    });
  };
  const fitFlowToViewport = (fullscreenMode = isFullscreen) => {
    const container = containerRef.current;
    if (!container) {
      updateZoom(0.64, 'fit');
      return;
    }
    const horizontalGutter = fullscreenMode ? 72 : 48;
    const verticalGutter = fullscreenMode ? 72 : 48;
    const availableWidth = Math.max(240, container.clientWidth - horizontalGutter);
    const availableHeight = Math.max(240, container.clientHeight - verticalGutter);
    const nextZoom = Math.min(
      1,
      availableWidth / graphLayout.width,
      availableHeight / graphLayout.height,
    );
    const normalizedZoom = Math.min(1, Math.max(0.2, Math.round(nextZoom * 100) / 100));
    setFlowPreset('fit');
    setFlowZoom(normalizedZoom);
    if (fullscreenMode) {
      setFlowPan({
        x: (container.clientWidth - graphLayout.width * normalizedZoom) / 2,
        y: (container.clientHeight - graphLayout.height * normalizedZoom) / 2,
      });
      return;
    }
    window.requestAnimationFrame(() => {
      const rootCenterX = (graphLayout.root.x + graphLayout.root.width / 2) * normalizedZoom;
      container.scrollLeft = Math.max(0, rootCenterX - container.clientWidth / 2);
      container.scrollTop = 0;
    });
  };
  const focusFlowStart = () => {
    const container = containerRef.current;
    if (!container) return;
    const nextZoom = 0.72;
    setFlowPreset(null);
    setFlowZoom(nextZoom);
    setFlowPan({
      x: container.clientWidth / 2 - (graphLayout.root.x + graphLayout.root.width / 2) * nextZoom,
      y: 44 - graphLayout.root.y * nextZoom,
    });
  };
  const toggleFullscreen = () => {
    const nextFullscreen = !isFullscreen;
    setIsFullscreen(nextFullscreen);
    onFullscreenChange(nextFullscreen);
    if (nextFullscreen) {
      onAssistantPanelOpenChange(true);
      setInspectorOpen(true);
    }
    if (nextFullscreen && selectedNodeIndex === null && nodes.length > 0) setSelectedNodeIndex(0);
    if (!nextFullscreen) {
      connectionPointerRef.current = null;
      connectionDragRef.current = null;
      setConnectionDrag(null);
      setArmedConnectionSourceId('');
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (nextFullscreen) focusFlowStart();
        else fitFlowToViewport(false);
        fullscreenButtonRef.current?.focus();
      });
    });
  };
  const startConnectionDrag = (event: ReactPointerEvent<HTMLButtonElement>, sourceNodeId: string) => {
    if (!isFullscreen) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    setArmedConnectionSourceId('');
    connectionPointerRef.current = { sourceNodeId, startX, startY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const armConnectionClick = (event: MouseEvent<HTMLButtonElement>, sourceNodeId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setArmedConnectionSourceId(sourceNodeId);
  };
  const handleConnectionPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = connectionPointerRef.current;
    if (!pending) return;
    const moved = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
    if (!connectionDragRef.current && moved < 4) return;
    const hoveredNode = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-flow-node-id]');
    const hoveredNodeId = hoveredNode?.dataset.flowNodeId || '';
    const targetNodeId = hoveredNodeId && hoveredNodeId !== pending.sourceNodeId ? hoveredNodeId : '';
    const targetRect = targetNodeId ? hoveredNode?.getBoundingClientRect() : null;
    const nextDrag = {
      sourceNodeId: pending.sourceNodeId,
      targetNodeId,
      startX: pending.startX,
      startY: pending.startY,
      currentX: targetRect ? targetRect.left + targetRect.width / 2 : event.clientX,
      currentY: targetRect ? targetRect.top - 2 : event.clientY,
    };
    connectionDragRef.current = nextDrag;
    setConnectionDrag(nextDrag);
  };
  const handleConnectionPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = connectionPointerRef.current;
    const drag = connectionDragRef.current;
    if (!pending) return;
    connectionPointerRef.current = null;
    connectionDragRef.current = null;
    setConnectionDrag(null);
    if (!drag) {
      setArmedConnectionSourceId((current) => current === pending.sourceNodeId ? '' : pending.sourceNodeId);
      return;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-flow-node-id]');
    const targetNodeId = drag.targetNodeId || target?.dataset.flowNodeId || '';
    if (targetNodeId) connectFlowNodes(drag.sourceNodeId, targetNodeId);
  };
  const handlePanPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isFullscreen || connectionDrag || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-flow-node-id], [data-flow-edge-hit], button, input, textarea, select, [role="button"], [role="combobox"]')) return;
    panStateRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: flowPan.x,
      panY: flowPan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePanPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panStateRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setFlowPan({
      x: pan.panX + event.clientX - pan.x,
      y: pan.panY + event.clientY - pan.y,
    });
  };
  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panStateRef.current?.pointerId !== event.pointerId) return;
    panStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const scheduleConnectionPreviewReanchor = () => {
    const pending = connectionPointerRef.current;
    if (!pending) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const latestPending = connectionPointerRef.current;
        if (!latestPending) return;
        const container = containerRef.current;
        const nodeElements = container?.querySelectorAll<HTMLElement>('[data-flow-node-id]');
        const findNode = (nodeId: string) => Array.from(nodeElements || [])
          .find((node) => node.dataset.flowNodeId === nodeId);
        const sourceHandle = findNode(latestPending.sourceNodeId)
          ?.querySelector<HTMLElement>('[data-flow-connect-handle]');
        const sourceRect = sourceHandle?.getBoundingClientRect();
        if (!sourceRect) return;
        const sourcePoint = {
          x: sourceRect.left + sourceRect.width / 2,
          y: sourceRect.top + sourceRect.height / 2,
        };
        connectionPointerRef.current = {
          ...latestPending,
          startX: sourcePoint.x,
          startY: sourcePoint.y,
        };
        const current = connectionDragRef.current;
        if (!current) return;
        const targetRect = current.targetNodeId
          ? findNode(current.targetNodeId)?.getBoundingClientRect()
          : null;
        const next = reanchorSkillFlowConnection(
          current,
          sourcePoint,
          targetRect
            ? { x: targetRect.left + targetRect.width / 2, y: targetRect.top - 2 }
            : undefined,
        );
        connectionDragRef.current = next;
        setConnectionDrag(next);
      });
    });
  };
  const handleCanvasWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!isFullscreen) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const graphX = (pointerX - flowPan.x) / flowZoom;
      const graphY = (pointerY - flowPan.y) / flowZoom;
      const multiplier = event.deltaY > 0 ? 0.9 : 1.1;
      const nextZoom = Math.min(1.18, Math.max(0.2, Math.round(flowZoom * multiplier * 100) / 100));
      setFlowPreset(null);
      setFlowZoom(nextZoom);
      setFlowPan({
        x: pointerX - graphX * nextZoom,
        y: pointerY - graphY * nextZoom,
      });
      scheduleConnectionPreviewReanchor();
      return;
    }
    const deltaX = normalizeSkillFlowWheelDelta(event.deltaX, event.deltaMode, event.currentTarget.clientWidth);
    const deltaY = normalizeSkillFlowWheelDelta(event.deltaY, event.deltaMode, event.currentTarget.clientHeight);
    setFlowPreset(null);
    setFlowPan((current) => ({
      x: current.x - deltaX,
      y: current.y - deltaY,
    }));
    scheduleConnectionPreviewReanchor();
  };
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const updateWidth = () => setFlowViewportWidth(container.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, isFullscreen]);
  useEffect(() => {
    if (nodes.length === 0) {
      if (selectedNodeIndex !== null) setSelectedNodeIndex(null);
      return;
    }
    if (selectedNodeIndex !== null && selectedNodeIndex >= nodes.length) setSelectedNodeIndex(nodes.length - 1);
  }, [nodes.length, selectedNodeIndex]);
  useEffect(() => {
    setNodePositionOverrides({});
    setSelectedEdgeId('');
  }, [skill.skill_id]);
  useEffect(() => {
    const visibleEdgeIds = new Set(graphLayout.edges.map((edge) => edge.id));
    if (selectedEdgeId && !visibleEdgeIds.has(selectedEdgeId)) setSelectedEdgeId('');
  }, [graphLayout.edges, selectedEdgeId]);
  useEffect(() => {
    if (!isFullscreen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeId) {
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
        const selectedEdge = graphLayout.edges.find((edge) => edge.id === selectedEdgeId);
        if (selectedEdge?.edgeIndex !== undefined) {
          event.preventDefault();
          deleteFlowEdgeAt(selectedEdge.edgeIndex);
        }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (connectionDrag) {
        connectionPointerRef.current = null;
        connectionDragRef.current = null;
        setConnectionDrag(null);
        return;
      }
      if (armedConnectionSourceId) {
        setArmedConnectionSourceId('');
        return;
      }
      setIsFullscreen(false);
      onFullscreenChange(false);
      window.requestAnimationFrame(() => fullscreenButtonRef.current?.focus());
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [armedConnectionSourceId, connectionDrag, graphLayout.edges, isFullscreen, onFullscreenChange, selectedEdgeId]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || isFullscreen || centeredGraphKey.current === graphKey) return undefined;
    centeredGraphKey.current = graphKey;
    const frame = window.requestAnimationFrame(() => {
      const rootCenterX = (graphLayout.root.x + graphLayout.root.width / 2) * flowZoom;
      const targetScrollLeft = Math.max(0, rootCenterX - container.clientWidth / 2);
      container.scrollLeft = targetScrollLeft;
      container.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [containerRef, flowZoom, graphKey, graphLayout.root.x, graphLayout.root.width, isFullscreen]);
  const isFitZoom = flowPreset === 'fit';
  const isFullZoom = flowPreset === '100' && Math.abs(flowZoom - 1) < 0.001;
  return (
    <div
      className={cn(FLOW_VIEWER_CLASS, isFullscreen && FLOW_VIEWER_FULLSCREEN_CLASS)}
      role={isFullscreen ? 'dialog' : undefined}
      aria-modal={isFullscreen || undefined}
      aria-label={isFullscreen ? 'SOP 流程图全屏查看' : undefined}
      onPointerMove={(event) => {
        handleConnectionPointerMove(event);
        handleNodePointerMove(event);
      }}
      onPointerUp={(event) => {
        handleConnectionPointerUp(event);
        finishNodeDrag(event);
      }}
      onPointerCancel={(event) => {
        handleConnectionPointerUp(event);
        finishNodeDrag(event);
      }}
    >
      <div className={cn(FLOW_VIEWER_CLASS, isFullscreen && FLOW_VIEWER_FULLSCREEN_PANEL_CLASS)}>
        <div className={cn(FLOW_ZOOM_TOOLBAR_CLASS, isFullscreen && FLOW_ZOOM_TOOLBAR_FULLSCREEN_CLASS)} aria-label="流程图控制">
          {isFullscreen && (
            <div className={FLOW_VIEWER_TITLE_CLASS}>
              <span className={FLOW_VIEWER_TITLE_MARK_CLASS}><BranchesOutlined /></span>
              <span className="grid min-w-0 gap-[2px]">
                <strong {...(skill.name ? USER_CONTENT_ATTRIBUTES : {})} className="truncate text-[14px] font-medium text-[#18181a]">{skill.name || 'SOP 流程图'}</strong>
                <span className={FLOW_VIEWER_TITLE_META_CLASS}>
                  {nodes.length} 个节点 · {graphLayout.edges.length} 条连线 · {armedConnectionSourceId ? '点击目标节点完成连接' : '拖动节点调整排版，选择连线可删除'}
                </span>
              </span>
            </div>
          )}
          <div className={FLOW_ZOOM_CONTROLS_CLASS}>
            {isFullscreen && (
              <>
                <UIButton
                  variant="outline"
                  size="sm"
                  className={flowZoomPresetButtonClass(assistantPanelOpen)}
                  aria-pressed={assistantPanelOpen}
                  onClick={() => {
                    onAssistantPanelOpenChange(!assistantPanelOpen);
                  }}
                >
                  {assistantPanelOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
                  AI 修改
                </UIButton>
                <UIButton
                  variant="outline"
                  size="sm"
                  className={flowZoomPresetButtonClass(inspectorOpen)}
                  aria-pressed={inspectorOpen}
                  onClick={() => {
                    setInspectorOpen((current) => !current);
                  }}
                >
                  {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
                  结构编辑
                </UIButton>
              </>
            )}
            <span className="shrink-0">缩放</span>
            <UIButton variant="outline" size="sm" className={FLOW_ZOOM_STEP_BUTTON_CLASS} onClick={() => updateZoom(flowZoom - 0.08)} aria-label="缩小">
              -
            </UIButton>
            <span className={FLOW_ZOOM_VALUE_CLASS}>{Math.round(flowZoom * 100)}%</span>
            <UIButton variant="outline" size="sm" className={FLOW_ZOOM_STEP_BUTTON_CLASS} onClick={() => updateZoom(flowZoom + 0.08)} aria-label="放大">
              +
            </UIButton>
            <UIButton
              variant="outline"
              size="sm"
              className={flowZoomPresetButtonClass(isFitZoom)}
              aria-pressed={isFitZoom}
              onClick={() => fitFlowToViewport()}
            >
              适配
            </UIButton>
            <UIButton
              variant="outline"
              size="sm"
              className={flowZoomPresetButtonClass(isFullZoom)}
              aria-pressed={isFullZoom}
              onClick={() => updateZoom(1, '100')}
            >
              100%
            </UIButton>
            <UIButton
              ref={fullscreenButtonRef}
              variant="outline"
              size="sm"
              className={CARD_OUTLINE_BUTTON_CLASS}
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '全屏查看流程图'}
            >
              {isFullscreen ? <Minimize2 /> : <Maximize2 />}
              {isFullscreen ? '退出全屏' : '全屏查看'}
            </UIButton>
          </div>
        </div>
        <div className={FLOW_VIEWER_BODY_CLASS}>
        <div
          className={cn(
            FLOW_CLASS,
            isFullscreen && FLOW_FULLSCREEN_CLASS,
            isFullscreen && FLOW_FULLSCREEN_PANNABLE_CLASS,
            isFullscreen && assistantPanelOpen && FLOW_FULLSCREEN_WITH_AI_CLASS,
          )}
          ref={containerRef}
          onPointerDown={handlePanPointerDown}
          onPointerMove={handlePanPointerMove}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
          onWheel={handleCanvasWheel}
          aria-label={isFullscreen ? 'SOP 流程图画布，可拖拽空白区域移动' : undefined}
          style={isFullscreen ? { backgroundPosition: `${flowPan.x}px ${flowPan.y}px` } : undefined}
        >
        <div
          className={cn(FLOW_ZOOM_SHELL_CLASS, isFullscreen && 'h-full! min-w-0! w-full!')}
          style={isFullscreen ? { width: '100%', height: '100%' } : { width: canvasWidth, height: zoomedHeight }}
        >
          <div
            className={cn(FLOW_GRAPH_CANVAS_CLASS, isFullscreen && 'rounded-none bg-none')}
            style={{
              top: isFullscreen ? flowPan.y : 0,
              left: isFullscreen ? flowPan.x : canvasOffsetX,
              width: graphLayout.width,
              height: graphLayout.height,
              transform: `scale(${flowZoom})`,
            }}
          >
            <svg
              className={cn(FLOW_EDGES_CLASS, 'pointer-events-auto')}
              width={graphLayout.width}
              height={graphLayout.height}
              viewBox={`0 0 ${graphLayout.width} ${graphLayout.height}`}
              aria-label="SOP 流程连线"
            >
              <defs>
                <marker id="skill-flow-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#4e716d" />
                </marker>
              </defs>
              {graphLayout.edges.map((edge) => (
                <g key={edge.id}>
                  <path
                    className={cn(
                      FLOW_EDGE_PATH_CLASS,
                      'pointer-events-none',
                      hoveredEdgeId === edge.id && 'stroke-[#4f817c]! [stroke-width:2.15] opacity-100',
                      selectedEdgeId === edge.id && 'stroke-[#04756f]! [stroke-width:2.5] opacity-100',
                    )}
                    d={edge.path}
                    markerEnd="url(#skill-flow-arrow)"
                    aria-hidden="true"
                  >
                    <title>{edge.title}</title>
                  </path>
                  {edge.kind === 'edge' && (
                    <path
                      d={edge.path}
                      fill="none"
                      stroke="rgba(4, 117, 111, 0.001)"
                      strokeWidth="28"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="stroke"
                      data-flow-edge-hit={edge.id}
                      className="cursor-pointer [pointer-events:stroke]"
                      role="button"
                      tabIndex={0}
                      aria-label={`选择流转 ${edge.title}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerEnter={() => setHoveredEdgeId(edge.id)}
                      onPointerLeave={() => setHoveredEdgeId((current) => current === edge.id ? '' : current)}
                      onFocus={() => setHoveredEdgeId(edge.id)}
                      onBlur={() => setHoveredEdgeId((current) => current === edge.id ? '' : current)}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedEdgeId(edge.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedEdgeId(edge.id);
                      }}
                    />
                  )}
                </g>
              ))}
            </svg>
            {graphLayout.edges.map((edge) => (
              <div
                className={cn(
                  flowEdgeLabelClass(edge.labelTone || edge.kind),
                  edge.kind === 'edge' && 'pointer-events-auto! flex cursor-pointer items-center gap-[5px] overflow-visible!',
                  selectedEdgeId === edge.id && 'border-[#04756f]! bg-[#f3fbf8]! text-[#075f59]!',
                )}
                key={`${edge.id}_label`}
                data-flow-edge-label={edge.id}
                style={{
                  left: edge.labelX,
                  top: edge.labelY,
                  ...(isFullscreen
                    ? {
                        transform: `translate(-50%, -50%) scale(${1 / flowZoom})`,
                        transformOrigin: 'center',
                      }
                    : {}),
                }}
                title={edge.title}
                onPointerEnter={() => setHoveredEdgeId(edge.id)}
                onPointerLeave={() => setHoveredEdgeId((current) => current === edge.id ? '' : current)}
                onFocusCapture={() => setHoveredEdgeId(edge.id)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setHoveredEdgeId('');
                }}
              >
                {edge.kind === 'edge' ? (
                  <button
                    type="button"
                    className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-inherit focus-visible:outline-none"
                    aria-label={`选择流转 ${edge.title}`}
                    onClick={() => setSelectedEdgeId(edge.id)}
                  >
                    {edge.label}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{edge.label}</span>
                )}
                {edge.kind === 'edge' && edge.edgeIndex !== undefined && (
                  <button
                    type="button"
                    className={cn(
                      'pointer-events-none absolute right-[-8px] top-[-9px] z-[2] grid size-[20px] place-items-center rounded-full border border-[#e3e7ec] bg-white p-0 text-[15px] leading-none text-[#858b9c] opacity-0 shadow-[0_4px_10px_rgba(24,31,45,0.12)] transition-[opacity,background,color,border-color] hover:border-[#fecaca] hover:bg-[#fee2e2] hover:text-[#b42318] focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none',
                      (hoveredEdgeId === edge.id || selectedEdgeId === edge.id)
                        && 'pointer-events-auto opacity-100',
                    )}
                    aria-label={`删除流转 ${edge.title}`}
                    title="删除这条流转规则"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      deleteFlowEdgeAt(edge.edgeIndex as number);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <div
              className={FLOW_ROOT_POSITION_CLASS}
              style={{ left: graphLayout.root.x, top: graphLayout.root.y, width: graphLayout.root.width, height: graphLayout.root.height }}
            >
              <SelectableTarget
                className={distillFlowNodeClass('basic', true, selectedPaths, highlightedPaths, updatingPaths, dirtyPaths)}
                target={{ path: 'basic', label: '基础信息' }}
                onToggle={(target) => {
                  setSelectedNodeIndex(null);
                  setBasicInspectorOpen(true);
                  onToggle(target);
                }}
              >
                {selectedPaths.includes('basic') && <span className={SELECTION_MARK_CLASS}><CheckOutlined /></span>}
                <span>基础信息</span>
                <strong {...USER_CONTENT_ATTRIBUTES}><InlineDiffText path="basic" field="name" value={skill.name} diffs={textDiffs} /></strong>
                <small {...USER_CONTENT_ATTRIBUTES}>{skill.skill_id}</small>
                <p {...(skill.description ? USER_CONTENT_ATTRIBUTES : {})}><InlineDiffText path="basic" field="description" value={skill.description || '暂无描述'} diffs={textDiffs} /></p>
                <div className={FLOW_META_CLASS}>
                  <FlowMetaRow label="业务域">
                    <span {...USER_CONTENT_ATTRIBUTES} className={FLOW_CHIP_CLASS}>{skill.business_domain || '-'}</span>
                  </FlowMetaRow>
                  <FlowMetaRow label="单步上限">
                    <span className={FLOW_CHIP_CLASS}>
                      {skill.step_timeout_seconds ? `${skill.step_timeout_seconds} 秒` : '未单独限制'}
                    </span>
                  </FlowMetaRow>
                  <FlowMetaRow label="必填信息">
                    <PlainChipList values={skill.required_info} />
                  </FlowMetaRow>
                  <FlowMetaRow label="触发意图">
                    <PlainChipList values={skill.trigger_intents} />
                  </FlowMetaRow>
                </div>
              </SelectableTarget>
            </div>
            {graphLayout.nodes.map((item) => (
              <div
                className={FLOW_NODE_POSITION_CLASS}
                data-flow-node-id={item.nodeId}
                key={item.nodeId}
                style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
                onPointerDown={(event) => startNodeDrag(event, item)}
                onClickCapture={(event) => {
                  if (suppressNodeClickRef.current !== item.nodeId) return;
                  suppressNodeClickRef.current = '';
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <SkillFlowNodeCard
                  index={item.index}
                  step={item.step}
                  terminal={terminalSet.has(item.nodeId)}
                  outgoingEdges={edgeMap[item.nodeId] || []}
                  selectedPaths={selectedPaths}
                  highlightedPaths={highlightedPaths}
                  updatingPaths={updatingPaths}
                  dirtyPaths={dirtyPaths}
                  textDiffs={textDiffs}
                  toolDescriptions={toolDescriptions}
                  toolStatuses={toolStatuses}
                  sopSkills={sopSkills}
                  selected={selectedNodeId === item.nodeId}
                  connecting={connectionDrag?.sourceNodeId === item.nodeId || armedConnectionSourceId === item.nodeId}
                  dropTarget={connectionDrag?.targetNodeId === item.nodeId}
                  connectHandleScale={Math.min(2.4, 1 / flowZoom)}
                  showConnectHandle={isFullscreen}
                  onConnectClick={armConnectionClick}
                  onConnectStart={startConnectionDrag}
                  onSelect={() => {
                    if (armedConnectionSourceId) {
                      const sourceNodeId = armedConnectionSourceId;
                      setArmedConnectionSourceId('');
                      connectFlowNodes(sourceNodeId, item.nodeId);
                    }
                    setBasicInspectorOpen(false);
                    setSelectedNodeIndex(item.index);
                  }}
                  onToggle={onToggle}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      {isFullscreen && inspectorOpen && (
        basicInspectorOpen ? (
          <SkillFlowBasicInspector
            skill={skill}
            lockSkillId={lockSkillId}
            onEditBasic={editFlowBasic}
          />
        ) : (
          <SkillFlowInspector
            node={selectedNode}
            nodeIndex={selectedNodeIndex}
            nodeId={selectedNodeId}
            nodes={nodes}
            nodeOptions={nodeOptions}
            outgoingEdges={selectedNodeId ? edgeMap[selectedNodeId] || [] : []}
            terminal={selectedNodeId ? terminalSet.has(selectedNodeId) : false}
            actionOptions={inspectorActionOptions}
            toolDescriptions={toolDescriptions}
            toolStatuses={toolStatuses}
            generalSkillOptions={generalSkillOptions}
            toolOptions={toolOptions}
            knowledgeBaseOptions={knowledgeBaseOptions}
            sopOptions={sopOptions}
            tenantUserOptions={tenantUserOptions}
            onEditNode={editFlowNode}
            onAddEdge={addFlowEdge}
            onUpdateEdge={updateFlowEdge}
            onDeleteEdge={deleteFlowEdge}
          />
        )
      )}
      </div>
      </div>
      {connectionDrag && (
        <svg className={FLOW_CONNECTION_PREVIEW_CLASS} aria-hidden="true">
          <path
            d={connectionPreviewPath(connectionDrag)}
            fill="none"
            stroke="#04756f"
            strokeWidth="2.25"
            strokeLinecap="round"
          />
          <circle
            cx={connectionDrag.currentX}
            cy={connectionDrag.currentY}
            r={connectionDrag.targetNodeId ? 5 : 3.5}
            fill={connectionDrag.targetNodeId ? "white" : "#04756f"}
            stroke="#04756f"
            strokeWidth="2"
          />
        </svg>
      )}
    </div>
  );
}

function FlowInspectorSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-[12px] rounded-[16px] border border-[#e4e8ee] bg-white p-[14px] shadow-[0_6px_18px_rgba(24,31,45,0.035)]">
      <div className="grid min-w-0 gap-[2px]">
        <strong className="text-[13px] font-semibold text-[#18181a]">{title}</strong>
        {description && <span className="text-[11px] leading-[1.5] text-[#858b9c]">{description}</span>}
      </div>
      <div className={SOURCE_META_LIST_CLASS}>{children}</div>
    </section>
  );
}

function SkillFlowBasicInspector({
  skill,
  lockSkillId,
  onEditBasic,
}: {
  skill: SkillCard;
  lockSkillId?: boolean;
  onEditBasic: (
    field: keyof SkillCard,
    value: string | string[] | number | null,
  ) => void;
}) {
  return (
    <aside className={FLOW_INSPECTOR_CLASS} aria-label="编辑 SOP 基础信息">
      <div className={FLOW_INSPECTOR_HEADER_CLASS}>
        <div className="grid min-w-0 gap-[3px]">
          <strong className="truncate text-[14px] font-semibold text-[#18181a]">基础信息 · {skill.name || '未命名 SOP'}</strong>
          <span className="text-[11px] leading-[1.45] text-[#858b9c]">这里与源码视图的基础信息使用同一份草稿，修改会实时同步。</span>
        </div>
        <span className="shrink-0 rounded-full bg-[#edf8f5] px-[8px] py-[4px] text-[11px] text-[#04756f]">实时同步</span>
      </div>
      <div className={FLOW_INSPECTOR_BODY_CLASS}>
        <div className="grid min-w-0 gap-[12px]">
          <FlowInspectorSection title="身份与版本" description="定义 SOP 的稳定标识、展示名称和所属业务域。">
            <EditableSourceTextLine label="SOP 名称" value={skill.name || ''} onChange={(value) => onEditBasic('name', value)} />
            <EditableSourceTextLine label={fieldLabel('skill_id')} value={skill.skill_id || ''} readOnly={lockSkillId} onChange={(value) => onEditBasic('skill_id', value)} />
            <EditableSourceTextLine label={fieldLabel('version')} value={skill.version || ''} onChange={(value) => onEditBasic('version', value)} />
            <EditableSourceTextLine label={fieldLabel('business_domain')} value={skill.business_domain || ''} onChange={(value) => onEditBasic('business_domain', value)} />
            <EditableSourceNumberLine
              label={fieldLabel('step_timeout_seconds')}
              value={skill.step_timeout_seconds}
              min={1}
              max={3600}
              placeholder="不单独限制"
              onChange={(value) => onEditBasic('step_timeout_seconds', value)}
            />
            <CapabilityScopeControl
              compact
              resourceType="sop"
              value={normalizeCapabilityScope(skill.capability_scope)}
              onChange={(value) => onEditBasic('capability_scope', value)}
            />
          </FlowInspectorSection>
          <FlowInspectorSection title="触发与目标" description="说明何时进入流程，以及模型需要完成什么。">
            <EditableSourceTextLine label={fieldLabel('description')} value={skill.description || ''} multiline onChange={(value) => onEditBasic('description', value)} />
            <EditableSourceListLine label={fieldLabel('trigger_intents')} values={skill.trigger_intents} onChange={(value) => onEditBasic('trigger_intents', value)} />
            <EditableSourceListLine label={fieldLabel('user_utterance_examples')} values={skill.user_utterance_examples} onChange={(value) => onEditBasic('user_utterance_examples', value)} />
            <EditableSourceListLine label={fieldLabel('goal')} values={skill.goal} onChange={(value) => onEditBasic('goal', value)} />
          </FlowInspectorSection>
          <FlowInspectorSection title="输入与回复约束" description="列出完成流程所需的信息和最终回复规则。">
            <EditableSourceListLine label={fieldLabel('required_info')} values={skill.required_info} onChange={(value) => onEditBasic('required_info', value)} />
            <EditableSourceListLine label={fieldLabel('response_rules')} values={skill.response_rules} minRows={5} maxRows={14} onChange={(value) => onEditBasic('response_rules', value)} />
          </FlowInspectorSection>
        </div>
      </div>
    </aside>
  );
}

function SkillFlowInspector({
  node,
  nodeIndex,
  nodeId,
  nodes,
  nodeOptions,
  outgoingEdges,
  terminal,
  actionOptions,
  toolDescriptions,
  toolStatuses,
  generalSkillOptions,
  toolOptions,
  knowledgeBaseOptions,
  sopOptions,
  tenantUserOptions,
  onEditNode,
  onAddEdge,
  onUpdateEdge,
  onDeleteEdge,
}: {
  node: Record<string, unknown> | null;
  nodeIndex: number | null;
  nodeId: string;
  nodes: Array<Record<string, unknown>>;
  nodeOptions: SelectOption[];
  outgoingEdges: Array<Record<string, unknown>>;
  terminal: boolean;
  actionOptions: SelectOption[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
  generalSkillOptions: CapabilityReferenceOption[];
  toolOptions: CapabilityReferenceOption[];
  knowledgeBaseOptions: CapabilityReferenceOption[];
  sopOptions: SelectOption[];
  tenantUserOptions: SelectOption[];
  onEditNode: (index: number, field: string, value: string | string[] | boolean | Record<string, unknown>) => void;
  onAddEdge: (index: number) => void;
  onUpdateEdge: (index: number, edgeIndex: number, patch: Record<string, unknown>) => void;
  onDeleteEdge: (index: number, edgeIndex: number) => void;
}) {
  if (!node || nodeIndex === null) {
    return (
      <aside className={FLOW_INSPECTOR_CLASS} aria-label="节点编辑器">
        <div className={FLOW_INSPECTOR_EMPTY_CLASS}>
          选择一个节点后，可在这里编辑对应的源码字段和流转规则。
        </div>
      </aside>
    );
  }
  const nodeState = [
    Boolean(node.optional) ? '可选' : '必选',
    terminal ? '终止节点' : '流程节点',
  ].join(' · ');
  const isSubflow = String(node.type || '') === 'subflow';
  // 处理人仅对 handoff 节点有意义;转人工动作只允许出现在 handoff 节点上,
  // 回复/收集等其他节点一律不展示处理人与转人工动作。
  const isHandoffNode = String(node.type || '') === 'handoff';
  return (
    <aside className={FLOW_INSPECTOR_CLASS} aria-label={`编辑节点 ${String(node.name || nodeId)}`}>
      <div className={FLOW_INSPECTOR_HEADER_CLASS}>
        <div className="grid min-w-0 gap-[3px]">
          <strong className="truncate text-[14px] font-semibold text-[#18181a]">Node {nodeIndex + 1} · {String(node.name || nodeId)}</strong>
          <span className="text-[11px] leading-[1.45] text-[#858b9c]">拖动左侧画布浏览；从节点右侧连接点拖到目标节点，可新增流转。</span>
        </div>
        <span className="shrink-0 rounded-full bg-[#edf8f5] px-[8px] py-[4px] text-[11px] text-[#04756f]">实时同步</span>
      </div>
      <div className={FLOW_INSPECTOR_BODY_CLASS}>
        <div className="grid min-w-0 gap-[12px]">
          <FlowInspectorSection title="节点定义" description="节点名称、类型和执行目标会直接进入 TaskFrame。">
            <EditableSourceTextLine label="节点名称" value={String(node.name || '')} onChange={(value) => onEditNode(nodeIndex, 'name', value)} />
            <EditableSourceTextLine label={fieldLabel('step_id')} value={nodeId} onChange={(value) => onEditNode(nodeIndex, 'step_id', value)} />
            <EditableSourceSelectLine label={fieldLabel('type')} value={String(node.type || 'collect_info')} options={NODE_TYPE_OPTIONS} onChange={(value) => onEditNode(nodeIndex, 'type', value)} />
            {String(node.type || '') === 'subflow' && (
              <EditableSourceSelectLine
                label="调用子 SOP"
                value={String(node.sub_sop_id || '')}
                options={sopOptions}
                onChange={(value) => onEditNode(nodeIndex, 'sub_sop_id', value)}
              />
            )}
            <SourceReadonlyLine label="节点状态" value={nodeState} staticLabels />
            {isSubflow ? (
              <SourceReadonlyLine label="执行职责" value="仅进入所选子 SOP；字段、动作和能力由子 SOP 自己定义。" />
            ) : (
              <EditableSourceTextLine label={fieldLabel('instruction')} value={String(node.instruction || '')} multiline onChange={(value) => onEditNode(nodeIndex, 'instruction', value)} />
            )}
            {isHandoffNode && (
              <EditableSourceSelectLine
                label="处理人"
                value={
                  node.assignee_user_id
                    ? formatHandoffAssigneeValue(
                      String(node.assignee_user_id),
                      String(node.assignee_notify_channel || ''),
                    )
                    : UNASSIGNED_USER_VALUE
                }
                options={tenantUserOptions}
                onChange={(value) => onEditNode(
                  nodeIndex,
                  'assignee_user_id',
                  value === UNASSIGNED_USER_VALUE ? '' : value,
                )}
              />
            )}
          </FlowInspectorSection>
          {!isSubflow && (
            <>
              <FlowInspectorSection title="输入与允许动作" description="明确本节点需要收集的字段，以及模型可以自主选择的动作。">
                <EditableSourceListLine label={fieldLabel('expected_user_info')} values={asStringList(node.expected_user_info)} onChange={(value) => onEditNode(nodeIndex, 'expected_user_info', value)} />
                <EditableSourceActionLine values={asStringList(node.allowed_actions)} options={actionOptions} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} onChange={(value) => onEditNode(nodeIndex, 'allowed_actions', value)} />
              </FlowInspectorSection>
              <FlowInspectorSection title="节点专用能力" description="SOP-specific 能力只有在这里明确引用后，才会进入当前节点的 Harness 能力清单。">
                <EditableCapabilityReferencesLine label="SOP 技能" values={asStringList(node.general_skill_ids)} requiredValues={asStringList(node.required_general_skill_ids)} options={generalSkillOptions} emptyText="未指定技能" onChange={(value) => onEditNode(nodeIndex, 'general_skill_ids', value)} onRequiredChange={(value) => onEditNode(nodeIndex, 'required_general_skill_ids', value)} />
                <EditableCapabilityReferencesLine label="SOP 工具" values={asStringList(node.tool_ids)} requiredValues={asStringList(node.required_tool_ids)} options={toolOptions} emptyText="未指定工具" onChange={(value) => onEditNode(nodeIndex, 'tool_ids', value)} onRequiredChange={(value) => onEditNode(nodeIndex, 'required_tool_ids', value)} />
                <EditableCapabilityReferencesLine label="SOP 知识库" values={asStringList(node.knowledge_base_ids)} requiredValues={asStringList(node.required_knowledge_base_ids)} options={knowledgeBaseOptions} emptyText="未指定知识库" onChange={(value) => onEditNode(nodeIndex, 'knowledge_base_ids', value)} onRequiredChange={(value) => onEditNode(nodeIndex, 'required_knowledge_base_ids', value)} />
              </FlowInspectorSection>
            </>
          )}
          <FlowInspectorSection title="流转与失败处理" description="按优先级判断规则；未命中时使用重试策略或终止流程。">
            <EditableFlowRulesLine sourceNodeId={nodeId} edges={outgoingEdges} nodes={nodes} nodeOptions={nodeOptions} terminal={terminal} onAdd={() => onAddEdge(nodeIndex)} onUpdate={(edgeIndex, patch) => onUpdateEdge(nodeIndex, edgeIndex, patch)} onDelete={(edgeIndex) => onDeleteEdge(nodeIndex, edgeIndex)} />
            {!isSubflow && <SourceJsonLine label="知识范围" value={node.knowledge_scope} />}
            {!isSubflow && <EditableRetryPolicyLine value={node.retry_policy} onChange={(value) => onEditNode(nodeIndex, 'retry_policy', value)} />}
          </FlowInspectorSection>
        </div>
      </div>
    </aside>
  );
}

function SkillFlowNodeCard({
  index,
  step,
  terminal,
  outgoingEdges,
  selectedPaths,
  highlightedPaths,
  updatingPaths,
  dirtyPaths,
  textDiffs,
  toolDescriptions,
  toolStatuses,
  sopSkills,
  selected,
  connecting,
  dropTarget,
  connectHandleScale,
  showConnectHandle,
  onConnectClick,
  onConnectStart,
  onSelect,
  onToggle,
}: {
  index: number;
  step: Record<string, unknown>;
  terminal: boolean;
  outgoingEdges: Array<Record<string, unknown>>;
  selectedPaths: string[];
  highlightedPaths: string[];
  updatingPaths: string[];
  dirtyPaths: string[];
  textDiffs: TextDiffAnimation[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
  sopSkills: SkillRead[];
  selected: boolean;
  connecting: boolean;
  dropTarget: boolean;
  connectHandleScale: number;
  showConnectHandle: boolean;
  onConnectClick: (event: MouseEvent<HTMLButtonElement>, sourceNodeId: string) => void;
  onConnectStart: (event: ReactPointerEvent<HTMLButtonElement>, sourceNodeId: string) => void;
  onSelect: () => void;
  onToggle: (target: TargetSelection) => void;
}) {
  const nodeId = String(step.node_id || step.step_id || `node_${index + 1}`);
  const path = stepTargetPath(index);
  const expectedInfo = asStringList(step.expected_user_info);
  const actionList = asStringList(step.allowed_actions);
  const instruction = String(step.instruction || '暂无说明');
  const isSubflow = String(step.type || '') === 'subflow';
  const childSop = isSubflow
    ? sopSkills.find((item) => item.skill_id === String(step.sub_sop_id || ''))
    : undefined;
  return (
    <div className={FLOW_NODE_SHELL_CLASS}>
      <SelectableTarget
        className={cn(
          distillFlowNodeClass(path, false, selectedPaths, highlightedPaths, updatingPaths, dirtyPaths),
          'cursor-grab! active:cursor-grabbing!',
          selected && 'border-[#04756f]! shadow-[0_0_0_3px_rgba(4,117,111,0.10),0_12px_30px_rgba(4,117,111,0.08)]',
          dropTarget && 'border-[#04756f]! shadow-[0_0_0_4px_rgba(4,117,111,0.12),0_12px_30px_rgba(4,117,111,0.10)]',
        )}
        target={{ path, label: `节点 ${index + 1}：${step.name || nodeId}` }}
        onToggle={(target) => {
          onSelect();
          onToggle(target);
        }}
      >
        {selectedPaths.includes(path) && <span className={SELECTION_MARK_CLASS}><CheckOutlined /></span>}
        <span>节点 {index + 1}</span>
        <strong {...USER_CONTENT_ATTRIBUTES}><InlineDiffText path={path} field="name" value={String(step.name || nodeId)} diffs={textDiffs} /></strong>
        <small {...USER_CONTENT_ATTRIBUTES}>{nodeId}</small>
        <div className={FLOW_NODE_BADGES_CLASS}>
          <span className={FLOW_CHIP_CLASS}>{nodeTypeLabel(String(step.type || 'collect_info'))}</span>
          {Boolean(step.optional) && <span className={FLOW_CHIP_CLASS}>可选</span>}
          {terminal && <span className={FLOW_CHIP_CLASS}>终止</span>}
        </div>
        {isSubflow ? (
          <NestedSopPreview childSop={childSop} subSopId={String(step.sub_sop_id || '')} />
        ) : (
          <p {...(step.instruction ? USER_CONTENT_ATTRIBUTES : {})} className={FLOW_NODE_SUMMARY_CLASS} title={instruction}>
            <InlineDiffText path={path} field="instruction" value={instruction} diffs={textDiffs} />
          </p>
        )}
        <div className={FLOW_COMPACT_META_CLASS}>
          {!isSubflow && expectedInfo.length > 0 && (
            <div className={FLOW_COMPACT_ROW_CLASS}>
              <span>字段</span>
              <PlainChipList values={expectedInfo} />
            </div>
          )}
          {!isSubflow && actionList.length > 0 && (
            <div className={FLOW_COMPACT_ROW_CLASS}>
              <span>动作</span>
              <FlowActionList actions={actionList} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} />
            </div>
          )}
          {outgoingEdges.length > 0 && <span className={FLOW_ROUTE_COUNT_CLASS}>{outgoingRouteCountLabel(outgoingEdges)}</span>}
        </div>
      </SelectableTarget>
      {showConnectHandle && (
        <button
          type="button"
          data-flow-connect-handle
          className={cn(FLOW_NODE_CONNECT_HANDLE_CLASS, connecting && FLOW_NODE_CONNECT_HANDLE_ACTIVE_CLASS)}
          style={{ transform: `translateX(-50%) scale(${connectHandleScale})` }}
          aria-label={`从「${String(step.name || nodeId)}」拖线连接节点`}
          title="拖到另一个节点以新增流转规则"
          onPointerDown={(event) => onConnectStart(event, nodeId)}
          onClick={(event) => onConnectClick(event, nodeId)}
        >
          +
        </button>
      )}
    </div>
  );
}

function NestedSopPreview({ childSop, subSopId }: { childSop?: SkillRead; subSopId: string }) {
  const childNodes = childSop ? skillGraphSteps(childSop.content) : [];
  const visibleNodes = childNodes.slice(0, 4);
  return (
    <div className="grid gap-[7px] rounded-[10px] border border-[#cfe5df] bg-[#f3faf7] p-[9px] text-[#315e59]">
      <div className="flex min-w-0 items-center justify-between gap-[8px]">
        <strong className="truncate text-[12px] font-semibold">{childSop?.name || '未找到子 SOP'}</strong>
        <span className="shrink-0 rounded-full bg-white px-[7px] py-[2px] text-[10px] text-[#04756f]">共享字段</span>
      </div>
      <span className="truncate font-mono text-[10px] text-[#66817d]">{subSopId || '尚未选择 SOP'}</span>
      {visibleNodes.length > 0 ? (
        <div className="flex min-w-0 items-center gap-[4px] overflow-hidden" aria-label="子 SOP 节点预览">
          {visibleNodes.map((node, index) => (
            <div className="contents" key={String(node.node_id || index)}>
              {index > 0 && <span className="shrink-0 text-[#8aa39f]">→</span>}
              <span className="min-w-0 truncate rounded-md border border-[#d8e9e4] bg-white px-[6px] py-[3px] text-[10px]">
                {String(node.name || node.node_id || `节点 ${index + 1}`)}
              </span>
            </div>
          ))}
          {childNodes.length > visibleNodes.length && (
            <span className="shrink-0 text-[10px] text-[#66817d]">+{childNodes.length - visibleNodes.length}</span>
          )}
        </div>
      ) : (
        <span className="text-[10px] text-[#8a9694]">发布子 SOP 后将在这里显示其流程节点</span>
      )}
    </div>
  );
}

function FlowMetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={FLOW_META_ROW_CLASS}>
      <span className={FLOW_META_LABEL_CLASS}>{label}</span>
      {children}
    </div>
  );
}

function PlainChipList({ values }: { values: unknown }) {
  const items = asStringList(values);
  if (items.length === 0) return <span className={cn(FLOW_CHIP_CLASS, FLOW_CHIP_MUTED_CLASS)}>-</span>;
  return (
    <div className={FLOW_CHIP_LIST_CLASS}>
      {items.map((item, index) => (
        <span {...USER_CONTENT_ATTRIBUTES} className={FLOW_CHIP_CLASS} key={`${item}_${index}`}>
          {item}
        </span>
      ))}
    </div>
  );
}

function FlowActionList({
  actions,
  toolDescriptions,
  toolStatuses,
}: {
  actions: string[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
}) {
  return (
    <div className="flex min-w-0 flex-wrap gap-[6px]">
      {actions.map((action, index) => (
        <ActionChip action={action} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} key={`${action}_${index}`} />
      ))}
    </div>
  );
}

function skillGraphSteps(skill: SkillCard): Array<Record<string, unknown>> {
  if (Array.isArray(skill.nodes) && skill.nodes.length > 0) {
    return skill.nodes.map((node, index) => {
      const capabilityRefs = nodeCapabilityRefs(node);
      return {
        step_id: node.node_id || `node_${index + 1}`,
        node_id: node.node_id || `node_${index + 1}`,
        type: node.type || 'collect_info',
        name: node.name || node.node_id || `节点 ${index + 1}`,
        instruction: node.instruction || '',
        optional: Boolean(node.optional),
        condition: node.condition || '',
        expected_user_info: asStringList(node.expected_user_info),
        allowed_actions: asStringList(node.allowed_actions),
        general_skill_ids: capabilityRefs.general_skill_ids,
        tool_ids: capabilityRefs.tool_ids,
        knowledge_base_ids: capabilityRefs.knowledge_base_ids,
        required_general_skill_ids: capabilityRefs.required_general_skill_ids,
        required_tool_ids: capabilityRefs.required_tool_ids,
        required_knowledge_base_ids: capabilityRefs.required_knowledge_base_ids,
        knowledge_scope: isRecord(node.knowledge_scope) ? node.knowledge_scope : {},
        retry_policy: isRecord(node.retry_policy) ? node.retry_policy : {},
        metadata: isRecord(node.metadata) ? node.metadata : {},
        sub_sop_id: stringValue(node.sub_sop_id, ''),
        assignee_user_id: stringValue(node.assignee_user_id, ''),
        assignee_notify_channel: stringValue(node.assignee_notify_channel, ''),
      };
    });
  }
  return [];
}

function nodeCapabilityRefs(node: Record<string, unknown>) {
  const refs = isRecord(node.capability_refs) ? node.capability_refs : {};
  const generalSkillIds = asStringList(refs.general_skill_ids ?? node.general_skill_ids);
  const toolIds = asStringList(refs.tool_ids ?? node.tool_ids);
  const knowledgeBaseIds = asStringList(refs.knowledge_base_ids ?? node.knowledge_base_ids);
  return {
    general_skill_ids: generalSkillIds,
    tool_ids: toolIds,
    knowledge_base_ids: knowledgeBaseIds,
    required_general_skill_ids: asStringList(
      refs.required_general_skill_ids ?? node.required_general_skill_ids,
    ).filter((value) => generalSkillIds.includes(value)),
    required_tool_ids: asStringList(
      refs.required_tool_ids ?? node.required_tool_ids,
    ).filter((value) => toolIds.includes(value)),
    required_knowledge_base_ids: asStringList(
      refs.required_knowledge_base_ids ?? node.required_knowledge_base_ids,
    ).filter((value) => knowledgeBaseIds.includes(value)),
  };
}

function updateCapabilityRefs(
  refs: ReturnType<typeof nodeCapabilityRefs>,
  field: string,
  values: string[],
): ReturnType<typeof nodeCapabilityRefs> {
  const next = { ...refs, [field]: Array.from(new Set(values)) };
  const requiredField = REQUIRED_CAPABILITY_FIELD_BY_ALLOWED[field];
  if (requiredField) {
    next[requiredField as keyof typeof next] = asStringList(
      next[requiredField as keyof typeof next],
    ).filter((value) => values.includes(value));
  }
  return next;
}

function skillGraphEdgeMap(skill: SkillCard): Record<string, Array<Record<string, unknown>>> {
  const map: Record<string, Array<Record<string, unknown>>> = {};
  (Array.isArray(skill.edges) ? skill.edges : []).forEach((edge) => {
    const source = String(edge.source_node_id || '');
    if (!source) return;
    if (!map[source]) map[source] = [];
    map[source].push(edge);
  });
  return map;
}

function normalizeSkillNodes(skill: SkillCard): Array<Record<string, unknown>> {
  return Array.isArray(skill.nodes) ? skill.nodes.filter(isRecord).map((node, index) => ({
    ...node,
    node_id: String(node.node_id || node.step_id || `node_${index + 1}`),
  })) : [];
}

function normalizeSkillEdges(skill: SkillCard): Array<Record<string, unknown>> {
  return Array.isArray(skill.edges) ? skill.edges.filter(isRecord).map((edge, index) => ({
    source_node_id: String(edge.source_node_id || ''),
    next_node_id: String(edge.next_node_id || ''),
    condition: typeof edge.condition === 'string' ? edge.condition : '',
    priority: Number.isFinite(Number(edge.priority)) ? Number(edge.priority) : index,
    label: typeof edge.label === 'string' ? edge.label : '',
  })) : [];
}

function nodeIdAt(skill: SkillCard, index: number): string {
  const node = normalizeSkillNodes(skill)[index];
  return String(node?.node_id || node?.step_id || `node_${index + 1}`);
}

function findSourceEdgeIndex(edges: Array<Record<string, unknown>>, sourceId: string, localIndex: number): number {
  let seen = -1;
  return edges.findIndex((edge) => {
    if (String(edge.source_node_id || '') !== sourceId) return false;
    seen += 1;
    return seen === localIndex;
  });
}

function edgePriority(edge: Record<string, unknown>, fallback = 0): number {
  const value = Number(edge.priority);
  return Number.isFinite(value) ? value : fallback;
}

function uniqueNodeId(nodes: Array<Record<string, unknown>>, preferred: string): string {
  const used = new Set(nodes.map((node) => String(node.node_id || node.step_id || '')).filter(Boolean));
  const base = preferred.replace(/\s+/g, '_').replace(/[^\w.-]/g, '') || 'node';
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

function nodeDisplayNameById(nodes: Array<Record<string, unknown>>, nodeId: string): string {
  const index = nodes.findIndex((node) => String(node.node_id || node.step_id || '') === nodeId);
  if (index < 0) return nodeId || '未指定节点';
  const node = nodes[index];
  return `Node ${index + 1} · ${String(node.name || nodeId)}`;
}

type SkillFlowCanvasNode = {
  nodeId: string;
  step: Record<string, unknown>;
  index: number;
  rank: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type SkillFlowCanvasEdge = {
  id: string;
  kind: 'root' | 'edge';
  edgeIndex?: number;
  labelTone?: 'root' | 'branch' | 'parallel' | 'return';
  label: string;
  title: string;
  path: string;
  labelX: number;
  labelY: number;
};

function estimatedWrappedLines(value: unknown, charactersPerLine: number): number {
  const text = String(value || '').trim();
  if (!text) return 1;
  return text.split('\n').reduce((total, line) => (
    total + Math.max(1, Math.ceil(Array.from(line).length / charactersPerLine))
  ), 0);
}

function estimateSkillFlowNodeHeight(nodes: Array<Record<string, unknown>>): number {
  return Math.max(324, ...nodes.map((node) => {
    const instructionHeight = estimatedWrappedLines(node.instruction || '暂无说明', 24) * 21;
    const fieldRows = Math.ceil(asStringList(node.expected_user_info).length / 3) * 28;
    const actionRows = Math.ceil(asStringList(node.allowed_actions).length / 2) * 28;
    return 182 + instructionHeight + fieldRows + actionRows + 48;
  }));
}

function estimateSkillFlowRootHeight(skill: SkillCard): number {
  const descriptionHeight = estimatedWrappedLines(skill.description || '暂无描述', 38) * 21;
  const infoRows = Math.ceil(asStringList(skill.required_info).length / 4) * 28;
  const intentRows = Math.ceil(asStringList(skill.trigger_intents).length / 4) * 28;
  return Math.max(270, 154 + descriptionHeight + infoRows + intentRows + 72);
}

function buildSkillFlowCanvasLayout(
  skill: SkillCard,
  nodes: Array<Record<string, unknown>>,
  nodeNameMap: Record<string, string>,
  positionOverrides: Record<string, SkillFlowPosition> = {},
) {
  const layerLayout = buildSkillFlowLayout(skill, nodes);
  const cardWidth = 360;
  const cardHeight = estimateSkillFlowNodeHeight(nodes);
  const rootWidth = 500;
  const rootHeight = estimateSkillFlowRootHeight(skill);
  const columnGap = 188;
  const rowGap = 236;
  const rootGap = 126;
  const paddingX = 144;
  const paddingY = 66;
  const layerWidths = layerLayout.layers.map((layer) => (
    layer.length * cardWidth + Math.max(0, layer.length - 1) * columnGap
  ));
  const maxContentWidth = Math.max(rootWidth, ...layerWidths, 0);
  const baseWidth = Math.max(1180, paddingX * 2 + maxContentWidth);
  const root = {
    x: (baseWidth - rootWidth) / 2,
    y: paddingY,
    width: rootWidth,
    height: rootHeight,
  };
  const positionedNodes: SkillFlowCanvasNode[] = [];
  const positionMap = new Map<string, SkillFlowCanvasNode>();

  layerLayout.layers.forEach((layer, layerIndex) => {
    const layerWidth = layer.length * cardWidth + Math.max(0, layer.length - 1) * columnGap;
    const layerStartX = Math.max(paddingX, (baseWidth - layerWidth) / 2);
    layer.forEach((item, itemIndex) => {
      const positioned = {
        ...item,
        rank: layerIndex,
        x: positionOverrides[item.nodeId]?.x
          ?? skillNodeFlowPosition(item.step)?.x
          ?? layerStartX + itemIndex * (cardWidth + columnGap),
        y: positionOverrides[item.nodeId]?.y
          ?? skillNodeFlowPosition(item.step)?.y
          ?? paddingY + rootHeight + rootGap + layerIndex * (cardHeight + rowGap),
        width: cardWidth,
        height: cardHeight,
      };
      positionedNodes.push(positioned);
      positionMap.set(item.nodeId, positioned);
    });
  });

  const width = Math.max(
    baseWidth,
    ...positionedNodes.map((node) => node.x + node.width + paddingX),
  );

  const rawEdges = Array.isArray(skill.edges) ? skill.edges : [];
  const edgeSiblingCounts = rawEdges.reduce<Record<string, number>>((acc, edge) => {
    const sourceId = String(edge.source_node_id || '');
    if (sourceId) acc[sourceId] = (acc[sourceId] || 0) + 1;
    return acc;
  }, {});
  const sourceEdgeLabelCounts = rawEdges.reduce<Record<string, Record<string, number>>>((acc, edge) => {
    const sourceId = String(edge.source_node_id || '').trim();
    if (!sourceId) return acc;
    const label = normalizedEdgeLabel(edge, nodeNameMap);
    if (!acc[sourceId]) acc[sourceId] = {};
    acc[sourceId][label] = (acc[sourceId][label] || 0) + 1;
    return acc;
  }, {});
  const incomingCounts = rawEdges.reduce<Record<string, number>>((acc, edge) => {
    const targetId = String(edge.next_node_id || '');
    if (targetId) acc[targetId] = (acc[targetId] || 0) + 1;
    return acc;
  }, {});
  const edgeSiblingIndexes: Record<string, number> = {};
  const incomingIndexes: Record<string, number> = {};
  const layoutEdges: SkillFlowCanvasEdge[] = [];
  const baseHeight = paddingY * 2 + rootHeight + rootGap + layerLayout.layers.length * cardHeight + Math.max(0, layerLayout.layers.length - 1) * rowGap;
  const height = Math.max(
    baseHeight,
    ...positionedNodes.map((node) => node.y + node.height + paddingY),
  );
  const startNode = positionMap.get(String(skill.start_node_id || positionedNodes[0]?.nodeId || ''));
  if (startNode) {
    const sourceX = root.x + root.width / 2;
    const sourceY = root.y + root.height + 8;
    const targetX = startNode.x + startNode.width / 2;
    const targetY = startNode.y - 8;
    const laneY = edgeLaneY(sourceY, targetY, 0, 1);
    const labelAnchor = avoidFlowLabelOverlap(
      { x: (sourceX + targetX) / 2, y: laneY },
      [...positionedNodes, { ...root, nodeId: '__root__' } as SkillFlowCanvasNode],
      width,
      height,
    );
    layoutEdges.push({
      id: `root_${startNode.nodeId}`,
      kind: 'root',
      labelTone: 'root',
      label: '开始',
      title: `开始 -> ${nodeNameMap[startNode.nodeId] || startNode.nodeId}`,
      path: forwardFlowPath(sourceX, sourceY, targetX, targetY, laneY),
      labelX: labelAnchor.x,
      labelY: labelAnchor.y,
    });
  }
  rawEdges.forEach((edge, index) => {
    const sourceId = String(edge.source_node_id || '');
    const targetId = String(edge.next_node_id || '');
    const source = positionMap.get(sourceId);
    const target = positionMap.get(targetId);
    if (!source || !target) return;
    const siblingCount = edgeSiblingCounts[sourceId] || 1;
    const baseLabel = normalizedEdgeLabel(edge, nodeNameMap);
    const hasDuplicateSourceLabel = (sourceEdgeLabelCounts[sourceId]?.[baseLabel] || 0) > 1;
    const isParallelFlow = hasDuplicateSourceLabel;
    const label = flowEdgeDisplayLabel(edge, nodeNameMap, siblingCount, hasDuplicateSourceLabel);
    const title = incomingEdgeLabel(edge, nodeNameMap);
    const siblingIndex = edgeSiblingIndexes[sourceId] || 0;
    edgeSiblingIndexes[sourceId] = siblingIndex + 1;
    const incomingCount = incomingCounts[targetId] || 1;
    const incomingIndex = incomingIndexes[targetId] || 0;
    incomingIndexes[targetId] = incomingIndex + 1;
    const sourceX = source.x + source.width / 2;
    const sourceY = source.y + source.height + 8;
    const targetX = target.x + target.width / 2;
    const targetY = target.y - 8;
    const isReturn = targetY <= sourceY;
    const laneY = edgeLaneY(sourceY, targetY, siblingIndex, siblingCount);
    const shouldAvoidNodes = !isReturn && forwardRouteHitsNode(source, target, positionedNodes, laneY);
    const path = isReturn
      ? sideReturnFlowPath(source, target, width, siblingIndex)
      : shouldAvoidNodes
        ? sideForwardFlowPath(source, target, positionedNodes, width, siblingIndex, incomingIndex)
        : forwardFlowPath(sourceX, sourceY, targetX, targetY, laneY);
    const labelAnchor = isReturn
      ? returnEdgeLabelPosition(source, target, width, siblingIndex)
      : shouldAvoidNodes
        ? sideForwardEdgeLabelPosition(source, target, positionedNodes, width, siblingIndex, incomingIndex)
        : forwardEdgeLabelPosition(sourceX, targetX, laneY, siblingIndex, siblingCount, incomingIndex, incomingCount);
    const safeLabelAnchor = avoidFlowLabelOverlap(labelAnchor, positionedNodes, width, height);
    layoutEdges.push({
      id: `${sourceId}_${targetId}_${index}`,
      kind: 'edge',
      edgeIndex: index,
      label: compactEdgeLabel(label),
      title,
      path,
      labelX: safeLabelAnchor.x,
      labelY: safeLabelAnchor.y,
      labelTone: isReturn ? 'return' : (isParallelFlow ? 'parallel' : (siblingCount > 1 ? 'branch' : 'root')),
    });
  });

  return { width, height, root, nodes: positionedNodes, edges: layoutEdges };
}

function buildSkillFlowLayout(skill: SkillCard, nodes: Array<Record<string, unknown>>) {
  const byId = new Map(nodes.map((node, index) => [
    String(node.node_id || node.step_id || `node_${index + 1}`),
    { node, index },
  ]));
  const edgeMap = skillGraphEdgeMap(skill);
  const startId = String(skill.start_node_id || nodes[0]?.node_id || nodes[0]?.step_id || '');
  const start = startId && byId.has(startId)
    ? startId
    : nodes.length > 0
      ? String(nodes[0].node_id || nodes[0].step_id || 'node_1')
      : '';
  const reachable = new Set<string>();
  const queue = start ? [start] : [];
  while (queue.length > 0) {
    const nodeId = queue.shift() || '';
    if (!nodeId || reachable.has(nodeId) || !byId.has(nodeId)) continue;
    reachable.add(nodeId);
    (edgeMap[nodeId] || [])
      .slice()
      .sort((a, b) => {
        const priorityDelta = Number(a.priority || 0) - Number(b.priority || 0);
        if (priorityDelta !== 0) return priorityDelta;
        const aIndex = byId.get(String(a.next_node_id || ''))?.index ?? Number.MAX_SAFE_INTEGER;
        const bIndex = byId.get(String(b.next_node_id || ''))?.index ?? Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      })
      .forEach((edge) => {
        const nextId = String(edge.next_node_id || '');
        if (nextId && byId.has(nextId) && !reachable.has(nextId)) queue.push(nextId);
      });
  }

  const ranks = new Map<string, number>();
  if (start) ranks.set(start, 0);
  for (let pass = 0; pass < nodes.length + 2; pass += 1) {
    let changed = false;
    (Array.isArray(skill.edges) ? skill.edges : []).forEach((edge) => {
      const sourceId = String(edge.source_node_id || '');
      const targetId = String(edge.next_node_id || '');
      if (!reachable.has(sourceId) || !reachable.has(targetId)) return;
      const sourceMeta = byId.get(sourceId);
      const targetMeta = byId.get(targetId);
      if (!sourceMeta || !targetMeta) return;
      if (targetMeta.index <= sourceMeta.index) return;
      const sourceRank = ranks.get(sourceId);
      if (sourceRank === undefined) return;
      const nextRank = sourceRank + 1;
      if ((ranks.get(targetId) ?? -1) < nextRank) {
        ranks.set(targetId, nextRank);
        changed = true;
      }
    });
    if (!changed) break;
  }

  const layerMap = new Map<number, Array<{ nodeId: string; step: Record<string, unknown>; index: number }>>();
  const orderedReachable = nodes
    .map((node, index) => ({
      nodeId: String(node.node_id || node.step_id || `node_${index + 1}`),
      step: node,
      index,
    }))
    .filter((item) => reachable.has(item.nodeId));
  orderedReachable.forEach((item) => {
    const rank = Math.max(0, Math.min(ranks.get(item.nodeId) ?? item.index, item.index));
    if (!layerMap.has(rank)) layerMap.set(rank, []);
    layerMap.get(rank)?.push(item);
  });

  const layers = Array.from(layerMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, layer]) => layer.sort((a, b) => a.index - b.index));

  const remainder = nodes
    .map((node, index) => ({
      nodeId: String(node.node_id || node.step_id || `node_${index + 1}`),
      step: node,
      index,
    }))
    .filter((item) => !reachable.has(item.nodeId));
  if (remainder.length > 0) layers.push(remainder);
  return { layers };
}

function edgeLaneY(sourceY: number, targetY: number, siblingIndex: number, siblingCount: number): number {
  const safeTop = sourceY + 58;
  const safeBottom = targetY - 58;
  if (safeBottom <= safeTop) {
    return sourceY + Math.max(72, (targetY - sourceY) * 0.42);
  }
  const laneCount = Math.max(1, siblingCount);
  const maxSpread = Math.min(38, Math.max(24, (safeBottom - safeTop) / Math.max(1, laneCount - 1 || 1)));
  const start = (safeTop + safeBottom) / 2 - ((laneCount - 1) * maxSpread) / 2;
  return Math.max(safeTop, Math.min(safeBottom, start + siblingIndex * maxSpread));
}

function forwardFlowPath(sourceX: number, sourceY: number, targetX: number, targetY: number, laneY: number): string {
  const safeLaneY = Math.max(sourceY + 48, Math.min(targetY - 48, laneY));
  const verticalEase = Math.min(44, Math.max(22, (targetY - sourceY) * 0.18));
  const horizontalGap = Math.abs(targetX - sourceX);
  if (horizontalGap < 12) {
    return [
      `M ${sourceX} ${sourceY}`,
      `C ${sourceX} ${sourceY + verticalEase}, ${targetX} ${targetY - verticalEase}, ${targetX} ${targetY}`,
    ].join(' ');
  }
  const bend = Math.max(44, Math.min(120, horizontalGap * 0.28));
  return [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX} ${sourceY + verticalEase}, ${sourceX} ${safeLaneY - verticalEase}, ${sourceX} ${safeLaneY}`,
    `C ${sourceX + Math.sign(targetX - sourceX) * bend} ${safeLaneY}, ${targetX - Math.sign(targetX - sourceX) * bend} ${safeLaneY}, ${targetX} ${safeLaneY}`,
    `C ${targetX} ${safeLaneY + verticalEase}, ${targetX} ${targetY - verticalEase}, ${targetX} ${targetY}`,
  ].join(' ');
}

function connectionPreviewPath(connection: {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}): string {
  const { startX, startY, currentX, currentY } = connection;
  const horizontalDistance = Math.abs(currentX - startX);
  const verticalDistance = currentY - startY;
  if (verticalDistance >= 36) {
    const tension = Math.max(54, Math.min(180, verticalDistance * 0.42 + horizontalDistance * 0.08));
    return `M ${startX} ${startY} C ${startX} ${startY + tension}, ${currentX} ${currentY - tension}, ${currentX} ${currentY}`;
  }
  const direction = currentX >= startX ? 1 : -1;
  const sideX = direction > 0
    ? Math.max(startX, currentX) + Math.max(92, Math.min(150, horizontalDistance * 0.24 + 88))
    : Math.min(startX, currentX) - Math.max(92, Math.min(150, horizontalDistance * 0.24 + 88));
  const exitY = startY + 54;
  const entryY = currentY - 54;
  return [
    `M ${startX} ${startY}`,
    `C ${startX} ${startY + 30}, ${sideX} ${exitY - 20}, ${sideX} ${exitY}`,
    `C ${sideX} ${(exitY + entryY) / 2}, ${sideX} ${(exitY + entryY) / 2}, ${sideX} ${entryY}`,
    `C ${sideX} ${entryY + 20}, ${currentX} ${currentY - 30}, ${currentX} ${currentY}`,
  ].join(' ');
}

function rectsOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function segmentHitsFlowNode(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  node: SkillFlowCanvasNode,
  margin = 18,
) {
  const segmentRect = {
    left: Math.min(x1, x2) - margin,
    right: Math.max(x1, x2) + margin,
    top: Math.min(y1, y2) - margin,
    bottom: Math.max(y1, y2) + margin,
  };
  const nodeRect = {
    left: node.x,
    right: node.x + node.width,
    top: node.y,
    bottom: node.y + node.height,
  };
  return rectsOverlap(segmentRect, nodeRect);
}

function forwardRouteHitsNode(
  source: SkillFlowCanvasNode,
  target: SkillFlowCanvasNode,
  nodes: SkillFlowCanvasNode[],
  laneY: number,
) {
  const sourceX = source.x + source.width / 2;
  const sourceY = source.y + source.height + 8;
  const targetX = target.x + target.width / 2;
  const targetY = target.y - 8;
  const safeLaneY = Math.max(sourceY + 48, Math.min(targetY - 48, laneY));
  return nodes.some((node) => {
    if (node.nodeId === source.nodeId || node.nodeId === target.nodeId) return false;
    return segmentHitsFlowNode(sourceX, sourceY, sourceX, safeLaneY, node)
      || segmentHitsFlowNode(sourceX, safeLaneY, targetX, safeLaneY, node)
      || segmentHitsFlowNode(targetX, safeLaneY, targetX, targetY, node);
  });
}

function sideForwardLaneX(
  source: SkillFlowCanvasNode,
  target: SkillFlowCanvasNode,
  nodes: SkillFlowCanvasNode[],
  canvasWidth: number,
  siblingIndex: number,
  incomingIndex: number,
) {
  const sourceY = source.y + source.height + 8;
  const targetY = target.y - 8;
  const verticalTop = Math.min(sourceY, targetY);
  const verticalBottom = Math.max(sourceY, targetY);
  const relevantNodes = nodes.filter((node) => (
    node.nodeId !== source.nodeId
    && node.nodeId !== target.nodeId
    && node.y < verticalBottom + 80
    && node.y + node.height > verticalTop - 80
  ));
  const laneOffset = 76 + siblingIndex * 28 + incomingIndex * 18;
  const rightBoundary = Math.max(
    source.x + source.width,
    target.x + target.width,
    ...relevantNodes.map((node) => node.x + node.width),
  );
  const leftBoundary = Math.min(
    source.x,
    target.x,
    ...relevantNodes.map((node) => node.x),
  );
  const rightX = Math.min(canvasWidth - 74, rightBoundary + laneOffset);
  const leftX = Math.max(74, leftBoundary - laneOffset);
  const preferRight = target.x >= source.x;
  const candidates = preferRight ? [rightX, leftX] : [leftX, rightX];
  const clear = candidates.find((candidateX) => !relevantNodes.some((node) => (
    segmentHitsFlowNode(candidateX, sourceY + 34, candidateX, targetY - 34, node, 12)
  )));
  return clear ?? candidates[0];
}

function sideForwardFlowPath(
  source: SkillFlowCanvasNode,
  target: SkillFlowCanvasNode,
  nodes: SkillFlowCanvasNode[],
  canvasWidth: number,
  siblingIndex: number,
  incomingIndex: number,
): string {
  const sourceX = source.x + source.width / 2;
  const sourceY = source.y + source.height + 8;
  const targetX = target.x + target.width / 2;
  const targetY = target.y - 8;
  const sideX = sideForwardLaneX(source, target, nodes, canvasWidth, siblingIndex, incomingIndex);
  const exitY = sourceY + 54 + (siblingIndex % 2) * 18;
  const entryY = targetY - 54 - (incomingIndex % 2) * 18;
  return [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX} ${exitY - 24}, ${sideX} ${exitY - 24}, ${sideX} ${exitY}`,
    `C ${sideX} ${(exitY + entryY) / 2}, ${sideX} ${(exitY + entryY) / 2}, ${sideX} ${entryY}`,
    `C ${sideX} ${entryY + 24}, ${targetX} ${entryY + 24}, ${targetX} ${targetY}`,
  ].join(' ');
}

function sideForwardEdgeLabelPosition(
  source: SkillFlowCanvasNode,
  target: SkillFlowCanvasNode,
  nodes: SkillFlowCanvasNode[],
  canvasWidth: number,
  siblingIndex: number,
  incomingIndex: number,
) {
  const sourceY = source.y + source.height + 8;
  const targetY = target.y - 8;
  const sideX = sideForwardLaneX(source, target, nodes, canvasWidth, siblingIndex, incomingIndex);
  return {
    x: sideX,
    y: (sourceY + targetY) / 2,
  };
}

function forwardEdgeLabelPosition(
  sourceX: number,
  targetX: number,
  laneY: number,
  siblingIndex: number,
  siblingCount: number,
  incomingIndex: number,
  incomingCount: number,
) {
  const siblingOffset = siblingCount > 1 ? (siblingIndex - (siblingCount - 1) / 2) * 18 : 0;
  const incomingOffset = incomingCount > 1 ? (incomingIndex - (incomingCount - 1) / 2) * 28 : 0;
  const minX = Math.min(sourceX, targetX);
  const maxX = Math.max(sourceX, targetX);
  const midpoint = (sourceX + targetX) / 2;
  const hasHorizontalRoom = maxX - minX > 220;
  const x = hasHorizontalRoom
    ? Math.max(minX + 98, Math.min(maxX - 98, midpoint + siblingOffset + incomingOffset))
    : targetX + siblingOffset + incomingOffset;
  return { x, y: laneY };
}

function returnEdgeLabelPosition(
  source: SkillFlowCanvasNode,
  target: SkillFlowCanvasNode,
  canvasWidth: number,
  siblingIndex: number,
) {
  const sideX = Math.min(canvasWidth - 96, Math.max(source.x + source.width + 96 + siblingIndex * 30, target.x + target.width + 96));
  return {
    x: sideX,
    y: Math.max(72, target.y - 84 - siblingIndex * 18),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function flowLabelOverlapsNode(
  point: { x: number; y: number },
  node: Pick<SkillFlowCanvasNode, 'x' | 'y' | 'width' | 'height'>,
) {
  const labelWidth = 210;
  const labelHeight = 34;
  const margin = 22;
  const left = point.x - labelWidth / 2;
  const right = point.x + labelWidth / 2;
  const top = point.y - labelHeight / 2;
  const bottom = point.y + labelHeight / 2;
  return !(
    right < node.x - margin
    || left > node.x + node.width + margin
    || bottom < node.y - margin
    || top > node.y + node.height + margin
  );
}

function avoidFlowLabelOverlap(
  anchor: { x: number; y: number },
  nodes: SkillFlowCanvasNode[],
  canvasWidth: number,
  canvasHeight: number,
) {
  const clampPoint = (point: { x: number; y: number }) => ({
    x: clampNumber(point.x, 112, canvasWidth - 112),
    y: clampNumber(point.y, 34, canvasHeight - 34),
  });
  const fits = (point: { x: number; y: number }) => !nodes.some((node) => flowLabelOverlapsNode(point, node));
  const base = clampPoint(anchor);
  if (fits(base)) return base;
  const candidates: Array<{ x: number; y: number }> = [];
  [48, 84, 122, 168, 216].forEach((offset) => {
    candidates.push(
      { x: anchor.x, y: anchor.y - offset },
      { x: anchor.x, y: anchor.y + offset },
      { x: anchor.x - offset * 1.4, y: anchor.y },
      { x: anchor.x + offset * 1.4, y: anchor.y },
      { x: anchor.x - offset, y: anchor.y - offset },
      { x: anchor.x + offset, y: anchor.y - offset },
      { x: anchor.x - offset, y: anchor.y + offset },
      { x: anchor.x + offset, y: anchor.y + offset },
    );
  });
  const found = candidates.map(clampPoint).find(fits);
  return found || clampPoint({ x: anchor.x, y: anchor.y - 76 });
}

function sideReturnFlowPath(
  source: SkillFlowCanvasNode,
  target: SkillFlowCanvasNode,
  canvasWidth: number,
  siblingIndex: number,
): string {
  const sourceX = source.x + source.width / 2;
  const sourceY = source.y + source.height + 8;
  const targetX = target.x + target.width / 2;
  const targetY = target.y - 8;
  const sideX = Math.min(canvasWidth - 54, Math.max(source.x + source.width + 70 + siblingIndex * 28, target.x + target.width + 70));
  const bottomY = sourceY + 64;
  const topY = Math.max(44, targetY - 64);
  return [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX} ${bottomY}, ${sideX} ${bottomY}, ${sideX} ${bottomY}`,
    `C ${sideX} ${bottomY}, ${sideX} ${topY}, ${sideX} ${topY}`,
    `C ${sideX} ${topY}, ${targetX} ${topY}, ${targetX} ${targetY}`,
  ].join(' ');
}

function incomingEdgeLabel(edge: Record<string, unknown>, nodeNameMap: Record<string, string> = {}): string {
  const source = String(edge.source_node_id || '');
  const sourceName = source && nodeNameMap[source] ? nodeNameMap[source] : source;
  const targetName = edgeTargetName(edge, nodeNameMap);
  const label = String(edge.label || '');
  const condition = conditionNaturalText(String(edge.condition || ''));
  const route = [sourceName, targetName].filter(Boolean).join(' -> ');
  const detail = label && condition ? `${label}（${condition}）` : label || condition;
  if (route && detail) return `${route}：${detail}`;
  if (route) return route;
  return detail || '流转';
}

function edgeDisplayLabel(edge: Record<string, unknown>, nodeNameMap: Record<string, string> = {}): string {
  const label = String(edge.label || '').trim();
  if (label) return label;
  const condition = conditionNaturalText(String(edge.condition || '')).trim();
  if (condition) return condition;
  const source = String(edge.source_node_id || '');
  const sourceName = source && nodeNameMap[source] ? nodeNameMap[source] : source;
  return sourceName ? `来自 ${sourceName}` : '流转';
}

function normalizedEdgeLabel(edge: Record<string, unknown>, nodeNameMap: Record<string, string> = {}): string {
  return edgeDisplayLabel(edge, nodeNameMap).replace(/\s+/g, ' ').trim() || '流转';
}

function edgeTargetName(edge: Record<string, unknown>, nodeNameMap: Record<string, string> = {}): string {
  const targetId = String(edge.next_node_id || '').trim();
  return targetId ? nodeNameMap[targetId] || targetId : '';
}

function hasDuplicateSiblingEdgeLabel(
  edge: Record<string, unknown>,
  siblings: Array<Record<string, unknown>>,
  nodeNameMap: Record<string, string> = {},
): boolean {
  if (siblings.length <= 1) return false;
  const sourceId = String(edge.source_node_id || '').trim();
  const label = normalizedEdgeLabel(edge, nodeNameMap);
  return siblings.filter((item) => (
    String(item.source_node_id || '').trim() === sourceId
    && normalizedEdgeLabel(item, nodeNameMap) === label
  )).length > 1;
}

function hasDuplicateOutgoingEdgeLabel(
  edges: Array<Record<string, unknown>>,
  nodeNameMap: Record<string, string> = {},
): boolean {
  if (edges.length <= 1) return false;
  const labelCounts = edges.reduce<Record<string, number>>((acc, edge) => {
    const label = normalizedEdgeLabel(edge, nodeNameMap);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  return Object.values(labelCounts).some((count) => count > 1);
}

function outgoingRouteCountLabel(edges: Array<Record<string, unknown>>): string {
  return `${edges.length} 条${hasDuplicateOutgoingEdgeLabel(edges) ? '并行' : ''}流转`;
}

function flowEdgeDisplayLabel(
  edge: Record<string, unknown>,
  nodeNameMap: Record<string, string> = {},
  siblingCount = 1,
  hasDuplicateSourceLabel = false,
): string {
  const label = normalizedEdgeLabel(edge, nodeNameMap);
  const targetName = edgeTargetName(edge, nodeNameMap);
  if (hasDuplicateSourceLabel && targetName) {
    return `并行执行 · ${targetName}`;
  }
  const hasExplicitLabel = Boolean(String(edge.label || '').trim() || String(edge.condition || '').trim());
  if (siblingCount > 1 && targetName && (hasDuplicateSourceLabel || !hasExplicitLabel)) {
    return `${label} · 到${targetName}`;
  }
  return label;
}

function sourceEdgeSummary(
  edge: Record<string, unknown>,
  nodeNameMap: Record<string, string> = {},
  index = 0,
  siblingEdges: Array<Record<string, unknown>> = [],
): string {
  const targetName = edgeTargetName(edge, nodeNameMap) || '未指定节点';
  const label = String(edge.label || '').trim();
  const condition = conditionNaturalText(String(edge.condition || '')).trim();
  const hasPriority = edge.priority !== undefined && edge.priority !== null && String(edge.priority).trim() !== '';
  const priority = hasPriority && typeof edge.priority === 'number' ? edge.priority : hasPriority && Number.isFinite(Number(edge.priority)) ? Number(edge.priority) : index;
  const prefix = label || condition;
  const parallelText = hasDuplicateSiblingEdgeLabel(edge, siblingEdges, nodeNameMap) ? '并行执行 · ' : '';
  const priorityText = hasPriority && Number.isFinite(priority) ? ` · 优先级 ${priority}` : '';
  return `${parallelText}${prefix ? `${prefix} -> ` : ''}${targetName}${priorityText}`;
}

function compactEdgeLabel(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= 24) return text;
  return `${text.slice(0, 21)}...`;
}

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_OPTIONS.find((item) => item.value === type)?.label || type || '节点';
}

function knowledgeScopeLabels(value: unknown): string[] {
  if (!isRecord(value) || Object.keys(value).length === 0) return [];
  return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`);
}

function compactInputStyle(value: string, minCh = 8, maxCh = 92): CSSProperties {
  const longestLine = String(value || '').split('\n').reduce((max, line) => Math.max(max, visualTextWidth(line)), 0);
  const width = Math.max(minCh, Math.min(maxCh, longestLine + 2));
  return { width: `min(${width}ch, 100%)` };
}

function visualTextWidth(value: string): number {
  return Array.from(value).reduce((total, char) => {
    if (/[\u2e80-\u9fff\uff00-\uffef]/.test(char)) return total + 2;
    return total + 1;
  }, 0);
}

function sourceInputStyle(value: string, multiline = false): CSSProperties {
  const longestLine = String(value || '').split('\n').reduce((max, line) => Math.max(max, visualTextWidth(line)), 0);
  const minCh = multiline ? 34 : 18;
  const maxCh = multiline ? 96 : 72;
  const width = Math.max(minCh, Math.min(maxCh, longestLine + 4));
  return { width: `min(${width}ch, 100%)`, maxWidth: '100%' };
}

function previewSourceText(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return '暂无节点说明';
  return text.length > 96 ? `${text.slice(0, 96)}...` : text;
}

function EditableSourceHeading({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <EditableSourceField>
      <SourceInput
        className={SOURCE_TITLE_INPUT_CLASS}
        style={compactInputStyle(value, 10, 56)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </EditableSourceField>
  );
}

function EditableSourceStepHeading({
  index,
  value,
  fallback,
  onChange,
}: {
  index: number;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  return (
    <EditableSourceField>
      <div className={SOURCE_STEP_TITLE_EDIT_CLASS}>
        <span>Node {index + 1}:</span>
        <SourceInput
          value={value}
          placeholder={fallback}
          style={compactInputStyle(value || fallback, 10, 88)}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </EditableSourceField>
  );
}

function EditableSourceTextLine({
  label,
  value,
  multiline = false,
  collapsible = false,
  readOnly = false,
  onChange,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  collapsible?: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const canCollapse = collapsible && multiline;
  const shouldStartCollapsed = canCollapse && value.trim().length > 90;
  const [collapsed, setCollapsed] = useState(shouldStartCollapsed);

  useEffect(() => {
    if (!canCollapse || value.trim().length <= 90) {
      setCollapsed(false);
    }
  }, [canCollapse, value]);

  return (
    <div className={cn(SOURCE_LINE_CLASS, canCollapse && "collapsible")}>
      <span className={SOURCE_KEY_CLASS}>{label}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          {canCollapse ? (
            <div className={SOURCE_COLLAPSIBLE_EDITOR_CLASS}>
              <button
                type="button"
                className={SOURCE_COLLAPSIBLE_HEAD_CLASS}
                onClick={() => setCollapsed((current) => !current)}
              >
                <span {...(collapsed && value.trim() ? USER_CONTENT_ATTRIBUTES : {})} className={cn(SOURCE_COLLAPSIBLE_PREVIEW_CLASS, !collapsed && SOURCE_COLLAPSIBLE_PREVIEW_MUTED_CLASS)}>
                  {collapsed ? previewSourceText(value) : '正在编辑节点说明'}
                </span>
                <span className={SOURCE_COLLAPSIBLE_TOGGLE_CLASS}>
                  {collapsed ? <RightOutlined /> : <DownOutlined />}
                  {collapsed ? '展开' : '收起'}
                </span>
              </button>
              {!collapsed && (
                <AutoGrowTextarea
                  className={SOURCE_EDIT_INPUT_CLASS}
                  value={value}
                  style={sourceInputStyle(value, true)}
                  minRows={3}
                  readOnly={readOnly}
                  onChange={(event) => {
                    if (!readOnly) onChange(event.target.value);
                  }}
                />
              )}
            </div>
          ) : multiline ? (
            <AutoGrowTextarea
              className={SOURCE_EDIT_INPUT_CLASS}
              value={value}
              style={sourceInputStyle(value, true)}
              minRows={2}
              readOnly={readOnly}
              onChange={(event) => {
                if (!readOnly) onChange(event.target.value);
              }}
            />
          ) : (
            <SourceInput
              className={SOURCE_EDIT_INPUT_CLASS}
              value={value}
              style={sourceInputStyle(value)}
              readOnly={readOnly}
              onChange={(event) => {
                if (!readOnly) onChange(event.target.value);
              }}
            />
          )}
        </EditableSourceField>
      </span>
    </div>
  );
}

function EditableSourceNumberLine({
  label,
  value,
  min,
  max,
  placeholder,
  onChange,
}: {
  label: string;
  value?: number | null;
  min: number;
  max: number;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>{label}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <SourceInput
            className={SOURCE_EDIT_INPUT_CLASS}
            type="number"
            min={min}
            max={max}
            step={1}
            value={value == null ? '' : String(value)}
            placeholder={placeholder}
            style={sourceInputStyle(value == null ? '' : String(value))}
            onChange={(event) => {
              if (!event.target.value.trim()) {
                onChange(null);
                return;
              }
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                onChange(Math.max(min, Math.min(max, Math.round(next))));
              }
            }}
          />
        </EditableSourceField>
      </span>
    </div>
  );
}

function EditableSourceListLine({
  label,
  values = [],
  minRows = 1,
  maxRows,
  onChange,
}: {
  label: string;
  values: string[];
  minRows?: number;
  maxRows?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>{label}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <AutoGrowTextarea
            className={SOURCE_EDIT_INPUT_CLASS}
            value={values.join('\n')}
            style={sourceInputStyle(values.join('\n'), true)}
            minRows={minRows}
            maxRows={maxRows}
            onChange={(event) => onChange(event.target.value)}
          />
        </EditableSourceField>
      </span>
    </div>
  );
}

function EditableSourceSelectLine({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const mergedOptions = options.some((option) => option.value === value) || !value
    ? options
    : [...options, { value, label: value }];
  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>{label}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <SourceSelect
            className={cn(SOURCE_SELECT_CLASS, "w-[220px]")}
            value={value}
            options={mergedOptions}
            onChange={onChange}
          />
        </EditableSourceField>
      </span>
    </div>
  );
}

function EditableConditionLine({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const presetValue = conditionPresetValue(value);
  const naturalValue = conditionNaturalText(value);
  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>{fieldLabel('condition')}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <div className={CONDITION_EDITOR_CLASS}>
            <SourceSelect
              className={CONDITION_PRESET_CLASS}
              value={presetValue}
              options={CONDITION_PRESET_OPTIONS}
              onChange={(nextValue) => {
                if (nextValue === '__custom__') {
                  onChange(naturalValue);
                  return;
                }
                onChange(conditionFromPreset(nextValue));
              }}
            />
            <AutoGrowTextarea
              className={cn(SOURCE_EDIT_INPUT_CLASS, CONDITION_INPUT_CLASS)}
              value={naturalValue}
              placeholder="用一句话描述什么时候进入，例如：用户已经提供商品名称后进入"
              minRows={1}
              onChange={(event) => onChange(event.target.value)}
            />
            <span className={CONDITION_READABLE_CLASS}>{conditionReadableText(value)}</span>
          </div>
        </EditableSourceField>
      </span>
    </div>
  );
}

function SourceReadonlyLine({ label, value, staticLabels = false }: { label: string; value: string; staticLabels?: boolean }) {
  return (
    <div className={cn(SOURCE_LINE_CLASS, "readonly")}>
      <span className={SOURCE_KEY_CLASS}>{label}</span>
      <span {...(staticLabels ? {} : USER_CONTENT_ATTRIBUTES)} className={cn(SOURCE_VALUE_CLASS, SOURCE_READONLY_VALUE_CLASS)}>
        {staticLabels ? value.split(' · ').map((item, index) => <span key={item}>{index > 0 ? ' · ' : ''}<span>{item}</span></span>) : value || '-'}
      </span>
    </div>
  );
}

function SourceJsonLine({ label, value }: { label: string; value: unknown }) {
  if (!hasReadableSourceObject(value)) return null;
  return (
    <div className={cn(SOURCE_LINE_CLASS, "readonly")}>
      <span className={SOURCE_KEY_CLASS}>{label}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <pre className={SOURCE_JSON_INLINE_CLASS}>{JSON.stringify(value, null, 2)}</pre>
      </span>
    </div>
  );
}

function EditableRetryPolicyLine({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const policy = isRecord(value) ? value : {};
  const attemptKey = Object.prototype.hasOwnProperty.call(policy, 'max_retries') ? 'max_retries' : 'max_attempts';
  const strategyKey = Object.prototype.hasOwnProperty.call(policy, 'strategy') ? 'strategy' : 'on_failure';
  const messageKey = Object.prototype.hasOwnProperty.call(policy, 'message') ? 'message' : 'retry_message';
  const maxAttempts = retryPolicyNumber(policy.max_retries ?? policy.max_attempts);
  const strategy = retryPolicyString(policy.strategy ?? policy.on_failure);
  const retryMessage = retryPolicyString(policy.retry_message ?? policy.message);
  const strategyOptions = mergeSelectOptions(
    RETRY_STRATEGY_OPTIONS,
    strategy ? [{ value: strategy, label: retryStrategyLabel(strategy) }] : [],
  );

  function commit(patch: Record<string, unknown>) {
    const next = { ...policy, ...patch };
    Object.keys(next).forEach((key) => {
      if (next[key] === '' || next[key] === null || next[key] === undefined) delete next[key];
    });
    onChange(next);
  }

  function updateAttempts(nextValue: number | string | null) {
    const nextNumber = Number(nextValue);
    commit(Number.isFinite(nextNumber) && nextNumber > 0
      ? { [attemptKey]: Math.floor(nextNumber) }
      : { max_attempts: undefined, max_retries: undefined });
  }

  function updateStrategy(nextValue?: string) {
    commit(nextValue ? { [strategyKey]: nextValue } : { on_failure: undefined, strategy: undefined });
  }

  function updateMessage(nextValue: string) {
    commit(nextValue.trim() ? { [messageKey]: nextValue } : { retry_message: undefined, message: undefined });
  }

  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>重试策略</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <div className={RETRY_POLICY_EDITOR_CLASS}>
            <label className={RETRY_POLICY_FIELD_CLASS}>
              <span>最多重试</span>
              <SourceNumberInput
                min={0}
                value={maxAttempts}
                placeholder="不限制"
                onChange={updateAttempts}
              />
            </label>
            <label className={RETRY_POLICY_FIELD_CLASS}>
              <span>失败后</span>
              <SourceSelect
                value={strategy || undefined}
                options={strategyOptions}
                placeholder="选择处理方式"
                onChange={(nextValue) => updateStrategy(nextValue)}
              />
            </label>
            <label className={RETRY_POLICY_FIELD_CLASS}>
              <span>追问文案</span>
              <SourceInput
                value={retryMessage}
                placeholder="例如：请补充需要校验的报文内容。"
                onChange={(event) => updateMessage(event.target.value)}
              />
            </label>
          </div>
        </EditableSourceField>
      </span>
    </div>
  );
}

function retryPolicyNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : null;
}

function retryPolicyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function retryStrategyLabel(value: string): string {
  return RETRY_STRATEGY_OPTIONS.find((item) => item.value === value)?.label || value;
}

function hasReadableSourceObject(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).length > 0;
}

function EditableSourceActionLine({
  values,
  options,
  toolDescriptions,
  toolStatuses,
  onChange,
}: {
  values: string[];
  options: SelectOption[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
  onChange: (value: string) => void;
}) {
  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>{fieldLabel('allowed_actions')}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <EditableActionList
            actions={values}
            options={options}
            toolDescriptions={toolDescriptions}
            toolStatuses={toolStatuses}
            onChange={onChange}
          />
        </EditableSourceField>
      </span>
    </div>
  );
}

export function EditableCapabilityReferencesLine({
  label,
  values,
  requiredValues,
  options,
  emptyText,
  onChange,
  onRequiredChange,
}: {
  label: string;
  values: string[];
  requiredValues: string[];
  options: CapabilityReferenceOption[];
  emptyText: string;
  onChange: (value: string[]) => void;
  onRequiredChange: (value: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const selectedValues = new Set(values);
  const mergedOptions = mergeCapabilityReferenceOptions(
    options.filter((option) => !option.unavailableReason || selectedValues.has(option.value)),
    values,
  );
  const selected = new Set(values);
  const required = new Set(requiredValues);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = mergedOptions
    .filter((option) => {
      if (!normalizedQuery) return true;
      return [option.label, option.value, option.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((left, right) => Number(selected.has(right.value)) - Number(selected.has(left.value)));

  function toggle(value: string, checked: boolean) {
    if (checked) {
      onChange(Array.from(new Set([...values, value])));
      return;
    }
    onChange(values.filter((item) => item !== value));
  }

  function setRequired(value: string, checked: boolean) {
    if (checked) {
      onRequiredChange(Array.from(new Set([...requiredValues, value])));
      return;
    }
    onRequiredChange(requiredValues.filter((item) => item !== value));
  }

  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>{label}</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-h-[34px] w-full items-center justify-between gap-[10px] rounded-[8px] border border-[#dfe3eb] bg-white px-[10px] py-[6px] text-left outline-none transition-colors hover:border-[#c7cedc] focus-visible:border-[#1a71ff] focus-visible:ring-2 focus-visible:ring-[#1a71ff]/15"
              >
                <span className="flex min-w-0 flex-1 flex-wrap gap-[5px]">
                  {values.length === 0 ? (
                    <span className="text-[12px] text-[#a0a7b8]">{emptyText}</span>
                  ) : (
                    values.map((value) => {
                      const option = mergedOptions.find((item) => item.value === value);
                      return (
                        <span
                          key={value}
                          {...USER_CONTENT_TITLE_ATTRIBUTES}
                          title={option?.label || value}
                          className={cn(
                            'inline-flex max-w-[200px] items-center gap-[5px] rounded-full px-[8px] py-[3px] text-[11px]',
                            required.has(value)
                              ? 'bg-[#fff1dc] text-[#9a5a00]'
                              : 'bg-[#eef3fb] text-[#464c5e]',
                          )}
                        >
                          <span {...USER_CONTENT_ATTRIBUTES} className="truncate">{option?.label || value}</span>
                          <span className="shrink-0 text-[9px] opacity-75">
                            {required.has(value) ? '强制' : '可选'}
                          </span>
                        </span>
                      );
                    })
                  )}
                </span>
                <span className="shrink-0 text-[11px] text-[#1a71ff]">
                  {values.length > 0 ? `已选择 ${values.length} 个` : '选择'}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="z-[130] w-[min(420px,calc(100vw-32px))] p-0">
              <div className="border-b border-[#eceef1] p-[10px]">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`搜索${label}`}
                  className="h-[32px]"
                />
              </div>
              <div className="max-h-[300px] overflow-y-auto p-[6px]">
                {filteredOptions.length === 0 ? (
                  <div className="px-[10px] py-[24px] text-center text-[12px] text-[#858b9c]">暂无可选能力</div>
                ) : (
                  filteredOptions.map((option) => {
                    const checked = selected.has(option.value);
                    const disabled = Boolean(option.unavailableReason) && !checked;
                    return (
                      <div
                        key={option.value}
                        className={cn(
                          'flex items-start gap-[10px] rounded-[8px] px-[9px] py-[8px]',
                          disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-[#f6f8fb]',
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={disabled}
                          className="mt-[2px]"
                          onCheckedChange={(next) => toggle(option.value, next === true)}
                          aria-label={`${checked ? '取消选择' : '选择'} ${option.label}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 flex-wrap items-center gap-[6px]">
                            <strong {...USER_CONTENT_ATTRIBUTES} className="truncate text-[12px] font-medium text-[#18181a]">{option.label}</strong>
                            <CapabilityScopeBadge value={option.capabilityScope} />
                            {option.unavailableReason && (
                              <span className="text-[10px] text-[#d20b0b]">{option.unavailableReason}</span>
                            )}
                          </span>
                          <span {...USER_CONTENT_ATTRIBUTES} className="mt-[2px] block truncate text-[11px] text-[#858b9c]">
                            {option.description || option.value}
                          </span>
                        </span>
                        {checked && (
                          <span className="inline-flex shrink-0 rounded-[7px] bg-[#f0f2f6] p-[2px] text-[10px]">
                            <button
                              type="button"
                              className={cn(
                                'rounded-[5px] px-[7px] py-[3px] transition-colors',
                                !required.has(option.value)
                                  ? 'bg-white text-[#1a71ff] shadow-sm'
                                  : 'text-[#7c8495] hover:text-[#464c5e]',
                              )}
                              onClick={() => setRequired(option.value, false)}
                            >
                              可选执行
                            </button>
                            <button
                              type="button"
                              className={cn(
                                'rounded-[5px] px-[7px] py-[3px] transition-colors',
                                required.has(option.value)
                                  ? 'bg-[#fff7e8] text-[#a45f00] shadow-sm'
                                  : 'text-[#7c8495] hover:text-[#464c5e]',
                              )}
                              onClick={() => setRequired(option.value, true)}
                            >
                              强制执行
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              <div className="border-t border-[#eceef1] px-[12px] py-[8px] text-[11px] leading-[1.45] text-[#858b9c]">
                通用能力始终可由模型自主选择；仅限 SOP 的能力需在当前节点选择。标记为强制执行后，成功调用才允许推进节点。
              </div>
            </PopoverContent>
          </Popover>
        </EditableSourceField>
      </span>
    </div>
  );
}

function mergeCapabilityReferenceOptions(
  options: CapabilityReferenceOption[],
  values: string[],
): CapabilityReferenceOption[] {
  const existing = new Set(options.map((option) => option.value));
  return [
    ...options,
    ...values
      .filter((value) => !existing.has(value))
      .map((value) => ({
        value,
        label: value,
        description: '资源当前不可用，可取消引用',
        unavailableReason: '资源不可用',
      })),
  ];
}

function EditableActionList({
  actions,
  options,
  toolDescriptions,
  toolStatuses,
  onChange,
}: {
  actions: string[];
  options: SelectOption[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
  onChange: (value: string) => void;
}) {
  const { notify } = useDistillPageHost();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const mergedOptions = mergeSelectOptions(options, actions.map((action) => ({
    value: action,
    label: actionLabel(action),
  })));

  function writeActions(nextActions: string[]) {
    onChange(nextActions.filter(Boolean).join('\n'));
  }

  function commitAction(index: number, action: string) {
    const nextAction = action.trim();
    const next = [...actions];
    if (!nextAction) {
      if (index < next.length) next.splice(index, 1);
      writeActions(next);
      setEditingIndex(null);
      return;
    }
    const duplicateIndex = next.findIndex((item, itemIndex) => item === nextAction && itemIndex !== index);
    if (duplicateIndex >= 0) {
      notify.info('这个动作已经添加过了');
      setEditingIndex(null);
      return;
    }
    if (index >= next.length) {
      next.push(nextAction);
    } else {
      next[index] = nextAction;
    }
    writeActions(next);
    setEditingIndex(null);
  }

  function removeAction(index: number) {
    const next = [...actions];
    next.splice(index, 1);
    writeActions(next);
    if (editingIndex === index) setEditingIndex(null);
  }

  function actionSelect(index: number, value?: string) {
    return (
      <ActionCombobox
        value={value || undefined}
        options={mergedOptions}
        placeholder="选择一个动作"
        onSelect={(nextValue) => commitAction(index, String(nextValue || ''))}
      />
    );
  }

  return (
    <div className={cn(SOURCE_ACTION_EDITOR_CLASS, "group/action-editor")}>
      <div className={cn(SOURCE_ACTION_LIST_CLASS, SOURCE_ACTION_LIST_EDITABLE_CLASS)}>
        {actions.map((action, index) => (
          editingIndex === index ? (
            <span className={SOURCE_ACTION_PICKER_CLASS} key={`editing_${index}`}>
              {actionSelect(index, action)}
            </span>
          ) : (
            <span className={cn(SOURCE_ACTION_TOKEN_CLASS, "group/token")} key={`${action}_${index}`}>
              <button
                type="button"
                className={SOURCE_ACTION_EDIT_BUTTON_CLASS}
                onClick={() => setEditingIndex(index)}
              >
                <ActionChip action={action} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} editable />
              </button>
              <button type="button" className={SOURCE_ACTION_REMOVE_CLASS} onClick={() => removeAction(index)} aria-label={`移除 ${actionLabel(action)}`}>
                <CloseOutlined />
              </button>
            </span>
          )
        ))}
        {editingIndex !== null && editingIndex >= actions.length && (
          <span className={SOURCE_ACTION_PICKER_CLASS}>
            {actionSelect(editingIndex)}
          </span>
        )}
        {actions.length === 0 && editingIndex === null && (
          <div className={SOURCE_ACTION_EMPTY_CLASS}>
            <span>当前节点还没有允许动作</span>
            <button type="button" className={SOURCE_ACTION_ADD_CLASS} onClick={() => setEditingIndex(0)}>
              <PlusOutlined />
              添加动作
            </button>
          </div>
        )}
        {actions.length > 0 && editingIndex === null && (
          <button type="button" className={SOURCE_ACTION_ADD_CLASS} onClick={() => setEditingIndex(actions.length)}>
            <PlusOutlined />
            新增动作
          </button>
        )}
      </div>
      <span className={SOURCE_EDIT_HINT_CLASS}>每次新增一个动作；点击已有动作可重新选择。</span>
    </div>
  );
}

function EditableFlowRulesLine({
  sourceNodeId,
  edges,
  nodes,
  nodeOptions,
  terminal,
  onAdd,
  onUpdate,
  onDelete,
}: {
  sourceNodeId: string;
  edges: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
  nodeOptions: SelectOption[];
  terminal: boolean;
  onAdd: () => void;
  onUpdate: (edgeIndex: number, patch: Record<string, unknown>) => void;
  onDelete: (edgeIndex: number) => void;
}) {
  const orderedEdges = edges
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => edgePriority(a.edge, a.index) - edgePriority(b.edge, b.index));
  return (
    <div className={SOURCE_LINE_CLASS}>
      <span className={SOURCE_KEY_CLASS}>流转规则</span>
      <span className={SOURCE_VALUE_CLASS}>
        <EditableSourceField>
          <div className={FLOW_RULE_EDITOR_CLASS}>
            <div className={FLOW_RULE_HEAD_CLASS}>
              <span>从 {nodeDisplayNameById(nodes, sourceNodeId)} 出发</span>
              <UIButton variant="outline" size="sm" className={PILL_OUTLINE_BUTTON_CLASS} onClick={onAdd}>
                <PlusOutlined />
                新增规则
              </UIButton>
            </div>
            {orderedEdges.length === 0 ? (
              <div className={FLOW_RULE_EMPTY_CLASS}>{terminal ? '当前节点是终止节点，默认流程结束。' : '还没有后续节点，请新增流转规则。'}</div>
            ) : (
              <div className={FLOW_RULE_LIST_CLASS}>
                {orderedEdges.map(({ edge, index }) => (
                  <div className={FLOW_RULE_ITEM_CLASS} key={`${String(edge.next_node_id)}_${index}`}>
                    <label className={cn(FLOW_RULE_FIELD_CLASS, FLOW_RULE_FIELD_TARGET_CLASS)}>
                      <span>目标 Node</span>
                      <SourceSelect
                        className={FLOW_RULE_TARGET_CLASS}
                        value={String(edge.next_node_id || '') || undefined}
                        options={nodeOptions}
                        placeholder="选择目标 Node"
                        onChange={(value) => onUpdate(index, { next_node_id: value })}
                      />
                    </label>
                    <label className={cn(FLOW_RULE_FIELD_CLASS, FLOW_RULE_FIELD_LABEL_CLASS)}>
                      <span>规则名称</span>
                      <SourceInput
                        className={FLOW_RULE_LABEL_INPUT_CLASS}
                        value={String(edge.label || '')}
                        placeholder="例如：信息完整后继续"
                        onChange={(event) => onUpdate(index, { label: event.target.value })}
                      />
                    </label>
                    <div className={cn(FLOW_RULE_FIELD_CLASS, FLOW_RULE_FIELD_CONDITION_CLASS)}>
                      <span>进入条件</span>
                      <div className={FLOW_RULE_CONDITION_CONTROLS_CLASS}>
                        <SourceSelect
                          className={CONDITION_PRESET_CLASS}
                          value={conditionPresetValue(String(edge.condition || ''))}
                          options={CONDITION_PRESET_OPTIONS}
                          onChange={(nextValue) => {
                            if (nextValue === '__custom__') {
                              onUpdate(index, { condition: conditionNaturalText(String(edge.condition || '')) });
                              return;
                            }
                            onUpdate(index, { condition: conditionFromPreset(nextValue) });
                          }}
                        />
                        <AutoGrowTextarea
                          className={FLOW_RULE_CONDITION_INPUT_CLASS}
                          value={conditionNaturalText(String(edge.condition || ''))}
                          placeholder="用一句话描述，例如：报文已获取后进入"
                          minRows={1}
                          onChange={(event) => onUpdate(index, { condition: event.target.value })}
                        />
                      </div>
                      <em>{flowRuleConditionText(String(edge.condition || ''))}</em>
                    </div>
                    <label className={cn(FLOW_RULE_FIELD_CLASS, FLOW_RULE_FIELD_PRIORITY_CLASS)}>
                      <span>优先级</span>
                      <SourceNumberInput
                        className={FLOW_RULE_PRIORITY_CLASS}
                        min={0}
                        value={edgePriority(edge, index)}
                        onChange={(value) => onUpdate(index, { priority: Number(value ?? 0) })}
                      />
                    </label>
                    <UIButton variant="destructive" size="icon" className={FLOW_RULE_DELETE_CLASS} onClick={() => onDelete(index)}>
                      <DeleteOutlined />
                    </UIButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        </EditableSourceField>
      </span>
    </div>
  );
}

function EditableSourceField({ children }: { children: ReactNode }) {
  function stop(event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
  }

  return (
    <div className={SOURCE_EDIT_FIELD_CLASS} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onKeyDown={stop}>
      {children}
    </div>
  );
}

function SelectableTarget({
  className,
  target,
  onToggle,
  children,
}: {
  className: string;
  target: TargetSelection;
  onToggle: (target: TargetSelection) => void;
  children: ReactNode;
}) {
  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (hasSelectedText()) {
      event.preventDefault();
      return;
    }
    onToggle(target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle(target);
  }

  return (
    <div role="button" tabIndex={0} className={className} onClick={handleClick} onKeyDown={handleKeyDown}>
      {children}
    </div>
  );
}

function ActionDiffList({
  diff,
  currentActions,
  toolDescriptions,
  toolStatuses,
}: {
  diff: TextDiffAnimation;
  currentActions: string[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
}) {
  const oldActions = actionsFromDiffText(diffFullOldValue(diff));
  const newActions = actionsFromDiffText(diffFullNewValue(diff));
  const visibleActions = currentActions.length > 0 ? currentActions : newActions;
  const inserted = new Set(newActions.filter((action) => !oldActions.includes(action)));
  const removed = oldActions.filter((action) => !newActions.includes(action));
  const phaseClass = diff.phase === 'mark' ? 'marked' : diff.phase === 'type' ? 'typing' : 'settled';
  if (visibleActions.length === 0 && removed.length === 0) return <span className={ACTION_EMPTY_CLASS}>-</span>;
  return (
    <div className={ACTION_LIST_CLASS}>
      {removed.map((action, index) => (
        <ActionChip
          action={action}
          toolDescriptions={toolDescriptions}
          toolStatuses={toolStatuses}
          className="removed"
          key={`removed_${action}_${index}`}
        />
      ))}
      {visibleActions.map((action, index) => (
        <ActionChip
          action={action}
          toolDescriptions={toolDescriptions}
          toolStatuses={toolStatuses}
          className={inserted.has(action) ? `added ${phaseClass}` : ''}
          key={`${action}_${index}`}
        />
      ))}
    </div>
  );
}

function ActionList({
  actions,
  toolDescriptions,
  toolStatuses,
}: {
  actions: string[];
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
}) {
  if (actions.length === 0) return <span className={ACTION_EMPTY_CLASS}>-</span>;
  return (
    <div className={ACTION_LIST_CLASS}>
      {actions.map((action, index) => (
        <ActionChip
          action={action}
          toolDescriptions={toolDescriptions}
          toolStatuses={toolStatuses}
          key={`${action}_${index}`}
        />
      ))}
    </div>
  );
}

function ActionChip({
  action,
  toolDescriptions,
  toolStatuses,
  className = '',
  editable = false,
}: {
  action: string;
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
  className?: string;
  editable?: boolean;
}) {
  const toolName = toolNameFromAction(action);
  const description = toolName ? toolDescriptions[toolName] || '当前工具配置中暂无描述' : '';
  const status = toolName ? toolStatuses[toolName] || 'incomplete' : '';
  const variant = className.includes('removed')
    ? 'removed'
    : className.includes('added')
      ? className.includes('typing')
        ? 'typing'
        : className.includes('settled')
          ? 'settled'
          : 'added'
      : undefined;

  return (
    <span
      className={cn(actionChipClass({ toolName: toolName || undefined, status, variant }), editable && 'pr-[26px]')}
      {...(toolName && toolDescriptions[toolName] ? USER_CONTENT_TITLE_ATTRIBUTES : {})}
      title={description || undefined}
    >
      {actionLabel(action)}
    </span>
  );
}

function SaveReviewDiffValue({
  diff,
  toolDescriptions,
  toolStatuses,
}: {
  diff: TextDiffAnimation;
  toolDescriptions: ToolDescriptionMap;
  toolStatuses: ToolStatusMap;
}) {
  if (diff.field === 'allowed_actions') {
    const removedActions = actionsFromDiffText(diffFullOldValue(diff));
    const insertedActions = actionsFromDiffText(diffFullNewValue(diff));
    return (
      <>
        {diff.removed && (
          <div className={cn(SAVE_REVIEW_ACTION_DIFF_CLASS, SAVE_REVIEW_ACTION_DIFF_OLD_CLASS)}>
            <span className={cn(SAVE_REVIEW_DIFF_SIGN_CLASS, SAVE_REVIEW_DIFF_SIGN_OLD_CLASS)}>-</span>
            <ActionList actions={removedActions} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} />
          </div>
        )}
        {diff.inserted && (
          <div className={cn(SAVE_REVIEW_ACTION_DIFF_CLASS, SAVE_REVIEW_ACTION_DIFF_NEW_CLASS)}>
            <span className={cn(SAVE_REVIEW_DIFF_SIGN_CLASS, SAVE_REVIEW_DIFF_SIGN_NEW_CLASS)}>+</span>
            <ActionList actions={insertedActions} toolDescriptions={toolDescriptions} toolStatuses={toolStatuses} />
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {diff.removed && <div><span className={DIFF_OLD_CLASS}>- {diff.removed}</span></div>}
      {diff.inserted && <div><span className={DIFF_NEW_CLASS}>+ {diff.inserted}</span></div>}
    </>
  );
}

function InlineDiffText({
  path,
  field,
  value,
  diffs,
}: {
  path: string;
  field: string;
  value: string;
  diffs: TextDiffAnimation[];
}): ReactNode {
  const diff = diffs.find((item) => item.path === path && item.field === field);
  if (!diff) return value;
  if (diff.phase === 'mark') {
    return (
      <>
        {diff.prefix}
        {diff.removed ? <span className={INLINE_REMOVE_CLASS}>{diff.removed}</span> : null}
        {diff.suffix}
      </>
    );
  }
  const typedInsert = diff.inserted.slice(0, Math.ceil(diff.inserted.length * diff.progress));
  return (
    <>
      {diff.prefix}
      {typedInsert ? <span className={cn(INLINE_ADD_CLASS, diff.phase === 'settled' && INLINE_ADD_SETTLED_CLASS)}>{typedInsert}</span> : null}
      {diff.suffix}
    </>
  );
}

function diffFullOldValue(diff: TextDiffAnimation): string {
  return `${diff.prefix}${diff.removed}${diff.suffix}`;
}

function diffFullNewValue(diff: TextDiffAnimation): string {
  return `${diff.prefix}${diff.inserted}${diff.suffix}`;
}

function actionsFromDiffText(value: string): string[] {
  const normalized = value.replace(/`/g, '').trim();
  if (!normalized || normalized === '-') return [];
  return normalized
    .split(/[、,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInitialSkillPrompt(text: string): { title: string; raw_content: string } {
  return { title: '新SOP', raw_content: text.trim() };
}

function createStreamingDraftSeed(payload: { title: string; raw_content: string }): SkillCard {
  return {
    skill_id: `skill_${slugSegment(payload.title) || 'preview'}`,
    name: payload.title || '新SOP',
    version: '1.0.0',
    business_domain: '',
    description: payload.raw_content.slice(0, 120),
    capability_scope: 'general',
    trigger_intents: [],
    user_utterance_examples: [],
    goal: [],
    required_info: [],
    response_rules: [],
    nodes: [],
    edges: [],
    start_node_id: '',
    terminal_node_ids: [],
    interruption_policy: {},
  };
}

function previewSkillFromStream(
  streamText: string,
  previous: SkillCard,
  payload: { title: string; raw_content: string },
): SkillCard {
  const parsed = parseCompleteStreamSkill(streamText);
  if (parsed) return parsed;
  const source = extractDraftSkillSource(streamText);
  const next = cloneSkill(previous || createStreamingDraftSeed(payload));
  applyStringPreview(next, source, 'skill_id');
  applyStringPreview(next, source, 'name');
  applyStringPreview(next, source, 'version');
  applyStringPreview(next, source, 'business_domain');
  applyStringPreview(next, source, 'description');
  applyArrayPreview(next, source, 'trigger_intents');
  applyArrayPreview(next, source, 'user_utterance_examples');
  applyArrayPreview(next, source, 'goal');
  applyArrayPreview(next, source, 'required_info');
  applyArrayPreview(next, source, 'response_rules');
  const nodes = extractNodePreview(source);
  if (nodes.length > 0) {
    next.nodes = nodes;
    next.start_node_id = String(nodes[0]?.node_id || '');
    next.terminal_node_ids = nodes.length > 0 ? [String(nodes[nodes.length - 1]?.node_id || '')].filter(Boolean) : [];
    next.edges = nodes.slice(0, -1).map((node, index) => ({
      source_node_id: String(node.node_id || ''),
      next_node_id: String(nodes[index + 1]?.node_id || ''),
      condition: '',
      priority: index,
      label: '',
    })).filter((edge) => edge.source_node_id && edge.next_node_id);
  }
  return next;
}

function parseCompleteStreamSkill(streamText: string): SkillCard | null {
  try {
    const parsed = JSON.parse(extractJsonCandidate(streamText)) as Record<string, unknown>;
    const draft = isRecord(parsed.draft_skill) ? parsed.draft_skill : parsed;
    if (!isRecord(draft)) return null;
    return {
      skill_id: stringValue(draft.skill_id, 'skill_preview'),
      name: stringValue(draft.name, '新SOP'),
      version: stringValue(draft.version, '1.0.0'),
      business_domain: stringValue(draft.business_domain, ''),
      description: stringValue(draft.description, ''),
      capability_scope: normalizeCapabilityScope(draft.capability_scope),
      step_timeout_seconds:
        typeof draft.step_timeout_seconds === 'number'
          ? draft.step_timeout_seconds
          : null,
      trigger_intents: asStringList(draft.trigger_intents),
      user_utterance_examples: asStringList(draft.user_utterance_examples),
      goal: asStringList(draft.goal),
      required_info: asStringList(draft.required_info),
      response_rules: asStringList(draft.response_rules),
      nodes: Array.isArray(draft.nodes) ? draft.nodes.filter(isRecord).map(normalizeNodePreview) : [],
      edges: Array.isArray(draft.edges) ? draft.edges.filter(isRecord).map(normalizeEdgePreview) : [],
      start_node_id: stringValue(draft.start_node_id, ''),
      terminal_node_ids: asStringList(draft.terminal_node_ids),
      interruption_policy: isRecord(draft.interruption_policy) ? stringRecord(draft.interruption_policy) : {},
    };
  } catch {
    return null;
  }
}

function extractDraftSkillSource(streamText: string): string {
  const fieldIndex = streamText.indexOf('"draft_skill"');
  if (fieldIndex < 0) return streamText;
  const objectStart = streamText.indexOf('{', fieldIndex);
  if (objectStart < 0) return streamText.slice(fieldIndex);
  return streamText.slice(objectStart);
}

function extractJsonCandidate(streamText: string): string {
  const stripped = streamText.trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return start >= 0 && end >= start ? stripped.slice(start, end + 1) : stripped;
}

function applyStringPreview(skill: SkillCard, source: string, field: keyof SkillCard): void {
  const value = extractJsonStringField(source, String(field));
  if (value !== null) {
    (skill as unknown as Record<string, unknown>)[field] = value;
  }
}

function applyArrayPreview(skill: SkillCard, source: string, field: keyof SkillCard): void {
  const value = extractJsonStringArrayField(source, String(field));
  if (value !== null) {
    (skill as unknown as Record<string, unknown>)[field] = value;
  }
}

function extractNodePreview(source: string): Array<Record<string, unknown>> {
  const fragments = extractObjectFragmentsFromArrayField(source, 'nodes');
  return fragments
    .map((fragment, index) => parseNodeFragment(fragment, index))
    .filter((node): node is Record<string, unknown> => Boolean(node));
}

function parseNodeFragment(fragment: string, index: number): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fragment) as unknown;
    if (isRecord(parsed)) return normalizeNodePreview(parsed, index);
  } catch {
    // Partial object: fall through to field extraction.
  }
  const nodeId = extractJsonStringField(fragment, 'node_id') || '';
  const type = extractJsonStringField(fragment, 'type') || 'collect_info';
  const name = extractJsonStringField(fragment, 'name') || '';
  const instruction = extractJsonStringField(fragment, 'instruction') || '';
  const condition = extractJsonStringField(fragment, 'condition') || '';
  const subSopId = extractJsonStringField(fragment, 'sub_sop_id') || '';
  const assigneeUserId = extractJsonStringField(fragment, 'assignee_user_id') || '';
  const assigneeNotifyChannel = extractJsonStringField(fragment, 'assignee_notify_channel') || '';
  const expectedUserInfo = extractJsonStringArrayField(fragment, 'expected_user_info') || [];
  const allowedActions = extractJsonStringArrayField(fragment, 'allowed_actions') || [];
  const generalSkillIds = extractJsonStringArrayField(fragment, 'general_skill_ids') || [];
  const toolIds = extractJsonStringArrayField(fragment, 'tool_ids') || [];
  const knowledgeBaseIds = extractJsonStringArrayField(fragment, 'knowledge_base_ids') || [];
  const requiredGeneralSkillIds = extractJsonStringArrayField(fragment, 'required_general_skill_ids') || [];
  const requiredToolIds = extractJsonStringArrayField(fragment, 'required_tool_ids') || [];
  const requiredKnowledgeBaseIds = extractJsonStringArrayField(fragment, 'required_knowledge_base_ids') || [];
  if (
    !nodeId
    && !name
    && !instruction
    && expectedUserInfo.length === 0
    && allowedActions.length === 0
    && generalSkillIds.length === 0
    && toolIds.length === 0
    && knowledgeBaseIds.length === 0
  ) {
    return null;
  }
  return {
    node_id: nodeId || `node_${index + 1}`,
    type,
    name: name || nodeId || `节点 ${index + 1}`,
    instruction,
    optional: false,
    condition,
    sub_sop_id: subSopId,
    expected_user_info: expectedUserInfo,
    allowed_actions: allowedActions,
    capability_refs: {
      general_skill_ids: generalSkillIds,
      tool_ids: toolIds,
      knowledge_base_ids: knowledgeBaseIds,
      required_general_skill_ids: requiredGeneralSkillIds,
      required_tool_ids: requiredToolIds,
      required_knowledge_base_ids: requiredKnowledgeBaseIds,
    },
    knowledge_scope: {},
    retry_policy: {},
    metadata: {},
    assignee_user_id: assigneeUserId || null,
    assignee_notify_channel: assigneeNotifyChannel || null,
  };
}

function normalizeNodePreview(node: Record<string, unknown>, index = 0): Record<string, unknown> {
  const nodeId = stringValue(node.node_id, `node_${index + 1}`);
  const capabilityRefs = nodeCapabilityRefs(node);
  const assigneeUserId = stringValue(node.assignee_user_id, '');
  const assigneeNotifyChannel = stringValue(node.assignee_notify_channel, '');
  return {
    node_id: nodeId,
    type: stringValue(node.type, 'collect_info'),
    name: stringValue(node.name, nodeId),
    instruction: stringValue(node.instruction, ''),
    optional: Boolean(node.optional),
    condition: stringValue(node.condition, ''),
    expected_user_info: asStringList(node.expected_user_info),
    allowed_actions: asStringList(node.allowed_actions),
    capability_refs: capabilityRefs,
    knowledge_scope: isRecord(node.knowledge_scope) ? node.knowledge_scope : {},
    retry_policy: isRecord(node.retry_policy) ? node.retry_policy : {},
    metadata: isRecord(node.metadata) ? node.metadata : {},
    sub_sop_id: stringValue(node.sub_sop_id, ''),
    assignee_user_id: assigneeUserId || null,
    assignee_notify_channel: assigneeNotifyChannel || null,
  };
}

function normalizeEdgePreview(edge: Record<string, unknown>, index = 0): Record<string, unknown> {
  return {
    source_node_id: stringValue(edge.source_node_id, ''),
    next_node_id: stringValue(edge.next_node_id, ''),
    condition: stringValue(edge.condition, ''),
    priority: Number(edge.priority || index),
    label: stringValue(edge.label, ''),
  };
}

function extractJsonStringField(source: string, field: string): string | null {
  const match = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(source);
  if (!match) return null;
  return decodeJsonString(match[1]);
}

function extractJsonStringArrayField(source: string, field: string): string[] | null {
  const start = findFieldValueStart(source, field);
  if (start === null) return null;
  const arrayStart = skipWhitespace(source, start);
  if (source[arrayStart] !== '[') return null;
  const arrayEnd = findBalancedEnd(source, arrayStart, '[', ']');
  const arrayText = arrayEnd === null ? source.slice(arrayStart + 1) : source.slice(arrayStart, arrayEnd + 1);
  if (arrayEnd !== null) {
    try {
      const parsed = JSON.parse(arrayText) as unknown;
      return asStringList(parsed);
    } catch {
      return extractQuotedJsonStrings(arrayText);
    }
  }
  return extractQuotedJsonStrings(arrayText);
}

function extractObjectFragmentsFromArrayField(source: string, field: string): string[] {
  const start = findFieldValueStart(source, field);
  if (start === null) return [];
  const arrayStart = skipWhitespace(source, start);
  if (source[arrayStart] !== '[') return [];
  const fragments: string[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        fragments.push(source.slice(objectStart, index + 1));
        objectStart = -1;
      }
      continue;
    }
    if (char === ']' && depth === 0) break;
  }
  if (depth > 0 && objectStart >= 0) {
    fragments.push(source.slice(objectStart));
  }
  return fragments;
}

function findFieldValueStart(source: string, field: string): number | null {
  const match = new RegExp(`"${escapeRegExp(field)}"\\s*:`).exec(source);
  return match ? match.index + match[0].length : null;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function findBalancedEnd(source: string, start: number, openChar: string, closeChar: string): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function extractQuotedJsonStrings(source: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const value = decodeJsonString(match[1]);
    if (value) values.push(value);
  }
  return values;
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function slugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function joinList(values: unknown): string {
  if (Array.isArray(values)) {
    const items = values.map(String).filter(Boolean);
    return items.length > 0 ? items.map((item) => `\`${item}\``).join(', ') : '-';
  }
  if (typeof values === 'string' && values.trim()) return values;
  return '-';
}

function joinPlain(values: unknown): string {
  if (Array.isArray(values)) {
    const items = values.map(String).filter(Boolean);
    return items.length > 0 ? items.join('、') : '-';
  }
  if (typeof values === 'string' && values.trim()) return values;
  return '-';
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

export function applyNodeTypeChange(
  node: Record<string, unknown>,
  nextType: string,
): Record<string, unknown> {
  const type = String(nextType || 'collect_info');
  node.type = type;
  // 类型切换离开 handoff 时清理转人工专属配置:动作与处理人只属于 handoff 节点
  if (type !== 'handoff') {
    node.allowed_actions = asStringList(node.allowed_actions)
      .filter((action) => action !== 'handoff_human');
    node.assignee_user_id = null;
    node.assignee_notify_channel = null;
  }
  return node;
}

export function filterActionOptionsForNodeType(options: SelectOption[], type: string): SelectOption[] {
  // 转人工动作只允许出现在 handoff 节点上
  if (String(type || '') === 'handoff') return options;
  return options.filter((option) => option.value !== 'handoff_human');
}

function hasSelectedText(): boolean {
  return Boolean(window.getSelection()?.toString().trim());
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

function filenameTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || '新SOP';
}

const uploadContentMarker = '上传文档内容：';

function buildOutgoingText(input: string, attachments: UploadAttachment[]): string {
  const text = input.trim();
  const attachmentText = attachments
    .filter((item) => item.status === 'ready' && item.text?.trim())
    .map((item) => `文件：${item.name}\n${item.text?.trim() || ''}`)
    .join('\n\n');
  return [text, attachmentText ? `上传文档内容：\n${attachmentText}` : ''].filter(Boolean).join('\n\n');
}

function visibleChatContent(item: ChatItem): string {
  if (item.role !== 'user') return item.content;
  return stripUploadContent(item.content || item.outgoingText || '');
}

function buildEditedOutgoingText(item: ChatItem, displayText: string): string {
  const source = item.outgoingText || item.content;
  const markerIndex = source.indexOf(uploadContentMarker);
  if (markerIndex < 0) return displayText.trim();
  const uploadContent = source.slice(markerIndex).trim();
  return [displayText.trim(), uploadContent].filter(Boolean).join('\n\n');
}

function stripUploadContent(text: string): string {
  const markerIndex = text.indexOf(uploadContentMarker);
  return (markerIndex >= 0 ? text.slice(0, markerIndex) : text).trim();
}

function buildDisplayAttachments(attachments: UploadAttachment[]): ChatAttachment[] {
  return attachments
    .filter((item) => item.status === 'ready')
    .map((item) => ({
      id: item.id,
      name: item.name,
      type: attachmentTypeLabel(item.name),
    }));
}

function attachmentTypeLabel(filename: string): string {
  const extension = filename.split('.').pop()?.trim().toUpperCase();
  return extension || 'FILE';
}

function splitEditableList(value: string): string[] {
  return value
    .split(/\n|,|，|、/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatMessageTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function CopyGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="4" width="12" height="12" rx="3" />
      <rect x="4" y="8" width="12" height="12" rx="3" />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 19l4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L5 19z" />
      <path d="M14.8 5.2l4 4" />
    </svg>
  );
}

function normalizeToolSuggestions(value: unknown): ToolSuggestionItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      name: String(item.name || '').trim(),
      display_name: typeof item.display_name === 'string' ? item.display_name : undefined,
      description: typeof item.description === 'string' ? item.description : undefined,
      bucket: typeof item.bucket === 'string' && item.bucket.trim() ? item.bucket.trim() : '技能自发现工具',
      tool_type: item.tool_type === 'mcp' ? 'mcp' : item.tool_type === 'a2a' ? 'a2a' : 'http',
      method: typeof item.method === 'string' ? item.method : 'POST',
      url: typeof item.url === 'string' ? item.url : '',
      mcp_config: isRecord(item.mcp_config) ? item.mcp_config : {},
      input_schema: isRecord(item.input_schema) ? item.input_schema : {},
      output_schema: isRecord(item.output_schema) ? item.output_schema : {},
      sample_arguments: isRecord(item.sample_arguments) ? item.sample_arguments : {},
      source_excerpt: typeof item.source_excerpt === 'string' ? item.source_excerpt : undefined,
      probe_result: isRecord(item.probe_result) ? item.probe_result as ToolProbeResponse : undefined,
      reason: typeof item.reason === 'string' ? item.reason : '',
      resolution_status: toolSuggestionResolutionValue(item.resolution_status),
      matched_tool_id: typeof item.matched_tool_id === 'string' ? item.matched_tool_id : undefined,
      matched_tool_name: typeof item.matched_tool_name === 'string' ? item.matched_tool_name : undefined,
      matched_tool_display_name: typeof item.matched_tool_display_name === 'string' ? item.matched_tool_display_name : undefined,
      missing_reason: typeof item.missing_reason === 'string' ? item.missing_reason : undefined,
      status: 'pending' as const,
      probeStatus: isRecord(item.probe_result)
        ? Boolean(item.probe_result.success)
          ? 'success' as const
          : 'error' as const
        : 'idle' as const,
    }))
    .filter((item) => item.name);
}

function toolSuggestionResolutionValue(value: unknown): ToolSuggestion['resolution_status'] {
  return value === 'existing' || value === 'incomplete' || value === 'new_candidate' ? value : 'new_candidate';
}

function toolSuggestionResolution(suggestion: ToolSuggestionItem): NonNullable<ToolSuggestion['resolution_status']> {
  return suggestion.resolution_status || 'new_candidate';
}

function toolSuggestionTitle(suggestion: ToolSuggestionItem): string {
  const label = suggestion.display_name || suggestion.name;
  if (toolSuggestionResolution(suggestion) === 'existing') {
    return `已匹配工具：${suggestion.matched_tool_display_name || label}`;
  }
  return `建议新增工具：${label}`;
}

function toolSuggestionResolutionLabel(suggestion: ToolSuggestionItem): string {
  const status = toolSuggestionResolution(suggestion);
  if (status === 'existing') return '已匹配现有工具';
  if (status === 'incomplete') return '工具信息不足';
  return '可新增候选';
}

function toolSuggestionStatusText(suggestion: ToolSuggestionItem): string {
  if (suggestion.status === 'accepted') return '已确认';
  if (suggestion.status === 'created') return '已新增';
  if (suggestion.status === 'rejected') return '已拒绝';
  if (suggestion.probeStatus === 'probing') return '测试中';
  if (suggestion.probe_result?.success) return '测试通过';
  if (suggestion.probe_result && !suggestion.probe_result.success) return '测试失败';
  if (toolSuggestionResolution(suggestion) === 'existing') return '已存在';
  if (toolSuggestionResolution(suggestion) === 'incomplete') return '信息不足';
  return '待新增';
}

function toolSuggestionStatusClass(suggestion: ToolSuggestionItem): ToolStatusBadgeVariant {
  if (suggestion.status === 'accepted' || suggestion.status === 'created' || suggestion.probe_result?.success || toolSuggestionResolution(suggestion) === 'existing') {
    return 'success';
  }
  if (suggestion.status === 'rejected' || (suggestion.probe_result && !suggestion.probe_result.success)) {
    return 'error';
  }
  if (suggestion.probeStatus === 'probing') return 'running';
  if (toolSuggestionResolution(suggestion) === 'incomplete') return 'muted';
  return 'pending';
}

function toolSuggestionSelectionsComplete(suggestions: ToolSuggestionItem[]): boolean {
  const candidates = suggestions.filter((suggestion) => toolSuggestionResolution(suggestion) === 'new_candidate');
  return candidates.length > 0 && candidates.every((suggestion) =>
    suggestion.status === 'accepted' || suggestion.status === 'created' || suggestion.status === 'rejected',
  );
}

function compactWarningItems(
  warnings: string[],
  _toolSuggestions: ToolSuggestionItem[] | undefined,
): Array<{ text: string; title: string }> {
  const items: Array<{ text: string; title: string }> = [];
  for (const warning of warnings) {
    const text = warning.trim();
    if (!text) continue;
    const existing = items.find((item) => item.text === text);
    if (existing) {
      existing.title = `${existing.title}\n${warning}`;
      continue;
    }
    items.push({ text, title: warning });
  }
  return items;
}

function readDistillCache(key: string): DistillCacheSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DistillCacheSnapshot>;
    return {
      draft: parsed.draft || null,
      loadedSkill: parsed.loadedSkill || null,
      lastSavedDraft: parsed.lastSavedDraft || null,
      messages: Array.isArray(parsed.messages) ? parsed.messages : DEFAULT_DISTILL_MESSAGES,
      input: typeof parsed.input === 'string' ? parsed.input : '',
      selectedPaths: normalizeInitialSelectedPaths(
        Array.isArray(parsed.selectedPaths) ? parsed.selectedPaths.map(String) : DEFAULT_TARGET_PATHS,
      ),
      highlightedPaths: Array.isArray(parsed.highlightedPaths) ? parsed.highlightedPaths.map(String) : [],
      updatingPaths: Array.isArray(parsed.updatingPaths) ? parsed.updatingPaths.map(String) : [],
      dirtyPaths: Array.isArray(parsed.dirtyPaths) ? parsed.dirtyPaths.map(String) : [],
      textDiffs: Array.isArray(parsed.textDiffs) ? parsed.textDiffs : [],
      pendingChange: parsed.pendingChange || null,
      viewMode: parsed.viewMode === 'source' ? 'source' : 'flow',
      attachments: Array.isArray(parsed.attachments)
        ? parsed.attachments.filter((item): item is UploadAttachment => isRecord(item)).map((item) => ({
            id: String(item.id || `file_${Date.now()}_${Math.random().toString(16).slice(2)}`),
            name: String(item.name || '未命名文件'),
            status: item.status === 'error' ? 'error' : 'ready',
            text: typeof item.text === 'string' ? item.text : undefined,
            error: typeof item.error === 'string' ? item.error : undefined,
          }))
        : [],
      streamStatus: typeof parsed.streamStatus === 'string' ? parsed.streamStatus : '',
      activeJob: isRecord(parsed.activeJob)
        ? {
            jobId: String(parsed.activeJob.jobId || ''),
            kind: parsed.activeJob.kind === 'rewrite' ? 'rewrite' : 'distill',
            assistantId: String(parsed.activeJob.assistantId || ''),
            lastSeq: Number(parsed.activeJob.lastSeq || 0),
            status: typeof parsed.activeJob.status === 'string' ? parsed.activeJob.status : undefined,
            createPayload: isRecord(parsed.activeJob.createPayload)
              ? {
                  title: String(parsed.activeJob.createPayload.title || ''),
                  raw_content: String(parsed.activeJob.createPayload.raw_content || ''),
                }
              : undefined,
            previousDraft: isRecord(parsed.activeJob.previousDraft)
              ? (parsed.activeJob.previousDraft as SkillCard)
              : undefined,
            targets: Array.isArray(parsed.activeJob.targets)
              ? parsed.activeJob.targets.map(String)
              : undefined,
          }
        : null,
    };
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

function createDistillWorkspaceId(): string {
  if (typeof window.crypto?.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function writeDistillCache(key: string, snapshot: DistillCacheSnapshot): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Cache is best-effort. Large uploaded documents can exceed browser quota.
  }
}

function removeDistillCache(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Cache cleanup is best-effort.
  }
}

function isBlankDistillWorkspace(snapshot: DistillCacheSnapshot): boolean {
  return !snapshot.draft && !snapshot.loadedSkill && !snapshot.lastSavedDraft;
}

function normalizeInitialSelectedPaths(paths: string[]): string[] {
  if (paths.length === 1 && paths[0] === 'basic') return [];
  return paths;
}

function allTargetPaths(skill: SkillCard): string[] {
  return [
    'basic',
    ...skillGraphSteps(skill).map((_step, index) => stepTargetPath(index)),
  ];
}

function reconcileSelectedPaths(paths: string[], skill: SkillCard): string[] {
  if (paths.length === 0) return [];
  const available = allTargetPaths(skill);
  const next = paths.filter((path) => available.includes(path));
  return next.length > 0 ? next : DEFAULT_TARGET_PATHS;
}


function mergePaths(current: string[], next: string[]): string[] {
  return Array.from(new Set([...current, ...next]));
}

function cloneSkill(skill: SkillCard): SkillCard {
  return JSON.parse(JSON.stringify(skill)) as SkillCard;
}

function normalizeSubflowNode<T extends Record<string, unknown>>(node: T): T {
  if (String(node.type || '') !== 'subflow') return node;
  return {
    ...node,
    instruction: '',
    expected_user_info: [],
    allowed_actions: [],
    capability_refs: {
      general_skill_ids: [],
      tool_ids: [],
      knowledge_base_ids: [],
      required_general_skill_ids: [],
      required_tool_ids: [],
      required_knowledge_base_ids: [],
    },
    knowledge_scope: {},
    retry_policy: {},
  };
}

function normalizeSubflowNodes(skill: SkillCard): SkillCard {
  const next = cloneSkill(skill);
  next.nodes = (Array.isArray(next.nodes) ? next.nodes : []).map((node) => (
    normalizeSubflowNode({ ...node })
  ));
  return next;
}

function wouldCreateSopNestingCycle(
  parentSkillId: string,
  candidateSkillId: string,
  skills: SkillRead[],
): boolean {
  const byId = new Map(skills.map((item) => [item.skill_id, item]));
  const visiting = new Set<string>();
  const reachesParent = (skillId: string): boolean => {
    if (skillId === parentSkillId) return true;
    if (visiting.has(skillId)) return false;
    visiting.add(skillId);
    const row = byId.get(skillId);
    const childIds = (row?.content.nodes || [])
      .filter((node) => String(node.type || '') === 'subflow')
      .map((node) => String(node.sub_sop_id || '').trim())
      .filter(Boolean);
    return childIds.some(reachesParent);
  };
  return reachesParent(candidateSkillId);
}

function canonicalizeSkillCapabilityRefs(skill: SkillCard): SkillCard {
  const next = cloneSkill(skill);
  next.nodes = (Array.isArray(next.nodes) ? next.nodes : []).map((node) => {
    const normalized = { ...node, capability_refs: nodeCapabilityRefs(node) };
    const legacyFields = normalized as Record<string, unknown>;
    delete legacyFields.general_skill_ids;
    delete legacyFields.tool_ids;
    delete legacyFields.knowledge_base_ids;
    delete legacyFields.required_general_skill_ids;
    delete legacyFields.required_tool_ids;
    delete legacyFields.required_knowledge_base_ids;
    return normalized;
  });
  return next;
}

function uniqueDraftSkillId(skillId: string): string {
  const normalized = (skillId || 'skill')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'skill';
  return `${normalized}_${Date.now().toString(36)}`;
}

function comparableSkillContent(skill: SkillCard): SkillCard {
  const next = cloneSkill(skill);
  next.version = '';
  return next;
}

function hasSkillContentChanges(targetDraft: SkillCard | null, baseDraft: SkillCard | null): boolean {
  if (!targetDraft) return false;
  if (!baseDraft) return true;
  return JSON.stringify(comparableSkillContent(targetDraft)) !== JSON.stringify(comparableSkillContent(baseDraft));
}

function removeToolActionFromSkill(skill: SkillCard, toolName: string): SkillCard {
  const next = cloneSkill(skill);
  const targetAction = `call_tool:${toolName}`;
  next.nodes = (Array.isArray(next.nodes) ? next.nodes : []).map((node) => ({
    ...node,
    allowed_actions: asStringList(node.allowed_actions).filter((action) => action !== targetAction),
  }));
  return next;
}

function integrateToolSuggestionsIntoDraft(
  skill: SkillCard,
  suggestions: ToolSuggestionItem[],
  fallbackPaths: string[] = [],
): SkillCard {
  const next = cloneSkill(skill);
  const nodes = normalizeSkillNodes(next);
  const fallbackIndexes = fallbackPaths
    .map(stepIndexFromPath)
    .filter((index): index is number => index !== null && index >= 0 && index < nodes.length);

  suggestions.forEach((suggestion) => {
    const toolName = suggestion.name.trim();
    if (!toolName) return;
    const action = `call_tool:${toolName}`;
    const existingIndexes = nodes
      .map((node, index) => (asStringList(node.allowed_actions).includes(action) ? index : -1))
      .filter((index) => index >= 0);
    const targetIndexes = existingIndexes.length > 0
      ? existingIndexes
      : toolSuggestionTargetIndexes(nodes, suggestion, fallbackIndexes);

    targetIndexes.forEach((nodeIndex) => {
      const node = nodes[nodeIndex];
      const actions = asStringList(node.allowed_actions);
      if (actions.includes(action)) return;
      node.allowed_actions = [...actions, action];
    });
  });

  next.nodes = nodes;
  return next;
}

function toolSuggestionTargetIndexes(
  nodes: Array<Record<string, unknown>>,
  _suggestion: ToolSuggestionItem,
  fallbackIndexes: number[],
): number[] {
  const uniqueFallbacks = Array.from(new Set(fallbackIndexes));
  if (uniqueFallbacks.length === 1) return uniqueFallbacks;
  const toolNodeIndexes = nodes
    .map((node, index) => (String(node.type || '') === 'tool_call' ? index : -1))
    .filter((index) => index >= 0);
  if (toolNodeIndexes.length === 1) return toolNodeIndexes;
  return [];
}

function cloneSkillRead(skill: SkillRead): SkillRead {
  return JSON.parse(JSON.stringify(skill)) as SkillRead;
}

function collectRollbackOperations(messages: ChatItem[]): DistillHistoryOperation[] {
  const operations = messages.flatMap((item) => item.operations || []);
  const relevant = operations.filter((operation) =>
    ['skill_change', 'version_save', 'tool_add'].includes(operation.kind),
  );
  const seen = new Set<string>();
  return relevant.filter((operation) => {
    const key = `${operation.kind}:${operation.skillId || ''}:${operation.version || ''}:${operation.toolId || operation.toolName || ''}:${operation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blankSkillForAnimation(skill: SkillCard): SkillCard {
  const blank = cloneSkill(skill);
  blank.skill_id = '';
  blank.name = '';
  blank.version = '';
  blank.business_domain = '';
  blank.description = '';
  blank.capability_scope = 'general';
  blank.trigger_intents = [];
  blank.user_utterance_examples = [];
  blank.goal = [];
  blank.required_info = [];
  blank.response_rules = [];
  blank.nodes = skillGraphSteps(skill).map((step) => ({
    node_id: '',
    type: String(step.type || 'collect_info'),
    name: '',
    instruction: '',
    sub_sop_id: '',
    optional: Boolean(step.optional),
    condition: '',
    expected_user_info: [],
    allowed_actions: [],
    capability_refs: {
      general_skill_ids: [],
      tool_ids: [],
      knowledge_base_ids: [],
      required_general_skill_ids: [],
      required_tool_ids: [],
      required_knowledge_base_ids: [],
    },
    knowledge_scope: {},
    retry_policy: {},
    metadata: {},
  }));
  blank.edges = [];
  blank.start_node_id = '';
  blank.terminal_node_ids = [];
  return blank;
}

function diffTargetPaths(previousDraft: SkillCard, nextDraft: SkillCard, targetPaths: string[]): string[] {
  const candidates = Array.from(new Set([
    ...targetPaths,
    ...allTargetPaths(previousDraft),
    ...allTargetPaths(nextDraft),
    'graph',
  ]));
  return candidates.filter((path) => sectionSignature(previousDraft, path) !== sectionSignature(nextDraft, path));
}

function sectionSignature(skill: SkillCard, path: string): string {
  if (path === 'basic') {
    return JSON.stringify({
      skill_id: skill.skill_id,
      name: skill.name,
      version: skill.version,
      business_domain: skill.business_domain || '',
      description: skill.description,
      step_timeout_seconds: skill.step_timeout_seconds ?? null,
      trigger_intents: skill.trigger_intents || [],
      user_utterance_examples: skill.user_utterance_examples || [],
      goal: skill.goal || [],
      required_info: skill.required_info || [],
      interruption_policy: skill.interruption_policy || {},
      response_rules: skill.response_rules || [],
    });
  }
  if (path === 'graph') {
    return JSON.stringify({
      edges: skill.edges || [],
      start_node_id: skill.start_node_id,
      terminal_node_ids: skill.terminal_node_ids || [],
    });
  }
  const stepIndex = stepIndexFromPath(path);
  if (stepIndex === null) return '';
  return JSON.stringify(skillGraphSteps(skill)[stepIndex] || null);
}

function collectTextDiffs(previousDraft: SkillCard, nextDraft: SkillCard, changedPaths: string[]): TextDiffAnimation[] {
  const diffs: TextDiffAnimation[] = [];
  const paths = changedPaths.includes('all') ? allTargetPaths(nextDraft) : changedPaths;
  paths.forEach((path) => {
    if (path === 'basic') {
      [
        'skill_id',
        'name',
        'version',
        'business_domain',
        'description',
        'trigger_intents',
        'user_utterance_examples',
        'goal',
        'required_info',
        'response_rules',
      ].forEach((field) => {
        const diff = makeTextDiff(
          path,
          field,
          getDisplayField(previousDraft, path, field),
          getDisplayField(nextDraft, path, field),
        );
        if (diff) diffs.push(diff);
      });
      return;
    }
    const stepIndex = stepIndexFromPath(path);
    if (stepIndex === null) return;
    [
      'step_id',
      'type',
      'condition',
      'name',
      'instruction',
      'expected_user_info',
      'allowed_actions',
      'general_skill_ids',
      'tool_ids',
      'knowledge_base_ids',
    ].forEach((field) => {
      const diff = makeTextDiff(
        path,
        field,
        getDisplayField(previousDraft, path, field),
        getDisplayField(nextDraft, path, field),
      );
      if (diff) diffs.push(diff);
    });
  });
  return diffs;
}

function makeTextDiff(path: string, field: string, oldText: string, newText: string): TextDiffAnimation | null {
  if (oldText === newText) return null;
  let prefixLength = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefixLength < maxPrefix && oldText[prefixLength] === newText[prefixLength]) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  const maxSuffix = Math.min(oldText.length - prefixLength, newText.length - prefixLength);
  while (
    suffixLength < maxSuffix &&
    oldText[oldText.length - 1 - suffixLength] === newText[newText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  return {
    key: `${path}:${field}`,
    path,
    field,
    prefix: newText.slice(0, prefixLength),
    removed: oldText.slice(prefixLength, oldText.length - suffixLength),
    inserted: newText.slice(prefixLength, newText.length - suffixLength),
    suffix: newText.slice(newText.length - suffixLength),
    phase: 'mark',
    progress: 0,
  };
}

function getDisplayField(skill: SkillCard, path: string, field: string): string {
  const value =
    path === 'basic'
      ? (skill as unknown as Record<string, unknown>)[field]
      : skillGraphSteps(skill)[stepIndexFromPath(path) ?? -1]?.[field];
  if (Array.isArray(value)) return joinList(value.map(String));
  if (typeof value === 'string') return value;
  return '';
}

function setTextField(skill: SkillCard, path: string, field: string, value: string): void {
  if (isListField(field)) return;
  if (path === 'basic') {
    (skill as unknown as Record<string, unknown>)[field] = value;
    return;
  }
  const stepIndex = stepIndexFromPath(path);
  if (stepIndex === null) return;
  if (Array.isArray(skill.nodes) && skill.nodes[stepIndex]) {
    const nodeField = field === 'step_id' ? 'node_id' : field;
    skill.nodes[stepIndex][nodeField] = value;
  }
}

function isListField(field: string): boolean {
  return [
    'trigger_intents',
    'user_utterance_examples',
    'goal',
    'required_info',
    'response_rules',
    'expected_user_info',
    'allowed_actions',
    'general_skill_ids',
    'tool_ids',
    'knowledge_base_ids',
  ].includes(field);
}

function typedDraft(previousDraft: SkillCard, nextDraft: SkillCard, diffs: TextDiffAnimation[], progress: number): SkillCard {
  const output = cloneSkill(previousDraft);
  diffs.forEach((diff) => {
    const typedInsert = diff.inserted.slice(0, Math.ceil(diff.inserted.length * progress));
    setTextField(output, diff.path, diff.field, `${diff.prefix}${typedInsert}${diff.suffix}`);
  });
  if (progress >= 1) return cloneSkill(nextDraft);
  return output;
}

function bumpSkillVersion(version: string): string {
  const parts = version.split('.').map((item) => Number.parseInt(item, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 1;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  return `${major}.${minor + 1}.0`;
}

function buildToolDescriptionMap(tools: ToolRead[], messages: ChatItem[] = []): ToolDescriptionMap {
  const descriptions = tools.reduce<ToolDescriptionMap>((acc, tool) => {
    acc[tool.name] = [tool.display_name, tool.description].filter(Boolean).join('：') || tool.name;
    return acc;
  }, {});
  messages.flatMap((item) => item.toolSuggestions || []).forEach((suggestion) => {
    const label = suggestion.display_name || suggestion.name;
    descriptions[suggestion.name] = [label, suggestion.description || suggestion.reason].filter(Boolean).join('：') || suggestion.name;
    if (suggestion.matched_tool_name) {
      descriptions[suggestion.matched_tool_name] = descriptions[suggestion.name];
    }
  });
  return descriptions;
}

function buildToolStatusMap(tools: ToolRead[], messages: ChatItem[]): ToolStatusMap {
  const statuses = tools.reduce<ToolStatusMap>((acc, tool) => {
    acc[tool.name] = 'existing';
    return acc;
  }, {});
  messages.flatMap((item) => item.toolSuggestions || []).forEach((suggestion) => {
    const resolution = toolSuggestionResolution(suggestion);
    const status: ToolActionStatus =
      resolution === 'existing'
        ? 'existing'
        : resolution === 'incomplete'
          ? 'incomplete'
          : suggestion.status === 'accepted' || suggestion.status === 'created' || suggestion.status === 'rejected'
            ? suggestion.status
            : 'pending';
    statuses[suggestion.name] = status;
    if (suggestion.matched_tool_name) statuses[suggestion.matched_tool_name] = status;
  });
  return statuses;
}

function toolPayloadFromSuggestion(suggestion: ToolSuggestionItem, skillId: string | undefined, tenantId: string): Record<string, unknown> {
  const outputSchema = suggestion.probe_result?.success && suggestion.probe_result.inferred_output_schema
    ? suggestion.probe_result.inferred_output_schema
    : suggestion.output_schema || {};
  return {
    tenant_id: tenantId,
    name: suggestion.name,
    display_name: suggestion.display_name || suggestion.name,
    description: suggestion.description || suggestion.reason || '',
    bucket: suggestion.bucket || '技能自发现工具',
    tool_type: suggestion.tool_type || 'http',
    method: suggestion.method || 'POST',
    url: suggestion.url || `/api/mock/${suggestion.name.replace(/\./g, '/')}`,
    headers: {},
    auth: {},
    mcp_config: suggestion.tool_type === 'mcp' || suggestion.tool_type === 'a2a' ? suggestion.mcp_config || {} : {},
    input_schema: suggestion.input_schema || {},
    output_schema: outputSchema,
    execution_policy: { timeout_seconds: 8 },
    allowed_skills: skillId ? [skillId] : [],
    enabled: true,
  };
}

function toolReadFromSuggestion(suggestion: ToolSuggestionItem, skillId: string | undefined, tenantId: string): ToolRead {
  const outputSchema = suggestion.probe_result?.success && suggestion.probe_result.inferred_output_schema
    ? suggestion.probe_result.inferred_output_schema
    : suggestion.output_schema || {};
  return {
    id: suggestion.name,
    tenant_id: tenantId,
    name: suggestion.name,
    display_name: suggestion.display_name || suggestion.name,
    description: suggestion.description || suggestion.reason || '',
    bucket: suggestion.bucket || '技能自发现工具',
    tool_type: suggestion.tool_type || 'http',
    method: suggestion.method || 'POST',
    url: suggestion.url || `/api/mock/${suggestion.name.replace(/\./g, '/')}`,
    headers: {},
    auth: {},
    mcp_config: suggestion.tool_type === 'mcp' || suggestion.tool_type === 'a2a' ? suggestion.mcp_config || {} : {},
    input_schema: suggestion.input_schema || {},
    output_schema: outputSchema,
    execution_policy: { timeout_seconds: 8 },
    allowed_skills: skillId ? [skillId] : [],
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function upsertToolRead(current: ToolRead[], nextTool: ToolRead): ToolRead[] {
  const exists = current.some((tool) => tool.name === nextTool.name);
  return exists
    ? current.map((tool) => (tool.name === nextTool.name ? { ...tool, ...nextTool, id: nextTool.id || tool.id } : tool))
    : [...current, nextTool];
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    skill_id: '技能 ID',
    name: '名称',
    version: '版本',
    business_domain: '业务域',
    description: '描述',
    capability_scope: '使用范围',
    step_timeout_seconds: '单步运行上限（秒）',
    trigger_intents: '触发意图',
    user_utterance_examples: '示例话术',
    goal: '目标',
    required_info: '必填信息',
    response_rules: '回复规则',
    step_id: '节点 ID',
    type: '节点类型',
    condition: '条件',
    instruction: '节点说明',
    expected_user_info: '期望字段',
    allowed_actions: '允许动作',
    general_skill_ids: 'SOP 技能',
    tool_ids: 'SOP 工具',
    knowledge_base_ids: 'SOP 知识库',
    sub_sop_id: '调用子 SOP',
  };
  return labels[field] || field;
}

function toolNameFromAction(action: string): string {
  return action.startsWith('call_tool:') ? action.replace(/^call_tool:/, '').trim() : '';
}

function actionLabel(action: string): string {
  const toolName = toolNameFromAction(action);
  if (toolName) return `调用工具：${toolName}`;
  return BASE_ACTION_OPTIONS.find((item) => item.value === action)?.label || action;
}

function buildActionOptions(
  toolDescriptions: ToolDescriptionMap,
  toolStatuses: ToolStatusMap,
  steps: Array<Record<string, unknown>>,
): SelectOption[] {
  const toolNames = Array.from(new Set([
    ...Object.keys(toolDescriptions),
    ...Object.keys(toolStatuses),
  ])).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const toolOptions = toolNames.map((toolName) => ({
    value: `call_tool:${toolName}`,
    label: `调用工具：${toolName}`,
  }));
  const currentActionOptions = steps
    .flatMap((step) => asStringList(step.allowed_actions))
    .filter(Boolean)
    .map((action) => ({ value: action, label: actionLabel(action) }));
  return mergeSelectOptions(BASE_ACTION_OPTIONS, toolOptions, currentActionOptions);
}

function mergeSelectOptions(...groups: SelectOption[][]): SelectOption[] {
  const seen = new Set<string>();
  const output: SelectOption[] = [];
  groups.flat().forEach((option) => {
    if (!option.value || seen.has(option.value)) return;
    seen.add(option.value);
    output.push(option);
  });
  return output;
}

function conditionPresetValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'always' || trimmed === 'true') return '__always__';
  if (CONDITION_PRESET_OPTIONS.some((option) => option.value === trimmed)) return trimmed;
  const naturalMatch = Object.entries(CONDITION_PRESET_TEXT).find(([, text]) => text === trimmed);
  if (naturalMatch) return naturalMatch[0];
  return '__custom__';
}

function conditionFromPreset(value: string): string {
  if (value === '__always__') return '';
  return CONDITION_PRESET_TEXT[value] || '';
}

function conditionNaturalText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'always' || trimmed === 'true') return '';
  if (CONDITION_PRESET_TEXT[trimmed]) return CONDITION_PRESET_TEXT[trimmed];
  const presetMatch = Object.entries(CONDITION_PRESET_TEXT).find(([, text]) => text === trimmed);
  if (presetMatch) return presetMatch[1];
  return trimmed;
}

function conditionReadableText(value: string): string {
  const natural = conditionNaturalText(value);
  return natural ? `模型理解：${natural}。` : '模型理解：没有额外限制，流程可以从这里继续。';
}

function flowRuleConditionText(value: string): string {
  const natural = conditionNaturalText(value);
  return natural ? `进入条件：${natural}。` : '进入条件：总是进入。';
}

function diffTargetLabel(path: string, skill: SkillCard | null): string {
  if (!skill) return path;
  return targetLabel([path], skill);
}

function targetLabel(paths: string[], skill: SkillCard): string {
  const labels = paths.map((path) => {
    if (path === 'basic') return '基础信息';
    if (path === 'graph') return '流程连线';
    const stepIndex = stepIndexFromPath(path);
    if (stepIndex !== null) {
      const index = stepIndex;
      const step = index >= 0 ? skillGraphSteps(skill)[index] : null;
      return step ? `节点 ${index + 1}：${step.name || step.step_id || path}` : path;
    }
    return path;
  });
  return labels.join('、');
}

function stepTargetPath(index: number): string {
  return `nodes[${index}]`;
}

function stepIndexFromPath(path: string): number | null {
  const match = path.match(/^nodes\[(\d+)\]$/);
  return match ? Number(match[1]) : null;
}
