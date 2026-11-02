import StartupErrorPanel from './StartupErrorPanel';

export default function GatewayRuntimeErrorScreen({ error, onRetry }: { error: string; onRetry: () => void | Promise<void> }) {
  return <StartupErrorPanel error={error} onRetry={onRetry} />;
}
