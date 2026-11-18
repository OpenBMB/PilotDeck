// @ts-nocheck
import { USER_CONTENT_ATTRIBUTES } from '../../../staffdeck-shared/vendor/FormalUserContent';
import './FormalKnowledgeLayout.css';
import type { HTMLAttributes, ReactNode } from 'react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AppHeader,
  hasApiErrorStatus,
  CapabilityScopeBadge,
  CapabilityScopeControl,
  CapabilityScopeLoading,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconAdd,
  IconChevronDown,
  IconClear,
  IconFolder,
  IconRefresh,
  IconSearch,
  Input,
  KnowledgeGraphCanvas,
  ModelConfigDropdown,
  Paginator,
  Progress,
  ResourceImportDialog,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatCard,
  Textarea,
  UIButton,
  UISelect,
  cn,
  isTeamScope,
  normalizeCapabilityScope,
  useClientPagination,
  useKnowledgePageHost,
  KnowledgeGraphVisualization as HostKnowledgeGraphVisualization,
  DIALOG_CANCEL_BUTTON_CLASS,
  DIALOG_FOOTER_CLASS,
  DIALOG_PRIMARY_BUTTON_CLASS,
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DANGER_CLASS,
  MOBILE_CARD_CLASS,
  OUTLINE_ACTION_BUTTON_CLASS,
  OUTLINE_ACTION_BUTTON_SM_CLASS,
  SEARCH_COMBO_BUTTON_CLASS,
  SEARCH_COMBO_CLASS,
  SEARCH_COMBO_INPUT_CLASS,
  SELECT_TRIGGER_CLASS,
  AuditOutlined,
  CheckOutlined,
  CloseOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileAddOutlined,
  FileMarkdownOutlined,
  HistoryOutlined,
  InboxOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RightOutlined,
} from './KnowledgePageHost';
import type {
  AgentProfileRead,
  CapabilityScope,
  EnterpriseAuthUser,
  KnowledgeBaseRead,
  KnowledgeBucketRead,
  KnowledgeChunkRead,
  KnowledgeConceptRead,
  KnowledgeDiscoveryRead,
  KnowledgeDocumentRead,
  KnowledgeIngestJobRead,
  KnowledgeSearchResponse,
  ModelConfigRead,
} from './KnowledgePageHost';

const KNOWLEDGE_PAGE_SIZE = 10;
const KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY = 'knowledge-search-model';
const TERMINAL_KNOWLEDGE_JOB_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
const KnowledgeGraphVisualization = HostKnowledgeGraphVisualization;

type KnowledgeBaseVersionRead = {
  id: string;
  version: string;
  name: string;
  description?: string;
  status: string;
  is_head: boolean;
  is_base: boolean;
  updated_at: string;
  created_at: string;
};

type IngestStepView = {
  key: string;
  label: string;
  progress: number;
  status: 'pending' | 'running' | 'done';
};

type OkfLintIssue = {
  issue_type?: string;
  title?: string;
  message?: string;
  concept_id?: string;
  concept_type?: string;
  document_id?: string;
};

const DEFAULT_INGEST_STEPS: IngestStepView[] = [
  { key: 'queued', label: '排队中', progress: 0, status: 'pending' },
  { key: 'parsing', label: '解析原始资料', progress: 0.08, status: 'pending' },
  {
    key: 'normalizing',
    label: '规范化原始资料',
    progress: 0.16,
    status: 'pending',
  },
  {
    key: 'documenting',
    label: '写入文档页',
    progress: 0.24,
    status: 'pending',
  },
  {
    key: 'bucketing',
    label: '规划知识图谱',
    progress: 0.36,
    status: 'pending',
  },
  {
    key: 'bucket_writing',
    label: '写入知识图谱',
    progress: 0.48,
    status: 'pending',
  },
  { key: 'chunking', label: '生成引用来源', progress: 0.62, status: 'pending' },
  {
    key: 'summarizing',
    label: '刷新 目录索引',
    progress: 0.74,
    status: 'pending',
  },
  {
    key: 'discovering',
    label: '发现 SOP/工具',
    progress: 0.88,
    status: 'pending',
  },
  { key: 'done', label: '完成入库', progress: 1, status: 'pending' },
];

type KnowledgePageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

function resolveKnowledgeAgentScope(
  rows: AgentProfileRead[],
  currentUser: EnterpriseAuthUser | undefined,
  isAdmin: (user?: EnterpriseAuthUser) => boolean,
  currentAgentId: string,
): string {
  const currentAgent = rows.find((item) => item.id === currentAgentId);
  if (currentAgent) {
    if (!currentAgent.is_overall || isAdmin(currentUser))
      return currentAgent.id;
  }
  if (isAdmin(currentUser)) return '';
  // This module-level helper has no host access, so pick the first active
  // non-overall agent directly instead of calling the host's
  // `visibleEmployeeAgents` (which is only in scope inside the component).
  return (
    rows.find((item) => !item.is_overall && item.active !== false)?.id || ''
  );
}

function effectiveKnowledgeAgentId(
  rows: AgentProfileRead[],
  agentId: string,
): string {
  const agent = rows.find((item) => item.id === agentId);
  return agent && !agent.is_overall ? agent.id : '';
}

