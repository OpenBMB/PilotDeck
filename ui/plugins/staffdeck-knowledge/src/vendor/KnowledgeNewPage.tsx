// @ts-nocheck
import './FormalKnowledgeLayout.css';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AppHeader, CapabilityScopeBadge, CapabilityScopeControl, FileAddOutlined, IconFolder, InboxOutlined,
  KDialogCancelButton, KnowledgeGraphCanvas as HostKnowledgeGraphVisualization, Progress, StatCard, UIButton, UISelect,
  SelectContent, SelectItem, SelectTrigger, SelectValue, cn, useKnowledgePageHost,
} from './KnowledgePageHost';
import type { CapabilityScope, KnowledgeDiscoveryRead, KnowledgeIngestJobRead } from './KnowledgePageHost';
import { KnowledgeJobCard } from './KnowledgePage';

const TERMINAL_JOB_STATUSES = new Set([
  'succeeded', 'failed', 'cancelled', 'canceled',
  'completed', 'complete', 'done', 'error',
]);

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function KCard({ title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-[16px] border border-[#eef0f4] bg-white p-[20px]">
      {(title || right) && (
        <header className="mb-[16px] flex items-center justify-between">
          {title && (
            <div className="flex items-center gap-[8px] text-[15px] font-semibold text-[#18181a]">
              {title}
            </div>
          )}
          {right}
        </header>
      )}
      {children}
    </section>
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
  children: React.ReactNode;
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
        if (disabled) return;
        emit(event.dataTransfer?.files ?? null);
      }}
    >
      {children}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept}
        multiple={multiple}
        onChange={(event) => emit(event.target.files)}
      />
    </div>
  );
}

