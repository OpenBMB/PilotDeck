import { Dialog, DialogContent, DialogTitle, DetailField, IconSkill } from './SkillsPageHost';
import { USER_CONTENT_ATTRIBUTES } from './FormalUserContent';

export type StaffDeckSopVersion = {
  id: string;
  skill_id?: string;
  name: string;
  version: string;
  business_domain?: string;
  status?: string;
  call_count?: number;
  positive_rate?: number;
  negative_rate?: number;
  updated_at: string;
  content?: unknown;
};

export type SopVersionDetailLabels = {
  title: string;
  emptyTitle: string;
  version: string;
  domain: string;
  status: string;
  calls: string;
  positive: string;
  negative: string;
  updated: string;
  draft: string;
  published: string;
  archived: string;
  unknown: string;
};

const DEFAULT_LABELS: SopVersionDetailLabels = {
  title: '版本详情', emptyTitle: '版本详情', version: '版本', domain: '业务域', status: '状态',
  calls: '调用次数', positive: '好评率', negative: '差评率', updated: '更新时间',
  draft: '草稿', published: '已启用', archived: '已停用', unknown: '-',
};

/**
 * Source: StaffDeck frontend-enterprise/src/pages/SkillsPage.tsx VersionDetailDialog.
 * Host adapters provide the selected version and localized labels; the view
 * keeps the source page's detail fields and serialized SOP content visible.
 */
export function SopVersionDetailDialog({ detail, onClose, labels = DEFAULT_LABELS }: {
  detail: StaffDeckSopVersion | null;
  onClose: () => void;
  labels?: SopVersionDetailLabels;
}) {
  const status = detail?.status === 'published' ? labels.published : detail?.status === 'draft' ? labels.draft : detail?.status === 'archived' ? labels.archived : detail?.status || labels.unknown;
  // Mechanical restoration of the original VersionDetailDialog layout.
  // Controlled Close, focus, portal and Escape belong to the formal Host.
  return <Dialog open={Boolean(detail)} onOpenChange={(next: boolean) => !next && onClose()}>
    <DialogContent aria-describedby={undefined} className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[900px]">
      <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
        <IconSkill className="size-[14px] shrink-0" />
        <DialogTitle className="min-w-0 truncate text-[14px] font-normal leading-none text-[#757f9c]">
          {detail ? <>{labels.title}：<span {...USER_CONTENT_ATTRIBUTES}>{detail.name}</span> / <span {...USER_CONTENT_ATTRIBUTES}>{detail.version}</span></> : labels.emptyTitle}
        </DialogTitle>
        <button type="button" aria-label="关闭" className="ml-auto shrink-0 rounded px-2 py-1 text-lg" onClick={onClose}>×</button>
      </div>
      {detail && <div className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto px-[12px]">
        <div className="grid grid-cols-2 gap-[10px] max-[520px]:grid-cols-1">
          <DetailField label={labels.version}><span {...USER_CONTENT_ATTRIBUTES}>{detail.version}</span></DetailField>
          <DetailField label={labels.domain}>{detail.business_domain ? <span {...USER_CONTENT_ATTRIBUTES}>{detail.business_domain}</span> : labels.unknown}</DetailField>
          <DetailField label={labels.status}>{detail.status === 'published' || detail.status === 'draft' || detail.status === 'archived' ? status : <span {...USER_CONTENT_ATTRIBUTES}>{status}</span>}</DetailField>
          <DetailField label={labels.calls}>{detail.call_count || 0} 次</DetailField>
          <DetailField label={labels.positive}>{`${Math.round((detail.positive_rate || 0) * 100)}%`}</DetailField>
          <DetailField label={labels.negative}>{`${Math.round((detail.negative_rate || 0) * 100)}%`}</DetailField>
          <DetailField label={labels.updated}>{detail.updated_at.slice(0, 10)}</DetailField>
        </div>
        <pre {...USER_CONTENT_ATTRIBUTES} className="overflow-x-auto rounded-[12px] bg-[#f6f6f6] p-[14px] text-[12px] leading-[1.7] text-[#464c5e] wrap-anywhere whitespace-pre-wrap">{skillSourceText(detail)}</pre>
      </div>}
    </DialogContent>
  </Dialog>;
}

function skillSourceText(detail: StaffDeckSopVersion): string {
  if (typeof detail.content === 'string') return detail.content;
  const skill = isRecord(detail.content) ? detail.content : {};
  const nodes = Array.isArray(skill.nodes) ? skill.nodes.filter(isRecord) : [];
  return [
    `# ${text(skill.name) || detail.name}`,
    `- skill_id: ${text(skill.skill_id) || detail.skill_id || '-'}`,
    `- version: ${text(skill.version) || detail.version}`,
    `- business_domain: ${text(skill.business_domain) || detail.business_domain || '-'}`,
    `- description: ${text(skill.description) || '-'}`,
    `- trigger_intents: ${formatList(skill.trigger_intents)}`,
    `- user_utterance_examples: ${formatList(skill.user_utterance_examples)}`,
    `- goal: ${formatList(skill.goal)}`,
    `- required_info: ${formatList(skill.required_info)}`,
    `- response_rules: ${formatList(skill.response_rules)}`,
    '',
    '## 详细节点',
    ...nodes.flatMap((node, index) => [
      '',
      `### 节点 ${index + 1}: ${text(node.name) || text(node.node_id) || `节点 ${index + 1}`}`,
      `- node_id: ${text(node.node_id) || '-'}`,
      `- node_type: ${text(node.type) || 'collect_info'}`,
      `- condition: ${text(node.condition) || '-'}`,
      `- instruction: ${text(node.instruction) || '-'}`,
      `- expected_user_info: ${formatList(node.expected_user_info)}`,
      `- allowed_actions: ${formatList(node.allowed_actions)}`,
    ]),
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function formatList(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.map(String).join(', ') : '-';
}

export default SopVersionDetailDialog;