export default function KnowledgeManagePage({
  currentUser,
  onLogout,
}: KnowledgePageProps = {}) {
  const {
    api,
    navigate,
    notify,
    tenantId: TENANT_ID,
    loadEmployeeDirectory,
    isEnterpriseAdmin,
    canManageEmployeeAgent,
    visibleEmployeeAgents,
    openGalleryAgentId,
    openGalleryImportSourceOptions,
    resourceCreatorName,
    getDateLocale,
    agentScope,
  } = useKnowledgePageHost();
  const readEmployeeScope = agentScope.read;
  const persistSharedAgentScope = agentScope.persist;
  const clearSharedAgentScope = agentScope.clear;
  const emitAgentScopeChange = agentScope.emit;
  const [searchParams, setSearchParams] = useSearchParams();
  const [documents, setDocuments] = useState<KnowledgeDocumentRead[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [selectedDocument, setSelectedDocument] =
    useState<KnowledgeDocumentRead | null>(null);
  const [buckets, setBuckets] = useState<KnowledgeBucketRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelState, setPanelState] = useState({
    bases: 'loading',
    documents: 'loading',
  });
  const [panelErrors, setPanelErrors] = useState<Record<string, string>>({});
  const refreshSequence = useRef(0);
  const [agentId, setAgentId] = useState(readEmployeeScope);
  const [agentScopeLoaded, setAgentScopeLoaded] = useState(false);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<'plaza' | 'employee'>('plaza');
  const [importSourceAgentId, setImportSourceAgentId] = useState('');
  const [importSourceKnowledgeBases, setImportSourceKnowledgeBases] = useState<
    KnowledgeBaseRead[]
  >([]);
  const [importSelectedKnowledgeBaseIds, setImportSelectedKnowledgeBaseIds] =
    useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [editingKnowledgeBase, setEditingKnowledgeBase] =
    useState<KnowledgeBaseRead | null>(null);
  const [deleteKbTarget, setDeleteKbTarget] =
    useState<KnowledgeBaseRead | null>(null);
  const [knowledgeBaseDraft, setKnowledgeBaseDraft] = useState({
    name: '',
    description: '',
    status: 'active',
    capability_scope: 'general' as CapabilityScope,
  });
  const [versionKnowledgeBase, setVersionKnowledgeBase] =
    useState<KnowledgeBaseRead | null>(null);
  const [knowledgeBaseVersions, setKnowledgeBaseVersions] = useState<
    KnowledgeBaseVersionRead[]
  >([]);
  const [editingDocument, setEditingDocument] =
    useState<KnowledgeDocumentRead | null>(null);
  const [documentDraft, setDocumentDraft] = useState({
    title: '',
    status: 'ready',
    content_md: '',
  });
  const [documentEditorMode, setDocumentEditorMode] = useState<
    'edit' | 'preview'
  >('edit');
  const [editingBucket, setEditingBucket] =
    useState<KnowledgeBucketRead | null>(null);
  const [bucketDraft, setBucketDraft] = useState({ title: '', summary: '' });
  const [bucketChunks, setBucketChunks] = useState<KnowledgeChunkRead[]>([]);
  const [chunkDrafts, setChunkDrafts] = useState<
    Record<string, { content: string; summary: string }>
  >({});
  const [contentSaving, setContentSaving] = useState(false);
  const [documentSearch, setDocumentSearch] = useState('');
  const [knowledgeBaseFilter, setKnowledgeBaseFilter] = useState('__all__');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] =
    useState<KnowledgeSearchResponse | null>(null);
  const [modelConfigs, setModelConfigs] = useState<ModelConfigRead[]>([]);
  const [selectedSearchModelId, setSelectedSearchModelId] = useState(
    () =>
      window.localStorage.getItem(
        `${KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY}:${TENANT_ID}`,
      ) || '',
  );
  const [okfConcepts, setOkfConcepts] = useState<KnowledgeConceptRead[]>([]);
  const [okfLoading, setOkfLoading] = useState(false);
  const [okfImportOpen, setOkfImportOpen] = useState(false);
  const [okfLintIssues, setOkfLintIssues] = useState<OkfLintIssue[]>([]);
  const [okfLintReportOpen, setOkfLintReportOpen] = useState(false);
  const [okfLintKnowledgeBase, setOkfLintKnowledgeBase] =
    useState<KnowledgeBaseRead | null>(null);
  const [viewingConcept, setViewingConcept] =
    useState<KnowledgeConceptRead | null>(null);
  const [editingConcept, setEditingConcept] =
    useState<KnowledgeConceptRead | null>(null);
  const [conceptDraft, setConceptDraft] = useState('');
  const conceptEditorType = editingConcept
    ? okfFrontmatterValue(
        conceptDraft,
        'type',
        editingConcept.concept_type || 'Topic',
      )
    : 'Topic';
  const conceptEditorTitle = editingConcept
    ? okfFrontmatterValue(
        conceptDraft,
        'title',
        editingConcept.title || editingConcept.concept_id,
      )
    : '';
  const conceptEditorDescription = editingConcept
    ? okfFrontmatterValue(
        conceptDraft,
        'description',
        editingConcept.description || '',
      )
    : '';

  const currentAgent = useMemo(
    () => agents.find((item) => item.id === agentId),
    [agents, agentId],
  );
  const isOverallAgent = !currentAgent || currentAgent.is_overall;
  const canManageCurrentScope = currentAgent
    ? canManageEmployeeAgent(currentAgent, currentUser)
    : isEnterpriseAdmin(currentUser);
  const effectiveAgentId =
    currentAgent && !currentAgent.is_overall ? agentId : '';
  const visibleKnowledgeBases = useMemo(
    () => knowledgeBases.filter((item) => !isEmptyDefaultKnowledgeBase(item)),
    [knowledgeBases],
  );
  const selectedKnowledgeBase = useMemo(() => {
    if (selectedDocument) {
      return (
        visibleKnowledgeBases.find(
          (item) => item.id === selectedDocument.knowledge_base_id,
        ) || null
      );
    }
    if (knowledgeBaseFilter !== '__all__') {
      return (
        visibleKnowledgeBases.find((item) => item.id === knowledgeBaseFilter) ||
        null
      );
    }
    return visibleKnowledgeBases[0] || null;
  }, [knowledgeBaseFilter, selectedDocument, visibleKnowledgeBases]);
  const filteredKnowledgeBases = useMemo(() => {
    const query = documentSearch.trim().toLowerCase();
    if (!query) return visibleKnowledgeBases;
    return visibleKnowledgeBases.filter((item) => {
      const searchable = [
        item.name,
        item.description,
        item.status,
        item.version,
        resourceCreatorName(item),
        item.branch_sync_state,
        item.document_count,
        item.bucket_count,
        item.chunk_count,
      ]
        .filter((value) => value !== undefined && value !== null)
        .join(' ')
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [documentSearch, visibleKnowledgeBases]);

  const pageTitle = isOverallAgent ? '知识库广场' : '知识库';
  const listLabel = isOverallAgent ? '知识库广场列表' : '知识库列表';
  const listEmptyText =
    panelState.bases === 'error'
      ? '加载失败，请重试'
      : panelState.bases === 'loading'
        ? '加载中'
        : isOverallAgent
          ? '暂无知识库，点击「新增」创建一个吧'
          : '当前员工暂无知识库';

  const stats = useMemo(
    () => ({
      total: visibleKnowledgeBases.length,
      active: visibleKnowledgeBases.filter(
        (item) => item.status === 'active' || item.status === 'published',
      ).length,
      archived: visibleKnowledgeBases.filter(
        (item) => item.status === 'archived',
      ).length,
      documents: visibleKnowledgeBases.reduce(
        (sum, item) => sum + (item.document_count || 0),
        0,
      ),
    }),
    [visibleKnowledgeBases],
  );

  const pagination = useClientPagination(
    filteredKnowledgeBases,
    KNOWLEDGE_PAGE_SIZE,
    documentSearch,
  );

  useEffect(() => {
    void loadAgentScope();
  }, [currentUser?.id]);

  useEffect(() => {
    if (!agentScopeLoaded) return;
    const resolvedAgentId = resolveKnowledgeAgentScope(
      agents,
      currentUser,
      isEnterpriseAdmin,
      agentId,
    );
    if (resolvedAgentId !== agentId) {
      clearKnowledgeViewState();
      applyResolvedAgentScope(resolvedAgentId);
      return;
    }
    if (!isEnterpriseAdmin(currentUser) && !resolvedAgentId) {
      clearKnowledgeViewState();
      return;
    }
    void refresh(effectiveKnowledgeAgentId(agents, resolvedAgentId));
    return () => {
      refreshSequence.current += 1;
    };
  }, [agentScopeLoaded, agentId, agents, currentUser?.id]);

  useEffect(() => {
    api
      .get<ModelConfigRead[]>(
        `/api/enterprise/model-configs?tenant_id=${TENANT_ID}`,
      )
      .then((items) => {
        const enabled = items.filter((item) => item.enabled);
        setModelConfigs(enabled);
        setSelectedSearchModelId((current) => {
          if (current && enabled.some((item) => item.id === current))
            return current;
          const fallback =
            enabled.find((item) => item.is_default)?.id || enabled[0]?.id || '';
          if (fallback) {
            window.localStorage.setItem(
              `${KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY}:${TENANT_ID}`,
              fallback,
            );
          }
          return fallback;
        });
      })
      .catch(() => setModelConfigs([]));
  }, []);

  useEffect(() => {
    if (searchParams.get('add') !== 'plaza') return;
    if (agents.length === 0) return;
    const resourceId = searchParams.get('resourceId') || undefined;
    if (isOverallAgent) {
      notify.warning('请先选择一个数字员工，再从广场复制知识库');
    } else {
      void openImportKnowledgeBases('plaza', resourceId);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('add');
    next.delete('resourceId');
    setSearchParams(next, { replace: true });
  }, [agents.length, isOverallAgent, searchParams, setSearchParams]);

  useEffect(() => {
    if (
      knowledgeBaseFilter !== '__all__' &&
      !visibleKnowledgeBases.some((item) => item.id === knowledgeBaseFilter)
    ) {
      setKnowledgeBaseFilter('__all__');
    }
  }, [visibleKnowledgeBases, knowledgeBaseFilter]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next =
        (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener(
      'ultrarag-enterprise-agent-scope-change',
      onScopeChange,
    );
    return () =>
      window.removeEventListener(
        'ultrarag-enterprise-agent-scope-change',
        onScopeChange,
      );
  }, []);

  function applyResolvedAgentScope(nextAgentId: string) {
    if (nextAgentId === agentId) return;
    if (nextAgentId) {
      persistSharedAgentScope(nextAgentId, currentUser?.id);
    } else {
      clearSharedAgentScope(currentUser?.id);
    }
    setAgentId(nextAgentId);
    emitAgentScopeChange(nextAgentId);
  }

  function clearKnowledgeViewState() {
    refreshSequence.current += 1;
    setDocuments([]);
    setKnowledgeBases([]);
    setSelectedDocument(null);
    setBuckets([]);
    setOkfConcepts([]);
    setOkfLintIssues([]);
    setSearchResult(null);
  }

  async function loadAgentScope() {
    setAgentScopeLoaded(false);
    try {
      const agentRows = await loadEmployeeDirectory();
      setAgents(agentRows);
      const resolvedAgentId = resolveKnowledgeAgentScope(
        agentRows,
        currentUser,
        isEnterpriseAdmin,
        agentId,
      );
      if (resolvedAgentId !== agentId) {
        clearKnowledgeViewState();
        applyResolvedAgentScope(resolvedAgentId);
      }
      setAgentScopeLoaded(true);
    } catch (error) {
      clearKnowledgeViewState();
      notify.error(error instanceof Error ? error.message : '加载员工失败');
      setAgentScopeLoaded(true);
    }
  }

  async function refresh(
    scopedAgentId = effectiveAgentId,
    preferredDocument: KnowledgeDocumentRead | null = selectedDocument,
  ) {
    if (!agentScopeLoaded) return;
    if (!isEnterpriseAdmin(currentUser) && !scopedAgentId) {
      clearKnowledgeViewState();
      // No scope means "nothing to list", not "still loading" — keep the
      // stat cards at 0 instead of an indefinite placeholder.
      setPanelState({ bases: 'ready', documents: 'ready' });
      return;
    }
    setLoading(true);
    const sequence = ++refreshSequence.current;
    const isCurrentRefresh = () => sequence === refreshSequence.current;
    setPanelErrors({});
    setPanelState({ bases: 'loading', documents: 'loading' });
    setDocuments([]);
    setKnowledgeBases([]);
    setSelectedDocument(null);
    setBuckets([]);
    try {
      const suffix = scopedAgentId
        ? `&agent_id=${encodeURIComponent(scopedAgentId)}`
        : '';
      async function loadPanel<T>(
        key: 'bases' | 'documents',
        path: string,
        apply: (value: T) => void,
      ) {
        try {
          const rows = await api.get<T>(path);
          if (!isCurrentRefresh()) return null;
          apply(rows);
          setPanelState((state) => ({ ...state, [key]: 'ready' }));
          return rows;
        } catch (error) {
          if (!isCurrentRefresh()) return null;
          const message =
            error instanceof Error ? error.message : '加载失败，请重试';
          setPanelErrors((errors) => ({ ...errors, [key]: message }));
          setPanelState((state) => ({ ...state, [key]: 'error' }));
          notify.error(message);
          return null;
        }
      }
      const [docResult, kbResult] = await Promise.all([
        loadPanel<KnowledgeDocumentRead[]>(
          'documents',
          `/api/enterprise/knowledge/documents?tenant_id=${TENANT_ID}${suffix}`,
          setDocuments,
        ),
        loadPanel<KnowledgeBaseRead[]>(
          'bases',
          `/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}${suffix}`,
          setKnowledgeBases,
        ),
      ]);
      if (!isCurrentRefresh()) return;
      const docRows = docResult || [];
      const kbRows = kbResult || [];
      const scopedDocRows =
        knowledgeBaseFilter === '__all__'
          ? docRows
          : docRows.filter(
              (item) => item.knowledge_base_id === knowledgeBaseFilter,
            );
      const current = preferredDocument
        ? scopedDocRows.find((item) => item.id === preferredDocument.id) ||
          scopedDocRows.find(
            (item) =>
              item.knowledge_base_id === preferredDocument.knowledge_base_id &&
              item.filename === preferredDocument.filename,
          ) ||
          scopedDocRows[0] ||
          null
        : scopedDocRows[0] || null;
      setSelectedDocument(current);
      if (current) {
        await loadBuckets(current, false);
      } else {
        setBuckets([]);
        const visibleKbRows = kbRows.filter(
          (item) => !isEmptyDefaultKnowledgeBase(item),
        );
        const fallbackKnowledgeBaseId =
          knowledgeBaseFilter !== '__all__'
            ? knowledgeBaseFilter
            : visibleKbRows[0]?.id || '';
        await loadOkfConcepts(fallbackKnowledgeBaseId, false);
      }
    } catch (error) {
      if (isCurrentRefresh())
        notify.error(error instanceof Error ? error.message : '刷新知识库失败');
    } finally {
      if (isCurrentRefresh()) setLoading(false);
    }
  }

  async function loadBuckets(document: KnowledgeDocumentRead, select = true) {
    if (select) setSelectedDocument(document);
    setBuckets([]);
    setSearchResult(null);
    try {
      const [rows] = await Promise.all([
        api.get<KnowledgeBucketRead[]>(
          `/api/enterprise/knowledge/documents/${document.id}/buckets?tenant_id=${TENANT_ID}${effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : ''}`,
        ),
        loadOkfConcepts(document.knowledge_base_id, false),
      ]);
      setBuckets(rows);
    } catch (error) {
      setBuckets([]);
      notify.error(error instanceof Error ? error.message : '加载内部索引失败');
    }
  }

  async function loadOkfConcepts(knowledgeBaseId?: string, showLoading = true) {
    if (!knowledgeBaseId) {
      setOkfConcepts([]);
      setOkfLintIssues([]);
      return;
    }
    if (showLoading) setOkfLoading(true);
    const suffix = effectiveAgentId
      ? `&agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    try {
      const rows = await api.get<KnowledgeConceptRead[]>(
        `/api/enterprise/knowledge-bases/${knowledgeBaseId}/okf/concepts?tenant_id=${TENANT_ID}${suffix}`,
      );
      setOkfConcepts(rows);
      setOkfLintIssues([]);
    } catch (error) {
      setOkfConcepts([]);
      if (hasApiErrorStatus(error, 404)) {
        setOkfLintIssues([]);
        return;
      }
      notify.error(error instanceof Error ? error.message : '加载知识图谱失败');
    } finally {
      if (showLoading) setOkfLoading(false);
    }
  }

  function selectKnowledgeBase(knowledgeBaseId: string) {
    setKnowledgeBaseFilter(knowledgeBaseId);
    const nextDocument =
      knowledgeBaseId === '__all__'
        ? documents[0] || null
        : documents.find(
            (item) => item.knowledge_base_id === knowledgeBaseId,
          ) || null;
    if (nextDocument) {
      void loadBuckets(nextDocument);
      return;
    }
    setSelectedDocument(null);
    setBuckets([]);
    setSearchResult(null);
    void loadOkfConcepts(
      knowledgeBaseId === '__all__' ? undefined : knowledgeBaseId,
    );
  }

  async function runKnowledgeSearch() {
    const query = searchQuery.trim();
    if (!query) {
      notify.warning('请输入要调试的知识问题');
      return;
    }
    setSearchLoading(true);
    try {
      const response = await api.post<KnowledgeSearchResponse>(
        '/api/enterprise/knowledge/search',
        {
          tenant_id: TENANT_ID,
          agent_id: effectiveAgentId || undefined,
          knowledge_base_ids:
            knowledgeBaseFilter !== '__all__'
              ? [knowledgeBaseFilter]
              : selectedDocument?.knowledge_base_id
                ? [selectedDocument.knowledge_base_id]
                : undefined,
          query,
          model_config_id: selectedSearchModelId || undefined,
          mode: 'debug',
          max_depth: 3,
          need_evidence_pack: true,
        },
      );
      setSearchResult(response);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '知识检索失败');
    } finally {
      setSearchLoading(false);
    }
  }

  async function openImportKnowledgeBases(
    mode: 'plaza' | 'employee' = 'plaza',
    selectedResourceId?: string,
  ) {
    try {
      const agentRows = agents.length ? agents : await loadEmployeeDirectory();
      setAgents(agentRows);
      setImportMode(mode);
      const firstSource =
        mode === 'plaza'
          ? openGalleryAgentId(agentRows)
          : visibleEmployeeAgents(agentRows, currentUser, {
              activeOnly: true,
              excludeAgentId: agentId,
            })[0]?.id || '';
      setImportSourceAgentId(firstSource);
      setImportSelectedKnowledgeBaseIds([]);
      setImportOpen(true);
      if (firstSource) {
        const sourceRows = await loadImportSourceKnowledgeBases(firstSource);
        if (
          selectedResourceId &&
          sourceRows.some((item) => item.id === selectedResourceId)
        ) {
          setImportSelectedKnowledgeBaseIds([selectedResourceId]);
        }
      } else {
        setImportSourceKnowledgeBases([]);
      }
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载员工失败');
    }
  }

  async function loadImportSourceKnowledgeBases(
    sourceAgentId: string,
  ): Promise<KnowledgeBaseRead[]> {
    setImportSourceKnowledgeBases([]);
    setImportSelectedKnowledgeBaseIds([]);
    if (!sourceAgentId) return [];
    try {
      const rows = await api.get<KnowledgeBaseRead[]>(
        `/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(sourceAgentId)}`,
      );
      const activeRows = rows.filter((item) => item.status === 'active');
      setImportSourceKnowledgeBases(activeRows);
      return activeRows;
    } catch (error) {
      notify.error(
        error instanceof Error ? error.message : '加载来源知识库失败',
      );
      return [];
    }
  }

  async function submitImportKnowledgeBases() {
    if (!agentId) {
      notify.warning('请先选择一个数字员工');
      return;
    }
    if (!importSourceAgentId) {
      notify.warning(
        importMode === 'plaza' ? '请选择开放广场' : '请选择来源员工',
      );
      return;
    }
    if (importSelectedKnowledgeBaseIds.length === 0) {
      notify.warning('请选择要复制的知识库');
      return;
    }
    setImportLoading(true);
    try {
      const result = await api.post<{
        imported: Array<Record<string, unknown>>;
        missing: Array<Record<string, unknown>>;
      }>(`/api/enterprise/agents/${agentId}/resources/import`, {
        tenant_id: TENANT_ID,
        source_agent_id: importSourceAgentId,
        resource_type: 'knowledge_base',
        resource_ids: importSelectedKnowledgeBaseIds,
      });
      const importedCount = result.imported?.length || 0;
      const missingCount = result.missing?.length || 0;
      notify.success(
        `已复制 ${importedCount} 个知识库${missingCount ? `，${missingCount} 个未复制` : ''}`,
      );
      setImportOpen(false);
      await refresh();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '复制知识库失败');
    } finally {
      setImportLoading(false);
    }
  }

  function handleCreateAction(key: string) {
    if (key === 'blank') {
      navigate('/enterprise/knowledge/new');
      return;
    }
    if (key === 'okf') {
      setOkfImportOpen(true);
      return;
    }
    if (key === 'plaza') {
      void openImportKnowledgeBases('plaza');
      return;
    }
    if (key === 'employee') {
      void openImportKnowledgeBases('employee');
    }
  }

  async function importOkfFile(file: File) {
    try {
      const contentBase64 = await fileToBase64(file);
      await api.post('/api/enterprise/knowledge/okf/import', {
        tenant_id: TENANT_ID,
        agent_id: effectiveAgentId || undefined,
        knowledge_base_id: selectedKnowledgeBase?.id,
        filename: file.name,
        content_base64: contentBase64,
      });
      notify.success('已导入知识库备份包');
      setOkfImportOpen(false);
      await refresh();
    } catch (error) {
      notify.error(
        error instanceof Error ? error.message : '导入知识库备份包失败',
      );
    }
  }

  async function exportOkfBundle(targetKnowledgeBase = selectedKnowledgeBase) {
    if (!targetKnowledgeBase) {
      notify.warning('请先选择知识库');
      return;
    }
    const suffix = effectiveAgentId
      ? `&agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    try {
      const blob = await api.blob(
        `/api/enterprise/knowledge-bases/${targetKnowledgeBase.id}/okf/export?tenant_id=${TENANT_ID}${suffix}`,
      );
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${targetKnowledgeBase.name || targetKnowledgeBase.id}-okf.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      notify.success('已导出知识库备份包');
    } catch (error) {
      notify.error(
        error instanceof Error ? error.message : '导出知识库备份包失败',
      );
    }
  }

  async function lintOkfBundle(targetKnowledgeBase = selectedKnowledgeBase) {
    if (!targetKnowledgeBase) {
      notify.warning('请先选择知识库');
      return;
    }
    if (targetKnowledgeBase.id !== selectedKnowledgeBase?.id) {
      selectKnowledgeBase(targetKnowledgeBase.id);
    }
    const suffix = effectiveAgentId
      ? `&agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    setOkfLoading(true);
    try {
      const result = await api.post<{
        status: string;
        issue_count: number;
        issues: OkfLintIssue[];
      }>(
        `/api/enterprise/knowledge-bases/${targetKnowledgeBase.id}/okf/lint?tenant_id=${TENANT_ID}${suffix}`,
      );
      setOkfLintIssues(result.issues || []);
      setOkfLintKnowledgeBase(targetKnowledgeBase);
      setOkfLintReportOpen(true);
      notify.success(
        result.issue_count
          ? `发现 ${result.issue_count} 个待处理建议`
          : '知识图谱检查通过',
      );
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '知识图谱检查失败');
    } finally {
      setOkfLoading(false);
    }
  }

  function openConceptEditor(row: KnowledgeConceptRead) {
    setEditingConcept(row);
    setConceptDraft(row.content_md || '');
  }

  function openConceptViewer(row: KnowledgeConceptRead) {
    setViewingConcept(row);
  }

  function editViewingConcept() {
    if (!viewingConcept) return;
    const concept = viewingConcept;
    setViewingConcept(null);
    openConceptEditor(concept);
  }

  async function saveConcept() {
    if (!editingConcept || !selectedKnowledgeBase) return;
    const suffix = effectiveAgentId
      ? `?agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    try {
      const next = await api.put<KnowledgeConceptRead>(
        `/api/enterprise/knowledge-bases/${selectedKnowledgeBase.id}/okf/concepts/${conceptPath(editingConcept.concept_id)}${suffix}`,
        {
          tenant_id: TENANT_ID,
          document_id: editingConcept.document_id,
          content_md: conceptDraft,
          status: editingConcept.status,
        },
      );
      setOkfConcepts((current) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
      setEditingConcept(null);
      notify.success('已保存知识图谱');
      await loadOkfConcepts(selectedKnowledgeBase.id, false);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存知识图谱失败');
    }
  }

  function openEditKnowledgeBase(row: KnowledgeBaseRead) {
    setEditingKnowledgeBase(row);
    setKnowledgeBaseDraft({
      name: row.name,
      description: row.description || '',
      status: row.status === 'archived' ? 'archived' : 'active',
      capability_scope: normalizeCapabilityScope(row.capability_scope),
    });
  }

  async function saveKnowledgeBase() {
    if (!editingKnowledgeBase) return;
    const suffix = effectiveAgentId
      ? `?agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    try {
      const next = await api.put<KnowledgeBaseRead>(
        `/api/enterprise/knowledge-bases/${editingKnowledgeBase.id}${suffix}`,
        {
          tenant_id: TENANT_ID,
          name: knowledgeBaseDraft.name,
          description: knowledgeBaseDraft.description,
          status: knowledgeBaseDraft.status,
          capability_scope: knowledgeBaseDraft.capability_scope,
        },
      );
      setKnowledgeBases((current) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
      setEditingKnowledgeBase(null);
      notify.success('已保存知识库');
      await refresh();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存知识库失败');
    }
  }

  async function setKnowledgeBaseStatus(
    row: KnowledgeBaseRead,
    active: boolean,
  ) {
    const suffix = effectiveAgentId
      ? `?agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    try {
      const next = await api.put<KnowledgeBaseRead>(
        `/api/enterprise/knowledge-bases/${row.id}${suffix}`,
        {
          tenant_id: TENANT_ID,
          status: active ? 'active' : 'archived',
        },
      );
      setKnowledgeBases((current) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
      notify.success(active ? '已上线知识库' : '已下线知识库');
      await refresh();
    } catch (error) {
      notify.error(
        error instanceof Error
          ? error.message
          : active
            ? '上线失败'
            : '下线失败',
      );
    }
  }

  function deleteKnowledgeBase(row: KnowledgeBaseRead) {
    setDeleteKbTarget(row);
  }

  async function runDeleteKnowledgeBase() {
    const row = deleteKbTarget;
    if (!row) return;
    const branchMode = !isOverallAgent;
    const suffix = effectiveAgentId
      ? `&agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    try {
      await api.delete(
        `/api/enterprise/knowledge-bases/${row.id}?tenant_id=${TENANT_ID}${suffix}`,
      );
      notify.success(branchMode ? '已移除知识库' : '已删除知识库');
      setDeleteKbTarget(null);
      await refresh();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '删除失败');
    }
  }

  async function openKnowledgeBaseVersions(row: KnowledgeBaseRead) {
    const suffix = effectiveAgentId
      ? `&agent_id=${encodeURIComponent(effectiveAgentId)}`
      : '';
    try {
      const versions = await api.get<KnowledgeBaseVersionRead[]>(
        `/api/enterprise/knowledge-bases/${row.id}/versions?tenant_id=${TENANT_ID}${suffix}`,
      );
      setVersionKnowledgeBase(row);
      setKnowledgeBaseVersions(versions);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载版本失败');
    }
  }

  async function syncKnowledgeBaseFromOverall(row: KnowledgeBaseRead) {
    if (!agentId) {
      notify.warning('请先选择员工');
      return;
    }
    try {
      await api.post(
        `/api/enterprise/knowledge-bases/${row.id}/sync-from-overall?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(agentId)}`,
      );
      notify.success('已从广场同步');
      await refresh();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '同步失败');
    }
  }

  async function promoteKnowledgeBaseToOverall(row: KnowledgeBaseRead) {
    if (!agentId) {
      notify.warning('请先选择员工');
      return;
    }
    try {
      await api.post(
        `/api/enterprise/knowledge-bases/${row.id}/promote-to-overall?tenant_id=${TENANT_ID}&agent_id=${encodeURIComponent(agentId)}`,
      );
      notify.success('已发布到广场');
      await refresh();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '推送失败');
    }
  }

  async function rollbackKnowledgeBaseVersion(
    version: KnowledgeBaseVersionRead,
  ) {
    if (!versionKnowledgeBase || !effectiveAgentId) return;
    try {
      await api.post(
        `/api/enterprise/knowledge-bases/${versionKnowledgeBase.id}/rollback`,
        {
          tenant_id: TENANT_ID,
          agent_id: effectiveAgentId,
          version: version.version,
        },
      );
      notify.success(`已回滚到 ${version.version}`);
      await openKnowledgeBaseVersions(versionKnowledgeBase);
      await refresh();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '回滚失败');
    }
  }

  function openEditDocument(row: KnowledgeDocumentRead) {
    const metadata = row.metadata || {};
    const documentCard = isRecord(metadata.document_card)
      ? metadata.document_card
      : {};
    const fallback = String(documentCard.summary || row.title || row.filename);
    setEditingDocument(row);
    setDocumentDraft({
      title: row.title || row.filename,
      status: row.status,
      content_md: documentSourceMarkdown(row, fallback),
    });
    setDocumentEditorMode('edit');
  }

  async function saveDocument() {
    if (!editingDocument) return;
    if (!documentDraft.content_md.trim()) {
      notify.warning('文档正文不能为空');
      return;
    }
    setContentSaving(true);
    try {
      const query = effectiveAgentId
        ? `?agent_id=${encodeURIComponent(effectiveAgentId)}`
        : '';
      const next = await api.put<KnowledgeDocumentRead>(
        `/api/enterprise/knowledge/documents/${editingDocument.id}${query}`,
        {
          tenant_id: TENANT_ID,
          title: documentDraft.title,
          status: documentDraft.status,
          content_md: documentDraft.content_md,
          expected_updated_at: editingDocument.updated_at,
        },
      );
      setEditingDocument(null);
      await refresh(effectiveAgentId, next);
      notify.success('已保存并重建知识索引');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存文档失败');
    } finally {
      setContentSaving(false);
    }
  }

  async function openBucketEditor(row: KnowledgeBucketRead) {
    setEditingBucket(row);
    setBucketDraft({ title: row.title, summary: row.summary });
    try {
      const chunks = await api.get<KnowledgeChunkRead[]>(
        `/api/enterprise/knowledge/buckets/${row.id}/chunks?tenant_id=${TENANT_ID}${effectiveAgentId ? `&agent_id=${encodeURIComponent(effectiveAgentId)}` : ''}`,
      );
      setBucketChunks(chunks);
      setChunkDrafts(
        Object.fromEntries(
          chunks.map((chunk) => [
            chunk.id,
            { content: chunk.content, summary: chunk.summary || '' },
          ]),
        ),
      );
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载引用来源失败');
    }
  }

  async function saveBucketAndChunks() {
    if (!editingBucket) return;
    setContentSaving(true);
    try {
      await api.put<KnowledgeBucketRead>(
        `/api/enterprise/knowledge/buckets/${editingBucket.id}`,
        {
          tenant_id: TENANT_ID,
          title: bucketDraft.title,
          summary: bucketDraft.summary,
        },
      );
      for (const chunk of bucketChunks) {
        await api.put<KnowledgeChunkRead>(
          `/api/enterprise/knowledge/chunks/${chunk.id}`,
          {
            tenant_id: TENANT_ID,
            content: chunkDrafts[chunk.id]?.content ?? chunk.content,
            summary: chunkDrafts[chunk.id]?.summary ?? chunk.summary,
          },
        );
      }
      notify.success('已保存知识内容');
      setEditingBucket(null);
      if (selectedDocument) await loadBuckets(selectedDocument, false);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存知识内容失败');
    } finally {
      setContentSaving(false);
    }
  }

  function renderKnowledgeBaseActions(item: KnowledgeBaseRead) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="知识库操作"
          className="grid size-7 place-items-center rounded-[8px] text-[#858b9c] transition-colors outline-none hover:bg-black/5 hover:text-[#18181a]"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreOutlined />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
          {canManageCurrentScope && (
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => openEditKnowledgeBase(item)}
            >
              <EditOutlined />
              详情
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onSelect={() => void openKnowledgeBaseVersions(item)}
          >
            <HistoryOutlined />
            版本管理
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onSelect={() => void exportOkfBundle(item)}
          >
            <DownloadOutlined />
            导出知识库备份包
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            disabled={okfLoading}
            onSelect={() => void lintOkfBundle(item)}
          >
            <AuditOutlined />
            知识图谱检查
          </DropdownMenuItem>
          {!isOverallAgent && (
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => void syncKnowledgeBaseFromOverall(item)}
            >
              从广场同步
            </DropdownMenuItem>
          )}
          {!isOverallAgent && (
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => void promoteKnowledgeBaseToOverall(item)}
            >
              发布到广场
            </DropdownMenuItem>
          )}
          {canManageCurrentScope && (
            <>
              {item.status === 'archived' ? (
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  onSelect={() => void setKnowledgeBaseStatus(item, true)}
                >
                  <PlayCircleOutlined />
                  上线
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  onSelect={() => void setKnowledgeBaseStatus(item, false)}
                >
                  <PauseCircleOutlined />
                  下线
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="my-[2px] bg-[#eef0f4]" />
              <DropdownMenuItem
                variant="destructive"
                className={MENU_ITEM_DANGER_CLASS}
                onSelect={() => deleteKnowledgeBase(item)}
              >
                <DeleteOutlined />
                {isOverallAgent ? '删除' : '移除'}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const knowledgeBaseColumns: DataTableColumn<KnowledgeBaseRead>[] = [
    {
      key: 'name',
      title: '名称',
      render: (row) => (
        <div className="min-w-0">
          <strong
            {...USER_CONTENT_ATTRIBUTES}
            className="block truncate text-[13px] font-medium text-[#18181a]"
          >
            {row.name}
          </strong>
          {row.description ? (
            <span
              {...USER_CONTENT_ATTRIBUTES}
              className="mt-[2px] block truncate text-[12px] text-[#858b9c]"
            >
              {row.description}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 100,
      render: (row) => statusTag(row.status),
    },
    {
      key: 'capability_scope',
      title: '能力范围',
      width: 105,
      render: (row) => <CapabilityScopeBadge value={row.capability_scope} />,
    },
    {
      key: 'creator',
      title: '创建者',
      width: 120,
      render: (row) => (
        <span
          {...USER_CONTENT_ATTRIBUTES}
          className="block truncate text-[#858b9c]"
          title={resourceCreatorName(row)}
        >
          {resourceCreatorName(row) || '-'}
        </span>
      ),
    },
    {
      key: 'content_stats',
      title: '版本与内容',
      width: 260,
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
          {row.version ? <KTag>v{row.version}</KTag> : <KTag>无版本</KTag>}
          <KTag>{row.document_count ?? 0} 文档</KTag>
          <KTag>{row.bucket_count ?? 0} 目录</KTag>
          <KTag>{row.chunk_count ?? 0} 引用</KTag>
        </div>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 70,
      align: 'right',
      render: (row) => renderKnowledgeBaseActions(row),
    },
  ];

  const renderMobileKnowledgeBaseCard = (item: KnowledgeBaseRead) => (
    <article
      className={cn(
        MOBILE_CARD_CLASS,
        'cursor-pointer',
        selectedKnowledgeBase?.id === item.id && 'ring-2 ring-[#18181a]',
      )}
      key={item.id}
      onClick={() => selectKnowledgeBase(item.id)}
    >
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <strong
            {...USER_CONTENT_ATTRIBUTES}
            className="block truncate text-[14px] font-semibold text-[#18181a]"
          >
            {item.name}
          </strong>
          <span
            {...(item.description ? USER_CONTENT_ATTRIBUTES : {})}
            className="mt-[2px] block truncate text-[12px] text-[#858b9c]"
          >
            {item.description || '未填写描述'}
          </span>
          <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">
            创建者：
            <span {...USER_CONTENT_ATTRIBUTES}>
              {resourceCreatorName(item) || '-'}
            </span>
          </span>
        </div>
        <span
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {renderKnowledgeBaseActions(item)}
        </span>
      </div>
      <div className="mt-[10px] flex flex-wrap items-center gap-[6px]">
        {statusTag(item.status)}
        <CapabilityScopeBadge value={item.capability_scope} />
        {item.version ? <KTag>v{item.version}</KTag> : null}
        <KTag>{item.document_count} 文档</KTag>
        <KTag>{item.bucket_count} 目录</KTag>
        <KTag>{item.chunk_count} 引用</KTag>
      </div>
    </article>
  );

  if (!agentScopeLoaded) return <CapabilityScopeLoading />;

  return (
    <div
      className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]"
      aria-busy={loading}
    >
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={pageTitle}
        description={
          isOverallAgent
            ? '维护知识库广场中的知识库、知识图谱与检索调试。'
            : '维护当前数字员工的知识库、知识图谱与检索调试。'
        }
      />

      <div className="mt-[20px] mb-[16px] flex flex-wrap items-center justify-end gap-[12px]">
        <UIButton
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
          className={OUTLINE_ACTION_BUTTON_CLASS}
        >
          <IconRefresh
            className={cn('size-[14px]', loading && 'animate-spin')}
          />
          刷新
        </UIButton>
        {canManageCurrentScope && (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-guide-target="knowledge-create"
              className="flex h-[34px] items-center gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white outline-none transition-colors hover:bg-[#303030]"
            >
              <IconAdd className="size-[14px]" />
              新增
              <IconChevronDown className="size-[12px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => handleCreateAction('blank')}
              >
                <FileAddOutlined />
                新建知识库
              </DropdownMenuItem>
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => handleCreateAction('okf')}
              >
                <FileMarkdownOutlined />
                导入知识库备份包
              </DropdownMenuItem>

            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-white p-[18px_18px_24px_18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]">
        {Object.keys(panelErrors).length > 0 && (
          <div
            role="alert"
            className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <p>部分数据加载失败，其他模块仍可使用</p>
            {Object.entries(panelErrors).map(([key, message]) => (
              <p key={key}>
                {key === 'bases' ? '知识库' : '文档'}：{message}
              </p>
            ))}
          </div>
        )}
        <div
          className="flex flex-wrap items-stretch gap-[20px]"
          aria-label="知识库统计"
        >
          <StatCard
            label="知识库总数"
            value={panelState.bases === 'ready' ? stats.total : '—'}
          />
          <StatCard
            label="已上线"
            value={panelState.bases === 'ready' ? stats.active : '—'}
            tone="green"
          />
          <StatCard
            label="已下线"
            value={panelState.bases === 'ready' ? stats.archived : '—'}
          />
          <StatCard
            label="文档总数"
            value={panelState.documents === 'ready' ? stats.documents : '—'}
          />
        </div>

        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconFolder className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">
              {listLabel}
            </span>
          </div>

          <label className="flex h-[34px] w-[300px] max-w-full items-center gap-[8px] overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] transition-colors focus-within:border-[#18181a]">
            <IconSearch className="size-[14px] shrink-0 text-[#858b9c]" />
            <input
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              value={documentSearch}
              placeholder="搜索知识库名称、描述、状态或版本"
              onChange={(event) => setDocumentSearch(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
            />
            {documentSearch && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setDocumentSearch('')}
                className="grid size-[16px] shrink-0 place-items-center text-[#c0c6d4] hover:text-[#858b9c]"
              >
                <IconClear className="size-[14px]" />
              </button>
            )}
          </label>

          <div className="grid gap-[10px] md:hidden">
            {filteredKnowledgeBases.length ? (
              pagination.pagedItems.map(renderMobileKnowledgeBaseCard)
            ) : (
              <div className="py-[40px] text-center text-[13px] text-[#858b9c]">
                {listEmptyText}
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <DataTable
              aria-label="知识库列表"
              columns={knowledgeBaseColumns}
              data={pagination.pagedItems}
              rowKey={(row) => row.id}
              loading={loading}
              emptyText={listEmptyText}
              onRowClick={(row) => selectKnowledgeBase(row.id)}
            />
          </div>

          {filteredKnowledgeBases.length > 0 && (
            <Paginator
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </div>
      </div>

      <div className="mt-[16px] flex flex-col gap-[16px]">
        <KCard title="知识图谱">
          {!selectedDocument ? (
            <EmptyState description="选择知识库后查看文档卡片、知识索引和知识图谱" />
          ) : (
            <目录索引Overview
              document={selectedDocument}
              knowledgeBase={selectedKnowledgeBase}
              buckets={buckets}
              okfConcepts={okfConcepts}
              canEdit={canManageCurrentScope}
              onEditDocument={openEditDocument}
              onEditBucket={openBucketEditor}
              onViewConcept={openConceptViewer}
              onEditConcept={openConceptEditor}
            />
          )}
        </KCard>

        <KCard title="渐进检索调试">
          <div className="flex w-full flex-col gap-[14px]">
            <div className="flex flex-wrap items-center gap-[10px]">
              <label
                className={cn(
                  SEARCH_COMBO_CLASS,
                  'min-w-[280px] flex-1 max-w-[560px]',
                )}
              >
                <input
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  className={SEARCH_COMBO_INPUT_CLASS}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void runKnowledgeSearch();
                    }
                  }}
                  placeholder="输入知识问题"
                />
                <button
                  type="button"
                  className={SEARCH_COMBO_BUTTON_CLASS}
                  disabled={searchLoading}
                  onClick={() => void runKnowledgeSearch()}
                >
                  {searchLoading ? '检索中…' : '检索'}
                </button>
              </label>
              <ModelConfigDropdown
                models={modelConfigs}
                value={selectedSearchModelId}
                onChange={(modelId) => {
                  setSelectedSearchModelId(modelId);
                  window.localStorage.setItem(
                    `${KNOWLEDGE_SEARCH_MODEL_STORAGE_KEY}:${TENANT_ID}`,
                    modelId,
                  );
                }}
                buttonClassName="h-[34px]"
              />
            </div>
            <KnowledgeSearchDebug
              result={searchResult}
              loading={searchLoading}
            />
          </div>
        </KCard>
      </div>

      <ResourceImportDialog
        open={importOpen}
        loading={importLoading}
        icon={<DatabaseOutlined />}
        title={
          importMode === 'plaza' ? '从广场复制知识库' : '从数字员工复制知识库'
        }
        sourcePlaceholder={
          importMode === 'plaza' ? '选择开放广场' : '选择来源员工'
        }
        sources={
          importMode === 'plaza'
            ? openGalleryImportSourceOptions(agents, '开放广场')
            : visibleEmployeeAgents(agents, currentUser, {
                activeOnly: true,
                excludeAgentId: agentId,
              }).map((item) => ({ value: item.id, label: item.name }))
        }
        sourceId={importSourceAgentId}
        itemsLabel="选择知识库"
        items={importSourceKnowledgeBases.map((item) => ({
          id: item.id,
          label: (
            <>
              <span {...USER_CONTENT_ATTRIBUTES}>{item.name}</span>
              <span className="text-[#858b9c]">
                {' '}
                · {item.version || '1.0.0'}
              </span>
            </>
          ),
        }))}
        selectedIds={importSelectedKnowledgeBaseIds}
        emptyText="没有可复制的知识库"
        note={
          importMode === 'plaza'
            ? '从开放广场复制可用知识库；不可复制内容不会出现在列表。'
            : '从数字员工复制可用知识库；不可见内容不会出现在列表。'
        }
        submitText="复制"
        onSourceChange={(value) => {
          setImportSourceAgentId(value);
          void loadImportSourceKnowledgeBases(value);
        }}
        onSelectedChange={setImportSelectedKnowledgeBaseIds}
        onClose={() => setImportOpen(false)}
        onSubmit={() => void submitImportKnowledgeBases()}
      />
      <KDialog
        open={okfImportOpen}
        title="导入知识库备份包"
        onClose={() => setOkfImportOpen(false)}
      >
        <FileDropzone
          accept=".zip,.md,.markdown"
          onFiles={(files) => files[0] && void importOkfFile(files[0])}
        >
          <FileMarkdownOutlined className="mb-[8px] text-[28px] text-[#1a71ff]" />
          <p className="m-0 text-[14px] font-medium text-foreground">
            选择或拖入知识库备份包（.zip）
          </p>
          <p className="mt-[4px] mb-0 text-[12px] text-[#858b9c]">
            导入后会生成知识图谱、知识索引和引用来源。
          </p>
        </FileDropzone>
      </KDialog>
      <KDialog
        open={okfLintReportOpen}
        title={
          okfLintKnowledgeBase
            ? `知识图谱检查：${okfLintKnowledgeBase.name}`
            : '知识图谱检查'
        }
        width={820}
        onClose={() => setOkfLintReportOpen(false)}
        footer={
          <KDialogCancelButton onClick={() => setOkfLintReportOpen(false)}>
            关闭
          </KDialogCancelButton>
        }
      >
        <div className="flex flex-col gap-[14px]">
          <p className="text-[13px] leading-[1.6] text-[#858b9c]">
            用于检查当前知识库的知识图谱结构，发现断链、孤立页、重复主题等问题。检查结果仅作参考，不会自动修改数据。
          </p>
          {okfLintIssues.length === 0 ? (
            <EmptyState description="知识图谱检查通过" />
          ) : (
            <div className="grid gap-[10px] sm:grid-cols-2">
              {okfLintIssues.map((issue, index) => (
                <div
                  className="flex flex-col gap-[6px] rounded-[12px] border border-[#f4d58a] bg-[#fffaf0] p-[12px]"
                  key={`${issue.issue_type || 'issue'}-${issue.concept_id || index}`}
                >
                  <KTag color="gold">{issue.issue_type || 'warning'}</KTag>
                  <strong className="text-[13px] font-semibold wrap-break-word text-[#18181a]">
                    {issue.title || issue.concept_id || '知识图谱检查'}
                  </strong>
                  <span className="text-[12px] wrap-break-word text-[#858b9c]">
                    {issue.message || '待处理'}
                  </span>
                  {issue.concept_id ? (
                    <small className="font-mono text-[12px] wrap-break-word text-[#858b9c]">
                      {issue.concept_id}
                    </small>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </KDialog>
      <KDialog
        open={Boolean(viewingConcept)}
        title={
          viewingConcept ? (
            <WikiViewerTitle concept={viewingConcept} />
          ) : (
            '知识图谱'
          )
        }
        width="min(1040px, calc(100vw - 48px))"
        onClose={() => setViewingConcept(null)}
        footer={
          <>
            <KDialogCancelButton onClick={() => setViewingConcept(null)}>
              关闭
            </KDialogCancelButton>
            <KDialogPrimaryButton onClick={editViewingConcept}>
              <EditOutlined />
              编辑知识图谱
            </KDialogPrimaryButton>
          </>
        }
      >
        {viewingConcept && <WikiConceptViewer concept={viewingConcept} />}
      </KDialog>
      <KDialog
        open={Boolean(editingConcept)}
        title={
          editingConcept ? (
            <div className="flex min-w-0 flex-col gap-[4px]">
              <span className="text-[13px] font-semibold text-[#858b9c]">
                编辑知识图谱
              </span>
              <strong
                {...USER_CONTENT_ATTRIBUTES}
                className="line-clamp-2 text-[20px] font-semibold leading-[1.35] text-[#18181a]"
              >
                {conceptEditorTitle || editingConcept.concept_id}
              </strong>
            </div>
          ) : (
            '编辑知识图谱'
          )
        }
        width="min(1120px, calc(100vw - 48px))"
        onClose={() => setEditingConcept(null)}
        footer={
          <>
            <KDialogCancelButton onClick={() => setEditingConcept(null)} />
            <KDialogPrimaryButton onClick={() => void saveConcept()}>
              保存
            </KDialogPrimaryButton>
          </>
        }
      >
        {editingConcept && (
          <div className="grid min-w-0 grid-cols-1 gap-[16px] lg:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="flex flex-col gap-[16px] rounded-[12px] border border-[#eceef1] bg-[#fafbfc] p-[16px]">
              <div className="inline-flex w-fit items-center gap-[8px] rounded-[10px] border border-[#1a71ff]/25 bg-[#1a71ff]/8 px-[11px] py-[8px] text-[13px] font-medium text-[#1a71ff]">
                <FileMarkdownOutlined />
                <span>{conceptTypeLabel(conceptEditorType)}</span>
              </div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-[12px] gap-y-[10px]">
                <span className="text-[12px] font-semibold text-[#858b9c]">
                  页面路径
                </span>
                <strong className="text-[13px] wrap-break-word text-[#18181a]">
                  {editingConcept.concept_id}
                </strong>
                <span className="text-[12px] font-semibold text-[#858b9c]">
                  链接
                </span>
                <strong className="text-[13px] text-[#18181a]">
                  {editingConcept.links.length} 个
                </strong>
                <span className="text-[12px] font-semibold text-[#858b9c]">
                  引用
                </span>
                <strong className="text-[13px] text-[#18181a]">
                  {editingConcept.citations.length} 个
                </strong>
                <span className="text-[12px] font-semibold text-[#858b9c]">
                  更新时间
                </span>
                <strong className="text-[13px] text-[#18181a]">
                  {formatDateTime(editingConcept.updated_at, getDateLocale())}
                </strong>
              </div>
              <div className="rounded-[12px] border border-[#eceef1] bg-white p-[12px] text-[13px] leading-[1.65] text-[#858b9c]">
                知识图谱以结构化文本保存，标题和摘要会同步写入内容。
              </div>
            </aside>
            <section className="flex min-w-0 flex-col gap-[16px]">
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-[minmax(0,1.4fr)_minmax(180px,0.6fr)]">
                <label className="flex flex-col gap-[8px]">
                  <span className="text-[13px] font-semibold text-[#464c5e]">
                    页面标题
                  </span>
                  <Input
                    value={conceptEditorTitle}
                    onChange={(event) =>
                      setConceptDraft((prev) =>
                        updateOkfFrontmatterValue(
                          prev,
                          'title',
                          event.target.value,
                        ),
                      )
                    }
                    placeholder="知识图谱标题"
                  />
                </label>
                <label className="flex flex-col gap-[8px]">
                  <span className="text-[13px] font-semibold text-[#464c5e]">
                    页面类型
                  </span>
                  <UISelect
                    value={conceptEditorType}
                    onValueChange={(value) =>
                      setConceptDraft((prev) =>
                        updateOkfFrontmatterValue(prev, 'type', value),
                      )
                    }
                  >
                    <SelectTrigger
                      className={cn(SELECT_TRIGGER_CLASS, 'w-full')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from(CONCEPT_TYPE_LABELS.entries()).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </UISelect>
                </label>
                <label className="flex flex-col gap-[8px] sm:col-span-full">
                  <span className="text-[13px] font-semibold text-[#464c5e]">
                    页面摘要
                  </span>
                  <Textarea
                    value={conceptEditorDescription}
                    rows={3}
                    onChange={(event) =>
                      setConceptDraft((prev) =>
                        updateOkfFrontmatterValue(
                          prev,
                          'description',
                          event.target.value,
                        ),
                      )
                    }
                    placeholder="说明这个知识图谱沉淀了什么知识"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-[8px]">
                <span className="text-[13px] font-semibold text-[#464c5e]">
                  知识图谱源码
                </span>
                <Textarea
                  className="min-h-[420px] resize-y font-mono text-[13px] leading-[1.55]"
                  value={conceptDraft}
                  rows={18}
                  onChange={(event) => setConceptDraft(event.target.value)}
                  spellCheck={false}
                />
              </label>
            </section>
          </div>
        )}
      </KDialog>
      <KDialog
        open={Boolean(editingKnowledgeBase)}
        title="知识库详情"
        onClose={() => setEditingKnowledgeBase(null)}
        footer={
          <>
            <KDialogCancelButton
              onClick={() => setEditingKnowledgeBase(null)}
            />
            <KDialogPrimaryButton onClick={() => void saveKnowledgeBase()}>
              保存
            </KDialogPrimaryButton>
          </>
        }
      >
        <div className="flex w-full flex-col gap-[12px]">
          <Input
            value={knowledgeBaseDraft.name}
            onChange={(event) =>
              setKnowledgeBaseDraft((prev) => ({
                ...prev,
                name: event.target.value,
              }))
            }
            placeholder="知识库名称"
          />
          <Textarea
            rows={4}
            value={knowledgeBaseDraft.description}
            onChange={(event) =>
              setKnowledgeBaseDraft((prev) => ({
                ...prev,
                description: event.target.value,
              }))
            }
            placeholder="知识库描述"
          />
          <UISelect
            value={knowledgeBaseDraft.status}
            onValueChange={(value) =>
              setKnowledgeBaseDraft((prev) => ({ ...prev, status: value }))
            }
          >
            <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">上线</SelectItem>
              <SelectItem value="archived">下线</SelectItem>
            </SelectContent>
          </UISelect>
          <CapabilityScopeControl
            value={knowledgeBaseDraft.capability_scope}
            onChange={(value) =>
              setKnowledgeBaseDraft((prev) => ({
                ...prev,
                capability_scope: value,
              }))
            }
            resourceType="knowledge_base"
          />
        </div>
      </KDialog>
      <KDialog
        open={Boolean(versionKnowledgeBase)}
        title={
          versionKnowledgeBase
            ? `版本管理：${versionKnowledgeBase.name}`
            : '版本管理'
        }
        width={840}
        onClose={() => setVersionKnowledgeBase(null)}
        footer={
          <KDialogCancelButton onClick={() => setVersionKnowledgeBase(null)}>
            关闭
          </KDialogCancelButton>
        }
      >
        <DataTable
          aria-label="版本列表"
          rowKey={(row) => row.id}
          data={knowledgeBaseVersions}
          emptyText="暂无版本记录"
          columns={
            [
              { key: 'version', title: '版本', render: (row) => row.version },
              {
                key: 'name',
                title: '名称',
                render: (row) => (
                  <span {...USER_CONTENT_ATTRIBUTES}>{row.name}</span>
                ),
              },
              {
                key: 'status',
                title: '状态',
                render: (row) => statusTag(String(row.status)),
              },
              {
                key: 'is_head',
                title: 'Head',
                render: (row) =>
                  row.is_head ? <KTag color="green">当前</KTag> : null,
              },
              {
                key: 'updated_at',
                title: '更新时间',
                render: (row) => String(row.updated_at).slice(0, 10),
              },
              {
                key: 'actions',
                title: '操作',
                width: 96,
                render: (row) =>
                  !isOverallAgent && !row.is_head ? (
                    <UIButton
                      variant="outline"
                      size="sm"
                      onClick={() => void rollbackKnowledgeBaseVersion(row)}
                    >
                      回滚
                    </UIButton>
                  ) : null,
              },
            ] as DataTableColumn<KnowledgeBaseVersionRead>[]
          }
        />
      </KDialog>
      <KDialog
        open={Boolean(editingDocument)}
        title="在线编辑知识文档"
        width="min(1080px, calc(100vw - 48px))"
        onClose={() => setEditingDocument(null)}
        footer={
          <>
            <KDialogCancelButton
              disabled={contentSaving}
              onClick={() => setEditingDocument(null)}
            />
            <KDialogPrimaryButton
              disabled={contentSaving}
              onClick={() => void saveDocument()}
            >
              {contentSaving ? '正在重建索引…' : '保存并重建索引'}
            </KDialogPrimaryButton>
          </>
        }
      >
        <div className="flex w-full flex-col gap-[14px]">
          <div className="grid gap-[12px] md:grid-cols-[minmax(0,1fr)_220px]">
            <Input
              value={documentDraft.title}
              onChange={(event) =>
                setDocumentDraft((prev) => ({
                  ...prev,
                  title: event.target.value,
                }))
              }
              placeholder="文档标题"
            />
            <UISelect
              value={documentDraft.status}
              onValueChange={(value) =>
                setDocumentDraft((prev) => ({ ...prev, status: value }))
              }
            >
              <SelectTrigger className={cn(SELECT_TRIGGER_CLASS, 'w-full')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ready">可用</SelectItem>
                <SelectItem value="processing">处理中</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
                <SelectItem value="archived">下线</SelectItem>
              </SelectContent>
            </UISelect>
          </div>
          <div className="flex items-center justify-between gap-[12px]">
            <div
              className="inline-flex rounded-[9px] bg-[#f3f5f8] p-[3px]"
              aria-label="正文编辑模式"
            >
              <button
                type="button"
                className={cn(
                  'rounded-[7px] px-[14px] py-[6px] text-[12px] text-[#697085]',
                  documentEditorMode === 'edit' &&
                    'bg-white font-medium text-[#17191f] shadow-sm',
                )}
                onClick={() => setDocumentEditorMode('edit')}
              >
                Markdown 编辑
              </button>
              <button
                type="button"
                className={cn(
                  'rounded-[7px] px-[14px] py-[6px] text-[12px] text-[#697085]',
                  documentEditorMode === 'preview' &&
                    'bg-white font-medium text-[#17191f] shadow-sm',
                )}
                onClick={() => setDocumentEditorMode('preview')}
              >
                预览
              </button>
            </div>
            <span className="text-[12px] tabular-nums text-[#858b9c]">
              {documentDraft.content_md.length.toLocaleString()} 字符
            </span>
          </div>
          {documentEditorMode === 'edit' ? (
            <Textarea
              rows={22}
              value={documentDraft.content_md}
              onChange={(event) =>
                setDocumentDraft((prev) => ({
                  ...prev,
                  content_md: event.target.value,
                }))
              }
              placeholder="使用 Markdown 编辑知识正文"
              className="min-h-[460px] resize-y font-mono text-[13px] leading-6"
            />
          ) : (
            <div className="min-h-[460px] max-h-[62vh] overflow-auto rounded-[12px] border border-[#e6e9ef] bg-white p-[18px]">
              <MarkdownPreview
                markdown={documentDraft.content_md || '暂无正文'}
              />
            </div>
          )}
          <p className="m-0 text-[12px] leading-5 text-[#858b9c]">
            保存后会自动重建目录索引、引用来源和知识图谱；员工范围的修改会写入员工私有版本，不影响广场原版本。
          </p>
        </div>
      </KDialog>
      <KDialog
        open={Boolean(editingBucket)}
        title="编辑内部索引与引用来源"
        width={920}
        onClose={() => setEditingBucket(null)}
        footer={
          <>
            <KDialogCancelButton
              disabled={contentSaving}
              onClick={() => setEditingBucket(null)}
            />
            <KDialogPrimaryButton
              disabled={contentSaving}
              onClick={() => void saveBucketAndChunks()}
            >
              保存
            </KDialogPrimaryButton>
          </>
        }
      >
        <div className="flex w-full flex-col gap-[14px]">
          <Input
            value={bucketDraft.title}
            onChange={(event) =>
              setBucketDraft((prev) => ({ ...prev, title: event.target.value }))
            }
            placeholder="内部索引标题"
          />
          <Textarea
            rows={4}
            value={bucketDraft.summary}
            onChange={(event) =>
              setBucketDraft((prev) => ({
                ...prev,
                summary: event.target.value,
              }))
            }
            placeholder="内部索引摘要"
          />
          <div className="flex flex-col gap-[12px]">
            {bucketChunks.map((chunk) => (
              <div
                className="flex flex-col gap-[10px] rounded-[12px] border border-[#eceef1] bg-[#fafbfc] p-[12px]"
                key={chunk.id}
              >
                <div className="flex items-center justify-between gap-[10px]">
                  <strong className="text-[13px] font-semibold text-[#18181a]">
                    引用来源 {chunk.chunk_index + 1}
                  </strong>
                  <KTag>{chunk.source_ref || 'chunk'}</KTag>
                </div>
                <Textarea
                  rows={2}
                  value={chunkDrafts[chunk.id]?.summary || ''}
                  onChange={(event) =>
                    setChunkDrafts((prev) => ({
                      ...prev,
                      [chunk.id]: {
                        ...(prev[chunk.id] || {
                          content: chunk.content,
                          summary: '',
                        }),
                        summary: event.target.value,
                      },
                    }))
                  }
                  placeholder="引用来源摘要"
                />
                <Textarea
                  rows={6}
                  value={chunkDrafts[chunk.id]?.content || ''}
                  onChange={(event) =>
                    setChunkDrafts((prev) => ({
                      ...prev,
                      [chunk.id]: {
                        ...(prev[chunk.id] || {
                          content: '',
                          summary: chunk.summary || '',
                        }),
                        content: event.target.value,
                      },
                    }))
                  }
                  placeholder="引用来源内容"
                />
              </div>
            ))}
          </div>
        </div>
      </KDialog>

      <ConfirmDialog
        open={Boolean(deleteKbTarget)}
        onOpenChange={(open) => !open && setDeleteKbTarget(null)}
        title={
          deleteKbTarget
            ? `${isOverallAgent ? '删除' : '移除'}知识库：${deleteKbTarget.name}`
            : ''
        }
        description={
          !isOverallAgent
            ? '这只会在当前数字员工中隐藏该知识库；开放广场和其他数字员工仍然保留。'
            : '开放广场会永久删除该知识库及其文档、内部索引、引用来源和版本记录。'
        }
        confirmText={isOverallAgent ? '删除' : '移除'}
        onConfirm={() => void runDeleteKnowledgeBase()}
      />
    </div>
  );
}

export function KnowledgeAddPage({ currentUser }: KnowledgePageProps = {}) {
  const {
    api,
    navigate,
    notify,
    tenantId: TENANT_ID,
    loadEmployeeDirectory,
    isEnterpriseAdmin,
    canManageEmployeeAgent,
    visibleEmployeeAgents,
    agentScope,
  } = useKnowledgePageHost();
  const readEmployeeScope = agentScope.read;
  const persistSharedAgentScope = agentScope.persist;
  const clearSharedAgentScope = agentScope.clear;
  const emitAgentScopeChange = agentScope.emit;
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRead[]>([]);
  const [capabilityScope, setCapabilityScope] =
    useState<CapabilityScope>('general');
  const [jobs, setJobs] = useState<Record<string, KnowledgeIngestJobRead>>({});
  const [agentId, setAgentId] = useState(readEmployeeScope);
  const [agentScopeLoaded, setAgentScopeLoaded] = useState(false);
  const [checkedDiscoveryJobIds, setCheckedDiscoveryJobIds] = useState<
    string[]
  >([]);
  const [pendingDiscoveries, setPendingDiscoveries] = useState<
    KnowledgeDiscoveryRead[]
  >([]);
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState(false);
  const [cancellingJobIds, setCancellingJobIds] = useState<string[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
  const uploading = uploadingFiles.size > 0;
  const sortedJobs = useMemo(
    () =>
      Object.values(jobs).sort((left, right) => {
        const diff = knowledgeJobSortTime(right) - knowledgeJobSortTime(left);
        return diff || right.id.localeCompare(left.id);
      }),
    [jobs],
  );
  const activeJobs = useMemo(
    () =>
      sortedJobs.filter((job) =>
        ['queued', 'running', 'cancel_requested'].includes(job.status),
      ),
    [sortedJobs],
  );
  const visibleKnowledgeBases = useMemo(
    () => knowledgeBases.filter((item) => !isEmptyDefaultKnowledgeBase(item)),
    [knowledgeBases],
  );

  useEffect(() => {
    let active = true;
    loadEmployeeDirectory()
      .then((agentRows) => {
        if (!active) return;
        const resolvedAgentId = resolveKnowledgeAgentScope(
          agentRows,
          currentUser,
          isEnterpriseAdmin,
          agentId,
        );
        if (resolvedAgentId !== agentId) {
          if (resolvedAgentId) {
            persistSharedAgentScope(resolvedAgentId, currentUser?.id);
          } else {
            clearSharedAgentScope(currentUser?.id);
          }
          setAgentId(resolvedAgentId);
          emitAgentScopeChange(resolvedAgentId);
        }
        setAgentScopeLoaded(true);
      })
      .catch(() => {
        if (active) setAgentScopeLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!agentScopeLoaded) return;
    void refreshKnowledgeBases();
    void loadRecentJobs();
  }, [agentId, agentScopeLoaded]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next =
        (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      setAgentId(next && !isTeamScope(next) ? next : readEmployeeScope());
    };
    window.addEventListener(
      'ultrarag-enterprise-agent-scope-change',
      onScopeChange,
    );
    return () =>
      window.removeEventListener(
        'ultrarag-enterprise-agent-scope-change',
        onScopeChange,
      );
  }, []);

  useEffect(() => {
    if (activeJobs.length === 0) return;
    const timer = window.setInterval(() => {
      activeJobs.forEach((job) => {
        void api
          .get<KnowledgeIngestJobRead>(
            `/api/enterprise/knowledge/jobs/${job.id}?tenant_id=${TENANT_ID}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`,
          )
          .then((next) => {
            setJobs((prev) => ({ ...prev, [next.id]: next }));
            if (TERMINAL_KNOWLEDGE_JOB_STATUSES.has(next.status)) {
              setCancellingJobIds((current) =>
                current.filter((id) => id !== next.id),
              );
              void refreshKnowledgeBases();
              void loadRecentJobs();
            }
          })
          .catch(() => undefined);
      });
    }, 1400);
    return () => window.clearInterval(timer);
  }, [activeJobs]);

  useEffect(() => {
    const controller = new AbortController();
    sortedJobs
      .filter(
        (job) =>
          job.status === 'succeeded' &&
          !checkedDiscoveryJobIds.includes(job.id),
      )
      .forEach((job) => {
        void loadDiscoveriesForJob(job, controller.signal);
      });
    return () => controller.abort();
  }, [sortedJobs, checkedDiscoveryJobIds, agentId]);

  async function refreshKnowledgeBases() {
    if (!isEnterpriseAdmin(currentUser) && !agentId) {
      setKnowledgeBases([]);
      return;
    }
    try {
      const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const rows = await api.get<KnowledgeBaseRead[]>(
        `/api/enterprise/knowledge-bases?tenant_id=${TENANT_ID}${suffix}`,
      );
      setKnowledgeBases(rows);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载知识库失败');
    }
  }

  async function loadRecentJobs() {
    if (!isEnterpriseAdmin(currentUser) && !agentId) {
      setJobs({});
      return;
    }
    try {
      const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const rows = await api.get<KnowledgeIngestJobRead[]>(
        `/api/enterprise/knowledge/jobs?tenant_id=${TENANT_ID}${suffix}&limit=8`,
      );
      setJobs(Object.fromEntries(rows.map((job) => [job.id, job])));
    } catch {
      setJobs({});
    }
  }

  async function uploadFile(file: File) {
    if (!isEnterpriseAdmin(currentUser) && !agentId) {
      notify.warning('请先选择一个数字员工');
      return;
    }
    const fileKey = `${file.name}-${file.size}-${file.lastModified}`;
    setUploadingFiles((prev) => new Set(prev).add(fileKey));
    try {
      const contentBase64 = await fileToBase64(file);
      const suffix = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
      const job = await api.post<KnowledgeIngestJobRead>(
        `/api/enterprise/knowledge/documents${suffix}`,
        {
          tenant_id: TENANT_ID,
          filename: file.name,
          title: file.name.replace(/\.[^.]+$/, ''),
          content_base64: contentBase64,
          capability_scope: capabilityScope,
        },
      );
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      await refreshKnowledgeBases();
      notify.success('已创建知识库和入库任务');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploadingFiles((prev) => {
        const next = new Set(prev);
        next.delete(fileKey);
        return next;
      });
    }
  }

  async function cancelJob(job: KnowledgeIngestJobRead) {
    if (!['queued', 'running', 'cancel_requested'].includes(job.status)) return;
    setCancellingJobIds((current) =>
      current.includes(job.id) ? current : [...current, job.id],
    );
    try {
      const next = await api.post<KnowledgeIngestJobRead>(
        `/api/enterprise/knowledge/jobs/${job.id}/cancel?tenant_id=${TENANT_ID}`,
      );
      setJobs((prev) => ({ ...prev, [next.id]: next }));
      notify.success(
        next.status === 'cancelled' ? '已取消入库任务' : '已发送取消请求',
      );
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '取消入库任务失败');
    } finally {
      setCancellingJobIds((current) => current.filter((id) => id !== job.id));
    }
  }

  async function loadDiscoveriesForJob(
    job: KnowledgeIngestJobRead,
    signal: AbortSignal,
  ) {
    const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
    for (let attempt = 0; attempt < 5 && !signal.aborted; attempt += 1) {
      try {
        const rows = await api.get<KnowledgeDiscoveryRead[]>(
          `/api/enterprise/knowledge/discoveries?tenant_id=${TENANT_ID}${suffix}`,
        );
        if (signal.aborted) return;
        const next = rows.filter(
          (item) =>
            item.status === 'pending' &&
            item.suggestion_type !== 'warning' &&
            item.knowledge_base_id === job.knowledge_base_id &&
            (!job.document_id || item.document_id === job.document_id),
        );
        if (next.length > 0) {
          setPendingDiscoveries((current) => {
            const seen = new Set(current.map((item) => item.id));
            return [...current, ...next.filter((item) => !seen.has(item.id))];
          });
          setDiscoveryModalOpen(true);
          setCheckedDiscoveryJobIds((prev) =>
            prev.includes(job.id) ? prev : [...prev, job.id],
          );
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (attempt === 4)
          notify.warning(
            error instanceof Error ? error.message : '加载知识发现建议失败',
          );
      }
      if (attempt < 4) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            window.clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = window.setTimeout(finish, 700);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    }
    if (!signal.aborted)
      setCheckedDiscoveryJobIds((prev) =>
        prev.includes(job.id) ? prev : [...prev, job.id],
      );
  }

  async function confirmDiscovery(item: KnowledgeDiscoveryRead) {
    try {
      await api.post(
        `/api/enterprise/knowledge/discoveries/${item.id}/confirm?tenant_id=${TENANT_ID}`,
      );
      notify.success('已确认建议');
      setPendingDiscoveries((current) =>
        current.filter((entry) => entry.id !== item.id),
      );
      await refreshKnowledgeBases();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '确认失败');
    }
  }

  async function rejectDiscovery(item: KnowledgeDiscoveryRead) {
    try {
      await api.post(
        `/api/enterprise/knowledge/discoveries/${item.id}/reject?tenant_id=${TENANT_ID}`,
      );
      notify.success('已拒绝建议');
      setPendingDiscoveries((current) =>
        current.filter((entry) => entry.id !== item.id),
      );
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '拒绝失败');
    }
  }

  return (
    <div className="knowledge-page knowledge-add-page knowledge-floating-subpage">
      <div className="knowledge-floating-shell">
        <div className="knowledge-floating-head">
          <div>
            <span className="section-kicker">知识库 / 新建</span>
            <h3 className="my-[4px] text-[20px] font-semibold text-foreground">
              新建知识库
            </h3>
            <span className="text-[13px] text-[#858b9c]">
              上传业务文档后，系统会先生成知识图谱，再刷新目录索引、引用来源与自发现建议。
            </span>
          </div>
          <UIButton
            variant="outline"
            onClick={() => navigate('/enterprise/knowledge')}
          >
            <RightOutlined />
            返回
          </UIButton>
        </div>

        <KCard
          className="knowledge-upload-card"
          bodyClassName="flex flex-col gap-[16px]"
        >
          <div className="knowledge-upload-controls">
            <div>
              <strong className="block text-[14px] font-semibold text-foreground">
                上传文档即创建知识库
              </strong>
              <span className="text-[13px] text-[#858b9c]">
                一个文件对应一份独立知识库；回到知识库后可查看文档卡片、知识索引和知识图谱。
              </span>
            </div>
            <UIButton
              variant="outline"
              onClick={() => navigate('/enterprise/knowledge')}
            >
              管理已有知识库
            </UIButton>
          </div>
          {visibleKnowledgeBases.length > 0 && (
            <div className="knowledge-base-target-strip">
              {visibleKnowledgeBases.map((item) => (
                <div key={item.id} className="knowledge-base-target">
                  <span {...USER_CONTENT_ATTRIBUTES}>{item.name}</span>
                  <small>
                    {item.document_count} 文档 / {item.bucket_count} 目录 /{' '}
                    {item.chunk_count} 引用
                  </small>
                  <CapabilityScopeBadge value={item.capability_scope} />
                </div>
              ))}
            </div>
          )}
          <CapabilityScopeControl
            value={capabilityScope}
            onChange={setCapabilityScope}
            resourceType="knowledge_base"
          />
          <FileDropzone
            multiple
            accept=".doc,.docx,.txt,.md,.markdown,.html,.htm,.pdf"
            onFiles={(files) => files.forEach((file) => void uploadFile(file))}
            disabled={uploading}
          >
            {uploading ? (
              <div className="knowledge-upload-inner">
                <InboxOutlined spin />
                <div>
                  <strong>正在上传 {uploadingFiles.size} 个文件...</strong>
                  <span>请稍候，上传完成后会自动创建知识库并开始入库。</span>
                </div>
              </div>
            ) : (
              <div className="knowledge-upload-inner">
                <InboxOutlined />
                <div>
                  <strong>拖拽文档到这里，或点击上传</strong>
                  <span>
                    支持 doc/docx/txt/md/html/pdf；旧版 doc 会提示转换为 docx。
                  </span>
                </div>
              </div>
            )}
          </FileDropzone>
        </KCard>

        <KCard title="入库任务">
          {sortedJobs.length === 0 ? (
            <EmptyState description="上传后这里会显示原始资料、知识图谱和引用来源入库进度" />
          ) : (
            <div className="knowledge-jobs">
              {sortedJobs.map((job) => (
                <KnowledgeJobCard
                  job={job}
                  key={job.id}
                  cancelling={cancellingJobIds.includes(job.id)}
                  onCancel={cancelJob}
                />
              ))}
            </div>
          )}
        </KCard>
      </div>

      <KDialog
        open={discoveryModalOpen && pendingDiscoveries.length > 0}
        title="发现可新增资源"
        width={820}
        className="knowledge-discovery-modal"
        onClose={() => setDiscoveryModalOpen(false)}
      >
        <DiscoveryColumn
          title="可确认建议"
          description="模型从本次上传的知识中发现了技能或工具草案，确认后才会写入系统。"
          items={pendingDiscoveries}
          onConfirm={confirmDiscovery}
          onReject={rejectDiscovery}
        />
      </KDialog>
    </div>
  );
}

export function KnowledgeJobCard({
  job,
  cancelling,
  onCancel,
}: {
  job: KnowledgeIngestJobRead;
  cancelling?: boolean;
  onCancel?: (job: KnowledgeIngestJobRead) => void;
}) {
  const steps = ingestSteps(job);
  const metadata = job.metadata || {};
  const stageLabel =
    stringFromMetadata(metadata.stage_label) || stageLabelFallback(job.stage);
  const stageDetail = stringFromMetadata(metadata.stage_detail);
  const cancellable = ['queued', 'running'].includes(job.status);
  return (
    <div className="knowledge-job">
      <div className="knowledge-job-head">
        <div>
          <strong
            {...USER_CONTENT_ATTRIBUTES}
            className="text-[14px] font-semibold text-foreground"
          >
            {job.filename}
          </strong>
          <span className="text-[13px] text-[#858b9c]"> · {stageLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-[8px]">
          {statusTag(job.status)}
          {cancellable && onCancel && (
            <UIButton
              type="button"
              variant="outline"
              size="sm"
              className={OUTLINE_ACTION_BUTTON_SM_CLASS}
              disabled={cancelling}
              onClick={() => onCancel(job)}
            >
              <CloseOutlined />
              {cancelling ? '取消中' : '取消'}
            </UIButton>
          )}
        </div>
      </div>
      <SmoothProgress job={job} />
      <div className="knowledge-stage-track">
        {steps.map((step) => (
          <div
            className={`knowledge-stage-step is-${step.status}`}
            key={step.key}
          >
            <span />
            <small>{step.label}</small>
          </div>
        ))}
      </div>
      {stageDetail && (
        <span className="knowledge-job-detail text-[13px] text-[#858b9c]">
          {stageDetail}
        </span>
      )}
      {job.error && (
        <span className="text-[13px] text-[#d20b0b]">{job.error}</span>
      )}
    </div>
  );
}

function knowledgeJobSortTime(job: KnowledgeIngestJobRead): number {
  const createdAt = Date.parse(job.created_at || '');
  if (Number.isFinite(createdAt)) return createdAt;
  const updatedAt = Date.parse(job.updated_at || '');
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function SmoothProgress({ job }: { job: KnowledgeIngestJobRead }) {
  const target = Math.max(
    0,
    Math.min(100, Math.round((job.progress || 0) * 100)),
  );
  const [displayProgress, setDisplayProgress] = useState(target);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayProgress((current) => {
        if (current === target) return current;
        const diff = target - current;
        const step = Math.max(1, Math.ceil(Math.abs(diff) / 14));
        return current + Math.sign(diff) * Math.min(Math.abs(diff), step);
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [target]);

  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';
  const cancelling = job.status === 'cancel_requested';
  const indicatorClassName = failed
    ? 'bg-[#d20b0b]'
    : cancelled
      ? 'bg-[#9aa3b2]'
      : cancelling
        ? 'bg-[#d29a0b]'
        : 'bg-gradient-to-r from-[#0f7f74] to-[#16a34a]';
  const valueClassName = failed ? 'text-[#d20b0b]' : 'text-[#858b9c]';
  return (
    <div className="flex items-center gap-[10px]">
      <Progress
        value={displayProgress}
        className="h-[8px] flex-1"
        indicatorClassName={indicatorClassName}
      />
      <span className={cn('text-[12px] tabular-nums', valueClassName)}>
        {displayProgress}%
      </span>
    </div>
  );
}

function ingestSteps(job: KnowledgeIngestJobRead): IngestStepView[] {
  const raw = (job.metadata || {}).ingest_steps;
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      const record =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : {};
      const status =
        record.status === 'running' || record.status === 'done'
          ? record.status
          : 'pending';
      return {
        key: String(record.key || `step_${index}`),
        label: String(
          record.label ||
            DEFAULT_INGEST_STEPS[index]?.label ||
            `阶段 ${index + 1}`,
        ),
        progress: Number(record.progress || 0),
        status,
      };
    });
  }
  const currentProgress = job.progress || 0;
  if (job.status === 'cancelled' || job.stage === 'cancelled') {
    return DEFAULT_INGEST_STEPS.map((step) => ({
      ...step,
      status: step.progress < currentProgress ? 'done' : 'pending',
    }));
  }
  return DEFAULT_INGEST_STEPS.map((step) => ({
    ...step,
    status:
      job.stage === step.key
        ? 'running'
        : step.progress < currentProgress || job.stage === 'done'
          ? 'done'
          : 'pending',
  }));
}

function stageLabelFallback(stage: string): string {
  return (
    DEFAULT_INGEST_STEPS.find((item) => item.key === stage)?.label ||
    stage ||
    '处理中'
  );
}

function stringFromMetadata(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeMarkdownForDisplay(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+(#{1,6}\s+)/g, '\n\n$1')
    .trim();
}

function documentSourceMarkdown(
  document: KnowledgeDocumentRead,
  fallback: string,
): string {
  const metadata = document.metadata || {};
  const rawText =
    stringFromMetadata(metadata.raw_text) ||
    stringFromMetadata(metadata.content);
  if (rawText.trim()) return rawText;
  const sectionTree = Array.isArray(metadata.section_tree)
    ? metadata.section_tree
    : [];
  const sourceBlocks = sectionTree
    .map((node) => {
      if (!isRecord(node)) return '';
      const content = stringFromMetadata(node.content).trim();
      if (content) return content;
      const title = stringFromMetadata(node.title).trim();
      const summary = stringFromMetadata(node.summary).trim();
      if (title && summary) return `## ${title}\n\n${summary}`;
      return title || summary;
    })
    .filter(Boolean);
  return sourceBlocks.length ? sourceBlocks.join('\n\n') : fallback;
}

type KnowledgeDetailView = 'document' | 'sections' | 'wiki' | 'evidence';
type KnowledgeContentView = 'sections' | 'wiki' | 'evidence';
const STRUCTURE_PREVIEW_LIMIT = 8;
const OKF_PREVIEW_LIMIT = 8;

type WikiIndexGroup = {
  key: string;
  title: string;
  description: string;
  concepts: KnowledgeConceptRead[];
};

type KnowledgeOverviewItem = {
  key: string;
  title: string;
  summary: string;
  concept?: KnowledgeConceptRead;
  indexGroup?: WikiIndexGroup;
  bucket?: KnowledgeBucketRead;
};

export function 目录索引Overview({
  document,
  knowledgeBase,
  buckets,
  okfConcepts,
  canEdit,
  onEditDocument,
  onEditBucket,
  onViewConcept,
  onEditConcept,
}: {
  document: KnowledgeDocumentRead;
  knowledgeBase: KnowledgeBaseRead | null;
  buckets: KnowledgeBucketRead[];
  okfConcepts: KnowledgeConceptRead[];
  canEdit: boolean;
  onEditDocument: (document: KnowledgeDocumentRead) => void;
  onEditBucket: (bucket: KnowledgeBucketRead) => void;
  onViewConcept: (concept: KnowledgeConceptRead) => void;
  onEditConcept: (concept: KnowledgeConceptRead) => void;
}) {
  const dateLocale = useKnowledgePageHost().getDateLocale();
  const [detailView, setDetailView] = useState<KnowledgeDetailView | null>(
    null,
  );
  const [detailFocusKey, setDetailFocusKey] = useState<string | null>(null);
  const [activeContentView, setActiveContentView] =
    useState<KnowledgeContentView>('evidence');
  const [wikiPresentation, setWikiPresentation] = useState<'graph' | 'cards'>(
    'graph',
  );
  const [wikiViewMode, setWikiViewMode] = useState<'graph' | 'cards'>('graph');
  const metadata = document.metadata || {};
  const documentCard = isRecord(metadata.document_card)
    ? metadata.document_card
    : {};
  const wikiStructureConcepts = useMemo(
    () => sortWikiConcepts(okfConcepts, dateLocale),
    [okfConcepts, dateLocale],
  );
  const wikiIndexGroups = useMemo(
    () => buildWikiIndexGroups(wikiStructureConcepts, dateLocale),
    [wikiStructureConcepts, dateLocale],
  );
  const previewWikiStructure = wikiIndexGroups.slice(
    0,
    STRUCTURE_PREVIEW_LIMIT,
  );
  const previewConcepts = okfConcepts.slice(0, OKF_PREVIEW_LIMIT);
  const documentTitle = String(
    documentCard.title ||
      document.title ||
      knowledgeBase?.name ||
      document.filename,
  );
  const documentSummary = String(documentCard.summary || '暂无文档摘要');
  const sourceMarkdown = useMemo(
    () => documentSourceMarkdown(document, documentSummary),
    [document, documentSummary],
  );
  const totalChunkCount =
    buckets.reduce((sum, bucket) => sum + (bucket.chunk_count || 0), 0) ||
    document.chunk_count ||
    0;
  const evidenceBuckets = useMemo(
    () =>
      buckets.filter(
        (bucket) =>
          bucket.chunk_count > 0 || bucketContentMarkdown(bucket).trim(),
      ),
    [buckets],
  );
  const previewEvidence = useMemo(
    () => previewEvidenceItems(buckets, totalChunkCount, OKF_PREVIEW_LIMIT),
    [buckets, totalChunkCount],
  );
  const openDetail = (view: KnowledgeDetailView, focusKey?: string) => {
    setDetailFocusKey(focusKey || null);
    setDetailView(view);
  };
  const openContentDetail = (view: KnowledgeContentView, focusKey?: string) => {
    if (view === 'sections') {
      openDetail('sections', focusKey);
      return;
    }
    openDetail(view, focusKey);
  };

  useEffect(() => {
    if (!detailView || !detailFocusKey) return;
    const timer = window.setTimeout(() => {
      const targets = Array.from(
        window.document.querySelectorAll<HTMLElement>(
          '.knowledge-detail-modal .knowledge-detail-target',
        ),
      );
      const target = targets.find(
        (item) => item.dataset.detailKey === detailFocusKey,
      );
      if (!target) return;
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      target.classList.add('is-focused');
      window.setTimeout(() => target.classList.remove('is-focused'), 1500);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [detailView, detailFocusKey]);

  const overviewContent: Record<
    KnowledgeContentView,
    {
      title: string;
      description: string;
      count: number;
      emptyText: string;
      items: KnowledgeOverviewItem[];
    }
  > = {
    sections: {
      title: '目录索引',
      description: '按目录结构组织知识范围，先看主题，再进入知识图谱。',
      count: wikiIndexGroups.length,
      emptyText: '暂无目录索引',
      items: previewWikiStructure.map((group) => ({
        key: group.key,
        title: group.title,
        summary: group.description,
        indexGroup: group,
      })),
    },
    wiki: {
      title: '知识图谱',
      description: '可读知识页，用于长期沉淀、跨文档综合和数字员工复制。',
      count: okfConcepts.length,
      emptyText: '暂无知识图谱',
      items: previewConcepts.map((concept) => ({
        key: concept.id,
        title: concept.title || concept.concept_id,
        summary: `${conceptTypeLabel(concept.concept_type)} · ${concept.description || concept.concept_id}`,
        concept,
      })),
    },
    evidence: {
      title: '引用来源',
      description: '保留切片内容、原文片段和来源路径，用于回答溯源。',
      count: totalChunkCount,
      emptyText: '暂无引用来源',
      items: previewEvidence,
    },
  };
  const activeContent = overviewContent[activeContentView];

  return (
    <div className="knowledge-pageindex">
      <div className="knowledge-pageindex-card">
        <div className="knowledge-document-card-body">
          <span className="text-[13px] text-[#858b9c]">文档卡片</span>
          <h5 className="my-[4px] text-[15px] font-semibold text-foreground">
            {documentTitle}
          </h5>
          <div className="knowledge-document-card-markdown is-preview">
            <MarkdownPreview markdown={documentSummary} />
          </div>
        </div>
        <div className="knowledge-pageindex-actions">
          <UIButton
            variant="outline"
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
            onClick={() => openDetail('document')}
          >
            <EditOutlined />
            详情
          </UIButton>
        </div>
        <div className="knowledge-document-meta">
          <button
            type="button"
            className="knowledge-stat-pill"
            onClick={() => openDetail('document')}
          >
            <span>格式</span>
            <strong>{document.file_type || 'unknown'}</strong>
          </button>
          <button
            type="button"
            className={`knowledge-stat-pill ${activeContentView === 'sections' ? 'is-active' : ''}`}
            aria-pressed={activeContentView === 'sections'}
            onClick={() => setActiveContentView('sections')}
          >
            <span>目录索引</span>
            <strong>{wikiIndexGroups.length}</strong>
          </button>
          <button
            type="button"
            className={`knowledge-stat-pill ${activeContentView === 'wiki' ? 'is-active' : ''}`}
            aria-pressed={activeContentView === 'wiki'}
            onClick={() => setActiveContentView('wiki')}
          >
            <span>知识图谱</span>
            <strong>{okfConcepts.length}</strong>
          </button>
          <button
            type="button"
            className={`knowledge-stat-pill ${activeContentView === 'evidence' ? 'is-active' : ''}`}
            aria-pressed={activeContentView === 'evidence'}
            onClick={() => setActiveContentView('evidence')}
          >
            <span>引用来源</span>
            <strong>{totalChunkCount}</strong>
          </button>
        </div>
      </div>

      <div
        className={cn(
          'knowledge-overview-panel',
          activeContentView === 'wiki' &&
            wikiPresentation === 'graph' &&
            'is-graph',
        )}
      >
        <div className="knowledge-overview-panel-head">
          <span>
            <strong>{activeContent.title}</strong>
            <small>{activeContent.description}</small>
          </span>
          <div className="knowledge-overview-panel-actions">
            {activeContentView === 'wiki' && (
              <div
                className="knowledge-graph-view-switch"
                aria-label="知识图谱呈现方式"
              >
                <button
                  type="button"
                  className={wikiPresentation === 'graph' ? 'is-active' : ''}
                  aria-pressed={wikiPresentation === 'graph'}
                  onClick={() => setWikiPresentation('graph')}
                >
                  图谱
                </button>
                <button
                  type="button"
                  className={wikiPresentation === 'cards' ? 'is-active' : ''}
                  aria-pressed={wikiPresentation === 'cards'}
                  onClick={() => setWikiPresentation('cards')}
                >
                  卡片
                </button>
              </div>
            )}
            <KTag>{activeContent.count}</KTag>
            <button
              type="button"
              className="text-[13px] text-[#1a71ff] transition-colors hover:text-[#4a8dff]"
              onClick={() => openContentDetail(activeContentView)}
            >
              查看全部
            </button>
          </div>
        </div>
        {activeContentView === 'wiki' && wikiPresentation === 'graph' ? (
          <Suspense fallback={<div className="kgv-empty">加载中…</div>}>
            <KnowledgeGraphVisualization
              concepts={okfConcepts}
              knowledgeBaseKey={knowledgeBase?.id || document.knowledge_base_id}
              onViewConcept={onViewConcept}
            />
          </Suspense>
        ) : (
          <>
            {activeContentView === 'sections' && (
              <div
                className="knowledge-layer-explain"
                aria-label="知识层级说明"
              >
                <span>
                  <strong>目录索引</strong>
                  <small>目录索引，用于按资料、章节、主题逐级展开</small>
                </span>
                <span>
                  <strong>知识图谱</strong>
                  <small>
                    最底层可读知识页，回答时基于页面内容并追溯引用来源
                  </small>
                </span>
              </div>
            )}
            <div className="knowledge-mini-list">
              {activeContent.items.length === 0 ? (
                <span className="knowledge-empty-note">
                  {activeContent.emptyText}
                </span>
              ) : (
                activeContent.items.map((entry) => (
                  <button
                    type="button"
                    className="knowledge-mini-item"
                    key={`${activeContentView}-${entry.key}`}
                    onClick={() => {
                      if (
                        activeContentView === 'sections' &&
                        entry.indexGroup
                      ) {
                        openContentDetail('sections', entry.indexGroup.key);
                        return;
                      }
                      if (
                        (activeContentView === 'sections' ||
                          activeContentView === 'wiki') &&
                        entry.concept
                      ) {
                        onViewConcept(entry.concept);
                        return;
                      }
                      if (activeContentView === 'evidence' && entry.bucket) {
                        openContentDetail('evidence', entry.bucket.id);
                        return;
                      }
                      openContentDetail(activeContentView, entry.key);
                    }}
                    title={
                      activeContentView === 'sections' && entry.indexGroup
                        ? '查看目录下的知识图谱'
                        : (activeContentView === 'sections' ||
                              activeContentView === 'wiki') &&
                            entry.concept
                          ? '查看知识图谱'
                          : activeContentView === 'evidence'
                            ? '查看引用来源'
                            : '查看详情'
                    }
                  >
                    <strong
                      {...(entry.indexGroup ||
                      entry.concept ||
                      entry.bucket?.title ||
                      entry.bucket?.bucket_key ||
                      (!entry.bucket && entry.key !== 'chunk-total')
                        ? USER_CONTENT_ATTRIBUTES
                        : {})}
                    >
                      {entry.title}
                    </strong>
                    <small
                      {...(entry.bucket &&
                      bucketContentMarkdown(entry.bucket).trim()
                        ? USER_CONTENT_ATTRIBUTES
                        : {})}
                    >
                      {entry.summary}
                    </small>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <KDialog
        open={Boolean(detailView)}
        title={knowledgeDetailTitle(detailView)}
        width={
          detailView === 'sections' || detailView === 'wiki'
            ? 'min(1240px, calc(100vw - 56px))'
            : 920
        }
        className={`knowledge-detail-modal${detailView === 'sections' ? ' knowledge-detail-modal-sections' : ''}`}
        onClose={() => setDetailView(null)}
      >
        {detailView === 'document' && (
          <div className="knowledge-detail-stack">
            <div className="knowledge-detail-header">
              <div>
                <span className="text-[13px] text-[#858b9c]">文档卡片</span>
                <h4 className="my-[4px] text-[16px] font-semibold text-foreground">
                  {documentTitle}
                </h4>
              </div>
              {canEdit && (
                <UIButton
                  variant="outline"
                  className={OUTLINE_ACTION_BUTTON_SM_CLASS}
                  onClick={() => onEditDocument(document)}
                >
                  <EditOutlined />
                  修改
                </UIButton>
              )}
            </div>
            <section className="knowledge-document-md-panel">
              <div className="knowledge-document-md-panel-head">
                <strong>文档卡片</strong>
                <KTag>{document.file_type || 'unknown'}</KTag>
              </div>
              <div className="knowledge-document-md-scroll is-summary">
                <MarkdownPreview markdown={documentSummary} />
              </div>
            </section>
            <section className="knowledge-document-md-panel">
              <div className="knowledge-document-md-panel-head">
                <strong>原始资料</strong>
                <KTag>
                  {Array.isArray(metadata.section_tree)
                    ? metadata.section_tree.length
                    : 0}{' '}
                  段
                </KTag>
              </div>
              <div className="knowledge-document-md-scroll is-source">
                <MarkdownPreview markdown={sourceMarkdown || '暂无原始资料'} />
              </div>
            </section>
            <div className="knowledge-evidence-stat is-inline">
              <strong>{document.file_type || 'unknown'}</strong>
              <span>文件格式</span>
            </div>
            <div className="knowledge-document-meta">
              <button
                type="button"
                className="knowledge-stat-pill"
                onClick={() => openDetail('sections')}
              >
                <span>目录索引</span>
                <strong>{wikiIndexGroups.length}</strong>
              </button>
              <button
                type="button"
                className="knowledge-stat-pill"
                onClick={() => openDetail('wiki')}
              >
                <span>知识图谱</span>
                <strong>{okfConcepts.length}</strong>
              </button>
              <button
                type="button"
                className="knowledge-stat-pill"
                onClick={() => openDetail('evidence')}
              >
                <span>引用来源</span>
                <strong>{totalChunkCount}</strong>
              </button>
            </div>
          </div>
        )}

        {detailView === 'sections' && (
          <div className="knowledge-wiki-map">
            {wikiIndexGroups.length === 0 ? (
              <EmptyState description="暂无 目录索引 目录" />
            ) : (
              wikiIndexGroups.map((group) => (
                <section
                  className="knowledge-wiki-map-card knowledge-index-group knowledge-detail-target"
                  key={group.key}
                  data-detail-key={group.key}
                >
                  <div className="knowledge-index-group-head">
                    <div>
                      <KTag color="green">目录索引</KTag>
                      <strong>{group.title}</strong>
                      <small>{group.description}</small>
                    </div>
                    <KTag>{group.concepts.length} 页</KTag>
                  </div>
                  <div className="knowledge-index-page-list">
                    {group.concepts.slice(0, 8).map((concept) => (
                      <button
                        type="button"
                        key={concept.id}
                        onClick={() => onViewConcept(concept)}
                      >
                        <span {...USER_CONTENT_ATTRIBUTES}>
                          {concept.title || concept.concept_id}
                        </span>
                        <small>
                          {conceptTypeLabel(concept.concept_type)} ·{' '}
                          {concept.description || concept.concept_id}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}

        {detailView === 'evidence' && (
          <div className="knowledge-concept-list">
            {evidenceBuckets.length === 0 ? (
              <EmptyState description="暂无引用来源" />
            ) : (
              evidenceBuckets.map((bucket) => {
                const contentMarkdown = bucketContentMarkdown(bucket);
                return (
                  <section
                    className="knowledge-concept-card knowledge-detail-target"
                    key={bucket.id}
                    data-detail-key={bucket.id}
                  >
                    <div className="knowledge-concept-card-head">
                      <div>
                        <div className="flex flex-wrap items-center gap-[8px]">
                          <KTag color="green">引用来源</KTag>
                          {bucketStatusTag(bucket)}
                          <KTag>{bucket.chunk_count} 个切片</KTag>
                        </div>
                        <h5
                          {...(bucket.title || bucket.bucket_key
                            ? USER_CONTENT_ATTRIBUTES
                            : {})}
                          className="mt-[6px] mb-0 text-[15px] font-semibold text-foreground"
                        >
                          {bucket.title || bucket.bucket_key || '引用来源'}
                        </h5>
                      </div>
                      <UIButton
                        variant="outline"
                        size="sm"
                        onClick={() => onEditBucket(bucket)}
                      >
                        <EditOutlined />
                        编辑
                      </UIButton>
                    </div>
                    {bucket.summary ? (
                      <p
                        {...USER_CONTENT_ATTRIBUTES}
                        className="my-[6px] text-[13px] leading-[1.65] text-[#858b9c]"
                      >
                        {bucket.summary}
                      </p>
                    ) : null}
                    <KnowledgeBucketLinks bucket={bucket} evidenceOnly />
                    <section className="mt-[12px] rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
                      <MarkdownPreview
                        markdown={
                          contentMarkdown ||
                          '暂无可展示的切片正文，可点击编辑加载完整引用来源。'
                        }
                      />
                    </section>
                  </section>
                );
              })
            )}
          </div>
        )}

        {detailView === 'wiki' && (
          <div className="knowledge-concept-list">
            {okfConcepts.length === 0 ? (
              <EmptyState description="暂无知识图谱" />
            ) : (
              <>
                <div className="knowledge-graph-view-switch">
                  <button
                    type="button"
                    className={`knowledge-graph-view-btn${wikiViewMode === 'graph' ? ' is-active' : ''}`}
                    onClick={() => setWikiViewMode('graph')}
                  >
                    图谱视图
                  </button>
                  <button
                    type="button"
                    className={`knowledge-graph-view-btn${wikiViewMode === 'cards' ? ' is-active' : ''}`}
                    onClick={() => setWikiViewMode('cards')}
                  >
                    卡片视图
                  </button>
                </div>
                {wikiViewMode === 'graph' ? (
                  <KnowledgeGraphCanvas
                    concepts={okfConcepts}
                    onSelectConcept={onViewConcept}
                  />
                ) : (
                  okfConcepts.map((concept) => (
                    <div
                      className="knowledge-concept-card knowledge-detail-target"
                      key={concept.id}
                      data-detail-key={concept.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onViewConcept(concept)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onViewConcept(concept);
                        }
                      }}
                    >
                      <div className="knowledge-concept-card-head">
                        <div>
                          <div className="flex flex-wrap items-center gap-[8px]">
                            <KTag
                              color={conceptTypeColor(concept.concept_type)}
                            >
                              {conceptTypeLabel(concept.concept_type)}
                            </KTag>
                            {statusTag(concept.status)}
                          </div>
                          <h5
                            {...USER_CONTENT_ATTRIBUTES}
                            className="mt-[6px] mb-0 text-[15px] font-semibold text-foreground"
                          >
                            {concept.title || concept.concept_id}
                          </h5>
                        </div>
                        <UIButton
                          variant="outline"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            onEditConcept(concept);
                          }}
                        >
                          <EditOutlined />
                          编辑
                        </UIButton>
                      </div>
                      <p
                        {...(concept.description
                          ? USER_CONTENT_ATTRIBUTES
                          : {})}
                        className="my-[6px] text-[13px] text-[#858b9c]"
                      >
                        {concept.description || conceptSummary(concept)}
                      </p>
                      <div className="flex flex-wrap items-center gap-[6px]">
                        <KTag>{concept.concept_id}</KTag>
                        <KTag>{concept.links.length} 个链接</KTag>
                        <KTag>{concept.citations.length} 个引用</KTag>
                        {concept.document_id ? (
                          <KTag>来源文档 {concept.document_id}</KTag>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </KDialog>
    </div>
  );
}

function WikiViewerTitle({ concept }: { concept: KnowledgeConceptRead }) {
  return (
    <div className="flex min-w-0 flex-col gap-[4px]">
      <span className="text-[13px] font-semibold text-[#1a71ff]">
        {conceptTypeLabel(concept.concept_type)}
      </span>
      <strong
        {...USER_CONTENT_ATTRIBUTES}
        className="line-clamp-2 text-[20px] font-semibold leading-[1.35] text-[#18181a]"
      >
        {concept.title || concept.concept_id}
      </strong>
      <small
        {...USER_CONTENT_ATTRIBUTES}
        className="font-mono text-[12px] wrap-break-word text-[#858b9c]"
      >
        {concept.concept_id}
      </small>
    </div>
  );
}

function WikiConceptViewer({ concept }: { concept: KnowledgeConceptRead }) {
  const dateLocale = useKnowledgePageHost().getDateLocale();
  const body = stripOkfFrontmatter(concept.content_md || '');
  const tags = Array.isArray(concept.frontmatter?.tags)
    ? concept.frontmatter.tags
    : [];
  const citations = Array.isArray(concept.citations) ? concept.citations : [];
  const links = Array.isArray(concept.links) ? concept.links : [];
  const sourceRefs = Array.isArray(concept.source_refs)
    ? concept.source_refs
    : [];
  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <section className="flex flex-col gap-[10px] rounded-[16px] border border-[#1a71ff]/18 bg-[#f5f8ff] p-[18px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <KTag color={conceptTypeColor(concept.concept_type)}>
            {conceptTypeLabel(concept.concept_type)}
          </KTag>
          {statusTag(concept.status)}
          {tags.slice(0, 5).map((tag) => (
            <KTag key={String(tag)}>{String(tag)}</KTag>
          ))}
        </div>
        <h3
          {...USER_CONTENT_ATTRIBUTES}
          className="text-[20px] font-semibold text-[#18181a]"
        >
          {concept.title || concept.concept_id}
        </h3>
        <p
          {...(concept.description ? USER_CONTENT_ATTRIBUTES : {})}
          className="text-[14px] leading-[1.65] text-[#18181a]"
        >
          {concept.description || conceptSummary(concept)}
        </p>
      </section>

      <section
        className="grid min-w-0 gap-[10px] grid-cols-[repeat(auto-fit,minmax(160px,1fr))]"
        aria-label="知识图谱元信息"
      >
        {[
          { label: '页面路径', value: concept.concept_id },
          { label: '链接', value: `${links.length} 个` },
          { label: '引用', value: `${citations.length} 个` },
          {
            label: '更新时间',
            value: formatDateTime(concept.updated_at, dateLocale),
          },
        ].map((item) => (
          <div
            key={item.label}
            className="flex min-w-0 flex-col gap-[6px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white px-[14px] py-[13px]"
          >
            <span className="text-[12px] font-semibold text-[#858b9c]">
              {item.label}
            </span>
            <strong className="wrap-break-word text-[14px] text-[#18181a]">
              {item.value}
            </strong>
          </div>
        ))}
      </section>

      <section className="rounded-[16px] border border-[#eceef1] bg-white p-[18px]">
        <MarkdownPreview markdown={body || '暂无正文'} />
      </section>

      {(links.length > 0 || citations.length > 0 || sourceRefs.length > 0) && (
        <section
          className="grid min-w-0 grid-cols-1 gap-[10px] xl:grid-cols-3"
          aria-label="知识链接与引用"
        >
          {links.length > 0 && (
            <div className="flex min-w-0 flex-col gap-[10px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
              <strong className="text-[13px] font-semibold text-[#18181a]">
                关联页面
              </strong>
              <div className="flex max-h-[220px] min-w-0 max-w-full flex-wrap gap-[6px] overflow-x-hidden overflow-y-auto pr-[2px]">
                {links.slice(0, 12).map((item, index) => (
                  <KnowledgeRelationChip key={`link-${index}`}>
                    {recordLabel(item, ['target', 'concept_id', 'id'])}
                  </KnowledgeRelationChip>
                ))}
              </div>
            </div>
          )}
          {citations.length > 0 && (
            <div className="flex min-w-0 flex-col gap-[10px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
              <strong className="text-[13px] font-semibold text-[#18181a]">
                引用
              </strong>
              <div className="flex max-h-[220px] min-w-0 max-w-full flex-wrap gap-[6px] overflow-x-hidden overflow-y-auto pr-[2px]">
                {citations.slice(0, 12).map((item, index) => (
                  <KnowledgeRelationChip key={`citation-${index}`}>
                    {recordLabel(item, ['label', 'source', 'uri', 'id'])}
                  </KnowledgeRelationChip>
                ))}
              </div>
            </div>
          )}
          {sourceRefs.length > 0 && (
            <div className="flex min-w-0 flex-col gap-[10px] overflow-hidden rounded-[14px] border border-[#eceef1] bg-white p-[14px]">
              <strong className="text-[13px] font-semibold text-[#18181a]">
                来源
              </strong>
              <div className="flex max-h-[220px] min-w-0 max-w-full flex-wrap gap-[6px] overflow-x-hidden overflow-y-auto pr-[2px]">
                {sourceRefs.slice(0, 12).map((item, index) => (
                  <KnowledgeRelationChip key={`source-${index}`}>
                    {recordLabel(item, [
                      'document_id',
                      'section_id',
                      'source',
                      'id',
                    ])}
                  </KnowledgeRelationChip>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const { renderMarkdownBlocks } = useKnowledgePageHost();
  const normalized = normalizeMarkdownForDisplay(markdown);
  return (
    <div
      {...(normalized ? USER_CONTENT_ATTRIBUTES : {})}
      className="knowledge-markdown-preview"
    >
      {renderMarkdownBlocks(normalized || '暂无内容')}
    </div>
  );
}

function stripOkfFrontmatter(markdown: string) {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*/, '').trim();
}

function recordLabel(item: unknown, keys: string[]) {
  if (!isRecord(item)) return String(item || 'unknown');
  for (const key of keys) {
    const value = item[key];
    if (value) return String(value);
  }
  return JSON.stringify(item);
}

function KnowledgeRelationChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block min-w-0 max-w-full rounded-[6px] bg-[#f2f3f5] px-[8px] py-px text-[12px] font-medium leading-[18px] whitespace-normal wrap-anywhere text-[#5b6273]">
      {children}
    </span>
  );
}

function KnowledgeBucketLinks({
  bucket,
  evidenceOnly = false,
}: {
  bucket: KnowledgeBucketRead;
  evidenceOnly?: boolean;
}) {
  const sourceSections = bucketSourceSections(bucket);
  const representativeChunks = bucketRepresentativeChunks(bucket);
  return (
    <div className="knowledge-bucket-link-grid">
      {!evidenceOnly && (
        <>
          <span className="text-[13px] text-[#858b9c]">覆盖来源</span>
          <div>
            {sourceSections.length === 0 ? (
              <KTag>暂无来源路径</KTag>
            ) : (
              sourceSections.map((section) => (
                <KTag key={String(section)}>{String(section)}</KTag>
              ))
            )}
          </div>
        </>
      )}
      <span className="text-[13px] text-[#858b9c]">
        {evidenceOnly ? '引用来源' : '代表引用'}
      </span>
      <div className="knowledge-evidence-token-list">
        {representativeChunks.length === 0 ? (
          bucket.chunk_count > 0 ? (
            <KTag>{bucket.chunk_count} 个引用来源</KTag>
          ) : (
            <KTag>暂无可读代表来源</KTag>
          )
        ) : (
          representativeChunks.map((chunkId) => (
            <KTag key={String(chunkId)}>{String(chunkId)}</KTag>
          ))
        )}
      </div>
    </div>
  );
}

function knowledgeDetailTitle(view: KnowledgeDetailView | null) {
  if (view === 'document') return '文档详情';
  if (view === 'sections') return '目录索引 目录';
  if (view === 'wiki') return '知识图谱';
  if (view === 'evidence') return '引用来源';
  return '知识详情';
}

function bucketSourceSections(bucket: KnowledgeBucketRead) {
  const bucketMeta = bucket.metadata || {};
  if (Array.isArray(bucketMeta.section_paths)) return bucketMeta.section_paths;
  if (Array.isArray(bucketMeta.section_ids)) return bucketMeta.section_ids;
  return [];
}

function bucketRepresentativeChunks(bucket: KnowledgeBucketRead) {
  const representativeChunks = Array.isArray(
    bucket.metadata?.representative_chunk_ids,
  )
    ? bucket.metadata.representative_chunk_ids
    : [];
  return representativeChunks
    .map((chunkId) => String(chunkId || '').trim())
    .filter(
      (chunkId) =>
        chunkId.length > 0 && !/^k?chunk_[a-f0-9]{8,}$/i.test(chunkId),
    )
    .slice(0, 12);
}

function bucketContentMarkdown(bucket: KnowledgeBucketRead): string {
  const metadata = bucket.metadata || {};
  const content = stringFromMetadata(metadata.content).trim();
  if (content) return content;
  const excerpt = stringFromMetadata(metadata.excerpt).trim();
  if (excerpt) return excerpt;
  return bucket.summary || '';
}

function previewRepresentativeChunkIds(buckets: KnowledgeBucketRead[]) {
  const ids: string[] = [];
  buckets.forEach((bucket) => {
    ids.push(...bucketRepresentativeChunks(bucket));
  });
  return Array.from(new Set(ids)).slice(0, 3);
}

function previewEvidenceItems(
  buckets: KnowledgeBucketRead[],
  chunkCount: number,
  limit: number,
) {
  const bucketItems = buckets
    .filter((bucket) => bucket.chunk_count > 0)
    .slice(0, limit)
    .map((bucket) => {
      const sourceSections = bucketSourceSections(bucket)
        .map((section) => String(section))
        .filter(Boolean)
        .slice(0, 2);
      const contentPreview = bucketContentMarkdown(bucket)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
      return {
        key: bucket.id,
        title: bucket.title || bucket.bucket_key || '引用来源',
        summary:
          contentPreview ||
          (sourceSections.length
            ? `${bucket.chunk_count} 个引用来源，覆盖 ${sourceSections.join(' / ')}`
            : `${bucket.chunk_count} 个引用来源，已完成桶级映射。`),
        bucket,
      };
    });
  if (bucketItems.length > 0) return bucketItems;

  const representativeChunkIds = previewRepresentativeChunkIds(buckets);
  if (representativeChunkIds.length > 0) {
    return representativeChunkIds.map((chunkId) => ({
      key: chunkId,
      title: chunkId,
      summary: '代表引用来源，可在详情中查看来源映射。',
    }));
  }

  if (chunkCount > 0) {
    return [
      {
        key: 'chunk-total',
        title: '已入库引用来源',
        summary: `共 ${chunkCount} 个引用来源，当前暂无可展示的桶级代表来源。`,
      },
    ];
  }

  return [];
}

function KnowledgeSearchDebug({
  result,
  loading,
  compact = false,
}: {
  result: KnowledgeSearchResponse | null;
  loading: boolean;
  compact?: boolean;
}) {
  if (loading) {
    return (
      <span className="text-[13px] text-[#858b9c]">
        正在按目录索引和知识图谱检索，并整理引用来源...
      </span>
    );
  }
  if (!result) {
    return <EmptyState description="尚未运行检索" />;
  }
  const selectedConcepts = result.selected_concepts || [];
  const okfCitations = result.okf_citations || [];
  return (
    <div className={`knowledge-search-debug${compact ? ' is-compact' : ''}`}>
      <div className="knowledge-route-trace">
        {(result.route_trace || result.trace || []).map((item, index) => (
          <div
            className="knowledge-route-step"
            key={`${String(item.phase || 'phase')}-${index}`}
          >
            <span>{index + 1}</span>
            <div>
              <strong>{routePhaseLabel(String(item.phase || ''))}</strong>
              <small>{String(item.message || '')}</small>
            </div>
          </div>
        ))}
      </div>
      <Accordion type="multiple" className="flex flex-col gap-[6px]">
        <AccordionItem value="concepts">
          <AccordionTrigger>{`知识图谱 ${selectedConcepts.length}`}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">
              {JSON.stringify(selectedConcepts, null, 2)}
            </pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="okf-citations">
          <AccordionTrigger>{`知识图谱引用 ${okfCitations.length}`}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">
              {JSON.stringify(okfCitations, null, 2)}
            </pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="documents">
          <AccordionTrigger>{`文档 ${result.selected_documents.length}`}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">
              {JSON.stringify(result.selected_documents, null, 2)}
            </pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="sections">
          <AccordionTrigger>{`展开来源 ${result.expanded_sections.length}`}</AccordionTrigger>
          <AccordionContent>
            <pre className="knowledge-json">
              {JSON.stringify(result.expanded_sections, null, 2)}
            </pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="evidence">
          <AccordionTrigger>{`引用来源包 ${result.evidence_pack.length}`}</AccordionTrigger>
          <AccordionContent>
            <div className="knowledge-evidence-list">
              {result.evidence_pack.map((item) => (
                <div className="knowledge-evidence-item" key={item.chunk_id}>
                  <strong
                    {...USER_CONTENT_ATTRIBUTES}
                    className="text-[13px] font-semibold text-foreground"
                  >
                    {item.section_path || item.source_path || item.chunk_id}
                  </strong>
                  <p
                    {...USER_CONTENT_ATTRIBUTES}
                    className="m-0 text-[13px] text-foreground"
                  >
                    {item.excerpt}
                  </p>
                  <span
                    {...USER_CONTENT_ATTRIBUTES}
                    className="text-[13px] text-[#858b9c]"
                  >
                    {item.confidence_reason}
                  </span>
                </div>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function DiscoveryColumn({
  title,
  description,
  items,
  readonly = false,
  onConfirm,
  onReject,
}: {
  title: string;
  description: string;
  items: KnowledgeDiscoveryRead[];
  readonly?: boolean;
  onConfirm: (item: KnowledgeDiscoveryRead) => Promise<void>;
  onReject: (item: KnowledgeDiscoveryRead) => Promise<void>;
}) {
  return (
    <div className="knowledge-discovery-column">
      <div className="knowledge-section-heading">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <KTag>{items.length}</KTag>
      </div>
      {items.length === 0 ? (
        <EmptyState description="暂无内容" />
      ) : (
        <div className="knowledge-discovery-list flex flex-col gap-[12px]">
          {items.map((item) => (
            <div
              className={`knowledge-discovery ${item.suggestion_type}`}
              key={item.id}
            >
              <div className="knowledge-discovery-header">
                <div className="flex flex-wrap items-center gap-[8px]">
                  <strong
                    {...USER_CONTENT_ATTRIBUTES}
                    className="text-[14px] font-semibold text-foreground"
                  >
                    {item.title}
                  </strong>
                  <KTag>{typeLabel(item.suggestion_type)}</KTag>
                  {statusTag(item.status)}
                </div>
                {!readonly && item.status === 'pending' && (
                  <div className="flex items-center gap-[8px]">
                    <UIButton
                      variant="outline"
                      size="icon"
                      className="size-8 rounded-full"
                      onClick={() => void onConfirm(item)}
                    >
                      <CheckOutlined />
                    </UIButton>
                    <UIButton
                      variant="outline"
                      size="icon"
                      className="size-8 rounded-full"
                      onClick={() => void onReject(item)}
                    >
                      <CloseOutlined />
                    </UIButton>
                  </div>
                )}
              </div>
              {item.reason && (
                <p
                  {...USER_CONTENT_ATTRIBUTES}
                  className="my-[6px] text-[13px] text-[#858b9c]"
                >
                  {item.reason}
                </p>
              )}
              <Accordion type="single" collapsible>
                <AccordionItem value="payload" className="border-b-0">
                  <AccordionTrigger className="py-[6px]">
                    查看详情
                  </AccordionTrigger>
                  <AccordionContent>
                    <pre className="knowledge-json">
                      {JSON.stringify(item.payload, null, 2)}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function routePhaseLabel(phase: string) {
  const map: Record<string, string> = {
    document_route: '选择知识库文档',
    document_route_lexical: '按相关性选择知识库文档',
    okf_concept_route: '选择知识图谱',
    okf_only: '仅命中知识图谱',
    bucket_route: '展开内部索引',
    bucket_route_lexical: '按相关性选择内部索引',
    section_expand: '读取来源',
    read_chunks: '读取引用来源',
    evidence_pack: '整理引用来源包',
    no_documents: '没有文档',
    no_buckets: '没有内部索引',
  };
  return map[phase] || phase || '检索阶段';
}

function isEmptyDefaultKnowledgeBase(item: KnowledgeBaseRead) {
  const hasRuntimeKnowledge =
    item.document_count > 0 || item.bucket_count > 0 || item.chunk_count > 0;
  if (
    !hasRuntimeKnowledge &&
    item.metadata?.created_from_document_upload &&
    !item.metadata?.source_document_id
  ) {
    return true;
  }
  return (
    item.name === '默认知识库' &&
    item.document_count === 0 &&
    item.bucket_count === 0 &&
    item.chunk_count === 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function statusTag(status: string) {
  const map: Record<string, { color: string; label: string }> = {
    active: { color: 'green', label: '已上线' },
    published: { color: 'green', label: '已发布' },
    archived: { color: 'default', label: '已下线' },
    draft: { color: 'default', label: '草稿' },
    succeeded: { color: 'green', label: '已完成' },
    ready: { color: 'green', label: '达标' },
    confirmed: { color: 'green', label: '已确认' },
    failed: { color: 'red', label: '失败' },
    pending: { color: 'gold', label: '待处理' },
    running: { color: 'processing', label: '处理中' },
    queued: { color: 'gold', label: '排队中' },
    cancel_requested: { color: 'gold', label: '取消中' },
    cancelled: { color: 'default', label: '已取消' },
  };
  const item = map[status] || { color: 'gold', label: status };
  return <KTag color={item.color}>{item.label}</KTag>;
}

function bucketStatusTag(bucket: KnowledgeBucketRead) {
  if (bucket.status === 'ready') return <KTag color="green">达标</KTag>;
  return <KTag color="gold">待补足</KTag>;
}

const KTAG_TONE_CLASS: Record<string, string> = {
  green: 'bg-[#eafbf0] text-[#018434]',
  red: 'bg-[#fce7e7] text-[#d20b0b]',
  gold: 'bg-[#fff4e0] text-[#c47d09]',
  processing: 'bg-[#e6f0ff] text-[#1a71ff]',
  blue: 'bg-[#e6f0ff] text-[#1a71ff]',
  geekblue: 'bg-[#eceaffe6] text-[#3538cd]',
  cyan: 'bg-[#e0fbff] text-[#0891a5]',
  purple: 'bg-[#f2e9ff] text-[#7a35cd]',
  magenta: 'bg-[#ffe9f4] text-[#c41d7f]',
  default: 'bg-[#f2f3f5] text-[#5b6273]',
};

function KTag({
  color = 'default',
  children,
}: {
  color?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[4px] rounded-[6px] px-[8px] py-px text-[12px] font-medium leading-[18px]',
        KTAG_TONE_CLASS[color] || KTAG_TONE_CLASS.default,
      )}
    >
      {children}
    </span>
  );
}

function KCard({
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
    <section
      className={cn(
        'overflow-hidden rounded-[14px] border border-[#eceef1] bg-white',
        className,
      )}
      {...rest}
    >
      {(title || extra) && (
        <div className="flex min-h-[54px] items-center justify-between gap-[12px] border-b border-[#eceef1] px-[20px] py-[10px]">
          <div className="min-w-0 text-[14px] font-medium text-[#18181a]">
            {title}
          </div>
          {extra ? (
            <div className="shrink-0 text-[#858b9c]">{extra}</div>
          ) : null}
        </div>
      )}
      <div className={cn('p-[20px]', bodyClassName)}>{children}</div>
    </section>
  );
}

function KDialogCancelButton({
  children = '取消',
  className,
  ...props
}: React.ComponentProps<typeof UIButton>) {
  return (
    <UIButton
      variant="outline"
      className={cn(DIALOG_CANCEL_BUTTON_CLASS, className)}
      {...props}
    >
      {children}
    </UIButton>
  );
}

function KDialogPrimaryButton({
  children,
  className,
  ...props
}: React.ComponentProps<typeof UIButton>) {
  return (
    <UIButton className={cn(DIALOG_PRIMARY_BUTTON_CLASS, className)} {...props}>
      {children}
    </UIButton>
  );
}

function KDialog({
  open,
  title,
  width,
  className,
  footer,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  width?: number | string;
  className?: string;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        style={
          width
            ? { maxWidth: typeof width === 'number' ? `${width}px` : width }
            : undefined
        }
        className={cn(
          'flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[560px]',
          className,
        )}
      >
        <DialogTitle
          className="px-[24px] py-[16px] text-[16px] font-semibold text-foreground"
          asChild={typeof title !== 'string'}
        >
          {typeof title === 'string' ? title : <div>{title}</div>}
        </DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto px-[24px] pb-[16px]">
          {children}
        </div>
        {footer ? <div className={DIALOG_FOOTER_CLASS}>{footer}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ description }: { description: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-[6px] py-[36px] text-center text-[13px] text-[#858b9c]">
      {description}
    </div>
  );
}

function FileDropzone({
  accept,
  multiple = false,
  disabled = false,
  onFiles,
  children,
}: {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const emit = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-[12px] border border-dashed border-border bg-(--surface-subtle) px-[16px] py-[28px] text-center transition-colors',
        dragActive && 'border-[#1a71ff] bg-[#1a71ff]/5',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        if (!disabled) emit(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          emit(event.target.files);
          event.target.value = '';
        }}
      />
      {children}
    </div>
  );
}

function conceptPath(conceptId: string) {
  return conceptId
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

const CONCEPT_TYPE_LABELS = new Map<string, string>([
  ['Source Document', '原始资料'],
  ['Source Section', '资料页'],
  ['Topic', '主题'],
  ['Playbook', '流程知识'],
  ['Business Rule', '业务规则'],
  ['Query Analysis', '查询分析'],
]);

function conceptTypeLabel(type: string) {
  return CONCEPT_TYPE_LABELS.get(type) || type || '概念';
}

function conceptTypeColor(type: string) {
  const map: Record<string, string> = {
    'Source Document': 'blue',
    'Source Section': 'cyan',
    Topic: 'green',
    Playbook: 'purple',
    'Business Rule': 'gold',
    'Query Analysis': 'magenta',
  };
  return map[type] || 'default';
}

function sortWikiConcepts(
  concepts: KnowledgeConceptRead[],
  dateLocale: string,
) {
  const rank: Record<string, number> = {
    'Source Document': 0,
    'Source Section': 1,
    Topic: 2,
    Playbook: 3,
    'Business Rule': 4,
    'Query Analysis': 5,
  };
  return [...concepts].sort((left, right) => {
    const leftRank = rank[left.concept_type] ?? 99;
    const rightRank = rank[right.concept_type] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left.title || left.concept_id).localeCompare(
      right.title || right.concept_id,
      dateLocale,
    );
  });
}

function buildWikiIndexGroups(
  concepts: KnowledgeConceptRead[],
  dateLocale: string,
): WikiIndexGroup[] {
  const groupMap = new Map<string, WikiIndexGroup>();
  concepts.forEach((concept) => {
    const key = wikiIndexGroupKey(concept);
    const existing = groupMap.get(key);
    if (existing) {
      existing.concepts.push(concept);
      existing.description = wikiIndexGroupDescription(existing.concepts);
      return;
    }
    groupMap.set(key, {
      key,
      title: wikiIndexGroupTitle(concept),
      description: wikiIndexGroupDescription([concept]),
      concepts: [concept],
    });
  });
  return Array.from(groupMap.values()).map((group) => ({
    ...group,
    concepts: sortWikiConcepts(group.concepts, dateLocale),
  }));
}

function wikiIndexGroupKey(concept: KnowledgeConceptRead) {
  const sourceDocument = stringFromMetadata(
    concept.frontmatter?.source_document,
  );
  if (sourceDocument) return `source:${sourceDocument}`;
  const firstSource = concept.source_refs.find(
    (item) => isRecord(item) && (item.source_document || item.document_id),
  );
  if (isRecord(firstSource)) {
    const label = String(
      firstSource.source_document || firstSource.document_id || '',
    ).trim();
    if (label) return `source:${label}`;
  }
  return `type:${concept.concept_type || '知识图谱'}`;
}

function wikiIndexGroupTitle(concept: KnowledgeConceptRead) {
  const sourceDocument = stringFromMetadata(
    concept.frontmatter?.source_document,
  );
  if (sourceDocument) return sourceDocument.replace(/^sources\//, '');
  const firstSource = concept.source_refs.find(
    (item) => isRecord(item) && (item.source_document || item.document_id),
  );
  if (isRecord(firstSource)) {
    const label = String(
      firstSource.source_document || firstSource.document_id || '',
    ).trim();
    if (label) return label.replace(/^sources\//, '');
  }
  return conceptTypeLabel(concept.concept_type);
}

function wikiIndexGroupDescription(concepts: KnowledgeConceptRead[]) {
  const types = Array.from(
    new Set(
      concepts
        .map((concept) => conceptTypeLabel(concept.concept_type))
        .filter(Boolean),
    ),
  ).slice(0, 4);
  const samples = concepts
    .map((concept) => concept.title || concept.concept_id)
    .filter(Boolean)
    .slice(0, 3);
  const typeText = types.length ? types.join('、') : '知识图谱';
  const sampleText = samples.length ? `，包含 ${samples.join(' / ')}` : '';
  return `${concepts.length} 个知识图谱，覆盖 ${typeText}${sampleText}`;
}

function conceptSummary(concept: KnowledgeConceptRead) {
  const body = concept.content_md
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/[#>*_\-[\]()`]/g, ' ')
    .trim();
  return body.length > 160 ? `${body.slice(0, 160)}...` : body || '暂无摘要';
}

function okfFrontmatterValue(markdown: string, key: string, fallback = '') {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return fallback;
  const line = frontmatter[1]
    .split('\n')
    .find((item) => item.trim().startsWith(`${key}:`));
  if (!line) return fallback;
  const raw = line.slice(line.indexOf(':') + 1).trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return raw.replace(/^['"]|['"]$/g, '');
  }
}

function updateOkfFrontmatterValue(
  markdown: string,
  key: string,
  value: string,
) {
  const normalizedValue = JSON.stringify(value);
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) {
    return `---\n${key}: ${normalizedValue}\n---\n\n${markdown}`;
  }
  const lines = frontmatter[1].split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}:`));
  if (index >= 0) {
    lines[index] = `${key}: ${normalizedValue}`;
  } else {
    lines.push(`${key}: ${normalizedValue}`);
  }
  return markdown.replace(
    /^---\n[\s\S]*?\n---/,
    `---\n${lines.join('\n')}\n---`,
  );
}

function formatDateTime(value: string, dateLocale: string) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(dateLocale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function typeLabel(type: string) {
  if (type === 'skill') return '技能';
  if (type === 'tool') return '工具';
  return '提示';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() || '' : result);
    };
    reader.readAsDataURL(file);
  });
}
