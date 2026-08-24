type IconProps = {
  width?: number;
  height?: number;
  className?: string;
};

export function WelcomeWaveIcon({ width = 40, height = 40, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M184,213.27A80,80,0,0,1,74.7,184l-40-69.32a20,20,0,0,1,34.64-20L55.08,70A20,20,0,0,1,89.73,50l6.92,12h0a20,20,0,0,1,34.64-20l30,52A20,20,0,0,1,196,74l17.31,30A80,80,0,0,1,184,213.27Z" opacity="0.2" />
      <path d="M220.17,100,202.86,70a28,28,0,0,0-38.24-10.25,27.69,27.69,0,0,0-9,8.34L138.2,38a28,28,0,0,0-48.48,0A28,28,0,0,0,48.15,74l1.59,2.76A27.67,27.67,0,0,0,38,80.41a28,28,0,0,0-10.24,38.25l40,69.32a87.47,87.47,0,0,0,53.43,41,88.56,88.56,0,0,0,22.92,3,88,88,0,0,0,76.06-132Zm-6.66,62.64A72,72,0,0,1,81.62,180l-40-69.32a12,12,0,0,1,20.78-12L81.63,132a8,8,0,1,0,13.85-8L62,66A12,12,0,1,1,82.78,54L114,108a8,8,0,1,0,13.85-8L103.57,58h0a12,12,0,1,1,20.78-12l33.42,57.9a48,48,0,0,0-5.54,60.6,8,8,0,0,0,13.24-9A32,32,0,0,1,172.78,112a8,8,0,0,0,2.13-10.4L168.23,90A12,12,0,1,1,189,78l17.31,30A71.56,71.56,0,0,1,213.51,162.62ZM184.25,31.71A8,8,0,0,1,194,26a59.62,59.62,0,0,1,36.53,28l.33.57a8,8,0,1,1-13.85,8l-.33-.57a43.67,43.67,0,0,0-26.8-20.5A8,8,0,0,1,184.25,31.71ZM80.89,237a8,8,0,0,1-11.23,1.33A119.56,119.56,0,0,1,40.06,204a8,8,0,0,1,13.86-8,103.67,103.67,0,0,0,25.64,29.72A8,8,0,0,1,80.89,237Z" />
    </svg>
  );
}

export function TranslateIcon({ width = 22, height = 22, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M247.15,212.42l-56-112a8,8,0,0,0-14.31,0l-21.71,43.43A88,88,0,0,1,108,126.93,103.65,103.65,0,0,0,135.69,64H160a8,8,0,0,0,0-16H104V32a8,8,0,0,0-16,0V48H32a8,8,0,0,0,0,16h87.63A87.76,87.76,0,0,1,96,116.35a87.74,87.74,0,0,1-19-31,8,8,0,1,0-15.08,5.34A103.63,103.63,0,0,0,84,127a87.55,87.55,0,0,1-52,17,8,8,0,0,0,0,16,103.46,103.46,0,0,0,64-22.08,104.18,104.18,0,0,0,51.44,21.31l-26.6,53.19a8,8,0,0,0,14.31,7.16L148.94,192h70.11l13.79,27.58A8,8,0,0,0,240,224a8,8,0,0,0,7.15-11.58ZM156.94,176,184,121.89,211.05,176Z" />
    </svg>
  );
}

export function ChoiceCheckIcon({ width = 22, height = 22, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

export function ArrowRightIcon({ width = 19, height = 19, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M224.49,136.49l-72,72a12,12,0,0,1-17-17L187,140H40a12,12,0,0,1,0-24H187L135.51,64.48a12,12,0,0,1,17-17l72,72A12,12,0,0,1,224.49,136.49Z" />
    </svg>
  );
}

export function ArrowLeftIcon({ width = 19, height = 19, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M224,140H69l51.52,51.51a12,12,0,0,1-17,17l-72-72a12,12,0,0,1,0-17l72-72a12,12,0,0,1,17,17L69,116H224a12,12,0,0,1,0,24Z" />
    </svg>
  );
}

export function StepCheckIcon({ width = 14, height = 14, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

export function ShieldCheckIcon({ width = 22, height = 22, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M216,56v56c0,96-88,120-88,120S40,208,40,112V56a8,8,0,0,1,8-8H208A8,8,0,0,1,216,56Z" opacity="0.2" />
      <path d="M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.26,47,25.53a8,8,0,0,0,4.2,0c1-.27,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0ZM82.34,141.66a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32l-56,56a8,8,0,0,1-11.32,0Z" />
    </svg>
  );
}

export function RadioCheckIcon({ width = 12, height = 12, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

export function FolderIcon({ width = 22, height = 22, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M216,72H131.31L104,44.69A16,16,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.62A15.4,15.4,0,0,0,232,200.62V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40Z" />
    </svg>
  );
}

export function GitBranchIcon({ width = 22, height = 22, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M228,168a36,36,0,1,0-44.41,35A12,12,0,0,1,172,215.14V160a36.06,36.06,0,0,0-24-33.94V89.94A36,36,0,1,0,132,40a36.06,36.06,0,0,0,12,27.92v36.14A36.06,36.06,0,0,0,136,160v55.14A12,12,0,0,1,124.41,203,36,36,0,1,0,80,168a36.06,36.06,0,0,0,12,27.92v-8.06A12,12,0,0,1,116,176v16a36,36,0,1,0,72,0v-16a12,12,0,0,1,24,0v8.06A36.06,36.06,0,0,0,228,168ZM108,40A12,12,0,1,1,120,52,12,12,0,0,1,108,40ZM68,192a12,12,0,1,1,12,12A12,12,0,0,1,68,192Zm120,12a12,12,0,1,1,12-12A12,12,0,0,1,188,204Z" />
    </svg>
  );
}

export function WarningIcon({ width = 18, height = 18, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.84A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.07A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z" />
    </svg>
  );
}

export function CaretIcon({ width = 14, height = 14, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

export function FolderBrowseIcon({ width = 18, height = 18, className }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="currentColor" viewBox="0 0 256 256" className={className} aria-hidden="true">
      <path d="M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.93,51.2A16.14,16.14,0,0,0,93.34,48H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64h0L121.07,84.8A16.14,16.14,0,0,0,130.67,88H200v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Z" />
    </svg>
  );
}
