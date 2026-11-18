import type { CSSProperties } from 'react';
import StaffdeckIcon, { type StaffdeckIconName } from './FormalStaffdeckIcon';

type IconProps = {
  className?: string;
  rotate?: number;
  spin?: boolean;
  style?: CSSProperties;
  [key: string]: unknown;
};

function Sd1AntIcon({ name, rotate = 0, spin = false, className = '', style }: IconProps & { name: StaffdeckIconName }) {
  const transform = [style?.transform, rotate ? `rotate(${rotate}deg)` : ''].filter(Boolean).join(' ');
  return (
    <StaffdeckIcon
      name={name}
      className={`${spin ? 'sd1-icon-spin ' : ''}${className}`.trim()}
      style={{ ...style, transform: transform || undefined }}
    />
  );
}

export const ApiOutlined = (props: IconProps) => <Sd1AntIcon name="model" {...props} />;
export const AppstoreOutlined = (props: IconProps) => <Sd1AntIcon name="grid" {...props} />;
export const ArrowLeftOutlined = (props: IconProps) => <Sd1AntIcon name="arrow" rotate={180} {...props} />;
export const AuditOutlined = (props: IconProps) => <Sd1AntIcon name="file" {...props} />;
export const BranchesOutlined = (props: IconProps) => <Sd1AntIcon name="branch" {...props} />;
export const CheckCircleFilled = (props: IconProps) => <Sd1AntIcon name="check" {...props} />;
export const CheckCircleOutlined = (props: IconProps) => <Sd1AntIcon name="check" {...props} />;
export const CheckOutlined = (props: IconProps) => <Sd1AntIcon name="check" {...props} />;
export const ClockCircleOutlined = (props: IconProps) => <Sd1AntIcon name="clock" {...props} />;
export const CloseCircleOutlined = (props: IconProps) => <Sd1AntIcon name="close" {...props} />;
export const CloseOutlined = (props: IconProps) => <Sd1AntIcon name="close" {...props} />;
export const CloudOutlined = (props: IconProps) => <Sd1AntIcon name="cloud" {...props} />;
export const CloudSyncOutlined = (props: IconProps) => <Sd1AntIcon name="refresh" {...props} />;
export const CodeOutlined = (props: IconProps) => <Sd1AntIcon name="code" {...props} />;
export const DatabaseOutlined = (props: IconProps) => <Sd1AntIcon name="database" {...props} />;
export const DeleteOutlined = (props: IconProps) => <Sd1AntIcon name="trash" {...props} />;
export const DesktopOutlined = (props: IconProps) => <Sd1AntIcon name="desktop" {...props} />;
export const DownOutlined = (props: IconProps) => <Sd1AntIcon name="arrow" rotate={90} {...props} />;
export const DownloadOutlined = (props: IconProps) => <Sd1AntIcon name="download" {...props} />;
export const EditOutlined = (props: IconProps) => <Sd1AntIcon name="edit" {...props} />;
export const ExperimentOutlined = (props: IconProps) => <Sd1AntIcon name="tool" {...props} />;
export const EyeOutlined = (props: IconProps) => <Sd1AntIcon name="eye" {...props} />;
export const FileAddOutlined = (props: IconProps) => <Sd1AntIcon name="plus" {...props} />;
export const FileMarkdownOutlined = (props: IconProps) => <Sd1AntIcon name="file" {...props} />;
export const FileSearchOutlined = (props: IconProps) => <Sd1AntIcon name="file" {...props} />;
export const FileTextOutlined = (props: IconProps) => <Sd1AntIcon name="file" {...props} />;
export const FolderOpenOutlined = (props: IconProps) => <Sd1AntIcon name="folder" {...props} />;
export const GithubOutlined = (props: IconProps) => <Sd1AntIcon name="code" {...props} />;
export const HistoryOutlined = (props: IconProps) => <Sd1AntIcon name="history" {...props} />;
export const IdcardOutlined = (props: IconProps) => <Sd1AntIcon name="user" {...props} />;
export const InboxOutlined = (props: IconProps) => <Sd1AntIcon name="inbox" {...props} />;
export const InfoCircleOutlined = (props: IconProps) => <Sd1AntIcon name="info" {...props} />;
export const LoadingOutlined = (props: IconProps) => <Sd1AntIcon name="refresh" spin {...props} />;
export const LockOutlined = (props: IconProps) => <Sd1AntIcon name="lock" {...props} />;
export const MessageOutlined = (props: IconProps) => <Sd1AntIcon name="chat" {...props} />;
export const MoonOutlined = (props: IconProps) => <Sd1AntIcon name="moon" {...props} />;
export const MoreOutlined = (props: IconProps) => <Sd1AntIcon name="more" {...props} />;
export const PauseCircleOutlined = (props: IconProps) => <Sd1AntIcon name="pause" {...props} />;
export const PlayCircleOutlined = (props: IconProps) => <Sd1AntIcon name="play" {...props} />;
export const PlusOutlined = (props: IconProps) => <Sd1AntIcon name="plus" {...props} />;
export const ProfileOutlined = (props: IconProps) => <Sd1AntIcon name="filter" {...props} />;
export const ReloadOutlined = (props: IconProps) => <Sd1AntIcon name="refresh" {...props} />;
export const RightOutlined = (props: IconProps) => <Sd1AntIcon name="arrow" {...props} />;
export const RollbackOutlined = (props: IconProps) => <Sd1AntIcon name="history" {...props} />;
export const SaveOutlined = (props: IconProps) => <Sd1AntIcon name="save" {...props} />;
export const SearchOutlined = (props: IconProps) => <Sd1AntIcon name="search" {...props} />;
export const SendOutlined = (props: IconProps) => <Sd1AntIcon name="send" {...props} />;
export const SolutionOutlined = (props: IconProps) => <Sd1AntIcon name="spark" {...props} />;
export const StopOutlined = (props: IconProps) => <Sd1AntIcon name="stop" {...props} />;
export const SunOutlined = (props: IconProps) => <Sd1AntIcon name="sun" {...props} />;
export const SyncOutlined = (props: IconProps) => <Sd1AntIcon name="refresh" {...props} />;
export const TeamOutlined = (props: IconProps) => <Sd1AntIcon name="user" {...props} />;
export const ToolOutlined = (props: IconProps) => <Sd1AntIcon name="tool" {...props} />;
export const UploadOutlined = (props: IconProps) => <Sd1AntIcon name="upload" {...props} />;
export const UserOutlined = (props: IconProps) => <Sd1AntIcon name="user" {...props} />;
export const UsergroupAddOutlined = (props: IconProps) => <Sd1AntIcon name="user" {...props} />;
export const WarningOutlined = (props: IconProps) => <Sd1AntIcon name="warning" {...props} />;
