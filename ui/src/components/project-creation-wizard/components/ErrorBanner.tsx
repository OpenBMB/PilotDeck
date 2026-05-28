import { AlertCircle } from 'lucide-react';

type ErrorBannerProps = {
  message: string;
};

export default function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
      <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" strokeWidth={1.75} />
      <p className="text-sm text-destructive">{message}</p>
    </div>
  );
}