export default function KnowledgeNewPage() {
  const { api, navigate, notify, tenantId: TENANT_ID, visibleEmployeeAgents, canManageEmployeeAgent, isEnterpriseAdmin } = useKnowledgePageHost();
  const navigateBack = useNavigate();
  const [agentId, setAgentId] = useState<string>('');
  const [agents, setAgents] = useState<any[]>([]);
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>('general');
  const [uploading, setUploading] = useState(false);
  const [uploadedJobs, setUploadedJobs] = useState<KnowledgeIngestJobRead[]>([]);
  const [existingJobs, setExistingJobs] = useState<KnowledgeIngestJobRead[]>([]);
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string>('');

  async function loadAgents() {
    try {
      const rows = await api.get<any[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`);
      setAgents(rows);
      // Single-user hosts expose only the copy target (no overall agent), so
      // fall back to it — otherwise agentId stays empty and the job polling
      // below never starts.
      const primary =
        rows.find((a: any) => a.is_overall) ||
        rows.find((a: any) => a.copy_target) ||
        rows[0];
      if (primary) setAgentId(primary.id);
    } catch {
      // no agents — leave empty
    }
  }

  async function loadJobs() {
    try {
      const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
      const rows = await api.get<KnowledgeIngestJobRead[]>(
        `/api/enterprise/knowledge/jobs?tenant_id=${TENANT_ID}${suffix}`,
      );
      setExistingJobs(rows);
    } catch {
      // jobs endpoint may not be available yet
    }
  }

  useEffect(() => { void loadAgents(); }, []);
  useEffect(() => { void loadJobs(); }, [agentId]);

  const effectiveAgentId = agentId || undefined;
  const scope = effectiveAgentId
    ? { kind: 'agent' as const, agentId: effectiveAgentId }
    : { kind: 'agent' as const, agentId: 'local' };

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        const contentBase64 = await fileToBase64(file);
        // Try upload-auto first (auto-creates KB from document)
        let job: any;
        try {
          job = await api.post<any>('/api/enterprise/knowledge/documents/upload-auto', {
            tenant_id: TENANT_ID,
            agent_id: effectiveAgentId,
            filename: file.name,
            content_base64: contentBase64,
            capability_scope: capabilityScope,
          });
        } catch {
          // Fallback: upload to selected KB or create new one first
          const kbId = selectedKnowledgeBaseId || (await createBaseFromScope());
          job = await api.post<any>('/api/enterprise/knowledge/documents', {
            tenant_id: TENANT_ID,
            agent_id: effectiveAgentId,
            knowledge_base_id: kbId,
            filename: file.name,
            content_base64: contentBase64,
            title: file.name.replace(/\.[^.]+$/, ''),
          });
        }
        if (job) {
          setUploadedJobs((prev) => [job, ...prev]);
          if (job.knowledge_base_id) setSelectedKnowledgeBaseId(String(job.knowledge_base_id));
        }
      }
      notify.success(`已上传 ${files.length} 个文档`);
      void loadJobs();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function createBaseFromScope(): Promise<string> {
    const suffix = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
    const base = await api.post<any>(`/api/enterprise/knowledge-bases${suffix}`, {
      tenant_id: TENANT_ID,
      name: '临时知识库',
      status: 'active',
      capability_scope: capabilityScope,
    });
    return base.id;
  }

  function goBack() {
    navigateBack(-1);
  }

  const allJobs = useMemo(() => {
    const seen = new Set<string>();
    return [...uploadedJobs, ...existingJobs].filter((job) => {
      const id = job?.id;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [uploadedJobs, existingJobs]);

  // Mirror the current job list into refs so the polling loop never depends on
  // array identity. Keying the effect on `allJobs` used to re-arm the timer on
  // every state update, which silently dropped the next ticks.
  const jobsRef = useRef<KnowledgeIngestJobRead[]>([]);
  jobsRef.current = allJobs;
  const apiRef = useRef(api);
  apiRef.current = api;

  // Poll non-terminal jobs through the host adapter (→ get_knowledge_job),
  // so stage/progress/metadata stay in sync with the ingest pipeline.
  useEffect(() => {
    // Do not gate polling on agentId: single-user hosts may report no agent
    // while uploads still produce jobs that need stage/progress updates.
    const suffix = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : '';
    const timer = window.setInterval(() => {
      const active = jobsRef.current.filter(
        (job) => job && job.id && !TERMINAL_JOB_STATUSES.has(String(job.status || '').toLowerCase()),
      );
      active.forEach((job) => {
        void apiRef.current
          .get<KnowledgeIngestJobRead>(
            `/api/enterprise/knowledge/jobs/${job.id}?tenant_id=${TENANT_ID}${suffix}`,
          )
          .then((next) => {
            if (!next || !next.id) return;
            setUploadedJobs((prev) =>
              prev.some((item) => item.id === next.id)
                ? prev.map((item) => (item.id === next.id ? next : item))
                : prev,
            );
            setExistingJobs((prev) =>
              prev.some((item) => item.id === next.id)
                ? prev.map((item) => (item.id === next.id ? next : item))
                : prev,
            );
          })
          .catch(() => {});
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [agentId, TENANT_ID]);

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]">
      {/* Breadcrumb header */}
      <div className="mb-[16px] flex items-center justify-between">
        <nav className="flex items-center gap-[6px] text-[13px] text-[#858b9c]">
          <button onClick={goBack} className="hover:text-[#18181a] transition-colors">知识库</button>
          <span>/</span>
          <span className="text-[#18181a] font-medium">新建</span>
        </nav>
        <UIButton variant="outline" onClick={goBack} className="h-[32px] px-[16px] text-[12px]">
          返回
        </UIButton>
      </div>

      {/* Title */}
      <div className="mb-[24px]">
        <h1 className="text-[20px] font-semibold text-[#18181a]">新建知识库</h1>
        <p className="mt-[6px] text-[13px] text-[#858b9c]">
          上传文档即可创建知识库，系统会先生成知识索引、判断新资料、引用来源与自动发现建议。
        </p>
      </div>

      <div className="flex flex-col gap-[16px]">
        {/* Upload card */}
        <KCard title="上传文档即创建知识库" right={
          <UIButton variant="outline" onClick={() => navigate('/enterprise/knowledge')} className="h-[28px] px-[12px] text-[12px]">
            管理已有知识库
          </UIButton>
        }>
          <p className="mb-[16px] text-[12px] text-[#858b9c]">
            一个文件对应一个独立知识库；当你有明确知识主题时，按类别分别创建。
          </p>

          {/* Example row */}
          <div className="mb-[16px] flex items-center gap-[8px] text-[12px]">
            <span className="text-[#858b9c]">示例：</span>
            <span className="rounded-[6px] border border-[#eef0f4] bg-[#f7f8fb] px-[10px] py-[4px] text-[#18181a]">行政-会议费用预算管理规定</span>
          </div>

          {/* Capability scope */}
          <div className="mb-[16px] flex items-center justify-between">
            <div className="flex items-center gap-[6px] text-[13px]">
              <span className="text-[#18181a] font-medium">能力范围</span>
              <span className="text-[#858b9c]">（帮助 AI 自动匹配最相关的知识库）</span>
            </div>
            <CapabilityScopeBadge value={capabilityScope} />
          </div>
          <div className="mb-[20px]">
            <CapabilityScopeControl
              value={capabilityScope}
              onChange={setCapabilityScope}
              resourceType="knowledge_base"
            />
          </div>

          {/* Dropzone */}
          <FileDropzone
            accept=".doc,.docx,.txt,.md,.html,.pdf"
            onFiles={(files) => void handleFiles(files)}
            disabled={uploading}
          >
            {uploading ? (
              <>
                <div className="mb-[8px] flex items-center gap-[8px] text-[#858b9c]">
                  <Progress value={undefined} className="h-[4px] w-[200px]" />
                </div>
                <p className="m-0 text-[14px] font-medium text-foreground">正在上传...</p>
              </>
            ) : (
              <>
                <FileAddOutlined className="mb-[8px] text-[32px] text-[#1a71ff]" />
                <p className="m-0 text-[14px] font-medium text-foreground">拖拽文档到这里，或点击上传</p>
                <p className="mt-[4px] mb-0 text-[12px] text-[#858b9c]">
                  支持 doc/docx/txt/md/html/pdf；旧版 doc 会转换为 docx。
                </p>
              </>
            )}
          </FileDropzone>
        </KCard>

        {/* Jobs card */}
        <KCard title="入库任务">
          {allJobs.length === 0 ? (
            <p className="py-[16px] text-center text-[13px] text-[#858b9c]">
              上传后这里会显示处理进度，知识图谱结构来源入库通道。
            </p>
          ) : (
            <div className="flex flex-col gap-[10px]">
              {allJobs.slice(0, 10).map((job, index) => (
                <KnowledgeJobCard key={`${job.id}-${index}`} job={job} />
              ))}
            </div>
          )}
        </KCard>
      </div>
    </div>
  );
}

