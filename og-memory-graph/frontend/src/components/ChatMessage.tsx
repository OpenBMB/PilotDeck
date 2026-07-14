import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConvMessage } from '../api/client';

interface Props {
  msg: ConvMessage;
  isStreaming?: boolean;
}

const TOOL_LABEL: Record<string, string> = {
  get_cluster_info: '📊 集群信息',
  get_graph_summary: '🔮 图谱摘要',
  search_nodes: '🔍 节点搜索',
  get_report_content: '📄 报告内容',
  list_clusters: '📋 集群列表',
  run_pipeline: '▶ 启动流水线',
  get_task_status: '⏳ 任务状态',
  write_memory: '💾 写入记忆',
  set_preference: '⚙ 更新偏好',
  read_memory: '📖 读取记忆'
};

function ToolCard({ ev }: {ev: NonNullable<ConvMessage['tool_events']>[number];}) {
  const label = TOOL_LABEL[ev.name] ?? `🔧 ${ev.name}`;
  const isResult = ev.type === 'tool_result';

  return (
    <div className="tool-card">
      <div className="tool-card-hd">
        <span className="tool-card-label">{label}</span>
        {isResult && <span className="tool-card-done">✓</span>}
      </div>
      {ev.type === 'tool_call' && !!ev.input &&
      <div className="tool-card-body">
          {Object.entries(ev.input as Record<string, unknown>).map(([k, v]) =>
        <div key={k} className="tool-card-row">
              <span className="tool-card-k">{k}</span>
              <span className="tool-card-v">{String(v)}</span>
            </div>
        )}
        </div>
      }
      {isResult && ev.result !== undefined &&
      <div className="tool-card-result">
          {typeof ev.result === 'string' ?
        ev.result :
        JSON.stringify(ev.result, null, 2).slice(0, 300)
        }
          {JSON.stringify(ev.result ?? '').length > 300 ? '…' : ''}
        </div>
      }
    </div>);

}

export default function ChatMessage({ msg, isStreaming }: Props) {
  const isUser = msg.role === 'user';

  return (
    <div className={`chat-msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="chat-bubble">
        {}
        {!isUser && (msg.tool_events ?? []).map((ev, i) =>
        <ToolCard key={i} ev={ev} />
        )}

        {}
        {msg.content &&
        <div className="chat-content">
            {isUser ?
          <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span> :
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          }
            {isStreaming && <span className="chat-cursor">▋</span>}
          </div>
        }
      </div>
    </div>);

}
