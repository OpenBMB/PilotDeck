import type { CSSProperties } from 'react';

export type StaffdeckIconName =
  | 'arrow'
  | 'branch'
  | 'calendar'
  | 'chat'
  | 'check'
  | 'close'
  | 'cloud'
  | 'clock'
  | 'code'
  | 'database'
  | 'desktop'
  | 'download'
  | 'edit'
  | 'eye'
  | 'file'
  | 'filter'
  | 'folder'
  | 'globe'
  | 'grid'
  | 'history'
  | 'image'
  | 'inbox'
  | 'info'
  | 'logout'
  | 'lock'
  | 'model'
  | 'moon'
  | 'more'
  | 'pause'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'save'
  | 'search'
  | 'send'
  | 'sidebar-close'
  | 'sidebar-open'
  | 'spark'
  | 'stop'
  | 'sun'
  | 'thumb-down'
  | 'thumb-up'
  | 'tool'
  | 'trash'
  | 'upload'
  | 'user'
  | 'warning';

type StaffdeckIconProps = {
  name: StaffdeckIconName;
  className?: string;
  size?: number;
  style?: CSSProperties;
};

const iconPaths: Record<StaffdeckIconName, string[]> = {
  arrow: ['M9 5l6 7-6 7'],
  branch: ['M7 5v5a4 4 0 0 0 4 4h6', 'M7 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M17 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M7 23a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M7 19v-9'],
  calendar: ['M7 3v4', 'M17 3v4', 'M4 8h16', 'M5 5h14v15H5V5Z', 'M8 12h.1', 'M12 12h.1', 'M16 12h.1'],
  chat: ['M6 7.5h12a2.5 2.5 0 0 1 2.5 2.5v4.5A2.5 2.5 0 0 1 18 17H11l-4.5 3v-3H6A2.5 2.5 0 0 1 3.5 14.5V10A2.5 2.5 0 0 1 6 7.5Z', 'M8 11.2h7.5', 'M8 14h4.5'],
  check: ['M5 12.5l4 4L19 6.5'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  cloud: ['M7.5 18h9.5a4 4 0 0 0 .7-7.9A6.2 6.2 0 0 0 5.8 11.5 3.4 3.4 0 0 0 7.5 18Z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3.5 2'],
  code: ['M9 8l-4 4 4 4', 'M15 8l4 4-4 4', 'M13 5l-2 14'],
  database: ['M5 7c0 2 14 2 14 0S5 5 5 7Z', 'M5 7v5c0 2 14 2 14 0V7', 'M5 12v5c0 2 14 2 14 0v-5'],
  desktop: ['M4 5h16v11H4V5Z', 'M9 20h6', 'M12 16v4'],
  download: ['M12 4v10', 'M8 10l4 4 4-4', 'M5 20h14'],
  edit: ['M5 19h4.2L19 9.2 14.8 5 5 14.8V19Z', 'M13.5 6.5l4 4'],
  eye: ['M3.5 12s3-5.5 8.5-5.5S20.5 12 20.5 12s-3 5.5-8.5 5.5S3.5 12 3.5 12Z', 'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  file: ['M6 4h8l4 4v12H6V4Z', 'M14 4v5h5', 'M9 13h6', 'M9 16h4'],
  filter: ['M5 7h14', 'M8 12h8', 'M11 17h2'],
  folder: ['M4 7h6l2 2h8v10H4V7Z'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3 12h18', 'M12 3c2.2 2.4 3.2 5.3 3.2 9s-1 6.6-3.2 9c-2.2-2.4-3.2-5.3-3.2-9S9.8 5.4 12 3Z'],
  grid: ['M5 5h5v5H5V5Z', 'M14 5h5v5h-5V5Z', 'M5 14h5v5H5v-5Z', 'M14 14h5v5h-5v-5Z'],
  history: ['M4 7v5h5', 'M4.8 12a7.2 7.2 0 1 0 2.1-5.1L4 9.8', 'M12 8v4l3 2'],
  image: ['M5 5h14v14H5V5Z', 'M8.5 10a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z', 'M5 16l4.4-4.4 3.4 3.4 2.1-2.1L19 17'],
  inbox: ['M4 5h16l-2 10h-3a3 3 0 0 1-6 0H6L4 5Z', 'M4 15v4h16v-4'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5', 'M12 8h.1'],
  logout: ['M9 5H6.5A2.5 2.5 0 0 0 4 7.5v9A2.5 2.5 0 0 0 6.5 19H9', 'M14 8l4 4-4 4', 'M18 12H9'],
  lock: ['M7 11h10v9H7v-9Z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  model: ['M12 4l7 4v8l-7 4-7-4V8l7-4Z', 'M12 12l7-4', 'M12 12v8', 'M12 12L5 8'],
  moon: ['M20 14.7A7.5 7.5 0 0 1 9.3 4a8.5 8.5 0 1 0 10.7 10.7Z'],
  more: ['M6 12h.1', 'M12 12h.1', 'M18 12h.1'],
  pause: ['M8 6v12', 'M16 6v12'],
  play: ['M8 5v14l11-7L8 5Z'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M19 8a7 7 0 0 0-12.2-2.4L5 8', 'M5 5v3h3', 'M5 16a7 7 0 0 0 12.2 2.4L19 16', 'M19 19v-3h-3'],
  save: ['M5 4h12l2 2v14H5V4Z', 'M8 4v6h8V4', 'M8 20v-6h8v6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M16.5 16.5 21 21'],
  send: ['M4 12 20 5l-7 14-2-6-7-1Z', 'M11 13l9-8'],
  'sidebar-close': ['M4 5h16v14H4V5Z', 'M9 5v14', 'M15 9l-3 3 3 3'],
  'sidebar-open': ['M4 5h16v14H4V5Z', 'M9 5v14', 'M12 9l3 3-3 3'],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z', 'M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z'],
  stop: ['M7 7h10v10H7V7Z'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  'thumb-down': ['M7 3h3.2c1.5 0 2.9.8 3.6 2.1L16 9.5V14H9.4l.8 4.1A1.6 1.6 0 0 1 8.6 20H8l-3-6V5a2 2 0 0 1 2-2Z', 'M16 5h3v9h-3'],
  'thumb-up': ['M7 21h3.2c1.5 0 2.9-.8 3.6-2.1L16 14.5V10H9.4l.8-4.1A1.6 1.6 0 0 0 8.6 4H8l-3 6v9a2 2 0 0 0 2 2Z', 'M16 10h3v9h-3'],
  tool: ['M14.5 5.5a4.5 4.5 0 0 0 4 6.3L11 19.3a2.1 2.1 0 0 1-3-3l7.5-7.5a4.5 4.5 0 0 0-1-3.3Z', 'M7.2 16.8l2 2'],
  trash: ['M5 7h14', 'M9 7V5h6v2', 'M8 10v8', 'M12 10v8', 'M16 10v8', 'M7 7l1 13h8l1-13'],
  upload: ['M12 20V10', 'M8 14l4-4 4 4', 'M5 4h14'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4.5 20c1.2-4.1 13.8-4.1 15 0'],
  warning: ['M12 4 21 20H3L12 4Z', 'M12 9v5', 'M12 17h.1'],
};

export default function StaffdeckIcon({ name, className = '', size = 18, style }: StaffdeckIconProps) {
  return (
    <svg
      className={`sd1-icon sd1-icon-${name} ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {iconPaths[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
